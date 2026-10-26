import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import {
  addDays,
  chooseUnit,
  creepPercent,
  forecast,
  idealLine,
  milestoneState,
  planPercent,
  planStatus,
  rangeOf,
  reliability,
  todayUtc,
  varianceDays,
  type MilestoneState,
  type PlanStatus,
  type Unit,
} from "../../modules/work/domain/metrics.js";
import { problem } from "../responses.js";
import type { MemberGuard } from "./guard.js";
import { readPeriods, SELECT_SPRINT, sprintResponse, toSprint, type MethodologyPeriod, type SprintRow } from "./planning.js";

// Project insights (M5): read-only. Every route resolves the project through RLS first (404 otherwise), then reads
// inside the session-bound transaction with explicit tenant_id and project_id filters. The history replay lives in
// the spark.insight_* functions (migration 0026); the statements here cover current-state reads.

const FORMER_MEMBER = "Former member";
const UNASSIGNED_LAST = Number.MAX_SAFE_INTEGER;
const OVERDUE_LIMIT = 20;
const WORKSPACE_OVERDUE_LIMIT = 50;
const WORKSPACE_PROJECT_LIMIT = 50;
const VELOCITY_SPRINTS = 6;
const SCATTER_LIMIT = 500;
const AGING_LIMIT = 200;
const THROUGHPUT_DAYS = 14;
const REFERENCE_DAYS = 90;
const DEFAULT_DAYS = 30;

const projectNotFound = [404, "Not Found", "project_not_found", "Project does not exist."] as const;
const sprintNotFound = [404, "Not Found", "sprint_not_found", "Sprint does not exist."] as const;
const periodNotFound = [404, "Not Found", "period_not_found", "Period does not exist."] as const;
const workspaceNotFound = [404, "Not Found", "workspace_not_found", "Workspace does not exist."] as const;
const sprintMissingDates = [409, "Conflict", "sprint_missing_dates", "Set the sprint's start and end dates to see its burndown."] as const;

// ---------- Schemas ----------

const uuid = { type: "string", format: "uuid" } as const;
const projectParams = { type: "object", required: ["projectId"], properties: { projectId: uuid }, additionalProperties: false } as const;

// Fastify's validator strips unknown keys instead of failing (removeAdditional); propertyNames makes them a 400.
const rangeQuery = {
  type: "object",
  propertyNames: { enum: ["days"] },
  properties: { days: { type: "integer", minimum: 7, maximum: 180, default: DEFAULT_DAYS } },
  additionalProperties: false,
} as const;
const periodQuery = {
  type: "object",
  propertyNames: { enum: ["period"] },
  properties: { period: uuid },
  additionalProperties: false,
} as const;
const sprintParams = { type: "object", required: ["sprintId"], properties: { sprintId: uuid }, additionalProperties: false } as const;
const workspaceParams = { type: "object", required: ["workspaceId"], properties: { workspaceId: uuid }, additionalProperties: false } as const;
const noQuery = { type: "object", propertyNames: false, additionalProperties: false } as const;

const nullableString = { type: ["string", "null"] } as const;
const nullableNumber = { type: ["number", "null"] } as const;
const userRef = { type: ["object", "null"], properties: { id: { type: "string" }, displayName: { type: "string" } } } as const;
const rangeResponse = { type: "object", properties: { from: { type: "string" }, to: { type: "string" } } } as const;
const percentiles = { type: "object", properties: { p50: nullableNumber, p85: nullableNumber } } as const;

const summaryResponse = {
  type: "object",
  properties: {
    unit: { type: "string" },
    total: { type: "number" },
    done: { type: "number" },
    open: { type: "number" },
    donePercent: { type: "number" },
    plan: {
      type: "object",
      properties: {
        kind: nullableString,
        label: nullableString,
        start: nullableString,
        end: nullableString,
        planPercent: nullableNumber,
        status: { type: "string" },
      },
    },
    forecast: { type: "object", properties: { ratePerDay: { type: "number" }, date: nullableString } },
    overdue: {
      type: "object",
      properties: {
        count: { type: "integer" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { issueId: { type: "string" }, key: { type: "string" }, title: { type: "string" }, dueDate: { type: "string" }, assignee: userRef },
          },
        },
      },
    },
    periods: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, methodology: { type: "string" }, startedAt: { type: "string" }, endedAt: nullableString },
      },
    },
  },
} as const;

const membersResponse = {
  type: "object",
  properties: {
    range: rangeResponse,
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          user: userRef,
          completed: { type: "integer" },
          completedPoints: { type: "number" },
          onTimeRate: nullableNumber,
          open: { type: "integer" },
          overdue: { type: "integer" },
          medianCycleDays: nullableNumber,
        },
      },
    },
  },
} as const;

const flowResponse = {
  type: "object",
  properties: {
    range: rangeResponse,
    days: {
      type: "array",
      items: {
        type: "object",
        properties: {
          day: { type: "string" },
          backlog: { type: "integer" },
          todo: { type: "integer" },
          inProgress: { type: "integer" },
          done: { type: "integer" },
          completed: { type: "integer" },
          completedPoints: { type: "number" },
        },
      },
    },
    markers: { type: "array", items: { type: "object", properties: { at: { type: "string" }, from: { type: "string" }, to: { type: "string" } } } },
  },
} as const;

const cycleTimeResponse = {
  type: "object",
  properties: {
    range: rangeResponse,
    points: {
      type: "array",
      items: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          key: { type: "string" },
          title: { type: "string" },
          completedAt: { type: "string" },
          cycleDays: nullableNumber,
          leadDays: { type: "number" },
        },
      },
    },
    cycle: percentiles,
    lead: percentiles,
    truncated: { type: "boolean" },
  },
} as const;

const agingResponse = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          key: { type: "string" },
          title: { type: "string" },
          statusName: { type: "string" },
          assignee: userRef,
          startedAt: nullableString,
          ageDays: { type: "number" },
        },
      },
    },
    columns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          statusId: { type: "string" },
          name: { type: "string" },
          category: { type: "string" },
          wipLimit: { type: ["integer", "null"] },
          count: { type: "integer" },
        },
      },
    },
    cycle: percentiles,
  },
} as const;

