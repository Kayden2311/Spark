import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { getMethodology } from "../src/modules/work/domain/methodology.js";
import { dbError, fakePool, principalRow, type QueryHandler } from "./fake-pool.js";

const config = loadConfig({ NODE_ENV: "test" });
const cookie = `spark_session=${"b".repeat(64)}`;
const wsId = "1d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const projectId = "3d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const leadId = "4d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const phaseId = "5d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";

const workspaceRow = {
  id: wsId,
  slug: "acme",
  name: "Acme",
  version: 3,
  created_at: new Date("2026-01-01T00:00:00Z"),
  role: "owner",
  member_count: "2",
};

// A project created before M2: backfilled to Kanban, no board, no statuses, no issues.
const legacyProjectRow = {
  id: projectId,
  key: "WEB",
  name: "Website",
  description: null,
  methodology: "kanban",
  start_date: null,
  target_date: null,
  sprint_length_days: null,
  baselined_at: null,
  settings_version: 1,
  created_at: new Date("2026-01-03T00:00:00Z"),
  lead_id: null,
  lead_display_name: null,
  issue_total: "0",
  issue_done: "0",
};

const waterfallRow = {
  ...legacyProjectRow,
  key: "LAUNCH",
  name: "Launch",
  methodology: "waterfall",
  start_date: "2026-11-02",
  target_date: "2026-11-11",
  baselined_at: new Date("2026-10-18T09:00:00Z"),
  settings_version: 4,
  lead_id: leadId,
  lead_display_name: "Lena",
  issue_total: "5",
  issue_done: "2",
};

const statusRow = { id: "6d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6", name: "Done", category: "done", position: "5120.000000", wip_limit: null };
const phaseRow = {
  id: phaseId,
  name: "Requirements",
  position: 1,
  planned_start: "2026-11-02",
  planned_end: "2026-11-03",
  baseline_start: "2026-11-02",
  baseline_end: "2026-11-03",
  status: "planned",
};
const milestoneRow = {
  id: "7d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6",
  name: "Requirements sign-off",
  phase_id: phaseId,
  due_date: "2026-11-03",
  baseline_due_date: "2026-11-03",
  completed_at: null,
};

type Request = { method: "GET" | "POST" | "PATCH"; url: string; payload?: unknown; headers?: Record<string, string> };

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

const detailHandlers = (row: object = legacyProjectRow): Array<[string, QueryHandler]> => [
  ["FROM spark.projects p", () => [row]],
  ["FROM spark.issue_statuses s", () => [statusRow]],
  ["FROM spark.project_phases ph", () => [phaseRow]],
  ["FROM spark.project_milestones ms", () => [milestoneRow]],
];

const createUrl = `/api/v1/workspaces/${wsId}/projects`;
const kanbanBody = { key: "WEB", name: "Website", methodology: "kanban" };
const createCall = (sql: string) => sql.includes("ws_create_project");

const ROUTES: Request[] = [
  { method: "POST", url: createUrl, payload: kanbanBody },
  { method: "GET", url: createUrl },
  { method: "GET", url: `/api/v1/workspaces/${wsId}/projects/by-key/WEB` },
  { method: "GET", url: `/api/v1/projects/${projectId}` },
  { method: "PATCH", url: `/api/v1/projects/${projectId}`, payload: { name: "New" }, headers: { "if-match": '"v1"' } },
];

