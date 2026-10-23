import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { formatEtag, parseIfMatch } from "../../modules/work/domain/etag.js";
import { problem } from "../responses.js";
import { MUTATION_RATE_LIMIT, expectOutcome } from "../session-guard.js";
import { preconditionFailed, preconditionRequired, type MemberGuard } from "./guard.js";
import {
  milestoneResponse,
  phaseResponse,
  projectDetailResponse,
  readMilestone,
  readPlanItems,
  readProjectDetail,
  type Milestone,
  type Phase,
  type ProjectDetail,
} from "./projects.js";

// Planning writes (M4): sprints, the Waterfall phase plan, milestones, re-baselining, board columns and the
// methodology switch. Every write is a spark.ws_* definer function that re-checks membership and authority;
// these routes validate transport input, require If-Match on versioned state and map outcomes to HTTP.

const METHODOLOGY_IDS = ["scrum", "kanban", "waterfall"] as const;
const CATEGORIES = ["backlog", "todo", "in_progress", "done"] as const;
const FINISHED_SPRINTS_LIMIT = 50;

// ---------- Representation ----------

export interface Sprint {
  id: string;
  name: string;
  goal: string | null;
  status: string;
  startsOn: string | null;
  endsOn: string | null;
  startedAt: string | null;
  completedAt: string | null;
  committedPoints: number | null;
  committedCount: number | null;
  completedPoints: number | null;
  completedCount: number | null;
  version: number;
}

/** Which methodology the project used when; `endedAt` null is the current period. */
export interface MethodologyPeriod {
  methodology: string;
  startedAt: string;
  endedAt: string | null;
}

export interface Plan {
  phases: Phase[];
  milestones: Milestone[];
  baselinedAt: string | null;
  periods: MethodologyPeriod[];
  version: number;
}

const nullableString = { type: ["string", "null"] } as const;
const nullableNumber = { type: ["number", "null"] } as const;
const nullableInteger = { type: ["integer", "null"] } as const;

const sprintResponse = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    goal: nullableString,
    status: { type: "string" },
    startsOn: nullableString,
    endsOn: nullableString,
    startedAt: nullableString,
    completedAt: nullableString,
    committedPoints: nullableNumber,
    committedCount: nullableInteger,
    completedPoints: nullableNumber,
    completedCount: nullableInteger,
    version: { type: "integer" },
  },
} as const;

const planResponse = {
  type: "object",
  properties: {
    phases: { type: "array", items: phaseResponse },
    milestones: { type: "array", items: milestoneResponse },
    baselinedAt: nullableString,
    periods: {
      type: "array",
      items: { type: "object", properties: { methodology: { type: "string" }, startedAt: { type: "string" }, endedAt: nullableString } },
    },
    version: { type: "integer" },
  },
} as const;

// ---------- Reads (RLS-scoped, explicit columns and tenant/project filters) ----------

interface ProjectRef { id: string; tenant_id: string; baselined_at: Date | null; settings_version: number }

async function readProjectRef(client: PoolClient, projectId: string): Promise<ProjectRef | null> {
  const found = await client.query<ProjectRef>(
    `SELECT p.id, p.tenant_id, p.baselined_at, p.settings_version FROM spark.projects p WHERE p.id = $1
     AND p.tenant_id = ANY ((SELECT spark.session_workspace_ids())::uuid[])`,
    [projectId],
  );
  return found.rows[0] ?? null;
}

interface SprintRow {
  id: string;
  name: string;
  goal: string | null;
  status: string;
  starts_on: string | null;
  ends_on: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  committed_points: string | null;
  committed_count: number | null;
  completed_points: string | null;
  completed_count: number | null;
  version: number;
}

// Sprint dates are calendar days stored as midnight UTC; they leave the database as YYYY-MM-DD text.
const SELECT_SPRINT = `SELECT s.id, s.name, s.goal, s.status,
  to_char((s.starts_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS starts_on,
  to_char((s.ends_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS ends_on,
  s.started_at, s.completed_at, s.committed_points, s.committed_count, s.completed_points, s.completed_count, s.version
  FROM spark.sprints s`;

