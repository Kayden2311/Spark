import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { dbError, fakePool, principalRow, type QueryHandler } from "./fake-pool.js";

const config = loadConfig({ NODE_ENV: "test" });
const cookie = `spark_session=${"d".repeat(64)}`;
const communityId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";

type Calls = Array<{ sql: string; params: unknown[] }>;
type Method = "GET" | "POST" | "DELETE";
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

const join = (rows: object[]): [string, QueryHandler] => ["spark.ws_join_community", () => rows];
const requestFn = (rows: object[]): [string, QueryHandler] => ["spark.ws_request_community_membership", () => rows];
const requestRow = {
  id: requestId,
  status: "pending",
  message: "Hi there",
  created_at: new Date("2026-11-01T09:00:00Z"),
  reviewed_by_user_id: "33333333-3333-4333-8333-333333333333",
};
const readRequest: [string, QueryHandler] = ["FROM spark.community_join_requests", () => [requestRow]];

const routes: Call[] = [
  { method: "POST", url: `/api/v1/communities/${communityId}/join` },
  { method: "POST", url: `/api/v1/communities/${communityId}/requests`, payload: {} },
  { method: "GET", url: "/api/v1/me/community-requests" },
  { method: "DELETE", url: `/api/v1/community-requests/${requestId}` },
  { method: "POST", url: `/api/v1/community-requests/${requestId}/decision`, payload: { decision: "approve" } },
];

describe("membership routes need a session", () => {
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

  it("rejects a cross-origin POST before any database work", async () => {
    const { response, calls } = await send({ method: "POST", url: `/api/v1/communities/${communityId}/join`, headers: { origin: "https://evil.example" } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "origin_not_allowed" });
    expect(calls).toHaveLength(0);
  });
});

describe("POST /communities/{id}/join", () => {
  const url = `/api/v1/communities/${communityId}/join`;

  it("joins and answers the member state", async () => {
    const { response, calls } = await send({ method: "POST", url }, [join([{ outcome: "joined", status: "active" }])]);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual({ status: "member", alreadyMember: false });
    expect(find(calls, "spark.ws_join_community")?.params).toEqual([communityId]);
  });

  it("is idempotent: a second join answers 200 with alreadyMember", async () => {
    const { response } = await send({ method: "POST", url }, [join([{ outcome: "already_member", status: "active" }])]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "member", alreadyMember: true });
  });

  it.each([
    ["request_required", 409],
    ["community_frozen", 409],
    ["membership_suspended", 403],
    ["not_found", 404],
  ])("maps %s to %i", async (outcome, status) => {
    const { response } = await send({ method: "POST", url }, [join([{ outcome, status: null }])]);
    expect(response.statusCode).toBe(status);
    expect(response.json().code).toBe(outcome === "not_found" ? "community_not_found" : outcome);
  });

  it("answers 500 for an outcome outside the table", async () => {
    const { response } = await send({ method: "POST", url }, [join([{ outcome: "mystery", status: null }])]);
    expect(response.statusCode).toBe(500);
  });

  it("rejects a malformed community id", async () => {
    const { response, calls } = await send({ method: "POST", url: "/api/v1/communities/not-a-uuid/join" });
    expect(response.statusCode).toBe(400);
    expect(called(calls, "spark.ws_join_community")).toBe(false);
  });
});

describe("POST /communities/{id}/requests", () => {
  const url = `/api/v1/communities/${communityId}/requests`;

  it("creates a request with 201 and Location, never exposing the reviewer", async () => {
    const { response, calls } = await send({ method: "POST", url, payload: { message: "Hi there" } }, [
      requestFn([{ outcome: "requested", request_id: requestId, retry_after: null }]),
      readRequest,
    ]);
    expect(response.statusCode).toBe(201);
    expect(response.headers.location).toBe(`/api/v1/community-requests/${requestId}`);
    expect(response.json()).toEqual({ request: { id: requestId, status: "pending", message: "Hi there", createdAt: "2026-11-01T09:00:00.000Z" } });
    expect(response.body).not.toContain("reviewed");
    expect(find(calls, "spark.ws_request_community_membership")?.params).toEqual([communityId, "Hi there"]);
  });

  it("answers 200 with the same pending request on a repeat", async () => {
    const { response } = await send({ method: "POST", url, payload: {} }, [
      requestFn([{ outcome: "already_pending", request_id: requestId, retry_after: null }]),
      readRequest,
    ]);
    expect(response.statusCode).toBe(200);
    expect(response.json().request.id).toBe(requestId);
  });

  it("passes a missing message as null", async () => {
    const { calls } = await send({ method: "POST", url, payload: {} }, [requestFn([{ outcome: "requested", request_id: requestId, retry_after: null }]), readRequest]);
    expect(find(calls, "spark.ws_request_community_membership")?.params).toEqual([communityId, null]);
  });

  it("accepts a request without a body", async () => {
    const { response, calls } = await send({ method: "POST", url }, [requestFn([{ outcome: "requested", request_id: requestId, retry_after: null }]), readRequest]);
    expect(response.statusCode).toBe(201);
    expect(find(calls, "spark.ws_request_community_membership")?.params).toEqual([communityId, null]);
  });

  it("answers 409 request_cooldown with retryAfter", async () => {
    const { response } = await send({ method: "POST", url, payload: {} }, [
      requestFn([{ outcome: "request_cooldown", request_id: null, retry_after: new Date("2026-11-15T09:00:00Z") }]),
    ]);
    expect(response.statusCode).toBe(409);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({ code: "request_cooldown", retryAfter: "2026-11-15T09:00:00.000Z" });
  });

  it.each([
    ["join_instead", 409],
    ["already_member", 409],
    ["community_frozen", 409],
    ["membership_suspended", 403],
    ["not_found", 404],
  ])("maps %s to %i", async (outcome, status) => {
    const { response } = await send({ method: "POST", url, payload: {} }, [requestFn([{ outcome, request_id: null, retry_after: null }])]);
    expect(response.statusCode).toBe(status);
    expect(response.json().code).toBe(outcome === "not_found" ? "community_not_found" : outcome);
  });

  it("rejects an unknown body key with 400", async () => {
    const { response, calls } = await send({ method: "POST", url, payload: { message: "x", role: "owner" } });
    expect(response.statusCode).toBe(400);
    expect(called(calls, "spark.ws_request_community_membership")).toBe(false);
  });

  it("rejects a message over 500 characters", async () => {
    const { response, calls } = await send({ method: "POST", url, payload: { message: "x".repeat(501) } });
    expect(response.statusCode).toBe(400);
    expect(called(calls, "spark.ws_request_community_membership")).toBe(false);
  });

  it("maps the whitelisted 22023 message to invalid_input", async () => {
    const error = Object.assign(new Error("Invalid request message"), { code: "22023" });
    const { response } = await send({ method: "POST", url, payload: { message: "ok" } }, [["spark.ws_request_community_membership", () => error]]);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_input", detail: "Invalid request message." });
  });
});

