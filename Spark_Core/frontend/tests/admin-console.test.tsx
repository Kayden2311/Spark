import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), push: vi.fn() };
const navigation = { pathname: "/admin", search: new URLSearchParams() };
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
import AuditLogPage from "../src/app/admin/audit/page";
import ReportsPage from "../src/app/admin/reports/page";
import UsersAdminPage from "../src/app/admin/users/page";
import BillingPage from "../src/app/admin/billing/page";
import CampaignsAdminPage from "../src/app/admin/campaigns/page";
import { ChartCard } from "../src/app/admin/_components/charts";

const overview = {
  communities: { active: 3, featured: 1, frozen: 0, archived: 0, flagged: 1 },
  users: { active: 5, suspended: 1 },
  reports: { open: 2 },
  campaigns: { pending: 1, approved: 0 },
  workspaces: { active: 4 },
  auditEvents: 9,
};

const report = {
  id: "r1",
  status: "open",
  reasonCode: "spam",
  details: "Bot links",
  createdAt: "2026-10-17T10:00:00.000Z",
  resolvedAt: null,
  community: { id: "c1", name: "Hyperdrive Founders", slug: "hyperdrive" },
  reporter: { id: "u2", displayName: "Riley Reporter" },
  target: { kind: "post", id: "p1", title: "Crypto bot offer", body: "50x guaranteed returns", moderationStatus: "visible" },
};

let requests: Array<{ url: string; method: string; body?: unknown }> = [];