const iso = (value: Date | null) => (value ? value.toISOString() : null);
// numeric arrives from pg as text.
const points = (value: string | null) => (value === null ? null : Number(value));

function toSprint(row: SprintRow): Sprint {
  return {
    id: row.id,
    name: row.name,
    goal: row.goal,
    status: row.status,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    committedPoints: points(row.committed_points),
    committedCount: row.committed_count,
    completedPoints: points(row.completed_points),
    completedCount: row.completed_count,
    version: row.version,
  };
}

async function readSprint(client: PoolClient, sprintId: string): Promise<Sprint | null> {
  const found = await client.query<SprintRow>(
    `${SELECT_SPRINT} WHERE s.id = $1 AND s.tenant_id = ANY ((SELECT spark.session_workspace_ids())::uuid[])`,
    [sprintId],
  );
  const row = found.rows[0];
  return row ? toSprint(row) : null;
}

/** The project's methodology history, oldest first (who changed it and why stay out of the plan). */
async function readPeriods(client: PoolClient, tenantId: string, projectId: string): Promise<MethodologyPeriod[]> {
  const found = await client.query<{ methodology: string; started_at: Date; ended_at: Date | null }>(
    `SELECT mp.methodology, mp.started_at, mp.ended_at FROM spark.project_methodology_periods mp
     WHERE mp.tenant_id = $1 AND mp.project_id = $2 ORDER BY mp.started_at, mp.id`,
    [tenantId, projectId],
  );
  return found.rows.map((row) => ({ methodology: row.methodology, startedAt: row.started_at.toISOString(), endedAt: iso(row.ended_at) }));
}

async function readPlan(client: PoolClient, projectId: string): Promise<Plan | null> {
  const project = await readProjectRef(client, projectId);
  if (!project) return null;
  return {
    ...(await readPlanItems(client, project.tenant_id, project.id)),
    baselinedAt: iso(project.baselined_at),
    periods: await readPeriods(client, project.tenant_id, project.id),
    version: project.settings_version,
  };
}

/** True when the status is a column of the project (and visible to the actor). */
async function statusInProject(client: PoolClient, projectId: string, statusId: string): Promise<boolean> {
  const found = await client.query(
    `SELECT s.id FROM spark.issue_statuses s JOIN spark.projects p ON p.tenant_id = s.tenant_id AND p.id = s.project_id
     WHERE p.id = $1 AND s.id = $2 AND s.tenant_id = ANY ((SELECT spark.session_workspace_ids())::uuid[])`,
    [projectId, statusId],
  );
  return found.rows.length > 0;
}

/** Non-archived cards in a column: the guard_status trigger's own occupancy. */
async function columnOccupancy(client: PoolClient, projectId: string, statusId: string): Promise<number> {
  const found = await client.query<{ cards: string }>(
    `SELECT count(*) AS cards FROM spark.issues i JOIN spark.projects p ON p.tenant_id = i.tenant_id AND p.id = i.project_id
     WHERE p.id = $1 AND i.status_id = $2 AND i.archived_at IS NULL`,
    [projectId, statusId],
  );
  return Number(found.rows[0]?.cards ?? 0);
}

// ---------- Request schemas ----------

const uuid = { type: "string", format: "uuid" } as const;
const nullableUuid = { type: ["string", "null"], format: "uuid" } as const;
const date = { type: "string", format: "date" } as const;
const nullableDate = { type: ["string", "null"], format: "date" } as const;

const params = (...names: string[]) => ({
  type: "object",
  required: names,
  properties: Object.fromEntries(names.map((name) => [name, uuid])),
  additionalProperties: false,
});
const projectParams = params("projectId");
const sprintParams = params("sprintId");
const milestoneParams = params("milestoneId");
const statusParams = params("projectId", "statusId");

// Text limits here only bound the payload; the database trims and enforces the real limits (sprint name
// 1-80, goal 500, milestone name 80, column name 40, reasons 200). Fastify's validator strips unknown keys
// instead of failing (removeAdditional); propertyNames makes them a 400.
const sprintFields = {
  name: { type: "string", minLength: 1, maxLength: 200 },
  goal: { type: ["string", "null"], maxLength: 2000 },
  startsOn: nullableDate,
  endsOn: nullableDate,
} as const;

