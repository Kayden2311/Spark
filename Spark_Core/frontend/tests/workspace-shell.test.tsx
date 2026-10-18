import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LIST } from "./project-fixtures";

const navigation = { pathname: "/w/northstar-labs" };
const auth = {
  isAuthenticated: true,
  isLoading: false,
  platformRoles: [] as string[],
  user: { id: "u-avery", displayName: "Avery Founder", email: "avery@example.com", avatarUrl: null },
  workspaces: [{ workspaceId: "w1", workspaceName: "Northstar Labs", workspaceSlug: "northstar-labs", role: "owner" }],
  logout: vi.fn(),
  refreshSession: vi.fn(async () => {}),
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ slug: "northstar-labs" }),
}));
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));

import { WorkspaceShell } from "../src/app/components";
import WorkspaceLayout from "../src/app/w/[slug]/layout";

const owner = { slug: "northstar-labs", name: "Northstar Labs", role: "owner" };
const member = { ...owner, role: "member" };

beforeEach(() => {
  navigation.pathname = "/w/northstar-labs";
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("workspace shell projects", () => {
  it("lists project links with a methodology dot and offers New project to owners", () => {
    render(<WorkspaceShell current="Home" projects={LIST} workspace={owner}><p>Inside</p></WorkspaceShell>);
    const nav = screen.getByRole("navigation", { name: "Projects" });
    const atlas = within(nav).getByRole("link", { name: "Atlas app" });
    expect(atlas).toHaveAttribute("href", "/w/northstar-labs/p/ATLAS");
    expect(atlas.querySelector("[data-methodology]")).toHaveAttribute("data-methodology", "scrum");
    expect(within(nav).getByRole("link", { name: "Ops desk" }).querySelector("[data-methodology]")).toHaveAttribute("data-methodology", "kanban");
    expect(within(nav).getByRole("link", { name: "Website relaunch" }).querySelector("[data-methodology]")).toHaveAttribute("data-methodology", "waterfall");
    expect(within(nav).getByRole("link", { name: "New project" })).toHaveAttribute("href", "/w/northstar-labs/projects/new");
  });

  it("hides New project from plain members", () => {
    render(<WorkspaceShell current="Home" projects={LIST} workspace={member}><p>Inside</p></WorkspaceShell>);
    const nav = screen.getByRole("navigation", { name: "Projects" });
    expect(within(nav).getAllByRole("link")).toHaveLength(3);
    expect(within(nav).queryByRole("link", { name: "New project" })).not.toBeInTheDocument();
  });

  it("shows at most eight projects and links to the rest", () => {
    const many = Array.from({ length: 10 }, (_, index) => ({ ...LIST[1], id: `p${index}`, key: `K${index}X`, name: `Project ${index}` }));
    render(<WorkspaceShell current="Home" projects={many} workspace={member}><p>Inside</p></WorkspaceShell>);
    const nav = screen.getByRole("navigation", { name: "Projects" });
    expect(within(nav).getAllByRole("link", { name: /^Project \d$/ })).toHaveLength(8);
    expect(within(nav).getByRole("link", { name: "All 10 projects" })).toHaveAttribute("href", "/w/northstar-labs#projects");
  });

  it("marks the open project as the current page", () => {
    navigation.pathname = "/w/northstar-labs/p/OPS";
    render(<WorkspaceShell current="" projects={LIST} workspace={owner}><p>Inside</p></WorkspaceShell>);
    const nav = screen.getByRole("navigation", { name: "Projects" });
    expect(within(nav).getByRole("link", { name: "Ops desk" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Atlas app" })).not.toHaveAttribute("aria-current");
  });

  it("has no project section outside a workspace route", () => {
    render(<WorkspaceShell current="Schedule"><p>Inside</p></WorkspaceShell>);
    expect(screen.queryByRole("navigation", { name: "Projects" })).not.toBeInTheDocument();
  });

  it("loads the workspace's projects into the shell from the layout", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "/api/v1/workspaces/by-slug/northstar-labs") return reply({ id: "w1", slug: "northstar-labs", name: "Northstar Labs", role: "owner", memberCount: 2, version: 1, createdAt: "2026-10-18T10:00:00.000Z" });
      if (url === "/api/v1/workspaces/w1/projects") return reply({ items: LIST });
      return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
    }));
    render(<WorkspaceLayout><p>Inside</p></WorkspaceLayout>);
    const nav = await screen.findByRole("navigation", { name: "Projects" });
    expect(await within(nav).findByRole("link", { name: "Website relaunch" })).toHaveAttribute("href", "/w/northstar-labs/p/WEB");
  });
});
