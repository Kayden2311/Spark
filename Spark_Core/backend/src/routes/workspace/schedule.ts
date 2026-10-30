import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { formatEtag, parseIfMatch } from "../../modules/work/domain/etag.js";
import { problem } from "../responses.js";
import { MUTATION_RATE_LIMIT, expectOutcome } from "../session-guard.js";
import { preconditionFailed, preconditionRequired, type Member, type MemberGuard } from "./guard.js";

// Workspace schedule (M6): the calendar read (events plus derived deadlines) and the event commands. Writes are the
// spark.ws_*_event definer functions, which derive the actor from the session, re-check membership and authority and
// answer with a closed set of outcomes. Event routes carry no workspace in the path: the database answers not_found
// for an unknown id and for a non-member alike, and the reads below are RLS-scoped, so both look identical (404).

const FORMER_MEMBER = "Former member";
const EVENT_LIMIT = 500;
const DEADLINE_LIMIT = 500;
const MAX_SPAN_MS = 62 * 24 * 60 * 60 * 1000;
const RESPONSES = ["accepted", "declined", "tentative"] as const;

// ---------- Representation ----------

type AttendeeResponse = "pending" | (typeof RESPONSES)[number];

interface UserRef { id: string; displayName: string }

export interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
  status: string;
  organizer: UserRef;
  project: { id: string; key: string; name: string } | null;
  issue: { id: string; key: string; title: string } | null;
  attendees: Array<{ user: UserRef; response: string }>;
  myResponse: string | null;
  canEdit: boolean;
  version: number;
}

interface Deadline {
  kind: "task_due" | "sprint_end" | "milestone_due";
  date: string;
  title: string;
  project: { id: string; key: string; name: string; methodology: string };
  issueId?: string;
  assignee?: UserRef | null;
  sprintId?: string;
  milestoneId?: string;
}

const nullableString = { type: ["string", "null"] } as const;
const userRef = { type: "object", properties: { id: { type: "string" }, displayName: { type: "string" } } } as const;

const eventResponse = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    description: nullableString,
    location: nullableString,
    startsAt: { type: "string" },
    endsAt: { type: "string" },
    timezone: { type: "string" },
    status: { type: "string" },
    organizer: userRef,
    project: { type: ["object", "null"], properties: { id: { type: "string" }, key: { type: "string" }, name: { type: "string" } } },
    issue: { type: ["object", "null"], properties: { id: { type: "string" }, key: { type: "string" }, title: { type: "string" } } },
    attendees: { type: "array", items: { type: "object", properties: { user: userRef, response: { type: "string" } } } },
    myResponse: nullableString,
    canEdit: { type: "boolean" },
    version: { type: "integer" },
  },
} as const;

const deadlineResponse = {
  type: "object",
  properties: {
    kind: { type: "string" },
    date: { type: "string" },
    title: { type: "string" },
    project: { type: "object", properties: { id: { type: "string" }, key: { type: "string" }, name: { type: "string" }, methodology: { type: "string" } } },
    issueId: { type: "string" },
    assignee: { type: ["object", "null"], properties: { id: { type: "string" }, displayName: { type: "string" } } },
    sprintId: { type: "string" },
    milestoneId: { type: "string" },
  },
} as const;

const calendarResponse = {
  type: "object",
  properties: {
    range: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, tz: { type: "string" } } },
    events: { type: "array", items: eventResponse },
    deadlines: { type: "array", items: deadlineResponse },
    truncated: { type: "object", properties: { events: { type: "boolean" }, deadlines: { type: "boolean" } } },
  },
} as const;

// ---------- Reads (RLS-scoped, explicit columns and tenant filters) ----------

interface EventRow {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: Date;
  ends_at: Date;
  timezone: string;
  status: string;
  version: number;
  organizer_user_id: string;
  organizer_name: string | null;
  project_id: string | null;
  project_key: string | null;
  project_name: string | null;
  issue_id: string | null;
  issue_number: string | null;
  issue_title: string | null;
}

interface AttendeeRow {
  event_id: string;
  user_id: string;
  display_name: string | null;
  response: string;
}

