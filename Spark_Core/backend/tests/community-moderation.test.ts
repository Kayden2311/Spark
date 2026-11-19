import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { fakePool, principalRow, type QueryHandler } from "./fake-pool.js";

const config = loadConfig({ NODE_ENV: "test" });
const cookie = `spark_session=${"e".repeat(64)}`;
const communityId = "11111111-1111-4111-8111-111111111111";
const postId = "22222222-2222-4222-8222-222222222222";
const commentId = "33333333-3333-4333-8333-333333333333";
const reportId = "55555555-5555-4555-8555-555555555555";

type Calls = Array<{ sql: string; params: unknown[] }>;
interface Call { method: "GET" | "POST"; url: string; payload?: unknown; headers?: Record<string, string>; session?: "none" | "valid" | "expired" }

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

const report = (outcome: string, id: string | null = reportId): [string, QueryHandler] => ["spark.ws_report_content", () => [{ outcome, report_id: id }]];
const moderate = (outcome: string, status: string | null, closed: number | null = 0): [string, QueryHandler] =>
  ["spark.ws_moderate_content", () => [{ outcome, moderation_status: status, reports_closed: closed }]];

// The route re-reads the target after the call to return its new version.
const reread: Array<[string, QueryHandler]> = [["spark.community_post(", () => [{ version: 7 }]], ["spark.community_comment(", () => [{ version: 7 }]]];

const postReports = `/api/v1/posts/${postId}/reports`;
const commentReports = `/api/v1/comments/${commentId}/reports`;
const postModeration = `/api/v1/posts/${postId}/moderation`;
const commentModeration = `/api/v1/comments/${commentId}/moderation`;
const queueUrl = `/api/v1/communities/${communityId}/reports`;

const queueRow = (over: object = {}) => ({
  target_kind: "post",
  target_id: postId,
  post_id: postId,
  post_title: "Hello",
  excerpt: "First post",
  author_name: "Ada",
  moderation_status: "visible",
  open_reports: "3",
  reasons: [{ reason: "spam", count: 2 }, { reason: "other", count: 1 }],
  latest_details: ["looks like an ad"],
  first_reported_at: new Date("2026-11-10T09:00:00.000Z"),
  last_reported_at: "2026-11-11T09:00:00.000Z",
  ...over,
});

