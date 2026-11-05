import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { dbError, fakePool, principalRow, type QueryHandler } from "./fake-pool.js";

const config = loadConfig({ NODE_ENV: "test" });
const cookie = `spark_session=${"c".repeat(64)}`;
const base = "/api/v1/communities";

type Calls = Array<{ sql: string; params: unknown[] }>;

async function call(url: string, handlers: Array<[string, QueryHandler]> = [], session: "none" | "valid" | "expired" = "none") {
  const { pool, calls } = fakePool([["auth_session_principal", session === "valid" ? () => [principalRow] : () => []], ...handlers]);
  const app = await buildApp({ config, pool, rateLimit: false, logger: false });
  try {
    const response = await app.inject({ method: "GET", url, headers: session === "none" ? {} : { cookie } });
    return { response, calls };
  } finally {
    await app.close();
  }
}

const find = (calls: Calls, fragment: string) => calls.find((c) => c.sql.includes(fragment));
const called = (calls: Calls, fragment: string) => calls.some((c) => c.sql.includes(fragment));
const sessionSet = (calls: Calls) => called(calls, "spark.session_token_hash");

const id1 = "11111111-1111-4111-8111-111111111111";
const id2 = "22222222-2222-4222-8222-222222222222";

const cardRow = (over: object = {}) => ({
  id: id1,
  slug: "saas-founders",
  name: "SaaS Founders",
  tagline: "Grow B2B",
  visibility: "public",
  country_code: "DE",
  city: "Berlin",
  stage: "pre_seed",
  topics: ["b2b-saas", "founders"],
  member_count: "12",
  weekly_posts: "3",
  featured: true,
  frozen: false,
  host_workspace_name: "Northstar",
  viewer_status: null,
  cursor_name: "saas founders",
  ...over,
});
const detailRow = (over: object = {}) => ({
  ...cardRow(),
  description: "A place to talk",
  created_at: new Date("2026-10-01T10:00:00Z"),
  settings_version: 4,
  can_manage: false,
  host_admin: false,
  ...over,
});
const listHandler = (rows: object[]): [string, QueryHandler] => ["spark.discover_communities", () => rows];

