import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { formatEtag, parseIfMatch } from "../../modules/work/domain/etag.js";
import { parseIdempotencyKey, requestHash } from "../../modules/work/domain/idempotency.js";
import { pageSize, toPage } from "../pagination.js";
import { problem } from "../responses.js";
import { MUTATION_RATE_LIMIT, expectOutcome, pageQueryProperties, readCursor } from "../session-guard.js";
import { preconditionFailed, preconditionRequired, type MemberGuard } from "./guard.js";

const ISSUE_TYPES = ["task", "bug", "story"] as const;
const PRIORITIES = ["lowest", "low", "medium", "high", "highest"] as const;
const CREATE_KEYS = ["title", "description", "type", "priority", "statusId", "assigneeUserId", "storyPoints", "dueDate", "phaseId"] as const;
const PATCH_KEYS = ["title", "description", "type", "priority", "statusId", "afterIssueId", "assigneeUserId", "storyPoints", "dueDate", "phaseId", "archived"] as const;
const BOARD_LIMIT = 500;
const UPDATE_RATE_LIMIT = { rateLimit: { max: 120, timeWindow: 60 * 1000 } } as const;
// A user the actor can no longer see (left the workspace) still owns history; they are shown without a profile.
const FORMER_MEMBER = "Former member";

// ---------- Representation ----------

export interface IssueCard {
  id: string;
  number: number;
  key: string;
  title: string;
  type: string;
  priority: string;
  statusId: string;
  assignee: { id: string; displayName: string; avatarUrl: string | null } | null;
  storyPoints: number | null;
  dueDate: string | null;
  phaseId: string | null;
  version: number;
  completedAt: string | null;
  createdAt: string;
}

export interface IssueDetail extends IssueCard {
  projectId: string;
  description: string | null;
  reporter: { id: string; displayName: string } | null;
  startedAt: string | null;
  updatedAt: string;
  archivedAt: string | null;
}

const nullableString = { type: ["string", "null"] } as const;

const cardProperties = {
  id: { type: "string" },
  number: { type: "integer" },
  key: { type: "string" },
  title: { type: "string" },
  type: { type: "string" },
  priority: { type: "string" },
  statusId: { type: "string" },
  assignee: {
    type: ["object", "null"],
    properties: { id: { type: "string" }, displayName: { type: "string" }, avatarUrl: nullableString },
  },
  storyPoints: { type: ["number", "null"] },
  dueDate: nullableString,
  phaseId: nullableString,
  version: { type: "integer" },
  completedAt: nullableString,
  createdAt: { type: "string" },
} as const;

const cardResponse = { type: "object", properties: cardProperties } as const;

const detailResponse = {
  type: "object",
  properties: {
    ...cardProperties,
    projectId: { type: "string" },
    description: nullableString,
    reporter: { type: ["object", "null"], properties: { id: { type: "string" }, displayName: { type: "string" } } },
    startedAt: nullableString,
    updatedAt: { type: "string" },
    archivedAt: nullableString,
  },
} as const;

const boardResponse = {
  type: "object",
  properties: {
    project: {
      type: "object",
      properties: { id: { type: "string" }, key: { type: "string" }, name: { type: "string" }, methodology: { type: "string" } },
    },
    statuses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          category: { type: "string" },
          position: { type: "number" },
          wipLimit: { type: ["integer", "null"] },
          count: { type: "integer" },
        },
      },
    },
    issues: { type: "array", items: cardResponse },
    truncated: { type: "boolean" },
  },
} as const;

const pageResponse = (items: object) => ({
  type: "object",
  required: ["items", "nextCursor"],
  properties: { items: { type: "array", items }, nextCursor: nullableString },
});

const eventResponse = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string" },
    actor: { type: ["object", "null"], properties: { id: { type: "string" }, displayName: { type: "string" } } },
    fromVersion: { type: "integer" },
    toVersion: { type: "integer" },
    changes: { type: "object", additionalProperties: true },
    createdAt: { type: "string" },
  },
} as const;

// ---------- Reads (RLS-scoped, explicit columns and tenant/project filters) ----------

