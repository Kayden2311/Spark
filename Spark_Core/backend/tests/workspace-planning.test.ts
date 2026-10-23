import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { dbError, fakePool, principalRow, type QueryHandler } from "./fake-pool.js";

const config = loadConfig({ NODE_ENV: "test" });
const cookie = `spark_session=${"b".repeat(64)}`;
const tenantId = "1d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const projectId = "3d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const sprintId = "4d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const nextSprintId = "5d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const statusId = "6d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const milestoneId = "7d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const phaseId = "8d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const doneId = "9d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";

const projectRef = { id: projectId, tenant_id: tenantId, baselined_at: new Date("2026-10-18T09:00:00Z"), settings_version: 4 };

const projectDetailRow = {
  id: projectId,
  tenant_id: tenantId,
  key: "WEB",
  name: "Website",
  description: null,
  methodology: "kanban",
  start_date: null,
  target_date: null,
  sprint_length_days: null,
  baselined_at: null,
  settings_version: 5,
  created_at: new Date("2026-01-03T00:00:00Z"),
  lead_id: null,
  lead_display_name: null,
  issue_total: "3",
  issue_done: "1",
};

const sprintRow = {
  id: sprintId,
  name: "Sprint 1",
  goal: "Ship login",
  status: "planned",
  starts_on: "2026-11-02",
  ends_on: "2026-11-16",
  started_at: null,
  completed_at: null,
  committed_points: null,
  committed_count: null,
  completed_points: null,
  completed_count: null,
  version: 3,
};

const completedRow = {
  ...sprintRow,
  id: nextSprintId,
  name: "Sprint 0",
  status: "completed",
  started_at: new Date("2026-10-01T09:00:00Z"),
  completed_at: new Date("2026-10-15T17:00:00Z"),
  committed_points: "13.00",
  committed_count: 5,
  completed_points: "8.50",
  completed_count: 3,
  version: 3,
};

const phaseRow = {
  id: phaseId,
  name: "Build",
  position: 1,
  planned_start: "2026-11-02",
  planned_end: "2026-11-06",
  baseline_start: "2026-11-02",
  baseline_end: "2026-11-05",
  status: "planned",
};

const milestoneRow = {
  id: milestoneId,
  name: "Beta",
  phase_id: phaseId,
  due_date: "2026-11-06",
  baseline_due_date: null,
  completed_at: null,
  version: 2,
};

type Request = { method: "GET" | "POST" | "PATCH" | "PUT"; url: string; payload?: unknown; headers?: Record<string, string> };

async function call(request: Request, handlers: Array<[string, QueryHandler]> = [], signedIn = true) {
  const { pool, calls } = fakePool([["auth_session_principal", signedIn ? () => [principalRow] : () => []], ...handlers]);
  const app = await buildApp({ config, pool, rateLimit: false, logger: false });
  try {
    const response = await app.inject({ ...request, headers: { ...(signedIn ? { cookie } : {}), ...request.headers } } as Parameters<typeof app.inject>[0]);
    return { response, calls };
  } finally {
    await app.close();
  }
}

const paramsOf = (calls: Array<{ sql: string; params: unknown[] }>, fn: string) => calls.find((c) => c.sql.includes(fn))?.params ?? [];
const called = (calls: Array<{ sql: string; params: unknown[] }>, fn: string) => calls.some((c) => c.sql.includes(fn));

const projectRefHandler: [string, QueryHandler] = ["FROM spark.projects p WHERE", () => [projectRef]];
const sprintHandler = (row: object = sprintRow): [string, QueryHandler] => ["FROM spark.sprints s", () => [row]];
const planHandlers: Array<[string, QueryHandler]> = [
  projectRefHandler,
  ["FROM spark.project_phases ph", () => [phaseRow]],
  ["FROM spark.project_milestones ms", () => [milestoneRow]],
];
const detailHandlers = (row: object = projectDetailRow): Array<[string, QueryHandler]> => [
  ["FROM spark.projects p\n", () => [row]],
  ["FROM spark.issue_statuses s WHERE s.tenant_id", () => [{ id: statusId, name: "Doing", category: "in_progress", position: "2048.000000", wip_limit: 3 }]],
];
const statusInProject: [string, QueryHandler] = ["p.id = $1 AND s.id = $2", () => [{ id: statusId }]];

const sprintsUrl = `/api/v1/projects/${projectId}/sprints`;
const sprintUrl = `/api/v1/sprints/${sprintId}`;
const planUrl = `/api/v1/projects/${projectId}/plan`;
const phasesUrl = `/api/v1/projects/${projectId}/phases`;
const milestonesUrl = `/api/v1/projects/${projectId}/milestones`;
const milestoneUrl = `/api/v1/milestones/${milestoneId}`;
const baselineUrl = `/api/v1/projects/${projectId}/baseline`;
const statusUrl = `/api/v1/projects/${projectId}/statuses/${statusId}`;
const methodologyUrl = `/api/v1/projects/${projectId}/methodology`;

