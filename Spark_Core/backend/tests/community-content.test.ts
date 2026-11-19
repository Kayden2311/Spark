import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { memberRateKey } from "../src/routes/communities/content.js";
import { encodeCursor } from "../src/routes/pagination.js";
import { dbError, fakePool, principalRow, type QueryHandler } from "./fake-pool.js";

const config = loadConfig({ NODE_ENV: "test" });
const cookie = `spark_session=${"e".repeat(64)}`;
const communityId = "11111111-1111-4111-8111-111111111111";
const postId = "22222222-2222-4222-8222-222222222222";
const commentId = "33333333-3333-4333-8333-333333333333";
const authorId = "44444444-4444-4444-8444-444444444444";

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

const CREATED_AT = "2026-11-10 09:00:00.123456+00";

const feedRow = (over: object = {}) => ({
  id: postId,
  community_id: communityId,
  author_id: authorId,
  author_name: "Ada",
  author_avatar_url: null,
  title: "Hello",
  excerpt: "First post",
  truncated: false,
  created_at: new Date("2026-11-10T09:00:00.123Z"),
  cursor_ts: CREATED_AT,
  edited_at: null,
  comment_count: "2",
  moderation_status: "visible",
  version: 1,
  viewer_is_author: false,
  viewer_reported: false,
  ...over,
});

const postRow = (over: object = {}) => ({
  id: postId,
  community_id: communityId,
  community_slug: "night-owls",
  author_id: authorId,
  author_name: "Ada",
  author_avatar_url: null,
  title: "Hello",
  body: "First post body",
  created_at: new Date("2026-11-10T09:00:00.123Z"),
  edited_at: null,
  comment_count: "2",
  moderation_status: "visible",
  version: 3,
  viewer_is_author: true,
  viewer_reported: false,
  viewer_is_member: true,
  viewer_can_moderate: false,
  community_frozen: false,
  ...over,
});

const commentRow = (over: object = {}) => ({
  id: commentId,
  post_id: postId,
  author_id: authorId,
  author_name: "Ada",
  author_avatar_url: null,
  body: "Nice",
  created_at: new Date("2026-11-10T10:00:00.000Z"),
  cursor_ts: "2026-11-10 10:00:00+00",
  edited_at: null,
  moderation_status: "visible",
  version: 2,
  viewer_is_author: true,
  viewer_reported: false,
  community_id: communityId,
  ...over,
});

const detailRow = (over: object = {}) => ({
  id: communityId,
  slug: "night-owls",
  name: "Night Owls",
  tagline: "Late builders",
  visibility: "public",
  country_code: null,
  city: null,
  stage: "seed",
  topics: ["founders"],
  member_count: "1",
  weekly_posts: "0",
  featured: false,
  frozen: false,
  host_workspace_name: "Acme",
  viewer_status: "member",
  description: "d",
  created_at: new Date("2026-11-01T10:00:00Z"),
  settings_version: 1,
  can_manage: false,
  host_admin: false,
  ...over,
});

const detail = (over: object = {}): [string, QueryHandler] => ["spark.community_by_slug", () => [detailRow(over)]];
const feed = (rows: object[]): [string, QueryHandler] => ["spark.community_feed", () => rows];
const post = (over: object = {}): [string, QueryHandler] => ["spark.community_post(", () => [postRow(over)]];
const noPost: [string, QueryHandler] = ["spark.community_post(", () => []];
const comments = (rows: object[]): [string, QueryHandler] => ["spark.community_post_comments", () => rows];
const comment = (over: object = {}): [string, QueryHandler] => ["spark.community_comment(", () => [commentRow(over)]];

const feedUrl = `/api/v1/communities/${communityId}/posts`;
const postUrl = `/api/v1/posts/${postId}`;
const commentsUrl = `/api/v1/posts/${postId}/comments`;
const commentUrl = `/api/v1/comments/${commentId}`;
const ifMatch = { "if-match": "\"v3\"" };