// Names come from global spark.users under the coworker policy; a user who left (or is unreadable) shows as "Former member".
const SELECT_EVENT = `SELECT e.id, e.tenant_id, e.title, e.description, e.location, e.starts_at, e.ends_at, e.timezone, e.status, e.version,
  e.organizer_user_id, o.display_name AS organizer_name, e.project_id, p.key AS project_key, p.name AS project_name,
  e.issue_id, i.number AS issue_number, i.title AS issue_title
  FROM spark.calendar_events e
  LEFT JOIN spark.users o ON o.id = e.organizer_user_id
  LEFT JOIN spark.projects p ON p.tenant_id = e.tenant_id AND p.id = e.project_id
  LEFT JOIN spark.issues i ON i.tenant_id = e.tenant_id AND i.id = e.issue_id`;

const iso = (value: Date) => value.toISOString();
const userOf = (id: string, displayName: string | null): UserRef => ({ id, displayName: displayName ?? FORMER_MEMBER });

/** Builds events from rows: attendees (organizer first), the viewer's answer and canEdit from the viewer's role. */
async function hydrate(client: PoolClient, actorId: string, rows: EventRow[]): Promise<CalendarEvent[]> {
  if (rows.length === 0) return [];
  const tenants = [...new Set(rows.map((row) => row.tenant_id))];
  const attendees = await client.query<AttendeeRow>(
    `SELECT a.event_id, a.user_id, u.display_name, a.response
     FROM spark.event_attendees a LEFT JOIN spark.users u ON u.id = a.user_id
     WHERE a.tenant_id = ANY ($1::uuid[]) AND a.event_id = ANY ($2::uuid[])
     ORDER BY a.event_id, u.display_name NULLS LAST, a.user_id`,
    [tenants, [...new Set(rows.map((row) => row.id))]],
  );
  const byEvent = new Map<string, AttendeeRow[]>();
  for (const row of attendees.rows) byEvent.set(row.event_id, [...(byEvent.get(row.event_id) ?? []), row]);

  const roles = new Map<string, string | null>();
  for (const tenant of tenants) {
    const found = await client.query<{ role: string }>(
      "SELECT m.role FROM spark.workspace_memberships m WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.status = 'active'",
      [tenant, actorId],
    );
    roles.set(tenant, found.rows[0]?.role ?? null);
  }

  return rows.map((row) => {
    const invited = byEvent.get(row.id) ?? [];
    const ordered = [...invited.filter((a) => a.user_id === row.organizer_user_id), ...invited.filter((a) => a.user_id !== row.organizer_user_id)];
    const role = roles.get(row.tenant_id);
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      location: row.location,
      startsAt: iso(row.starts_at),
      endsAt: iso(row.ends_at),
      timezone: row.timezone,
      status: row.status,
      organizer: userOf(row.organizer_user_id, row.organizer_name),
      project: row.project_id && row.project_key && row.project_name ? { id: row.project_id, key: row.project_key, name: row.project_name } : null,
      issue: row.issue_id && row.issue_title !== null && row.project_key ? { id: row.issue_id, key: `${row.project_key}-${row.issue_number}`, title: row.issue_title } : null,
      attendees: ordered.map((a) => ({ user: userOf(a.user_id, a.display_name), response: a.response })),
      myResponse: invited.find((a) => a.user_id === actorId)?.response ?? null,
      canEdit: row.status === "scheduled" && (row.organizer_user_id === actorId || role === "owner" || role === "admin"),
      version: row.version,
    };
  });
}

async function readEvent(client: PoolClient, actorId: string, eventId: string): Promise<CalendarEvent | null> {
  const found = await client.query<EventRow>(
    `${SELECT_EVENT} WHERE e.id = $1 AND e.tenant_id = ANY ((SELECT spark.session_workspace_ids())::uuid[])`,
    [eventId],
  );
  return (await hydrate(client, actorId, found.rows))[0] ?? null;
}

// ---------- Request schemas ----------

const uuid = { type: "string", format: "uuid" } as const;
const nullableUuid = { type: ["string", "null"], format: "uuid" } as const;
const instant = { type: "string", format: "date-time" } as const;
const attendeeIds = { type: "array", maxItems: 50, items: uuid } as const;

const workspaceParams = { type: "object", required: ["workspaceId"], properties: { workspaceId: uuid }, additionalProperties: false } as const;
const eventParams = { type: "object", required: ["eventId"], properties: { eventId: uuid }, additionalProperties: false } as const;