const ifMatch = (version = 3) => ({ "if-match": `"v${version}"` });
const phasesBody = { phases: [{ id: phaseId, name: "Build", plannedStart: "2026-11-02", plannedEnd: "2026-11-06" }] };
const kanbanSwitch = {
  to: "kanban",
  columns: [
    { id: statusId, name: "Doing", category: "in_progress", wipLimit: 3 },
    { name: "Done", category: "done", wipLimit: null },
  ],
  mapping: { [doneId]: 1 },
  reason: "Steady flow of support work",
};

// Every state-changing route with a body that passes the schema, and the function it calls.
const WRITES: Array<{ route: Request; fn: string; empty: Record<string, unknown> }> = [
  { route: { method: "POST", url: sprintsUrl, payload: { name: "Sprint 2" } }, fn: "ws_create_sprint", empty: { outcome: "forbidden", sprint_id: null, sprint_version: null } },
  { route: { method: "PATCH", url: sprintUrl, payload: { name: "Sprint 1b" }, headers: ifMatch() }, fn: "ws_update_sprint", empty: { outcome: "forbidden", sprint_version: null } },
  { route: { method: "POST", url: `${sprintUrl}/start`, headers: ifMatch() }, fn: "ws_start_sprint", empty: { outcome: "forbidden", sprint_version: null } },
  { route: { method: "POST", url: `${sprintUrl}/complete`, payload: { carryToSprintId: null }, headers: ifMatch() }, fn: "ws_complete_sprint", empty: { outcome: "forbidden", sprint_version: null, moved_issues: null } },
  { route: { method: "PUT", url: phasesUrl, payload: phasesBody, headers: ifMatch(4) }, fn: "ws_save_phases", empty: { outcome: "forbidden", settings_version: null } },
  { route: { method: "POST", url: milestonesUrl, payload: { name: "Beta", dueDate: "2026-11-06" } }, fn: "ws_create_milestone", empty: { outcome: "forbidden", milestone_id: null, milestone_version: null } },
  { route: { method: "PATCH", url: milestoneUrl, payload: { completed: true }, headers: ifMatch(2) }, fn: "ws_update_milestone", empty: { outcome: "forbidden", milestone_version: null } },
  { route: { method: "POST", url: baselineUrl, payload: { reason: "Scope change" }, headers: ifMatch(4) }, fn: "ws_rebaseline_project", empty: { outcome: "forbidden", settings_version: null } },
  { route: { method: "PATCH", url: statusUrl, payload: { wipLimit: 2 }, headers: ifMatch(4) }, fn: "ws_update_status", empty: { outcome: "forbidden", settings_version: null } },
  { route: { method: "POST", url: methodologyUrl, payload: kanbanSwitch, headers: ifMatch(4) }, fn: "ws_switch_methodology", empty: { outcome: "forbidden", settings_version: null, moved_issues: null } },
];

const READS: Request[] = [
  { method: "GET", url: sprintsUrl },
  { method: "GET", url: sprintUrl },
  { method: "GET", url: planUrl },
  { method: "GET", url: milestoneUrl },
];

// Commands that change versioned state and therefore need If-Match.
const VERSIONED = WRITES.filter((w) => w.route.headers);