describe("GET /communities/{id}/posts", () => {
  it("lists a public feed anonymously with no-store", async () => {
    const { response, calls } = await send({ method: "GET", url: feedUrl, session: "none" }, [detail({ viewer_status: null }), feed([feedRow()])]);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const item = response.json().items[0];
    expect(item).toMatchObject({
      id: postId, communityId, title: "Hello", excerpt: "First post", truncated: false, commentCount: 2, moderation: "visible", version: 1,
      author: { id: authorId, displayName: "Ada", avatarUrl: null },
      viewer: { isAuthor: false, reported: false, canEdit: false, canDelete: false, canReport: false, canModerate: false },
    });
    expect(item).not.toHaveProperty("cursorTs");
    expect(response.json().nextCursor).toBeNull();
    expect(find(calls, "spark.community_feed")?.params).toEqual([communityId, null, null, 20]);
  });

  it("derives viewer flags from the community detail and the row", async () => {
    const rows = [feedRow({ viewer_is_author: true }), feedRow({ id: commentId, viewer_reported: false })];
    const { response } = await send({ method: "GET", url: feedUrl }, [detail({ viewer_status: "moderator" }), feed(rows)]);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    const [mine, other] = response.json().items;
    expect(mine.viewer).toEqual({ isAuthor: true, reported: false, canEdit: true, canDelete: true, canReport: false, canModerate: true });
    expect(other.viewer).toEqual({ isAuthor: false, reported: false, canEdit: false, canDelete: false, canReport: true, canModerate: true });
  });

  it("denies canEdit in a frozen community, for a hidden post and for a non-member", async () => {
    const frozen = await send({ method: "GET", url: feedUrl }, [detail({ frozen: true }), feed([feedRow({ viewer_is_author: true })])]);
    expect(frozen.response.json().items[0].viewer.canEdit).toBe(false);
    const hidden = await send({ method: "GET", url: feedUrl }, [detail(), feed([feedRow({ viewer_is_author: true, moderation_status: "hidden" })])]);
    expect(hidden.response.json().items[0].viewer.canEdit).toBe(false);
    const stranger = await send({ method: "GET", url: feedUrl }, [detail({ viewer_status: null }), feed([feedRow({ viewer_is_author: true })])]);
    expect(stranger.response.json().items[0].viewer.canEdit).toBe(false);
  });

  it("does not offer report on an already reported post", async () => {
    const { response } = await send({ method: "GET", url: feedUrl }, [detail(), feed([feedRow({ viewer_reported: true })])]);
    expect(response.json().items[0].viewer).toMatchObject({ reported: true, canReport: false });
  });

  it("returns nextCursor from the extra row and passes the cursor on", async () => {
    const rows = [feedRow(), feedRow({ id: commentId, cursor_ts: "2026-11-10 08:00:00+00" })];
    const first = await send({ method: "GET", url: `${feedUrl}?limit=1`, session: "none" }, [detail(), feed(rows)]);
    expect(first.response.json().items).toHaveLength(1);
    const cursor = first.response.json().nextCursor as string;
    expect(cursor).toBe(encodeCursor({ createdAt: CREATED_AT, id: postId }));
    expect(find(first.calls, "spark.community_feed")?.params).toEqual([communityId, null, null, 1]);
    const next = await send({ method: "GET", url: `${feedUrl}?cursor=${cursor}&limit=1`, session: "none" }, [detail(), feed([])]);
    expect(find(next.calls, "spark.community_feed")?.params).toEqual([communityId, CREATED_AT, postId, 1]);
  });

  it("rejects an invalid cursor with 400 invalid_cursor", async () => {
    const { response, calls } = await send({ method: "GET", url: `${feedUrl}?cursor=%25%25%25`, session: "none" });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("invalid_cursor");
    expect(called(calls, "spark.community_feed")).toBe(false);
  });

  it.each(["limit=0", "limit=51", "extra=1"])("rejects %s with 400", async (query) => {
    const { response } = await send({ method: "GET", url: `${feedUrl}?${query}`, session: "none" });
    expect(response.statusCode).toBe(400);
  });

  it("answers 401 for a private feed without a session and 403 members_only with one", async () => {
    const denied: [string, QueryHandler] = ["spark.community_feed", () => pgError("42501", "Community members only")];
    const anonymous = await send({ method: "GET", url: feedUrl, session: "none" }, [denied]);
    expect(anonymous.response.statusCode).toBe(401);
    expect(anonymous.response.json().code).toBe("unauthenticated");
    const signedIn = await send({ method: "GET", url: feedUrl }, [denied]);
    expect(signedIn.response.statusCode).toBe(403);
    expect(signedIn.response.json().code).toBe("members_only");
    expect(signedIn.response.headers["cache-control"]).toBe("private, no-store");
  });

  it("maps P0002 Community not found to 404 and any other 42501 stays 500", async () => {
    const missing = await send({ method: "GET", url: feedUrl, session: "none" }, [["spark.community_feed", () => pgError("P0002", "Community not found")]]);
    expect(missing.response.statusCode).toBe(404);
    expect(missing.response.json().code).toBe("community_not_found");
    const other = await send({ method: "GET", url: feedUrl }, [["spark.community_feed", () => pgError("42501", "permission denied for function")]]);
    expect(other.response.statusCode).toBe(500);
  });

  it("treats an expired cookie as anonymous", async () => {
    const { response } = await send({ method: "GET", url: feedUrl, session: "expired" }, [detail({ viewer_status: null }), feed([feedRow()])]);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});

describe("GET /posts/{id}", () => {
  it("returns the detail with ETag and flags from community_post", async () => {
    const { response } = await send({ method: "GET", url: postUrl, session: "none" }, [post({ viewer_is_author: false, viewer_is_member: false })]);
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe("\"v3\"");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      id: postId, communityId, communitySlug: "night-owls", body: "First post body", title: "Hello", version: 3, commentCount: 2,
      author: { id: authorId },
      viewer: { isAuthor: false, canEdit: false, canDelete: false, canReport: false, canModerate: false },
    });
    expect(response.json()).not.toHaveProperty("excerpt");
  });

  it("lets the author edit and delete, a moderator moderate", async () => {
    const own = await send({ method: "GET", url: postUrl }, [post()]);
    expect(own.response.json().viewer).toMatchObject({ isAuthor: true, canEdit: true, canDelete: true, canReport: false });
    const staff = await send({ method: "GET", url: postUrl }, [post({ viewer_is_author: false, viewer_can_moderate: true })]);
    expect(staff.response.json().viewer).toMatchObject({ canModerate: true, canReport: true, canEdit: false });
    const frozen = await send({ method: "GET", url: postUrl }, [post({ community_frozen: true })]);
    expect(frozen.response.json().viewer).toMatchObject({ canEdit: false, canDelete: true });
  });

  it("answers 404 post_not_found when unreadable and 400 for a bad id", async () => {
    const missing = await send({ method: "GET", url: postUrl, session: "none" }, [noPost]);
    expect(missing.response.statusCode).toBe(404);
    expect(missing.response.json().code).toBe("post_not_found");
    const bad = await send({ method: "GET", url: "/api/v1/posts/nope", session: "none" });
    expect(bad.response.statusCode).toBe(400);
  });
});

