import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { addDays, rangeOf, todayUtc } from "../src/modules/work/domain/metrics.js";
import { fakePool, principalRow, type QueryHandler } from "./fake-pool.js";

const config = loadConfig({ NODE_ENV: "test" });
const cookie = `spark_session=${"b".repeat(64)}`;
const tenantId = "1d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const projectId = "3d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const userA = "aa4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const userB = "ab4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const userGone = "ac4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const periodKanbanId = "ad4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const periodScrumId = "bd4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const statusId = "6d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const sprintId = "5d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const phaseId = "7d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const otherPeriodId = "cd4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";

const today = () => todayUtc(new Date());
const base = `/api/v1/projects/${projectId}/insights`;
const urls = ["summary", "members", "flow", "cycle-time", "aging-wip", "velocity", "schedule"].map((name) => `${base}/${name}`);

type Calls = Array<{ sql: string; params: unknown[] }>;

async function get(url: string, handlers: Array<[string, QueryHandler]> = [], signedIn = true) {
  const { pool, calls } = fakePool([["auth_session_principal", signedIn ? () => [principalRow] : () => []], ...handlers]);
  const app = await buildApp({ config, pool, rateLimit: false, logger: false });
  try {
    const response = await app.inject({ method: "GET", url, headers: signedIn ? { cookie } : {} });
    return { response, calls };
  } finally {
    await app.close();
  }
}

const find = (calls: Calls, fragment: string) => calls.find((c) => c.sql.includes(fragment));

const projectRow = (over: object = {}) => ({
  id: projectId, tenant_id: tenantId, key: "WEB", methodology: "kanban", start_date: null, target_date: null, ...over,
});
const project = (over: object = {}): [string, QueryHandler] => ["FROM spark.projects p WHERE", () => [projectRow(over)]];
const periodRows = [
  { id: periodKanbanId, methodology: "kanban", started_at: new Date("2026-01-03T08:00:00Z"), ended_at: new Date("2026-10-18T09:30:00Z") },
  { id: periodScrumId, methodology: "scrum", started_at: new Date("2026-10-18T09:30:00Z"), ended_at: null },
];
const periods: [string, QueryHandler] = ["FROM spark.project_methodology_periods mp", () => periodRows];

// The SQL aggregate over a scope: counts arrive as bigint text.
const aggregate = (rows: Array<{ points: string | null; is_done: boolean }>) => ({
  total_count: String(rows.length),
  done_count: String(rows.filter((r) => r.is_done).length),
  estimated_count: String(rows.filter((r) => r.points !== null).length),
  total_points: String(rows.reduce((sum, r) => sum + Number(r.points ?? 0), 0)),
  done_points: String(rows.filter((r) => r.is_done).reduce((sum, r) => sum + Number(r.points ?? 0), 0)),
});