describe("planning routes", () => {
  it.each([...READS, ...WRITES.map((w) => w.route)])("$method $url requires a session", async (route) => {
    const { response } = await call(route, [], false);
    expect(response.statusCode).toBe(401);
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it.each(WRITES)("$route.method $route.url answers a plain member with 403 insufficient_role", async ({ route, fn, empty }) => {
    const { response } = await call(route, [statusInProject, [fn, () => [empty]]]);
    expect(response.statusCode).toBe(403);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toMatchObject({ code: "insufficient_role", detail: "Only owners, admins and the project lead can change the plan." });
  });

  it.each(WRITES)("$route.method $route.url is 404 for a non-member", async ({ route, fn, empty }) => {
    const { response } = await call(route, [statusInProject, [fn, () => [{ ...empty, outcome: "not_found" }]]]);
    expect(response.statusCode).toBe(404);
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it.each(WRITES)("$route.method $route.url fails closed on an unknown outcome", async ({ route, fn, empty }) => {
    const { response } = await call(route, [statusInProject, [fn, () => [{ ...empty, outcome: "weird" }]]]);
    expect(response.statusCode).toBe(500);
  });

  it.each(WRITES)("$route.method $route.url refuses a cross-origin request", async ({ route, fn }) => {
    const { response, calls } = await call({ ...route, headers: { ...route.headers, origin: "https://evil.example" } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "origin_not_allowed" });
    expect(called(calls, fn)).toBe(false);
  });

  it.each(VERSIONED)("$route.method $route.url requires If-Match", async ({ route, fn }) => {
    const { response, calls } = await call({ ...route, headers: {} });
    expect(response.statusCode).toBe(428);
    expect(response.json()).toMatchObject({ code: "precondition_required" });
    expect(called(calls, fn)).toBe(false);
  });

  it.each(VERSIONED)("$route.method $route.url rejects a malformed If-Match", async ({ route, fn }) => {
    const { response, calls } = await call({ ...route, headers: { "if-match": 'W/"v3"' } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_if_match" });
    expect(called(calls, fn)).toBe(false);
  });

  it.each(WRITES.filter((w) => w.route.payload !== undefined))("$route.method $route.url rejects an unknown body key", async ({ route, fn }) => {
    const { response, calls } = await call({ ...route, payload: { ...(route.payload as object), color: "red" } });
    expect(response.statusCode).toBe(400);
    expect(called(calls, fn)).toBe(false);
  });

  describe("sprints", () => {
    it("lists active and planned sprints, then the last 50 finished ones", async () => {
      const { response, calls } = await call({ method: "GET", url: sprintsUrl }, [
        projectRefHandler,
        ["status IN ('active', 'planned')", () => [{ ...sprintRow, status: "active", version: 4 }]],
        ["status IN ('completed', 'cancelled')", () => [completedRow]],
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      const items = response.json().items;
      expect(items.map((s: { id: string }) => s.id)).toEqual([sprintId, nextSprintId]);
      expect(items[1]).toEqual({
        id: nextSprintId,
        name: "Sprint 0",
        goal: "Ship login",
        status: "completed",
        startsOn: "2026-11-02",
        endsOn: "2026-11-16",
        startedAt: "2026-10-01T09:00:00.000Z",
        completedAt: "2026-10-15T17:00:00.000Z",
        committedPoints: 13,
        committedCount: 5,
        completedPoints: 8.5,
        completedCount: 3,
        version: 3,
      });
      const open = calls.find((c) => c.sql.includes("status IN ('active', 'planned')"));
      const finished = calls.find((c) => c.sql.includes("status IN ('completed', 'cancelled')"));
      expect(open?.params).toEqual([tenantId, projectId]);
      expect(open?.sql).toContain("AT TIME ZONE 'UTC'");
      expect(finished?.params).toEqual([tenantId, projectId]);
      expect(finished?.sql).toContain("LIMIT 50");
      expect(open?.sql).not.toMatch(/SELECT \*/u);
    });

    it("is 404 when the project is not visible", async () => {
      const { response, calls } = await call({ method: "GET", url: sprintsUrl });
      expect(response.statusCode).toBe(404);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.json()).toMatchObject({ code: "project_not_found" });
      expect(called(calls, "FROM spark.sprints s")).toBe(false);
    });

    it("reads one sprint with an ETag", async () => {
      const { response, calls } = await call({ method: "GET", url: sprintUrl }, [sprintHandler()]);
      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"v3"');
      expect(response.json()).toMatchObject({ id: sprintId, status: "planned", startsOn: "2026-11-02", committedPoints: null });
      expect(calls.find((c) => c.sql.includes("FROM spark.sprints s"))?.sql).toContain("session_workspace_ids");
    });

    it("is 404 for a sprint that is not visible", async () => {
      const { response } = await call({ method: "GET", url: sprintUrl });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "sprint_not_found" });
    });

    it("creates a sprint with the five parameters", async () => {
      const payload = { name: "Sprint 1", goal: "Ship login", startsOn: "2026-11-02", endsOn: "2026-11-16" };
      const { response, calls } = await call({ method: "POST", url: sprintsUrl, payload }, [
        ["ws_create_sprint", () => [{ outcome: "ok", sprint_id: sprintId, sprint_version: 1 }]],
        sprintHandler({ ...sprintRow, version: 1 }),
      ]);
      expect(response.statusCode).toBe(201);
      expect(response.headers.location).toBe(`/api/v1/sprints/${sprintId}`);
      expect(response.headers.etag).toBe('"v1"');
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(paramsOf(calls, "ws_create_sprint")).toEqual([projectId, "Sprint 1", "Ship login", "2026-11-02", "2026-11-16"]);
      expect(response.json()).toMatchObject({ id: sprintId, name: "Sprint 1", version: 1 });
    });

    it("creates a sprint without a goal or dates", async () => {
      const { calls } = await call({ method: "POST", url: sprintsUrl, payload: { name: "Sprint 2" } }, [
        ["ws_create_sprint", () => [{ outcome: "ok", sprint_id: sprintId, sprint_version: 1 }]],
        sprintHandler(),
      ]);
      expect(paramsOf(calls, "ws_create_sprint")).toEqual([projectId, "Sprint 2", null, null, null]);
    });

    it.each([
      ["a calendar-invalid date", { name: "S", startsOn: "2026-02-30", endsOn: "2026-03-10" }],
      ["no name", { goal: "x" }],
      ["an empty name", { name: "" }],
    ])("rejects a create with %s in the schema", async (_label, payload) => {
      const { response, calls } = await call({ method: "POST", url: sprintsUrl, payload });
      expect(response.statusCode).toBe(400);
      expect(called(calls, "ws_create_sprint")).toBe(false);
    });

    it("reports a sprint write on a Kanban project as invalid input", async () => {
      const error = Object.assign(dbError("22023"), { message: "Invalid methodology" });
      const { response } = await call({ method: "POST", url: sprintsUrl, payload: { name: "S" } }, [["ws_create_sprint", () => error]]);
      expect(response.statusCode).toBe(400);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.json()).toMatchObject({ code: "invalid_input", detail: "Invalid methodology." });
    });

    it.each(["Invalid sprint name", "Invalid sprint goal", "Invalid sprint dates"])("reports the whitelisted error %s", async (message) => {
      const error = Object.assign(dbError("22023"), { message });
      const { response } = await call({ method: "POST", url: sprintsUrl, payload: { name: "S" } }, [["ws_create_sprint", () => error]]);
      expect(response.json()).toMatchObject({ code: "invalid_input", detail: `${message}.` });
    });

    it("patches a sprint with If-Match", async () => {
      const payload = { name: "Sprint 1b", goal: null, startsOn: "2026-11-03", endsOn: "2026-11-17" };
      const { response, calls } = await call({ method: "PATCH", url: sprintUrl, payload, headers: ifMatch() }, [
        ["ws_update_sprint", () => [{ outcome: "ok", sprint_version: 4 }]],
        sprintHandler({ ...sprintRow, name: "Sprint 1b", version: 4 }),
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"v4"');
      const params = paramsOf(calls, "ws_update_sprint");
      expect(params.slice(0, 2)).toEqual([sprintId, 3]);
      expect(JSON.parse(String(params[2]))).toEqual(payload);
    });

    it("rejects an empty sprint patch", async () => {
      const { response, calls } = await call({ method: "PATCH", url: sprintUrl, payload: {}, headers: ifMatch() });
      expect(response.statusCode).toBe(400);
      expect(called(calls, "ws_update_sprint")).toBe(false);
    });

    it("answers a stale sprint patch with 412 and the current sprint", async () => {
      const { response } = await call({ method: "PATCH", url: sprintUrl, payload: { name: "X" }, headers: ifMatch(1) }, [
        ["ws_update_sprint", () => [{ outcome: "version_mismatch", sprint_version: 3 }]],
        sprintHandler(),
      ]);
      expect(response.statusCode).toBe(412);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.json()).toMatchObject({ code: "version_mismatch", current: { id: sprintId, version: 3 } });
    });

    it("maps not_editable to 409 sprint_not_editable", async () => {
      const { response } = await call({ method: "PATCH", url: sprintUrl, payload: { startsOn: "2026-11-03" }, headers: ifMatch() }, [
        ["ws_update_sprint", () => [{ outcome: "not_editable", sprint_version: null }]],
      ]);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "sprint_not_editable" });
    });

    it("starts a sprint and returns it with the new ETag", async () => {
      const { response, calls } = await call({ method: "POST", url: `${sprintUrl}/start`, headers: ifMatch() }, [
        ["ws_start_sprint", () => [{ outcome: "ok", sprint_version: 4 }]],
        sprintHandler({ ...sprintRow, status: "active", started_at: new Date("2026-11-02T08:00:00Z"), committed_points: "5.00", committed_count: 2, version: 4 }),
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"v4"');
      expect(paramsOf(calls, "ws_start_sprint")).toEqual([sprintId, 3]);
      expect(response.json()).toMatchObject({ status: "active", startedAt: "2026-11-02T08:00:00.000Z", committedPoints: 5, committedCount: 2 });
    });

    it("answers a second start of an already active sprint with 409, even with a stale If-Match", async () => {
      const { response } = await call({ method: "POST", url: `${sprintUrl}/start`, headers: ifMatch(1) }, [
        ["ws_start_sprint", () => [{ outcome: "already_active", sprint_version: null }]],
      ]);
      expect(response.statusCode).toBe(409);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.json()).toMatchObject({ code: "sprint_already_active", detail: "Another sprint is already active in this project. Complete it first." });
    });

    it.each([
      ["not_planned", "sprint_not_planned"],
      ["missing_dates", "sprint_missing_dates"],
    ])("maps start outcome %s to 409 %s", async (outcome, code) => {
      const { response } = await call({ method: "POST", url: `${sprintUrl}/start`, headers: ifMatch() }, [
        ["ws_start_sprint", () => [{ outcome, sprint_version: null }]],
      ]);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code });
    });

    it("answers a stale start with 412 and the current sprint", async () => {
      const { response } = await call({ method: "POST", url: `${sprintUrl}/start`, headers: ifMatch(1) }, [
        ["ws_start_sprint", () => [{ outcome: "version_mismatch", sprint_version: 3 }]],
        sprintHandler(),
      ]);
      expect(response.statusCode).toBe(412);
      expect(response.json()).toMatchObject({ code: "version_mismatch", current: { id: sprintId, version: 3 } });
    });

    it("completes a sprint carrying open work to the next sprint", async () => {
      const { response, calls } = await call({ method: "POST", url: `${sprintUrl}/complete`, payload: { carryToSprintId: nextSprintId }, headers: ifMatch(4) }, [
        ["ws_complete_sprint", () => [{ outcome: "ok", sprint_version: 5, moved_issues: 2 }]],
        sprintHandler({ ...completedRow, id: sprintId, version: 5 }),
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"v5"');
      expect(paramsOf(calls, "ws_complete_sprint")).toEqual([sprintId, 4, nextSprintId]);
      expect(response.json()).toMatchObject({ sprint: { id: sprintId, status: "completed", completedPoints: 8.5 }, movedIssues: 2 });
    });

    it("completes a sprint moving open work to the backlog", async () => {
      const { calls } = await call({ method: "POST", url: `${sprintUrl}/complete`, payload: { carryToSprintId: null }, headers: ifMatch(4) }, [
        ["ws_complete_sprint", () => [{ outcome: "ok", sprint_version: 5, moved_issues: 0 }]],
        sprintHandler(completedRow),
      ]);
      expect(paramsOf(calls, "ws_complete_sprint")).toEqual([sprintId, 4, null]);
    });

    it.each([
      ["no body", undefined],
      ["no carry target key", {}],
      ["a malformed carry target", { carryToSprintId: "next" }],
    ])("rejects a complete with %s", async (_label, payload) => {
      const { response, calls } = await call({ method: "POST", url: `${sprintUrl}/complete`, payload, headers: ifMatch(4) });
      expect(response.statusCode).toBe(400);
      expect(called(calls, "ws_complete_sprint")).toBe(false);
    });

    it.each([
      ["not_active", 409, "sprint_not_active"],
      ["invalid_carry_target", 422, "invalid_carry_target"],
    ])("maps complete outcome %s", async (outcome, status, code) => {
      const { response } = await call({ method: "POST", url: `${sprintUrl}/complete`, payload: { carryToSprintId: nextSprintId }, headers: ifMatch(4) }, [
        ["ws_complete_sprint", () => [{ outcome, sprint_version: null, moved_issues: null }]],
      ]);
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
    });

    it("answers a stale complete with 412 and the current sprint", async () => {
      const { response } = await call({ method: "POST", url: `${sprintUrl}/complete`, payload: { carryToSprintId: null }, headers: ifMatch(1) }, [
        ["ws_complete_sprint", () => [{ outcome: "version_mismatch", sprint_version: 4, moved_issues: null }]],
        sprintHandler({ ...sprintRow, status: "active", version: 4 }),
      ]);
      expect(response.statusCode).toBe(412);
      expect(response.json()).toMatchObject({ code: "version_mismatch", current: { status: "active", version: 4 } });
    });
  });

  describe("plan", () => {
    it("reads phases, milestones and the project version", async () => {
      const { response, calls } = await call({ method: "GET", url: planUrl }, planHandlers);
      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"v4"');
      expect(response.json()).toEqual({
        phases: [{
          id: phaseId,
          name: "Build",
          position: 1,
          plannedStart: "2026-11-02",
          plannedEnd: "2026-11-06",
          baselineStart: "2026-11-02",
          baselineEnd: "2026-11-05",
          status: "planned",
        }],
        milestones: [{ id: milestoneId, name: "Beta", phaseId, dueDate: "2026-11-06", baselineDueDate: null, completedAt: null, version: 2 }],
        baselinedAt: "2026-10-18T09:00:00.000Z",
        version: 4,
      });
      expect(paramsOf(calls, "FROM spark.project_phases ph")).toEqual([tenantId, projectId]);
      expect(paramsOf(calls, "FROM spark.project_milestones ms")).toEqual([tenantId, projectId]);
    });

    it("is 404 for a project that is not visible", async () => {
      const { response } = await call({ method: "GET", url: planUrl });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "project_not_found" });
    });

    it("saves the phase plan with the project version", async () => {
      const { response, calls } = await call({ method: "PUT", url: phasesUrl, payload: phasesBody, headers: ifMatch(4) }, [
        ["ws_save_phases", () => [{ outcome: "ok", settings_version: 5 }]],
        ["FROM spark.projects p WHERE", () => [{ ...projectRef, settings_version: 5 }]],
        ...planHandlers.slice(1),
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"v5"');
      const params = paramsOf(calls, "ws_save_phases");
      expect(params.slice(0, 2)).toEqual([projectId, 4]);
      expect(JSON.parse(String(params[2]))).toEqual(phasesBody.phases);
      expect(response.json()).toMatchObject({ version: 5, phases: [{ id: phaseId }] });
    });

    it("answers a stale phase plan with 412 and the current plan, before input errors", async () => {
      const invalid = { phases: [{ name: "Build", plannedStart: "2026-11-09", plannedEnd: "2026-11-02" }] };
      const { response } = await call({ method: "PUT", url: phasesUrl, payload: invalid, headers: ifMatch(1) }, [
        ["ws_save_phases", () => [{ outcome: "version_mismatch", settings_version: 4 }]],
        ...planHandlers,
      ]);
      expect(response.statusCode).toBe(412);
      expect(response.json()).toMatchObject({ code: "version_mismatch", current: { version: 4, phases: [{ id: phaseId }] } });
    });

    it.each(["Invalid project phases", "Invalid phase"])("reports the whitelisted phase error %s", async (message) => {
      const error = Object.assign(dbError("22023"), { message });
      const { response } = await call({ method: "PUT", url: phasesUrl, payload: phasesBody, headers: ifMatch(4) }, [["ws_save_phases", () => error]]);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_input", detail: `${message}.` });
    });

    it.each([
      ["no phases", { phases: [] }],
      ["an unknown phase key", { phases: [{ name: "Build", plannedStart: "2026-11-02", plannedEnd: "2026-11-06", owner: "x" }] }],
      ["a calendar-invalid date", { phases: [{ name: "Build", plannedStart: "2026-11-31", plannedEnd: "2026-12-06" }] }],
    ])("rejects a phase plan with %s in the schema", async (_label, payload) => {
      const { response, calls } = await call({ method: "PUT", url: phasesUrl, payload, headers: ifMatch(4) });
      expect(response.statusCode).toBe(400);
      expect(called(calls, "ws_save_phases")).toBe(false);
    });

    it("creates a milestone", async () => {
      const { response, calls } = await call({ method: "POST", url: milestonesUrl, payload: { name: "Beta", dueDate: "2026-11-06", phaseId } }, [
        ["ws_create_milestone", () => [{ outcome: "ok", milestone_id: milestoneId, milestone_version: 1 }]],
        ["FROM spark.project_milestones ms", () => [{ ...milestoneRow, version: 1 }]],
      ]);
      expect(response.statusCode).toBe(201);
      expect(response.headers.location).toBe(`/api/v1/milestones/${milestoneId}`);
      expect(response.headers.etag).toBe('"v1"');
      expect(paramsOf(calls, "ws_create_milestone")).toEqual([projectId, "Beta", "2026-11-06", phaseId]);
      expect(calls.find((c) => c.sql.includes("FROM spark.project_milestones ms"))?.sql).toContain("session_workspace_ids");
    });

    it("creates a milestone without a phase", async () => {
      const { calls } = await call({ method: "POST", url: milestonesUrl, payload: { name: "Beta", dueDate: "2026-11-06" } }, [
        ["ws_create_milestone", () => [{ outcome: "ok", milestone_id: milestoneId, milestone_version: 1 }]],
        ["FROM spark.project_milestones ms", () => [milestoneRow]],
      ]);
      expect(paramsOf(calls, "ws_create_milestone")).toEqual([projectId, "Beta", "2026-11-06", null]);
    });

    it("rejects a milestone without a due date", async () => {
      const { response, calls } = await call({ method: "POST", url: milestonesUrl, payload: { name: "Beta" } });
      expect(response.statusCode).toBe(400);
      expect(called(calls, "ws_create_milestone")).toBe(false);
    });

    it("reads one milestone with an ETag", async () => {
      const { response } = await call({ method: "GET", url: milestoneUrl }, [["FROM spark.project_milestones ms", () => [milestoneRow]]]);
      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"v2"');
      expect(response.json()).toMatchObject({ id: milestoneId, phaseId });
    });

    it("is 404 for a milestone that is not visible", async () => {
      const { response } = await call({ method: "GET", url: milestoneUrl });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "milestone_not_found" });
    });

    it("completes a milestone with If-Match", async () => {
      const payload = { name: "Beta 2", dueDate: "2026-11-07", phaseId: null, completed: true };
      const { response, calls } = await call({ method: "PATCH", url: milestoneUrl, payload, headers: ifMatch(2) }, [
        ["ws_update_milestone", () => [{ outcome: "ok", milestone_version: 3 }]],
        ["FROM spark.project_milestones ms", () => [{ ...milestoneRow, completed_at: new Date("2026-11-07T10:00:00Z"), version: 3 }]],
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"v3"');
      const params = paramsOf(calls, "ws_update_milestone");
      expect(params.slice(0, 2)).toEqual([milestoneId, 2]);
      expect(JSON.parse(String(params[2]))).toEqual(payload);
      expect(response.json()).toMatchObject({ completedAt: "2026-11-07T10:00:00.000Z", version: 3 });
    });

    it("answers a stale milestone patch with 412 and the current milestone", async () => {
      const { response } = await call({ method: "PATCH", url: milestoneUrl, payload: { completed: true }, headers: ifMatch(1) }, [
        ["ws_update_milestone", () => [{ outcome: "version_mismatch", milestone_version: 2 }]],
        ["FROM spark.project_milestones ms", () => [milestoneRow]],
      ]);
      expect(response.statusCode).toBe(412);
      expect(response.json()).toMatchObject({ code: "version_mismatch", current: { id: milestoneId, version: 2 } });
    });

    it("reports a whitelisted milestone error", async () => {
      const error = Object.assign(dbError("22023"), { message: "Invalid milestone" });
      const { response } = await call({ method: "PATCH", url: milestoneUrl, payload: { dueDate: "2027-01-01" }, headers: ifMatch(2) }, [["ws_update_milestone", () => error]]);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_input", detail: "Invalid milestone." });
    });

    it("re-baselines with a reason", async () => {
      const { response, calls } = await call({ method: "POST", url: baselineUrl, payload: { reason: "Scope change" }, headers: ifMatch(4) }, [
        ["ws_rebaseline_project", () => [{ outcome: "ok", settings_version: 5 }]],
        ["FROM spark.projects p WHERE", () => [{ ...projectRef, settings_version: 5 }]],
        ...planHandlers.slice(1),
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"v5"');
      expect(paramsOf(calls, "ws_rebaseline_project")).toEqual([projectId, 4, "Scope change"]);
      expect(response.json()).toMatchObject({ version: 5, baselinedAt: "2026-10-18T09:00:00.000Z" });
    });

    it("rejects a re-baseline without a reason", async () => {
      const { response, calls } = await call({ method: "POST", url: baselineUrl, payload: {}, headers: ifMatch(4) });
      expect(response.statusCode).toBe(400);
      expect(called(calls, "ws_rebaseline_project")).toBe(false);
    });

    it("answers a stale re-baseline with 412 and the current plan", async () => {
      const { response } = await call({ method: "POST", url: baselineUrl, payload: { reason: "Scope change" }, headers: ifMatch(1) }, [
        ["ws_rebaseline_project", () => [{ outcome: "version_mismatch", settings_version: 4 }]],
        ...planHandlers,
      ]);
      expect(response.statusCode).toBe(412);
      expect(response.json()).toMatchObject({ code: "version_mismatch", current: { version: 4 } });
    });
  });

  describe("statuses", () => {
    it("renames a column and changes its WIP limit", async () => {
      const { response, calls } = await call({ method: "PATCH", url: statusUrl, payload: { name: "In review", wipLimit: 4 }, headers: ifMatch(4) }, [
        statusInProject,
        ["ws_update_status", () => [{ outcome: "ok", settings_version: 5 }]],
        ...detailHandlers(),
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"v5"');
      expect(paramsOf(calls, "ws_update_status")).toEqual([statusId, 4, "In review", 4, false]);
      expect(paramsOf(calls, "p.id = $1 AND s.id = $2")).toEqual([projectId, statusId]);
      expect(response.json()).toMatchObject({ id: projectId, version: 5, statuses: [{ id: statusId, wipLimit: 3 }] });
    });

    it("clears a WIP limit with null", async () => {
      const { calls } = await call({ method: "PATCH", url: statusUrl, payload: { wipLimit: null }, headers: ifMatch(4) }, [
        statusInProject,
        ["ws_update_status", () => [{ outcome: "ok", settings_version: 5 }]],
        ...detailHandlers(),
      ]);
      expect(paramsOf(calls, "ws_update_status")).toEqual([statusId, 4, null, null, true]);
    });

    it("is 404 for a column of another project, without calling the write", async () => {
      const { response, calls } = await call({ method: "PATCH", url: statusUrl, payload: { name: "X" }, headers: ifMatch(4) });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "status_not_found" });
      expect(called(calls, "ws_update_status")).toBe(false);
    });

    it.each([
      ["an empty patch", {}],
      ["a WIP limit of 0", { wipLimit: 0 }],
      ["a fractional WIP limit", { wipLimit: 2.5 }],
      ["a category", { category: "done" }],
    ])("rejects %s in the schema", async (_label, payload) => {
      const { response, calls } = await call({ method: "PATCH", url: statusUrl, payload, headers: ifMatch(4) }, [statusInProject]);
      expect(response.statusCode).toBe(400);
      expect(called(calls, "ws_update_status")).toBe(false);
    });

    it("refuses a WIP limit below the cards in the column with the count", async () => {
      const { response, calls } = await call({ method: "PATCH", url: statusUrl, payload: { wipLimit: 2 }, headers: ifMatch(4) }, [
        statusInProject,
        ["ws_update_status", () => [{ outcome: "wip_below_occupancy", settings_version: null }]],
        ["count(*) AS cards", () => [{ cards: "5" }]],
      ]);
      expect(response.statusCode).toBe(409);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.json()).toMatchObject({ code: "wip_below_occupancy", detail: "5 cards are in this column; the limit can't be below that." });
      const count = calls.find((c) => c.sql.includes("count(*) AS cards"));
      expect(count?.sql).toContain("archived_at IS NULL");
      expect(count?.params).toEqual([projectId, statusId]);
    });

    it("maps name_taken to 409", async () => {
      const { response } = await call({ method: "PATCH", url: statusUrl, payload: { name: "Done" }, headers: ifMatch(4) }, [
        statusInProject,
        ["ws_update_status", () => [{ outcome: "name_taken", settings_version: null }]],
      ]);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "name_taken" });
    });

    it("answers a stale column edit with 412 and the current project", async () => {
      const { response } = await call({ method: "PATCH", url: statusUrl, payload: { name: "X" }, headers: ifMatch(1) }, [
        statusInProject,
        ["ws_update_status", () => [{ outcome: "version_mismatch", settings_version: 5 }]],
        ...detailHandlers(),
      ]);
      expect(response.statusCode).toBe(412);
      expect(response.json()).toMatchObject({ code: "version_mismatch", current: { id: projectId, version: 5 } });
    });

    it.each(["Invalid status name", "Invalid WIP limit"])("reports the whitelisted error %s", async (message) => {
      const error = Object.assign(dbError("22023"), { message });
      const { response } = await call({ method: "PATCH", url: statusUrl, payload: { name: " " }, headers: ifMatch(4) }, [statusInProject, ["ws_update_status", () => error]]);
      expect(response.json()).toMatchObject({ code: "invalid_input", detail: `${message}.` });
    });
  });

  describe("methodology switch", () => {
    it("switches to Kanban with the ten parameters", async () => {
      const { response, calls } = await call({ method: "POST", url: methodologyUrl, payload: kanbanSwitch, headers: ifMatch(4) }, [
        ["ws_switch_methodology", () => [{ outcome: "ok", settings_version: 5, moved_issues: 3 }]],
        ...detailHandlers(),
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"v5"');
      expect(response.headers["cache-control"]).toBe("private, no-store");
      const params = paramsOf(calls, "ws_switch_methodology");
      expect(params).toHaveLength(10);
      expect(params.slice(0, 3)).toEqual([projectId, 4, "kanban"]);
      expect(JSON.parse(String(params[3]))).toEqual(kanbanSwitch.columns);
      expect(JSON.parse(String(params[4]))).toEqual(kanbanSwitch.mapping);
      expect(params.slice(5)).toEqual([null, null, null, null, "Steady flow of support work"]);
      expect(response.json()).toMatchObject({ project: { id: projectId, version: 5, methodology: "kanban" }, movedIssues: 3 });
    });

    it("passes the sprint length when switching to Scrum", async () => {
      const { calls } = await call({ method: "POST", url: methodologyUrl, payload: { ...kanbanSwitch, to: "scrum", sprintLengthDays: 21 }, headers: ifMatch(4) }, [
        ["ws_switch_methodology", () => [{ outcome: "ok", settings_version: 5, moved_issues: 0 }]],
        ...detailHandlers({ ...projectDetailRow, methodology: "scrum", sprint_length_days: 21 }),
      ]);
      expect(paramsOf(calls, "ws_switch_methodology").slice(5, 9)).toEqual([21, null, null, null]);
    });

    it("passes dates and the phase plan when switching to Waterfall", async () => {
      const payload = { ...kanbanSwitch, to: "waterfall", startDate: "2026-11-02", targetDate: "2026-11-30", phases: phasesBody.phases };
      const { calls } = await call({ method: "POST", url: methodologyUrl, payload, headers: ifMatch(4) }, [
        ["ws_switch_methodology", () => [{ outcome: "ok", settings_version: 5, moved_issues: 0 }]],
        ...detailHandlers({ ...projectDetailRow, methodology: "waterfall" }),
      ]);
      const params = paramsOf(calls, "ws_switch_methodology");
      expect(params.slice(5, 8)).toEqual([null, "2026-11-02", "2026-11-30"]);
      expect(JSON.parse(String(params[8]))).toEqual(phasesBody.phases);
    });

    it.each([
      ["a start date", { startDate: "2026-11-02" }],
      ["a target date", { targetDate: "2026-11-30" }],
      ["phases", { phases: phasesBody.phases }],
    ])("refuses %s unless switching to Waterfall, before calling the database", async (_label, extra) => {
      const { response, calls } = await call({ method: "POST", url: methodologyUrl, payload: { ...kanbanSwitch, ...extra }, headers: ifMatch(4) });
      expect(response.statusCode).toBe(400);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.json()).toMatchObject({ code: "invalid_input", detail: "Start date, target date and phases apply only when switching to Waterfall." });
      expect(called(calls, "ws_switch_methodology")).toBe(false);
    });

    it("refuses a sprint length unless switching to Scrum", async () => {
      const { response, calls } = await call({ method: "POST", url: methodologyUrl, payload: { ...kanbanSwitch, sprintLengthDays: 14 }, headers: ifMatch(4) });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_input", detail: "A sprint length applies only when switching to Scrum." });
      expect(called(calls, "ws_switch_methodology")).toBe(false);
    });

    it.each([
      ["an unknown methodology", { to: "lean" }],
      ["a mapping index that is not an integer", { mapping: { [doneId]: 0.5 } }],
      ["a mapping key that is not a status id", { mapping: { done: 1 } }],
      ["a column with an unknown key", { columns: [{ name: "Doing", category: "in_progress", color: "red" }, { name: "Done", category: "done" }] }],
      ["one column", { columns: [{ name: "Done", category: "done" }] }],
      ["no reason", { reason: undefined }],
    ])("rejects %s in the schema", async (_label, extra) => {
      const { response, calls } = await call({ method: "POST", url: methodologyUrl, payload: { ...kanbanSwitch, ...extra }, headers: ifMatch(4) });
      expect(response.statusCode).toBe(400);
      expect(called(calls, "ws_switch_methodology")).toBe(false);
    });

    it.each([
      ["active_sprint", "active_sprint", "Complete the active sprint before switching methodology."],
      ["same_methodology", "same_methodology", "The project already uses that methodology."],
      ["wip_below_occupancy", "wip_below_occupancy", "A column's WIP limit is below the cards it would hold."],
    ])("maps %s to 409", async (outcome, code, detail) => {
      const { response } = await call({ method: "POST", url: methodologyUrl, payload: kanbanSwitch, headers: ifMatch(4) }, [
        ["ws_switch_methodology", () => [{ outcome, settings_version: null, moved_issues: null }]],
      ]);
      expect(response.statusCode).toBe(409);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.json()).toMatchObject({ code, detail });
    });

    it("answers a stale switch with 412 and the current project", async () => {
      const { response } = await call({ method: "POST", url: methodologyUrl, payload: kanbanSwitch, headers: ifMatch(1) }, [
        ["ws_switch_methodology", () => [{ outcome: "version_mismatch", settings_version: 5, moved_issues: null }]],
        ...detailHandlers(),
      ]);
      expect(response.statusCode).toBe(412);
      expect(response.json()).toMatchObject({ code: "version_mismatch", current: { id: projectId, version: 5 } });
    });

    it.each(["Invalid status mapping", "Invalid project statuses", "Invalid switch reason", "Invalid sprint length"])(
      "reports the whitelisted error %s",
      async (message) => {
        const error = Object.assign(dbError("22023"), { message });
        const { response } = await call({ method: "POST", url: methodologyUrl, payload: kanbanSwitch, headers: ifMatch(4) }, [["ws_switch_methodology", () => error]]);
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ code: "invalid_input", detail: `${message}.` });
      },
    );
  });
});