describe("POST /posts/{id}/reports and /comments/{id}/reports", () => {
  it.each([["post", postReports, "post", postId], ["comment", commentReports, "comment", commentId]])(
    "creates a %s report: 201 without Location, then 200 for the same target",
    async (_name, url, kind, target) => {
      const created = await send({ method: "POST", url, payload: { reason: "spam", details: " ad " } }, [report("reported")]);
      expect(created.response.statusCode).toBe(201);
      expect(created.response.json()).toEqual({ report: { id: reportId, status: "open" } });
      expect(created.response.headers.location).toBeUndefined();
      expect(created.response.headers["cache-control"]).toBe("private, no-store");
      expect(find(created.calls, "spark.ws_report_content")?.params).toEqual([kind, target, "spam", " ad "]);

      const again = await send({ method: "POST", url, payload: { reason: "spam" } }, [report("already_reported")]);
      expect(again.response.statusCode).toBe(200);
      expect(again.response.json()).toEqual({ report: { id: reportId, status: "open" } });
      expect(again.response.headers.location).toBeUndefined();
      expect(again.response.headers["cache-control"]).toBe("private, no-store");
      expect(find(again.calls, "spark.ws_report_content")?.params[3]).toBeNull();
    },
  );

  it.each([
    [{ reason: "nonsense" }],
    [{}],
    [{ reason: "spam", extra: 1 }],
    [{ reason: "spam", details: { a: 1 } }],
    [{ reason: "spam", details: "x".repeat(4001) }],
  ])("rejects %j with 400 before any SQL", async (payload) => {
    const { response, calls } = await send({ method: "POST", url: postReports, payload });
    expect(response.statusCode).toBe(400);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(called(calls, "spark.ws_")).toBe(false);
  });

  it("rejects a malformed id and a query string with 400", async () => {
    expect((await send({ method: "POST", url: "/api/v1/posts/nope/reports", payload: { reason: "spam" } })).response.statusCode).toBe(400);
    expect((await send({ method: "POST", url: `${postReports}?x=1`, payload: { reason: "spam" } })).response.statusCode).toBe(400);
  });

  it("answers 409 own_content for the author's own content", async () => {
    const { response } = await send({ method: "POST", url: postReports, payload: { reason: "spam" } }, [report("own_content", null)]);
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("own_content");
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it.each([[postReports, "post_not_found"], [commentReports, "comment_not_found"]])("answers 404 for %s", async (url, code) => {
    const { response } = await send({ method: "POST", url, payload: { reason: "spam" } }, [report("not_found", null)]);
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe(code);
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("maps 22023 report messages to invalid_input", async () => {
    const { response } = await send({ method: "POST", url: postReports, payload: { reason: "spam", details: "x" } },
      [["spark.ws_report_content", () => pgError("22023", "Invalid report details")]]);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_input", detail: "Invalid report details." });
  });

  it.each(["40001", "40P01"])("maps %s to 503 retry_later with Retry-After", async (code) => {
    const { response } = await send({ method: "POST", url: postReports, payload: { reason: "spam" } },
      [["spark.ws_report_content", () => pgError(code, "collision")]]);
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe("retry_later");
    expect(response.headers["retry-after"]).toBe("1");
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("answers 500 for an outcome outside the closed set and for a missing id", async () => {
    expect((await send({ method: "POST", url: postReports, payload: { reason: "spam" } }, [report("surprise")])).response.statusCode).toBe(500);
    expect((await send({ method: "POST", url: postReports, payload: { reason: "spam" } }, [report("reported", null)])).response.statusCode).toBe(500);
  });

  it("never returns reporter data", async () => {
    const { response } = await send({ method: "POST", url: postReports, payload: { reason: "spam" } },
      [["spark.ws_report_content", () => [{ outcome: "reported", report_id: reportId, reporter_user_id: "secret-reporter" }]]]);
    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain("secret-reporter");
    expect(response.body.toLowerCase()).not.toContain("reporter");
  });
});

describe("POST /posts/{id}/moderation and /comments/{id}/moderation", () => {
  it.each([["post", postModeration, postId], ["comment", commentModeration, commentId]])("hides a %s", async (_name, url, target) => {
    const { response, calls } = await send({ method: "POST", url, payload: { action: "hide", reason: "spam ad" } }, [moderate("ok", "hidden", 2), ...reread]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ moderation: "hidden", reportsClosed: 2, changed: true, version: 7 });
    expect(find(calls, url.includes("/posts/") ? "spark.community_post(" : "spark.community_comment(")?.params).toEqual([target]);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(find(calls, "spark.ws_moderate_content")?.params).toEqual([url.includes("/posts/") ? "post" : "comment", target, "hide", "spam ad"]);
  });

  it("answers unchanged with 200 and changed: false", async () => {
    const { response } = await send({ method: "POST", url: postModeration, payload: { action: "restore", reason: "already fine" } }, [moderate("unchanged", "visible", 0), ...reread]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ moderation: "visible", reportsClosed: 0, changed: false, version: 7 });
  });

  it.each([
    [{ action: "hide" }],
    [{ reason: "because" }],
    [{ action: "delete", reason: "because" }],
    [{ action: "hide", reason: "because", extra: true }],
    [{ action: "hide", reason: { a: 1 } }],
  ])("rejects %j with 400 before any SQL", async (payload) => {
    const { response, calls } = await send({ method: "POST", url: postModeration, payload });
    expect(response.statusCode).toBe(400);
    expect(called(calls, "spark.ws_")).toBe(false);
  });

  it("answers 400 for a 2-character reason (the database rejects it) and a blank one", async () => {
    for (const reason of ["ab", "   "]) {
      const { response } = await send({ method: "POST", url: postModeration, payload: { action: "hide", reason } },
        [["spark.ws_moderate_content", () => pgError("22023", "Invalid moderation reason")]]);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_input", detail: "Invalid moderation reason." });
    }
  });

  it("answers 403 insufficient_role when the actor does not moderate", async () => {
    const { response } = await send({ method: "POST", url: postModeration, payload: { action: "hide", reason: "because" } }, [moderate("forbidden", null, null)]);
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("insufficient_role");
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it.each([[postModeration, "post_not_found"], [commentModeration, "comment_not_found"]])("answers 404 for %s", async (url, code) => {
    const { response } = await send({ method: "POST", url, payload: { action: "dismiss", reason: "because" } }, [moderate("not_found", null, null)]);
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe(code);
  });

  it("answers 500 for an outcome outside the closed set", async () => {
    const { response } = await send({ method: "POST", url: postModeration, payload: { action: "hide", reason: "because" } }, [moderate("own_content", "visible")]);
    expect(response.statusCode).toBe(500);
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it.each(["40001", "40P01"])("maps %s to 503 retry_later", async (code) => {
    const { response } = await send({ method: "POST", url: postModeration, payload: { action: "hide", reason: "because" } },
      [["spark.ws_moderate_content", () => pgError(code, "collision")]]);
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe("retry_later");
  });
});

describe("GET /communities/{id}/reports", () => {
  it("lists the queue without any reporter data", async () => {
    const { response, calls } = await send({ method: "GET", url: queueUrl }, [["spark.community_report_queue", () => [queueRow(), queueRow({ target_kind: "comment", target_id: commentId, open_reports: 1 })]]]);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(find(calls, "spark.community_report_queue")?.params).toEqual([communityId]);
    const body = response.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toEqual({
      target: { kind: "post", id: postId, postId, title: "Hello", excerpt: "First post", authorName: "Ada", moderation: "visible" },
      openReports: 3,
      reasons: [{ reason: "spam", count: 2 }, { reason: "other", count: 1 }],
      latestDetails: ["looks like an ad"],
      firstReportedAt: "2026-11-10T09:00:00.000Z",
      lastReportedAt: "2026-11-11T09:00:00.000Z",
    });
    expect(response.body.toLowerCase()).not.toContain("reporter");
  });

  it("drops columns it does not map", async () => {
    const { response } = await send({ method: "GET", url: queueUrl }, [["spark.community_report_queue", () => [queueRow({ reporter_user_id: "secret-reporter" })]]]);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("secret-reporter");
  });

  it("answers an empty queue", async () => {
    const { response } = await send({ method: "GET", url: queueUrl }, [["spark.community_report_queue", () => []]]);
    expect(response.json()).toEqual({ items: [] });
  });

  it("answers 403 for a non-moderator and never mentions a reporter", async () => {
    const { response } = await send({ method: "GET", url: queueUrl }, [["spark.community_report_queue", () => pgError("42501", "Community access denied")]]);
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("insufficient_role");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body.toLowerCase()).not.toContain("reporter");
  });

  it("answers 404 for an unreadable community", async () => {
    const { response } = await send({ method: "GET", url: queueUrl }, [["spark.community_report_queue", () => pgError("P0002", "Community not found")]]);
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("community_not_found");
  });

  it("answers 401 without a session and 400 for a malformed id", async () => {
    const anon = await send({ method: "GET", url: queueUrl, session: "none" });
    expect(anon.response.statusCode).toBe(401);
    expect(anon.response.headers["cache-control"]).toBe("private, no-store");
    expect(called(anon.calls, "spark.community_report_queue")).toBe(false);
    expect((await send({ method: "GET", url: "/api/v1/communities/nope/reports" })).response.statusCode).toBe(400);
  });
});

const writes: Call[] = [
  { method: "POST", url: postReports, payload: { reason: "spam" } },
  { method: "POST", url: commentReports, payload: { reason: "spam" } },
  { method: "POST", url: postModeration, payload: { action: "hide", reason: "because" } },
  { method: "POST", url: commentModeration, payload: { action: "hide", reason: "because" } },
];

describe("report and moderation writes need a session and a same-origin caller", () => {
  it.each(writes)("$url answers 401 unauthenticated without a cookie", async (route) => {
    const { response, calls } = await send({ ...route, session: "none" });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("unauthenticated");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(called(calls, "spark.ws_")).toBe(false);
  });

  it.each(writes)("$url answers 401 session_expired for an invalid session", async (route) => {
    const { response } = await send({ ...route, session: "expired" });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("session_expired");
  });

  it.each(writes)("$url answers 403 origin_not_allowed cross-origin", async (route) => {
    const { response, calls } = await send({ ...route, headers: { origin: "https://evil.example" } });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("origin_not_allowed");
    expect(calls).toHaveLength(0);
  });
});