interface CardRow {
  id: string;
  number: string | number;
  project_key: string;
  title: string;
  type: string;
  priority: string;
  status_id: string;
  assignee_user_id: string | null;
  assignee_display_name: string | null;
  assignee_avatar_url: string | null;
  story_points: string | null;
  due_date: string | null;
  phase_id: string | null;
  version: number;
  completed_at: Date | null;
  created_at: Date;
  cursor_ts: string;
}

interface DetailRow extends CardRow {
  project_id: string;
  description: string | null;
  reporter_user_id: string | null;
  reporter_display_name: string | null;
  started_at: Date | null;
  updated_at: Date;
  archived_at: Date | null;
}

// Due dates leave the database as YYYY-MM-DD text so no time zone conversion can shift them. Users are
// joined through the coworker-scoped users policy.
const CARD_COLUMNS = `i.id, i.number, p.key AS project_key, i.title, i.type, i.priority, i.status_id,
  i.assignee_user_id, a.display_name AS assignee_display_name, a.avatar_url AS assignee_avatar_url,
  i.story_points, to_char(i.due_date, 'YYYY-MM-DD') AS due_date, i.phase_id, i.version, i.completed_at,
  i.created_at, i.created_at::text AS cursor_ts`;

const CARD_FROM = `FROM spark.issues i
  JOIN spark.projects p ON p.tenant_id = i.tenant_id AND p.id = i.project_id
  LEFT JOIN spark.users a ON a.id = i.assignee_user_id`;

const SELECT_DETAIL = `SELECT ${CARD_COLUMNS}, i.project_id, i.description, i.reporter_user_id,
  r.display_name AS reporter_display_name, i.started_at, i.updated_at, i.archived_at
  ${CARD_FROM}
  LEFT JOIN spark.users r ON r.id = i.reporter_user_id
  WHERE i.id = $1 AND i.tenant_id = ANY ((SELECT spark.session_workspace_ids())::uuid[])`;

const iso = (value: Date | null) => (value ? value.toISOString() : null);

function toCard(row: CardRow): IssueCard & { cursorTs: string } {
  return {
    id: row.id,
    number: Number(row.number),
    key: `${row.project_key}-${row.number}`,
    title: row.title,
    type: row.type,
    priority: row.priority,
    statusId: row.status_id,
    assignee: row.assignee_user_id
      ? { id: row.assignee_user_id, displayName: row.assignee_display_name ?? FORMER_MEMBER, avatarUrl: row.assignee_display_name === null ? null : row.assignee_avatar_url }
      : null,
    // numeric arrives from pg as text.
    storyPoints: row.story_points === null ? null : Number(row.story_points),
    dueDate: row.due_date,
    phaseId: row.phase_id,
    version: row.version,
    completedAt: iso(row.completed_at),
    createdAt: row.created_at.toISOString(),
    cursorTs: row.cursor_ts,
  };
}

function withoutCursorTs(card: IssueCard & { cursorTs: string }): IssueCard {
  const { cursorTs, ...rest } = card;
  void cursorTs;
  return rest;
}

/** The issue as the actor sees it (any active member of its workspace), or null when it is not visible. */
export async function readIssueDetail(client: PoolClient, issueId: string): Promise<IssueDetail | null> {
  const found = await client.query<DetailRow>(SELECT_DETAIL, [issueId]);
  const row = found.rows[0];
  if (!row) return null;
  return {
    ...withoutCursorTs(toCard(row)),
    projectId: row.project_id,
    description: row.description,
    reporter: row.reporter_user_id ? { id: row.reporter_user_id, displayName: row.reporter_display_name ?? FORMER_MEMBER } : null,
    startedAt: iso(row.started_at),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: iso(row.archived_at),
  };
}

interface ProjectRow { id: string; tenant_id: string; key: string; name: string; methodology: string }

async function readProject(client: PoolClient, projectId: string): Promise<ProjectRow | null> {
  const found = await client.query<ProjectRow>("SELECT p.id, p.tenant_id, p.key, p.name, p.methodology FROM spark.projects p WHERE p.id = $1", [projectId]);
  return found.rows[0] ?? null;
}

interface StatusLimitRow { name: string; wip_limit: number | null }

