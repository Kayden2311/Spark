import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { formatEtag, parseIfMatch } from "../../modules/work/domain/etag.js";
import { getMethodology, type Methodology, type StatusCategory } from "../../modules/work/domain/methodology.js";
import { spreadPhases } from "../../modules/work/domain/phases.js";
import { problem } from "../responses.js";
import { MUTATION_RATE_LIMIT, expectOutcome } from "../session-guard.js";
import { preconditionFailed, preconditionRequired, type MemberGuard } from "./guard.js";
import { readWorkspace } from "./workspaces.js";

const KEY_PATTERN = "^[A-Z][A-Z0-9]{1,9}$";
const METHODOLOGY_IDS = ["scrum", "kanban", "waterfall"] as const;
const CATEGORIES = ["backlog", "todo", "in_progress", "done"] as const;
const PATCH_KEYS = ["name", "description", "leadUserId", "startDate", "targetDate", "sprintLengthDays"] as const;

// ---------- Representation ----------

export interface Project {
  id: string;
  key: string;
  name: string;
  description: string | null;
  methodology: string;
  lead: { id: string; displayName: string } | null;
  startDate: string | null;
  targetDate: string | null;
  sprintLengthDays: number | null;
  baselinedAt: string | null;
  version: number;
  createdAt: string;
  progress: { total: number; done: number; open: number };
}

export interface ProjectDetail extends Project {
  statuses: Array<{ id: string; name: string; category: string; position: number; wipLimit: number | null }>;
  phases: Array<{
    id: string;
    name: string;
    position: number;
    plannedStart: string;
    plannedEnd: string;
    baselineStart: string | null;
    baselineEnd: string | null;
    status: string;
  }>;
  milestones: Array<{ id: string; name: string; phaseId: string | null; dueDate: string; baselineDueDate: string | null; completedAt: string | null }>;
}

const nullableString = { type: ["string", "null"] } as const;

const projectProperties = {
  id: { type: "string" },
  key: { type: "string" },
  name: { type: "string" },
  description: nullableString,
  methodology: { type: "string", enum: METHODOLOGY_IDS },
  lead: {
    type: ["object", "null"],
    properties: { id: { type: "string" }, displayName: { type: "string" } },
  },
  startDate: nullableString,
  targetDate: nullableString,
  sprintLengthDays: { type: ["integer", "null"] },
  baselinedAt: nullableString,
  version: { type: "integer" },
  createdAt: { type: "string" },
  progress: {
    type: "object",
    properties: { total: { type: "integer" }, done: { type: "integer" }, open: { type: "integer" } },
  },
} as const;

const projectResponse = { type: "object", properties: projectProperties } as const;

const projectDetailResponse = {
  type: "object",
  properties: {
    ...projectProperties,
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
        },
      },
    },
    phases: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          position: { type: "integer" },
          plannedStart: { type: "string" },
          plannedEnd: { type: "string" },
          baselineStart: nullableString,
          baselineEnd: nullableString,
          status: { type: "string" },
        },
      },
    },
    milestones: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          phaseId: nullableString,
          dueDate: { type: "string" },
          baselineDueDate: nullableString,
          completedAt: nullableString,
        },
      },
    },
  },
} as const;

// ---------- Reads (RLS-scoped, explicit columns only) ----------

interface ProjectRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  methodology: string;
  start_date: string | null;
  target_date: string | null;
  sprint_length_days: number | null;
  baselined_at: Date | null;
  settings_version: number;
  created_at: Date;
  lead_id: string | null;
  lead_display_name: string | null;
  issue_total: string;
  issue_done: string;
}

// Dates leave the database as YYYY-MM-DD text so no time zone conversion can shift them. The lead is
// joined through the coworker-scoped users policy; a lead the actor can no longer see reads as no lead.
const SELECT_PROJECT = `SELECT p.id, p.key, p.name, p.description, p.methodology,
  to_char(p.start_date, 'YYYY-MM-DD') AS start_date, to_char(p.target_date, 'YYYY-MM-DD') AS target_date,
  p.sprint_length_days, p.baselined_at, p.settings_version, p.created_at,
  u.id AS lead_id, u.display_name AS lead_display_name,
  progress.total AS issue_total, progress.done AS issue_done
  FROM spark.projects p
  LEFT JOIN spark.users u ON u.id = p.lead_user_id
  CROSS JOIN LATERAL (
    SELECT count(*) AS total, count(*) FILTER (WHERE st.category = 'done') AS done
    FROM spark.issues i JOIN spark.issue_statuses st ON st.tenant_id = i.tenant_id AND st.id = i.status_id
    WHERE i.tenant_id = p.tenant_id AND i.project_id = p.id AND i.archived_at IS NULL
  ) progress`;