// Text limits here only bound the payload; the database trims and enforces the real limits. Fastify's validator strips
// unknown keys instead of failing (removeAdditional); propertyNames makes them a 400.
const createBody = {
  type: "object",
  required: ["title", "startsAt", "endsAt", "timezone"],
  propertyNames: { enum: ["title", "description", "location", "startsAt", "endsAt", "timezone", "projectId", "issueId", "attendeeUserIds"] },
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    description: { type: ["string", "null"], maxLength: 2000 },
    location: { type: ["string", "null"], maxLength: 200 },
    startsAt: instant,
    endsAt: instant,
    timezone: { type: "string", minLength: 1, maxLength: 64 },
    projectId: uuid,
    issueId: uuid,
    attendeeUserIds: attendeeIds,
  },
  additionalProperties: false,
} as const;

// Clearing projectId (null) while the event keeps an issueId is refused by the database with 'Invalid event issue':
// send issueId null in the same patch.
const patchBody = {
  type: "object",
  minProperties: 1,
  propertyNames: { enum: ["title", "description", "location", "startsAt", "endsAt", "timezone", "projectId", "issueId", "attendeeUserIds"] },
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    description: { type: ["string", "null"], maxLength: 2000 },
    location: { type: ["string", "null"], maxLength: 200 },
    startsAt: instant,
    endsAt: instant,
    timezone: { type: "string", minLength: 1, maxLength: 64 },
    projectId: nullableUuid,
    issueId: nullableUuid,
    attendeeUserIds: attendeeIds,
  },
  additionalProperties: false,
} as const;

const respondBody = {
  type: "object",
  required: ["response"],
  propertyNames: { enum: ["response"] },
  properties: { response: { type: "string", enum: RESPONSES } },
  additionalProperties: false,
} as const;

const calendarQuery = {
  type: "object",
  required: ["from", "to"],
  propertyNames: { enum: ["from", "to", "tz"] },
  properties: { from: instant, to: instant, tz: { type: "string", minLength: 1, maxLength: 64, default: "UTC" } },
  additionalProperties: false,
} as const;

interface CreateBody {
  title: string;
  description?: string | null;
  location?: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
  projectId?: string;
  issueId?: string;
  attendeeUserIds?: string[];
}
type PatchBody = Partial<Omit<CreateBody, "projectId" | "issueId"> & { projectId: string | null; issueId: string | null }>;

// ---------- Outcomes ----------

type Mapped = readonly [number, string, string, string];

const eventNotFound: Mapped = [404, "Not Found", "event_not_found", "Event does not exist."];
const workspaceNotFound: Mapped = [404, "Not Found", "workspace_not_found", "Workspace does not exist."];
const forbidden: Mapped = [403, "Forbidden", "insufficient_role", "Only the organizer, owners and admins can change this event."];
const cancelled: Mapped = [409, "Conflict", "event_cancelled", "A cancelled event cannot change."];

const updateOutcomes: Record<string, Mapped> = { not_found: eventNotFound, forbidden, cancelled };
const cancelOutcomes: Record<string, Mapped> = {
  not_found: eventNotFound,
  forbidden,
  already_cancelled: [409, "Conflict", "event_already_cancelled", "The event is already cancelled."],
};
const respondOutcomes: Record<string, Mapped> = {
  not_found: eventNotFound,
  not_invited: [403, "Forbidden", "not_invited", "You are not invited to this event."],
  cancelled,
};

