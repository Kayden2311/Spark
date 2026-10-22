import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), push: vi.fn() };
const navigation = { pathname: "/admin/users", search: new URLSearchParams() };
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
import UsersAdminPage from "../src/app/admin/users/page";

const overview = {
  communities: { active: 12, featured: 1, frozen: 0, archived: 2, flagged: 5 },
  users: { active: 90, suspended: 3 },
  reports: { open: 4 },
  campaigns: { pending: 0, approved: 0 },
  workspaces: { active: 4 },
  auditEvents: 9,
};

const totals = (signups: number, avgActiveUsers: number) => ({ signups, signIns: 80, posts: 30, comments: 20, reportsOpened: 3, reportsClosed: 2, avgActiveUsers });
const activity = {
  days: 30,
  series: [
    { day: "2026-10-18", activeUsers: 30, signups: 3, signIns: 20, posts: 10, comments: 6, reportsOpened: 1, reportsClosed: 1 },
    { day: "2026-10-19", activeUsers: 38, signups: 4, signIns: 20, posts: 10, comments: 6, reportsOpened: 1, reportsClosed: 1 },
    { day: "2026-10-20", activeUsers: 52, signups: 5, signIns: 20, posts: 20, comments: 14, reportsOpened: 1, reportsClosed: 1 },
  ],
  current: totals(12, 40),
  previous: totals(8, 32),
  audience: { dau: 10, wau: 25, mau: 31, totalUsers: 93 },
};

const person = (id: string, name: string, roles: string[], status = "active") => ({
  id, displayName: name, email: `${id}@example.com`, avatarUrl: null, status, createdAt: "2026-10-01T00:00:00.000Z", lastLoginAt: null, platformRoles: roles, workspaceCount: 0,
});
const holders = (count: number) => ({ items: Array.from({ length: count }, (_, index) => person(`h${index}`, `Holder ${index}`, ["platform_admin"])), nextCursor: null });
const directory = { items: [person("a", "Another Admin", ["platform_admin"]), person("m", "Member Mia", []), person("s", "Suspended Sam", [], "suspended")], nextCursor: null };

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

// Role holder reads first: the directory handler matches every other /users request.
const routes = {
  "GET /api/v1/admin/overview": json(overview),
  "GET /api/v1/admin/analytics/activity": json(activity),
  "GET /api/v1/admin/users?role=super_admin&limit=100": json(holders(1)),
  "GET /api/v1/admin/users?role=platform_admin&limit=100": json(holders(2)),
  "GET /api/v1/admin/users?role=community_moderator&limit=100": json(holders(1)),
  "GET /api/v1/admin/users?role=content_moderator&limit=100": json(holders(0)),
  "GET /api/v1/admin/users?role=campaign_moderator&limit=100": json(holders(1)),
  "GET /api/v1/admin/users": json(directory),
};

beforeEach(() => {
  requests = [];
  router.replace.mockClear();
  auth.platformRoles = ["platform_admin"];
  navigation.pathname = "/admin/users";
  navigation.search = new URLSearchParams();
});
afterEach(() => vi.unstubAllGlobals());