describe("project insight routes", () => {
  describe.each(urls)("%s", (url) => {
    it("is 401 without a session, uncached", async () => {
      const { response } = await get(url, [], false);
      expect(response.statusCode).toBe(401);
      expect(response.headers["cache-control"]).toBe("private, no-store");
    });

    it("is 404 for an unknown or foreign project, uncached", async () => {
      const { response } = await get(url);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "project_not_found" });
      expect(response.headers["cache-control"]).toBe("private, no-store");
    });

    it("rejects a malformed project id and unknown query keys with 400, uncached", async () => {
      const bad = await get(url.replace(projectId, "nope"), [project()]);
      expect(bad.response.statusCode).toBe(400);
      expect(bad.response.headers["cache-control"]).toBe("private, no-store");
      const unknown = await get(`${url}?bogus=1`, [project()]);
      expect(unknown.response.statusCode).toBe(400);
      expect(unknown.response.headers["cache-control"]).toBe("private, no-store");
    });
  });

  describe.each(["members", "flow", "cycle-time"])("%s days", (name) => {
    const url = `${base}/${name}`;
    it.each(["6", "181", "abc", "7.5", ""])("rejects days=%s", async (days) => {
      const { response } = await get(`${url}?days=${days}`, [project()]);
      expect(response.statusCode).toBe(400);
    });
    it.each(["7", "180"])("accepts days=%s", async (days) => {
      const { response } = await get(`${url}?days=${days}`, [project(), periods]);
      expect(response.statusCode).toBe(200);
    });
  });

  it("does not accept days on summary or aging-wip", async () => {
    expect((await get(`${base}/summary?days=30`, [project()])).response.statusCode).toBe(400);
    expect((await get(`${base}/aging-wip?days=30`, [project()])).response.statusCode).toBe(400);
  });

  describe("summary", () => {
    const issues = (rows: Array<{ points: string | null; is_done: boolean }>): [string, QueryHandler] => ["AS total_count", () => [aggregate(rows)]];
    const flowRows = (completed: number, completedPoints = "0"): [string, QueryHandler] => [
      "spark.insight_flow(", () => Array.from({ length: 14 }, (_, i) => ({ day: addDays(today(), i - 13), completed, completed_points: completedPoints })),
    ];
    const overdue: [string, QueryHandler] = ["AS overdue_total", () => [
      { id: "i1", number: 7, title: "Late", due_date: "2026-01-02", assignee_user_id: userA, assignee_display_name: "Ada", overdue_total: "25" },
      { id: "i2", number: 9, title: "Later", due_date: "2026-01-03", assignee_user_id: userGone, assignee_display_name: null, overdue_total: "25" },
      { id: "i3", number: 11, title: "Unowned", due_date: "2026-01-04", assignee_user_id: null, assignee_display_name: null, overdue_total: "25" },
    ]];

    it("uses counts for a kanban project without dates, forecasts from the last 14 days and reports no plan", async () => {
      const { response, calls } = await get(`${base}/summary`, [
        project(), periods, issues([{ points: null, is_done: true }, { points: "3", is_done: false }, { points: null, is_done: false }, { points: null, is_done: false }]),
        flowRows(1), overdue,
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      const body = response.json();
      expect(body).toMatchObject({
        unit: "count", total: 4, done: 1, open: 3, donePercent: 25,
        plan: { kind: null, label: null, start: null, end: null, planPercent: null, status: "no_plan" },
        forecast: { ratePerDay: 1, date: addDays(today(), 3) },
        overdue: { count: 25 },
      });
      expect(body.overdue.items).toEqual([
        { issueId: "i1", key: "WEB-7", title: "Late", dueDate: "2026-01-02", assignee: { id: userA, displayName: "Ada" } },
        { issueId: "i2", key: "WEB-9", title: "Later", dueDate: "2026-01-03", assignee: { id: userGone, displayName: "Former member" } },
        { issueId: "i3", key: "WEB-11", title: "Unowned", dueDate: "2026-01-04", assignee: null },
      ]);
      expect(body.periods).toEqual([
        { id: periodKanbanId, methodology: "kanban", startedAt: "2026-01-03T08:00:00.000Z", endedAt: "2026-10-18T09:30:00.000Z" },
        { id: periodScrumId, methodology: "scrum", startedAt: "2026-10-18T09:30:00.000Z", endedAt: null },
      ]);
      expect(find(calls, "spark.insight_flow(")?.params).toEqual([tenantId, projectId, addDays(today(), -13), today()]);
      expect(find(calls, "AS overdue_total")?.sql).toMatch(/LIMIT 20/u);
      expect(find(calls, "AS overdue_total")?.params.slice(0, 2)).toEqual([tenantId, projectId]);
    });

    it("measures story points when 80% are estimated and forecasts with completed points", async () => {
      const { response } = await get(`${base}/summary`, [
        project(), periods,
        issues([{ points: "5", is_done: true }, { points: "3", is_done: false }, { points: "2", is_done: false }, { points: "0", is_done: false }, { points: "10", is_done: false }]),
        flowRows(9, "2"), overdue,
      ]);
      expect(response.json()).toMatchObject({ unit: "points", total: 20, done: 5, open: 15, donePercent: 25, forecast: { ratePerDay: 2, date: addDays(today(), 8) } });
    });

    it("has a null forecast date when nothing was completed in 14 days", async () => {
      const { response } = await get(`${base}/summary`, [project(), periods, issues([{ points: null, is_done: false }]), flowRows(0), overdue]);
      expect(response.json().forecast).toEqual({ ratePerDay: 0, date: null });
    });

    it("scores a scrum project against its active sprint", async () => {
      const start = addDays(today(), -4);
      const end = addDays(today(), 5);
      const { response, calls } = await get(`${base}/summary`, [
        project({ methodology: "scrum" }), periods,
        ["FROM spark.sprints s WHERE", () => [{ id: "sp1", name: "Sprint 7", starts_on: start, ends_on: end }]],
        issues([{ points: null, is_done: true }, ...Array.from({ length: 4 }, () => ({ points: null, is_done: false }))]),
        flowRows(0), overdue,
      ]);
      expect(response.json().plan).toEqual({ kind: "sprint", label: "Sprint 7", start, end, planPercent: 50, status: "behind" });
      expect(find(calls, "FROM spark.sprints s WHERE")?.sql).toMatch(/s\.status = 'active'/u);
      expect(find(calls, "AS total_count")?.params).toEqual([tenantId, projectId, "sp1"]);
    });

    it("reports on_track for an empty plan scope", async () => {
      const start = addDays(today(), -4);
      const { response } = await get(`${base}/summary`, [
        project({ methodology: "scrum" }), periods,
        ["FROM spark.sprints s WHERE", () => [{ id: "sp1", name: "Sprint 7", starts_on: start, ends_on: addDays(today(), 5) }]],
        issues([]), flowRows(0), overdue,
      ]);
      expect(response.json()).toMatchObject({ total: 0, donePercent: 0, plan: { planPercent: 50, status: "on_track" } });
    });

    it("has no plan and covers the whole project for scrum without an active sprint", async () => {
      const { response, calls } = await get(`${base}/summary`, [project({ methodology: "scrum" }), periods, issues([{ points: null, is_done: true }]), flowRows(0), overdue]);
      expect(response.json()).toMatchObject({ total: 1, plan: { kind: null, status: "no_plan" } });
      expect(find(calls, "AS total_count")?.params).toEqual([tenantId, projectId, null]);
    });

    it("scores waterfall and kanban against the project window", async () => {
      const start = addDays(today(), -9);
      const end = addDays(today(), 10);
      for (const methodology of ["waterfall", "kanban"]) {
        const { response } = await get(`${base}/summary`, [
          project({ methodology, start_date: start, target_date: end }), periods,
          issues([{ points: null, is_done: true }, { points: null, is_done: true }, { points: null, is_done: false }, { points: null, is_done: false }]), flowRows(0), overdue,
        ]);
        expect(response.json().plan).toEqual({ kind: "project", label: "Project window", start, end, planPercent: 50, status: "on_track" });
      }
    });

    it("decides the status from the percentages as displayed (one decimal)", async () => {
      const start = addDays(today(), -9);
      const end = addDays(today(), 10);
      const counts = (total: number, done: number): [string, QueryHandler] => ["AS total_count", () => [{
        total_count: String(total), done_count: String(done), estimated_count: "0", total_points: "0", done_points: "0",
      }]];
      const status = async (total: number, done: number) => (await get(`${base}/summary`, [
        project({ start_date: start, target_date: end }), periods, counts(total, done), flowRows(0), overdue,
      ])).response.json();
      // 39.96% shows as 40%: exactly plan (50%) − 10, so on track, as the numbers on screen say.
      expect(await status(2500, 999)).toMatchObject({ donePercent: 40, plan: { planPercent: 50, status: "on_track" } });
      // 39.94% shows as 39.9%: under plan − 10.
      expect(await status(5000, 1997)).toMatchObject({ donePercent: 39.9, plan: { planPercent: 50, status: "at_risk" } });
      // 24.96% shows as 25%: exactly plan − 25, so at risk rather than behind.
      expect(await status(2500, 624)).toMatchObject({ donePercent: 25, plan: { planPercent: 50, status: "at_risk" } });
    });

    it("sets the forecast date to today when nothing remains", async () => {
      const { response } = await get(`${base}/summary`, [project(), periods, issues([{ points: null, is_done: true }]), flowRows(0), overdue]);
      expect(response.json()).toMatchObject({ open: 0, donePercent: 100, forecast: { date: today() } });
    });
  });

  describe("members", () => {
    const workspaceMembers: [string, QueryHandler] = ["spark.ws_list_members(", () => [
      { user_id: userA, display_name: "Ada" }, { user_id: userB, display_name: "Ben" },
    ]];
    const row = (user_id: string | null, over: object = {}) => ({
      user_id, completed: 0, completed_points: "0", with_due: 0, on_time: 0, open: 0, overdue: 0, median_cycle_days: null, ...over,
    });

    it("lists every active member with zeros, sorts by completed then name and puts Unassigned last", async () => {
      const { response, calls } = await get(`${base}/members`, [
        project(), workspaceMembers,
        ["spark.insight_members(", () => [
          row(null, { completed: 9, open: 2 }),
          row(userA, { completed: 3, completed_points: "8.5", with_due: 2, on_time: 1, open: 4, overdue: 1, median_cycle_days: "2.5" }),
          row(userGone, { completed: 3 }),
        ]],
        ["FROM spark.users u WHERE", () => [{ id: userGone, display_name: "Gus" }]],
      ]);
      expect(response.statusCode).toBe(200);
      const { range, items } = response.json();
      expect(range).toEqual(rangeOf(30, today()));
      expect(items).toEqual([
        { user: { id: userA, displayName: "Ada" }, completed: 3, completedPoints: 8.5, onTimeRate: 50, open: 4, overdue: 1, medianCycleDays: 2.5 },
        { user: { id: userGone, displayName: "Gus" }, completed: 3, completedPoints: 0, onTimeRate: null, open: 0, overdue: 0, medianCycleDays: null },
        { user: { id: userB, displayName: "Ben" }, completed: 0, completedPoints: 0, onTimeRate: null, open: 0, overdue: 0, medianCycleDays: null },
        { user: null, completed: 9, completedPoints: 0, onTimeRate: null, open: 2, overdue: 0, medianCycleDays: null },
      ]);
      const { from, to } = range;
      expect(find(calls, "spark.insight_members(")?.params).toEqual([tenantId, [projectId], from, to, today()]);
    });

    it("keeps a former member's work under \"Former member\" when their name is not readable, before Unassigned", async () => {
      const { response, calls } = await get(`${base}/members`, [
        project(), workspaceMembers,
        ["spark.insight_members(", () => [
          row(null, { completed: 1, open: 1 }),
          row(userA, { completed: 2, open: 1 }),
          row(userGone, { completed: 4, completed_points: "6", open: 3, overdue: 2 }),
        ]],
        ["FROM spark.users u WHERE", () => []],
      ]);
      expect(response.statusCode).toBe(200);
      const items = response.json().items as Array<{ user: { id: string; displayName: string } | null; completed: number; open: number; overdue: number }>;
      expect(items.map((item) => item.user)).toEqual([
        { id: userGone, displayName: "Former member" }, { id: userA, displayName: "Ada" }, { id: userB, displayName: "Ben" }, null,
      ]);
      expect(items[0]).toMatchObject({ completed: 4, completedPoints: 6, open: 3, overdue: 2 });
      // Every stats row is listed, so the table adds up to the project's totals.
      expect(items.reduce((sum, item) => sum + item.completed, 0)).toBe(7);
      expect(items.reduce((sum, item) => sum + item.open, 0)).toBe(5);
      expect(find(calls, "FROM spark.users u WHERE")?.params).toEqual([[userGone]]);
    });

    it("omits Unassigned when there is no unassigned row and passes the requested range", async () => {
      const { response, calls } = await get(`${base}/members?days=7`, [project(), workspaceMembers, ["spark.insight_members(", () => []]]);
      expect(response.json().items.map((i: { user: { id: string } | null }) => i.user?.id)).toEqual([userA, userB]);
      expect(find(calls, "spark.insight_members(")?.params.slice(2)).toEqual([addDays(today(), -6), today(), today()]);
    });
  });

  describe("flow", () => {
    it("maps days and marks the methodology switches inside the range", async () => {
      const switchedAt = addDays(today(), -3);
      const rows = [
        { id: periodKanbanId, methodology: "kanban", started_at: new Date("2026-01-03T08:00:00Z"), ended_at: new Date(`${switchedAt}T09:30:00Z`) },
        { id: periodScrumId, methodology: "scrum", started_at: new Date(`${switchedAt}T09:30:00Z`), ended_at: null },
      ];
      const { response, calls } = await get(`${base}/flow`, [
        project(), ["FROM spark.project_methodology_periods mp", () => rows],
        ["spark.insight_flow(", () => [{ day: today(), backlog: 1, todo: 2, in_progress: 3, done: 4, completed: 5, completed_points: "6.5" }]],
      ]);
      expect(response.json()).toEqual({
        range: rangeOf(30, today()),
        days: [{ day: today(), backlog: 1, todo: 2, inProgress: 3, done: 4, completed: 5, completedPoints: 6.5 }],
        markers: [{ at: `${switchedAt}T09:30:00.000Z`, from: "kanban", to: "scrum" }],
      });
      expect(find(calls, "spark.insight_flow(")?.params).toEqual([tenantId, projectId, addDays(today(), -29), today()]);
    });

    it("leaves out boundaries outside the range", async () => {
      const old = [periodRows[0], { ...periodRows[1], started_at: new Date(`${addDays(today(), -60)}T09:30:00Z`) }];
      const { response } = await get(`${base}/flow`, [project(), ["FROM spark.project_methodology_periods mp", () => old], ["spark.insight_flow(", () => []]]);
      expect(response.json().markers).toEqual([]);
    });
  });

  describe("cycle-time", () => {
    const point = (i: number) => ({
      id: `i${i}`, number: i, title: `T${i}`, completed_at: new Date("2026-10-20T10:00:00Z"), cycle_days: i === 0 ? null : "2.5", lead_days: "4.0",
    });
    const percentiles: [string, QueryHandler] = ["percentile_cont", () => [{ cycle_p50: "2.5", cycle_p85: "6.0", lead_p50: null, lead_p85: null }]];

    it("returns points, percentiles and the range", async () => {
      const { response, calls } = await get(`${base}/cycle-time?days=14`, [project(), ["AS cycle_days", () => [point(0), point(1)]], percentiles]);
      expect(response.json()).toEqual({
        range: rangeOf(14, today()),
        points: [
          { issueId: "i0", key: "WEB-0", title: "T0", completedAt: "2026-10-20T10:00:00.000Z", cycleDays: null, leadDays: 4 },
          { issueId: "i1", key: "WEB-1", title: "T1", completedAt: "2026-10-20T10:00:00.000Z", cycleDays: 2.5, leadDays: 4 },
        ],
        cycle: { p50: 2.5, p85: 6 },
        lead: { p50: null, p85: null },
        truncated: false,
      });
      const pointsCall = find(calls, "AS cycle_days");
      expect(pointsCall?.params).toEqual([tenantId, projectId, addDays(today(), -13), today()]);
      expect(pointsCall?.sql).toMatch(/LIMIT 501/u);
      expect(find(calls, "percentile_cont")?.params).toEqual([tenantId, projectId, addDays(today(), -13), today()]);
    });

    it("truncates the scatter at 500 points", async () => {
      const rows = Array.from({ length: 501 }, (_, i) => point(i + 1));
      const { response } = await get(`${base}/cycle-time`, [project(), ["AS cycle_days", () => rows], percentiles]);
      expect(response.json().points).toHaveLength(500);
      expect(response.json().truncated).toBe(true);
    });
  });

  describe("aging-wip", () => {
    it("maps items, columns and the 90-day reference lines", async () => {
      const { response, calls } = await get(`${base}/aging-wip`, [
        project(),
        ["AS age_days", () => [
          { id: "i1", number: 3, title: "Old", status_name: "Doing", assignee_user_id: userA, assignee_display_name: "Ada", started_at: new Date("2026-10-01T00:00:00Z"), age_days: "25.5" },
          { id: "i2", number: 4, title: "NoStart", status_name: "Doing", assignee_user_id: null, assignee_display_name: null, started_at: null, age_days: "1.0" },
        ]],
        ["AS issue_count", () => [{ id: statusId, name: "Doing", category: "in_progress", wip_limit: 3, issue_count: "2" }]],
        ["percentile_cont", () => [{ cycle_p50: "3.0", cycle_p85: null, lead_p50: null, lead_p85: null }]],
      ]);
      expect(response.json()).toEqual({
        items: [
          { issueId: "i1", key: "WEB-3", title: "Old", statusName: "Doing", assignee: { id: userA, displayName: "Ada" }, startedAt: "2026-10-01T00:00:00.000Z", ageDays: 25.5 },
          { issueId: "i2", key: "WEB-4", title: "NoStart", statusName: "Doing", assignee: null, startedAt: null, ageDays: 1 },
        ],
        columns: [{ statusId, name: "Doing", category: "in_progress", wipLimit: 3, count: 2 }],
        cycle: { p50: 3, p85: null },
      });
      expect(find(calls, "AS age_days")?.sql).toMatch(/LIMIT 200/u);
      expect(find(calls, "AS issue_count")?.sql).toMatch(/ORDER BY s\.position/u);
      expect(find(calls, "percentile_cont")?.params).toEqual([tenantId, projectId, addDays(today(), -89), today()]);
    });
  });
  describe("velocity", () => {
    const outcome = (over: object = {}) => ({
      sprint_id: sprintId, name: "Sprint 6", completed_at: new Date("2026-10-10T10:00:00Z"), committed_points: "20", completed_points: "16.5",
      committed_count: 8, completed_count: 6, base_count: 5, base_points: "15", base_estimated: 5, base_done_count: 4, base_done_points: "12",
      already_done_count: 3, added_count: 2, added_points: "3", removed_count: 1, ...over,
    });
    const outcomes = (...rows: object[]): [string, QueryHandler] => ["spark.insight_sprint_outcomes(", () => rows];

    it("maps the sprints of the open period in points with reliability, creep and the average", async () => {
      const { response, calls } = await get(`${base}/velocity`, [
        project({ methodology: "scrum" }), periods,
        outcomes(outcome(), outcome({ sprint_id: userA, name: "Sprint 7", completed_points: "9", base_done_points: "15" })),
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.json()).toEqual({
        period: { id: periodScrumId, methodology: "scrum", startedAt: "2026-10-18T09:30:00.000Z", endedAt: null },
        unit: "points",
        sprints: [
          { id: sprintId, name: "Sprint 6", completedAt: "2026-10-10T10:00:00.000Z", committedPoints: 20, completedPoints: 16.5, committedCount: 8, completedCount: 6,
            reliability: 80, alreadyDone: 3, added: { count: 2, points: 3 }, removed: 1, creepPercent: 20 },
          { id: userA, name: "Sprint 7", completedAt: "2026-10-10T10:00:00.000Z", committedPoints: 20, completedPoints: 9, committedCount: 8, completedCount: 6,
            reliability: 100, alreadyDone: 3, added: { count: 2, points: 3 }, removed: 1, creepPercent: 20 },
        ],
        averageVelocity: 12.8,
      });
      const call = find(calls, "spark.insight_sprint_outcomes(");
      expect(call?.params.slice(0, 2)).toEqual([tenantId, projectId]);
      expect(call?.params[2]).toBe("2026-10-18T09:30:00.000Z");
      // The open period has no upper bound in SQL, so the API clock never cuts off a sprint completed just now.
      expect(call?.params[3]).toBe("infinity");
      expect(call?.params[4]).toBe(6);
    });

    it("measures in counts when under 80% of the base is estimated and nulls an empty base", async () => {
      const { response } = await get(`${base}/velocity`, [
        project({ methodology: "scrum" }), periods,
        outcomes(outcome({ base_estimated: 3 }), outcome({ completed_count: 3, base_count: 0, base_points: "0", base_estimated: 0, base_done_count: 0, base_done_points: "0" })),
      ]);
      const body = response.json();
      expect(body.unit).toBe("count");
      // The average is in the list's unit: completed counts (6 and 3), not completed points.
      expect(body.averageVelocity).toBe(4.5);
      expect(body.sprints[0]).toMatchObject({ reliability: 80, creepPercent: 40 });
      expect(body.sprints[1]).toMatchObject({ reliability: null, creepPercent: null });
    });

    it("has a null average without sprints", async () => {
      const { response } = await get(`${base}/velocity`, [project({ methodology: "scrum" }), periods, outcomes()]);
      expect(response.json()).toMatchObject({ sprints: [], averageVelocity: null });
    });

    it("returns no sprints for a non-Scrum period and bounds an ended period", async () => {
      const ended = await get(`${base}/velocity?period=${periodKanbanId}`, [project(), periods, outcomes(outcome())]);
      expect(ended.response.statusCode).toBe(200);
      expect(ended.response.json()).toMatchObject({ period: { id: periodKanbanId }, sprints: [], averageVelocity: null });
      expect(find(ended.calls, "spark.insight_sprint_outcomes(")).toBeUndefined();
    });

    it("is 404 period_not_found for a foreign period and 400 for a malformed one", async () => {
      const foreign = await get(`${base}/velocity?period=${otherPeriodId}`, [project(), periods]);
      expect(foreign.response.statusCode).toBe(404);
      expect(foreign.response.json()).toMatchObject({ code: "period_not_found" });
      expect(foreign.response.headers["cache-control"]).toBe("private, no-store");
      expect((await get(`${base}/velocity?period=nope`, [project(), periods])).response.statusCode).toBe(400);
    });
  });

  describe("schedule", () => {
    const phase = (over: object = {}) => ({
      id: phaseId, name: "Build", planned_start: addDays(today(), -9), planned_end: addDays(today(), 10), baseline_start: addDays(today(), -9),
      baseline_end: addDays(today(), 5), ...aggregate([{ points: null, is_done: true }, { points: null, is_done: true }, { points: null, is_done: false }, { points: null, is_done: false }]),
      ...over,
    });
    const phases = (...rows: object[]): [string, QueryHandler] => ["FROM spark.project_phases ph", () => rows];
    const milestones = (...rows: object[]): [string, QueryHandler] => ["FROM spark.project_milestones ms", () => rows];
    const milestone = (id: string, due: string, completed: Date | null, over: object = {}) => ({
      id, name: `M-${id}`, phase_id: phaseId, due_date: due, baseline_due_date: null, completed_at: completed, ...over,
    });

    it("maps phases with variance, plan status and milestone states", async () => {
      const { response, calls } = await get(`${base}/schedule`, [
        project({ methodology: "waterfall" }), periods,
        phases(phase(), phase({ id: userA, name: "Plan", baseline_start: null, baseline_end: null, planned_end: addDays(today(), 20), ...aggregate([]) })),
        milestones(
          milestone("m1", addDays(today(), -5), new Date(`${addDays(today(), -6)}T10:00:00Z`)),
          milestone("m2", addDays(today(), -5), new Date(`${addDays(today(), -1)}T10:00:00Z`)),
          milestone("m3", addDays(today(), -1), null),
          milestone("m4", addDays(today(), 3), null, { phase_id: null, baseline_due_date: addDays(today(), 1) }),
          milestone("m5", addDays(today(), 30), null),
        ),
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      const body = response.json();
      expect(body.period).toMatchObject({ id: periodScrumId });
      expect(body.phases).toEqual([
        { id: phaseId, name: "Build", plannedStart: addDays(today(), -9), plannedEnd: addDays(today(), 10), baselineStart: addDays(today(), -9), baselineEnd: addDays(today(), 5),
          varianceDays: 5, unit: "count", total: 4, done: 2, donePercent: 50, planPercent: 50, status: "on_track" },
        { id: userA, name: "Plan", plannedStart: addDays(today(), -9), plannedEnd: addDays(today(), 20), baselineStart: null, baselineEnd: null,
          varianceDays: null, unit: "count", total: 0, done: 0, donePercent: 0, planPercent: expect.any(Number), status: "on_track" },
      ]);
      expect(body.milestones.map((m: { id: string; state: string }) => [m.id, m.state])).toEqual([["m1", "hit"], ["m2", "missed"], ["m3", "missed"], ["m4", "at_risk"], ["m5", "upcoming"]]);
      expect(body.milestones[3]).toEqual({
        id: "m4", name: "M-m4", phaseId: null, dueDate: addDays(today(), 3), baselineDueDate: addDays(today(), 1), completedAt: null, state: "at_risk",
      });
      expect(body.counts).toEqual({ hit: 1, missed: 2, atRisk: 1, upcoming: 1 });
      expect(body.scheduleVarianceDays).toBe(15);
      expect(find(calls, "FROM spark.project_phases ph")?.params).toEqual([tenantId, projectId]);
      expect(find(calls, "FROM spark.project_phases ph")?.sql).toMatch(/ORDER BY ph\.position/u);
      expect(find(calls, "FROM spark.project_milestones ms")?.sql).toMatch(/ORDER BY ms\.due_date/u);
    });

    it("has a null schedule variance without baselines and works for an older period", async () => {
      const { response } = await get(`${base}/schedule?period=${periodKanbanId}`, [
        project(), periods, phases(phase({ baseline_start: null, baseline_end: null })), milestones(),
      ]);
      expect(response.json()).toMatchObject({ period: { id: periodKanbanId }, scheduleVarianceDays: null, counts: { hit: 0, missed: 0, atRisk: 0, upcoming: 0 }, milestones: [] });
    });

    it("measures a phase in story points when most of its issues are estimated", async () => {
      const { response } = await get(`${base}/schedule`, [
        project(), periods, phases(phase(aggregate([{ points: "5", is_done: true }, { points: "15", is_done: false }]))), milestones(),
      ]);
      expect(response.json().phases[0]).toMatchObject({ unit: "points", total: 20, done: 5, donePercent: 25, status: "at_risk" });
    });

    it("is 404 period_not_found for a foreign period", async () => {
      const { response } = await get(`${base}/schedule?period=${otherPeriodId}`, [project(), periods]);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "period_not_found" });
    });
  });

  describe("sprint burndown", () => {
    const url = `/api/v1/sprints/${sprintId}/burndown`;
    const sprintRow = (over: object = {}) => ({
      id: sprintId, tenant_id: tenantId, project_id: projectId, name: "Sprint 7", goal: null, status: "active", starts_on: addDays(today(), -2), ends_on: addDays(today(), 2),
      started_at: new Date("2026-10-24T08:00:00Z"), completed_at: null, committed_points: "10", committed_count: 4, completed_points: null, completed_count: null, version: 2, ...over,
    });
    const sprint = (over: object = {}): [string, QueryHandler] => ["FROM spark.sprints s WHERE s.id", () => [sprintRow(over)]];
    const day = (offset: number, nums: [number, string, number, string] | null) => ({
      day: addDays(today(), offset),
      scope_count: nums?.[0] ?? null, scope_points: nums?.[1] ?? null, remaining_count: nums?.[2] ?? null, remaining_points: nums?.[3] ?? null,
    });
    const burn: [string, QueryHandler] = ["spark.insight_sprint_burndown(", () => [
      day(-2, [4, "10", 4, "10"]), day(-1, [5, "12", 3, "7"]), day(0, [5, "12", 2, "4"]), day(1, null), day(2, null),
    ]];
    // One row per commitment: the committed story points and the issue's category at the sprint's started_at (null: did not exist yet).
    const commitments = (rows: Array<{ points: string | null; start?: string | null }>): [string, QueryHandler] => [
      "FROM spark.sprint_commitments c", () => rows.map((row) => ({ points: row.points, start_category: row.start ?? "todo" })),
    ];

    it("draws the ideal line from the committed base at the start, counting work finished on day 1, and leaves future days null (points)", async () => {
      // 12 points committed, 2 of them already done at the start: base 10. Day 1 ends with only 4 left, but the 6
      // points finished on day 1 still count in the base, so the ideal starts at 10, not 4.
      const dayOne: [string, QueryHandler] = ["spark.insight_sprint_burndown(", () => [
        day(-2, [4, "10", 2, "4"]), day(-1, [5, "12", 2, "4"]), day(0, [5, "12", 1, "1"]), day(1, null), day(2, null),
      ]];
      const { response, calls } = await get(url, [
        sprint({ committed_points: "12", committed_count: 5 }), dayOne,
        commitments([{ points: "5" }, { points: "5" }, { points: "0" }, { points: "2", start: "done" }, { points: null, start: null }]),
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      const body = response.json();
      expect(body.sprint).toMatchObject({ id: sprintId, name: "Sprint 7", startsOn: addDays(today(), -2), version: 2 });
      expect(body).toMatchObject({ unit: "points", base: 10 });
      expect(body.days).toEqual([
        { day: addDays(today(), -2), ideal: 10, scope: 10, remaining: 4 },
        { day: addDays(today(), -1), ideal: 7.5, scope: 12, remaining: 4 },
        { day: today(), ideal: 5, scope: 12, remaining: 1 },
        { day: addDays(today(), 1), ideal: 2.5, scope: null, remaining: null },
        { day: addDays(today(), 2), ideal: 0, scope: null, remaining: null },
      ]);
      expect(find(calls, "spark.insight_sprint_burndown(")?.params).toEqual([tenantId, sprintId]);
      const read = find(calls, "FROM spark.sprint_commitments c");
      expect(read?.sql).toMatch(/spark\.insight_issue_states\(\$1, \$2, \$3::timestamptz\)/u);
      expect(read?.params).toEqual([tenantId, projectId, "2026-10-24T08:00:00.000Z", sprintId]);
    });

    it("uses counts when under 80% of the commitments are estimated; the base leaves out issues done at the start", async () => {
      const { response } = await get(url, [sprint(), burn, commitments([{ points: "5" }, { points: null }, { points: null }, { points: null, start: "done" }])]);
      const body = response.json();
      expect(body).toMatchObject({ unit: "count", base: 3 });
      expect(body.days.map((d: { ideal: number }) => d.ideal)).toEqual([3, 2.25, 1.5, 0.75, 0]);
      expect(body.days.map((d: { remaining: number | null }) => d.remaining)).toEqual([4, 3, 2, null, null]);
    });

    it("has a zero base for a started sprint with no commitments", async () => {
      const { response } = await get(url, [sprint(), burn, commitments([]), ["FROM spark.issues i", () => [{ points: "3", category: "todo" }]]]);
      expect(response.json()).toMatchObject({ unit: "points", base: 0 });
    });

    it("bases a planned sprint on the issues in it now that are not done", async () => {
      const { response, calls } = await get(url, [
        sprint({ status: "planned", started_at: null, committed_points: null, committed_count: null }), burn, commitments([]),
        ["FROM spark.issues i", () => [{ points: "3", category: "todo" }, { points: "2", category: "done" }, { points: "4", category: "in_progress" }]],
      ]);
      expect(response.json()).toMatchObject({ unit: "points", base: 7 });
      expect(find(calls, "FROM spark.sprint_commitments c")).toBeUndefined();
      expect(find(calls, "FROM spark.issues i")?.params).toEqual([tenantId, projectId, sprintId]);
    });

    it("has a zero base when the sprint has not started yet and holds nothing", async () => {
      const future: [string, QueryHandler] = ["spark.insight_sprint_burndown(", () => [day(1, null), day(2, null)]];
      const { response } = await get(url, [
        sprint({ status: "planned", started_at: null, starts_on: addDays(today(), 1), ends_on: addDays(today(), 2) }), future, ["FROM spark.issues i", () => []],
      ]);
      expect(response.json()).toMatchObject({ base: 0, days: [{ ideal: 0, scope: null, remaining: null }, { ideal: 0, scope: null, remaining: null }] });
    });
  });

  describe("workspace insights", () => {
    const workspaceId = "2d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
    const url = `/api/v1/workspaces/${workspaceId}/insights`;
    const second = "4d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
    const workspace: [string, QueryHandler] = ["FROM spark.workspaces w", () => [{ id: workspaceId }]];
    const projectAgg = (over: object = {}) => ({
      id: projectId, key: "WEB", name: "Web", methodology: "kanban", start_date: null, target_date: null, sprint_id: null, sprint_starts_on: null, sprint_ends_on: null,
      open_count: "3", overdue_count: "1", ...aggregate([{ points: null, is_done: true }, { points: null, is_done: false }, { points: null, is_done: false }, { points: null, is_done: false }]), ...over,
    });
    const projectsQuery = (...rows: object[]): [string, QueryHandler] => ["p.archived_at IS NULL", () => rows];
    const members: [string, QueryHandler] = ["spark.ws_list_members(", () => [{ user_id: userA, display_name: "Ada" }, { user_id: userB, display_name: "Ben" }]];
    const memberStats: [string, QueryHandler] = ["spark.insight_members(", () => [
      { user_id: userA, completed: 2, completed_points: "5", with_due: 0, on_time: 0, open: 1, overdue: 0, median_cycle_days: null },
    ]];
    const calendar: [string, QueryHandler] = ["FROM generate_series", () => [
      { day: addDays(today(), -1), value: "4" }, { day: today(), value: "0" },
    ]];
    const overdueList: [string, QueryHandler] = ["ORDER BY i.due_date, p.key", () => [
      { id: "i1", number: 7, title: "Late", due_date: "2026-01-02", project_key: "WEB", assignee_user_id: userA, assignee_display_name: "Ada" },
      { id: "i2", number: 2, title: "Loose", due_date: "2026-01-03", project_key: "API", assignee_user_id: null, assignee_display_name: null },
    ]];

    it("is 401 without a session, 404 workspace_not_found for a foreign workspace and 400 for bad input", async () => {
      const anon = await get(url, [], false);
      expect(anon.response.statusCode).toBe(401);
      expect(anon.response.headers["cache-control"]).toBe("private, no-store");
      const foreign = await get(url);
      expect(foreign.response.statusCode).toBe(404);
      expect(foreign.response.json()).toMatchObject({ code: "workspace_not_found" });
      expect(foreign.response.headers["cache-control"]).toBe("private, no-store");
      for (const bad of ["/api/v1/workspaces/nope/insights", `${url}?bogus=1`, `${url}?days=6`, `${url}?days=181`]) {
        const { response } = await get(bad, [workspace]);
        expect(response.statusCode).toBe(400);
        expect(response.headers["cache-control"]).toBe("private, no-store");
      }
    });

    it("aggregates the workspace's projects, members, calendar and overdue work", async () => {
      const start = addDays(today(), -9);
      const end = addDays(today(), 10);
      const { response, calls } = await get(`${url}?days=7`, [
        workspace,
        projectsQuery(
          projectAgg({ start_date: start, target_date: end }),
          projectAgg({ id: second, key: "API", name: "Api", methodology: "scrum", sprint_id: sprintId, sprint_starts_on: start, sprint_ends_on: end, ...aggregate([{ points: "5", is_done: false }, { points: "15", is_done: true }]), open_count: "1", overdue_count: "0" }),
        ),
        members, memberStats, calendar, overdueList,
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      const body = response.json();
      expect(body.range).toEqual(rangeOf(7, today()));
      expect(body.projects).toEqual([
        { id: projectId, key: "WEB", name: "Web", methodology: "kanban", unit: "count", donePercent: 25, planPercent: 50, status: "at_risk", open: 3, overdue: 1 },
        { id: second, key: "API", name: "Api", methodology: "scrum", unit: "points", donePercent: 75, planPercent: 50, status: "on_track", open: 1, overdue: 0 },
      ]);
      expect(body.members.map((m: { user: { id: string } | null }) => m.user?.id)).toEqual([userA, userB]);
      expect(body.members[0]).toMatchObject({ completed: 2, completedPoints: 5, open: 1 });
      expect(body.calendar).toEqual([{ day: addDays(today(), -1), value: 4 }, { day: today(), value: 0 }]);
      expect(body.overdue).toEqual([
        { issueId: "i1", key: "WEB-7", title: "Late", projectKey: "WEB", dueDate: "2026-01-02", assignee: { id: userA, displayName: "Ada" } },
        { issueId: "i2", key: "API-2", title: "Loose", projectKey: "API", dueDate: "2026-01-03", assignee: null },
      ]);
      expect(find(calls, "p.archived_at IS NULL")?.params[0]).toBe(workspaceId);
      expect(find(calls, "spark.insight_members(")?.params).toEqual([workspaceId, [projectId, second], addDays(today(), -6), today(), today()]);
      expect(find(calls, "FROM generate_series")?.params).toEqual([workspaceId, [projectId, second], addDays(today(), -6), today()]);
      expect(find(calls, "ORDER BY i.due_date, p.key")?.params).toEqual([workspaceId, [projectId, second], today()]);
    });

    it("lists a former member whose name is not readable as \"Former member\", before Unassigned", async () => {
      const { response } = await get(url, [
        workspace, projectsQuery(projectAgg()), members,
        ["spark.insight_members(", () => [
          { user_id: null, completed: 1, completed_points: "0", with_due: 0, on_time: 0, open: 2, overdue: 0, median_cycle_days: null },
          { user_id: userGone, completed: 3, completed_points: "0", with_due: 1, on_time: 1, open: 1, overdue: 1, median_cycle_days: "1.5" },
        ]],
        ["FROM spark.users u WHERE", () => []],
        ["FROM generate_series", () => []],
      ]);
      expect(response.statusCode).toBe(200);
      const list = response.json().members as Array<{ user: { id: string; displayName: string } | null; completed: number; open: number }>;
      expect(list.map((m) => m.user)).toEqual([{ id: userGone, displayName: "Former member" }, { id: userA, displayName: "Ada" }, { id: userB, displayName: "Ben" }, null]);
      expect(list[0]).toMatchObject({ completed: 3, open: 1, onTimeRate: 100, medianCycleDays: 1.5 });
      expect(list.reduce((sum, m) => sum + m.completed, 0)).toBe(4);
    });

    it("reports an empty workspace with zero-filled members and no projects", async () => {
      const { response } = await get(url, [workspace, projectsQuery(), members, ["FROM generate_series", () => []]]);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ projects: [], overdue: [], calendar: [] });
      expect(response.json().members).toHaveLength(2);
    });
  });
});