describe("POST /communities/{id}/posts", () => {
  const create = (outcome: string, id: string | null = null): [string, QueryHandler] => ["spark.ws_create_post", () => [{ outcome, post_id: id }]];
  const payload = { title: "Hello", body: "First post body" };

  it("creates with 201, Location and ETag", async () => {
    const { response, calls } = await send({ method: "POST", url: feedUrl, payload }, [create("created", postId), post()]);
    expect(response.statusCode).toBe(201);
    expect(response.headers.location).toBe(`/api/v1/posts/${postId}`);
    expect(response.headers.etag).toBe("\"v3\"");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["idempotent-replayed"]).toBeUndefined();
    expect(response.json()).toMatchObject({ id: postId, body: "First post body" });
    const params = find(calls, "spark.ws_create_post")?.params;
    expect(params?.slice(0, 4)).toEqual([communityId, "Hello", "First post body", null]);
    expect(Buffer.isBuffer(params?.[4])).toBe(true);
  });

  it("passes the Idempotency-Key and marks a replay", async () => {
    const { response, calls } = await send({ method: "POST", url: feedUrl, payload, headers: { "idempotency-key": "key-1" } }, [create("replayed", postId), post()]);
    expect(response.statusCode).toBe(201);
    expect(response.headers["idempotent-replayed"]).toBe("true");
    expect(find(calls, "spark.ws_create_post")?.params[3]).toBe("key-1");
  });

  it("answers 404 post_not_found when a replayed post can no longer be read", async () => {
    const { response } = await send({ method: "POST", url: feedUrl, payload, headers: { "idempotency-key": "key-1" } }, [create("replayed", postId), noPost]);
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("post_not_found");
  });

  it("answers 500 when a created post cannot be read back", async () => {
    const { response } = await send({ method: "POST", url: feedUrl, payload }, [create("created", postId), noPost]);
    expect(response.statusCode).toBe(500);
  });

  it.each([
    ["idempotency_conflict", 409, "idempotency_key_reused"],
    ["community_frozen", 409, "community_frozen"],
    ["not_a_member", 403, "not_a_member"],
    ["not_found", 404, "community_not_found"],
  ])("maps %s to %i %s", async (outcome, status, code) => {
    const { response } = await send({ method: "POST", url: feedUrl, payload }, [create(outcome)]);
    expect(response.statusCode).toBe(status);
    expect(response.json().code).toBe(code);
  });

  it("answers 500 for an unexpected outcome", async () => {
    const { response } = await send({ method: "POST", url: feedUrl, payload }, [create("surprise")]);
    expect(response.statusCode).toBe(500);
  });

  it("rejects an invalid Idempotency-Key with 400 and no SQL", async () => {
    const { response, calls } = await send({ method: "POST", url: feedUrl, payload, headers: { "idempotency-key": "bad key!" } });
    expect(response.statusCode).toBe(400);
    expect(called(calls, "spark.ws_create_post")).toBe(false);
  });

  it.each([
    [{ title: "x".repeat(151), body: "b" }],
    [{ title: "t", body: "x".repeat(10001) }],
    [{ title: "t", body: "b", extra: 1 }],
    [{ title: "t" }],
    [{ title: "t", body: "b\u0000" }],
    [{ title: { text: "t" }, body: "b" }],
  ])("rejects an invalid body with 400 and no SQL (%#)", async (invalid) => {
    const { response, calls } = await send({ method: "POST", url: feedUrl, payload: invalid });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("bad_request");
    expect(called(calls, "spark.ws_")).toBe(false);
  });

  it.each(["Invalid post title", "Invalid post body", "Invalid idempotency key"])("maps 22023 %s to invalid_input", async (message) => {
    const { response } = await send({ method: "POST", url: feedUrl, payload }, [["spark.ws_create_post", () => pgError("22023", message)]]);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_input", detail: `${message}.` });
  });

  it.each(["40001", "40P01"])("maps %s to 503 retry_later with Retry-After", async (code) => {
    const { response } = await send({ method: "POST", url: feedUrl, payload }, [["spark.ws_create_post", () => dbError(code)]]);
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe("retry_later");
    expect(response.headers["retry-after"]).toBe("1");
  });
});

