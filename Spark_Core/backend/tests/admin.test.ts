import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { encodeCursor } from "../src/routes/pagination.js";
import { fakePool, principalRow, type QueryHandler } from "./fake-pool.js";

const config = loadConfig({ NODE_ENV: "test" });
const cookie = "spark_session=staff-token";
const target = "1d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const reason = "Violates community guidelines";

function principal(roles: string[]): QueryHandler {
  return () => [{ ...principalRow, platform_roles: roles }];
}

async function call(
  roles: string[] | null,
  request: { method: "GET" | "POST" | "PATCH" | "DELETE"; url: string; payload?: unknown },
  handlers: Array<[string, QueryHandler]> = [],
) {
  const { pool, calls } = fakePool([["auth_session_principal", roles ? principal(roles) : () => []], ...handlers]);
  const app = await buildApp({ config, pool, rateLimit: false, logger: false });
  try {
    const response = await app.inject({ ...request, headers: roles === undefined ? {} : { cookie } } as Parameters<typeof app.inject>[0]);
    return { response, calls };
  } finally {
    await app.close();
  }
}

const ROUTES: Array<{ method: "GET" | "POST" | "PATCH" | "DELETE"; url: string; payload?: unknown; allowed: string[] }> = [
  // Open to every platform role; only a signed-in user without one is denied.
  { method: "GET", url: "/api/v1/admin/overview", allowed: [] },
  { method: "GET", url: "/api/v1/admin/system", allowed: ["platform_admin"] },
  { method: "GET", url: "/api/v1/admin/reports", allowed: ["content_moderator"] },
  { method: "GET", url: `/api/v1/admin/reports/${target}`, allowed: ["content_moderator"] },
  { method: "POST", url: `/api/v1/admin/reports/${target}/actions`, payload: { action: "hide", reason }, allowed: ["content_moderator"] },
  { method: "GET", url: "/api/v1/admin/communities", allowed: ["community_moderator"] },
  { method: "POST", url: `/api/v1/admin/communities/${target}/actions`, payload: { action: "freeze", reason }, allowed: ["community_moderator"] },
  { method: "GET", url: "/api/v1/admin/users", allowed: ["platform_admin"] },
  { method: "GET", url: `/api/v1/admin/users/${target}`, allowed: ["platform_admin"] },
  { method: "PATCH", url: `/api/v1/admin/users/${target}/status`, payload: { status: "suspended", reason }, allowed: ["platform_admin"] },
  { method: "POST", url: `/api/v1/admin/users/${target}/roles`, payload: { role: "content_moderator", reason }, allowed: ["super_admin"] },
  { method: "DELETE", url: `/api/v1/admin/users/${target}/roles/content_moderator`, payload: { reason }, allowed: ["super_admin"] },
  { method: "GET", url: "/api/v1/admin/campaigns", allowed: ["campaign_moderator"] },
  { method: "GET", url: `/api/v1/admin/campaigns/${target}`, allowed: ["campaign_moderator"] },
  { method: "POST", url: `/api/v1/admin/campaigns/${target}/review`, payload: { decision: "approve", reason }, allowed: ["campaign_moderator"] },
  { method: "GET", url: "/api/v1/admin/audit-logs", allowed: ["platform_admin"] },
];

// A role outside each route's allowed set, chosen so every route has a meaningful denial.
function deniedRoles(allowed: string[]): string[] {
  if (allowed.length === 0) return [];
  if (allowed.includes("super_admin")) return ["platform_admin"];
  if (allowed.includes("platform_admin")) return ["content_moderator"];
  return [allowed.includes("content_moderator") ? "campaign_moderator" : "content_moderator"];
}

describe("admin route access", () => {
  it.each(ROUTES)("$method $url requires a session", async (route) => {
    const { pool } = fakePool();
    const app = await buildApp({ config, pool, rateLimit: false, logger: false });
    const response = await app.inject({ method: route.method, url: route.url, payload: route.payload as never });
    await app.close();
    expect(response.statusCode).toBe(401);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toMatchObject({ code: "unauthenticated" });
  });

  it.each(ROUTES)("$method $url rejects an expired session", async (route) => {
    const { response } = await call(null, route);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "session_expired" });
  });

  it.each(ROUTES)("$method $url rejects staff without the required role", async (route) => {
    const { response, calls } = await call(deniedRoles(route.allowed), route);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "insufficient_permissions" });
    expect(calls.some((entry) => entry.sql.includes("staff_"))).toBe(false);
  });

  it("maps a role revoked mid-request to 403 and a session revoked mid-request to 401", async () => {
    const roleGone = Object.assign(new Error("Platform role required"), { code: "42501" });
    const sessionGone = Object.assign(new Error("Live session required"), { code: "28000" });
    expect((await call(["platform_admin"], ROUTES[0]!, [["staff_overview", () => roleGone]])).response.statusCode).toBe(403);
    expect((await call(["platform_admin"], ROUTES[0]!, [["staff_overview", () => sessionGone]])).response.statusCode).toBe(401);
    // Any other privilege error is a real bug and must not be disguised as a normal denial.
    const other = Object.assign(new Error("permission denied for table users"), { code: "42501" });
    expect((await call(["platform_admin"], ROUTES[0]!, [["staff_overview", () => other]])).response.statusCode).toBe(500);
  });
});

