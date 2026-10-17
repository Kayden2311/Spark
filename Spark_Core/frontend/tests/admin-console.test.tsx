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
    expect(await within(nav).findByLabelText("2 need attention")).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  });
});

describe("reports queue", () => {
  function renderQueue() {
    navigation.pathname = "/admin/reports";
    return render(<AdminLayout><ReportsPage /></AdminLayout>);
  }

  it("resolves a report with a reason, removes it from the open queue and confirms", async () => {
    mockApi({
      "GET /api/v1/admin/overview": json(overview),
      "GET /api/v1/admin/reports?status=open": json({ items: [report], nextCursor: null }),
      "POST /api/v1/admin/reports/r1/actions": json({ id: "r1", status: "resolved" }),
    });
    renderQueue();
    await userEvent.click(await screen.findByRole("button", { name: "Review" }));
    const drawer = screen.getByRole("dialog", { name: "Reported post" });
    expect(within(drawer).getByText("50x guaranteed returns")).toBeInTheDocument();
    expect(within(drawer).getByText("Riley Reporter")).toBeInTheDocument();

    await userEvent.click(within(drawer).getByRole("button", { name: "Hide content" }));
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
      "GET /api/v1/admin/overview": json(overview),
      "GET /api/v1/admin/reports?status=open": json({ items: [report], nextCursor: null }),
      "POST /api/v1/admin/reports/r1/actions": json({ code: "report_already_closed", detail: "This report has already been resolved or dismissed." }, 409),
    });
    renderQueue();
    await userEvent.click(await screen.findByRole("button", { name: "Review" }));
    await userEvent.click(screen.getByRole("button", { name: "Dismiss report" }));
    const dialog = screen.getByRole("dialog", { name: "Dismiss this report?" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: /reason/i }), "Not a violation");
    await userEvent.click(within(dialog).getByRole("button", { name: "Dismiss report" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("already been resolved");
  });

  it("loads further pages with the cursor and shows an error with retry", async () => {
    let failOnce = true;
    mockApi({
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
    expect(await screen.findByRole("alert")).toHaveTextContent(/on our side/);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Second report")).toBeInTheDocument();
    expect(screen.getByText("2 shown")).toBeInTheDocument();
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
  it("returns focus to the drawer button after cancelling its dialog", async () => {
    navigation.pathname = "/admin/reports";
    mockApi({ "GET /api/v1/admin/overview": json(overview), "GET /api/v1/admin/reports?status=open": json({ items: [report], nextCursor: null }) });
    render(<AdminLayout><ReportsPage /></AdminLayout>);
    await userEvent.click(await screen.findByRole("button", { name: "Review" }));
    const hide = within(screen.getByRole("dialog", { name: "Reported post" })).getByRole("button", { name: "Hide content" });
    await userEvent.click(hide);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(hide).toHaveFocus();
  });

  it("reloads the queue when an action reports the item already changed", async () => {
    let listCalls = 0;
    navigation.pathname = "/admin/reports";
    mockApi({
      "GET /api/v1/admin/overview": json(overview),
      "GET /api/v1/admin/reports?status=open": () => (++listCalls === 1 ? json({ items: [report], nextCursor: null })() : json({ items: [], nextCursor: null })()),
      "POST /api/v1/admin/reports/r1/actions": json({ code: "report_already_closed", detail: "This report has already been resolved or dismissed." }, 409),
    });
    render(<AdminLayout><ReportsPage /></AdminLayout>);
    await userEvent.click(await screen.findByRole("button", { name: "Review" }));
    await userEvent.click(screen.getByRole("button", { name: "Dismiss report" }));
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
    expect(await screen.findByRole("button", { name: "Suspend Member Mia" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Suspend Another Admin" })).not.toBeInTheDocument();
  });
});