describe("PATCH /posts/{id}", () => {
  const update = (outcome: string, version: number | null = null): [string, QueryHandler] => ["spark.ws_update_post", () => [{ outcome, version }]];

  it("updates with 200 and the new ETag", async () => {
    const { response, calls } = await send({ method: "PATCH", url: postUrl, payload: { title: "New" }, headers: ifMatch }, [update("ok", 4), post({ version: 4 })]);
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe("\"v4\"");
    expect(find(calls, "spark.ws_update_post")?.params).toEqual([postId, 3, "New", null]);
  });

  it("requires If-Match (428) and rejects a malformed one (400)", async () => {
    const missing = await send({ method: "PATCH", url: postUrl, payload: { title: "New" } });
    expect(missing.response.statusCode).toBe(428);
    expect(called(missing.calls, "spark.ws_update_post")).toBe(false);
    const malformed = await send({ method: "PATCH", url: postUrl, payload: { title: "New" }, headers: { "if-match": "W/\"v3\"" } });
    expect(malformed.response.statusCode).toBe(400);
    expect(malformed.response.json().code).toBe("invalid_if_match");
  });

  it("answers 412 with the current post when stale", async () => {
    const { response } = await send({ method: "PATCH", url: postUrl, payload: { body: "New" }, headers: ifMatch }, [update("version_mismatch", 5), post({ version: 5 })]);
    expect(response.statusCode).toBe(412);
    expect(response.json()).toMatchObject({ code: "version_mismatch", current: { id: postId, version: 5 } });
  });

  it.each([
    ["not_author", 403, "not_author"],
    ["not_a_member", 403, "not_a_member"],
    ["community_frozen", 409, "community_frozen"],
    ["content_hidden", 409, "content_hidden"],
    ["not_found", 404, "post_not_found"],
  ])("maps %s to %i %s", async (outcome, status, code) => {
    const { response } = await send({ method: "PATCH", url: postUrl, payload: { title: "New" }, headers: ifMatch }, [update(outcome)]);
    expect(response.statusCode).toBe(status);
    expect(response.json().code).toBe(code);
  });

  it.each([[{}], [{ title: "x".repeat(151) }], [{ title: "a", extra: 1 }]])("rejects an invalid body with 400 and no SQL (%#)", async (payload) => {
    const { response, calls } = await send({ method: "PATCH", url: postUrl, payload, headers: ifMatch });
    expect(response.statusCode).toBe(400);
    expect(called(calls, "spark.ws_")).toBe(false);
  });

  it("answers 500 for an unexpected outcome", async () => {
    const { response } = await send({ method: "PATCH", url: postUrl, payload: { title: "New" }, headers: ifMatch }, [update("surprise")]);
    expect(response.statusCode).toBe(500);
  });
});

