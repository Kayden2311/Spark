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

const today = () => todayUtc(new Date());
const base = `/api/v1/projects/${projectId}/insights`;
const urls = ["summary", "members", "flow", "cycle-time", "aging-wip"].map((name) => `${base}/${name}`);

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
    const issues = (rows: Array<{ points: string | null; is_done: boolean }>): [string, QueryHandler] => ["AS is_done", () => rows];
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
      expect(find(calls, "AS is_done")?.params).toEqual([tenantId, projectId, "sp1"]);
    });

    it("has no plan and covers the whole project for scrum without an active sprint", async () => {
      const { response, calls } = await get(`${base}/summary`, [project({ methodology: "scrum" }), periods, issues([{ points: null, is_done: true }]), flowRows(0), overdue]);
      expect(response.json()).toMatchObject({ total: 1, plan: { kind: null, status: "no_plan" } });
      expect(find(calls, "AS is_done")?.params).toEqual([tenantId, projectId, null]);
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
});