const periodResponse = {
  type: "object",
  properties: { id: { type: "string" }, methodology: { type: "string" }, startedAt: { type: "string" }, endedAt: nullableString },
} as const;

const velocityResponse = {
  type: "object",
  properties: {
    period: periodResponse,
    unit: { type: "string" },
    sprints: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          completedAt: { type: "string" },
          committedPoints: nullableNumber,
          completedPoints: nullableNumber,
          committedCount: { type: ["integer", "null"] },
          completedCount: { type: ["integer", "null"] },
          reliability: nullableNumber,
          alreadyDone: { type: "integer" },
          added: { type: "object", properties: { count: { type: "integer" }, points: { type: "number" } } },
          removed: { type: "integer" },
          creepPercent: nullableNumber,
        },
      },
    },
    averageVelocity: nullableNumber,
  },
} as const;

const burndownResponse = {
  type: "object",
  properties: {
    sprint: sprintResponse,
    unit: { type: "string" },
    base: { type: "number" },
    days: {
      type: "array",
      items: { type: "object", properties: { day: { type: "string" }, ideal: { type: "number" }, scope: nullableNumber, remaining: nullableNumber } },
    },
  },
} as const;

const scheduleResponse = {
  type: "object",
  properties: {
    period: periodResponse,
    phases: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          plannedStart: { type: "string" },
          plannedEnd: { type: "string" },
          baselineStart: nullableString,
          baselineEnd: nullableString,
          varianceDays: { type: ["integer", "null"] },
          unit: { type: "string" },
          total: { type: "number" },
          done: { type: "number" },
          donePercent: { type: "number" },
          planPercent: nullableNumber,
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
          state: { type: "string" },
        },
      },
    },
    counts: { type: "object", properties: { hit: { type: "integer" }, missed: { type: "integer" }, atRisk: { type: "integer" }, upcoming: { type: "integer" } } },
    scheduleVarianceDays: { type: ["integer", "null"] },
  },
} as const;

const workspaceInsightsResponse = {
  type: "object",
  properties: {
    range: rangeResponse,
    projects: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          key: { type: "string" },
          name: { type: "string" },
          methodology: { type: "string" },
          unit: { type: "string" },
          donePercent: { type: "number" },
          planPercent: nullableNumber,
          status: { type: "string" },
          open: { type: "integer" },
          overdue: { type: "integer" },
        },
      },
    },
    members: membersResponse.properties.items,
    calendar: { type: "array", items: { type: "object", properties: { day: { type: "string" }, value: { type: "integer" } } } },
    overdue: {
      type: "array",
      items: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          key: { type: "string" },
          title: { type: "string" },
          projectKey: { type: "string" },
          dueDate: { type: "string" },
          assignee: userRef,
        },
      },
    },
  },
} as const;

// ---------- Reads ----------

interface ProjectRef {
  id: string;
  tenant_id: string;
  key: string;
  methodology: string;
  start_date: string | null;
  target_date: string | null;
}

async function readProject(client: PoolClient, projectId: string): Promise<ProjectRef | null> {
  const found = await client.query<ProjectRef>(
    `SELECT p.id, p.tenant_id, p.key, p.methodology, to_char(p.start_date, 'YYYY-MM-DD') AS start_date,
       to_char(p.target_date, 'YYYY-MM-DD') AS target_date
     FROM spark.projects p WHERE p.id = $1 AND p.tenant_id = ANY ((SELECT spark.session_workspace_ids())::uuid[])`,
    [projectId],
  );
  return found.rows[0] ?? null;
}

// numeric and bigint arrive from pg as text.
const num = (value: string | number): number => Number(value);
const nullableNum = (value: string | number | null): number | null => (value === null ? null : Number(value));
const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

function userOf(id: string | null, displayName: string | null): { id: string; displayName: string } | null {
  return id === null ? null : { id, displayName: displayName ?? FORMER_MEMBER };
}

interface FlowRow {
  day: string;
  backlog: number;
  todo: number;
  in_progress: number;
  done: number;
  completed: number;
  completed_points: string;
}

async function readFlow(client: PoolClient, project: ProjectRef, from: string, to: string): Promise<FlowRow[]> {
  const found = await client.query<FlowRow>(
    `SELECT to_char(f.day, 'YYYY-MM-DD') AS day, f.backlog, f.todo, f.in_progress, f.done, f.completed, f.completed_points
     FROM spark.insight_flow($1, $2, $3::date, $4::date) f ORDER BY f.day`,
    [project.tenant_id, project.id, from, to],
  );
  return found.rows;
}

interface Percentiles {
  cycle_p50: string | null;
  cycle_p85: string | null;
  lead_p50: string | null;
  lead_p85: string | null;
}

/** Cycle (started to completed) and lead (created to completed) percentiles over issues completed in the UTC day range. */
async function readPercentiles(client: PoolClient, project: ProjectRef, from: string, to: string): Promise<Percentiles> {
  const found = await client.query<Percentiles>(
    `WITH done AS (
       SELECT extract(epoch FROM i.completed_at - i.started_at) / 86400 AS cycle_elapsed_days,
         extract(epoch FROM i.completed_at - i.created_at) / 86400 AS lead_elapsed_days
       FROM spark.issues i
       JOIN spark.issue_statuses st ON st.tenant_id = i.tenant_id AND st.project_id = i.project_id AND st.id = i.status_id
       WHERE i.tenant_id = $1 AND i.project_id = $2 AND st.tenant_id = $1 AND st.project_id = $2 AND st.category = 'done'
         AND i.archived_at IS NULL AND i.completed_at IS NOT NULL
         AND (i.completed_at AT TIME ZONE 'UTC')::date BETWEEN $3::date AND $4::date
     )
     SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY d.cycle_elapsed_days))::numeric, 1) AS cycle_p50,
       round((percentile_cont(0.85) WITHIN GROUP (ORDER BY d.cycle_elapsed_days))::numeric, 1) AS cycle_p85,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY d.lead_elapsed_days))::numeric, 1) AS lead_p50,
       round((percentile_cont(0.85) WITHIN GROUP (ORDER BY d.lead_elapsed_days))::numeric, 1) AS lead_p85
     FROM done d`,
    [project.tenant_id, project.id, from, to],
  );
  return found.rows[0] ?? { cycle_p50: null, cycle_p85: null, lead_p50: null, lead_p85: null };
}

