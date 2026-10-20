import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import fixtures from "./fixtures/community-health.json";

const router = { replace: vi.fn(), push: vi.fn() };
const navigation = { pathname: "/admin/communities", search: new URLSearchParams() };
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
import CommunitiesAdminPage from "../src/app/admin/communities/page";
import { healthOf } from "../src/app/admin/_components/community-actions";
import { HEALTH_GROUPS } from "../src/app/admin/communities/community-insights";

const overview = {
  // flagged also counts archived communities with open reports, so it differs from health.needsReview.
  communities: { active: 12, featured: 1, frozen: 0, archived: 2, flagged: 5 },
  users: { active: 5, suspended: 1 },
  reports: { open: 4 },
  campaigns: { pending: 0, approved: 0 },
  workspaces: { active: 4 },
  auditEvents: 9,
};

const stats = {
  days: 30,
  health: { growing: 5, steady: 4, slowing: 2, quiet: 1, needsReview: 3, archived: 1 },
  series: [
    { day: "2026-10-18", newMembers: 2, newCommunities: 1, liveCommunities: null },
    { day: "2026-10-19", newMembers: 5, newCommunities: 0, liveCommunities: null },
    { day: "2026-10-20", newMembers: 3, newCommunities: 2, liveCommunities: null },
  ],
  current: { newMembers: 10, newCommunities: 3 },
  previous: { newMembers: 20, newCommunities: 2 },
};

const totals = (scale: number) => ({ signups: 12, signIns: 80, posts: 30 * scale, comments: 20 * scale, reportsOpened: 3, reportsClosed: 2, avgActiveUsers: 40 });
const activity = {
  days: 30,
  series: [
    { day: "2026-10-19", activeUsers: 30, signups: 4, signIns: 20, posts: 10, comments: 6, reportsOpened: 1, reportsClosed: 1 },
    { day: "2026-10-20", activeUsers: 32, signups: 4, signIns: 20, posts: 20, comments: 14, reportsOpened: 1, reportsClosed: 1 },
  ],
  current: totals(1),
  previous: totals(0.5),
  audience: { dau: 10, wau: 25, mau: 40, totalUsers: 100 },
};
const reportStats = {
  days: 30, opened: 4, closed: 2, backlog: 4, medianHoursToClose: 5.5, reasons: [], topCommunities: [],
  series: [{ day: "2026-10-19", opened: 1, closed: 0, backlog: 3, medianHoursToClose: null }, { day: "2026-10-20", opened: 1, closed: 0, backlog: 4, medianHoursToClose: null }],
};
const top = { items: [{ id: "c1", name: "Makers", slug: "makers", posts: 40, comments: 22, newMembers: 5, contributors: 9 }] };
const engagement = { days: 30, cells: [{ dow: 1, hour: 9, events: 12 }] };

const community = (index: number) => ({
  id: `c${index}`,
  slug: `circle-${index}`,
  name: `Circle ${index}`,
  description: "",
  visibility: "public",
  stage: null,
  city: null,
  countryCode: null,
  state: "active",
  createdAt: "2026-01-01T00:00:00Z",
  featuredAt: null,
  frozenAt: null,
  archivedAt: null,
  creator: { id: "u1", displayName: "Owner", email: "owner@example.com", avatarUrl: null },
  memberCount: 10,
  openReports: index === 1 ? 2 : 0,
  newMembers30d: 0,
  posts30d: 3,
  comments30d: 1,
  weeklyActivity: [1, 1, 1, 1, 1, 1, 1, 1],
});
const page = { items: Array.from({ length: 10 }, (_, index) => community(index + 1)), nextCursor: "next" };

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

// Longer prefixes first: "/communities/stats" must not fall through to the list handler.
const routes = {
  "GET /api/v1/admin/overview": json(overview),
  "GET /api/v1/admin/communities/stats": json(stats),
  "GET /api/v1/admin/communities": json(page),
  "GET /api/v1/admin/analytics/activity": json(activity),
  "GET /api/v1/admin/analytics/top-communities": json(top),
  "GET /api/v1/admin/analytics/engagement": json(engagement),
  "GET /api/v1/admin/reports/stats": json(reportStats),
};