function mockApi(routes: Record<string, () => Response>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${init?.method ?? "GET"} ${url}`;
    const handler = Object.entries(routes).find(([pattern]) => key.startsWith(pattern))?.[1];
    return handler ? handler() : new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
  }));
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  requests = [];
  auth.isAuthenticated = true;
  auth.isLoading = false;
  auth.platformRoles = ["content_moderator"];
  navigation.pathname = "/admin";
  navigation.search = new URLSearchParams();
  router.replace.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("admin console shell", () => {
  it("sends signed-out visitors to sign in and returns them afterwards", async () => {
    auth.isAuthenticated = false;
    navigation.pathname = "/admin/reports";
    mockApi({});
    render(<AdminLayout><p>Secret</p></AdminLayout>);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login?redirect=%2Fadmin%2Freports"));
    expect(screen.queryByText("Secret")).not.toBeInTheDocument();
  });

  it("turns away signed-in members without a platform role", () => {
    auth.platformRoles = [];
    mockApi({});
    render(<AdminLayout><p>Secret</p></AdminLayout>);
    expect(screen.getByRole("heading", { name: /for spark staff/i })).toBeInTheDocument();
    expect(screen.queryByText("Secret")).not.toBeInTheDocument();
    expect(requests).toEqual([]);
  });

  it("shows only the sections the caller's roles allow, with queue counts", async () => {
    mockApi({ "GET /api/v1/admin/overview": json(overview) });
    render(<AdminLayout><p>Content</p></AdminLayout>);
    const nav = screen.getByRole("navigation", { name: "Admin sections" });
    expect(within(nav).getAllByRole("link").map((link) => link.textContent)).toEqual(["Overview", expect.stringMatching(/^Reports/)]);
    expect(await within(nav).findByRole("link", { name: /Reports.*2 need attention/u })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  });
});

// Side panels of the triage desk: queue health and the author's history.
const triage = {
  "GET /api/v1/admin/reports/stats": json({ days: 30, opened: 4, closed: 2, backlog: 2, medianHoursToClose: 5.5 }),
  "GET /api/v1/admin/reports/r1/context": json({ author: { id: "u9", displayName: "Sam Spammer", status: "active", joinedAt: "2026-09-01T00:00:00.000Z", reportsAgainst: 4, hiddenContent: 1 }, communityOpenReports: 3, reporterReportsFiled: 1 }),
};

describe("reports queue", () => {
  function renderQueue() {
    navigation.pathname = "/admin/reports";
    return render(<AdminLayout><ReportsPage /></AdminLayout>);
  }

  it("resolves a report with a reason, removes it from the open queue and confirms", async () => {
    mockApi({
      ...triage,
      "GET /api/v1/admin/overview": json(overview),
      "GET /api/v1/admin/reports?status=open": json({ items: [report], nextCursor: null }),
      "POST /api/v1/admin/reports/r1/actions": json({ id: "r1", status: "resolved" }),
    });
    renderQueue();
    const pane = await screen.findByRole("region", { name: "Selected report" });
    expect(await within(pane).findByText("50x guaranteed returns")).toBeInTheDocument();
    expect(within(pane).getByText("Riley Reporter")).toBeInTheDocument();
    // The author's history helps spot repeat offenders.
    expect(await within(pane).findByText("Sam Spammer")).toBeInTheDocument();
    expect(within(pane).getByText("Repeat reports")).toBeInTheDocument();

    await userEvent.click(within(pane).getByRole("button", { name: /^Hide content/u }));
    const dialog = screen.getByRole("dialog", { name: "Hide this content?" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: /reason/i }), "Scam links");
    await userEvent.click(within(dialog).getByRole("button", { name: "Hide content" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(requests.find((r) => r.method === "POST")).toEqual({ url: "/api/v1/admin/reports/r1/actions", method: "POST", body: { action: "hide", reason: "Scam links" } });
    expect(screen.getByText("The queue is clear")).toBeInTheDocument();
    expect(screen.getByText("Content hidden and report resolved.")).toBeInTheDocument();
  });

  it("keeps the report and shows the conflict when someone else already closed it", async () => {
    mockApi({
      ...triage,
      "GET /api/v1/admin/overview": json(overview),
      "GET /api/v1/admin/reports?status=open": json({ items: [report], nextCursor: null }),
      "POST /api/v1/admin/reports/r1/actions": json({ code: "report_already_closed", detail: "This report has already been resolved or dismissed." }, 409),
    });
    renderQueue();
    await userEvent.click(await screen.findByRole("button", { name: /^Dismiss D/u }));
    const dialog = screen.getByRole("dialog", { name: "Dismiss this report?" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: /reason/i }), "Not a violation");
    await userEvent.click(within(dialog).getByRole("button", { name: "Dismiss report" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("already been resolved");
  });

  it("loads further pages with the cursor and shows an error with retry", async () => {
    let failOnce = true;
    mockApi({
      ...triage,
      "GET /api/v1/admin/overview": json(overview),
      "GET /api/v1/admin/reports?status=open&cursor=next-1": json({ items: [{ ...report, id: "r2", target: { ...report.target, title: "Second report" } }], nextCursor: null }),
      "GET /api/v1/admin/reports?status=open": () => {
        if (failOnce) {
          failOnce = false;
          return new Response(JSON.stringify({ code: "internal_error" }), { status: 500 });
        }
        return json({ items: [report], nextCursor: "next-1" })();
      },
    });
    renderQueue();
    expect((await screen.findAllByRole("alert"))[0]).toHaveTextContent(/on our side/);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Second report")).toBeInTheDocument();
    expect(screen.getByText("2 reports")).toBeInTheDocument();
  });

  it("explains missing access instead of calling the API", async () => {
    auth.platformRoles = ["campaign_moderator"];
    mockApi({ "GET /api/v1/admin/overview": json(overview) });
    renderQueue();
    expect(screen.getByRole("heading", { name: /don't have access/i })).toBeInTheDocument();
    await waitFor(() => expect(requests.some((r) => r.url.includes("/reports"))).toBe(false));
  });
});

describe("review fixes", () => {
  it("returns focus to the action button after cancelling its dialog", async () => {
    navigation.pathname = "/admin/reports";
    mockApi({ ...triage, "GET /api/v1/admin/overview": json(overview), "GET /api/v1/admin/reports?status=open": json({ items: [report], nextCursor: null }) });
    render(<AdminLayout><ReportsPage /></AdminLayout>);
    const hide = await screen.findByRole("button", { name: /^Hide content/u });
    await userEvent.click(hide);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(hide).toHaveFocus();
  });

  it("reloads the queue when an action reports the item already changed", async () => {
    let listCalls = 0;
    navigation.pathname = "/admin/reports";
    mockApi({
      ...triage,
      "GET /api/v1/admin/overview": json(overview),
      "GET /api/v1/admin/reports?status=open": () => (++listCalls === 1 ? json({ items: [report], nextCursor: null })() : json({ items: [], nextCursor: null })()),
      "POST /api/v1/admin/reports/r1/actions": json({ code: "report_already_closed", detail: "This report has already been resolved or dismissed." }, 409),
    });
    render(<AdminLayout><ReportsPage /></AdminLayout>);
    await userEvent.click(await screen.findByRole("button", { name: /^Dismiss D/u }));
    const dialog = screen.getByRole("dialog", { name: "Dismiss this report?" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: /reason/i }), "Not a violation");
    await userEvent.click(within(dialog).getByRole("button", { name: "Dismiss report" }));
    await waitFor(() => expect(listCalls).toBe(2));
  });

  it("clears every audit filter in one navigation", async () => {
    auth.platformRoles = ["platform_admin"];
    navigation.pathname = "/admin/audit";
    navigation.search = new URLSearchParams("action=user.suspend&target=user&from=2026-01-01&to=2026-02-01");
    mockApi({ "GET /api/v1/admin/overview": json(overview), "GET /api/v1/admin/audit-logs": json({ items: [], nextCursor: null }) });
    render(<AdminLayout><AuditLogPage /></AdminLayout>);
    router.replace.mockClear();
    await userEvent.click(await screen.findByRole("button", { name: "Clear filters" }));
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith("/admin/audit", { scroll: false });
  });

  it("shows no suspend button on admin-tier accounts unless the viewer is a super admin", async () => {
    auth.platformRoles = ["platform_admin"];
    navigation.pathname = "/admin/users";
    const person = (id: string, name: string, roles: string[]) => ({ id, displayName: name, email: `${id}@example.com`, avatarUrl: null, status: "active", createdAt: "2026-10-01T00:00:00.000Z", lastLoginAt: null, platformRoles: roles, workspaceCount: 0 });
    mockApi({
      "GET /api/v1/admin/overview": json(overview),
      "GET /api/v1/admin/users": json({ items: [person("a", "Another Admin", ["platform_admin"]), person("m", "Member Mia", [])], nextCursor: null }),
    });
    render(<AdminLayout><UsersAdminPage /></AdminLayout>);
    // Row actions live in an overflow menu that follows the menu button pattern.
    const memberMenu = await screen.findByRole("button", { name: "Actions for Member Mia" });
    expect(memberMenu).toHaveAttribute("aria-haspopup", "menu");
    await userEvent.click(memberMenu);
    expect(memberMenu).toHaveAttribute("aria-expanded", "true");
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["View details", "Suspend user"]);
    expect(items[0]).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(items[1]).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(memberMenu).toHaveFocus();

    await userEvent.click(screen.getByRole("button", { name: "Actions for Another Admin" }));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["View details"]);
  });
});

describe("console v2", () => {
  beforeEach(() => window.localStorage.clear());

  it("collapses the sidebar to an icon rail with the button or the [ key, and remembers it", async () => {
    mockApi({ "GET /api/v1/admin/overview": json(overview) });
    const { container, unmount } = render(<AdminLayout><p>Content</p></AdminLayout>);
    const shell = container.querySelector(".admShell")!;
    expect(shell).toHaveAttribute("data-rail", "expanded");
    await userEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(shell).toHaveAttribute("data-rail", "collapsed");
    expect(window.localStorage.getItem("spark.admin.sidebar")).toBe("collapsed");
    // Collapsed links keep their names for screen readers and show a tooltip.
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("data-tip", "Overview");
    await userEvent.keyboard("[[");
    expect(shell).toHaveAttribute("data-rail", "expanded");
    await userEvent.keyboard("[[");
    unmount();
    const again = render(<AdminLayout><p>Content</p></AdminLayout>);
    expect(again.container.querySelector(".admShell")).toHaveAttribute("data-rail", "collapsed");
  });

  it("moves through the triage queue with J and K and opens actions with shortcuts", async () => {
    navigation.pathname = "/admin/reports";
    const second = { ...report, id: "r2", target: { ...report.target, title: "Second report", body: "Another body" } };
    mockApi({
      ...triage,
      "GET /api/v1/admin/reports/r2/context": json({ author: null, communityOpenReports: 0, reporterReportsFiled: 2 }),
      "GET /api/v1/admin/overview": json(overview),
      "GET /api/v1/admin/reports?status=open": json({ items: [report, second], nextCursor: null }),
    });
    render(<AdminLayout><ReportsPage /></AdminLayout>);
    const pane = await screen.findByRole("region", { name: "Selected report" });
    expect(await within(pane).findByRole("heading", { name: "Crypto bot offer" })).toBeInTheDocument();
    await userEvent.keyboard("j");
    expect(within(pane).getByRole("heading", { name: "Second report" })).toBeInTheDocument();
    expect(await within(pane).findByText("Deleted account")).toBeInTheDocument();
    await userEvent.keyboard("k");
    expect(within(pane).getByRole("heading", { name: "Crypto bot offer" })).toBeInTheDocument();
    await userEvent.keyboard("h");
    const dialog = screen.getByRole("dialog", { name: "Hide this content?" });
    // Reason templates fill the reason in one click.
    await userEvent.click(within(dialog).getByRole("button", { name: "Spam or unsolicited promotion." }));
    expect(within(dialog).getByRole("textbox", { name: /reason/i })).toHaveValue("Spam or unsolicited promotion.");
    // Shortcuts are ignored while a dialog is open.
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("groups campaigns into review columns on the board", async () => {
    auth.platformRoles = ["campaign_moderator"];
    navigation.pathname = "/admin/campaigns";
    const campaign = (id: string, name: string, reviewStatus: string) => ({
      id, name, reviewStatus, headline: `${name} headline`, description: "d", deliveryStatus: "not_scheduled", requestedStartAt: "2026-11-01T00:00:00.000Z",
      startsAt: null, endsAt: null, version: 1, createdAt: new Date(Date.now() - 4 * 86_400_000).toISOString(),
      community: { id: "c1", name: "Hyperdrive", slug: "hyperdrive" }, submitter: { id: "u1", displayName: "Owner" }, placement: null,
    });
    mockApi({
      "GET /api/v1/admin/overview": json(overview),
      "GET /api/v1/admin/campaigns?limit=100": json({ items: [campaign("a", "Launch week", "pending"), campaign("b", "Demo day", "approved"), campaign("c", "Crypto", "rejected")], nextCursor: null }),
    });
    render(<AdminLayout><CampaignsAdminPage /></AdminLayout>);
    const pending = await screen.findByRole("region", { name: "Pending review" });
    expect(within(pending).getByText("Launch week")).toBeInTheDocument();
    expect(within(pending).getByText("Waiting 4 days")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Approved" })).getByText("Demo day")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Rejected" })).getByText("Crypto")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("says plainly that no payment provider is connected on the billing page", async () => {
    auth.platformRoles = ["platform_admin"];
    navigation.pathname = "/admin/billing";
    mockApi({
      "GET /api/v1/admin/overview": json(overview),
      "GET /api/v1/admin/billing/overview": json({ counts: { freeWorkspaces: 3, trialing: 1, paying: 2, pastDue: 0, cancelled30d: 0, newPaid30d: 1, failedPayments30d: 0 }, revenue: [{ currency: "USD", mrrMinor: 12900, arrMinor: 154800, collected30dMinor: 2900, openMinor: 0, uncollectibleMinor: 0 }], planMix: [] }),
      "GET /api/v1/admin/billing/mrr": json({ months: 12, series: [] }),
      "GET /api/v1/admin/billing/subscriptions?kind=paid": json({ items: [], nextCursor: null }),
    });
    render(<AdminLayout><BillingPage /></AdminLayout>);
    expect(screen.getByText("No payment provider is connected yet.")).toBeInTheDocument();
    expect(await screen.findByText("$129.00")).toBeInTheDocument();
    expect(screen.getByText("$1,548 annual run rate")).toBeInTheDocument();
    expect(await screen.findByText("No subscriptions match")).toBeInTheDocument();
  });

  it("offers every chart's numbers as a table", async () => {
    render(
      <ChartCard table={{ columns: ["Day", "Posts"], rows: [["Oct 1", 4], ["Oct 2", 7]] }} title="Content created">
        <p>chart</p>
      </ChartCard>,
    );
    expect(screen.getByText("chart")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "View as table" }));
    const table = screen.getByRole("table", { name: "Content created" });
    expect(within(table).getByRole("rowheader", { name: "Oct 2" })).toBeInTheDocument();
    expect(within(table).getByText("7")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show chart" })).toHaveAttribute("aria-pressed", "true");
  });
});
