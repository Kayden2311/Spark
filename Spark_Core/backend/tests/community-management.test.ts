import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { dbError, fakePool, principalRow, type QueryHandler } from "./fake-pool.js";

const config = loadConfig({ NODE_ENV: "test" });
const cookie = `spark_session=${"e".repeat(64)}`;
const wsId = "1d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const communityId = "11111111-1111-4111-8111-111111111111";
const userId = "44444444-4444-4444-8444-444444444444";
const selfId = principalRow.user_id;

type Calls = Array<{ sql: string; params: unknown[] }>;
type Method = "GET" | "POST" | "PATCH" | "DELETE";
interface Call { method: Method; url: string; payload?: unknown; headers?: Record<string, string>; session?: "none" | "valid" | "expired" }

async function send(req: Call, handlers: Array<[string, QueryHandler]> = []) {
  const session = req.session ?? "valid";
  const { pool, calls } = fakePool([["auth_session_principal", session === "valid" ? () => [principalRow] : () => []], ...handlers]);
  const app = await buildApp({ config, pool, rateLimit: false, logger: false });
  try {
    const headers: Record<string, string> = { ...(session === "none" ? {} : { cookie }), ...req.headers };
    const response = await app.inject({ method: req.method, url: req.url, headers, ...(req.payload === undefined ? {} : { payload: req.payload as object }) });
    return { response, calls };
  } finally {
    await app.close();
  }
}

const called = (calls: Calls, fragment: string) => calls.some((c) => c.sql.includes(fragment));
const find = (calls: Calls, fragment: string) => calls.find((c) => c.sql.includes(fragment));
const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

const cardRow = (over: object = {}) => ({
  id: communityId,
  slug: "night-owls",
  name: "Night Owls",
  tagline: "Late builders",
  visibility: "private",
  country_code: "DE",
  city: null,
  stage: "seed",
  topics: ["founders"],
  member_count: "1",
  weekly_posts: "0",
  featured: false,
  frozen: false,
  host_workspace_name: "Acme",
  viewer_status: "owner",
  ...over,
});
const detailRow = (over: object = {}) => ({
  ...cardRow(),
  description: "A place for night owls",
  created_at: new Date("2026-11-01T10:00:00Z"),
  settings_version: 1,
  can_manage: true,
  host_admin: false,
  ...over,
});
const detailHandler = (over: object = {}): [string, QueryHandler] => ["spark.community_by_slug", () => [detailRow(over)]];

const createBody = {
  slug: "night-owls",
  name: "Night Owls",
  tagline: "Late builders",
  description: "A place for night owls",
  visibility: "private",
  countryCode: "DE",
  city: null,
  stage: "seed",
  topics: ["founders"],
};

const routes: Call[] = [
  { method: "POST", url: `/api/v1/workspaces/${wsId}/communities`, payload: createBody },
  { method: "GET", url: `/api/v1/workspaces/${wsId}/communities` },
  { method: "PATCH", url: `/api/v1/communities/${communityId}`, payload: { name: "X" }, headers: { "if-match": "\"v1\"" } },
  { method: "GET", url: `/api/v1/communities/${communityId}/requests` },
  { method: "GET", url: `/api/v1/communities/${communityId}/members` },
  { method: "GET", url: `/api/v1/communities/${communityId}/member-candidates` },
  { method: "POST", url: `/api/v1/communities/${communityId}/members`, payload: { userId } },
  { method: "PATCH", url: `/api/v1/communities/${communityId}/members/${userId}`, payload: { role: "moderator" } },
  { method: "DELETE", url: `/api/v1/communities/${communityId}/members/${userId}` },
];

describe("management routes need a session", () => {
  it.each(routes)("$method $url answers 401 unauthenticated without a cookie", async (route) => {
    const { response, calls } = await send({ ...route, session: "none" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "unauthenticated" });
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(called(calls, "spark.ws_")).toBe(false);
  });

  it.each(routes)("$method $url answers 401 session_expired for an invalid session", async (route) => {
    const { response } = await send({ ...route, session: "expired" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "session_expired" });
  });

  it("rejects a cross-origin create", async () => {
    const { response, calls } = await send({ method: "POST", url: `/api/v1/workspaces/${wsId}/communities`, payload: createBody, headers: { origin: "https://evil.example" } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "origin_not_allowed" });
    expect(calls).toHaveLength(0);
  });
});