describe("admin request validation", () => {
  it.each([
    ["missing reason", { action: "hide" }],
    ["short reason", { action: "hide", reason: "no" }],
    ["blank reason", { action: "hide", reason: "     " }],
    ["long reason", { action: "hide", reason: "x".repeat(501) }],
    ["unknown action", { action: "delete", reason }],
  ])("rejects a report action with %s", async (_name, payload) => {
    const { response, calls } = await call(["content_moderator"], { method: "POST", url: `/api/v1/admin/reports/${target}/actions`, payload });
    expect(response.statusCode).toBe(400);
    expect(calls.some((entry) => entry.sql.includes("staff_resolve_report"))).toBe(false);
  });

  it("rejects malformed ids, filters and cursors", async () => {
    expect((await call(["platform_admin"], { method: "PATCH", url: "/api/v1/admin/users/not-a-uuid/status", payload: { status: "suspended", reason } })).response.statusCode).toBe(400);
    expect((await call(["content_moderator"], { method: "GET", url: "/api/v1/admin/reports?status=closed" })).response.statusCode).toBe(400);
    expect((await call(["platform_admin"], { method: "GET", url: "/api/v1/admin/users?role=owner" })).response.statusCode).toBe(400);
    expect((await call(["platform_admin"], { method: "GET", url: "/api/v1/admin/audit-logs?limit=500" })).response.statusCode).toBe(400);
    const badCursor = await call(["content_moderator"], { method: "GET", url: "/api/v1/admin/reports?cursor=bm90LWEtY3Vyc29y" });
    expect(badCursor.response.statusCode).toBe(400);
    expect(badCursor.response.json()).toMatchObject({ code: "invalid_cursor" });
    const range = await call(["platform_admin"], { method: "GET", url: "/api/v1/admin/audit-logs?from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z" });
    expect(range.response.json()).toMatchObject({ code: "invalid_range" });
  });
});