describe("GET /communities", () => {
  it("lists cards for an anonymous visitor with no session setting", async () => {
    const { response, calls } = await call(base, [listHandler([cardRow()])]);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      items: [{
        id: id1,
        slug: "saas-founders",
        name: "SaaS Founders",
        tagline: "Grow B2B",
        visibility: "public",
        location: { countryCode: "DE", city: "Berlin" },
        stage: { code: "pre_seed", label: "Pre-seed" },
        topics: [{ slug: "b2b-saas", name: "B2B SaaS" }, { slug: "founders", name: "Founders Circle" }],
        memberCount: 12,
        weeklyPosts: 3,
        featured: true,
        frozen: false,
        host: { name: "Northstar" },
        viewerStatus: null,
      }],
      nextCursor: null,
    });
    expect(sessionSet(calls)).toBe(false);
    expect(find(calls, "spark.discover_communities")?.params).toEqual([null, null, null, null, null, null, 20]);
  });

  it("runs as the session and marks the response private", async () => {
    const { response, calls } = await call(base, [listHandler([cardRow({ viewer_status: "member" })])], "valid");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(sessionSet(calls)).toBe(true);
    expect(response.json().items[0].viewerStatus).toBe("member");
  });

  it("treats an expired or invalid cookie as anonymous, not 401", async () => {
    const { response, calls } = await call(base, [listHandler([cardRow()])], "expired");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(sessionSet(calls)).toBe(false);
  });

  it("passes the filters to the database", async () => {
    const { response, calls } = await call(`${base}?q=saas&topic=fintech&country=DE&stage=seed&limit=5`, [listHandler([])]);
    expect(response.statusCode).toBe(200);
    expect(find(calls, "spark.discover_communities")?.params).toEqual(["saas", "fintech", "DE", "seed", null, null, 5]);
  });

  it.each([
    "topic=crypto",
    "stage=late",
    "country=de",
    "country=DEU",
    "limit=0",
    "limit=51",
    "limit=abc",
    `q=${"x".repeat(101)}`,
    "unknown=1",
  ])("rejects ?%s with 400", async (query) => {
    const { response, calls } = await call(`${base}?${query}`, [listHandler([])]);
    expect(response.statusCode).toBe(400);
    expect(called(calls, "spark.discover_communities")).toBe(false);
  });

  it.each(["!!!", Buffer.from("not json").toString("base64url"), Buffer.from(JSON.stringify({ t: "a", id: "nope" })).toString("base64url"), Buffer.from(JSON.stringify({ t: 5, id: id1 })).toString("base64url")])(
    "rejects cursor %s with invalid_cursor",
    async (cursor) => {
      const { response, calls } = await call(`${base}?cursor=${cursor}`, [listHandler([])]);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_cursor" });
      expect(called(calls, "spark.discover_communities")).toBe(false);
    },
  );

  it("builds nextCursor from the last visible row when an extra row exists", async () => {
    const rows = [cardRow({ id: id1, cursor_name: "alpha" }), cardRow({ id: id2, slug: "b", cursor_name: "beta" }), cardRow({ id: "33333333-3333-4333-8333-333333333333", slug: "c", cursor_name: "gamma" })];
    const { response } = await call(`${base}?limit=2`, [listHandler(rows)]);
    const body = response.json();
    expect(body.items).toHaveLength(2);
    expect(JSON.parse(Buffer.from(body.nextCursor, "base64url").toString("utf8"))).toEqual({ t: "beta", id: id2 });
  });

  it("round-trips the cursor into the next query and has no cursor on the last page", async () => {
    const cursor = Buffer.from(JSON.stringify({ t: "beta", id: id2 })).toString("base64url");
    const { response, calls } = await call(`${base}?cursor=${cursor}&limit=2`, [listHandler([cardRow()])]);
    expect(response.statusCode).toBe(200);
    expect(response.json().nextCursor).toBeNull();
    expect(find(calls, "spark.discover_communities")?.params).toEqual([null, null, null, null, "beta", id2, 2]);
  });

  it("maps a whitelisted database input error to 400 invalid_input", async () => {
    const error = Object.assign(new Error("Invalid community search"), { code: "22023" });
    const { response } = await call(base, [["spark.discover_communities", () => error]]);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_input", detail: "Invalid community search." });
  });

  it("never exposes reviewer ids or emails", async () => {
    const { response } = await call(base, [listHandler([cardRow({ reviewed_by_user_id: id2, email: "a@b.c" })])]);
    expect(response.body).not.toMatch(/reviewed_by|email|a@b\.c/u);
  });
});

describe("GET /communities/filters", () => {
  it("groups options by kind with numeric counts", async () => {
    const rows = [
      { kind: "topic", value: "fintech", label: "FinTech", count: "2" },
      { kind: "stage", value: "seed", label: "Seed", count: "0" },
      { kind: "country", value: "DE", label: "DE", count: "5" },
    ];
    const { response } = await call(`${base}/filters`, [["spark.community_filter_values", () => rows]]);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      topics: [{ value: "fintech", label: "FinTech", count: 2 }],
      stages: [{ value: "seed", label: "Seed", count: 0 }],
      countries: [{ value: "DE", label: "DE", count: 5 }],
    });
  });
});

