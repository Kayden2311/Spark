import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), push: vi.fn() };
const navigation = { pathname: "/admin/analytics", search: new URLSearchParams() };
const auth = {
  isAuthenticated: true,
  isLoading: false,
  platformRoles: ["platform_admin"] as string[],
  user: { id: "me", displayName: "Casey Staff", email: "casey@example.com", avatarUrl: null },
  logout: vi.fn(),
  refreshSession: vi.fn(),
};

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => navigation.pathname,
  useSearchParams: () => navigation.search,
  useParams: () => ({}),
}));
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));

import AdminLayout from "../src/app/admin/layout";
import AnalyticsPage from "../src/app/admin/analytics/page";

const overview = {
  communities: { active: 3, featured: 1, frozen: 0, archived: 0, flagged: 0 },
  users: { active: 5, suspended: 0 },
  reports: { open: 0 },
  campaigns: { pending: 0, approved: 0 },
  workspaces: { active: 4 },
  auditEvents: 9,
};

const check = (status: string) => ({ status, detail: "Responding", latencyMs: 2 });
const minute = (index: number, requests: number, serverErrors: number, p95Ms: number | null) => ({
  minute: new Date(Date.UTC(2026, 9, 20, 10, index)).toISOString(), requests, clientErrors: 1, serverErrors, p95Ms,
});
const health = {
  status: "operational", checkedAt: new Date().toISOString(), collectingSince: new Date().toISOString(),
  checks: { api: check("ok"), database: check("ok"), redis: check("ok") },
  process: { nodeVersion: "v26.1.0", uptimeSeconds: 600, rssMb: 100, heapUsedMb: 30, heapTotalMb: 40, eventLoopP99Ms: 12, eventLoopMaxMs: 20 },
  database: { poolTotal: 4, poolIdle: 3, poolWaiting: 0, sizeMb: 30, connections: 5, cacheHitRatio: 0.99, activeSessions: 9 },
  redis: { usedMemoryMb: 2, connectedClients: 1, version: "8.0.0" },
  traffic: {
    windowMinutes: 60, stepMinutes: 1, requests: 60, clientErrors: 3, serverErrors: 3, p50Ms: 10, p95Ms: 120,
    series: [minute(0, 20, 1, 100), minute(1, 0, 0, null), minute(2, 40, 2, 140)],
    slowest: [{ route: "GET /api/v1/admin/users", requests: 10, serverErrors: 0, clientErrors: 0, avgMs: 40, p95Ms: 300 }],
    failing: [{ route: "POST /api/v1/posts", requests: 8, serverErrors: 2, clientErrors: 1, avgMs: 20, p95Ms: 50 }],
  },
};

const point = (day: string, activeUsers: number, signups: number) => ({ day, activeUsers, signups, signIns: 20, posts: 10, comments: 6, reportsOpened: 0, reportsClosed: 0 });
const totals = (signups: number) => ({ signups, signIns: 80, posts: 30, comments: 20, reportsOpened: 0, reportsClosed: 0, avgActiveUsers: 40 });
const activity = {
  days: 30,
  series: [point("2026-10-18", 38, 2), point("2026-10-19", 44, 4), point("2026-10-20", 41, 6)],
  current: totals(12),
  previous: totals(6),
  audience: { dau: 10, wau: 25, mau: 40, totalUsers: 100 },
};
const engagement = { days: 30, cells: [{ dow: 2, hour: 9, events: 5 }, { dow: 3, hour: 14, events: 2 }] };
const retention = { weeks: 8, cohorts: [{ week: "2026-10-05", size: 4, retained: [4, 2] }, { week: "2026-10-12", size: 2, retained: [2] }] };
const top = { items: [{ id: "c1", name: "Makers", slug: "makers", posts: 5, comments: 7, newMembers: 3, contributors: 4 }] };

let requests: string[] = [];
const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function mockApi(routes: Record<string, () => Response>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requests.push(url);
    const key = `${init?.method ?? "GET"} ${url}`;
    const handler = Object.entries(routes).find(([pattern]) => key.startsWith(pattern))?.[1];
    return handler ? handler() : new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
  }));
}