describe("admin outcome mapping", () => {
  const cases: Array<[string, { method: "POST" | "PATCH" | "DELETE"; url: string; payload: unknown }, string, string, number, string?]> = [
    ["report", { method: "POST", url: `/api/v1/admin/reports/${target}/actions`, payload: { action: "dismiss", reason } }, "staff_resolve_report", "ok", 200],
    ["report", { method: "POST", url: `/api/v1/admin/reports/${target}/actions`, payload: { action: "hide", reason } }, "staff_resolve_report", "not_found", 404, "report_not_found"],
    ["report", { method: "POST", url: `/api/v1/admin/reports/${target}/actions`, payload: { action: "hide", reason } }, "staff_resolve_report", "already_closed", 409, "report_already_closed"],
    ["community", { method: "POST", url: `/api/v1/admin/communities/${target}/actions`, payload: { action: "feature", reason } }, "staff_moderate_community", "ok", 200],
    ["community", { method: "POST", url: `/api/v1/admin/communities/${target}/actions`, payload: { action: "feature", reason } }, "staff_moderate_community", "invalid_transition", 409, "invalid_transition"],
    ["community", { method: "POST", url: `/api/v1/admin/communities/${target}/actions`, payload: { action: "feature", reason } }, "staff_moderate_community", "not_found", 404, "community_not_found"],
    ["status", { method: "PATCH", url: `/api/v1/admin/users/${target}/status`, payload: { status: "suspended", reason } }, "staff_set_user_status", "ok", 200],
    ["status", { method: "PATCH", url: `/api/v1/admin/users/${target}/status`, payload: { status: "suspended", reason } }, "staff_set_user_status", "self", 400, "self_suspension_prohibited"],
    ["status", { method: "PATCH", url: `/api/v1/admin/users/${target}/status`, payload: { status: "suspended", reason } }, "staff_set_user_status", "forbidden", 403, "insufficient_permissions"],
    ["status", { method: "PATCH", url: `/api/v1/admin/users/${target}/status`, payload: { status: "suspended", reason } }, "staff_set_user_status", "not_found", 404, "user_not_found"],
    ["status", { method: "PATCH", url: `/api/v1/admin/users/${target}/status`, payload: { status: "suspended", reason } }, "staff_set_user_status", "last_super_admin", 409, "last_super_admin"],
    ["status", { method: "PATCH", url: `/api/v1/admin/users/${target}/status`, payload: { status: "suspended", reason } }, "staff_set_user_status", "unchanged", 409, "status_unchanged"],
    ["grant", { method: "POST", url: `/api/v1/admin/users/${target}/roles`, payload: { role: "content_moderator", reason } }, "staff_grant_role", "granted", 201],
    ["grant", { method: "POST", url: `/api/v1/admin/users/${target}/roles`, payload: { role: "content_moderator", reason } }, "staff_grant_role", "exists", 409, "role_already_assigned"],
    ["grant", { method: "POST", url: `/api/v1/admin/users/${target}/roles`, payload: { role: "content_moderator", reason } }, "staff_grant_role", "not_found", 404, "user_not_found"],
    ["revoke", { method: "DELETE", url: `/api/v1/admin/users/${target}/roles/super_admin`, payload: { reason } }, "staff_revoke_role", "revoked", 204],
    ["revoke", { method: "DELETE", url: `/api/v1/admin/users/${target}/roles/super_admin`, payload: { reason } }, "staff_revoke_role", "not_found", 204],
    ["revoke", { method: "DELETE", url: `/api/v1/admin/users/${target}/roles/super_admin`, payload: { reason } }, "staff_revoke_role", "last_super_admin", 409, "last_super_admin"],
    ["campaign", { method: "POST", url: `/api/v1/admin/campaigns/${target}/review`, payload: { decision: "reject", reason } }, "staff_review_campaign", "ok", 200],
    ["campaign", { method: "POST", url: `/api/v1/admin/campaigns/${target}/review`, payload: { decision: "reject", reason } }, "staff_review_campaign", "not_pending", 409, "campaign_not_pending"],
    ["campaign", { method: "POST", url: `/api/v1/admin/campaigns/${target}/review`, payload: { decision: "reject", reason } }, "staff_review_campaign", "not_found", 404, "campaign_not_found"],
    ["campaign", { method: "POST", url: `/api/v1/admin/campaigns/${target}/review`, payload: { decision: "approve", reason } }, "staff_review_campaign", "community_unavailable", 409, "community_unavailable"],
  ];

  it.each(cases)("%s: %s outcome %s maps to %i", async (_area, request, fn, outcome, status, code) => {
    const { response, calls } = await call(["super_admin"], request, [[fn, () => [{ outcome }]]]);
    expect(response.statusCode).toBe(status);
    if (code) expect(response.json()).toMatchObject({ code });
    // The reason always reaches the database, which records it with the change.
    expect(calls.find((entry) => entry.sql.includes(fn))?.params).toContain(reason);
  });

  it.each(cases.filter((entry, index, all) => all.findIndex((other) => other[2] === entry[2]) === index))(
    "%s: never reports an unknown outcome as success",
    async (_area, request, fn) => {
      expect((await call(["super_admin"], request, [[fn, () => [{ outcome: "surprise" }]]])).response.statusCode).toBe(500);
      expect((await call(["super_admin"], request, [[fn, () => []]])).response.statusCode).toBe(500);
    },
  );

  it("passes the report dismissal through under its database name", async () => {
    const { calls } = await call(["content_moderator"], cases[0]![1], [["staff_resolve_report", () => [{ outcome: "ok" }]]]);
    expect(calls.find((entry) => entry.sql.includes("staff_resolve_report"))?.params).toEqual([target, "dismiss_report", reason]);
  });
});