const createSprintBody = {
  type: "object",
  required: ["name"],
  propertyNames: { enum: ["name", "goal", "startsOn", "endsOn"] },
  properties: sprintFields,
  additionalProperties: false,
} as const;

const patchSprintBody = { ...createSprintBody, required: [], minProperties: 1 } as const;

const completeSprintBody = {
  type: "object",
  required: ["carryToSprintId"],
  propertyNames: { enum: ["carryToSprintId"] },
  properties: { carryToSprintId: nullableUuid },
  additionalProperties: false,
} as const;

const phaseItems = {
  type: "array",
  minItems: 1,
  maxItems: 12,
  items: {
    type: "object",
    required: ["name", "plannedStart", "plannedEnd"],
    propertyNames: { enum: ["id", "name", "plannedStart", "plannedEnd"] },
    properties: { id: uuid, name: { type: "string", minLength: 1, maxLength: 200 }, plannedStart: date, plannedEnd: date },
    additionalProperties: false,
  },
} as const;

const phasesBody = {
  type: "object",
  required: ["phases"],
  propertyNames: { enum: ["phases"] },
  properties: { phases: phaseItems },
  additionalProperties: false,
} as const;

const milestoneFields = {
  name: { type: "string", minLength: 1, maxLength: 200 },
  dueDate: date,
  phaseId: nullableUuid,
} as const;

const createMilestoneBody = {
  type: "object",
  required: ["name", "dueDate"],
  propertyNames: { enum: ["name", "dueDate", "phaseId"] },
  properties: milestoneFields,
  additionalProperties: false,
} as const;

const patchMilestoneBody = {
  type: "object",
  minProperties: 1,
  propertyNames: { enum: ["name", "dueDate", "phaseId", "completed"] },
  properties: { ...milestoneFields, completed: { type: "boolean" } },
  additionalProperties: false,
} as const;

const reason = { type: "string", minLength: 1, maxLength: 500 } as const;

const baselineBody = {
  type: "object",
  required: ["reason"],
  propertyNames: { enum: ["reason"] },
  properties: { reason },
  additionalProperties: false,
} as const;

const wipLimit = { type: ["integer", "null"], minimum: 1, maximum: 99 } as const;

const patchStatusBody = {
  type: "object",
  minProperties: 1,
  propertyNames: { enum: ["name", "wipLimit"] },
  properties: { name: { type: "string", minLength: 1, maxLength: 100 }, wipLimit },
  additionalProperties: false,
} as const;

const switchBody = {
  type: "object",
  required: ["to", "columns", "mapping", "reason"],
  propertyNames: { enum: ["to", "columns", "mapping", "sprintLengthDays", "startDate", "targetDate", "phases", "reason"] },
  properties: {
    to: { type: "string", enum: METHODOLOGY_IDS },
    columns: {
      type: "array",
      minItems: 2,
      maxItems: 12,
      items: {
        type: "object",
        required: ["name", "category"],
        propertyNames: { enum: ["id", "name", "category", "wipLimit"] },
        properties: { id: uuid, name: { type: "string", minLength: 1, maxLength: 100 }, category: { type: "string", enum: CATEGORIES }, wipLimit },
        additionalProperties: false,
      },
    },
    // {"<removed status id>": 0-based index into columns}
    mapping: {
      type: "object",
      maxProperties: 12,
      propertyNames: { format: "uuid" },
      additionalProperties: { type: "integer", minimum: 0, maximum: 11 },
    },
    sprintLengthDays: { type: "integer", minimum: 7, maximum: 28 },
    startDate: date,
    targetDate: date,
    phases: phaseItems,
    reason,
  },
  additionalProperties: false,
} as const;

