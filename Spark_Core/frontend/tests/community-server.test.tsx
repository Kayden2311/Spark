import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notFound = vi.hoisted(() => vi.fn(() => {
  throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
}));
vi.mock("next/navigation", () => ({ notFound, useRouter: () => ({ push: vi.fn() }) }));
const incoming = vi.hoisted(() => ({ cookie: "spark_session=abc" as string | null, forwarded: null as string | null, realIp: null as string | null }));
vi.mock("next/headers", () => ({
  headers: async () => {
    const values: Record<string, string> = {};
    if (incoming.cookie) values.cookie = incoming.cookie;
    if (incoming.forwarded) values["x-forwarded-for"] = incoming.forwarded;
    if (incoming.realIp) values["x-real-ip"] = incoming.realIp;
    return new Headers(values);
  },
}));
vi.mock("../src/app/communities/[slug]/community-view", () => ({ CommunityView: () => null }));
vi.mock("../src/app/communities/[slug]/posts/[postId]/post-view", () => ({ PostView: () => null }));

import CommunityPage from "../src/app/communities/[slug]/page";
import PostNotFound from "../src/app/communities/[slug]/posts/[postId]/not-found";
import PostPage from "../src/app/communities/[slug]/posts/[postId]/page";
import { serverGet } from "../src/app/_lib/server-api";
import { json } from "./community-fixtures";
import { postDetail } from "./community-fixtures";

const POST_ID = "3f0c3a52-6d55-4d6c-9f55-0a1d9d2a7d11";

function stubApi(respond: (path: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    return respond(new URL(String(input)).pathname);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("server-side lookups", () => {
  beforeEach(() => {
    notFound.mockClear();
    incoming.cookie = "spark_session=abc";
    incoming.forwarded = null;
    incoming.realIp = null;
    delete process.env.SPARK_API_ORIGIN;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("serverGet forwards the cookie to the API origin and returns the status and body", async () => {
    process.env.SPARK_API_ORIGIN = "http://api.internal:4000";
    const fetchMock = stubApi(() => json({ ok: true }));
    const result = await serverGet("/api/v1/communities/x");
    expect(result).toEqual({ status: 200, body: { ok: true } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://api.internal:4000/api/v1/communities/x");
    expect((init?.headers as Record<string, string>).cookie).toBe("spark_session=abc");
    expect(init?.cache).toBe("no-store");
  });

  it("serverGet defaults to the local API and sends no cookie header when there is none", async () => {
    incoming.cookie = null;
    const fetchMock = stubApi(() => json({}, 404));
    expect((await serverGet("/api/v1/x")).status).toBe(404);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:4000/api/v1/x");
    expect((init?.headers as Record<string, string>).cookie).toBeUndefined();
  });

  it("serverGet forwards the visitor's address so the API limits per client, not per Next server", async () => {
    incoming.forwarded = "203.0.113.7, 10.0.0.2";
    const fetchMock = stubApi(() => json({}));
    await serverGet("/api/v1/x");
    expect((fetchMock.mock.calls[0]![1]?.headers as Record<string, string>)["x-forwarded-for"]).toBe("203.0.113.7, 10.0.0.2");

    incoming.realIp = "198.51.100.9";
    incoming.forwarded = "203.0.113.7";
    await serverGet("/api/v1/x");
    expect((fetchMock.mock.calls[1]![1]?.headers as Record<string, string>)["x-forwarded-for"]).toBe("203.0.113.7, 198.51.100.9");

    incoming.forwarded = null;
    incoming.realIp = null;
    await serverGet("/api/v1/x");
    expect((fetchMock.mock.calls[2]![1]?.headers as Record<string, string>)["x-forwarded-for"]).toBeUndefined();
  });

  it("serverGet reports a network failure as status 0", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    expect(await serverGet("/api/v1/x")).toEqual({ status: 0, body: null });
  });
});

describe("community page (server)", () => {
  beforeEach(() => {
    notFound.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("answers not found for an unknown or hidden community", async () => {
    stubApi(() => json({ code: "community_not_found", detail: "Community not found." }, 404));
    await expect(CommunityPage({ params: Promise.resolve({ slug: "nope" }) })).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it("answers not found for a slug that cannot exist without asking the API", async () => {
    const fetchMock = stubApi(() => json({ id: "c1" }));
    for (const slug of ["Bad_Slug", "a", "-x-", "x".repeat(41), "../etc"]) {
      await expect(CommunityPage({ params: Promise.resolve({ slug }) })).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders the client view for a readable community", async () => {
    const fetchMock = stubApi(() => json({ id: "c1" }));
    const element = await CommunityPage({ params: Promise.resolve({ slug: "northstar-founders" }) });
    expect(element.props.slug).toBe("northstar-founders");
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/v1/communities/northstar-founders");
    expect(notFound).not.toHaveBeenCalled();
  });

  it.each([500, 503, 401, 403, 0])("does not turn a %s answer into a 404", async (status) => {
    if (status === 0) vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("down"))));
    else stubApi(() => json({ code: "x", detail: "x" }, status));
    const element = await CommunityPage({ params: Promise.resolve({ slug: "northstar-founders" }) });
    expect(element.props.slug).toBe("northstar-founders");
    expect(notFound).not.toHaveBeenCalled();
  });
});

describe("post page (server)", () => {
  beforeEach(() => {
    notFound.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());
  const params = (slug = "northstar-founders", postId = POST_ID) => ({ params: Promise.resolve({ slug, postId }), searchParams: Promise.resolve({}) as Promise<{ edit?: string }> });

  it("answers not found when the post is unreadable", async () => {
    stubApi(() => json({ code: "post_not_found", detail: "Post not found." }, 404));
    await expect(PostPage(params())).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("answers not found without calling the API when the id is not a UUID", async () => {
    const fetchMock = stubApi(() => json({}));
    await expect(PostPage(params("northstar-founders", "nope"))).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers not found when the post belongs to another community", async () => {
    stubApi(() => json(postDetail({ id: POST_ID, communitySlug: "other-community" })));
    await expect(PostPage(params())).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("hands the resolved post to the client view", async () => {
    stubApi(() => json(postDetail({ id: POST_ID, title: "Resolved" })));
    const element = await PostPage({ params: Promise.resolve({ slug: "northstar-founders", postId: POST_ID }), searchParams: Promise.resolve({ edit: "1" }) });
    expect(element.props.initial.title).toBe("Resolved");
    expect(element.props.startEditing).toBe(true);
    expect(element.props.postId).toBe(POST_ID);
  });

  it.each([500, 401, 403])("lets the client view show its own error for a %s", async (status) => {
    stubApi(() => json({ code: "x", detail: "x" }, status));
    const element = await PostPage(params());
    expect(element.props.initial).toBeNull();
    expect(notFound).not.toHaveBeenCalled();
  });
});

describe("post not-found page (server)", () => {
  it("passes whether a session cookie exists to the client part, and nothing about the post", async () => {
    incoming.cookie = "spark_session=abc";
    expect((await PostNotFound()).props.signedIn).toBe(true);
    incoming.cookie = null;
    expect((await PostNotFound()).props.signedIn).toBe(false);
    incoming.cookie = "other=1";
    expect((await PostNotFound()).props.signedIn).toBe(false);
  });
});