const routes = {
  "GET /api/v1/admin/overview": json(overview),
  "GET /api/v1/admin/system/health": json(health),
  "GET /api/v1/admin/analytics/activity": json(activity),
  "GET /api/v1/admin/analytics/engagement": json(engagement),
  "GET /api/v1/admin/analytics/retention": json(retention),
  "GET /api/v1/admin/analytics/top-communities": json(top),
};

beforeEach(() => {
  requests = [];
  router.replace.mockClear();
  auth.platformRoles = ["platform_admin"];
  navigation.search = new URLSearchParams();
});
afterEach(() => vi.unstubAllGlobals());

const cardNamed = (cards: HTMLElement, label: string) => within(cards).getByText(new RegExp(`^${label}:`, "u")).closest("li")!;

describe("analytics: system health", () => {
  it("shows four trend cards, with sparklines from the traffic buckets and none for active sessions", async () => {
    mockApi(routes);
    render(<AdminLayout><AnalyticsPage /></AdminLayout>);
    const cards = screen.getByRole("list", { name: "Traffic numbers" });
    expect(within(cards).getAllByRole("listitem")).toHaveLength(4);
    expect(await within(cards).findByText(/^Requests, 1h: 60$/u)).toBeInTheDocument();
    expect(within(cards).getByText(/^Error rate: 5\.00%$/u)).toBeInTheDocument();
    expect(within(cards).getByText(/^Response p95: 120 ms$/u)).toBeInTheDocument();
    expect(within(cards).getByText(/^Active sessions: 9$/u)).toBeInTheDocument();
    for (const label of ["Requests, 1h", "Error rate", "Response p95"]) {
      expect(cardNamed(cards, label).querySelector(".admTrendCardSpark")).not.toBeNull();
    }
    expect(cardNamed(cards, "Active sessions").querySelector(".admTrendCardSpark")).toBeNull();
  });

  it("lays the health read out as bento tiles with ranked endpoints and gauges", async () => {
    mockApi(routes);
    render(<AdminLayout><AnalyticsPage /></AdminLayout>);
    const bento = await screen.findByRole("region", { name: "System health" });
    expect(await within(bento).findByRole("heading", { name: "All systems operational" })).toBeInTheDocument();
    const checks = within(bento).getByRole("list", { name: "Service checks" });
    expect(within(checks).getAllByRole("listitem")).toHaveLength(3);
    // Each check lifts on its own hover, so the tile holding them does not lift as well.
    for (const item of within(checks).getAllByRole("listitem")) expect(item).toHaveClass("admLift");
    expect(checks.closest(".admTile")).not.toHaveClass("admLift");
    for (const name of ["API traffic", "Response time", "Slowest endpoints", "Endpoints with errors", "Database", "API process"]) {
      expect(within(bento).getByRole("region", { name })).toBeInTheDocument();
    }
    const slowest = within(bento).getByRole("region", { name: "Slowest endpoints" });
    expect(within(slowest).getByText("/api/v1/admin/users")).toBeInTheDocument();
    expect(within(slowest).getByRole("button", { name: "View as table" })).toBeInTheDocument();
    const failing = within(bento).getByRole("region", { name: "Endpoints with errors" });
    expect(within(failing).getByText("/api/v1/posts")).toBeInTheDocument();
    const processTile = within(bento).getByRole("region", { name: "API process" });
    expect(within(processTile).getByText("Heap used")).toBeInTheDocument();
    expect(processTile.querySelectorAll(".vizGauge").length).toBeGreaterThan(0);
    const database = within(bento).getByRole("region", { name: "Database" });
    expect(database.querySelector(".vizGauge")).not.toBeNull();
  });

  it("keeps the trend cards on screen while the health read is still loading", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<AdminLayout><AnalyticsPage /></AdminLayout>);
    const cards = screen.getByRole("list", { name: "Traffic numbers" });
    expect(within(cards).getAllByRole("listitem")).toHaveLength(4);
    expect(within(cards).getByText("Active sessions: loading")).toBeInTheDocument();
  });
});