function wipDetail(status: StatusLimitRow | undefined): string {
  return status && status.wip_limit !== null ? `${status.name} is at its WIP limit (${status.wip_limit}).` : "The target status is at its WIP limit.";
}

/** The column a create targets: the requested status, or the default first status that is not done. */
async function createTargetStatus(client: PoolClient, projectId: string, statusId: string | null): Promise<StatusLimitRow | undefined> {
  const found = await client.query<StatusLimitRow>(
    `SELECT s.name, s.wip_limit FROM spark.projects p JOIN spark.issue_statuses s ON s.tenant_id = p.tenant_id AND s.project_id = p.id
     WHERE p.id = $1 AND (s.id = $2::uuid OR ($2::uuid IS NULL AND s.category <> 'done')) ORDER BY s.position, s.id LIMIT 1`,
    [projectId, statusId],
  );
  return found.rows[0];
}

/** The column an update targets: the requested status, or the issue's own status (restore from archive). */
async function updateTargetStatus(client: PoolClient, issueId: string, statusId: string | null): Promise<StatusLimitRow | undefined> {
  const found = await client.query<StatusLimitRow>(
    `SELECT s.name, s.wip_limit FROM spark.issues i JOIN spark.issue_statuses s
       ON s.tenant_id = i.tenant_id AND s.project_id = i.project_id AND s.id = coalesce($2::uuid, i.status_id)
     WHERE i.id = $1`,
    [issueId, statusId],
  );
  return found.rows[0];
}

// ---------- Request schemas ----------

const uuid = { type: "string", format: "uuid" } as const;
const nullableUuid = { type: ["string", "null"], format: "uuid" } as const;
const nullableDate = { type: ["string", "null"], format: "date" } as const;

const projectParams = { type: "object", required: ["projectId"], properties: { projectId: uuid }, additionalProperties: false } as const;
const issueParams = { type: "object", required: ["issueId"], properties: { issueId: uuid }, additionalProperties: false } as const;

// Text limits here only bound the payload; the database trims and enforces the real limits (title 1-200).
const fieldSchemas = {
  title: { type: "string", minLength: 1, maxLength: 500 },
  description: { type: ["string", "null"], maxLength: 10000 },
  type: { type: "string", enum: ISSUE_TYPES },
  priority: { type: "string", enum: PRIORITIES },
  statusId: uuid,
  assigneeUserId: nullableUuid,
  storyPoints: { type: ["number", "null"], minimum: 0, maximum: 100 },
  dueDate: nullableDate,
  phaseId: nullableUuid,
} as const;

// Fastify's validator strips unknown keys instead of failing (removeAdditional); propertyNames makes them a 400.
const createBody = {
  type: "object",
  required: ["title"],
  propertyNames: { enum: CREATE_KEYS },
  properties: fieldSchemas,
  additionalProperties: false,
} as const;

const patchBody = {
  type: "object",
  minProperties: 1,
  propertyNames: { enum: PATCH_KEYS },
  properties: { ...fieldSchemas, afterIssueId: nullableUuid, archived: { type: "boolean" } },
  additionalProperties: false,
} as const;

const listQuery = {
  type: "object",
  propertyNames: { enum: ["status", "assignee", "q", "archived", "cursor", "limit"] },
  properties: {
    status: uuid,
    assignee: { type: "string", pattern: "^(me|none|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$" },
    q: { type: "string", maxLength: 100 },
    archived: { type: "boolean", default: false },
    ...pageQueryProperties,
  },
  additionalProperties: false,
} as const;

const eventsQuery = {
  type: "object",
  propertyNames: { enum: ["cursor", "limit"] },
  properties: { ...pageQueryProperties },
  additionalProperties: false,
} as const;

interface CreateBody {
  title: string;
  description?: string | null;
  type?: string;
  priority?: string;
  statusId?: string;
  assigneeUserId?: string | null;
  storyPoints?: number | null;
  dueDate?: string | null;
  phaseId?: string | null;
}

type PatchBody = Partial<CreateBody & { afterIssueId: string | null; archived: boolean }>;

interface ListQuery { status?: string; assignee?: string; q?: string; archived: boolean; cursor?: string; limit?: number }

// ---------- Outcomes ----------

type Mapped = [number, string, string, string];