function toProject(row: ProjectRow): Project {
  const total = Number(row.issue_total);
  const done = Number(row.issue_done);
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    methodology: row.methodology,
    lead: row.lead_id && row.lead_display_name !== null ? { id: row.lead_id, displayName: row.lead_display_name } : null,
    startDate: row.start_date,
    targetDate: row.target_date,
    sprintLengthDays: row.sprint_length_days,
    baselinedAt: row.baselined_at ? row.baselined_at.toISOString() : null,
    version: row.settings_version,
    createdAt: row.created_at.toISOString(),
    progress: { total, done, open: total - done },
  };
}

interface StatusRow { id: string; name: string; category: string; position: string; wip_limit: number | null }
interface PhaseRow {
  id: string;
  name: string;
  position: number;
  planned_start: string;
  planned_end: string;
  baseline_start: string | null;
  baseline_end: string | null;
  status: string;
}
interface MilestoneRow { id: string; name: string; phase_id: string | null; due_date: string; baseline_due_date: string | null; completed_at: Date | null }

/** The project as the actor sees it (any active member), or null when it is not visible. */
export async function readProjectDetail(client: PoolClient, by: { id: string } | { workspaceId: string; key: string }): Promise<ProjectDetail | null> {
  const found = "id" in by
    ? await client.query<ProjectRow>(`${SELECT_PROJECT} WHERE p.id = $1`, [by.id])
    : await client.query<ProjectRow>(`${SELECT_PROJECT} WHERE p.tenant_id = $1 AND p.key = $2`, [by.workspaceId, by.key]);
  const row = found.rows[0];
  if (!row) return null;
  const scope = [row.id];
  const statuses = await client.query<StatusRow>(
    "SELECT s.id, s.name, s.category, s.position, s.wip_limit FROM spark.issue_statuses s WHERE s.project_id = $1 ORDER BY s.position, s.id",
    scope,
  );
  const phases = await client.query<PhaseRow>(
    `SELECT ph.id, ph.name, ph.position, to_char(ph.planned_start, 'YYYY-MM-DD') AS planned_start,
     to_char(ph.planned_end, 'YYYY-MM-DD') AS planned_end, to_char(ph.baseline_start, 'YYYY-MM-DD') AS baseline_start,
     to_char(ph.baseline_end, 'YYYY-MM-DD') AS baseline_end, ph.status
     FROM spark.project_phases ph WHERE ph.project_id = $1 ORDER BY ph.position`,
    scope,
  );
  const milestones = await client.query<MilestoneRow>(
    `SELECT ms.id, ms.name, ms.phase_id, to_char(ms.due_date, 'YYYY-MM-DD') AS due_date,
     to_char(ms.baseline_due_date, 'YYYY-MM-DD') AS baseline_due_date, ms.completed_at
     FROM spark.project_milestones ms WHERE ms.project_id = $1 ORDER BY ms.due_date, ms.name, ms.id`,
    scope,
  );
  return {
    ...toProject(row),
    statuses: statuses.rows.map((s) => ({ id: s.id, name: s.name, category: s.category, position: Number(s.position), wipLimit: s.wip_limit })),
    phases: phases.rows.map((p) => ({
      id: p.id,
      name: p.name,
      position: p.position,
      plannedStart: p.planned_start,
      plannedEnd: p.planned_end,
      baselineStart: p.baseline_start,
      baselineEnd: p.baseline_end,
      status: p.status,
    })),
    milestones: milestones.rows.map((m) => ({
      id: m.id,
      name: m.name,
      phaseId: m.phase_id,
      dueDate: m.due_date,
      baselineDueDate: m.baseline_due_date,
      completedAt: m.completed_at ? m.completed_at.toISOString() : null,
    })),
  };
}

// ---------- Request schemas ----------

const date = { type: "string", format: "date" } as const;
const nullableDate = { type: ["string", "null"], format: "date" } as const;
const uuid = { type: "string", format: "uuid" } as const;

const workspaceParams = {
  type: "object",
  required: ["workspaceId"],
  properties: { workspaceId: uuid },
  additionalProperties: false,
} as const;

const keyParams = {
  type: "object",
  required: ["workspaceId", "key"],
  properties: { workspaceId: uuid, key: { type: "string", pattern: KEY_PATTERN } },
  additionalProperties: false,
} as const;

const projectParams = {
  type: "object",
  required: ["projectId"],
  properties: { projectId: uuid },
  additionalProperties: false,
} as const;

