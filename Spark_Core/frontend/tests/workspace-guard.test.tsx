import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type AuthWorkspace = { workspaceId: string; workspaceName: string; workspaceSlug: string; role: string };

const router = { replace: vi.fn(), push: vi.fn() };
const navigation = { pathname: "/w/northstar-labs", params: { slug: "northstar-labs" } as Record<string, string> };
const auth = {
  isAuthenticated: true,
  isLoading: false,
  platformRoles: [] as string[],
  user: { id: "me", displayName: "Avery Founder", email: "avery@example.com", avatarUrl: null },
  workspaces: [] as AuthWorkspace[],
  logout: vi.fn(),
  refreshSession: vi.fn(async () => {}),
};

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(),
  useParams: () => navigation.params,
}));
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));

import WorkspaceResolverPage from "../src/app/workspace/page";
import WorkspaceLayout from "../src/app/w/[slug]/layout";
import WorkspaceHomePage from "../src/app/w/[slug]/page";
import SchedulePage from "../src/app/schedule/page";

const LAST_KEY = "spark:last-workspace";
const northstar: AuthWorkspace = { workspaceId: "w1", workspaceName: "Northstar Labs", workspaceSlug: "northstar-labs", role: "owner" };
const orbit: AuthWorkspace = { workspaceId: "w2", workspaceName: "Orbit Studio", workspaceSlug: "orbit-studio", role: "member" };
const workspace = { id: "w1", slug: "northstar-labs", name: "Northstar Labs", role: "owner", memberCount: 4, version: 2, createdAt: "2026-10-18T10:00:00.000Z" };

let requested: string[] = [];
function mockApi(routes: Record<string, () => Response>) {
  requested = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    requested.push(key);
    const handler = Object.entries(routes).find(([pattern]) => key.startsWith(pattern))?.[1];
    return handler ? handler() : new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
  }));
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ETag: "\"v2\"" } });