describe("project routes", () => {
  it.each(ROUTES)("$method $url requires a session", async (route) => {
    const { response } = await call(route, [], false);
    expect(response.statusCode).toBe(401);
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  describe("create", () => {
    it("fills Kanban template statuses and sends the 11 parameters", async () => {
      const { response, calls } = await call({ method: "POST", url: createUrl, payload: kanbanBody }, [
        ["ws_create_project", () => [{ outcome: "ok", project_id: projectId, settings_version: 1 }]],
        ...detailHandlers(),
      ]);
      expect(response.statusCode).toBe(201);
      expect(response.headers.location).toBe(`/api/v1/projects/${projectId}`);
      expect(response.headers.etag).toBe('"v1"');
      expect(response.headers["cache-control"]).toBe("private, no-store");
      const params = calls.find((c) => createCall(c.sql))?.params ?? [];
      expect(params).toHaveLength(11);
      expect(params.slice(0, 9)).toEqual([wsId, "WEB", "Website", null, "kanban", null, null, null, null]);
      expect(JSON.parse(String(params[9]))).toEqual(getMethodology("kanban").statuses);
      expect(JSON.parse(String(params[10]))).toEqual([]);
      expect(response.json()).toMatchObject({ id: projectId, key: "WEB", methodology: "kanban", version: 1, statuses: [{ name: "Done", position: 5120 }] });
    });

    it("defaults the Scrum sprint length to 14", async () => {
      const { calls } = await call({ method: "POST", url: createUrl, payload: { ...kanbanBody, methodology: "scrum" } }, [
        ["ws_create_project", () => [{ outcome: "ok", project_id: projectId, settings_version: 1 }]],
        ...detailHandlers(),
      ]);
      const params = calls.find((c) => createCall(c.sql))?.params ?? [];
      expect(params[8]).toBe(14);
      expect(JSON.parse(String(params[9]))).toEqual(getMethodology("scrum").statuses);
    });

    it("passes caller statuses and the lead through unchanged", async () => {
      const statuses = [
        { name: "Open", category: "todo", wipLimit: null },
        { name: "Closed", category: "done", wipLimit: null },
      ];
      const { calls } = await call(
        { method: "POST", url: createUrl, payload: { ...kanbanBody, description: "Site", leadUserId: leadId, statuses } },
        [["ws_create_project", () => [{ outcome: "ok", project_id: projectId, settings_version: 1 }]], ...detailHandlers()],
      );
      const params = calls.find((c) => createCall(c.sql))?.params ?? [];
      expect(params[3]).toBe("Site");
      expect(params[5]).toBe(leadId);
      expect(JSON.parse(String(params[9]))).toEqual(statuses);
    });

    it("spreads the default Waterfall phases over the project dates", async () => {
      const payload = { key: "LAUNCH", name: "Launch", methodology: "waterfall", startDate: "2026-11-02", targetDate: "2026-11-11" };
      const { response, calls } = await call({ method: "POST", url: createUrl, payload }, [
        ["ws_create_project", () => [{ outcome: "ok", project_id: projectId, settings_version: 1 }]],
        ...detailHandlers(waterfallRow),
      ]);
      expect(response.statusCode).toBe(201);
      const params = calls.find((c) => createCall(c.sql))?.params ?? [];
      expect(params.slice(6, 9)).toEqual(["2026-11-02", "2026-11-11", null]);
      expect(JSON.parse(String(params[10]))).toEqual([
        { name: "Requirements", plannedStart: "2026-11-02", plannedEnd: "2026-11-03" },
        { name: "Design", plannedStart: "2026-11-04", plannedEnd: "2026-11-05" },
        { name: "Build", plannedStart: "2026-11-06", plannedEnd: "2026-11-07" },
        { name: "Test", plannedStart: "2026-11-08", plannedEnd: "2026-11-09" },
        { name: "Deploy", plannedStart: "2026-11-10", plannedEnd: "2026-11-11" },
      ]);
      expect(response.json()).toMatchObject({
        methodology: "waterfall",
        startDate: "2026-11-02",
        baselinedAt: "2026-10-18T09:00:00.000Z",
        lead: { id: leadId, displayName: "Lena" },
        progress: { total: 5, done: 2, open: 3 },
        phases: [{ id: phaseId, position: 1, plannedStart: "2026-11-02", baselineEnd: "2026-11-03", status: "planned" }],
        milestones: [{ phaseId, dueDate: "2026-11-03", completedAt: null }],
      });
    });

    it.each([
      ["a 3-day range for 5 phases", { startDate: "2026-11-02", targetDate: "2026-11-04" }],
      ["a target before the start", { startDate: "2026-11-10", targetDate: "2026-11-02" }],
      ["missing dates", {}],
    ])("rejects Waterfall with %s before calling the database", async (_label, dates) => {
      const { response, calls } = await call({ method: "POST", url: createUrl, payload: { key: "LAUNCH", name: "Launch", methodology: "waterfall", ...dates } });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_input", detail: "Invalid project dates." });
      expect(calls.some((c) => createCall(c.sql))).toBe(false);
    });

    it.each([
      ["calendar-invalid date", { ...kanbanBody, startDate: "2026-02-30" }],
      ["lowercase key", { ...kanbanBody, key: "web" }],
      ["unknown methodology", { ...kanbanBody, methodology: "lean" }],
      ["one status", { ...kanbanBody, statuses: [{ name: "Done", category: "done", wipLimit: null }] }],
      ["unknown key", { ...kanbanBody, color: "red" }],
    ])("rejects a body with %s in the schema", async (_label, payload) => {
      const { response, calls } = await call({ method: "POST", url: createUrl, payload });
      expect(response.statusCode).toBe(400);
      expect(calls.some((c) => createCall(c.sql))).toBe(false);
    });

    it.each([
      ["key_taken", 409, "key_taken"],
      ["too_many_projects", 409, "too_many_projects"],
      ["invalid_lead", 422, "invalid_lead"],
      ["forbidden", 403, "insufficient_role"],
      ["not_found", 404, "workspace_not_found"],
    ])("maps create outcome %s", async (outcome, status, code) => {
      const { response } = await call({ method: "POST", url: createUrl, payload: kanbanBody }, [
        ["ws_create_project", () => [{ outcome, project_id: null, settings_version: null }]],
      ]);
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
    });

    it("fails closed on an unknown outcome", async () => {
      const { response } = await call({ method: "POST", url: createUrl, payload: kanbanBody }, [
        ["ws_create_project", () => [{ outcome: "weird", project_id: null, settings_version: null }]],
      ]);
      expect(response.statusCode).toBe(500);
    });

    it("reports a whitelisted database input error", async () => {
      const error = Object.assign(dbError("22023"), { message: "Invalid project statuses" });
      const { response } = await call({ method: "POST", url: createUrl, payload: kanbanBody }, [["ws_create_project", () => error]]);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_input", detail: "Invalid project statuses." });
    });

    it("rejects a cross-origin create", async () => {
      const { response } = await call({ method: "POST", url: createUrl, payload: kanbanBody, headers: { origin: "https://evil.example" } });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "origin_not_allowed" });
    });
  });

  describe("reads", () => {
    it("lists a backfilled pre-M2 project as Kanban with empty progress", async () => {
      const { response, calls } = await call({ method: "GET", url: createUrl }, [
        ["FROM spark.workspaces w", () => [workspaceRow]],
        ["FROM spark.projects p", () => [legacyProjectRow]],
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.json().items).toEqual([
        {
          id: projectId,
          key: "WEB",
          name: "Website",
          description: null,
          methodology: "kanban",
          lead: null,
          startDate: null,
          targetDate: null,
          sprintLengthDays: null,
          baselinedAt: null,
          version: 1,
          createdAt: "2026-01-03T00:00:00.000Z",
          progress: { total: 0, done: 0, open: 0 },
        },
      ]);
      const list = calls.find((c) => c.sql.includes("FROM spark.projects p"));
      expect(list?.sql).toContain("archived_at IS NULL");
      expect(list?.sql).not.toMatch(/u\.\*|SELECT \*/u);
      expect(list?.params).toEqual([wsId]);
    });

    it("is 404 when listing a workspace the actor is not in", async () => {
      const { response } = await call({ method: "GET", url: createUrl });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "workspace_not_found" });
    });

    it("opens a pre-M2 project without statuses", async () => {
      const { response } = await call({ method: "GET", url: `/api/v1/projects/${projectId}` }, [["FROM spark.projects p", () => [legacyProjectRow]]]);
      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"v1"');
      expect(response.json()).toMatchObject({ methodology: "kanban", statuses: [], phases: [], milestones: [] });
    });

    it("finds a project by key with an ETag", async () => {
      const { response, calls } = await call({ method: "GET", url: `/api/v1/workspaces/${wsId}/projects/by-key/LAUNCH` }, detailHandlers(waterfallRow));
      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"v4"');
      expect(response.json()).toMatchObject({ key: "LAUNCH", statuses: [{ category: "done", wipLimit: null }] });
      expect(calls.find((c) => c.sql.includes("FROM spark.projects p"))?.params).toEqual([wsId, "LAUNCH"]);
    });

    it.each([`/api/v1/workspaces/${wsId}/projects/by-key/WEB`, `/api/v1/projects/${projectId}`])("GET %s is 404 for a non-member", async (url) => {
      const { response } = await call({ method: "GET", url });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "project_not_found" });
    });

    it("rejects a malformed key in the path", async () => {
      const { response } = await call({ method: "GET", url: `/api/v1/workspaces/${wsId}/projects/by-key/web` });
      expect(response.statusCode).toBe(400);
    });
  });

  describe("PATCH", () => {
    const url = `/api/v1/projects/${projectId}`;
    const patch = (payload: unknown, headers: Record<string, string> = { "if-match": '"v4"' }): Request => ({ method: "PATCH", url, payload, headers });

    it("requires If-Match", async () => {
      const { response } = await call(patch({ name: "New" }, {}));
      expect(response.statusCode).toBe(428);
      expect(response.json()).toMatchObject({ code: "precondition_required" });
    });

    it("rejects a malformed If-Match", async () => {
      const { response } = await call(patch({ name: "New" }, { "if-match": "*" }));
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_if_match" });
    });

    it.each([
      ["methodology", { methodology: "scrum" }],
      ["an unknown key", { color: "red" }],
      ["an empty patch", {}],
      ["a calendar-invalid date", { targetDate: "2026-13-01" }],
    ])("rejects %s in the schema", async (_label, payload) => {
      const { response, calls } = await call(patch(payload));
      expect(response.statusCode).toBe(400);
      expect(calls.some((c) => c.sql.includes("ws_update_project"))).toBe(false);
    });

    it("updates and returns the new ETag", async () => {
      const body = { name: "Launch v2", description: null, leadUserId: null, targetDate: "2026-11-20" };
      const { response, calls } = await call(patch(body), [
        ["ws_update_project", () => [{ outcome: "ok", settings_version: 5 }]],
        ...detailHandlers({ ...waterfallRow, name: "Launch v2", settings_version: 5 }),
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"v5"');
      expect(response.json()).toMatchObject({ name: "Launch v2", version: 5 });
      const params = calls.find((c) => c.sql.includes("ws_update_project"))?.params ?? [];
      expect(params.slice(0, 2)).toEqual([projectId, 4]);
      expect(JSON.parse(String(params[2]))).toEqual(body);
    });

    it("answers 412 with the current project on a stale version", async () => {
      const { response } = await call(patch({ name: "New" }, { "if-match": '"v1"' }), [
        ["ws_update_project", () => [{ outcome: "version_mismatch", settings_version: 4 }]],
        ...detailHandlers(waterfallRow),
      ]);
      expect(response.statusCode).toBe(412);
      expect(response.json()).toMatchObject({ code: "version_mismatch", current: { id: projectId, version: 4, phases: [{ id: phaseId }] } });
    });

    it.each([
      ["forbidden", 403, "insufficient_role"],
      ["not_found", 404, "project_not_found"],
      ["invalid_lead", 422, "invalid_lead"],
    ])("maps %s", async (outcome, status, code) => {
      const { response } = await call(patch({ name: "New" }), [["ws_update_project", () => [{ outcome, settings_version: null }]]]);
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
    });

    it("fails closed on an unknown outcome", async () => {
      const { response } = await call(patch({ name: "New" }), [["ws_update_project", () => [{ outcome: "weird", settings_version: null }]]]);
      expect(response.statusCode).toBe(500);
    });

    it("rejects a cross-origin update", async () => {
      const { response } = await call(patch({ name: "New" }, { "if-match": '"v4"', origin: "https://evil.example" }));
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "origin_not_allowed" });
    });
  });
});
