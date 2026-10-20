import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { encodeCursor } from "../src/routes/pagination.js";
import { dbError, fakePool, principalRow, type QueryHandler } from "./fake-pool.js";

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
  { method: "GET", url: "/api/v1/admin/system/health", allowed: ["platform_admin"] },
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
  { method: "GET", url: "/api/v1/admin/analytics/activity", allowed: ["platform_admin"] },
  { method: "GET", url: "/api/v1/admin/analytics/engagement", allowed: ["platform_admin"] },
  { method: "GET", url: "/api/v1/admin/analytics/retention", allowed: ["platform_admin"] },
  { method: "GET", url: "/api/v1/admin/analytics/top-communities", allowed: ["community_moderator"] },
  { method: "GET", url: "/api/v1/admin/billing/overview", allowed: ["platform_admin"] },
  { method: "GET", url: "/api/v1/admin/billing/mrr", allowed: ["platform_admin"] },
  { method: "GET", url: "/api/v1/admin/billing/subscriptions", allowed: ["platform_admin"] },
  { method: "GET", url: "/api/v1/admin/billing/invoices", allowed: ["platform_admin"] },
  { method: "GET", url: `/api/v1/admin/communities/${target}`, allowed: ["community_moderator"] },
  { method: "GET", url: `/api/v1/admin/users/${target}/activity`, allowed: ["platform_admin"] },
  { method: "GET", url: `/api/v1/admin/users/${target}/sessions`, allowed: ["platform_admin"] },
  { method: "GET", url: "/api/v1/admin/reports/stats", allowed: ["content_moderator"] },
  { method: "GET", url: "/api/v1/admin/communities/stats", allowed: ["community_moderator"] },
  { method: "GET", url: `/api/v1/admin/reports/${target}/context`, allowed: ["content_moderator"] },
  { method: "GET", url: `/api/v1/admin/reports/${target}/preview`, allowed: ["content_moderator"] },
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

describe("admin insight routes", () => {
  it.each([
    "/api/v1/admin/analytics/activity?days=6",
    "/api/v1/admin/analytics/activity?days=366",
    "/api/v1/admin/analytics/retention?weeks=27",
    "/api/v1/admin/billing/mrr?months=25",
    "/api/v1/admin/billing/subscriptions?status=gone",
    "/api/v1/admin/billing/subscriptions?kind=gold",
    "/api/v1/admin/billing/invoices?status=gone",
  ])("rejects out-of-range input: %s", async (url) => {
    const { response, calls } = await call(["super_admin"], { method: "GET", url });
    expect(response.statusCode).toBe(400);
    expect(calls.some((entry) => entry.sql.includes("staff_"))).toBe(false);
  });

  it("splits the activity series into the period and the one before it", async () => {
    const day = (index: number) => ({ day: `2026-10-${String(index + 1).padStart(2, "0")}`, signups: "1", active_users: String(index), sign_ins: "2", posts: "3", comments: "4", reports_opened: "0", reports_closed: "0" });
    const { response, calls } = await call(["platform_admin"], { method: "GET", url: "/api/v1/admin/analytics/activity?days=7" }, [
      ["staff_activity_series", () => Array.from({ length: 14 }, (_, index) => day(index))],
      ["staff_active_user_totals", () => [{ dau: "3", wau: "9", mau: "20", total_users: "40" }]],
    ]);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(calls.find((entry) => entry.sql.includes("staff_activity_series"))?.params).toEqual([14]);
    expect(body.series).toHaveLength(7);
    expect(body.series[0].day).toBe("2026-10-08");
    expect(body.current).toMatchObject({ signups: 7, posts: 21, avgActiveUsers: 10 });
    expect(body.previous).toMatchObject({ signups: 7, avgActiveUsers: 3 });
    expect(body.audience).toEqual({ dau: 3, wau: 9, mau: 20, totalUsers: 40 });
  });

  it("reports MRR and ARR per currency from the billing functions", async () => {
    const { response } = await call(["platform_admin"], { method: "GET", url: "/api/v1/admin/billing/overview" }, [
      ["staff_billing_counts", () => [{ free_workspaces: "5", trialing: "1", paying: "2", past_due: "0", cancelled_30d: "1", new_paid_30d: "1", failed_payments_30d: "0" }]],
      ["staff_billing_revenue", () => [{ currency: "USD", mrr_minor: "12900", collected_30d_minor: "2900", open_minor: "0", uncollectible_minor: "0" }]],
      ["staff_billing_plan_mix", () => [{ plan_code: "pro", plan_name: "Pro", billing_kind: "paid", subscriptions: "2", currency: "USD", mrr_minor: "12900" }]],
    ]);
    expect(response.json()).toMatchObject({
      counts: { freeWorkspaces: 5, paying: 2 },
      revenue: [{ currency: "USD", mrrMinor: 12900, arrMinor: 154800 }],
      planMix: [{ code: "pro", subscriptions: 2, mrrMinor: 12900 }],
    });
  });

  it("never exposes session secrets", async () => {
    const { response } = await call(["platform_admin"], { method: "GET", url: `/api/v1/admin/users/${target}/sessions` }, [
      ["staff_user_sessions", () => [{ id: target, created_at: new Date(), last_seen_at: new Date(), expires_at: new Date(), auth_method: "password", state: "active", token_hash: "secret" }]],
    ]);
    expect(JSON.stringify(response.json())).not.toContain("secret");
    expect(Object.keys(response.json().items[0]).sort()).toEqual(["createdAt", "expiresAt", "id", "lastSeenAt", "method", "state"]);
  });
});