describe("POST /workspaces/{id}/communities", () => {
  const url = `/api/v1/workspaces/${wsId}/communities`;
  const create = (outcome: string, id: string | null = null): [string, QueryHandler] => ["spark.ws_create_community", () => [{ outcome, community_id: id }]];

  it("creates with 201, Location and ETag", async () => {
    const { response, calls } = await send({ method: "POST", url, payload: createBody }, [create("ok", communityId), detailHandler()]);
    expect(response.statusCode).toBe(201);
    expect(response.headers.location).toBe("/api/v1/communities/night-owls");
    expect(response.headers.etag).toBe("\"v1\"");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toMatchObject({ id: communityId, slug: "night-owls", canManage: true, canGovern: true, version: 1, description: "A place for night owls" });
    expect(find(calls, "spark.ws_create_community")?.params).toEqual([wsId, "night-owls", "Night Owls", "Late builders", "A place for night owls", "private", "DE", null, "seed", ["founders"]]);
  });

  it.each([
    ["slug_taken", 409, "slug_taken"],
    ["too_many_communities", 409, "too_many_communities"],
    ["forbidden", 403, "insufficient_role"],
    ["not_found", 404, "workspace_not_found"],
  ])("maps %s to %i", async (outcome, status, code) => {
    const { response } = await send({ method: "POST", url, payload: createBody }, [create(outcome)]);
    expect(response.statusCode).toBe(status);
    expect(response.json().code).toBe(code);
  });

  it("answers 500 for an unknown outcome", async () => {
    const { response } = await send({ method: "POST", url, payload: createBody }, [create("surprise")]);
    expect(response.statusCode).toBe(500);
  });

  it("reserves the slug the filters route shadows", async () => {
    const { response, calls } = await send({ method: "POST", url, payload: { ...createBody, slug: "filters" } }, [create("ok", communityId)]);
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("slug_taken");
    expect(called(calls, "spark.ws_create_community")).toBe(false);
  });

  it.each([
    [{ ...createBody, extra: true }],
    [{ ...createBody, slug: "Bad Slug" }],
    [{ ...createBody, visibility: "secret" }],
    [{ ...createBody, stage: "late" }],
    [{ ...createBody, topics: [] }],
    [{ ...createBody, topics: ["founders", "product", "fintech", "ai-data", "b2b-saas"] }],
    [{ ...createBody, topics: ["crypto"] }],
    [{ ...createBody, countryCode: "de" }],
    [{ ...createBody, name: "x".repeat(81) }],
    [Object.fromEntries(Object.entries(createBody).filter(([key]) => key !== "tagline"))],
  ])("rejects an invalid body with 400 bad_request (%#)", async (payload) => {
    const { response, calls } = await send({ method: "POST", url, payload });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("bad_request");
    expect(called(calls, "spark.ws_create_community")).toBe(false);
  });

  it.each(["Invalid community name", "Invalid community topics", "Invalid community location"])("maps 22023 %s to invalid_input", async (message) => {
    const { response } = await send({ method: "POST", url, payload: createBody }, [["spark.ws_create_community", () => pgError("22023", message)]]);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_input", detail: `${message}.` });
  });
});

describe("GET /workspaces/{id}/communities", () => {
  const url = `/api/v1/workspaces/${wsId}/communities`;

  it("lists the hosted communities as cards", async () => {
    const { response, calls } = await send({ method: "GET", url }, [["spark.ws_list_workspace_communities", () => [cardRow()]]]);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json().items[0]).toMatchObject({ id: communityId, slug: "night-owls", stage: { code: "seed", label: "Seed" }, memberCount: 1 });
    expect(find(calls, "spark.ws_list_workspace_communities")?.params).toEqual([wsId]);
  });

  it("maps P0002 Workspace not found to 404", async () => {
    const { response } = await send({ method: "GET", url }, [["spark.ws_list_workspace_communities", () => pgError("P0002", "Workspace not found")]]);
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("workspace_not_found");
  });
});