describe("admin report queue", () => {
  const row = (index: number) => ({
    id: `00000000-0000-4000-8000-00000000000${index}`,
    cursor_ts: `2026-10-17 10:00:0${index}.123456+00`,
    community_id: target,
    community_name: "Northstar Founders",
    community_slug: "northstar-founders",
    post_id: "11111111-1111-4111-8111-111111111111",
    comment_id: null,
    reporter_user_id: principalRow.user_id,
    reporter_name: "Reporter",
    reason_code: "spam",
    details: null,
    status: "open",
    created_at: new Date(`2026-10-17T10:00:0${index}.123Z`),
    resolved_at: null,
    post_title: "Reported post",
    post_body: "Body",
    post_moderation_status: "visible",
    comment_body: null,
    comment_moderation_status: null,
  });

  it("returns one page plus an opaque cursor built from the database timestamp", async () => {
    const { response, calls } = await call(["content_moderator"], { method: "GET", url: "/api/v1/admin/reports?limit=2" }, [["staff_list_reports", () => [row(3), row(2), row(1)]]]);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toEqual({
      id: row(3).id,
      status: "open",
      reasonCode: "spam",
      details: null,
      createdAt: "2026-10-17T10:00:03.123Z",
      resolvedAt: null,
      community: { id: target, name: "Northstar Founders", slug: "northstar-founders" },
      reporter: { id: principalRow.user_id, displayName: "Reporter" },
      target: { kind: "post", id: row(3).post_id, title: "Reported post", body: "Body", moderationStatus: "visible" },
    });
    expect(body.nextCursor).toBe(encodeCursor({ createdAt: row(2).cursor_ts, id: row(2).id }));
    expect(calls.find((entry) => entry.sql.includes("staff_list_reports"))?.params).toEqual(["open", null, null, null, 3]);

    const next = await call(["content_moderator"], { method: "GET", url: `/api/v1/admin/reports?limit=2&status=open&cursor=${body.nextCursor}` }, [["staff_list_reports", () => [row(1)]]]);
    expect(next.response.json()).toMatchObject({ items: [{ id: row(1).id }], nextCursor: null });
    expect(next.calls.find((entry) => entry.sql.includes("staff_list_reports"))?.params).toEqual(["open", null, row(2).cursor_ts, row(2).id, 3]);
  });

  it("returns a single report or 404", async () => {
    const found = await call(["content_moderator"], { method: "GET", url: `/api/v1/admin/reports/${target}` }, [["staff_list_reports", () => [row(1)]]]);
    expect(found.response.json()).toMatchObject({ id: row(1).id, target: { kind: "post" } });
    expect(found.response.json()).not.toHaveProperty("cursorTs");
    const missing = await call(["content_moderator"], { method: "GET", url: `/api/v1/admin/reports/${target}` });
    expect(missing.response.statusCode).toBe(404);
  });
});

describe("database input errors and request origin", () => {
  it("answers 400 when the database rejects a reason that is too short once trimmed", async () => {
    const invalid = Object.assign(new Error("A reason of 3 to 500 characters is required"), { code: "22023" });
    const { response } = await call(["content_moderator"], { method: "POST", url: `/api/v1/admin/reports/${target}/actions`, payload: { action: "hide", reason: "  ab  " } }, [["staff_resolve_report", () => invalid]]);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_input", detail: "A reason of 3 to 500 characters is required." });
  });

  it("does not echo unexpected database input errors", async () => {
    const builtIn = Object.assign(new Error("invalid parameter for internal_function"), { code: "22023" });
    const { response } = await call(["content_moderator"], { method: "POST", url: `/api/v1/admin/reports/${target}/actions`, payload: { action: "hide", reason } }, [["staff_resolve_report", () => builtIn]]);
    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toBe("The request contains a value the server does not accept.");
  });

  it.each([
    ["a foreign origin", { origin: "https://evil.example" }],
    ["a cross-site fetch", { "sec-fetch-site": "cross-site" }],
  ])("refuses a mutation from %s before touching the session", async (_name, headers) => {
    const { pool, calls } = fakePool([["auth_session_principal", principal(["super_admin"])]]);
    const app = await buildApp({ config, pool, rateLimit: false, logger: false });
    const response = await app.inject({ method: "PATCH", url: `/api/v1/admin/users/${target}/status`, payload: { status: "suspended", reason }, headers: { cookie, ...headers } });
    await app.close();
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "origin_not_allowed" });
    expect(calls).toEqual([]);
  });

  it("allows the configured frontend origin and same-origin fetches, and never blocks reads", async () => {
    const handlers: Array<[string, QueryHandler]> = [["staff_set_user_status", () => [{ outcome: "ok" }]]];
    const allowed = await call(["platform_admin"], { method: "PATCH", url: `/api/v1/admin/users/${target}/status`, payload: { status: "suspended", reason } }, handlers);
    expect(allowed.response.statusCode).toBe(200);
    const { pool } = fakePool([["auth_session_principal", principal(["platform_admin"])], ...handlers]);
    const app = await buildApp({ config, pool, rateLimit: false, logger: false });
    const fromFrontend = await app.inject({ method: "PATCH", url: `/api/v1/admin/users/${target}/status`, payload: { status: "suspended", reason }, headers: { cookie, origin: "http://localhost:3000", "sec-fetch-site": "same-origin" } });
    const read = await app.inject({ method: "GET", url: "/api/v1/admin/overview", headers: { cookie, origin: "https://evil.example" } });
    await app.close();
    expect(fromFrontend.statusCode).toBe(200);
    expect(read.statusCode).not.toBe(403);
  });
});