interface CreateSprintBody { name: string; goal?: string | null; startsOn?: string | null; endsOn?: string | null }
type PatchSprintBody = Partial<CreateSprintBody>;
interface PhaseInput { id?: string; name: string; plannedStart: string; plannedEnd: string }
interface CreateMilestoneBody { name: string; dueDate: string; phaseId?: string | null }
type PatchMilestoneBody = Partial<CreateMilestoneBody & { completed: boolean }>;
interface PatchStatusBody { name?: string; wipLimit?: number | null }
interface SwitchBody {
  to: string;
  columns: Array<{ id?: string; name: string; category: string; wipLimit?: number | null }>;
  mapping: Record<string, number>;
  sprintLengthDays?: number;
  startDate?: string;
  targetDate?: string;
  phases?: PhaseInput[];
  reason: string;
}

// ---------- Outcomes ----------

type Mapped = [number, string, string, string];

const forbidden: Mapped = [403, "Forbidden", "insufficient_role", "Only owners, admins and the project lead can change the plan."];
const projectNotFound: Mapped = [404, "Not Found", "project_not_found", "Project does not exist."];
const sprintNotFound: Mapped = [404, "Not Found", "sprint_not_found", "Sprint does not exist."];
const milestoneNotFound: Mapped = [404, "Not Found", "milestone_not_found", "Milestone does not exist."];
const statusNotFound: Mapped = [404, "Not Found", "status_not_found", "Column does not exist."];

// Outcome -> [status, title, code, detail]; an outcome missing from a table must be allowed explicitly or the route throws.
const projectOutcomes: Record<string, Mapped> = { not_found: projectNotFound, forbidden };
const sprintOutcomes: Record<string, Mapped> = {
  not_found: sprintNotFound,
  forbidden,
  not_editable: [409, "Conflict", "sprint_not_editable", "Only a planned sprint can change its dates, and a finished sprint cannot change."],
  already_active: [409, "Conflict", "sprint_already_active", "Another sprint is already active in this project. Complete it first."],
  not_planned: [409, "Conflict", "sprint_not_planned", "Only a planned sprint can be started."],
  missing_dates: [409, "Conflict", "sprint_missing_dates", "Set the sprint's start and end dates before starting it."],
  not_active: [409, "Conflict", "sprint_not_active", "Only the active sprint can be completed."],
  invalid_carry_target: [422, "Unprocessable Content", "invalid_carry_target", "Unfinished work can only move to a planned sprint of this project."],
};
const milestoneOutcomes: Record<string, Mapped> = { not_found: milestoneNotFound, forbidden };
const statusOutcomes: Record<string, Mapped> = {
  not_found: statusNotFound,
  forbidden,
  name_taken: [409, "Conflict", "name_taken", "Another column in this project already has that name."],
};
const switchOutcomes: Record<string, Mapped> = {
  not_found: projectNotFound,
  forbidden,
  same_methodology: [409, "Conflict", "same_methodology", "The project already uses that methodology."],
  active_sprint: [409, "Conflict", "active_sprint", "Complete the active sprint before switching methodology."],
  wip_below_occupancy: [409, "Conflict", "wip_below_occupancy", "A column's WIP limit is below the cards it would hold."],
};

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

type Written<T> = { mapped: Mapped } | { value: T; stale: boolean };

/** Sends a write result: a mapped problem, 412 with the current representation, or 200 with its ETag. */
function sendWritten<T>(request: FastifyRequest, reply: FastifyReply, result: Written<T> | undefined, version: (value: T) => number, body?: (value: T) => unknown) {
  if (reply.sent || !result) return reply;
  if ("mapped" in result) return problem(request, reply, ...result.mapped);
  if (result.stale) return preconditionFailed(request, reply, result.value);
  return reply.header("ETag", formatEtag(version(result.value))).send(body ? body(result.value) : result.value);
}

// ---------- Routes ----------

export function registerPlanningRoutes(app: FastifyInstance, guard: MemberGuard): void {
  registerSprintRoutes(app, guard);
  registerPlanRoutes(app, guard);
  registerColumnRoutes(app, guard);
}