describe("DELETE /posts/{id}", () => {
  const remove = (outcome: string): [string, QueryHandler] => ["spark.ws_delete_post", () => [{ outcome }]];

  it("answers 204", async () => {
    const { response, calls } = await send({ method: "DELETE", url: postUrl }, [remove("ok")]);
    expect(response.statusCode).toBe(204);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(find(calls, "spark.ws_delete_post")?.params).toEqual([postId]);
  });

  it.each([
    ["not_author", 403, "not_author"],
    ["not_found", 404, "post_not_found"],
  ])("maps %s to %i", async (outcome, status, code) => {
    const { response } = await send({ method: "DELETE", url: postUrl }, [remove(outcome)]);
    expect(response.statusCode).toBe(status);
    expect(response.json().code).toBe(code);
  });

  it("answers 500 for an unexpected outcome", async () => {
    const { response } = await send({ method: "DELETE", url: postUrl }, [remove("surprise")]);
    expect(response.statusCode).toBe(500);
  });
});

describe("GET /posts/{id}/comments", () => {
  it("lists comments with flags from community_post", async () => {
    const { response, calls } = await send({ method: "GET", url: commentsUrl, session: "none" }, [
      comments([commentRow({ viewer_is_author: false })]),
      post({ viewer_is_author: false, viewer_is_member: false }),
    ]);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const item = response.json().items[0];
    expect(item).toMatchObject({
      id: commentId, postId, body: "Nice", moderation: "visible", version: 2, author: { id: authorId },
      viewer: { isAuthor: false, canEdit: false, canDelete: false, canReport: false, canModerate: false },
    });
    expect(item).not.toHaveProperty("cursorTs");
    expect(find(calls, "spark.community_post_comments")?.params).toEqual([postId, null, null, 20]);
  });

  it("enables edit for the author member and moderation for staff", async () => {
    const own = await send({ method: "GET", url: commentsUrl }, [comments([commentRow()]), post()]);
    expect(own.response.json().items[0].viewer).toMatchObject({ canEdit: true, canDelete: true, canReport: false });
    const staff = await send({ method: "GET", url: commentsUrl }, [comments([commentRow({ viewer_is_author: false })]), post({ viewer_can_moderate: true })]);
    expect(staff.response.json().items[0].viewer).toMatchObject({ canModerate: true, canReport: true, canEdit: false });
  });

  it("pages with the extra row", async () => {
    const rows = [commentRow(), commentRow({ id: postId, cursor_ts: "2026-11-10 11:00:00+00" })];
    const { response } = await send({ method: "GET", url: `${commentsUrl}?limit=1`, session: "none" }, [comments(rows), post()]);
    expect(response.json().items).toHaveLength(1);
    expect(response.json().nextCursor).toBe(encodeCursor({ createdAt: "2026-11-10 10:00:00+00", id: commentId }));
  });

  it("rejects an invalid cursor and maps P0002 Post not found", async () => {
    const bad = await send({ method: "GET", url: `${commentsUrl}?cursor=zzz!`, session: "none" });
    expect(bad.response.statusCode).toBe(400);
    expect(bad.response.json().code).toBe("invalid_cursor");
    const missing = await send({ method: "GET", url: commentsUrl, session: "none" }, [["spark.community_post_comments", () => pgError("P0002", "Post not found")]]);
    expect(missing.response.statusCode).toBe(404);
    expect(missing.response.json().code).toBe("post_not_found");
  });
});