const pair = (p50: string | null, p85: string | null) => ({ p50: nullableNum(p50), p85: nullableNum(p85) });

// ---------- Shared scope maths ----------

/** One SQL aggregate over a scope of non-archived issues: counts arrive as bigint text, points as numeric text. */
interface ScopeAggregate {
  total_count: string;
  done_count: string;
  estimated_count: string;
  total_points: string;
  done_points: string;
}

// Aggregates over issues `i` joined to their status `st`; `inScope` narrows the scope with a FILTER.
const scopeAggregate = (inScope = "true") => `count(*) FILTER (WHERE ${inScope}) AS total_count,
  count(*) FILTER (WHERE ${inScope} AND st.category = 'done') AS done_count,
  count(i.story_points) FILTER (WHERE ${inScope}) AS estimated_count,
  coalesce(sum(coalesce(i.story_points, 0)) FILTER (WHERE ${inScope}), 0) AS total_points,
  coalesce(sum(coalesce(i.story_points, 0)) FILTER (WHERE ${inScope} AND st.category = 'done'), 0) AS done_points`;

interface Completion {
  unit: Unit;
  total: number;
  done: number;
  donePercent: number;
  planPercent: number | null;
  status: PlanStatus;
}

/** Done toward plan in the scope's unit (points when at least 80% of the issues are estimated). */
function completion(agg: ScopeAggregate, window: { start: string; end: string } | null, day: string): Completion {
  const count = num(agg.total_count);
  const estimated = num(agg.estimated_count);
  // chooseUnit works on items; only the estimated share matters, so a stand-in list keeps the 80% rule in one place.
  const unit = chooseUnit(Array.from({ length: count }, (_, index) => ({ points: index < estimated ? 1 : null })));
  const total = unit === "points" ? num(agg.total_points) : count;
  const done = unit === "points" ? num(agg.done_points) : num(agg.done_count);
  const donePercent = total > 0 ? (done / total) * 100 : 0;
  const elapsed = planPercent(window, day);
  // An empty scope has nothing to be late on.
  const status: PlanStatus = total === 0 && elapsed !== null ? "on_track" : planStatus(donePercent, elapsed);
  return { unit, total, done, donePercent, planPercent: elapsed, status };
}

interface WindowedProject {
  methodology: string;
  start_date: string | null;
  target_date: string | null;
}

/** Scrum scores the active sprint; Kanban and Waterfall the project window (both dates needed). */
function planWindow(
  project: WindowedProject,
  sprint: { name: string; starts_on: string | null; ends_on: string | null } | null,
): { window: { start: string; end: string } | null; kind: "sprint" | "project" | null; label: string | null } {
  if (project.methodology === "scrum") {
    return sprint?.starts_on && sprint.ends_on
      ? { window: { start: sprint.starts_on, end: sprint.ends_on }, kind: "sprint", label: sprint.name }
      : { window: null, kind: null, label: null };
  }
  return project.start_date && project.target_date
    ? { window: { start: project.start_date, end: project.target_date }, kind: "project", label: "Project window" }
    : { window: null, kind: null, label: null };
}

// ---------- Member stats (shared by project and workspace insights) ----------

interface MemberStatRow {
  user_id: string | null;
  completed: number;
  completed_points: string;
  with_due: number;
  on_time: number;
  open: number;
  overdue: number;
  median_cycle_days: string | null;
}

interface MemberData {
  stats: MemberStatRow[];
  members: Array<{ user_id: string; display_name: string }>;
  /** Assignees holding work who are no longer active members, with their names. */
  extra: Array<{ id: string; display_name: string }>;
}

async function readMemberData(
  client: PoolClient,
  tenantId: string,
  projectIds: string[],
  range: { from: string; to: string },
  day: string,
): Promise<MemberData> {
  const stats = await client.query<MemberStatRow>(
    `SELECT m.user_id, m.completed, m.completed_points, m.with_due, m.on_time, m.open, m.overdue, m.median_cycle_days
     FROM spark.insight_members($1, $2::uuid[], $3::date, $4::date, $5::date) m`,
    [tenantId, projectIds, range.from, range.to, day],
  );
  const members = await client.query<{ user_id: string; display_name: string }>(
    "SELECT m.user_id, m.display_name FROM spark.ws_list_members($1) m",
    [tenantId],
  );
  const known = new Set(members.rows.map((row) => row.user_id));
  const departed = stats.rows.map((row) => row.user_id).filter((id): id is string => id !== null && !known.has(id));
  // Departed members' names are read from global spark.users under the coworker policy; the ids come from tenant-scoped stats.
  const extra = departed.length === 0
    ? []
    : (await client.query<{ id: string; display_name: string }>("SELECT u.id, u.display_name FROM spark.users u WHERE u.id = ANY ($1::uuid[])", [departed])).rows;
  return { stats: stats.rows, members: members.rows, extra };
}

/** Every active member (zeros when idle), departed assignees still holding work, then Unassigned last. */
function memberItems({ stats, members, extra }: MemberData) {
  const names = new Map<string, string>([...members.map((m) => [m.user_id, m.display_name] as const), ...extra.map((u) => [u.id, u.display_name] as const)]);
  const byUser = new Map(stats.map((row) => [row.user_id, row]));
  const ids = [...members.map((m) => m.user_id), ...extra.map((u) => u.id)];
  const rows: Array<{ id: string | null; name: string }> = ids.map((id) => ({ id, name: names.get(id) ?? FORMER_MEMBER }));
  if (byUser.has(null)) rows.push({ id: null, name: "Unassigned" });

  const entries = rows.map(({ id, name }) => {
    const row = byUser.get(id);
    return {
      name,
      item: {
        user: id === null ? null : { id, displayName: name },
        completed: row?.completed ?? 0,
        completedPoints: row ? num(row.completed_points) : 0,
        onTimeRate: row && row.with_due > 0 ? round((row.on_time / row.with_due) * 100, 1) : null,
        open: row?.open ?? 0,
        overdue: row?.overdue ?? 0,
        medianCycleDays: row ? nullableNum(row.median_cycle_days) : null,
      },
    };
  });
  entries.sort((a, b) => (a.item.user === null ? UNASSIGNED_LAST : 0) - (b.item.user === null ? UNASSIGNED_LAST : 0)
    || b.item.completed - a.item.completed || a.name.localeCompare(b.name) || (a.item.user?.id ?? "").localeCompare(b.item.user?.id ?? ""));
  return entries.map((entry) => entry.item);
}