/** An instant with an explicit offset, normalized to UTC; undefined for one the calendar rejects (a leap second). */
function normalizeInstant(value: string): string | undefined {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function invalidInstant(request: FastifyRequest, reply: FastifyReply) {
  return problem(request, reply, 400, "Bad Request", "invalid_input", "Times must be valid ISO 8601 date-times with an offset.");
}

/** The If-Match version, or undefined after replying 428/400. */
function requireVersion(request: FastifyRequest, reply: FastifyReply): number | undefined {
  const expected = parseIfMatch(request.headers["if-match"]);
  if (expected === null) {
    void preconditionRequired(request, reply);
    return undefined;
  }
  if (expected === "invalid") {
    void problem(request, reply, 400, "Bad Request", "invalid_if_match", "If-Match must be a single strong entity tag such as \"v1\".");
    return undefined;
  }
  return expected;
}

type Written = { mapped: Mapped } | { event: CalendarEvent; stale: boolean };

function sendEvent(request: FastifyRequest, reply: FastifyReply, result: Written | undefined) {
  if (reply.sent || !result) return reply;
  if ("mapped" in result) return problem(request, reply, ...result.mapped);
  if (result.stale) return preconditionFailed(request, reply, result.event);
  return reply.header("ETag", formatEtag(result.event.version)).send(result.event);
}

// ---------- Routes ----------

export function registerScheduleRoutes(app: FastifyInstance, guard: MemberGuard): void {
  registerCalendarRoute(app, guard);
  registerEventRoutes(app, guard);
}

function registerCalendarRoute(app: FastifyInstance, guard: MemberGuard): void {
  app.get<{ Params: { workspaceId: string }; Querystring: { from: string; to: string; tz: string } }>(
    "/api/v1/workspaces/:workspaceId/calendar",
    { schema: { params: workspaceParams, querystring: calendarQuery, response: { 200: calendarResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const from = normalizeInstant(request.query.from);
      const to = normalizeInstant(request.query.to);
      if (from === undefined || to === undefined) return invalidInstant(request, reply);
      const span = Date.parse(to) - Date.parse(from);
      if (span <= 0 || span > MAX_SPAN_MS) {
        return problem(request, reply, 400, "Bad Request", "invalid_range", "from must be before to, and the range at most 62 days.");
      }
      const result = await guard.run(request, reply, member, async (client) => {
        const workspace = await client.query<{ id: string }>(
          `SELECT w.id FROM spark.workspaces w
           WHERE w.id = $1 AND w.id = ANY ((SELECT spark.session_workspace_ids())::uuid[]) AND w.status = 'active' AND w.archived_at IS NULL`,
          [request.params.workspaceId],
        );
        const tenantId = workspace.rows[0]?.id;
        if (!tenantId) return { kind: "workspace" as const };
        const zone = await client.query<{ name: string }>("SELECT z.name FROM pg_catalog.pg_timezone_names z WHERE z.name = $1", [request.query.tz]);
        const tz = zone.rows[0]?.name;
        if (!tz) return { kind: "zone" as const };

        const rows = await client.query<EventRow>(
          `${SELECT_EVENT}
           WHERE e.tenant_id = $1 AND e.tenant_id = ANY ((SELECT spark.session_workspace_ids())::uuid[])
             AND e.starts_at < $3::timestamptz AND e.ends_at > $2::timestamptz
           ORDER BY e.starts_at, e.id LIMIT ${EVENT_LIMIT + 1}`,
          [tenantId, from, to],
        );
        const events = await hydrate(client, member.userId, rows.rows.slice(0, EVENT_LIMIT));

        // A deadline is inside the range when its calendar date, read in tz, falls on a local day the range touches.
        const inRange = (column: string) => `${column} >= ($2::timestamptz AT TIME ZONE $4)::date
          AND ${column} <= (($3::timestamptz - interval '1 millisecond') AT TIME ZONE $4)::date`;
        const deadlines = await client.query<DeadlineRow>(
          `SELECT d.deadline_kind, d.due, d.title, d.project_id, d.project_key, d.project_name, d.methodology, d.issue_id,
             d.assignee_user_id, d.assignee_name, d.sprint_id, d.milestone_id
           FROM (
             SELECT 'task_due' AS deadline_kind, to_char(i.due_date, 'YYYY-MM-DD') AS due, i.title, p.id AS project_id, p.key AS project_key,
               p.name AS project_name, p.methodology, i.id AS issue_id, i.assignee_user_id, a.display_name AS assignee_name,
               NULL::uuid AS sprint_id, NULL::uuid AS milestone_id, i.id AS ref_id
             FROM spark.issues i
             JOIN spark.projects p ON p.tenant_id = i.tenant_id AND p.id = i.project_id
             JOIN spark.issue_statuses st ON st.tenant_id = i.tenant_id AND st.project_id = i.project_id AND st.id = i.status_id
             LEFT JOIN spark.users a ON a.id = i.assignee_user_id
             WHERE i.tenant_id = $1 AND p.tenant_id = $1 AND st.tenant_id = $1 AND p.archived_at IS NULL AND i.archived_at IS NULL
               AND st.category <> 'done' AND i.due_date IS NOT NULL AND ${inRange("i.due_date")}
             UNION ALL
             SELECT 'sprint_end', to_char((s.ends_at AT TIME ZONE $4)::date, 'YYYY-MM-DD'), s.name, p.id, p.key, p.name, p.methodology,
               NULL::uuid, NULL::uuid, NULL::text, s.id, NULL::uuid, s.id
             FROM spark.sprints s
             JOIN spark.projects p ON p.tenant_id = s.tenant_id AND p.id = s.project_id
             WHERE s.tenant_id = $1 AND p.tenant_id = $1 AND p.archived_at IS NULL AND s.status IN ('planned', 'active') AND s.ends_at IS NOT NULL
               AND ${inRange("(s.ends_at AT TIME ZONE $4)::date")}
             UNION ALL
             SELECT 'milestone_due', to_char(m.due_date, 'YYYY-MM-DD'), m.name, p.id, p.key, p.name, p.methodology,
               NULL::uuid, NULL::uuid, NULL::text, NULL::uuid, m.id, m.id
             FROM spark.project_milestones m
             JOIN spark.projects p ON p.tenant_id = m.tenant_id AND p.id = m.project_id
             WHERE m.tenant_id = $1 AND p.tenant_id = $1 AND p.archived_at IS NULL AND m.completed_at IS NULL AND ${inRange("m.due_date")}
           ) d
           ORDER BY d.due, d.deadline_kind, d.title, d.ref_id LIMIT ${DEADLINE_LIMIT + 1}`,
          [tenantId, from, to, tz],
        );
        return { kind: "ok" as const, tz, events, eventsMore: rows.rows.length > EVENT_LIMIT, deadlines: deadlines.rows };
      });
      if (reply.sent || !result) return reply;
      if (result.kind === "workspace") return problem(request, reply, ...workspaceNotFound);
      if (result.kind === "zone") return problem(request, reply, 400, "Bad Request", "invalid_input", "tz must be an IANA time zone name.");
      return {
        range: { from, to, tz: result.tz },
        events: result.events,
        deadlines: result.deadlines.slice(0, DEADLINE_LIMIT).map(toDeadline),
        truncated: { events: result.eventsMore, deadlines: result.deadlines.length > DEADLINE_LIMIT },
      };
    },
  );
}

interface DeadlineRow {
  deadline_kind: Deadline["kind"];
  due: string;
  title: string;
  project_id: string;
  project_key: string;
  project_name: string;
  methodology: string;
  issue_id: string | null;
  assignee_user_id: string | null;
  assignee_name: string | null;
  sprint_id: string | null;
  milestone_id: string | null;
}

function toDeadline(row: DeadlineRow): Deadline {
  const deadline: Deadline = {
    kind: row.deadline_kind,
    date: row.due,
    title: row.title,
    project: { id: row.project_id, key: row.project_key, name: row.project_name, methodology: row.methodology },
  };
  if (row.deadline_kind === "task_due" && row.issue_id) {
    deadline.issueId = row.issue_id;
    deadline.assignee = row.assignee_user_id ? userOf(row.assignee_user_id, row.assignee_name) : null;
  }
  if (row.deadline_kind === "sprint_end" && row.sprint_id) deadline.sprintId = row.sprint_id;
  if (row.deadline_kind === "milestone_due" && row.milestone_id) deadline.milestoneId = row.milestone_id;
  return deadline;
}

function registerEventRoutes(app: FastifyInstance, guard: MemberGuard): void {
  app.post<{ Params: { workspaceId: string }; Body: CreateBody }>(
    "/api/v1/workspaces/:workspaceId/calendar-events",
    { config: MUTATION_RATE_LIMIT, schema: { params: workspaceParams, body: createBody, response: { 201: eventResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const { body } = request;
      const startsAt = normalizeInstant(body.startsAt);
      const endsAt = normalizeInstant(body.endsAt);
      if (startsAt === undefined || endsAt === undefined) return invalidInstant(request, reply);
      const result = await guard.run(request, reply, member, async (client) => {
        const created = await client.query<{ outcome: string; event_id: string | null }>(
          "SELECT outcome, event_id FROM spark.ws_create_event($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid[])",
          [
            request.params.workspaceId, body.title, body.description ?? null, body.location ?? null, startsAt, endsAt, body.timezone,
            body.projectId ?? null, body.issueId ?? null, body.attendeeUserIds ?? [],
          ],
        );
        const row = created.rows[0];
        if (row?.outcome === "not_found") return { mapped: workspaceNotFound };
        expectOutcome(row?.outcome, "ok");
        const event = row?.event_id ? await readEvent(client, member.userId, row.event_id) : null;
        if (!event) throw new Error("Created event is not readable");
        return { event };
      });
      if (reply.sent || !result) return reply;
      if ("mapped" in result) return problem(request, reply, ...result.mapped);
      const { event } = result;
      return reply.code(201).header("Location", `/api/v1/calendar-events/${event.id}`).header("ETag", formatEtag(event.version)).send(event);
    },
  );

  app.get<{ Params: { eventId: string } }>(
    "/api/v1/calendar-events/:eventId",
    { schema: { params: eventParams, response: { 200: eventResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const event = await guard.run(request, reply, member, (client) => readEvent(client, member.userId, request.params.eventId));
      if (reply.sent) return reply;
      if (!event) return problem(request, reply, ...eventNotFound);
      return reply.header("ETag", formatEtag(event.version)).send(event);
    },
  );

  /** Runs a versioned event command and re-reads the event (also for the 412 body). */
  const versionedCommand = async (
    request: FastifyRequest<{ Params: { eventId: string } }>,
    reply: FastifyReply,
    outcomes: Record<string, Mapped>,
    command: (client: PoolClient, expected: number, member: Member) => Promise<{ outcome: string } | undefined>,
  ): Promise<Written | undefined> => {
    const member = await guard.authenticate(request, reply);
    if (!member) return undefined;
    const expected = requireVersion(request, reply);
    if (expected === undefined) return undefined;
    return guard.run(request, reply, member, async (client) => {
      const row = await command(client, expected, member);
      const mapped = row ? outcomes[row.outcome] : undefined;
      if (mapped) return { mapped };
      expectOutcome(row?.outcome, "ok", "version_mismatch");
      const event = await readEvent(client, member.userId, request.params.eventId);
      if (!event || !row) return { mapped: eventNotFound };
      return { event, stale: row.outcome === "version_mismatch" };
    });
  };

  app.patch<{ Params: { eventId: string }; Body: PatchBody }>(
    "/api/v1/calendar-events/:eventId",
    { config: MUTATION_RATE_LIMIT, schema: { params: eventParams, body: patchBody, response: { 200: eventResponse } } },
    async (request, reply) => {
      const patch: PatchBody = { ...request.body };
      for (const key of ["startsAt", "endsAt"] as const) {
        const value = patch[key];
        if (value === undefined) continue;
        const normalized = normalizeInstant(value);
        if (normalized === undefined) return invalidInstant(request, reply);
        patch[key] = normalized;
      }
      const result = await versionedCommand(request, reply, updateOutcomes, async (client, expected) =>
        (await client.query<{ outcome: string }>("SELECT outcome FROM spark.ws_update_event($1, $2, $3::jsonb)", [request.params.eventId, expected, JSON.stringify(patch)])).rows[0]);
      return sendEvent(request, reply, result);
    },
  );

  app.post<{ Params: { eventId: string } }>(
    "/api/v1/calendar-events/:eventId/cancel",
    { config: MUTATION_RATE_LIMIT, schema: { params: eventParams, response: { 200: eventResponse } } },
    async (request, reply) => {
      // A schema cannot describe an absent body (Fastify validates undefined as a type error), so "no keys" is checked here.
      const body: unknown = request.body;
      const empty = body === undefined || body === null || (typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0);
      if (!empty) return problem(request, reply, 400, "Bad Request", "invalid_input", "This command takes no body.");
      const result = await versionedCommand(request, reply, cancelOutcomes, async (client, expected) =>
        (await client.query<{ outcome: string }>("SELECT outcome FROM spark.ws_cancel_event($1, $2)", [request.params.eventId, expected])).rows[0]);
      return sendEvent(request, reply, result);
    },
  );

  app.put<{ Params: { eventId: string }; Body: { response: Exclude<AttendeeResponse, "pending"> } }>(
    "/api/v1/calendar-events/:eventId/attendees/me",
    { config: MUTATION_RATE_LIMIT, schema: { params: eventParams, body: respondBody, response: { 200: eventResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const result = await guard.run(request, reply, member, async (client): Promise<Written> => {
        const answered = await client.query<{ outcome: string }>("SELECT outcome FROM spark.ws_respond_event($1, $2)", [request.params.eventId, request.body.response]);
        const row = answered.rows[0];
        const mapped = row ? respondOutcomes[row.outcome] : undefined;
        if (mapped) return { mapped };
        expectOutcome(row?.outcome, "ok");
        const event = await readEvent(client, member.userId, request.params.eventId);
        return event ? { event, stale: false } : { mapped: eventNotFound };
      });
      return sendEvent(request, reply, result);
    },
  );
}
