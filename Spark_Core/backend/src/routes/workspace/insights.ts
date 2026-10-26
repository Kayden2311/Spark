import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import {
  addDays,
  chooseUnit,
  forecast,
  measure,
  planPercent,
  planStatus,
  rangeOf,
  todayUtc,
  type PlanStatus,
  type Unit,
} from "../../modules/work/domain/metrics.js";
import { problem } from "../responses.js";
import type { MemberGuard } from "./guard.js";
import { readPeriods, type MethodologyPeriod } from "./planning.js";

// Project insights (M5): read-only. Every route resolves the project through RLS first (404 otherwise), then reads
// inside the session-bound transaction with explicit tenant_id and project_id filters. The history replay lives in
// the spark.insight_* functions (migration 0026); the statements here cover current-state reads.

const FORMER_MEMBER = "Former member";
const UNASSIGNED_LAST = Number.MAX_SAFE_INTEGER;
const OVERDUE_LIMIT = 20;
const SCATTER_LIMIT = 500;
const AGING_LIMIT = 200;
const THROUGHPUT_DAYS = 14;
const REFERENCE_DAYS = 90;
const DEFAULT_DAYS = 30;

const projectNotFound = [404, "Not Found", "project_not_found", "Project does not exist."] as const;

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

interface SprintRef { id: string; name: string; starts_on: string | null; ends_on: string | null }

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
       SELECT extract(epoch FROM i.completed_at - i.started_at) / 86400 AS cycle_secs_days,
         extract(epoch FROM i.completed_at - i.created_at) / 86400 AS lead_secs_days
       FROM spark.issues i
       JOIN spark.issue_statuses st ON st.tenant_id = i.tenant_id AND st.project_id = i.project_id AND st.id = i.status_id
       WHERE i.tenant_id = $1 AND i.project_id = $2 AND st.tenant_id = $1 AND st.project_id = $2 AND st.category = 'done'
         AND i.archived_at IS NULL AND i.completed_at IS NOT NULL
         AND (i.completed_at AT TIME ZONE 'UTC')::date BETWEEN $3::date AND $4::date
     )
     SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY d.cycle_secs_days))::numeric, 1) AS cycle_p50,
       round((percentile_cont(0.85) WITHIN GROUP (ORDER BY d.cycle_secs_days))::numeric, 1) AS cycle_p85,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY d.lead_secs_days))::numeric, 1) AS lead_p50,
       round((percentile_cont(0.85) WITHIN GROUP (ORDER BY d.lead_secs_days))::numeric, 1) AS lead_p85
     FROM done d`,
    [project.tenant_id, project.id, from, to],
  );
  return found.rows[0] ?? { cycle_p50: null, cycle_p85: null, lead_p50: null, lead_p85: null };
}

const pair = (p50: string | null, p85: string | null) => ({ p50: nullableNum(p50), p85: nullableNum(p85) });

// ---------- Handlers ----------

interface RangeQuery { days: number }

type Guarded<T> = { project: ProjectRef } & T;

export function registerInsightRoutes(app: FastifyInstance, guard: MemberGuard): void {
  /** Authenticates, resolves the project through RLS and runs `work`; sends the error response itself and returns undefined. */
  async function withProject<T>(
    request: FastifyRequest<{ Params: { projectId: string } }>,
    reply: FastifyReply,
    work: (client: PoolClient, project: ProjectRef) => Promise<T>,
  ): Promise<Guarded<{ data: T }> | undefined> {
    const member = await guard.authenticate(request, reply);
    if (!member) return undefined;
    const result = await guard.run(request, reply, member, async (client) => {
      const project = await readProject(client, request.params.projectId);
      return project ? { project, data: await work(client, project) } : null;
    });
    if (reply.sent) return undefined;
    if (!result) {
      void problem(request, reply, ...projectNotFound);
      return undefined;
    }
    return result;
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
        let sprint: SprintRef | null = null;
        if (project.methodology === "scrum") {
          const found = await client.query<SprintRef>(
            `SELECT s.id, s.name, to_char((s.starts_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS starts_on,
               to_char((s.ends_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS ends_on
             FROM spark.sprints s WHERE s.tenant_id = $1 AND s.project_id = $2 AND s.status = 'active'
             ORDER BY s.started_at DESC, s.id LIMIT 1`,
            [project.tenant_id, project.id],
          );
          sprint = found.rows[0] ?? null;
        }
        const scoped = await client.query<{ points: string | null; is_done: boolean }>(
          `SELECT i.story_points AS points, (st.category = 'done') AS is_done
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
        return { sprint, scoped: scoped.rows, flow, overdue: overdue.rows, periods };
      });
      if (!result) return reply;
      const { project, data } = result;

      const items = data.scoped.map((row) => ({ points: nullableNum(row.points), done: row.is_done }));
      const unit: Unit = chooseUnit(items);
      const { total, done } = measure(items, unit);
      const donePercent = total > 0 ? (done / total) * 100 : 0;

      let window: { start: string; end: string } | null = null;
      let kind: "sprint" | "project" | null = null;
      let label: string | null = null;
      if (project.methodology === "scrum") {
        if (data.sprint?.starts_on && data.sprint.ends_on) {
          window = { start: data.sprint.starts_on, end: data.sprint.ends_on };
          kind = "sprint";
          label = data.sprint.name;
        }
      } else if (project.start_date && project.target_date) {
        window = { start: project.start_date, end: project.target_date };
        kind = "project";
        label = "Project window";
      }
      const elapsed = planPercent(window, day);
      const status: PlanStatus = planStatus(donePercent, elapsed);

      const throughput = data.flow.slice(-THROUGHPUT_DAYS).map((row) => (unit === "points" ? num(row.completed_points) : row.completed));
      const rate = forecast(total - done, throughput, day);

      return {
        unit,
        total,
        done,
        open: total - done,
        donePercent: round(donePercent, 1),
        plan: {
          kind,
          label,
          start: window?.start ?? null,
          end: window?.end ?? null,
          planPercent: elapsed === null ? null : round(elapsed, 1),
          status,
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
      const result = await withProject(request, reply, async (client, project) => {
        const stats = await client.query<{
          user_id: string | null;
          completed: number;
          completed_points: string;
          with_due: number;
          on_time: number;
          open: number;
          overdue: number;
          median_cycle_days: string | null;
        }>(
          `SELECT m.user_id, m.completed, m.completed_points, m.with_due, m.on_time, m.open, m.overdue, m.median_cycle_days
           FROM spark.insight_members($1, $2::uuid[], $3::date, $4::date, $5::date) m`,
          [project.tenant_id, [project.id], range.from, range.to, day],
        );
        const members = await client.query<{ user_id: string; display_name: string }>(
          "SELECT m.user_id, m.display_name FROM spark.ws_list_members($1) m",
          [project.tenant_id],
        );
        const known = new Set(members.rows.map((row) => row.user_id));
        const departed = others(stats.rows, known);
        const extra = departed.length === 0
          ? []
          : (await client.query<{ id: string; display_name: string }>("SELECT u.id, u.display_name FROM spark.users u WHERE u.id = ANY ($1::uuid[])", [departed])).rows;
        return { stats: stats.rows, members: members.rows, extra };
      });
      if (!result) return reply;
      const { stats, members, extra } = result.data;

      const names = new Map<string, string>([...members.map((m) => [m.user_id, m.display_name] as const), ...extra.map((u) => [u.id, u.display_name] as const)]);
      const byUser = new Map(stats.map((row) => [row.user_id, row]));
      const ids = [...members.map((m) => m.user_id), ...others(stats, new Set(members.map((m) => m.user_id)))];
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
      return { range, items: entries.map((entry) => entry.item) };
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
}

function others(stats: Array<{ user_id: string | null }>, known: Set<string>): string[] {
  return stats.map((row) => row.user_id).filter((id): id is string => id !== null && !known.has(id));
}
