import { vi } from "vitest";
import type { CommentItem, ContentViewer, PostDetail, PostSummary } from "../src/app/communities/_lib/content-api";
import type { CommunityCard, CommunityDetail } from "../src/app/communities/types";

/** API-shaped community records (GET /api/v1/communities and /communities/{slug}). */
export function card(overrides: Partial<CommunityCard> = {}): CommunityCard {
  return {
    id: "c-northstar",
    slug: "northstar-founders",
    name: "Northstar Founders",
    tagline: "Founders building B2B software.",
    visibility: "public",
    location: { countryCode: "VN", city: "Hanoi" },
    stage: { code: "seed", label: "Seed" },
    topics: [
      { slug: "b2b-saas", name: "B2B SaaS" },
      { slug: "founders", name: "Founders Circle" },
    ],
    memberCount: 1250,
    weeklyPosts: 42,
    featured: false,
    frozen: false,
    host: { name: "Northstar Labs" },
    viewerStatus: null,
    ...overrides,
  };
}

export function detail(overrides: Partial<CommunityDetail> = {}): CommunityDetail {
  return {
    ...card(),
    description: "A working community for founders selling software across Southeast Asia.",
    createdAt: "2026-10-01T10:00:00.000Z",
    canManage: false,
    canGovern: false,
    version: 1,
    ...overrides,
  };
}

export const filterOptions = {
  topics: [
    { value: "b2b-saas", label: "B2B SaaS", count: 2 },
    { value: "fintech", label: "FinTech", count: 1 },
  ],
  stages: [
    { value: "seed", label: "Seed", count: 2 },
    { value: "growth", label: "Growth", count: 1 },
  ],
  countries: [{ value: "VN", label: "VN", count: 3 }],
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": status >= 400 ? "application/problem+json" : "application/json", ...headers },
  });
}

export type Route = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;

/** Stubs fetch with a router of handlers; unmatched requests fail the test with a 500. */
export function stubFetch(route: Route) {
  const calls: { method: string; path: string; search: URLSearchParams; body: unknown; headers: Record<string, string> }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), "http://spark.test");
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value]));
    calls.push({ method, path: url.pathname, search: url.searchParams, body: init.body ? JSON.parse(String(init.body)) : undefined, headers });
    const response = await route(url, init);
    return response ?? json({ code: "unexpected", detail: `Unexpected ${method} ${url.pathname}` }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

const viewerFlags = (overrides: Partial<ContentViewer> = {}): ContentViewer => ({
  isAuthor: false,
  reported: false,
  canEdit: false,
  canDelete: false,
  canReport: true,
  canModerate: false,
  ...overrides,
});

/** API-shaped feed item (GET /api/v1/communities/{id}/posts). */
export function post(overrides: Partial<Omit<PostSummary, "viewer">> & { viewer?: Partial<ContentViewer> } = {}): PostSummary {
  const { viewer, ...rest } = overrides;
  return {
    id: "p1",
    communityId: "c-northstar",
    title: "Hello founders",
    excerpt: "We are looking for design partners.",
    truncated: false,
    author: { id: "u-ann", displayName: "Ann Lee", avatarUrl: null },
    createdAt: "2026-10-05T10:00:00.000Z",
    editedAt: null,
    commentCount: 0,
    moderation: "visible",
    version: 1,
    viewer: viewerFlags(viewer),
    ...rest,
  };
}

/** API-shaped post (GET /api/v1/posts/{id}). */
export function postDetail(overrides: Partial<Omit<PostDetail, "viewer">> & { viewer?: Partial<ContentViewer> } = {}): PostDetail {
  const { viewer, ...rest } = overrides;
  const { excerpt, truncated, ...base } = post({ viewer });
  void excerpt;
  void truncated;
  return { ...base, body: "We are looking for design partners.", communitySlug: "northstar-founders", ...rest };
}

/** API-shaped comment (GET /api/v1/posts/{id}/comments). */
export function comment(overrides: Partial<Omit<CommentItem, "viewer">> & { viewer?: Partial<ContentViewer> } = {}): CommentItem {
  const { viewer, ...rest } = overrides;
  return {
    id: "m1",
    postId: "p1",
    body: "Count me in.",
    author: { id: "u-bo", displayName: "Bo Tran", avatarUrl: null },
    createdAt: "2026-10-05T11:00:00.000Z",
    editedAt: null,
    moderation: "visible",
    version: 1,
    viewer: viewerFlags(viewer),
    ...rest,
  };
}