beforeEach(() => {
  requests = [];
  auth.platformRoles = ["platform_admin"];
  navigation.search = new URLSearchParams();
});
afterEach(() => vi.unstubAllGlobals());

describe("communities dashboard", () => {
  it("shows the four trend cards for an admin", async () => {
    mockApi(routes);
    render(<AdminLayout><CommunitiesAdminPage /></AdminLayout>);
    const cards = screen.getByRole("list", { name: "Community numbers" });
    expect(within(cards).getAllByRole("listitem")).toHaveLength(4);
    // No live-community history: the current count, the new-community change, and no sparkline.
    expect(await within(cards).findByText(/^Live communities: 12, \+50% new communities vs previous period, improving$/u)).toBeInTheDocument();
    expect(await within(cards).findByText(/^New members: 10, −50% vs previous period, worsening$/u)).toBeInTheDocument();
    expect(await within(cards).findByText(/^Posts, comments: 50, \+100% vs previous period, improving$/u)).toBeInTheDocument();
    expect(await within(cards).findByText(/^Open reports: 4, needs attention$/u)).toBeInTheDocument();
    const items = within(cards).getAllByRole("listitem");
    expect(items[0]!.querySelector(".admTrendCardSpark")).toBeNull();
    for (const item of items.slice(1)) expect(item.querySelector(".admTrendCardSpark")).not.toBeNull();
    expect(requests.some((url) => url.endsWith("/admin/communities/stats?days=30"))).toBe(true);
  });

  it("counts new communities on the live card when the previous period had none", async () => {
    mockApi({ ...routes, "GET /api/v1/admin/communities/stats": json({ ...stats, previous: { newMembers: 20, newCommunities: 0 } }) });
    render(<AdminLayout><CommunitiesAdminPage /></AdminLayout>);
    const cards = screen.getByRole("list", { name: "Community numbers" });
    expect(await within(cards).findByText(/^Live communities: 12, 3 new communities, none in the previous period, improving$/u)).toBeInTheDocument();
    expect(within(cards).getByText("↑ 3 new")).toBeInTheDocument();
  });

  it("counts the health mix over every community, not the loaded table page", async () => {
    mockApi(routes);
    render(<AdminLayout><CommunitiesAdminPage /></AdminLayout>);
    const tile = await screen.findByRole("region", { name: "Health mix" });
    expect(await within(tile).findByText("16 communities: 5 growing, 4 steady, 2 slowing, 1 quiet, 3 need review, 1 archived.")).toBeInTheDocument();
    // The table below still lists its loaded page of 10 with the client badges.
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(11);
    expect(within(table).getByText("Needs review")).toBeInTheDocument();
    expect(within(tile).getByText("3 communities need").closest("p")).toHaveTextContent("3 communities need a decision: they have open reports.");
    expect(within(tile).getByRole("link", { name: /Show flagged communities/u })).toHaveAttribute("href", "/admin/communities?status=flagged");
  });

  it("shows most active, member activity and the flagged share for an admin", async () => {
    mockApi(routes);
    render(<AdminLayout><CommunitiesAdminPage /></AdminLayout>);
    const ranked = await screen.findByRole("region", { name: "Most active communities" });
    expect(await within(ranked).findByRole("link", { name: "Makers" })).toHaveAttribute("href", "/admin/communities/c1");
    expect(screen.getByRole("region", { name: "When members are active" })).toBeInTheDocument();
    const flagged = screen.getByRole("region", { name: "Flagged communities" });
    // From the health counts (3 need review of 15 not archived), not overview flagged / active (5 / 12).
    expect(await within(flagged).findByRole("img", { name: "20%: 3 of 15 live communities have open reports" })).toBeInTheDocument();
    expect(requests.some((url) => url.includes("/admin/analytics/top-communities?days=30"))).toBe(true);
    expect(requests.some((url) => url.includes("/admin/analytics/engagement?days=30"))).toBe(true);
  });

  it("gives a community moderator no analytics or report tiles and no requests for them", async () => {
    auth.platformRoles = ["community_moderator"];
    mockApi(routes);
    render(<AdminLayout><CommunitiesAdminPage /></AdminLayout>);
    const cards = screen.getByRole("list", { name: "Community numbers" });
    expect(await within(cards).findByText(/^Live communities: 12/u)).toBeInTheDocument();
    expect(within(cards).getAllByRole("listitem")).toHaveLength(2);
    expect(within(cards).queryByText(/^Posts, comments/u)).not.toBeInTheDocument();
    expect(within(cards).queryByText(/^Open reports/u)).not.toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Health mix" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Flagged communities" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Most active communities" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "When members are active" })).not.toBeInTheDocument();
    await screen.findByRole("table");
    await waitFor(() => expect(requests.some((url) => url.includes("/admin/communities/stats"))).toBe(true));
    expect(requests.filter((url) => /\/admin\/(analytics|reports)\//u.test(url))).toEqual([]);
  });

  it("offers 7, 30 and 90 days and asks every period read for the chosen range", async () => {
    navigation.search = new URLSearchParams("range=90");
    mockApi(routes);
    render(<AdminLayout><CommunitiesAdminPage /></AdminLayout>);
    const picker = screen.getByRole("group", { name: "Date range" });
    expect(within(picker).getAllByRole("button").map((button) => button.textContent)).toEqual(["7d", "30d", "90d"]);
    await waitFor(() => expect(requests.some((url) => url.endsWith("/admin/communities/stats?days=90"))).toBe(true));
    expect(requests.some((url) => url.includes("/admin/analytics/activity?days=90"))).toBe(true);
    expect(requests.some((url) => url.includes("/admin/reports/stats?days=90"))).toBe(true);
  });

  it("falls back to 30 days for a range the stats read does not accept", async () => {
    navigation.search = new URLSearchParams("range=180");
    mockApi(routes);
    render(<AdminLayout><CommunitiesAdminPage /></AdminLayout>);
    await waitFor(() => expect(requests.some((url) => url.includes("/admin/communities/stats"))).toBe(true));
    expect(requests.filter((url) => url.includes("days=180"))).toEqual([]);
  });

  it("reloads the health counts after a table action", async () => {
    mockApi({ ...routes, "POST /api/v1/admin/communities/c2/actions": json({ ok: true }) });
    render(<AdminLayout><CommunitiesAdminPage /></AdminLayout>);
    await screen.findByRole("table");
    await waitFor(() => expect(requests.filter((url) => url.includes("/admin/communities/stats")).length).toBe(1));
    await userEvent.click(screen.getByRole("button", { name: "Actions for Circle 2" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Freeze" }));
    await userEvent.type(screen.getByRole("textbox", { name: /reason/i }), "Repeated spam");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Freeze" }));
    await waitFor(() => expect(requests.filter((url) => url.includes("/admin/communities/stats")).length).toBe(2));
  });

  it("shows an empty health mix and hides the flagged share on a platform with no communities", async () => {
    mockApi({
      ...routes,
      "GET /api/v1/admin/overview": json({ ...overview, communities: { active: 0, featured: 0, frozen: 0, archived: 0, flagged: 0 } }),
      "GET /api/v1/admin/communities/stats": json({ ...stats, health: { growing: 0, steady: 0, slowing: 0, quiet: 0, needsReview: 0, archived: 0 } }),
    });
    render(<AdminLayout><CommunitiesAdminPage /></AdminLayout>);
    const tile = await screen.findByRole("region", { name: "Health mix" });
    expect(await within(tile).findByText("No communities yet.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Flagged communities" })).not.toBeInTheDocument();
  });
});

describe("healthOf and the SQL health counts", () => {
  it("classifies the shared fixtures the way the database test expects", () => {
    expect(fixtures.cases.length).toBeGreaterThan(0);
    for (const entry of fixtures.cases) {
      // Week 8 is the current week: posts 2 weeks ago land in week 6, posts 5 weeks ago in week 3.
      const weeklyActivity = [0, 0, 0, 0, 0, 0, 0, 0];
      weeklyActivity[2] = entry.earlierPosts;
      weeklyActivity[5] = entry.recentPosts;
      const label = healthOf({ state: entry.archived ? "archived" : "active", openReports: entry.openReports, weeklyActivity }).label;
      const group = HEALTH_GROUPS.find((item) => item.label === label);
      expect({ name: entry.name, key: group?.sqlKey }).toEqual({ name: entry.name, key: entry.expected });
    }
  });
});
