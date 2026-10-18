import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LIST } from "./project-fixtures";

const router = { replace: vi.fn(), push: vi.fn() };
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
  useRouter: () => router,
  usePathname: () => "/w/northstar-labs",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ slug: "northstar-labs" }),
}));
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));

import WorkspaceLayout from "../src/app/w/[slug]/layout";
import WorkspaceHomePage from "../src/app/w/[slug]/page";

const workspace = { id: "w1", slug: "northstar-labs", name: "Northstar Labs", role: "owner", memberCount: 2, version: 2, createdAt: "2026-10-18T10:00:00.000Z" };

function mockApi(role: string, projects: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "/api/v1/workspaces/by-slug/northstar-labs") return reply({ ...workspace, role });
    if (url === "/api/v1/workspaces/w1/projects") return reply({ items: projects });
    if (url.startsWith("/api/v1/workspaces/w1/invitations")) return reply({ items: [] });
    return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
  }));
}

async function renderHome() {
  render(<WorkspaceLayout><WorkspaceHomePage /></WorkspaceLayout>);
  await screen.findByRole("heading", { level: 1, name: "Northstar Labs" });
  return screen.getByRole("region", { name: "Projects" });
}

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("workspace home projects", () => {
  it("lists projects with key, methodology pill, lead and progress", async () => {
    mockApi("owner", LIST);
    const section = await renderHome();
    const atlas = await within(section).findByRole("link", { name: /Atlas app/ });
    expect(atlas).toHaveAttribute("href", "/w/northstar-labs/p/ATLAS");
    expect(within(atlas).getByText("ATLAS")).toBeInTheDocument();
    expect(within(atlas).getByText("Scrum")).toHaveAttribute("data-methodology", "scrum");
    expect(within(atlas).getByText("3/8 done")).toBeInTheDocument();
    expect(within(atlas).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "3");
    expect(within(atlas).getByTitle("Lead: Avery Founder")).toHaveTextContent("AF");

    const ops = within(section).getByRole("link", { name: /Ops desk/ });
    expect(within(ops).getByText("Kanban")).toHaveAttribute("data-methodology", "kanban");
    expect(within(ops).getByText("No tasks yet")).toBeInTheDocument();
    expect(within(ops).queryByRole("progressbar")).not.toBeInTheDocument();

    const web = within(section).getByRole("link", { name: /Website relaunch/ });
    expect(within(web).getByText("Waterfall")).toHaveAttribute("data-methodology", "waterfall");
    expect(within(web).getByText("No lead")).toBeInTheDocument();

    expect(within(section).getByRole("link", { name: "New project" })).toHaveAttribute("href", "/w/northstar-labs/projects/new");
    expect(within(section).queryByText("Coming next")).not.toBeInTheDocument();
  });

  it("hides New project from plain members", async () => {
    mockApi("member", LIST);
    const section = await renderHome();
    await within(section).findByRole("link", { name: /Atlas app/ });
    expect(screen.queryByRole("link", { name: "New project" })).not.toBeInTheDocument();
  });

  it("keeps the methodology tiles in the empty state and links them to project creation", async () => {
    mockApi("owner", []);
    const section = await renderHome();
    expect(await within(section).findByText("Your first project starts here — choose Scrum, Kanban or Waterfall.")).toBeInTheDocument();
    for (const name of ["Scrum", "Kanban", "Waterfall"]) {
      expect(within(section).getByRole("link", { name: new RegExp(name) })).toHaveAttribute("href", "/w/northstar-labs/projects/new");
    }
  });

  it("tells members who creates projects when there are none", async () => {
    mockApi("member", []);
    const section = await renderHome();
    expect(await within(section).findByText("Owners and admins create projects. They'll show up here as soon as they exist.")).toBeInTheDocument();
    expect(within(section).queryByRole("link")).not.toBeInTheDocument();
    expect(within(section).getByText("Kanban")).toBeInTheDocument();
  });
});
