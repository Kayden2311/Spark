import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), push: vi.fn() };
const navigation = { pathname: "/admin", search: new URLSearchParams() };
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
import AdminOverviewPage from "../src/app/admin/page";

const overview = {
  communities: { active: 3, featured: 1, frozen: 0, archived: 0, flagged: 1 },
  users: { active: 5, suspended: 1 },
  reports: { open: 2 },
  campaigns: { pending: 4, approved: 0 },
  workspaces: { active: 4 },
  auditEvents: 9,
};

const totals = (scale: number) => ({ signups: 12 * scale, signIns: 80, posts: 30 * scale, comments: 20 * scale, reportsOpened: 3, reportsClosed: 2, avgActiveUsers: 41.6 * scale });
const point = (day: string, activeUsers: number) => ({ day, activeUsers, signups: 4, signIns: 20, posts: 10, comments: 6, reportsOpened: 1, reportsClosed: 1 });
const activity = {
  days: 30,
  series: [point("2026-10-18", 38), point("2026-10-19", 44), point("2026-10-20", 41)],
  current: totals(1),
  previous: totals(0.5),
  audience: { dau: 10, wau: 25, mau: 40, totalUsers: 100 },
};
const reportStats = {
  days: 30, opened: 4, closed: 2, backlog: 2, medianHoursToClose: 5.5, reasons: [], topCommunities: [],
  series: [{ day: "2026-10-19", opened: 1, closed: 0, backlog: 3, medianHoursToClose: null }, { day: "2026-10-20", opened: 0, closed: 1, backlog: 2, medianHoursToClose: 5.5 }],
};
const mrr = {
  months: 12,
  series: [
    { month: "2026-09-01", currency: "USD", mrrMinor: 10000, newPaid: 1, churned: 0 },
    { month: "2026-10-01", currency: "USD", mrrMinor: 12900, newPaid: 1, churned: 0 },
  ],
};

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

const adminRoutes = {
  "GET /api/v1/admin/overview": json(overview),
  "GET /api/v1/admin/analytics/activity": json(activity),
  "GET /api/v1/admin/billing/mrr": json(mrr),
  "GET /api/v1/admin/billing/overview": json({ counts: { freeWorkspaces: 3, trialing: 1, paying: 2, pastDue: 0, cancelled30d: 0, newPaid30d: 1, failedPayments30d: 0 }, revenue: [{ currency: "USD", mrrMinor: 12900, arrMinor: 154800, collected30dMinor: 2900, openMinor: 0, uncollectibleMinor: 0 }], planMix: [] }),
  "GET /api/v1/admin/reports/stats": json(reportStats),
  "GET /api/v1/admin/audit-logs": json({ items: [], nextCursor: null }),
  "GET /api/v1/admin/system": json({ status: "operational", nodeVersion: "v24.1.0", uptimeSeconds: 3600, activeSessions: 7, checkedAt: new Date().toISOString() }),
};

beforeEach(() => {
  requests = [];
  auth.platformRoles = ["platform_admin"];
  navigation.search = new URLSearchParams();
});
afterEach(() => vi.unstubAllGlobals());