function registerSprintRoutes(app: FastifyInstance, guard: MemberGuard): void {
  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/sprints",
    { schema: { params: projectParams, response: { 200: { type: "object", properties: { items: { type: "array", items: sprintResponse } } } } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const rows = await guard.run(request, reply, member, async (client) => {
        const project = await readProjectRef(client, request.params.projectId);
        if (!project) return null;
        const scope = [project.tenant_id, project.id];
        const open = await client.query<SprintRow>(
          `${SELECT_SPRINT} WHERE s.tenant_id = $1 AND s.project_id = $2 AND s.status IN ('active', 'planned')
           ORDER BY s.status = 'active' DESC, s.starts_at NULLS LAST, s.created_at, s.id`,
          scope,
        );
        const finished = await client.query<SprintRow>(
          `${SELECT_SPRINT} WHERE s.tenant_id = $1 AND s.project_id = $2 AND s.status IN ('completed', 'cancelled')
           ORDER BY s.completed_at DESC NULLS LAST, s.created_at DESC, s.id DESC LIMIT ${FINISHED_SPRINTS_LIMIT}`,
          scope,
        );
        return [...open.rows, ...finished.rows];
      });
      if (reply.sent) return reply;
      if (!rows) return problem(request, reply, ...projectNotFound);
      return { items: rows.map(toSprint) };
    },
  );

  app.get<{ Params: { sprintId: string } }>(
    "/api/v1/sprints/:sprintId",
    { schema: { params: sprintParams, response: { 200: sprintResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const sprint = await guard.run(request, reply, member, (client) => readSprint(client, request.params.sprintId));
      if (reply.sent) return reply;
      if (!sprint) return problem(request, reply, ...sprintNotFound);
      return reply.header("ETag", formatEtag(sprint.version)).send(sprint);
    },
  );

  app.post<{ Params: { projectId: string }; Body: CreateSprintBody }>(
    "/api/v1/projects/:projectId/sprints",
    { config: MUTATION_RATE_LIMIT, schema: { params: projectParams, body: createSprintBody, response: { 201: sprintResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const { body } = request;
      const result = await guard.run(request, reply, member, async (client) => {
        const created = await client.query<{ outcome: string; sprint_id: string | null }>(
          "SELECT outcome, sprint_id FROM spark.ws_create_sprint($1, $2, $3, $4, $5)",
          [request.params.projectId, body.name, body.goal ?? null, body.startsOn ?? null, body.endsOn ?? null],
        );
        const row = created.rows[0];
        const mapped = row ? projectOutcomes[row.outcome] : undefined;
        if (mapped) return { mapped };
        expectOutcome(row?.outcome, "ok");
        const sprint = row?.sprint_id ? await readSprint(client, row.sprint_id) : null;
        if (!sprint) throw new Error("Created sprint is not readable");
        return { sprint };
      });
      if (reply.sent || !result) return reply;
      if (result.mapped) return problem(request, reply, ...result.mapped);
      const { sprint } = result;
      return reply.code(201).header("Location", `/api/v1/sprints/${sprint.id}`).header("ETag", formatEtag(sprint.version)).send(sprint);
    },
  );

  /** Runs a versioned sprint command and re-reads the sprint (also for the 412 body). */
  const sprintCommand = async <Row extends { outcome: string }>(
    request: FastifyRequest<{ Params: { sprintId: string } }>,
    reply: FastifyReply,
    command: (client: PoolClient, expected: number) => Promise<Row | undefined>,
  ): Promise<Written<{ sprint: Sprint; row: Row }> | undefined> => {
    const member = await guard.authenticate(request, reply);
    if (!member) return undefined;
    const expected = requireVersion(request, reply);
    if (expected === undefined) return undefined;
    return guard.run(request, reply, member, async (client) => {
      const row = await command(client, expected);
      const mapped = row ? sprintOutcomes[row.outcome] : undefined;
      if (mapped) return { mapped };
      expectOutcome(row?.outcome, "ok", "version_mismatch");
      const sprint = await readSprint(client, request.params.sprintId);
      if (!sprint || !row) return { mapped: sprintNotFound };
      return { value: { sprint, row }, stale: row.outcome === "version_mismatch" };
    });
  };

  const sendSprint = (request: FastifyRequest, reply: FastifyReply, result: Written<{ sprint: Sprint }> | undefined) => {
    if (result && "value" in result && result.stale) return preconditionFailed(request, reply, result.value.sprint);
    return sendWritten(request, reply, result, (v) => v.sprint.version, (v) => v.sprint);
  };

  app.patch<{ Params: { sprintId: string }; Body: PatchSprintBody }>(
    "/api/v1/sprints/:sprintId",
    { config: MUTATION_RATE_LIMIT, schema: { params: sprintParams, body: patchSprintBody, response: { 200: sprintResponse } } },
    async (request, reply) => {
      const result = await sprintCommand(request, reply, async (client, expected) =>
        (await client.query<{ outcome: string }>("SELECT outcome FROM spark.ws_update_sprint($1, $2, $3)", [request.params.sprintId, expected, JSON.stringify(request.body)])).rows[0]);
      return sendSprint(request, reply, result);
    },
  );

  app.post<{ Params: { sprintId: string } }>(
    "/api/v1/sprints/:sprintId/start",
    { config: MUTATION_RATE_LIMIT, schema: { params: sprintParams, response: { 200: sprintResponse } } },
    async (request, reply) => {
      const result = await sprintCommand(request, reply, async (client, expected) =>
        (await client.query<{ outcome: string }>("SELECT outcome FROM spark.ws_start_sprint($1, $2)", [request.params.sprintId, expected])).rows[0]);
      return sendSprint(request, reply, result);
    },
  );

  app.post<{ Params: { sprintId: string }; Body: { carryToSprintId: string | null } }>(
    "/api/v1/sprints/:sprintId/complete",
    {
      config: MUTATION_RATE_LIMIT,
      schema: {
        params: sprintParams,
        body: completeSprintBody,
        response: { 200: { type: "object", properties: { sprint: sprintResponse, movedIssues: { type: "integer" } } } },
      },
    },
    async (request, reply) => {
      const result = await sprintCommand(request, reply, async (client, expected) =>
        (await client.query<{ outcome: string; moved_issues: number | null }>(
          "SELECT outcome, moved_issues FROM spark.ws_complete_sprint($1, $2, $3)",
          [request.params.sprintId, expected, request.body.carryToSprintId],
        )).rows[0]);
      if (result && "value" in result && result.stale) return preconditionFailed(request, reply, result.value.sprint);
      return sendWritten(request, reply, result, (v) => v.sprint.version, (v) => ({ sprint: v.sprint, movedIssues: v.row.moved_issues ?? 0 }));
    },
  );
}

function registerPlanRoutes(app: FastifyInstance, guard: MemberGuard): void {
  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/plan",
    { schema: { params: projectParams, response: { 200: planResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const plan = await guard.run(request, reply, member, (client) => readPlan(client, request.params.projectId));
      if (reply.sent) return reply;
      if (!plan) return problem(request, reply, ...projectNotFound);
      return reply.header("ETag", formatEtag(plan.version)).send(plan);
    },
  );

  /** Runs a versioned project-plan command (phases, re-baseline) and answers with the plan. */
  const planCommand = async (
    request: FastifyRequest<{ Params: { projectId: string } }>,
    reply: FastifyReply,
    command: (client: PoolClient, expected: number) => Promise<{ outcome: string } | undefined>,
  ) => {
    const member = await guard.authenticate(request, reply);
    if (!member) return reply;
    const expected = requireVersion(request, reply);
    if (expected === undefined) return reply;
    const result = await guard.run(request, reply, member, async (client): Promise<Written<Plan>> => {
      const outcome = (await command(client, expected))?.outcome;
      const mapped = outcome ? projectOutcomes[outcome] : undefined;
      if (mapped) return { mapped };
      expectOutcome(outcome, "ok", "version_mismatch");
      const plan = await readPlan(client, request.params.projectId);
      if (!plan) return { mapped: projectNotFound };
      return { value: plan, stale: outcome === "version_mismatch" };
    });
    return sendWritten(request, reply, result, (plan) => plan.version);
  };

  app.put<{ Params: { projectId: string }; Body: { phases: PhaseInput[] } }>(
    "/api/v1/projects/:projectId/phases",
    { config: MUTATION_RATE_LIMIT, schema: { params: projectParams, body: phasesBody, response: { 200: planResponse } } },
    (request, reply) =>
      planCommand(request, reply, async (client, expected) =>
        (await client.query<{ outcome: string }>("SELECT outcome FROM spark.ws_save_phases($1, $2, $3)", [request.params.projectId, expected, JSON.stringify(request.body.phases)])).rows[0]),
  );

  app.post<{ Params: { projectId: string }; Body: { reason: string } }>(
    "/api/v1/projects/:projectId/baseline",
    { config: MUTATION_RATE_LIMIT, schema: { params: projectParams, body: baselineBody, response: { 200: planResponse } } },
    (request, reply) =>
      planCommand(request, reply, async (client, expected) =>
        (await client.query<{ outcome: string }>("SELECT outcome FROM spark.ws_rebaseline_project($1, $2, $3)", [request.params.projectId, expected, request.body.reason])).rows[0]),
  );

  app.post<{ Params: { projectId: string }; Body: CreateMilestoneBody }>(
    "/api/v1/projects/:projectId/milestones",
    { config: MUTATION_RATE_LIMIT, schema: { params: projectParams, body: createMilestoneBody, response: { 201: milestoneResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const { body } = request;
      const result = await guard.run(request, reply, member, async (client) => {
        const created = await client.query<{ outcome: string; milestone_id: string | null }>(
          "SELECT outcome, milestone_id FROM spark.ws_create_milestone($1, $2, $3, $4)",
          [request.params.projectId, body.name, body.dueDate, body.phaseId ?? null],
        );
        const row = created.rows[0];
        const mapped = row ? projectOutcomes[row.outcome] : undefined;
        if (mapped) return { mapped };
        expectOutcome(row?.outcome, "ok");
        const milestone = row?.milestone_id ? await readMilestone(client, row.milestone_id) : null;
        if (!milestone) throw new Error("Created milestone is not readable");
        return { milestone };
      });
      if (reply.sent || !result) return reply;
      if (result.mapped) return problem(request, reply, ...result.mapped);
      const { milestone } = result;
      return reply.code(201).header("Location", `/api/v1/milestones/${milestone.id}`).header("ETag", formatEtag(milestone.version)).send(milestone);
    },
  );

  app.get<{ Params: { milestoneId: string } }>(
    "/api/v1/milestones/:milestoneId",
    { schema: { params: milestoneParams, response: { 200: milestoneResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const milestone = await guard.run(request, reply, member, (client) => readMilestone(client, request.params.milestoneId));
      if (reply.sent) return reply;
      if (!milestone) return problem(request, reply, ...milestoneNotFound);
      return reply.header("ETag", formatEtag(milestone.version)).send(milestone);
    },
  );

  app.patch<{ Params: { milestoneId: string }; Body: PatchMilestoneBody }>(
    "/api/v1/milestones/:milestoneId",
    { config: MUTATION_RATE_LIMIT, schema: { params: milestoneParams, body: patchMilestoneBody, response: { 200: milestoneResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const expected = requireVersion(request, reply);
      if (expected === undefined) return reply;
      const { milestoneId } = request.params;
      const result = await guard.run(request, reply, member, async (client): Promise<Written<Milestone>> => {
        const updated = await client.query<{ outcome: string }>(
          "SELECT outcome FROM spark.ws_update_milestone($1, $2, $3)",
          [milestoneId, expected, JSON.stringify(request.body)],
        );
        const outcome = updated.rows[0]?.outcome;
        const mapped = outcome ? milestoneOutcomes[outcome] : undefined;
        if (mapped) return { mapped };
        expectOutcome(outcome, "ok", "version_mismatch");
        const milestone = await readMilestone(client, milestoneId);
        if (!milestone) return { mapped: milestoneNotFound };
        return { value: milestone, stale: outcome === "version_mismatch" };
      });
      return sendWritten(request, reply, result, (milestone) => milestone.version);
    },
  );
}

function registerColumnRoutes(app: FastifyInstance, guard: MemberGuard): void {
  app.patch<{ Params: { projectId: string; statusId: string }; Body: PatchStatusBody }>(
    "/api/v1/projects/:projectId/statuses/:statusId",
    { config: MUTATION_RATE_LIMIT, schema: { params: statusParams, body: patchStatusBody, response: { 200: projectDetailResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const expected = requireVersion(request, reply);
      if (expected === undefined) return reply;
      const { projectId, statusId } = request.params;
      const { name, wipLimit } = request.body;
      const result = await guard.run(request, reply, member, async (client): Promise<Written<ProjectDetail> | { occupancy: number }> => {
        if (!(await statusInProject(client, projectId, statusId))) return { mapped: statusNotFound };
        // ws_update_status: a NULL limit keeps the current one; clearing it is the explicit flag.
        const updated = await client.query<{ outcome: string }>(
          "SELECT outcome FROM spark.ws_update_status($1, $2, $3, $4, $5)",
          [statusId, expected, name ?? null, wipLimit ?? null, wipLimit === null],
        );
        const outcome = updated.rows[0]?.outcome;
        const mapped = outcome ? statusOutcomes[outcome] : undefined;
        if (mapped) return { mapped };
        if (outcome === "wip_below_occupancy") return { occupancy: await columnOccupancy(client, projectId, statusId) };
        expectOutcome(outcome, "ok", "version_mismatch");
        const project = await readProjectDetail(client, { id: projectId });
        if (!project) return { mapped: projectNotFound };
        return { value: project, stale: outcome === "version_mismatch" };
      });
      if (result && "occupancy" in result) {
        return problem(request, reply, 409, "Conflict", "wip_below_occupancy", `${result.occupancy} cards are in this column; the limit can't be below that.`);
      }
      return sendWritten(request, reply, result, (project) => project.version);
    },
  );

  app.post<{ Params: { projectId: string }; Body: SwitchBody }>(
    "/api/v1/projects/:projectId/methodology",
    {
      config: MUTATION_RATE_LIMIT,
      schema: {
        params: projectParams,
        body: switchBody,
        response: { 200: { type: "object", properties: { project: projectDetailResponse, movedIssues: { type: "integer" } } } },
      },
    },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const expected = requireVersion(request, reply);
      if (expected === undefined) return reply;
      const { body } = request;
      const { projectId } = request.params;
      // The database refuses these too, but only after the version check; refusing them here keeps the
      // error independent of the project's state.
      if (body.to !== "waterfall" && (body.startDate !== undefined || body.targetDate !== undefined || body.phases !== undefined)) {
        return problem(request, reply, 400, "Bad Request", "invalid_input", "Start date, target date and phases apply only when switching to Waterfall.");
      }
      if (body.to !== "scrum" && body.sprintLengthDays !== undefined) {
        return problem(request, reply, 400, "Bad Request", "invalid_input", "A sprint length applies only when switching to Scrum.");
      }
      const result = await guard.run(request, reply, member, async (client): Promise<Written<{ project: ProjectDetail; moved: number }>> => {
        const switched = await client.query<{ outcome: string; moved_issues: number | null }>(
          "SELECT outcome, moved_issues FROM spark.ws_switch_methodology($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
          [
            projectId,
            expected,
            body.to,
            JSON.stringify(body.columns),
            JSON.stringify(body.mapping),
            body.sprintLengthDays ?? null,
            body.startDate ?? null,
            body.targetDate ?? null,
            body.phases === undefined ? null : JSON.stringify(body.phases),
            body.reason,
          ],
        );
        const row = switched.rows[0];
        const mapped = row ? switchOutcomes[row.outcome] : undefined;
        if (mapped) return { mapped };
        expectOutcome(row?.outcome, "ok", "version_mismatch");
        const project = await readProjectDetail(client, { id: projectId });
        if (!project) return { mapped: projectNotFound };
        return { value: { project, moved: row?.moved_issues ?? 0 }, stale: row?.outcome === "version_mismatch" };
      });
      if (result && "value" in result && result.stale) return preconditionFailed(request, reply, result.value.project);
      return sendWritten(request, reply, result, (v) => v.project.version, (v) => ({ project: v.project, movedIssues: v.moved }));
    },
  );
}