const projectNotFound: Mapped = [404, "Not Found", "project_not_found", "Project does not exist."];
const issueNotFound: Mapped = [404, "Not Found", "issue_not_found", "Issue does not exist."];
const invalidAssignee: Mapped = [422, "Unprocessable Content", "invalid_assignee", "The assignee must be an active member of the workspace."];

// Outcome -> [status, title, code, detail]; an outcome missing from the table must be allowed explicitly or the route throws.
const createOutcomes: Record<string, Mapped> = {
  not_found: projectNotFound,
  no_board: [409, "Conflict", "project_has_no_board", "This project has no board to add issues to."],
  invalid_assignee: invalidAssignee,
  too_many_issues: [409, "Conflict", "too_many_issues", "This project already has the maximum number of open issues."],
  idempotency_conflict: [409, "Conflict", "idempotency_key_reused", "This Idempotency-Key was already used for a different request."],
};

const updateOutcomes: Record<string, Mapped> = {
  not_found: issueNotFound,
  invalid_assignee: invalidAssignee,
};

function wipLimitReached(request: FastifyRequest, reply: FastifyReply, detail: string) {
  return problem(request, reply, 409, "Conflict", "wip_limit_reached", detail);
}

// ---------- Routes ----------

export function registerIssueRoutes(app: FastifyInstance, guard: MemberGuard): void {
  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/board",
    { schema: { params: projectParams, response: { 200: boardResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const result = await guard.run(request, reply, member, async (client) => {
        const project = await readProject(client, request.params.projectId);
        if (!project) return null;
        const scope = [project.tenant_id, project.id];
        const statuses = await client.query<{ id: string; name: string; category: string; position: string; wip_limit: number | null; issue_count: string }>(
          `SELECT s.id, s.name, s.category, s.position, s.wip_limit,
             (SELECT count(*) FROM spark.issues i WHERE i.tenant_id = s.tenant_id AND i.project_id = s.project_id
                AND i.status_id = s.id AND i.archived_at IS NULL) AS issue_count
           FROM spark.issue_statuses s WHERE s.tenant_id = $1 AND s.project_id = $2 ORDER BY s.position, s.id`,
          scope,
        );
        const cards = await client.query<CardRow>(
          `SELECT ${CARD_COLUMNS} ${CARD_FROM}
           JOIN spark.issue_statuses s ON s.tenant_id = i.tenant_id AND s.project_id = i.project_id AND s.id = i.status_id
           WHERE i.tenant_id = $1 AND i.project_id = $2 AND i.archived_at IS NULL
           ORDER BY s.position, s.id, i.position, i.id LIMIT ${BOARD_LIMIT + 1}`,
          scope,
        );
        return { project, statuses: statuses.rows, cards: cards.rows };
      });
      if (reply.sent) return reply;
      if (!result) return problem(request, reply, ...projectNotFound);
      const { project } = result;
      return {
        project: { id: project.id, key: project.key, name: project.name, methodology: project.methodology },
        statuses: result.statuses.map((s) => ({
          id: s.id,
          name: s.name,
          category: s.category,
          position: Number(s.position),
          wipLimit: s.wip_limit,
          count: Number(s.issue_count),
        })),
        issues: result.cards.slice(0, BOARD_LIMIT).map((row) => withoutCursorTs(toCard(row))),
        truncated: result.cards.length > BOARD_LIMIT,
      };
    },
  );

  app.get<{ Params: { projectId: string }; Querystring: ListQuery }>(
    "/api/v1/projects/:projectId/issues",
    { schema: { params: projectParams, querystring: listQuery, response: { 200: pageResponse(cardResponse) } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const cursor = readCursor(request, reply, request.query.cursor);
      if (cursor === undefined) return reply;
      const { status, assignee, q, archived } = request.query;
      const limit = pageSize(request.query.limit);

      const rows = await guard.run(request, reply, member, async (client) => {
        const project = await readProject(client, request.params.projectId);
        if (!project) return null;
        const params: unknown[] = [project.tenant_id, project.id];
        const bind = (value: unknown) => `$${params.push(value)}`;
        const conditions = ["i.tenant_id = $1", "i.project_id = $2", archived ? "i.archived_at IS NOT NULL" : "i.archived_at IS NULL"];
        if (status) conditions.push(`i.status_id = ${bind(status)}`);
        if (assignee === "none") conditions.push("i.assignee_user_id IS NULL");
        else if (assignee) conditions.push(`i.assignee_user_id = ${bind(assignee === "me" ? member.userId : assignee)}`);
        // strpos matches the text literally, so % and _ in the query need no escaping.
        if (q) conditions.push(`strpos(lower(i.title), lower(${bind(q)})) > 0`);
        if (cursor) conditions.push(`(i.created_at, i.id) < (${bind(cursor.createdAt)}::timestamptz, ${bind(cursor.id)}::uuid)`);
        const list = await client.query<CardRow>(
          `SELECT ${CARD_COLUMNS} ${CARD_FROM} WHERE ${conditions.join(" AND ")} ORDER BY i.created_at DESC, i.id DESC LIMIT ${limit + 1}`,
          params,
        );
        return list.rows;
      });
      if (reply.sent) return reply;
      if (!rows) return problem(request, reply, ...projectNotFound);
      return toPage(rows.map(toCard), limit);
    },
  );

  app.post<{ Params: { projectId: string }; Body: CreateBody }>(
    "/api/v1/projects/:projectId/issues",
    { config: MUTATION_RATE_LIMIT, schema: { params: projectParams, body: createBody, response: { 201: detailResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const header = request.headers["idempotency-key"];
      const key = parseIdempotencyKey(Array.isArray(header) ? header.join(",") : header);
      if (key === "invalid") return problem(request, reply, 400, "Bad Request", "invalid_input", "Invalid idempotency key.");
      const { body } = request;
      const { projectId } = request.params;
      // Hash of the validated body, so a retry that only reorders keys still matches.
      const hash = requestHash(body);

      const result = await guard.run(request, reply, member, async (client) => {
        const created = await client.query<{ outcome: string; issue_id: string | null; issue_version: number | null }>(
          "SELECT outcome, issue_id, issue_version FROM spark.ws_create_issue($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
          [
            projectId,
            body.title,
            body.description ?? null,
            body.type ?? null,
            body.priority ?? null,
            body.statusId ?? null,
            body.assigneeUserId ?? null,
            body.storyPoints ?? null,
            body.dueDate ?? null,
            body.phaseId ?? null,
            key,
            hash,
          ],
        );
        const row = created.rows[0];
        const mapped = row ? createOutcomes[row.outcome] : undefined;
        if (mapped) return { kind: "mapped" as const, mapped };
        if (row?.outcome === "wip_limit_reached") return { kind: "wip" as const, detail: wipDetail(await createTargetStatus(client, projectId, body.statusId ?? null)) };
        expectOutcome(row?.outcome, "ok", "replayed");
        const issue = row?.issue_id ? await readIssueDetail(client, row.issue_id) : null;
        if (!issue) throw new Error("Created issue is not readable");
        return { kind: "issue" as const, issue, replayed: row?.outcome === "replayed" };
      });
      if (reply.sent || !result) return reply;
      if (result.kind === "mapped") return problem(request, reply, ...result.mapped);
      if (result.kind === "wip") return wipLimitReached(request, reply, result.detail);
      const { issue } = result;
      if (result.replayed) reply.header("Idempotent-Replayed", "true");
      return reply.code(201).header("Location", `/api/v1/issues/${issue.id}`).header("ETag", formatEtag(issue.version)).send(issue);
    },
  );

  app.get<{ Params: { issueId: string } }>(
    "/api/v1/issues/:issueId",
    { schema: { params: issueParams, response: { 200: detailResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const issue = await guard.run(request, reply, member, (client) => readIssueDetail(client, request.params.issueId));
      if (reply.sent) return reply;
      if (!issue) return problem(request, reply, ...issueNotFound);
      return reply.header("ETag", formatEtag(issue.version)).send(issue);
    },
  );

  app.patch<{ Params: { issueId: string }; Body: PatchBody }>(
    "/api/v1/issues/:issueId",
    { config: UPDATE_RATE_LIMIT, schema: { params: issueParams, body: patchBody, response: { 200: detailResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const expected = parseIfMatch(request.headers["if-match"]);
      if (expected === null) return preconditionRequired(request, reply);
      if (expected === "invalid") return problem(request, reply, 400, "Bad Request", "invalid_if_match", "If-Match must be a single strong entity tag such as \"v1\".");
      const { issueId } = request.params;

      const result = await guard.run(request, reply, member, async (client) => {
        const updated = await client.query<{ outcome: string; issue_version: number | null }>(
          "SELECT outcome, issue_version FROM spark.ws_update_issue($1, $2, $3)",
          [issueId, expected, JSON.stringify(request.body)],
        );
        const outcome = updated.rows[0]?.outcome;
        const mapped = outcome ? updateOutcomes[outcome] : undefined;
        if (mapped) return { kind: "mapped" as const, mapped };
        if (outcome === "wip_limit_reached") return { kind: "wip" as const, detail: wipDetail(await updateTargetStatus(client, issueId, request.body.statusId ?? null)) };
        expectOutcome(outcome, "ok", "version_mismatch");
        const issue = await readIssueDetail(client, issueId);
        if (!issue) return { kind: "mapped" as const, mapped: issueNotFound };
        return { kind: "issue" as const, issue, stale: outcome === "version_mismatch" };
      });
      if (reply.sent || !result) return reply;
      if (result.kind === "mapped") return problem(request, reply, ...result.mapped);
      if (result.kind === "wip") return wipLimitReached(request, reply, result.detail);
      if (result.stale) return preconditionFailed(request, reply, result.issue);
      return reply.header("ETag", formatEtag(result.issue.version)).send(result.issue);
    },
  );

  app.get<{ Params: { issueId: string }; Querystring: { cursor?: string; limit?: number } }>(
    "/api/v1/issues/:issueId/events",
    { schema: { params: issueParams, querystring: eventsQuery, response: { 200: pageResponse(eventResponse) } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const cursor = readCursor(request, reply, request.query.cursor);
      if (cursor === undefined) return reply;
      const limit = pageSize(request.query.limit);

      const rows = await guard.run(request, reply, member, async (client) => {
        const found = await client.query<{ id: string; tenant_id: string; project_id: string }>(
          "SELECT i.id, i.tenant_id, i.project_id FROM spark.issues i WHERE i.id = $1 AND i.tenant_id = ANY ((SELECT spark.session_workspace_ids())::uuid[])",
          [request.params.issueId],
        );
        const issue = found.rows[0];
        if (!issue) return null;
        const params: unknown[] = [issue.tenant_id, issue.project_id, issue.id];
        const after = cursor ? `AND (e.created_at, e.id) < ($4::timestamptz, $5::uuid)` : "";
        if (cursor) params.push(cursor.createdAt, cursor.id);
        const events = await client.query<{
          id: string;
          event_type: string;
          actor_user_id: string | null;
          actor_display_name: string | null;
          from_version: number;
          to_version: number;
          changes: Record<string, unknown>;
          created_at: Date;
          cursor_ts: string;
        }>(
          `SELECT e.id, e.event_type, e.actor_user_id, u.display_name AS actor_display_name, e.from_version, e.to_version,
             e.changes, e.created_at, e.created_at::text AS cursor_ts
           FROM spark.issue_events e LEFT JOIN spark.users u ON u.id = e.actor_user_id
           WHERE e.tenant_id = $1 AND e.project_id = $2 AND e.issue_id = $3 ${after}
           ORDER BY e.created_at DESC, e.id DESC LIMIT ${limit + 1}`,
          params,
        );
        return events.rows;
      });
      if (reply.sent) return reply;
      if (!rows) return problem(request, reply, ...issueNotFound);
      return toPage(
        rows.map((row) => ({
          id: row.id,
          cursorTs: row.cursor_ts,
          type: row.event_type,
          actor: row.actor_user_id ? { id: row.actor_user_id, displayName: row.actor_display_name ?? FORMER_MEMBER } : null,
          fromVersion: row.from_version,
          toVersion: row.to_version,
          changes: row.changes,
          createdAt: row.created_at.toISOString(),
        })),
        limit,
      );
    },
  );
}