describe("overview dashboard", () => {
  it("shows four trend cards with values from the activity and MRR reads", async () => {
    mockApi(adminRoutes);
    render(<AdminLayout><AdminOverviewPage /></AdminLayout>);
    const cards = screen.getByRole("list", { name: "Key numbers" });
    expect(within(cards).getAllByRole("listitem")).toHaveLength(4);
    expect(await within(cards).findByText(/^Avg\. daily users: 42, \+100% vs previous period, improving$/u)).toBeInTheDocument();
    expect(within(cards).getByText(/^New sign-ups: 12, \+100% vs previous period/u)).toBeInTheDocument();
    expect(within(cards).getByText(/^Posts, comments: 50, \+100% vs previous period/u)).toBeInTheDocument();
    expect(await within(cards).findByText(/^MRR: \$129\.00, \+29% vs previous period, improving$/u)).toBeInTheDocument();
    expect(requests.some((url) => url.includes("/admin/billing/mrr"))).toBe(true);
  });

  it("links every Needs attention bar to its queue", async () => {
    mockApi(adminRoutes);
    render(<AdminLayout><AdminOverviewPage /></AdminLayout>);
    const tile = await screen.findByRole("region", { name: "Needs attention" });
    expect(await within(tile).findByRole("link", { name: "Reported content" })).toHaveAttribute("href", "/admin/reports");
    expect(within(tile).getByRole("link", { name: "Flagged communities" })).toHaveAttribute("href", "/admin/communities?status=flagged");
    expect(within(tile).getByRole("link", { name: "Campaign reviews" })).toHaveAttribute("href", "/admin/campaigns");
    expect(within(tile).getByText("7 items are waiting.")).toBeInTheDocument();
  });

  it("shows audience stickiness as DAU over MAU", async () => {
    mockApi(adminRoutes);
    render(<AdminLayout><AdminOverviewPage /></AdminLayout>);
    const tile = await screen.findByRole("region", { name: "Audience stickiness" });
    expect(await within(tile).findByRole("img", { name: "Stickiness 25%: 10 daily of 40 monthly active members" })).toBeInTheDocument();
    for (const name of ["Platform activity", "Content created", "Moderation flow", "Recent staff activity", "Revenue snapshot", "API health"]) {
      expect(screen.getByRole("region", { name })).toBeInTheDocument();
    }
  });

  it("asks a community moderator's role only for reads it can open, with no MRR card or revenue tile", async () => {
    auth.platformRoles = ["community_moderator"];
    mockApi(adminRoutes);
    render(<AdminLayout><AdminOverviewPage /></AdminLayout>);
    const tile = await screen.findByRole("region", { name: "Needs attention" });
    expect(await within(tile).findByRole("link", { name: "Flagged communities" })).toHaveAttribute("href", "/admin/communities?status=flagged");
    expect(within(tile).queryByRole("link", { name: "Reported content" })).not.toBeInTheDocument();
    await waitFor(() => expect(requests.some((url) => url.endsWith("/admin/overview"))).toBe(true));
    expect(requests.filter((url) => /\/admin\/(analytics|billing|reports|audit-logs|system)/u.test(url))).toEqual([]);
    expect(screen.queryByText(/^MRR/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Revenue snapshot" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Platform activity" })).not.toBeInTheDocument();
    expect(screen.getByText(/^Flagged communities: 1, needs attention$/u)).toBeInTheDocument();
  });

  it("gives a content moderator the moderation flow from report stats, without analytics reads", async () => {
    auth.platformRoles = ["content_moderator"];
    mockApi(adminRoutes);
    render(<AdminLayout><AdminOverviewPage /></AdminLayout>);
    expect(await screen.findByRole("region", { name: "Moderation flow" })).toBeInTheDocument();
    expect(await screen.findByText(/^Reports closed: 2$/u)).toBeInTheDocument();
    expect(requests.filter((url) => /\/admin\/(analytics|billing)\//u.test(url))).toEqual([]);
    expect(requests.some((url) => url.includes("/admin/reports/stats?days=30"))).toBe(true);
  });
  it("shows an error with Retry when the overview read fails, and Retry refetches it", async () => {
    auth.platformRoles = ["community_moderator"];
    let fail = true;
    mockApi({ "GET /api/v1/admin/overview": () => (fail ? new Response(JSON.stringify({ code: "boom", message: "Overview is down" }), { status: 500 }) : json(overview)()) });
    render(<AdminLayout><AdminOverviewPage /></AdminLayout>);
    const tile = await screen.findByRole("region", { name: "Needs attention" });
    const retry = await within(tile).findByRole("button", { name: /Retry/u });
    expect(screen.getByText(/^Flagged communities: –$/u)).toBeInTheDocument();
    const before = requests.filter((url) => url.endsWith("/admin/overview")).length;
    fail = false;
    await userEvent.click(retry);
    expect(await within(tile).findByRole("link", { name: "Flagged communities" })).toBeInTheDocument();
    expect(requests.filter((url) => url.endsWith("/admin/overview")).length).toBeGreaterThan(before);
  });

  it("shows the empty message on chart tiles whose series has no activity", async () => {
    const zero = (day: string) => ({ day, activeUsers: 0, signups: 0, signIns: 0, posts: 0, comments: 0, reportsOpened: 0, reportsClosed: 0 });
    mockApi({
      ...adminRoutes,
      "GET /api/v1/admin/analytics/activity": json({ ...activity, series: [zero("2026-10-19"), zero("2026-10-20")] }),
      "GET /api/v1/admin/reports/stats": json({ ...reportStats, series: [{ day: "2026-10-20", opened: 0, closed: 0, backlog: 0, medianHoursToClose: null }] }),
    });
    render(<AdminLayout><AdminOverviewPage /></AdminLayout>);
    for (const name of ["Platform activity", "Content created", "Moderation flow"]) {
      const tile = await screen.findByRole("region", { name });
      expect(await within(tile).findByText(/^No .+ in this period/u)).toBeInTheDocument();
    }
  });
});