describe("POST /posts/{id}/comments", () => {
  const create = (outcome: string, id: string | null = null): [string, QueryHandler] => ["spark.ws_create_comment", () => [{ outcome, comment_id: id }]];
  const payload = { body: "Nice" };

  it("creates with 201, Location and ETag", async () => {
    const { response, calls } = await send({ method: "POST", url: commentsUrl, payload }, [create("created", commentId), comment(), post()]);
    expect(response.statusCode).toBe(201);
    expect(response.headers.location).toBe(`/api/v1/comments/${commentId}`);
    expect(response.headers.etag).toBe("\"v2\"");
    expect(response.json()).toMatchObject({ id: commentId, postId, viewer: { canEdit: true } });
    const params = find(calls, "spark.ws_create_comment")?.params;
    expect(params?.slice(0, 3)).toEqual([postId, "Nice", null]);
  });

  it("marks a replay and answers 404 comment_not_found when it is gone", async () => {
    const headers = { "idempotency-key": "k:1" };
    const replay = await send({ method: "POST", url: commentsUrl, payload, headers }, [create("replayed", commentId), comment(), post()]);
    expect(replay.response.statusCode).toBe(201);
    expect(replay.response.headers["idempotent-replayed"]).toBe("true");
    const gone = await send({ method: "POST", url: commentsUrl, payload, headers }, [create("replayed", commentId), ["spark.community_comment(", () => []]]);
    expect(gone.response.statusCode).toBe(404);
    expect(gone.response.json().code).toBe("comment_not_found");
  });

  it.each([
    ["idempotency_conflict", 409, "idempotency_key_reused"],
    ["community_frozen", 409, "community_frozen"],
    ["content_hidden", 409, "content_hidden"],
    ["not_a_member", 403, "not_a_member"],
    ["not_found", 404, "post_not_found"],
  ])("maps %s to %i %s", async (outcome, status, code) => {
    const { response } = await send({ method: "POST", url: commentsUrl, payload }, [create(outcome)]);
    expect(response.statusCode).toBe(status);
    expect(response.json().code).toBe(code);
  });

  it("rejects a bad key, an oversized or unknown body with no SQL", async () => {
    for (const req of [
      { payload, headers: { "idempotency-key": "bad key" } },
      { payload: { body: "x".repeat(2001) } },
      { payload: { body: "x", extra: true } },
      { payload: {} },
    ]) {
      const { response, calls } = await send({ method: "POST", url: commentsUrl, ...req });
      expect(response.statusCode).toBe(400);
      expect(called(calls, "spark.ws_")).toBe(false);
    }
  });

  it("answers 500 for an unexpected outcome and 503 for a deadlock", async () => {
    const odd = await send({ method: "POST", url: commentsUrl, payload }, [create("surprise")]);
    expect(odd.response.statusCode).toBe(500);
    const dead = await send({ method: "POST", url: commentsUrl, payload }, [["spark.ws_create_comment", () => dbError("40P01")]]);
    expect(dead.response.statusCode).toBe(503);
    expect(dead.response.headers["retry-after"]).toBe("1");
  });

  it("maps 22023 Invalid comment body to invalid_input", async () => {
    const { response } = await send({ method: "POST", url: commentsUrl, payload }, [["spark.ws_create_comment", () => pgError("22023", "Invalid comment body")]]);
    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toBe("Invalid comment body.");
  });
});