describe("admin dashboard insight routes", () => {
  const healthRow = { growing: "2", steady: "1", slowing: "0", quiet: "3", needs_review: "1", archived: "4" };
  const communityDay = (index: number, live: string | null = null) => ({ day: `2026-10-${String(index + 1).padStart(2, "0")}`, new_members: String(index), new_communities: index % 2 ? "1" : "0", live_communities: live });

  it("returns community health counts and the period split from one 2 x days series", async () => {
    const { response, calls } = await call(["community_moderator"], { method: "GET", url: "/api/v1/admin/communities/stats?days=7" }, [
      ["staff_community_health_counts", () => [healthRow]],
      ["staff_community_daily", () => Array.from({ length: 14 }, (_, index) => communityDay(index))],
    ]);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(calls.find((entry) => entry.sql.includes("staff_community_daily"))?.params).toEqual([14]);
    const body = response.json();
    expect(body.days).toBe(7);
    expect(body.health).toEqual({ growing: 2, steady: 1, slowing: 0, quiet: 3, needsReview: 1, archived: 4 });
    expect(body.series).toHaveLength(7);
    expect(body.series[0]).toEqual({ day: "2026-10-08", newMembers: 7, newCommunities: 1, liveCommunities: null });
    expect(body.series[6]).toEqual({ day: "2026-10-14", newMembers: 13, newCommunities: 1, liveCommunities: null });
    // Days 8-14 are the current period, days 1-7 the one before it.
    expect(body.current).toEqual({ newMembers: 7 + 8 + 9 + 10 + 11 + 12 + 13, newCommunities: 4 });
    expect(body.previous).toEqual({ newMembers: 0 + 1 + 2 + 3 + 4 + 5 + 6, newCommunities: 3 });
  });

  it("defaults to 30 days and passes a live community count through as a number", async () => {
    const { response, calls } = await call(["platform_admin"], { method: "GET", url: "/api/v1/admin/communities/stats" }, [
      ["staff_community_health_counts", () => [healthRow]],
      ["staff_community_daily", () => Array.from({ length: 60 }, (_, index) => communityDay(index % 28, "5"))],
    ]);
    expect(response.statusCode).toBe(200);
    expect(calls.find((entry) => entry.sql.includes("staff_community_daily"))?.params).toEqual([60]);
    expect(response.json().series).toHaveLength(30);
    expect(response.json().series[0].liveCommunities).toBe(5);
  });

  it("answers zeros for an empty platform", async () => {
    const { response } = await call(["platform_admin"], { method: "GET", url: "/api/v1/admin/communities/stats?days=90" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      days: 90,
      health: { growing: 0, steady: 0, slowing: 0, quiet: 0, needsReview: 0, archived: 0 },
      series: [],
      current: { newMembers: 0, newCommunities: 0 },
      previous: { newMembers: 0, newCommunities: 0 },
    });
  });

  it("serves /communities/stats from the stats route, not the community detail route", async () => {
    const { response, calls } = await call(["community_moderator"], { method: "GET", url: "/api/v1/admin/communities/stats?days=30" }, [["staff_community_health_counts", () => [healthRow]]]);
    expect(response.statusCode).toBe(200);
    expect(calls.some((entry) => entry.sql.includes("staff_community_series"))).toBe(false);
    expect(calls.some((entry) => entry.sql.includes("staff_community_daily"))).toBe(true);
  });

  it.each([
    "/api/v1/admin/communities/stats?days=10",
    "/api/v1/admin/communities/stats?days=365",
    "/api/v1/admin/communities/stats?days=7&extra=1",
    "/api/v1/admin/reports/stats?days=6",
    "/api/v1/admin/reports/stats?days=30&extra=1",
  ])("rejects invalid input before the database: %s", async (url) => {
    const { response, calls } = await call(["super_admin"], { method: "GET", url });
    expect(response.statusCode).toBe(400);
    expect(calls.some((entry) => entry.sql.includes("staff_"))).toBe(false);
  });

  it("refuses community stats to a content moderator and report stats to a community moderator", async () => {
    const communities = await call(["content_moderator"], { method: "GET", url: "/api/v1/admin/communities/stats?days=7" });
    expect(communities.response.statusCode).toBe(403);
    expect(communities.calls.some((entry) => entry.sql.includes("staff_"))).toBe(false);
    const reports = await call(["community_moderator"], { method: "GET", url: "/api/v1/admin/reports/stats?days=7" });
    expect(reports.response.statusCode).toBe(403);
    expect(reports.calls.some((entry) => entry.sql.includes("staff_"))).toBe(false);
  });

  it("adds reasons, top communities and a daily series to the report stats", async () => {
    const { response, calls } = await call(["content_moderator"], { method: "GET", url: "/api/v1/admin/reports/stats?days=7" }, [
      ["staff_report_stats", () => [{ opened: "9", closed: "4", backlog: "12", median_hours_to_close: "5.5" }]],
      ["staff_report_reasons", () => [{ reason: "spam", open_count: "8" }, { reason: "abuse", open_count: "4" }]],
      ["staff_report_top_communities", () => [{ community_id: target, name: "Northstar Founders", slug: "northstar-founders", open_count: "6" }]],
      ["staff_report_daily", () => [
        { day: "2026-10-19", opened: "3", closed: "0", backlog: "11", median_hours_to_close: null },
        { day: "2026-10-20", opened: "2", closed: "1", backlog: "12", median_hours_to_close: "26.5" },
      ]],
    ]);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual({
      days: 7,
      opened: 9,
      closed: 4,
      backlog: 12,
      medianHoursToClose: 5.5,
      reasons: [{ reason: "spam", count: 8 }, { reason: "abuse", count: 4 }],
      topCommunities: [{ id: target, name: "Northstar Founders", slug: "northstar-founders", count: 6 }],
      series: [
        { day: "2026-10-19", opened: 3, closed: 0, backlog: 11, medianHoursToClose: null },
        { day: "2026-10-20", opened: 2, closed: 1, backlog: 12, medianHoursToClose: 26.5 },
      ],
    });
    expect(calls.find((entry) => entry.sql.includes("staff_report_top_communities"))?.params).toEqual([5]);
    expect(calls.find((entry) => entry.sql.includes("staff_report_daily"))?.params).toEqual([7]);
  });

  it("keeps the report stats valid when the queue is empty", async () => {
    const { response } = await call(["content_moderator"], { method: "GET", url: "/api/v1/admin/reports/stats" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ days: 30, opened: 0, closed: 0, backlog: 0, medianHoursToClose: null, reasons: [], topCommunities: [], series: [] });
  });
});

