import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), push: vi.fn() };
const navigation = { pathname: "/admin/reports", search: new URLSearchParams() };
const auth = {
  isAuthenticated: true,
  isLoading: false,
  platformRoles: ["content_moderator"] as string[],
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
import ReportsPage from "../src/app/admin/reports/page";

const overview = {
  communities: { active: 3, featured: 1, frozen: 0, archived: 0, flagged: 1 },
  users: { active: 5, suspended: 1 },
  reports: { open: 20 },
  campaigns: { pending: 0, approved: 0 },
  workspaces: { active: 4 },
  auditEvents: 9,
};

// The loaded queue page holds a single spam report; the API's reason counts cover every open report.
const report = {
  id: "r1",
  status: "open",
  reasonCode: "spam",
  details: null,
  createdAt: "2026-10-17T10:00:00.000Z",
  resolvedAt: null,
  community: { id: "c1", name: "Hyperdrive Founders", slug: "hyperdrive" },
  reporter: { id: "u2", displayName: "Riley Reporter" },
  target: { kind: "post", id: "p1", title: "Crypto bot offer", body: "50x guaranteed returns", moderationStatus: "visible" },
};

const stats = {
  days: 30,
  opened: 24,
  closed: 6,
  backlog: 20,
  medianHoursToClose: 5.5,
  reasons: [{ reason: "harassment", count: 12 }, { reason: "spam", count: 8 }],
  topCommunities: [{ id: "c9", name: "Rocket Club", slug: "rocket-club", count: 11 }, { id: "c1", name: "Hyperdrive Founders", slug: "hyperdrive", count: 9 }],
  series: [
    { day: "2026-10-18", opened: 10, closed: 2, backlog: 12, medianHoursToClose: 4 },
    { day: "2026-10-19", opened: 8, closed: 0, backlog: 20, medianHoursToClose: null },
    { day: "2026-10-20", opened: 6, closed: 4, backlog: 20, medianHoursToClose: 7 },
  ],
};

let requests: string[] = [];
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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
  "GET /api/v1/admin/reports/stats": json(stats),
  "GET /api/v1/admin/reports/r1/preview": json({ post: null, comment: null }),
  "GET /api/v1/admin/reports/r1/context": json({ author: null, communityOpenReports: 0, reporterReportsFiled: 1 }),
  "GET /api/v1/admin/reports?status=open&limit=100": json({ items: [report], nextCursor: null }),
};

beforeEach(() => {
  requests = [];
  auth.platformRoles = ["content_moderator"];
  navigation.search = new URLSearchParams();
});
afterEach(() => vi.unstubAllGlobals());

const renderPage = () => render(<AdminLayout><ReportsPage /></AdminLayout>);

describe("reports dashboard", () => {
  it("shows four trend cards from the report stats read, with sparklines from its daily series", async () => {
    mockApi(routes);
    renderPage();
    const cards = screen.getByRole("list", { name: "Report numbers" });
    expect(within(cards).getAllByRole("listitem")).toHaveLength(4);
    expect(await within(cards).findByText(/^Open now: 20, needs attention$/u)).toBeInTheDocument();
    expect(within(cards).getByText(/^Opened: 24$/u)).toBeInTheDocument();
    expect(within(cards).getByText(/^Closed: 6$/u)).toBeInTheDocument();
    expect(within(cards).getByText(/^Time to decision: 5\.5 h$/u)).toBeInTheDocument();
    // Every card has a series of at least two points (the median skips days with no closures).
    expect(cards.querySelectorAll(".vizSpark")).toHaveLength(4);
    expect(requests.some((url) => url.includes("/admin/reports/stats?days=30"))).toBe(true);
  });

  it("reads the backlog against its target: 20 open is 2× over a target of 10", async () => {
    mockApi(routes);
    renderPage();
    const tile = await screen.findByRole("region", { name: "Backlog" });
    expect(await within(tile).findByRole("img", { name: "Open reports: 20, 2× over target" })).toBeInTheDocument();
    expect(within(tile).getByText("Target 10")).toBeInTheDocument();
  });

  it("ranks reasons from the API's counts over all open reports, not the loaded queue page", async () => {
    mockApi(routes);
    renderPage();
    const tile = await screen.findByRole("region", { name: "Reports by reason" });
    const rows = await within(tile).findAllByRole("listitem");
    expect(rows.map((row) => row.querySelector(".vizBarListLabel")?.textContent)).toEqual(["Harassment", "Spam"]);
    expect(within(tile).getByText("12")).toBeInTheDocument();
    expect(within(tile).getByRole("button", { name: "View as table" })).toBeInTheDocument();
  });

  it("links each most-reported community to its detail page", async () => {
    mockApi(routes);
    renderPage();
    const tile = await screen.findByRole("region", { name: "Most reported communities" });
    expect(await within(tile).findByRole("link", { name: "Rocket Club" })).toHaveAttribute("href", "/admin/communities/c9");
    expect(within(tile).getByRole("link", { name: "Hyperdrive Founders" })).toHaveAttribute("href", "/admin/communities/c1");
  });

  it("charts opened against closed per day, with a table view", async () => {
    mockApi(routes);
    renderPage();
    expect(await screen.findByRole("region", { name: "Opened vs closed" })).toBeInTheDocument();
    // The old queue-health and loaded-page reason cards are replaced by the tiles.
    expect(screen.queryByText("Queue health")).not.toBeInTheDocument();
    expect(screen.queryByText("By reason")).not.toBeInTheDocument();
    // The triage queue and detail pane are still there.
    expect(screen.getByRole("region", { name: "Report queue" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Selected report" })).toBeInTheDocument();
  });

  it("shows plain empty messages on a platform with no reports", async () => {
    mockApi({
      ...routes,
      "GET /api/v1/admin/reports/stats": json({ ...stats, opened: 0, closed: 0, backlog: 0, medianHoursToClose: null, reasons: [], topCommunities: [], series: [{ day: "2026-10-20", opened: 0, closed: 0, backlog: 0, medianHoursToClose: null }] }),
    });
    renderPage();
    const cards = screen.getByRole("list", { name: "Report numbers" });
    expect(await within(cards).findByText(/^Open now: 0$/u)).toBeInTheDocument();
    expect(within(cards).getByText(/^Time to decision: –$/u)).toBeInTheDocument();
    expect(cards.querySelectorAll(".vizSpark")).toHaveLength(0);
    expect(await within(screen.getByRole("region", { name: "Backlog" })).findByRole("img", { name: "Open reports: 0, Within target" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Reports by reason" })).getByText("No open reports.")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Most reported communities" })).getByText("No community has open reports.")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Opened vs closed" })).getByText(/^No reports opened or closed/u)).toBeInTheDocument();
  });

  it("shows an error with Retry on every tile when the stats read fails, while the queue still works", async () => {
    mockApi({ ...routes, "GET /api/v1/admin/reports/stats": json({ code: "boom", message: "Stats are down" }, 500) });
    renderPage();
    for (const name of ["Backlog", "Reports by reason", "Opened vs closed", "Most reported communities"]) {
      const tile = await screen.findByRole("region", { name });
      expect(await within(tile).findByRole("button", { name: /Retry/u })).toBeInTheDocument();
    }
    expect(screen.getByText(/^Open now: –$/u)).toBeInTheDocument();
    const pane = screen.getByRole("region", { name: "Selected report" });
    await waitFor(() => expect(within(pane).getByRole("heading", { name: /Reported for spam/u })).toBeInTheDocument());
  });
});