describe("GET /me/community-requests", () => {
  it("lists the caller's requests without reviewer ids", async () => {
    const { response } = await send({ method: "GET", url: "/api/v1/me/community-requests" }, [
      ["spark.ws_list_my_community_requests", () => [{
        id: requestId,
        community_id: communityId,
        community_slug: "night-owls",
        community_name: "Night Owls",
        status: "rejected",
        message: null,
        created_at: new Date("2026-11-01T09:00:00Z"),
        reviewed_at: new Date("2026-11-02T09:00:00Z"),
        reviewed_by_user_id: "33333333-3333-4333-8333-333333333333",
      }]],
    ]);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual({
      items: [{
        id: requestId,
        community: { slug: "night-owls", name: "Night Owls" },
        status: "rejected",
        message: null,
        createdAt: "2026-11-01T09:00:00.000Z",
        reviewedAt: "2026-11-02T09:00:00.000Z",
      }],
    });
  });
});

describe("DELETE /community-requests/{id}", () => {
  const url = `/api/v1/community-requests/${requestId}`;
  const withdraw = (outcome: string): [string, QueryHandler] => ["spark.ws_withdraw_community_request", () => [{ outcome }]];

  it("withdraws with 204", async () => {
    const { response, calls } = await send({ method: "DELETE", url }, [withdraw("ok")]);
    expect(response.statusCode).toBe(204);
    expect(find(calls, "spark.ws_withdraw_community_request")?.params).toEqual([requestId]);
  });

  it.each([["not_pending", 409, "not_pending"], ["not_found", 404, "request_not_found"]])("maps %s", async (outcome, status, code) => {
    const { response } = await send({ method: "DELETE", url }, [withdraw(outcome)]);
    expect(response.statusCode).toBe(status);
    expect(response.json().code).toBe(code);
  });
});

describe("POST /community-requests/{id}/decision", () => {
  const url = `/api/v1/community-requests/${requestId}/decision`;
  const decide = (outcome: string, membership: string | null = null): [string, QueryHandler] =>
    ["spark.ws_decide_community_request", () => [{ outcome, membership_status: membership }]];

  it("approves and answers the status", async () => {
    const { response, calls } = await send({ method: "POST", url, payload: { decision: "approve" } }, [decide("approved", "active")]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "approved" });
    expect(find(calls, "spark.ws_decide_community_request")?.params).toEqual([requestId, "approve"]);
  });

  it("rejects and answers the status", async () => {
    const { response } = await send({ method: "POST", url, payload: { decision: "reject" } }, [decide("rejected")]);
    expect(response.json()).toEqual({ status: "rejected" });
  });

  it.each([
    ["already_decided", 409, "already_decided"],
    ["community_frozen", 409, "community_frozen"],
    ["forbidden", 403, "insufficient_role"],
    ["not_found", 404, "request_not_found"],
  ])("maps %s to %i", async (outcome, status, code) => {
    const { response } = await send({ method: "POST", url, payload: { decision: "approve" } }, [decide(outcome)]);
    expect(response.statusCode).toBe(status);
    expect(response.json().code).toBe(code);
  });

  it.each([{}, { decision: "maybe" }, { decision: "approve", note: "x" }])("rejects body %j with 400", async (payload) => {
    const { response, calls } = await send({ method: "POST", url, payload });
    expect(response.statusCode).toBe(400);
    expect(called(calls, "spark.ws_decide_community_request")).toBe(false);
  });

  it("keeps unrelated database errors as 500", async () => {
    const { response } = await send({ method: "POST", url, payload: { decision: "approve" } }, [["spark.ws_decide_community_request", () => dbError("42501")]]);
    expect(response.statusCode).toBe(500);
  });
});