describe("system health", () => {
  it("reports checks, traffic and process stats without exposing internals", async () => {
    const { response } = await call(["platform_admin"], { method: "GET", url: "/api/v1/admin/system/health?minutes=60" }, [
      ["pg_database_size", () => [{ size: String(64 * 1024 * 1024), connections: "7", hits: "990", reads: "10" }]],
      ["staff_active_session_count", () => [{ total: "12" }]],
    ]);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toMatch(/operational|degraded/u);
    expect(body.checks.database).toMatchObject({ status: "ok", detail: "Responding" });
    // No Redis is wired into this test app, so the check says so instead of guessing.
    expect(body.checks.redis).toMatchObject({ status: "unknown" });
    expect(body.database).toMatchObject({ sizeMb: 64, connections: 7, cacheHitRatio: 0.99, activeSessions: 12 });
    expect(body.traffic.series).toHaveLength(60);
    expect(body.process.nodeVersion).toBe(process.version);
  });

  it("still answers when Redis is down, while rate-limited routes fail", async () => {
    // A Redis client whose every command fails, as during an outage.
    const failing = () => { throw Object.assign(new Error("Connection is closed."), { code: "ECONNREFUSED" }); };
    const redis = {
      defineCommand: () => undefined,
      rateLimit: (...args: unknown[]) => (args.at(-1) as (error: Error) => void)(new Error("Connection is closed.")),
      ping: failing,
      info: failing,
      on: () => undefined,
    };
    const { pool } = fakePool([
      ["auth_session_principal", principal(["platform_admin"])],
      ["pg_database_size", () => [{ size: "0", connections: "1", hits: "1", reads: "0" }]],
    ]);
    const app = await buildApp({ config, pool, redis: redis as never, rateLimit: true, logger: false });
    try {
      const health = await app.inject({ method: "GET", url: "/api/v1/admin/system/health", headers: { cookie } });
      expect(health.statusCode).toBe(200);
      expect(health.json().checks.redis).toMatchObject({ status: "down" });
      expect(health.json().status).toBe("degraded");
      const other = await app.inject({ method: "GET", url: "/api/v1/admin/overview", headers: { cookie } });
      expect(other.statusCode).toBe(500);
    } finally {
      await app.close();
    }
  });

  it("says the database is unreachable instead of a generic error", async () => {
    const { pool } = fakePool([["auth_session_principal", () => dbError("ECONNREFUSED")]]);
    const app = await buildApp({ config, pool, rateLimit: false, logger: false });
    try {
      const response = await app.inject({ method: "GET", url: "/api/v1/admin/system/health", headers: { cookie } });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "database_unavailable" });
    } finally {
      await app.close();
    }
  });

  it("keeps unexpected database errors as server errors rather than calling them an outage", async () => {
    const { response } = await call(["platform_admin"], { method: "GET", url: "/api/v1/admin/system/health" }, [
      ["pg_database_size", () => dbError("42883")],
    ]);
    expect(response.statusCode).toBe(500);
  });

  it("covers the whole 24-hour window in eight-minute buckets", async () => {
    const { response } = await call(["platform_admin"], { method: "GET", url: "/api/v1/admin/system/health?minutes=1440" });
    expect(response.json().traffic).toMatchObject({ windowMinutes: 1440, stepMinutes: 8 });
    expect(response.json().traffic.series).toHaveLength(180);
  });

  it("limits health checks per client without using Redis", async () => {
    const { pool } = fakePool([["auth_session_principal", principal(["platform_admin"])]]);
    const app = await buildApp({ config, pool, rateLimit: false, logger: false });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 31; i++) statuses.push((await app.inject({ method: "GET", url: "/api/v1/admin/system/health", headers: { cookie } })).statusCode);
      expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
      expect(statuses[30]).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("rejects a window outside 15 minutes to a day", async () => {
    const { response } = await call(["platform_admin"], { method: "GET", url: "/api/v1/admin/system/health?minutes=5" });
    expect(response.statusCode).toBe(400);
  });
});