describe("analytics: engagement", () => {
  beforeEach(() => {
    navigation.search = new URLSearchParams("view=engagement");
  });

  it("shows DAU, WAU, MAU and sign-ups, with only DAU and sign-ups drawn as sparklines", async () => {
    mockApi(routes);
    render(<AdminLayout><AnalyticsPage /></AdminLayout>);
    const cards = screen.getByRole("list", { name: "Engagement numbers" });
    expect(within(cards).getAllByRole("listitem")).toHaveLength(4);
    expect(await within(cards).findByText(/^Active today: 10$/u)).toBeInTheDocument();
    expect(within(cards).getByText(/^Active this week: 25$/u)).toBeInTheDocument();
    expect(within(cards).getByText(/^Active this month: 40$/u)).toBeInTheDocument();
    expect(within(cards).getByText(/^Sign-ups: 12, \+100% vs previous period, improving$/u)).toBeInTheDocument();
    expect(cardNamed(cards, "Active today").querySelector(".admTrendCardSpark")).not.toBeNull();
    expect(cardNamed(cards, "Active this week").querySelector(".admTrendCardSpark")).toBeNull();
    expect(cardNamed(cards, "Active this month").querySelector(".admTrendCardSpark")).toBeNull();
    expect(cardNamed(cards, "Sign-ups").querySelector(".admTrendCardSpark")).not.toBeNull();
  });

  it("renders the heatmap, top communities, retention cohorts and activity trend tiles from their reads", async () => {
    mockApi(routes);
    render(<AdminLayout><AnalyticsPage /></AdminLayout>);
    const bento = await screen.findByRole("region", { name: "Engagement charts" });
    const heatmap = within(bento).getByRole("region", { name: "When members are active" });
    expect(await within(heatmap).findByText("Busiest hour: Tue 09:00 UTC: 5 events")).toBeInTheDocument();
    const cohorts = within(bento).getByRole("region", { name: "Retention cohorts" });
    expect(await within(cohorts).findByText("50%")).toBeInTheDocument();
    expect(within(cohorts).getByRole("button", { name: "View as table" })).toBeInTheDocument();
    const ranked = within(bento).getByRole("region", { name: "Top communities" });
    expect(await within(ranked).findByRole("link", { name: "Makers" })).toHaveAttribute("href", "/admin/communities/c1");
    expect(within(bento).getByRole("region", { name: "Activity trend" })).toBeInTheDocument();
    expect(requests.some((url) => url.includes("/admin/analytics/retention"))).toBe(true);
    expect(requests.some((url) => url.includes("/admin/system/health"))).toBe(false);
  });

  it("shows the empty message when there are no cohorts yet", async () => {
    mockApi({ ...routes, "GET /api/v1/admin/analytics/retention": json({ weeks: 8, cohorts: [] }) });
    render(<AdminLayout><AnalyticsPage /></AdminLayout>);
    const cohorts = await screen.findByRole("region", { name: "Retention cohorts" });
    expect(await within(cohorts).findByText("No sign-up cohorts in the last 8 weeks yet.")).toBeInTheDocument();
  });
});

describe("analytics: view switch", () => {
  it("keeps the view in the URL query", async () => {
    mockApi(routes);
    const { rerender } = render(<AdminLayout><AnalyticsPage /></AdminLayout>);
    expect(screen.getByRole("button", { name: "System health" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Engagement" }));
    expect(router.replace).toHaveBeenCalledWith("/admin/analytics?view=engagement", { scroll: false });

    navigation.search = new URLSearchParams("view=engagement");
    rerender(<AdminLayout><AnalyticsPage /></AdminLayout>);
    expect(await screen.findByRole("list", { name: "Engagement numbers" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "System health" }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/analytics", { scroll: false });
    await waitFor(() => expect(requests.some((url) => url.includes("/admin/analytics/activity"))).toBe(true));
  });
});