interface SprintWindowRow { id: string; name: string; starts_on: string | null; ends_on: string | null }

// ---------- Handlers ----------

interface RangeQuery { days: number }
interface PeriodQuery { period?: string }

const nextPeriodTo = (period: MethodologyPeriod): string => period.endedAt ?? new Date().toISOString();

/** The requested period, else the open one; undefined for an id that is not one of the project's periods. */
function pickPeriod(periods: MethodologyPeriod[], requested: string | undefined): MethodologyPeriod | undefined {
  return requested ? periods.find((period) => period.id === requested) : (periods.find((period) => period.endedAt === null) ?? periods[periods.length - 1]);
}

export function registerInsightRoutes(app: FastifyInstance, guard: MemberGuard): void {
  /**
   * Authenticates, resolves the scope (project, sprint or workspace) through RLS and runs `work` in the same
   * session-bound transaction. A scope that is not visible answers `notFound`; the error responses are sent here
   * and undefined is returned.
   */
  async function withScope<S, T>(
    request: FastifyRequest,
    reply: FastifyReply,
    notFound: readonly [number, string, string, string],
    resolve: (client: PoolClient) => Promise<S | null>,
    work: (client: PoolClient, scope: S) => Promise<T>,
  ): Promise<{ scope: S; data: T } | undefined> {
    const member = await guard.authenticate(request, reply);
    if (!member) return undefined;
    const result = await guard.run(request, reply, member, async (client) => {
      const scope = await resolve(client);
      return scope ? { scope, data: await work(client, scope) } : null;
    });
    if (reply.sent) return undefined;
    if (!result) {
      void problem(request, reply, ...notFound);
      return undefined;
    }
    return result;
  }

  async function withProject<T>(
    request: FastifyRequest<{ Params: { projectId: string } }>,
    reply: FastifyReply,
    work: (client: PoolClient, project: ProjectRef) => Promise<T>,
  ): Promise<{ project: ProjectRef; data: T } | undefined> {
    const result = await withScope(request, reply, projectNotFound, (client) => readProject(client, request.params.projectId), work);
    return result ? { project: result.scope, data: result.data } : undefined;
  }

  const today = () => todayUtc(new Date());

  // ----- Summary -----
  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/insights/summary",
    { schema: { params: projectParams, querystring: noQuery, response: { 200: summaryResponse } } },
    async (request, reply) => {
      const day = today();
      const result = await withProject(request, reply, async (client, project) => {
        // Scrum scores the active sprint; Kanban and Waterfall the project window; the unit comes from the scoped issues.
        let sprint: SprintWindowRow | null = null;
        if (project.methodology === "scrum") {
          const found = await client.query<SprintWindowRow>(
            `SELECT s.id, s.name, to_char((s.starts_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS starts_on,
               to_char((s.ends_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS ends_on
             FROM spark.sprints s WHERE s.tenant_id = $1 AND s.project_id = $2 AND s.status = 'active'
             ORDER BY s.started_at DESC, s.id LIMIT 1`,
            [project.tenant_id, project.id],
          );
          sprint = found.rows[0] ?? null;
        }
        const scoped = await client.query<ScopeAggregate>(
          `SELECT ${scopeAggregate()}
           FROM spark.issues i
           JOIN spark.issue_statuses st ON st.tenant_id = i.tenant_id AND st.project_id = i.project_id AND st.id = i.status_id
           WHERE i.tenant_id = $1 AND i.project_id = $2 AND st.tenant_id = $1 AND st.project_id = $2
             AND i.archived_at IS NULL AND ($3::uuid IS NULL OR i.sprint_id = $3::uuid)`,
          [project.tenant_id, project.id, sprint?.id ?? null],
        );
        const flow = await readFlow(client, project, addDays(day, -(THROUGHPUT_DAYS - 1)), day);
        const overdue = await client.query<{
          id: string;
          number: string;
          title: string;
          due_date: string;
          assignee_user_id: string | null;
          assignee_display_name: string | null;
          overdue_total: string;
        }>(
          `SELECT i.id, i.number, i.title, to_char(i.due_date, 'YYYY-MM-DD') AS due_date, i.assignee_user_id,
             a.display_name AS assignee_display_name, count(*) OVER () AS overdue_total
           FROM spark.issues i
           JOIN spark.issue_statuses st ON st.tenant_id = i.tenant_id AND st.project_id = i.project_id AND st.id = i.status_id
           LEFT JOIN spark.users a ON a.id = i.assignee_user_id
           WHERE i.tenant_id = $1 AND i.project_id = $2 AND st.tenant_id = $1 AND st.project_id = $2
             AND i.archived_at IS NULL AND st.category <> 'done' AND i.due_date < $3::date
           ORDER BY i.due_date, i.number, i.id LIMIT ${OVERDUE_LIMIT}`,
          [project.tenant_id, project.id, day],
        );
        const periods = await readPeriods(client, project.tenant_id, project.id);
        return { sprint, scoped: scoped.rows[0]!, flow, overdue: overdue.rows, periods };
      });
      if (!result) return reply;
      const { project, data } = result;

      const { window, kind, label } = planWindow(project, data.sprint);
      const progress = completion(data.scoped, window, day);
      const { unit, total, done } = progress;

      const throughput = data.flow.slice(-THROUGHPUT_DAYS).map((row) => (unit === "points" ? num(row.completed_points) : row.completed));
      const rate = forecast(total - done, throughput, day);

      return {
        unit,
        total,
        done,
        open: total - done,
        donePercent: round(progress.donePercent, 1),
        plan: {
          kind,
          label,
          start: window?.start ?? null,
          end: window?.end ?? null,
          planPercent: progress.planPercent === null ? null : round(progress.planPercent, 1),
          status: progress.status,
        },
        forecast: { ratePerDay: round(rate.ratePerDay, 2), date: rate.date },
        overdue: {
          count: data.overdue.length === 0 ? 0 : num(data.overdue[0]!.overdue_total),
          items: data.overdue.map((row) => ({
            issueId: row.id,
            key: `${project.key}-${row.number}`,
            title: row.title,
            dueDate: row.due_date,
            assignee: userOf(row.assignee_user_id, row.assignee_display_name),
          })),
        },
        periods: data.periods satisfies MethodologyPeriod[],
      };
    },
  );

  // ----- Members -----
  app.get<{ Params: { projectId: string }; Querystring: RangeQuery }>(
    "/api/v1/projects/:projectId/insights/members",
    { schema: { params: projectParams, querystring: rangeQuery, response: { 200: membersResponse } } },
    async (request, reply) => {
      const day = today();
      const range = rangeOf(request.query.days, day);
      const result = await withProject(request, reply, (client, project) => readMemberData(client, project.tenant_id, [project.id], range, day));
      if (!result) return reply;
      return { range, items: memberItems(result.data) };
    },
  );

  // ----- Flow -----
  app.get<{ Params: { projectId: string }; Querystring: RangeQuery }>(
    "/api/v1/projects/:projectId/insights/flow",
    { schema: { params: projectParams, querystring: rangeQuery, response: { 200: flowResponse } } },
    async (request, reply) => {
      const range = rangeOf(request.query.days, today());
      const result = await withProject(request, reply, async (client, project) => ({
        flow: await readFlow(client, project, range.from, range.to),
        periods: await readPeriods(client, project.tenant_id, project.id),
      }));
      if (!result) return reply;
      const start = Date.parse(`${range.from}T00:00:00Z`);
      const end = Date.parse(`${addDays(range.to, 1)}T00:00:00Z`);
      const markers = result.data.periods.flatMap((period, index) => {
        const previous = result.data.periods[index - 1];
        const at = Date.parse(period.startedAt);
        return previous && at >= start && at < end ? [{ at: period.startedAt, from: previous.methodology, to: period.methodology }] : [];
      });
      return {
        range,
        days: result.data.flow.map((row) => ({
          day: row.day,
          backlog: row.backlog,
          todo: row.todo,
          inProgress: row.in_progress,
          done: row.done,
          completed: row.completed,
          completedPoints: num(row.completed_points),
        })),
        markers,
      };
    },
  );

  // ----- Cycle time -----
  app.get<{ Params: { projectId: string }; Querystring: RangeQuery }>(
    "/api/v1/projects/:projectId/insights/cycle-time",
    { schema: { params: projectParams, querystring: rangeQuery, response: { 200: cycleTimeResponse } } },
    async (request, reply) => {
      const range = rangeOf(request.query.days, today());
      const result = await withProject(request, reply, async (client, project) => {
        const points = await client.query<{
          id: string;
          number: string;
          title: string;
          completed_at: Date;
          cycle_days: string | null;
          lead_days: string;
        }>(
          `SELECT i.id, i.number, i.title, i.completed_at,
             round((extract(epoch FROM i.completed_at - i.started_at) / 86400)::numeric, 1) AS cycle_days,
             round((extract(epoch FROM i.completed_at - i.created_at) / 86400)::numeric, 1) AS lead_days
           FROM spark.issues i
           JOIN spark.issue_statuses st ON st.tenant_id = i.tenant_id AND st.project_id = i.project_id AND st.id = i.status_id
           WHERE i.tenant_id = $1 AND i.project_id = $2 AND st.tenant_id = $1 AND st.project_id = $2 AND st.category = 'done'
             AND i.archived_at IS NULL AND i.completed_at IS NOT NULL
             AND (i.completed_at AT TIME ZONE 'UTC')::date BETWEEN $3::date AND $4::date
           ORDER BY i.completed_at DESC, i.id LIMIT ${SCATTER_LIMIT + 1}`,
          [project.tenant_id, project.id, range.from, range.to],
        );
        return { points: points.rows, percentiles: await readPercentiles(client, project, range.from, range.to) };
      });
      if (!result) return reply;
      const { project, data } = result;
      return {
        range,
        points: data.points.slice(0, SCATTER_LIMIT).map((row) => ({
          issueId: row.id,
          key: `${project.key}-${row.number}`,
          title: row.title,
          completedAt: row.completed_at.toISOString(),
          cycleDays: nullableNum(row.cycle_days),
          leadDays: num(row.lead_days),
        })),
        cycle: pair(data.percentiles.cycle_p50, data.percentiles.cycle_p85),
        lead: pair(data.percentiles.lead_p50, data.percentiles.lead_p85),
        truncated: data.points.length > SCATTER_LIMIT,
      };
    },
  );

  // ----- Aging WIP -----
  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/insights/aging-wip",
    { schema: { params: projectParams, querystring: noQuery, response: { 200: agingResponse } } },
    async (request, reply) => {
      const reference = rangeOf(REFERENCE_DAYS, today());
      const result = await withProject(request, reply, async (client, project) => {
        const items = await client.query<{
          id: string;
          number: string;
          title: string;
          status_name: string;
          assignee_user_id: string | null;
          assignee_display_name: string | null;
          started_at: Date | null;
          age_days: string;
        }>(
          `SELECT i.id, i.number, i.title, st.name AS status_name, i.assignee_user_id, a.display_name AS assignee_display_name, i.started_at,
             round((extract(epoch FROM now() - coalesce(i.started_at, i.created_at)) / 86400)::numeric, 1) AS age_days
           FROM spark.issues i
           JOIN spark.issue_statuses st ON st.tenant_id = i.tenant_id AND st.project_id = i.project_id AND st.id = i.status_id
           LEFT JOIN spark.users a ON a.id = i.assignee_user_id
           WHERE i.tenant_id = $1 AND i.project_id = $2 AND st.tenant_id = $1 AND st.project_id = $2
             AND st.category = 'in_progress' AND i.archived_at IS NULL
           ORDER BY coalesce(i.started_at, i.created_at), i.id LIMIT ${AGING_LIMIT}`,
          [project.tenant_id, project.id],
        );
        const columns = await client.query<{ id: string; name: string; category: string; wip_limit: number | null; issue_count: string }>(
          `SELECT s.id, s.name, s.category, s.wip_limit,
             (SELECT count(*) FROM spark.issues i WHERE i.tenant_id = s.tenant_id AND i.project_id = s.project_id
                AND i.status_id = s.id AND i.archived_at IS NULL) AS issue_count
           FROM spark.issue_statuses s WHERE s.tenant_id = $1 AND s.project_id = $2 ORDER BY s.position, s.id`,
          [project.tenant_id, project.id],
        );
        return { items: items.rows, columns: columns.rows, percentiles: await readPercentiles(client, project, reference.from, reference.to) };
      });
      if (!result) return reply;
      const { project, data } = result;
      return {
        items: data.items.map((row) => ({
          issueId: row.id,
          key: `${project.key}-${row.number}`,
          title: row.title,
          statusName: row.status_name,
          assignee: userOf(row.assignee_user_id, row.assignee_display_name),
          startedAt: row.started_at ? row.started_at.toISOString() : null,
          ageDays: num(row.age_days),
        })),
        columns: data.columns.map((row) => ({
          statusId: row.id,
          name: row.name,
          category: row.category,
          wipLimit: row.wip_limit,
          count: num(row.issue_count),
        })),
        cycle: pair(data.percentiles.cycle_p50, data.percentiles.cycle_p85),
      };
    },
  );

  // ----- Velocity -----
  app.get<{ Params: { projectId: string }; Querystring: PeriodQuery }>(
    "/api/v1/projects/:projectId/insights/velocity",
    { schema: { params: projectParams, querystring: periodQuery, response: { 200: velocityResponse } } },
    async (request, reply) => {
      const result = await withProject(request, reply, async (client, project) => {
        const periods = await readPeriods(client, project.tenant_id, project.id);
        const period = pickPeriod(periods, request.query.period);
        if (!period) return null;
        // Velocity is a Scrum measure: other periods have no sprints to report.
        if (period.methodology !== "scrum") return { period, outcomes: [] };
        const found = await client.query<OutcomeRow>(
          `SELECT o.sprint_id, o.name, o.completed_at, o.committed_points, o.completed_points, o.committed_count, o.completed_count,
             o.base_count, o.base_points, o.base_estimated, o.base_done_count, o.base_done_points, o.already_done_count,
             o.added_count, o.added_points, o.removed_count
           FROM spark.insight_sprint_outcomes($1, $2, $3::timestamptz, $4::timestamptz, $5) o ORDER BY o.completed_at, o.sprint_id`,
          [project.tenant_id, project.id, period.startedAt, nextPeriodTo(period), VELOCITY_SPRINTS],
        );
        return { period, outcomes: found.rows };
      });
      if (!result) return reply;
      if (!result.data) return problem(request, reply, ...periodNotFound);
      const { period, outcomes } = result.data;

      const estimated = outcomes.reduce((sum, row) => sum + row.base_estimated, 0);
      const baseItems = outcomes.reduce((sum, row) => sum + row.base_count, 0);
      const unit: Unit = chooseUnit(Array.from({ length: baseItems }, (_, index) => ({ points: index < estimated ? 1 : null })));
      const sprints = outcomes.map((row) => {
        const base = unit === "points" ? num(row.base_points) : row.base_count;
        const baseDone = unit === "points" ? num(row.base_done_points) : row.base_done_count;
        const added = unit === "points" ? num(row.added_points) : row.added_count;
        return {
          id: row.sprint_id,
          name: row.name,
          completedAt: row.completed_at.toISOString(),
          committedPoints: nullableNum(row.committed_points),
          completedPoints: nullableNum(row.completed_points),
          committedCount: row.committed_count,
          completedCount: row.completed_count,
          reliability: reliability({ total: base, done: baseDone }),
          alreadyDone: row.already_done_count,
          added: { count: row.added_count, points: num(row.added_points) },
          removed: row.removed_count,
          creepPercent: creepPercent(added, base),
        };
      });
      const averageVelocity = sprints.length === 0 ? null : round(sprints.reduce((sum, s) => sum + (s.completedPoints ?? 0), 0) / sprints.length, 1);
      return { period, unit, sprints, averageVelocity };
    },
  );

  // ----- Schedule -----
  app.get<{ Params: { projectId: string }; Querystring: PeriodQuery }>(
    "/api/v1/projects/:projectId/insights/schedule",
    { schema: { params: projectParams, querystring: periodQuery, response: { 200: scheduleResponse } } },
    async (request, reply) => {
      const day = today();
      const result = await withProject(request, reply, async (client, project) => {
        const periods = await readPeriods(client, project.tenant_id, project.id);
        const period = pickPeriod(periods, request.query.period);
        if (!period) return null;
        const scope = [project.tenant_id, project.id];
        // Phases and milestones are read as they are now, whichever period was asked for.
        const phases = await client.query<PhaseScheduleRow>(
          `SELECT ph.id, ph.name, to_char(ph.planned_start, 'YYYY-MM-DD') AS planned_start, to_char(ph.planned_end, 'YYYY-MM-DD') AS planned_end,
             to_char(ph.baseline_start, 'YYYY-MM-DD') AS baseline_start, to_char(ph.baseline_end, 'YYYY-MM-DD') AS baseline_end,
             a.total_count, a.done_count, a.estimated_count, a.total_points, a.done_points
           FROM spark.project_phases ph
           CROSS JOIN LATERAL (
             SELECT ${scopeAggregate()}
             FROM spark.issues i
             JOIN spark.issue_statuses st ON st.tenant_id = i.tenant_id AND st.project_id = i.project_id AND st.id = i.status_id
             WHERE i.tenant_id = ph.tenant_id AND i.project_id = ph.project_id AND i.phase_id = ph.id AND i.archived_at IS NULL
               AND st.tenant_id = ph.tenant_id AND st.project_id = ph.project_id
           ) a
           WHERE ph.tenant_id = $1 AND ph.project_id = $2 ORDER BY ph.position, ph.id`,
          scope,
        );
        const milestones = await client.query<{
          id: string;
          name: string;
          phase_id: string | null;
          due_date: string;
          baseline_due_date: string | null;
          completed_at: Date | null;
        }>(
          `SELECT ms.id, ms.name, ms.phase_id, to_char(ms.due_date, 'YYYY-MM-DD') AS due_date,
             to_char(ms.baseline_due_date, 'YYYY-MM-DD') AS baseline_due_date, ms.completed_at
           FROM spark.project_milestones ms
           WHERE ms.tenant_id = $1 AND ms.project_id = $2 ORDER BY ms.due_date, ms.name, ms.id`,
          scope,
        );
        return { period, phases: phases.rows, milestones: milestones.rows };
      });
      if (!result) return reply;
      if (!result.data) return problem(request, reply, ...periodNotFound);
      const { period, phases, milestones } = result.data;

      const counts = { hit: 0, missed: 0, atRisk: 0, upcoming: 0 };
      const countKey: Record<MilestoneState, keyof typeof counts> = { hit: "hit", missed: "missed", at_risk: "atRisk", upcoming: "upcoming" };
      const states = milestones.map((row) => {
        const completedAt = row.completed_at ? row.completed_at.toISOString() : null;
        const state = milestoneState({ dueDate: row.due_date, completedAt }, day);
        counts[countKey[state]] += 1;
        return {
          id: row.id,
          name: row.name,
          phaseId: row.phase_id,
          dueDate: row.due_date,
          baselineDueDate: row.baseline_due_date,
          completedAt,
          state,
        };
      });

      const latest = (values: Array<string | null>): string | null => values.reduce<string | null>((max, value) => (value !== null && (max === null || value > max) ? value : max), null);
      const latestPlanned = latest(phases.map((row) => row.planned_end));
      const latestBaseline = latest(phases.map((row) => row.baseline_end));
      return {
        period,
        phases: phases.map((row) => {
          const progress = completion(row, { start: row.planned_start, end: row.planned_end }, day);
          return {
            id: row.id,
            name: row.name,
            plannedStart: row.planned_start,
            plannedEnd: row.planned_end,
            baselineStart: row.baseline_start,
            baselineEnd: row.baseline_end,
            varianceDays: varianceDays(row.planned_end, row.baseline_end),
            unit: progress.unit,
            total: progress.total,
            done: progress.done,
            donePercent: round(progress.donePercent, 1),
            planPercent: progress.planPercent === null ? null : round(progress.planPercent, 1),
            status: progress.status,
          };
        }),
        milestones: states,
        counts,
        scheduleVarianceDays: latestPlanned === null ? null : varianceDays(latestPlanned, latestBaseline),
      };
    },
  );

  // ----- Sprint burndown -----
  app.get<{ Params: { sprintId: string } }>(
    "/api/v1/sprints/:sprintId/burndown",
    { schema: { params: sprintParams, querystring: noQuery, response: { 200: burndownResponse } } },
    async (request, reply) => {
      const result = await withScope(
        request,
        reply,
        sprintNotFound,
        async (client) => {
          const found = await client.query<SprintRow>(
            `${SELECT_SPRINT} WHERE s.id = $1 AND s.tenant_id = ANY ((SELECT spark.session_workspace_ids())::uuid[])`,
            [request.params.sprintId],
          );
          return found.rows[0] ?? null;
        },
        async (client, sprint) => {
          if (!sprint.starts_on || !sprint.ends_on) return null;
          const days = await client.query<{
            day: string;
            scope_count: number | null;
            scope_points: string | null;
            remaining_count: number | null;
            remaining_points: string | null;
          }>(
            `SELECT to_char(b.day, 'YYYY-MM-DD') AS day, b.scope_count, b.scope_points, b.remaining_count, b.remaining_points
             FROM spark.insight_sprint_burndown($1, $2) b ORDER BY b.day`,
            [sprint.tenant_id, sprint.id],
          );
          // The unit is decided once per sprint from what was committed; before any commitment, from what is in it now.
          const committed = await client.query<{ points: string | null }>(
            "SELECT c.story_points AS points FROM spark.sprint_commitments c WHERE c.tenant_id = $1 AND c.sprint_id = $2",
            [sprint.tenant_id, sprint.id],
          );
          const basis = committed.rows.length > 0
            ? committed.rows
            : (await client.query<{ points: string | null }>(
              "SELECT i.story_points AS points FROM spark.issues i WHERE i.tenant_id = $1 AND i.project_id = $2 AND i.sprint_id = $3 AND i.archived_at IS NULL",
              [sprint.tenant_id, sprint.project_id, sprint.id],
            )).rows;
          return { days: days.rows, unit: chooseUnit(basis.map((row) => ({ points: nullableNum(row.points) }))) };
        },
      );
      if (!result) return reply;
      if (!result.data) return problem(request, reply, ...sprintMissingDates);
      const { days, unit } = result.data;

      const value = (points: string | null, count: number | null): number | null => (unit === "points" ? nullableNum(points) : count);
      const rows = days.map((row) => ({ day: row.day, scope: value(row.scope_points, row.scope_count), remaining: value(row.remaining_points, row.remaining_count) }));
      const base = rows[0]?.remaining ?? 0;
      const ideal = new Map(idealLine(base, result.scope.starts_on!, result.scope.ends_on!).map((point) => [point.day, point.ideal]));
      return {
        sprint: toSprint(result.scope),
        unit,
        base,
        days: rows.map((row) => ({ day: row.day, ideal: ideal.get(row.day) ?? 0, scope: row.scope, remaining: row.remaining })),
      };
    },
  );

  // ----- Workspace insights -----
  app.get<{ Params: { workspaceId: string }; Querystring: RangeQuery }>(
    "/api/v1/workspaces/:workspaceId/insights",
    { schema: { params: workspaceParams, querystring: rangeQuery, response: { 200: workspaceInsightsResponse } } },
    async (request, reply) => {
      const day = today();
      const range = rangeOf(request.query.days, day);
      const result = await withScope(
        request,
        reply,
        workspaceNotFound,
        async (client) => {
          const found = await client.query<{ id: string }>(
            `SELECT w.id FROM spark.workspaces w
             WHERE w.id = $1 AND w.id = ANY ((SELECT spark.session_workspace_ids())::uuid[]) AND w.status = 'active' AND w.archived_at IS NULL`,
            [request.params.workspaceId],
          );
          return found.rows[0]?.id ?? null;
        },
        async (client, workspaceId) => {
          // Per project in one statement: the scoped aggregate (active sprint for Scrum) plus whole-project open and overdue counts.
          const projects = await client.query<WorkspaceProjectRow>(
            `SELECT p.id, p.key, p.name, p.methodology, to_char(p.start_date, 'YYYY-MM-DD') AS start_date,
               to_char(p.target_date, 'YYYY-MM-DD') AS target_date, sp.id AS sprint_id, sp.name AS sprint_name,
               sp.starts_on AS sprint_starts_on, sp.ends_on AS sprint_ends_on,
               a.total_count, a.done_count, a.estimated_count, a.total_points, a.done_points, a.open_count, a.overdue_count
             FROM spark.projects p
             LEFT JOIN LATERAL (
               SELECT s.id, s.name, to_char((s.starts_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS starts_on,
                 to_char((s.ends_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS ends_on
               FROM spark.sprints s
               WHERE p.methodology = 'scrum' AND s.tenant_id = p.tenant_id AND s.project_id = p.id AND s.status = 'active'
               ORDER BY s.started_at DESC, s.id LIMIT 1
             ) sp ON true
             CROSS JOIN LATERAL (
               SELECT ${scopeAggregate("(sp.id IS NULL OR i.sprint_id = sp.id)")},
                 count(*) FILTER (WHERE st.category <> 'done') AS open_count,
                 count(*) FILTER (WHERE st.category <> 'done' AND i.due_date < $2::date) AS overdue_count
               FROM spark.issues i
               JOIN spark.issue_statuses st ON st.tenant_id = i.tenant_id AND st.project_id = i.project_id AND st.id = i.status_id
               WHERE i.tenant_id = p.tenant_id AND i.project_id = p.id AND i.archived_at IS NULL
                 AND st.tenant_id = p.tenant_id AND st.project_id = p.id
             ) a
             WHERE p.tenant_id = $1 AND p.archived_at IS NULL
             ORDER BY p.name, p.id LIMIT ${WORKSPACE_PROJECT_LIMIT}`,
            [workspaceId, day],
          );
          // Exactly the projects resolved above, never caller-supplied ids.
          const ids = projects.rows.map((row) => row.id);
          const members = await readMemberData(client, workspaceId, ids, range, day);
          const calendar = await client.query<{ day: string; value: string }>(
            `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, count(e.id) AS value
             FROM generate_series($3::date::timestamp, $4::date::timestamp, interval '1 day') AS d(day)
             LEFT JOIN spark.issue_events e ON e.tenant_id = $1 AND e.project_id = ANY ($2::uuid[])
               AND e.created_at >= ($3::date::timestamp AT TIME ZONE 'UTC') AND e.created_at < (($4::date + 1)::timestamp AT TIME ZONE 'UTC')
               AND (e.created_at AT TIME ZONE 'UTC')::date = d.day::date
             GROUP BY d.day ORDER BY d.day`,
            [workspaceId, ids, range.from, range.to],
          );
          const overdue = await client.query<{
            id: string;
            number: string;
            title: string;
            due_date: string;
            project_key: string;
            assignee_user_id: string | null;
            assignee_display_name: string | null;
          }>(
            `SELECT i.id, i.number, i.title, to_char(i.due_date, 'YYYY-MM-DD') AS due_date, p.key AS project_key, i.assignee_user_id,
               a.display_name AS assignee_display_name
             FROM spark.issues i
             JOIN spark.projects p ON p.tenant_id = i.tenant_id AND p.id = i.project_id
             JOIN spark.issue_statuses st ON st.tenant_id = i.tenant_id AND st.project_id = i.project_id AND st.id = i.status_id
             LEFT JOIN spark.users a ON a.id = i.assignee_user_id
             WHERE i.tenant_id = $1 AND i.project_id = ANY ($2::uuid[]) AND p.tenant_id = $1 AND st.tenant_id = $1
               AND i.archived_at IS NULL AND st.category <> 'done' AND i.due_date < $3::date
             ORDER BY i.due_date, p.key, i.number, i.id LIMIT ${WORKSPACE_OVERDUE_LIMIT}`,
            [workspaceId, ids, day],
          );
          return { projects: projects.rows, members, calendar: calendar.rows, overdue: overdue.rows };
        },
      );
      if (!result) return reply;
      const { projects, members, calendar, overdue } = result.data;
      return {
        range,
        projects: projects.map((row) => {
          const sprint = row.sprint_id ? { name: row.sprint_name ?? "", starts_on: row.sprint_starts_on, ends_on: row.sprint_ends_on } : null;
          const progress = completion(row, planWindow(row, sprint).window, day);
          return {
            id: row.id,
            key: row.key,
            name: row.name,
            methodology: row.methodology,
            unit: progress.unit,
            donePercent: round(progress.donePercent, 1),
            planPercent: progress.planPercent === null ? null : round(progress.planPercent, 1),
            status: progress.status,
            open: num(row.open_count),
            overdue: num(row.overdue_count),
          };
        }),
        members: memberItems(members),
        calendar: calendar.map((row) => ({ day: row.day, value: num(row.value) })),
        overdue: overdue.map((row) => ({
          issueId: row.id,
          key: `${row.project_key}-${row.number}`,
          title: row.title,
          projectKey: row.project_key,
          dueDate: row.due_date,
          assignee: userOf(row.assignee_user_id, row.assignee_display_name),
        })),
      };
    },
  );
}

interface OutcomeRow {
  sprint_id: string;
  name: string;
  completed_at: Date;
  committed_points: string | null;
  completed_points: string | null;
  committed_count: number | null;
  completed_count: number | null;
  base_count: number;
  base_points: string;
  base_estimated: number;
  base_done_count: number;
  base_done_points: string;
  already_done_count: number;
  added_count: number;
  added_points: string;
  removed_count: number;
}

interface PhaseScheduleRow extends ScopeAggregate {
  id: string;
  name: string;
  planned_start: string;
  planned_end: string;
  baseline_start: string | null;
  baseline_end: string | null;
}

interface WorkspaceProjectRow extends ScopeAggregate, WindowedProject {
  id: string;
  key: string;
  name: string;
  sprint_id: string | null;
  sprint_name: string | null;
  sprint_starts_on: string | null;
  sprint_ends_on: string | null;
  open_count: string;
  overdue_count: string;
}