describe("PATCH /communities/{id}", () => {
  const url = `/api/v1/communities/${communityId}`;
  const update = (outcome: string, version: number | null): [string, QueryHandler] => ["spark.ws_update_community", () => [{ outcome, settings_version: version }]];

  it("requires If-Match (428)", async () => {
    const { response, calls } = await send({ method: "PATCH", url, payload: { name: "New" } });
    expect(response.statusCode).toBe(428);
    expect(called(calls, "spark.ws_update_community")).toBe(false);
  });

  it("rejects a malformed If-Match", async () => {
    const { response } = await send({ method: "PATCH", url, payload: { name: "New" }, headers: { "if-match": "W/\"v1\"" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("invalid_if_match");
  });

  it("updates and answers the detail with the new ETag", async () => {
    const { response, calls } = await send({ method: "PATCH", url, payload: { name: "New", city: null, topics: ["product"] }, headers: { "if-match": "\"v1\"" } }, [
      update("ok", 2),
      detailHandler({ name: "New", settings_version: 2, viewer_status: "moderator", host_admin: true }),
    ]);
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe("\"v2\"");
    expect(response.json()).toMatchObject({ name: "New", version: 2, canGovern: true });
    const params = find(calls, "spark.ws_update_community")?.params ?? [];
    expect(params.slice(0, 2)).toEqual([communityId, 1]);
    expect(JSON.parse(String(params[2]))).toEqual({ name: "New", city: null, topics: ["product"] });
    expect(find(calls, "spark.community_by_slug")?.params).toEqual([communityId]);
  });

  it("answers 412 with the current representation when stale", async () => {
    const { response } = await send({ method: "PATCH", url, payload: { name: "New" }, headers: { "if-match": "\"v1\"" } }, [
      update("version_mismatch", 3),
      detailHandler({ settings_version: 3, viewer_status: "moderator" }),
    ]);
    expect(response.statusCode).toBe(412);
    expect(response.json()).toMatchObject({ code: "version_mismatch", current: { id: communityId, version: 3, canGovern: false } });
  });

  it.each([["forbidden", 403, "insufficient_role"], ["not_found", 404, "community_not_found"]])("maps %s", async (outcome, status, code) => {
    const { response } = await send({ method: "PATCH", url, payload: { name: "New" }, headers: { "if-match": "\"v1\"" } }, [update(outcome, null)]);
    expect(response.statusCode).toBe(status);
    expect(response.json().code).toBe(code);
  });

  it.each([[{ slug: "other" }], [{}], [{ name: "x", owner: "me" }]])("rejects body %j with 400", async (payload) => {
    const { response, calls } = await send({ method: "PATCH", url, payload, headers: { "if-match": "\"v1\"" } });
    expect(response.statusCode).toBe(400);
    expect(called(calls, "spark.ws_update_community")).toBe(false);
  });

  it("maps 22023 Invalid community patch to invalid_input", async () => {
    const { response } = await send({ method: "PATCH", url, payload: { name: "x" }, headers: { "if-match": "\"v1\"" } }, [["spark.ws_update_community", () => pgError("22023", "Invalid community patch")]]);
    expect(response.json()).toMatchObject({ code: "invalid_input", detail: "Invalid community patch." });
  });
});

describe("GET /communities/{id}/requests", () => {
  const url = `/api/v1/communities/${communityId}/requests`;
  const standing = (visible: boolean, manage: boolean): [string, QueryHandler] => ["spark.can_manage_community", () => [{ visible, can_manage: manage }]];
  const requestRow = {
    id: "55555555-5555-4555-8555-555555555555",
    user_id: userId,
    display_name: "Bea",
    avatar_url: null,
    message: "Let me in",
    status: "pending",
    created_at: new Date("2026-11-02T08:00:00Z"),
    reviewed_at: null,
    reviewed_by_user_id: selfId,
    email: "bea@example.com",
  };

  it("lists requests for a manager without emails or reviewers", async () => {
    const { response, calls } = await send({ method: "GET", url: `${url}?status=pending` }, [standing(true, true), ["spark.ws_list_community_requests", () => [requestRow]]]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [{
        id: requestRow.id,
        requester: { id: userId, displayName: "Bea" },
        message: "Let me in",
        status: "pending",
        createdAt: "2026-11-02T08:00:00.000Z",
        reviewedAt: null,
      }],
    });
    expect(response.body).not.toContain("bea@example.com");
    expect(find(calls, "spark.ws_list_community_requests")?.params).toEqual([communityId, "pending"]);
  });

  it("passes no status as null", async () => {
    const { calls } = await send({ method: "GET", url }, [standing(true, true), ["spark.ws_list_community_requests", () => []]]);
    expect(find(calls, "spark.ws_list_community_requests")?.params).toEqual([communityId, null]);
  });

  it("answers 403 to a non-manager and never runs the list query", async () => {
    const { response, calls } = await send({ method: "GET", url }, [standing(true, false), ["spark.ws_list_community_requests", () => [requestRow]]]);
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("insufficient_role");
    expect(called(calls, "spark.ws_list_community_requests")).toBe(false);
  });

  it("answers 404 for an invisible community without running the list query", async () => {
    const { response, calls } = await send({ method: "GET", url }, [standing(false, false)]);
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("community_not_found");
    expect(called(calls, "spark.ws_list_community_requests")).toBe(false);
  });

  it("still maps the function's 42501 if standing changed in between", async () => {
    const { response } = await send({ method: "GET", url }, [standing(true, true), ["spark.ws_list_community_requests", () => pgError("42501", "Community access denied")]]);
    expect(response.statusCode).toBe(403);
  });

  it.each(["status=withdrawn", "status=all", "foo=1"])("rejects ?%s with 400", async (query) => {
    const { response } = await send({ method: "GET", url: `${url}?${query}` }, [standing(true, true)]);
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /communities/{id}/member-candidates", () => {
  const url = `/api/v1/communities/${communityId}/member-candidates`;
  const standing = (visible: boolean, manage: boolean): [string, QueryHandler] => ["spark.can_manage_community", () => [{ visible, can_manage: manage }]];

  it("lists host members who can be added", async () => {
    const { response } = await send({ method: "GET", url }, [standing(true, true), ["spark.ws_list_community_member_candidates", () => [{ user_id: userId, display_name: "Bea", avatar_url: "https://x/a.png", email: "bea@example.com" }]]]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [{ userId, displayName: "Bea", avatarUrl: "https://x/a.png" }] });
  });

  it("answers 403 to a non-manager without listing", async () => {
    const { response, calls } = await send({ method: "GET", url }, [standing(true, false)]);
    expect(response.statusCode).toBe(403);
    expect(called(calls, "spark.ws_list_community_member_candidates")).toBe(false);
  });
});

describe("GET /communities/{id}/members", () => {
  const url = `/api/v1/communities/${communityId}/members`;
  const list = (result: object[] | Error): [string, QueryHandler] => ["spark.ws_list_community_members", () => result];

  it("lists members with explicit fields", async () => {
    const { response } = await send({ method: "GET", url }, [list([{ user_id: userId, display_name: "Bea", avatar_url: null, role: "owner", joined_at: new Date("2026-11-01T00:00:00Z"), email: "bea@example.com" }])]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [{ userId, displayName: "Bea", avatarUrl: null, role: "owner", joinedAt: "2026-11-01T00:00:00.000Z" }] });
  });

  it("maps P0002 Community not found to 404", async () => {
    const { response } = await send({ method: "GET", url }, [list(pgError("P0002", "Community not found"))]);
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("community_not_found");
  });

  it("maps 42501 Community access denied to 403", async () => {
    const { response } = await send({ method: "GET", url }, [list(pgError("42501", "Community access denied"))]);
    expect(response.statusCode).toBe(403);
  });

  it("keeps other 42501 and P0002 errors as 500", async () => {
    expect((await send({ method: "GET", url }, [list(pgError("42501", "permission denied for table users"))])).response.statusCode).toBe(500);
    expect((await send({ method: "GET", url }, [list(pgError("P0002", "query returned no rows"))])).response.statusCode).toBe(500);
  });
});

describe("POST /communities/{id}/members", () => {
  const url = `/api/v1/communities/${communityId}/members`;
  const add = (outcome: string): [string, QueryHandler] => ["spark.ws_add_community_member", () => [{ outcome }]];
  const members: [string, QueryHandler] = ["spark.ws_list_community_members", () => [{ user_id: userId, display_name: "Bea", avatar_url: null, role: "member", joined_at: new Date("2026-11-03T00:00:00Z") }]];

  it("adds with 201 and Location", async () => {
    const { response, calls } = await send({ method: "POST", url, payload: { userId } }, [add("ok"), members]);
    expect(response.statusCode).toBe(201);
    expect(response.headers.location).toBe(`/api/v1/communities/${communityId}/members/${userId}`);
    expect(response.json()).toEqual({ userId, displayName: "Bea", avatarUrl: null, role: "member", joinedAt: "2026-11-03T00:00:00.000Z" });
    expect(find(calls, "spark.ws_add_community_member")?.params).toEqual([communityId, userId]);
  });

  it.each([
    ["already_member", 409, "already_member"],
    ["not_in_workspace", 422, "not_in_workspace"],
    ["community_frozen", 409, "community_frozen"],
    ["forbidden", 403, "insufficient_role"],
    ["not_found", 404, "community_not_found"],
  ])("maps %s to %i", async (outcome, status, code) => {
    const { response } = await send({ method: "POST", url, payload: { userId } }, [add(outcome)]);
    expect(response.statusCode).toBe(status);
    expect(response.json().code).toBe(code);
  });

  it.each([[{}], [{ userId: "nope" }], [{ userId, role: "owner" }]])("rejects body %j", async (payload) => {
    const { response, calls } = await send({ method: "POST", url, payload });
    expect(response.statusCode).toBe(400);
    expect(called(calls, "spark.ws_add_community_member")).toBe(false);
  });
});

describe("PATCH /communities/{id}/members/{userId}", () => {
  const url = `/api/v1/communities/${communityId}/members/${userId}`;
  const setRole = (outcome: string): [string, QueryHandler] => ["spark.ws_set_community_role", () => [{ outcome }]];
  const members: [string, QueryHandler] = ["spark.ws_list_community_members", () => [{ user_id: userId, display_name: "Bea", avatar_url: null, role: "moderator", joined_at: new Date("2026-11-03T00:00:00Z") }]];

  it("changes the role", async () => {
    const { response, calls } = await send({ method: "PATCH", url, payload: { role: "moderator" } }, [setRole("ok"), members]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ userId, role: "moderator" });
    expect(find(calls, "spark.ws_set_community_role")?.params).toEqual([communityId, userId, "moderator"]);
  });

  it.each([["last_owner", 409, "last_owner"], ["forbidden", 403, "insufficient_role"], ["not_found", 404, "member_not_found"]])("maps %s", async (outcome, status, code) => {
    const { response } = await send({ method: "PATCH", url, payload: { role: "member" } }, [setRole(outcome)]);
    expect(response.statusCode).toBe(status);
    expect(response.json().code).toBe(code);
  });

  it.each([[{ role: "admin" }], [{ role: "member", x: 1 }]])("rejects body %j", async (payload) => {
    const { response, calls } = await send({ method: "PATCH", url, payload });
    expect(response.statusCode).toBe(400);
    expect(called(calls, "spark.ws_set_community_role")).toBe(false);
  });
});

describe("DELETE /communities/{id}/members/{userId}", () => {
  it("removes another member", async () => {
    const { response, calls } = await send({ method: "DELETE", url: `/api/v1/communities/${communityId}/members/${userId}` }, [["spark.ws_remove_community_member", () => [{ outcome: "ok" }]]]);
    expect(response.statusCode).toBe(204);
    expect(find(calls, "spark.ws_remove_community_member")?.params).toEqual([communityId, userId]);
    expect(called(calls, "spark.ws_leave_community")).toBe(false);
  });

  it("leaves when the target is the caller", async () => {
    const { response, calls } = await send({ method: "DELETE", url: `/api/v1/communities/${communityId}/members/${selfId}` }, [["spark.ws_leave_community", () => [{ outcome: "ok" }]]]);
    expect(response.statusCode).toBe(204);
    expect(find(calls, "spark.ws_leave_community")?.params).toEqual([communityId]);
    expect(called(calls, "spark.ws_remove_community_member")).toBe(false);
  });

  it.each([
    ["spark.ws_leave_community", selfId, "last_owner", 409],
    ["spark.ws_remove_community_member", userId, "last_owner", 409],
    ["spark.ws_remove_community_member", userId, "forbidden", 403],
    ["spark.ws_remove_community_member", userId, "not_found", 404],
  ])("%s for %s maps %s to %i", async (fn, target, outcome, status) => {
    const { response } = await send({ method: "DELETE", url: `/api/v1/communities/${communityId}/members/${target}` }, [[fn, () => [{ outcome }]]]);
    expect(response.statusCode).toBe(status);
  });

  it("keeps a database outage a 500", async () => {
    const { response } = await send({ method: "DELETE", url: `/api/v1/communities/${communityId}/members/${userId}` }, [["spark.ws_remove_community_member", () => dbError("08006")]]);
    expect(response.statusCode).toBe(500);
  });
});
