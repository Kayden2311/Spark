import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { requestHash } from "../src/modules/work/domain/idempotency.js";
import { dbError, fakePool, principalRow, type QueryHandler } from "./fake-pool.js";

const config = loadConfig({ NODE_ENV: "test" });
const cookie = `spark_session=${"b".repeat(64)}`;
const tenantId = "1d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const projectId = "3d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const issueId = "4d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const statusId = "5d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const reviewId = "6d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const assigneeId = "8d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const eventId = "9d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";

const projectRow = { id: projectId, tenant_id: tenantId, key: "WEB", name: "Website", methodology: "kanban" };

const issueRow = {
  id: issueId,
  number: "7",
  project_key: "WEB",
  title: "Fix login",
  type: "bug",
  priority: "high",
  status_id: statusId,
  assignee_user_id: assigneeId,
  assignee_display_name: "Lena",
  assignee_avatar_url: null,
  story_points: "2.50",
  due_date: "2026-11-02",
  phase_id: null,
  version: 3,
  completed_at: null,
  created_at: new Date("2026-10-19T08:00:00Z"),
  cursor_ts: "2026-10-19 08:00:00.123456+00",
  project_id: projectId,
  description: "Steps",
  reporter_user_id: principalRow.user_id,
  reporter_display_name: "Admin",
  started_at: null,
  updated_at: new Date("2026-10-19T09:00:00Z"),
  archived_at: null,
};

const statusRows = [
  { id: statusId, name: "To do", category: "todo", position: "1024.000000", wip_limit: null, issue_count: "3" },
  { id: reviewId, name: "Review", category: "in_progress", position: "2048.000000", wip_limit: 3, issue_count: "3" },
];

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

const detailHandler = (row: object = issueRow): [string, QueryHandler] => ["FROM spark.issues i", () => [row]];
const boardUrl = `/api/v1/projects/${projectId}/board`;
const listUrl = `/api/v1/projects/${projectId}/issues`;
const issueUrl = `/api/v1/issues/${issueId}`;
const eventsUrl = `/api/v1/issues/${issueId}/events`;

const ROUTES: Request[] = [
  { method: "GET", url: boardUrl },
  { method: "GET", url: listUrl },
  { method: "POST", url: listUrl, payload: { title: "A" } },
  { method: "GET", url: issueUrl },
  { method: "PATCH", url: issueUrl, payload: { title: "B" }, headers: { "if-match": '"v3"' } },
  { method: "GET", url: eventsUrl },
];