describe("PATCH /comments/{id}", () => {
  const update = (outcome: string, version: number | null = null): [string, QueryHandler] => ["spark.ws_update_comment", () => [{ outcome, version }]];
  const headers = { "if-match": "\"v2\"" };

  it("updates with 200 and the new ETag", async () => {
    const { response, calls } = await send({ method: "PATCH", url: commentUrl, payload: { body: "Edited" }, headers }, [update("ok", 3), comment({ version: 3 }), post()]);
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe("\"v3\"");
    expect(find(calls, "spark.ws_update_comment")?.params).toEqual([commentId, 2, "Edited"]);
  });

  it("requires If-Match and answers 412 with current when stale", async () => {
    const missing = await send({ method: "PATCH", url: commentUrl, payload: { body: "Edited" } });
    expect(missing.response.statusCode).toBe(428);
    const stale = await send({ method: "PATCH", url: commentUrl, payload: { body: "Edited" }, headers }, [update("version_mismatch", 4), comment({ version: 4 }), post()]);
    expect(stale.response.statusCode).toBe(412);
    expect(stale.response.json()).toMatchObject({ code: "version_mismatch", current: { id: commentId, version: 4 } });
  });

  it.each([
    ["not_author", 403, "not_author"],
    ["not_a_member", 403, "not_a_member"],
    ["community_frozen", 409, "community_frozen"],
    ["content_hidden", 409, "content_hidden"],
    ["not_found", 404, "comment_not_found"],
  ])("maps %s to %i %s", async (outcome, status, code) => {
    const { response } = await send({ method: "PATCH", url: commentUrl, payload: { body: "Edited" }, headers }, [update(outcome)]);
    expect(response.statusCode).toBe(status);
    expect(response.json().code).toBe(code);
  });

  it.each([[{}], [{ body: "x".repeat(2001) }], [{ body: "a", extra: 1 }]])("rejects an invalid body with 400 (%#)", async (payload) => {
    const { response, calls } = await send({ method: "PATCH", url: commentUrl, payload, headers });
    expect(response.statusCode).toBe(400);
    expect(called(calls, "spark.ws_")).toBe(false);
  });
});

describe("DELETE /comments/{id}", () => {
  const remove = (outcome: string): [string, QueryHandler] => ["spark.ws_delete_comment", () => [{ outcome }]];

  it("answers 204, 403 and 404", async () => {
    const ok = await send({ method: "DELETE", url: commentUrl }, [remove("ok")]);
    expect(ok.response.statusCode).toBe(204);
    expect(find(ok.calls, "spark.ws_delete_comment")?.params).toEqual([commentId]);
    const other = await send({ method: "DELETE", url: commentUrl }, [remove("not_author")]);
    expect(other.response.statusCode).toBe(403);
    expect(other.response.json().code).toBe("not_author");
    const missing = await send({ method: "DELETE", url: commentUrl }, [remove("not_found")]);
    expect(missing.response.statusCode).toBe(404);
    expect(missing.response.json().code).toBe("comment_not_found");
    const odd = await send({ method: "DELETE", url: commentUrl }, [remove("surprise")]);
    expect(odd.response.statusCode).toBe(500);
  });
});

const writes: Call[] = [
  { method: "POST", url: feedUrl, payload: { title: "t", body: "b" } },
  { method: "PATCH", url: postUrl, payload: { title: "t" }, headers: ifMatch },
  { method: "DELETE", url: postUrl },
  { method: "POST", url: commentsUrl, payload: { body: "b" } },
  { method: "PATCH", url: commentUrl, payload: { body: "b" }, headers: { "if-match": "\"v2\"" } },
  { method: "DELETE", url: commentUrl },
];

describe("content writes need a session and a same-origin caller", () => {
  it.each(writes)("$method $url answers 401 unauthenticated without a cookie", async (route) => {
    const { response, calls } = await send({ ...route, session: "none" });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("unauthenticated");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(called(calls, "spark.ws_")).toBe(false);
  });

  it.each(writes)("$method $url answers 401 session_expired for an invalid session", async (route) => {
    const { response } = await send({ ...route, session: "expired" });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("session_expired");
  });

  it.each(writes)("$method $url answers 403 origin_not_allowed cross-origin", async (route) => {
    const { response, calls } = await send({ ...route, headers: { ...route.headers, origin: "https://evil.example" } });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("origin_not_allowed");
    expect(calls).toHaveLength(0);
  });
});

describe("member rate limit key", () => {
  it("keys on the session token hash and falls back to the address", () => {
    const a = memberRateKey({ headers: { cookie: "spark_session=aaaa" }, ip: "1.2.3.4" });
    const b = memberRateKey({ headers: { cookie: "spark_session=bbbb" }, ip: "1.2.3.4" });
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
    expect(a).not.toBe(b);
    expect(memberRateKey({ headers: { cookie: "spark_session=aaaa" }, ip: "9.9.9.9" })).toBe(a);
    expect(a).not.toContain("aaaa");
    expect(memberRateKey({ headers: {}, ip: "1.2.3.4" })).toBe("1.2.3.4");
  });
});