describe("users dashboard", () => {
  it("shows four trend cards from the activity, overview and role holder reads", async () => {
    mockApi(routes);
    render(<AdminLayout><UsersAdminPage /></AdminLayout>);
    const cards = screen.getByRole("list", { name: "Membership numbers" });
    expect(within(cards).getAllByRole("listitem")).toHaveLength(4);
    expect(await within(cards).findByText(/^New members: 12, \+50% vs previous period, improving$/u)).toBeInTheDocument();
    expect(within(cards).getByText(/^Avg\. daily users: 40, \+25% vs previous period, improving$/u)).toBeInTheDocument();
    expect(await within(cards).findByText(/^Suspended: 3$/u)).toBeInTheDocument();
    expect(await within(cards).findByText(/^Staff role grants: 5$/u)).toBeInTheDocument();
    const items = within(cards).getAllByRole("listitem");
    // Sign-ups and active users have daily history; suspensions and role grants do not, so no sparkline.
    expect(items[0]!.querySelector(".admTrendCardSpark")).not.toBeNull();
    expect(items[1]!.querySelector(".admTrendCardSpark")).not.toBeNull();
    expect(items[2]!.querySelector(".admTrendCardSpark")).toBeNull();
    expect(items[3]!.querySelector(".admTrendCardSpark")).toBeNull();
    expect(within(items[2]!).getByRole("link")).toHaveAttribute("href", "/admin/users?status=suspended");
    expect(requests.filter((url) => url.includes("/admin/analytics/activity"))).toEqual(["/api/v1/admin/analytics/activity?days=30"]);
  });

  it("marks the role grant count as a floor when a role has more holders than one page", async () => {
    mockApi({ ...routes, "GET /api/v1/admin/users?role=platform_admin&limit=100": json({ ...holders(2), nextCursor: "more" }) });
    render(<AdminLayout><UsersAdminPage /></AdminLayout>);
    const cards = screen.getByRole("list", { name: "Membership numbers" });
    expect(await within(cards).findByText(/^Staff role grants: 5\+$/u)).toBeInTheDocument();
  });

  it("charts sign-ups per day and the platform role mix, each with a table view", async () => {
    mockApi(routes);
    render(<AdminLayout><UsersAdminPage /></AdminLayout>);
    const signups = await screen.findByRole("region", { name: "Sign-ups" });
    await userEvent.click(await within(signups).findByRole("button", { name: "View as table" }));
    expect(within(within(signups).getByRole("table")).getAllByRole("row")).toHaveLength(4);

    const roles = screen.getByRole("region", { name: "Platform roles" });
    expect(await within(roles).findByText("role grants")).toBeInTheDocument();
    expect(within(roles).getByText("Super admin")).toBeInTheDocument();
    await userEvent.click(within(roles).getByRole("button", { name: "View as table" }));
    const rows = within(within(roles).getByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(6);
    expect(rows[2]).toHaveTextContent(/Platform admin\s*2/u);
  });

  it("splits accounts by status with links that filter the directory, and shows member reach", async () => {
    mockApi(routes);
    render(<AdminLayout><UsersAdminPage /></AdminLayout>);
    const status = await screen.findByRole("region", { name: "Account status" });
    expect(await within(status).findByRole("link", { name: "Active" })).toHaveAttribute("href", "/admin/users?status=active");
    expect(within(status).getByRole("link", { name: "Suspended" })).toHaveAttribute("href", "/admin/users?status=suspended");
    expect(within(status).getByText("90")).toBeInTheDocument();

    const reach = screen.getByRole("region", { name: "Member reach" });
    expect(await within(reach).findByRole("img", { name: "33%: 31 of 93 members were active in the last 30 days" })).toBeInTheDocument();
  });

  it("requests no dashboard reads in the Roles & access view", async () => {
    navigation.search = new URLSearchParams("view=roles");
    mockApi(routes);
    render(<AdminLayout><UsersAdminPage /></AdminLayout>);
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Membership numbers" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Sign-ups" })).not.toBeInTheDocument();
    await waitFor(() => expect(requests.some((url) => url.includes("role=super_admin"))).toBe(true));
    expect(requests.some((url) => url.includes("/analytics/"))).toBe(false);
  });
});

describe("users directory", () => {
  it("lists the directory below the dashboard in cards and in a table", async () => {
    mockApi(routes);
    const { unmount } = render(<AdminLayout><UsersAdminPage /></AdminLayout>);
    const directoryList = await screen.findByRole("link", { name: /Member Mia/u });
    expect(directoryList.closest(".admPersonGrid")).not.toBeNull();
    unmount();

    navigation.search = new URLSearchParams("layout=table");
    render(<AdminLayout><UsersAdminPage /></AdminLayout>);
    const row = (await screen.findByText("Member Mia")).closest("tr");
    expect(row).not.toBeNull();
    expect(within(row!).getByRole("button", { name: "Actions for Member Mia" })).toBeInTheDocument();
  });

  it("asks the directory read for the status and role in the address", async () => {
    navigation.search = new URLSearchParams("status=suspended&role=content_moderator");
    mockApi(routes);
    render(<AdminLayout><UsersAdminPage /></AdminLayout>);
    await waitFor(() => expect(requests).toContain("/api/v1/admin/users?status=suspended&role=content_moderator"));
  });

  it("keeps the status tabs, role select and search wired to the directory", async () => {
    mockApi(routes);
    render(<AdminLayout><UsersAdminPage /></AdminLayout>);
    await screen.findByRole("link", { name: /Member Mia/u });
    const tabs = screen.getByRole("group", { name: "Account status" });
    await userEvent.click(within(tabs).getByRole("button", { name: /Suspended/u }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/users?status=suspended", { scroll: false });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Platform role" }), "community_moderator");
    expect(router.replace).toHaveBeenLastCalledWith("/admin/users?role=community_moderator", { scroll: false });
    await userEvent.type(screen.getByRole("searchbox", { name: "Search users" }), "mia");
    await waitFor(() => expect(requests).toContain("/api/v1/admin/users?search=mia"));
  });
});