describe("issue routes", () => {
  it.each(ROUTES)("$method $url requires a session", async (route) => {
    const { response } = await call(route, [], false);
    expect(response.statusCode).toBe(401);
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  describe("board", () => {
    it("returns statuses with counts and caps the cards at 500", async () => {
      const rows = Array.from({ length: 501 }, (_, i) => ({ ...issueRow, id: `${String(i).padStart(8, "0")}-3b6c-4d7e-8f90-a1b2c3d4e5f6` }));
      const { response, calls } = await call({ method: "GET", url: boardUrl }, [
        ["FROM spark.projects p WHERE", () => [projectRow]],
        ["FROM spark.issue_statuses s", () => statusRows],
        ["FROM spark.issues i", () => rows],
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      const body = response.json();
      expect(body.project).toEqual({ id: projectId, key: "WEB", name: "Website", methodology: "kanban" });
      expect(body.statuses).toEqual([
        { id: statusId, name: "To do", category: "todo", position: 1024, wipLimit: null, count: 3 },
        { id: reviewId, name: "Review", category: "in_progress", position: 2048, wipLimit: 3, count: 3 },
      ]);
      expect(body.issues).toHaveLength(500);
      expect(body.truncated).toBe(true);
      expect(body.issues[0]).toEqual({
        id: rows[0]!.id,
        number: 7,
        key: "WEB-7",
        title: "Fix login",
        type: "bug",
        priority: "high",
        statusId,
        assignee: { id: assigneeId, displayName: "Lena", avatarUrl: null },
        storyPoints: 2.5,
        dueDate: "2026-11-02",
        phaseId: null,
        version: 3,
        completedAt: null,
        createdAt: "2026-10-19T08:00:00.000Z",
      });
      const cards = calls.find((c) => c.sql.includes("FROM spark.issues i") && !c.sql.includes("issue_statuses s WHERE"));
      expect(cards?.sql).toContain("LIMIT 501");
      expect(cards?.sql).toContain("archived_at IS NULL");
      expect(cards?.params).toEqual([tenantId, projectId]);
      for (const c of calls) expect(c.sql).not.toMatch(/u\.\*|a\.\*|SELECT \*/u);
    });

    it("is not truncated at 500 cards", async () => {
      const rows = Array.from({ length: 500 }, () => issueRow);
      const { response } = await call({ method: "GET", url: boardUrl }, [
        ["FROM spark.projects p WHERE", () => [projectRow]],
        ["FROM spark.issue_statuses s", () => statusRows],
        ["FROM spark.issues i", () => rows],
      ]);
      expect(response.json()).toMatchObject({ truncated: false });
      expect(response.json().issues).toHaveLength(500);
    });

    it("shows a former member as an assignee without a profile", async () => {
      const { response } = await call({ method: "GET", url: boardUrl }, [
        ["FROM spark.projects p WHERE", () => [projectRow]],
        ["FROM spark.issue_statuses s", () => statusRows],
        ["FROM spark.issues i", () => [{ ...issueRow, assignee_display_name: null }]],
      ]);
      expect(response.json().issues[0].assignee).toEqual({ id: assigneeId, displayName: "Former member", avatarUrl: null });
    });

    it("is 404 for a project the actor cannot see", async () => {
      const { response } = await call({ method: "GET", url: boardUrl });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "project_not_found" });
      expect(response.headers["cache-control"]).toBe("private, no-store");
    });
  });

  describe("list", () => {
    const listHandlers = (rows: object[]): Array<[string, QueryHandler]> => [
      ["FROM spark.projects p WHERE", () => [projectRow]],
      ["FROM spark.issues i", () => rows],
    ];

    it("binds the session user for assignee=me and pages newest first", async () => {
      const rows = [issueRow, { ...issueRow, id: eventId }];
      const { response, calls } = await call({ method: "GET", url: `${listUrl}?assignee=me&limit=1&q=Login` }, listHandlers(rows));
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({ id: issueId, key: "WEB-7" });
      expect(body.items[0]).not.toHaveProperty("cursorTs");
      expect(typeof body.nextCursor).toBe("string");
      const list = calls.find((c) => c.sql.includes("FROM spark.issues i"));
      expect(list?.params).toEqual([tenantId, projectId, principalRow.user_id, "Login"]);
      expect(list?.sql).toContain("ORDER BY i.created_at DESC, i.id DESC");
      expect(list?.sql).toContain("LIMIT 2");
      expect(list?.sql).toContain("i.archived_at IS NULL");
    });

    it("filters unassigned, archived issues of a status after a cursor", async () => {
      const first = await call({ method: "GET", url: `${listUrl}?limit=1` }, listHandlers([issueRow, issueRow]));
      const cursor = first.response.json().nextCursor as string;
      const { response, calls } = await call(
        { method: "GET", url: `${listUrl}?assignee=none&archived=true&status=${statusId}&cursor=${cursor}` },
        listHandlers([issueRow]),
      );
      expect(response.statusCode).toBe(200);
      expect(response.json().nextCursor).toBeNull();
      const list = calls.find((c) => c.sql.includes("FROM spark.issues i"));
      expect(list?.sql).toContain("i.assignee_user_id IS NULL");
      expect(list?.sql).toContain("i.archived_at IS NOT NULL");
      expect(list?.params).toEqual([tenantId, projectId, statusId, issueRow.cursor_ts, issueId]);
    });

    it.each([
      ["a long query", `q=${"x".repeat(101)}`],
      ["a bad assignee", "assignee=someone"],
      ["an unknown parameter", "sprint=1"],
      ["a limit above 100", "limit=101"],
    ])("rejects %s", async (_label, query) => {
      const { response } = await call({ method: "GET", url: `${listUrl}?${query}` }, listHandlers([]));
      expect(response.statusCode).toBe(400);
    });

    it("rejects a forged cursor", async () => {
      const { response } = await call({ method: "GET", url: `${listUrl}?cursor=abc` }, listHandlers([]));
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_cursor" });
    });

    it("is 404 for a project the actor cannot see", async () => {
      const { response } = await call({ method: "GET", url: listUrl });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "project_not_found" });
    });
  });

  describe("create", () => {
    const body = { title: "Fix login", type: "bug", storyPoints: 2.5, assigneeUserId: assigneeId };
    const create = (payload: unknown = body, headers: Record<string, string> = {}): Request => ({ method: "POST", url: listUrl, payload, headers });
    const created = (outcome: string, id: string | null = issueId): [string, QueryHandler] => [
      "ws_create_issue",
      () => [{ outcome, issue_id: id, issue_version: id ? 1 : null }],
    ];

    it("passes 12 parameters with the computed hash and a null key when the header is absent", async () => {
      const { response, calls } = await call(create(), [created("ok"), detailHandler({ ...issueRow, version: 1 })]);
      expect(response.statusCode).toBe(201);
      expect(response.headers.location).toBe(`/api/v1/issues/${issueId}`);
      expect(response.headers.etag).toBe('"v1"');
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers["idempotent-replayed"]).toBeUndefined();
      const params = calls.find((c) => c.sql.includes("ws_create_issue"))?.params ?? [];
      expect(params).toHaveLength(12);
      expect(params.slice(0, 11)).toEqual([projectId, "Fix login", null, "bug", null, null, assigneeId, 2.5, null, null, null]);
      expect(Buffer.isBuffer(params[11])).toBe(true);
      expect((params[11] as Buffer).equals(requestHash(body))).toBe(true);
      expect(response.json()).toMatchObject({
        id: issueId,
        key: "WEB-7",
        projectId,
        description: "Steps",
        reporter: { id: principalRow.user_id, displayName: "Admin" },
        startedAt: null,
        updatedAt: "2026-10-19T09:00:00.000Z",
        archivedAt: null,
        version: 1,
      });
    });

    it("passes the Idempotency-Key and hashes the body independent of key order", async () => {
      const reordered = { assigneeUserId: assigneeId, storyPoints: 2.5, type: "bug", title: "Fix login" };
      const { calls } = await call(create(reordered, { "idempotency-key": "retry-1:2026.10" }), [created("ok"), detailHandler()]);
      const params = calls.find((c) => c.sql.includes("ws_create_issue"))?.params ?? [];
      expect(params[10]).toBe("retry-1:2026.10");
      expect((params[11] as Buffer).equals(requestHash(body))).toBe(true);
    });

    it("replays the first result with Idempotent-Replayed", async () => {
      const { response } = await call(create(body, { "idempotency-key": "k1" }), [created("replayed"), detailHandler()]);
      expect(response.statusCode).toBe(201);
      expect(response.headers["idempotent-replayed"]).toBe("true");
      expect(response.headers.location).toBe(`/api/v1/issues/${issueId}`);
      expect(response.headers.etag).toBe('"v3"');
      expect(response.json()).toMatchObject({ id: issueId });
    });

    it("rejects a malformed Idempotency-Key before calling the database", async () => {
      const { response, calls } = await call(create(body, { "idempotency-key": "has space" }));
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_input", detail: "Invalid idempotency key." });
      expect(calls.some((c) => c.sql.includes("ws_create_issue"))).toBe(false);
    });

    it.each([
      ["idempotency_conflict", 409, "idempotency_key_reused"],
      ["too_many_issues", 409, "too_many_issues"],
      ["no_board", 409, "project_has_no_board"],
      ["invalid_assignee", 422, "invalid_assignee"],
      ["not_found", 404, "project_not_found"],
    ])("maps create outcome %s", async (outcome, status, code) => {
      const { response } = await call(create(), [created(outcome, null)]);
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
      expect(response.headers["cache-control"]).toBe("private, no-store");
    });

    it("names the full column on wip_limit_reached", async () => {
      const { response, calls } = await call(create({ title: "A", statusId: reviewId }), [
        created("wip_limit_reached", null),
        ["FROM spark.projects p JOIN spark.issue_statuses s", () => [{ name: "Review", wip_limit: 3 }]],
      ]);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "wip_limit_reached", detail: "Review is at its WIP limit (3)." });
      expect(calls.find((c) => c.sql.includes("FROM spark.projects p JOIN spark.issue_statuses s"))?.params).toEqual([projectId, reviewId]);
    });

    it("fails closed on an unknown outcome", async () => {
      const { response } = await call(create(), [created("weird", null)]);
      expect(response.statusCode).toBe(500);
    });

    it.each([
      ["a missing title", { type: "bug" }],
      ["an unknown key", { title: "A", sprintId: issueId }],
      ["an epic", { title: "A", type: "epic" }],
      ["a calendar-invalid date", { title: "A", dueDate: "2026-02-30" }],
      ["a non-uuid status", { title: "A", statusId: "todo" }],
      ["too many points", { title: "A", storyPoints: 101 }],
      ["an overlong description", { title: "A", description: "x".repeat(10001) }],
    ])("rejects %s in the schema", async (_label, payload) => {
      const { response, calls } = await call(create(payload));
      expect(response.statusCode).toBe(400);
      expect(calls.some((c) => c.sql.includes("ws_create_issue"))).toBe(false);
    });

    it("reports a whitelisted database input error", async () => {
      const error = Object.assign(dbError("22023"), { message: "Invalid issue title" });
      const { response } = await call(create({ title: "   " }), [["ws_create_issue", () => error]]);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_input", detail: "Invalid issue title." });
    });

    it("rejects a cross-origin create", async () => {
      const { response } = await call(create(body, { origin: "https://evil.example" }));
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "origin_not_allowed" });
      expect(response.headers["cache-control"]).toBe("private, no-store");
    });
  });

  describe("get", () => {
    it("returns the issue with an ETag", async () => {
      const { response, calls } = await call({ method: "GET", url: issueUrl }, [detailHandler()]);
      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"v3"');
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.json()).toMatchObject({ id: issueId, key: "WEB-7", storyPoints: 2.5, reporter: { displayName: "Admin" } });
      const read = calls.find((c) => c.sql.includes("FROM spark.issues i"));
      expect(read?.sql).toContain("session_workspace_ids");
      expect(read?.sql).not.toMatch(/u\.\*|SELECT \*/u);
    });

    it("is 404 issue_not_found for a non-member", async () => {
      const { response } = await call({ method: "GET", url: issueUrl });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "issue_not_found" });
      expect(response.headers["cache-control"]).toBe("private, no-store");
    });

    it("rejects a malformed id", async () => {
      const { response } = await call({ method: "GET", url: "/api/v1/issues/nope" });
      expect(response.statusCode).toBe(400);
    });
  });

  describe("PATCH", () => {
    const patch = (payload: unknown, headers: Record<string, string> = { "if-match": '"v3"' }): Request => ({ method: "PATCH", url: issueUrl, payload, headers });
    const updated = (outcome: string, version: number | null = 4): [string, QueryHandler] => ["ws_update_issue", () => [{ outcome, issue_version: version }]];

    it("requires If-Match", async () => {
      const { response } = await call(patch({ title: "B" }, {}));
      expect(response.statusCode).toBe(428);
      expect(response.json()).toMatchObject({ code: "precondition_required" });
    });

    it("rejects a malformed If-Match", async () => {
      const { response } = await call(patch({ title: "B" }, { "if-match": 'W/"v3"' }));
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_if_match" });
    });

    it.each([
      ["an unknown key", { sprintId: issueId }],
      ["an empty patch", {}],
      ["a non-boolean archived", { archived: "yes" }],
      ["a non-uuid anchor", { afterIssueId: "top" }],
    ])("rejects %s in the schema", async (_label, payload) => {
      const { response, calls } = await call(patch(payload));
      expect(response.statusCode).toBe(400);
      expect(calls.some((c) => c.sql.includes("ws_update_issue"))).toBe(false);
    });

    it("moves the issue and returns the new ETag", async () => {
      const body = { statusId: reviewId, afterIssueId: null, assigneeUserId: null };
      const { response, calls } = await call(patch(body), [updated("ok"), detailHandler({ ...issueRow, status_id: reviewId, version: 4 })]);
      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"v4"');
      expect(response.json()).toMatchObject({ statusId: reviewId, version: 4 });
      const params = calls.find((c) => c.sql.includes("ws_update_issue"))?.params ?? [];
      expect(params.slice(0, 2)).toEqual([issueId, 3]);
      expect(JSON.parse(String(params[2]))).toEqual(body);
    });

    it("answers 412 with the current issue on a stale version", async () => {
      const { response } = await call(patch({ title: "B" }, { "if-match": '"v1"' }), [updated("version_mismatch", 3), detailHandler()]);
      expect(response.statusCode).toBe(412);
      expect(response.json()).toMatchObject({ code: "version_mismatch", current: { id: issueId, version: 3, key: "WEB-7" } });
    });

    it("names the full column on wip_limit_reached", async () => {
      const { response, calls } = await call(patch({ statusId: reviewId }), [
        updated("wip_limit_reached", null),
        ["JOIN spark.issue_statuses s", () => [{ name: "Review", wip_limit: 3 }]],
      ]);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "wip_limit_reached", detail: "Review is at its WIP limit (3)." });
      expect(calls.find((c) => c.sql.includes("JOIN spark.issue_statuses s"))?.params).toEqual([issueId, reviewId]);
    });

    it("uses the issue's own status when a restore hits the WIP limit", async () => {
      const { response, calls } = await call(patch({ archived: false }), [
        updated("wip_limit_reached", null),
        ["JOIN spark.issue_statuses s", () => [{ name: "In progress", wip_limit: 4 }]],
      ]);
      expect(response.json()).toMatchObject({ detail: "In progress is at its WIP limit (4)." });
      expect(calls.find((c) => c.sql.includes("JOIN spark.issue_statuses s"))?.params).toEqual([issueId, null]);
    });

    it("maps the WIP trigger race fallback (23514) to 409", async () => {
      const error = Object.assign(dbError("23514"), { message: "Status WIP limit reached" });
      const { response } = await call(patch({ statusId: reviewId }), [["ws_update_issue", () => error]]);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "wip_limit_reached" });
      expect(response.headers["cache-control"]).toBe("private, no-store");
    });

    it("keeps other 23514 errors as 500", async () => {
      const error = Object.assign(dbError("23514"), { message: "Issue version must advance by exactly one" });
      const { response } = await call(patch({ statusId: reviewId }), [["ws_update_issue", () => error]]);
      expect(response.statusCode).toBe(500);
    });

    it.each([
      ["not_found", 404, "issue_not_found"],
      ["invalid_assignee", 422, "invalid_assignee"],
    ])("maps %s", async (outcome, status, code) => {
      const { response } = await call(patch({ assigneeUserId: assigneeId }), [updated(outcome, null)]);
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
    });

    it("fails closed on an unknown outcome", async () => {
      const { response } = await call(patch({ title: "B" }), [updated("weird", null)]);
      expect(response.statusCode).toBe(500);
    });

    it("reports a whitelisted database input error", async () => {
      const error = Object.assign(dbError("22023"), { message: "Invalid issue position" });
      const { response } = await call(patch({ afterIssueId: eventId }), [["ws_update_issue", () => error]]);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_input", detail: "Invalid issue position." });
    });

    it("rejects a cross-origin update", async () => {
      const { response } = await call(patch({ title: "B" }, { "if-match": '"v3"', origin: "https://evil.example" }));
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "origin_not_allowed" });
    });
  });

  describe("events", () => {
    const eventRow = {
      id: eventId,
      event_type: "issue.updated",
      actor_user_id: principalRow.user_id,
      actor_display_name: "Admin",
      from_version: 2,
      to_version: 3,
      changes: { fields: ["statusId"], after: { statusId: reviewId, archived: false } },
      created_at: new Date("2026-10-19T09:00:00Z"),
      cursor_ts: "2026-10-19 09:00:00.5+00",
    };

    it("lists history newest first", async () => {
      const { response, calls } = await call({ method: "GET", url: `${eventsUrl}?limit=10` }, [
        ["FROM spark.issues i", () => [{ id: issueId, tenant_id: tenantId, project_id: projectId }]],
        ["FROM spark.issue_events e", () => [eventRow, { ...eventRow, actor_user_id: null, actor_display_name: null }]],
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        items: [
          {
            id: eventId,
            type: "issue.updated",
            actor: { id: principalRow.user_id, displayName: "Admin" },
            fromVersion: 2,
            toVersion: 3,
            changes: eventRow.changes,
            createdAt: "2026-10-19T09:00:00.000Z",
          },
          { id: eventId, type: "issue.updated", actor: null, fromVersion: 2, toVersion: 3, changes: eventRow.changes, createdAt: "2026-10-19T09:00:00.000Z" },
        ],
        nextCursor: null,
      });
      const list = calls.find((c) => c.sql.includes("FROM spark.issue_events e"));
      expect(list?.params).toEqual([tenantId, projectId, issueId]);
      expect(list?.sql).toContain("ORDER BY e.created_at DESC, e.id DESC");
      expect(list?.sql).toContain("LIMIT 11");
    });

    it("is 404 issue_not_found for a non-member", async () => {
      const { response } = await call({ method: "GET", url: eventsUrl });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "issue_not_found" });
    });
  });
});