// Fastify's validator strips unknown keys instead of failing (removeAdditional); propertyNames makes them a 400.
const createBody = {
  type: "object",
  required: ["key", "name", "methodology"],
  propertyNames: {
    enum: ["key", "name", "description", "methodology", "leadUserId", "startDate", "targetDate", "sprintLengthDays", "statuses", "phases"],
  },
  properties: {
    key: { type: "string", pattern: KEY_PATTERN },
    name: { type: "string", minLength: 1, maxLength: 80 },
    description: { type: ["string", "null"], maxLength: 2000 },
    methodology: { type: "string", enum: METHODOLOGY_IDS },
    leadUserId: { type: ["string", "null"], format: "uuid" },
    startDate: nullableDate,
    targetDate: nullableDate,
    sprintLengthDays: { type: ["integer", "null"], minimum: 7, maximum: 28 },
    statuses: {
      type: "array",
      minItems: 2,
      maxItems: 12,
      items: {
        type: "object",
        required: ["name", "category"],
        propertyNames: { enum: ["name", "category", "wipLimit"] },
        properties: {
          name: { type: "string", minLength: 1, maxLength: 40 },
          category: { type: "string", enum: CATEGORIES },
          wipLimit: { type: ["integer", "null"], minimum: 1, maximum: 99 },
        },
        additionalProperties: false,
      },
    },
    phases: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        required: ["name", "plannedStart", "plannedEnd"],
        propertyNames: { enum: ["name", "plannedStart", "plannedEnd"] },
        properties: { name: { type: "string", minLength: 1, maxLength: 60 }, plannedStart: date, plannedEnd: date },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;

const patchBody = {
  type: "object",
  minProperties: 1,
  propertyNames: { enum: PATCH_KEYS },
  properties: {
    name: { type: "string", minLength: 1, maxLength: 80 },
    description: { type: ["string", "null"], maxLength: 2000 },
    leadUserId: { type: ["string", "null"], format: "uuid" },
    startDate: nullableDate,
    targetDate: nullableDate,
    sprintLengthDays: { type: "integer", minimum: 7, maximum: 28 },
  },
  additionalProperties: false,
} as const;

interface StatusInput { name: string; category: StatusCategory; wipLimit?: number | null }
interface PhaseInput { name: string; plannedStart: string; plannedEnd: string }

interface CreateBody {
  key: string;
  name: string;
  description?: string | null;
  methodology: Methodology;
  leadUserId?: string | null;
  startDate?: string | null;
  targetDate?: string | null;
  sprintLengthDays?: number | null;
  statuses?: StatusInput[];
  phases?: PhaseInput[];
}

type PatchBody = Partial<{ name: string; description: string | null; leadUserId: string | null; startDate: string | null; targetDate: string | null; sprintLengthDays: number }>;

// ---------- Outcomes ----------

type Mapped = [number, string, string, string];

const workspaceNotFound: Mapped = [404, "Not Found", "workspace_not_found", "Workspace does not exist."];
const projectNotFound: Mapped = [404, "Not Found", "project_not_found", "Project does not exist."];
const invalidLead: Mapped = [422, "Unprocessable Content", "invalid_lead", "The project lead must be an active member of the workspace."];

// Outcome -> [status, title, code, detail]; an outcome missing from the table must be allowed explicitly or the route throws.
const createOutcomes: Record<string, Mapped> = {
  not_found: workspaceNotFound,
  forbidden: [403, "Forbidden", "insufficient_role", "Only an owner or admin can create projects."],
  key_taken: [409, "Conflict", "key_taken", "That project key is already used in this workspace."],
  too_many_projects: [409, "Conflict", "too_many_projects", "This workspace already has the maximum number of projects."],
  invalid_lead: invalidLead,
};

const updateOutcomes: Record<string, Mapped> = {
  not_found: projectNotFound,
  forbidden: [403, "Forbidden", "insufficient_role", "Only an owner, an admin or the project lead can change project settings."],
  invalid_lead: invalidLead,
};

function invalidDates(request: FastifyRequest, reply: FastifyReply) {
  return problem(request, reply, 400, "Bad Request", "invalid_input", "Invalid project dates.");
}

/** Template defaults the API fills in before the database validates the full plan. */
function planFor(body: CreateBody): { statuses: StatusInput[]; phases: PhaseInput[]; sprintLengthDays: number | null } {
  const template = getMethodology(body.methodology);
  const statuses = body.statuses ?? template.statuses.map(({ name, category, wipLimit }) => ({ name, category, wipLimit }));
  let phases = body.phases ?? [];
  if (body.methodology === "waterfall" && body.phases === undefined) {
    phases = spreadPhases(body.startDate ?? "", body.targetDate ?? "", template.defaults.phaseNames);
  }
  const sprintLengthDays = body.sprintLengthDays ?? (body.methodology === "scrum" ? template.defaults.sprintLengthDays : null);
  return { statuses, phases, sprintLengthDays };
}

// ---------- Routes ----------

export function registerProjectRoutes(app: FastifyInstance, guard: MemberGuard): void {
  app.post<{ Params: { workspaceId: string }; Body: CreateBody }>(
    "/api/v1/workspaces/:workspaceId/projects",
    {
      config: { rateLimit: { max: 20, timeWindow: 60 * 60 * 1000 } },
      schema: { params: workspaceParams, body: createBody, response: { 201: projectDetailResponse } },
    },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const { body } = request;
      let plan: ReturnType<typeof planFor>;
      try {
        plan = planFor(body);
      } catch (error) {
        if (error instanceof RangeError) return invalidDates(request, reply);
        throw error;
      }

      const result = await guard.run(request, reply, member, async (client) => {
        const created = await client.query<{ outcome: string; project_id: string | null; settings_version: number | null }>(
          "SELECT outcome, project_id, settings_version FROM spark.ws_create_project($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
          [
            request.params.workspaceId,
            body.key,
            body.name,
            body.description ?? null,
            body.methodology,
            body.leadUserId ?? null,
            body.startDate ?? null,
            body.targetDate ?? null,
            plan.sprintLengthDays,
            JSON.stringify(plan.statuses),
            JSON.stringify(plan.phases),
          ],
        );
        const row = created.rows[0];
        const mapped = row ? createOutcomes[row.outcome] : undefined;
        if (mapped) return { mapped };
        expectOutcome(row?.outcome, "ok");
        const project = row?.project_id ? await readProjectDetail(client, { id: row.project_id }) : null;
        if (!project) throw new Error("Created project is not readable");
        return { project };
      });
      if (reply.sent || !result) return reply;
      if (result.mapped) return problem(request, reply, ...result.mapped);
      const { project } = result;
      return reply
        .code(201)
        .header("Location", `/api/v1/projects/${project.id}`)
        .header("ETag", formatEtag(project.version))
        .send(project);
    },
  );

  app.get<{ Params: { workspaceId: string } }>(
    "/api/v1/workspaces/:workspaceId/projects",
    { schema: { params: workspaceParams, response: { 200: { type: "object", properties: { items: { type: "array", items: projectResponse } } } } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const { workspaceId } = request.params;
      const rows = await guard.run(request, reply, member, async (client) => {
        if (!(await readWorkspace(client, member.userId, { id: workspaceId }))) return null;
        const list = await client.query<ProjectRow>(`${SELECT_PROJECT} WHERE p.tenant_id = $1 AND p.archived_at IS NULL ORDER BY p.name, p.id`, [workspaceId]);
        return list.rows;
      });
      if (reply.sent) return reply;
      if (!rows) return problem(request, reply, ...workspaceNotFound);
      return { items: rows.map(toProject) };
    },
  );

  app.get<{ Params: { workspaceId: string; key: string } }>(
    "/api/v1/workspaces/:workspaceId/projects/by-key/:key",
    { schema: { params: keyParams, response: { 200: projectDetailResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const project = await guard.run(request, reply, member, (client) =>
        readProjectDetail(client, { workspaceId: request.params.workspaceId, key: request.params.key }));
      if (reply.sent) return reply;
      if (!project) return problem(request, reply, ...projectNotFound);
      return reply.header("ETag", formatEtag(project.version)).send(project);
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId",
    { schema: { params: projectParams, response: { 200: projectDetailResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const project = await guard.run(request, reply, member, (client) => readProjectDetail(client, { id: request.params.projectId }));
      if (reply.sent) return reply;
      if (!project) return problem(request, reply, ...projectNotFound);
      return reply.header("ETag", formatEtag(project.version)).send(project);
    },
  );

  app.patch<{ Params: { projectId: string }; Body: PatchBody }>(
    "/api/v1/projects/:projectId",
    { config: MUTATION_RATE_LIMIT, schema: { params: projectParams, body: patchBody, response: { 200: projectDetailResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const expected = parseIfMatch(request.headers["if-match"]);
      if (expected === null) return preconditionRequired(request, reply);
      if (expected === "invalid") return problem(request, reply, 400, "Bad Request", "invalid_if_match", "If-Match must be a single strong entity tag such as \"v1\".");
      const { projectId } = request.params;

      const result = await guard.run(request, reply, member, async (client) => {
        const updated = await client.query<{ outcome: string; settings_version: number | null }>(
          "SELECT outcome, settings_version FROM spark.ws_update_project($1, $2, $3)",
          [projectId, expected, JSON.stringify(request.body)],
        );
        const outcome = updated.rows[0]?.outcome;
        const mapped = outcome ? updateOutcomes[outcome] : undefined;
        if (mapped) return { mapped };
        expectOutcome(outcome, "ok", "version_mismatch");
        const project = await readProjectDetail(client, { id: projectId });
        if (!project) throw new Error("Updated project is not readable");
        return { project, stale: outcome === "version_mismatch" };
      });
      if (reply.sent || !result) return reply;
      if (result.mapped) return problem(request, reply, ...result.mapped);
      if (result.stale) return preconditionFailed(request, reply, result.project);
      return reply.header("ETag", formatEtag(result.project.version)).send(result.project);
    },
  );
}