describe("GET /communities/{slug}", () => {
  it("returns the detail with an ETag from the settings version", async () => {
    const { response, calls } = await call(`${base}/saas-founders`, [["spark.community_by_slug", () => [detailRow()]]]);
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"v4"');
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({ slug: "saas-founders", description: "A place to talk", createdAt: "2026-10-01T10:00:00.000Z", canManage: false, version: 4 });
    expect(find(calls, "spark.community_by_slug")?.params).toEqual(["saas-founders"]);
    expect(sessionSet(calls)).toBe(false);
  });

  it("reports canManage with a session and a private cache", async () => {
    const { response, calls } = await call(`${base}/saas-founders`, [["spark.community_by_slug", () => [detailRow({ can_manage: true, viewer_status: "owner" })]]], "valid");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toMatchObject({ canManage: true, viewerStatus: "owner" });
    expect(sessionSet(calls)).toBe(true);
  });

  it.each([
    ["a community owner", { can_manage: true, viewer_status: "owner", host_admin: false }, true],
    ["a host workspace admin who is a community moderator", { can_manage: true, viewer_status: "moderator", host_admin: true }, true],
    ["a host workspace admin who is not a member", { can_manage: true, viewer_status: null, host_admin: true }, true],
    ["a plain moderator", { can_manage: true, viewer_status: "moderator", host_admin: false }, false],
    ["a member", { can_manage: false, viewer_status: "member", host_admin: false }, false],
  ])("decides canGovern on the server for %s", async (_who, row, expected) => {
    const { response, calls } = await call(`${base}/saas-founders`, [["spark.community_by_slug", () => [detailRow(row)]]], "valid");
    expect(response.statusCode).toBe(200);
    expect(response.json().canGovern).toBe(expected);
    expect(find(calls, "spark.community_by_slug")?.sql).toContain("spark.is_workspace_member(c.tenant_id, ARRAY['owner','admin'])");
  });

  it("never gives an anonymous visitor canGovern", async () => {
    const { response } = await call(`${base}/saas-founders`, [["spark.community_by_slug", () => [detailRow({ host_admin: true, viewer_status: null })]]]);
    expect(response.json().canGovern).toBe(false);
  });

  it("answers 404 community_not_found for an empty result", async () => {
    const { response } = await call(`${base}/ghost`, [["spark.community_by_slug", () => []]]);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "community_not_found" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});

describe("GET /me/communities", () => {
  const url = "/api/v1/me/communities";

  it("answers 401 without a cookie", async () => {
    const { response, calls } = await call(url);
    expect(response.statusCode).toBe(401);
    expect(called(calls, "spark.my_communities")).toBe(false);
  });

  it("answers 401 for an expired session", async () => {
    const { response } = await call(url, [], "expired");
    expect(response.statusCode).toBe(401);
  });

  it("answers 401 when the session ends before the read", async () => {
    const error = Object.assign(new Error("Live session required"), { code: "28000" });
    const { response } = await call(url, [["spark.my_communities", () => error]], "valid");
    expect(response.statusCode).toBe(401);
  });

  it("lists the actor's memberships privately", async () => {
    const { response, calls } = await call(url, [["spark.my_communities", () => [cardRow({ viewer_status: "moderator" })]]], "valid");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json().items).toHaveLength(1);
    expect(response.json().items[0].viewerStatus).toBe("moderator");
    expect(sessionSet(calls)).toBe(true);
  });

  it("does not hide unrelated database errors", async () => {
    const { response } = await call(url, [["spark.my_communities", () => dbError("XX000")]], "valid");
    expect(response.statusCode).toBe(500);
  });
});

describe("discovery input edge cases", () => {
  it("sets Cache-Control on an invalid cursor too", async () => {
    const anonymous = await call(`${base}?cursor=!!!`, [listHandler([])]);
    expect(anonymous.response.statusCode).toBe(400);
    expect(anonymous.response.headers["cache-control"]).toBe("no-store");
    const signedIn = await call(`${base}?cursor=!!!`, [listHandler([])], "valid");
    expect(signedIn.response.headers["cache-control"]).toBe("private, no-store");
  });

  it("answers invalid_cursor for an over-long cursor", async () => {
    const { response, calls } = await call(`${base}?cursor=${"A".repeat(400)}`, [listHandler([])]);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_cursor" });
    expect(called(calls, "spark.discover_communities")).toBe(false);
  });

  it("rejects a NUL byte in q with 400 before the database", async () => {
    const { response, calls } = await call(`${base}?q=a%00b`, [listHandler([])]);
    expect(response.statusCode).toBe(400);
    expect(called(calls, "spark.discover_communities")).toBe(false);
  });

  it("rejects a NUL byte in the slug with 400 before the database", async () => {
    const { response, calls } = await call(`${base}/a%00b`, [["spark.community_by_slug", () => [detailRow()]]]);
    expect(response.statusCode).toBe(400);
    expect(called(calls, "spark.community_by_slug")).toBe(false);
  });
});