beforeEach(() => {
  auth.isAuthenticated = true;
  auth.isLoading = false;
  auth.workspaces = [northstar, orbit];
  navigation.pathname = "/w/northstar-labs";
  navigation.params = { slug: "northstar-labs" };
  router.replace.mockClear();
  router.push.mockClear();
  auth.refreshSession.mockClear();
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("/workspace resolver", () => {
  it("sends signed-out visitors to sign in", () => {
    auth.isAuthenticated = false;
    render(<WorkspaceResolverPage />);
    expect(router.replace).toHaveBeenCalledWith("/login?redirect=%2Fworkspace");
  });

  it("starts onboarding when the person has no workspace", () => {
    auth.workspaces = [];
    render(<WorkspaceResolverPage />);
    expect(router.replace).toHaveBeenCalledWith("/onboarding");
  });

  it("opens the remembered workspace while the person is still a member", () => {
    window.localStorage.setItem(LAST_KEY, "orbit-studio");
    render(<WorkspaceResolverPage />);
    expect(router.replace).toHaveBeenCalledWith("/w/orbit-studio");
  });

  it("falls back to the first workspace when the remembered one is gone", () => {
    window.localStorage.setItem(LAST_KEY, "left-long-ago");
    render(<WorkspaceResolverPage />);
    expect(router.replace).toHaveBeenCalledWith("/w/northstar-labs");
  });

  it("waits while the session is loading", () => {
    auth.isLoading = true;
    render(<WorkspaceResolverPage />);
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("/w/[slug] guard", () => {
  it("sends signed-out visitors to sign in and back to this workspace", () => {
    auth.isAuthenticated = false;
    mockApi({});
    render(<WorkspaceLayout><p>Inside</p></WorkspaceLayout>);
    expect(router.replace).toHaveBeenCalledWith("/login?redirect=%2Fw%2Fnorthstar-labs");
    expect(requested).toEqual([]);
  });

  it("shows a calm not-found state on 404 and refreshes the session", async () => {
    mockApi({ "GET /api/v1/workspaces/by-slug/northstar-labs": json({ code: "workspace_not_found" }, 404) });
    window.localStorage.setItem(LAST_KEY, "northstar-labs");
    render(<WorkspaceLayout><p>Inside</p></WorkspaceLayout>);
    expect(await screen.findByRole("heading", { name: "This workspace isn't available to you" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /your workspaces/i })).toHaveAttribute("href", "/workspace");
    expect(screen.queryByText("Inside")).not.toBeInTheDocument();
    await waitFor(() => expect(auth.refreshSession).toHaveBeenCalledTimes(1));
    expect(window.localStorage.getItem(LAST_KEY)).toBeNull();
  });

  it("renders the workspace inside the shell and remembers it", async () => {
    mockApi({ "GET /api/v1/workspaces/by-slug/northstar-labs": json(workspace) });
    render(<WorkspaceLayout><p>Inside</p></WorkspaceLayout>);
    expect(await screen.findByText("Inside")).toBeInTheDocument();
    expect(window.localStorage.getItem(LAST_KEY)).toBe("northstar-labs");
    const nav = screen.getByRole("navigation", { name: "Workspace navigation" });
    expect(within(nav).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/w/northstar-labs");
    expect(within(nav).getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Members" })).toHaveAttribute("href", "/w/northstar-labs/members");
    expect(within(nav).getByRole("link", { name: "Notifications" })).toHaveTextContent(/^Notifications$/);
  });

  it("keeps working when storage is blocked", async () => {
    mockApi({ "GET /api/v1/workspaces/by-slug/northstar-labs": json(workspace) });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    render(<WorkspaceLayout><p>Inside</p></WorkspaceLayout>);
    expect(await screen.findByText("Inside")).toBeInTheDocument();
    setItem.mockRestore();
  });
});

describe("workspace home", () => {
  it("shows members, pending invites and the invite action for owners", async () => {
    mockApi({
      "GET /api/v1/workspaces/by-slug/northstar-labs": json(workspace),
      "GET /api/v1/workspaces/w1/invitations?status=pending": json({ items: [{ id: "i1" }, { id: "i2" }] }),
    });
    render(<WorkspaceLayout><WorkspaceHomePage /></WorkspaceLayout>);
    expect(await screen.findByRole("heading", { level: 1, name: "Northstar Labs" })).toBeInTheDocument();
    expect(screen.getByText("Owner", { selector: ".eyebrow" })).toBeInTheDocument();
    expect(screen.getByTestId("stat-members")).toHaveTextContent("4");
    await waitFor(() => expect(screen.getByTestId("stat-invites")).toHaveTextContent("2"));
    expect(screen.getByText("Your first project starts here — choose Scrum, Kanban or Waterfall.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Invite teammates" })).toHaveAttribute("href", "/w/northstar-labs/members");
  });

  it("hides invitations from members", async () => {
    mockApi({ "GET /api/v1/workspaces/by-slug/northstar-labs": json({ ...workspace, role: "member" }) });
    render(<WorkspaceLayout><WorkspaceHomePage /></WorkspaceLayout>);
    expect(await screen.findByRole("heading", { level: 1, name: "Northstar Labs" })).toBeInTheDocument();
    expect(screen.queryByTestId("stat-invites")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Invite teammates" })).not.toBeInTheDocument();
    expect(requested.some((key) => key.includes("/invitations"))).toBe(false);
  });
});

describe("workspace shell", () => {
  it("lists workspaces in the switcher and offers to create one", async () => {
    navigation.pathname = "/schedule";
    render(<SchedulePage />);
    await userEvent.click(screen.getByRole("button", { name: /switch workspace/i }));
    const menu = await screen.findByRole("navigation", { name: "Your workspaces" });
    expect(within(menu).getByRole("link", { name: /Orbit Studio/ })).toHaveAttribute("href", "/w/orbit-studio");
    expect(within(menu).getByRole("link", { name: /Create workspace/ })).toHaveAttribute("href", "/onboarding");
  });

  it("works with zero workspaces", async () => {
    auth.workspaces = [];
    navigation.pathname = "/schedule";
    render(<SchedulePage />);
    await userEvent.click(screen.getByRole("button", { name: /switch workspace/i }));
    const menu = await screen.findByRole("navigation", { name: "Your workspaces" });
    expect(within(menu).getAllByRole("link")).toHaveLength(1);
    expect(within(menu).getByRole("link", { name: /Create workspace/ })).toHaveAttribute("href", "/onboarding");
    expect(screen.queryByRole("link", { name: "Members" })).not.toBeInTheDocument();
  });
});
