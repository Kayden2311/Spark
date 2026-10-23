import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CATALOG } from "./methodology-catalog";
import { KANBAN, LIST, SCRUM, WATERFALL } from "./project-fixtures";

const navigation = { params: { slug: "northstar-labs", key: "OPS" } as Record<string, string> };
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
  usePathname: () => `/w/northstar-labs/p/${navigation.params.key}/overview`,
  useSearchParams: () => new URLSearchParams(),
  useParams: () => navigation.params,
}));
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));

import WorkspaceLayout from "../src/app/w/[slug]/layout";
import ProjectLayout from "../src/app/w/[slug]/p/[key]/layout";
import ProjectOverviewPage from "../src/app/w/[slug]/p/[key]/overview/page";

const workspace = { id: "w1", slug: "northstar-labs", name: "Northstar Labs", role: "owner", memberCount: 2, version: 2, createdAt: "2026-10-18T10:00:00.000Z" };
const members = [
  { userId: "u-avery", displayName: "Avery Founder", avatarUrl: null, email: null, role: "owner", joinedAt: "2026-10-01T10:00:00.000Z" },
  { userId: "u-blake", displayName: "Blake Rivers", avatarUrl: null, email: null, role: "member", joinedAt: "2026-10-10T10:00:00.000Z" },
];

type Handler = (init: RequestInit | undefined) => Response;
let calls: Array<{ key: string; body: unknown; ifMatch: string | null }> = [];
const json = (payload: unknown, status = 200, etag?: string): Handler => () =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...(etag ? { ETag: etag } : {}) } });

function mockApi(project: unknown, { role = "owner", extra = {} as Record<string, Handler> } = {}) {
  calls = [];
  const routes: Record<string, Handler> = {
    "GET /api/v1/workspaces/by-slug/northstar-labs": json({ ...workspace, role }),
    "GET /api/v1/workspaces/w1/projects": json({ items: LIST }),
    "GET /api/v1/workspaces/w1/members": json({ items: members }),
    "GET /api/v1/methodologies": json({ items: CATALOG }),
    ...(project ? { [`GET /api/v1/workspaces/w1/projects/by-key/${(project as { key: string }).key}`]: json(project, 200, "\"v3\"") } : {}),
    ...extra,
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const headers = new Headers(init?.headers);
    calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined, ifMatch: headers.get("If-Match") });
    const handler = routes[key];
    return handler ? handler(init) : new Response(JSON.stringify({ code: "project_not_found", detail: "Project does not exist." }), { status: 404 });
  }));
}

async function renderOverview(key: string) {
  navigation.params = { slug: "northstar-labs", key };
  render(<WorkspaceLayout><ProjectLayout><ProjectOverviewPage /></ProjectLayout></WorkspaceLayout>);
}

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("project overview", () => {
  it("shows a Kanban project's header, board columns with WIP limits and practices", async () => {
    mockApi(KANBAN);
    await renderOverview("OPS");
    expect(await screen.findByRole("heading", { level: 1, name: "Ops desk" })).toBeInTheDocument();
    // The shared project header (also shown on the board) carries the key, methodology and tabs.
    const header = screen.getByRole("region", { name: "Project" });
    expect(within(header).getByText("OPS")).toBeInTheDocument();
    expect(within(header).getByText("Kanban")).toHaveAttribute("data-methodology", "kanban");
    const tabs = within(header).getByRole("navigation", { name: "Project views" });
    expect(within(tabs).getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
    expect(within(tabs).getByRole("link", { name: "Board" })).toHaveAttribute("href", "/w/northstar-labs/p/OPS");
    const details = screen.getByRole("region", { name: "Project details" });
    expect(within(details).getByText("Blake Rivers")).toBeInTheDocument();
    expect(within(details).getByText("Requests from the support team.")).toBeInTheDocument();

    const board = screen.getByRole("region", { name: "Board columns" });
    expect(within(board).getAllByRole("listitem")).toHaveLength(5);
    expect(within(board).getByText("WIP 4")).toBeInTheDocument();
    expect(within(board).queryByText("The board arrives in the next update.")).not.toBeInTheDocument();
    expect(within(board).getByRole("link", { name: "Open the board" })).toHaveAttribute("href", "/w/northstar-labs/p/OPS");

    const flow = screen.getByRole("region", { name: "WIP limits" });
    expect(within(flow).getByText("3 of 5 columns have a WIP limit.")).toBeInTheDocument();
    expect(within(flow).getByText("Review")).toBeInTheDocument();

    const practices = await screen.findByRole("region", { name: "Practices for Kanban" });
    expect(within(practices).getByText("Respect WIP limits to finish before starting")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Timeline" })).not.toBeInTheDocument();
  });

  it("shows the sprint length for a Scrum project", async () => {
    mockApi(SCRUM);
    await renderOverview("ATLAS");
    const sprints = await screen.findByRole("region", { name: "Sprints" });
    expect(within(sprints).getByText("2-week sprints")).toBeInTheDocument();
    expect(within(sprints).getByText("Sprints start once tasks exist.")).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Practices for Scrum" })).toBeInTheDocument();
  });

  it("draws the Waterfall timeline with baseline bars and one marker per milestone", async () => {
    mockApi(WATERFALL);
    await renderOverview("WEB");
    const timeline = await screen.findByRole("region", { name: "Timeline" });
    const phases = within(timeline).getByRole("list", { name: "Phases" });
    expect(within(phases).getAllByRole("listitem")).toHaveLength(5);
    expect(within(phases).getByText("Requirements")).toBeInTheDocument();
    expect(within(timeline).getAllByRole("img", { name: /^Milestone / })).toHaveLength(5);
    expect(within(timeline).getAllByTestId("phase-baseline")).toHaveLength(5);
    expect(within(timeline).getByRole("img", { name: "Milestone Deploy sign-off, due Dec 11, 2026" })).toBeInTheDocument();
    const milestones = within(timeline).getByRole("list", { name: "Milestones" });
    expect(within(milestones).getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByText("No lead")).toBeInTheDocument();
  });

  it("has no header Settings button; settings live in the Settings tab", async () => {
    mockApi(KANBAN);
    await renderOverview("OPS");
    const tabs = await screen.findByRole("navigation", { name: "Project views" });
    expect(within(tabs).getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/w/northstar-labs/p/OPS/settings");
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("shows a not-found card for an unknown key", async () => {
    mockApi(null);
    await renderOverview("NOPE");
    expect(await screen.findByRole("heading", { name: "This project isn't available" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to workspace home" })).toHaveAttribute("href", "/w/northstar-labs");
  });
});
