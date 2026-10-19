import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  usePathname: () => `/w/northstar-labs/p/${navigation.params.key}`,
  useSearchParams: () => new URLSearchParams(),
  useParams: () => navigation.params,
}));
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));

import WorkspaceLayout from "../src/app/w/[slug]/layout";
import ProjectOverviewPage from "../src/app/w/[slug]/p/[key]/page";

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
  render(<WorkspaceLayout><ProjectOverviewPage /></WorkspaceLayout>);
}

const patches = () => calls.filter((call) => call.key.startsWith("PATCH"));

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("project overview", () => {
  it("shows a Kanban project's header, board columns with WIP limits and practices", async () => {
    mockApi(KANBAN);
    await renderOverview("OPS");
    expect(await screen.findByRole("heading", { level: 1, name: "Ops desk" })).toBeInTheDocument();
    const header = screen.getByRole("region", { name: "Project details" });
    expect(within(header).getByText("OPS")).toBeInTheDocument();
    expect(within(header).getByText("Kanban")).toHaveAttribute("data-methodology", "kanban");
    expect(within(header).getByText("Blake Rivers")).toBeInTheDocument();
    expect(screen.getByText("Requests from the support team.")).toBeInTheDocument();

    const board = screen.getByRole("region", { name: "Board columns" });
    expect(within(board).getAllByRole("listitem")).toHaveLength(5);
    expect(within(board).getByText("WIP 4")).toBeInTheDocument();
    expect(within(board).getByText("The board arrives in the next update.")).toBeInTheDocument();

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

  it("shows a not-found card for an unknown key", async () => {
    mockApi(null);
    await renderOverview("NOPE");
    expect(await screen.findByRole("heading", { name: "This project isn't available" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to workspace home" })).toHaveAttribute("href", "/w/northstar-labs");
  });

  it("hides Settings from a member who does not lead the project", async () => {
    mockApi(KANBAN, { role: "member" });
    await renderOverview("OPS");
    await screen.findByRole("heading", { level: 1, name: "Ops desk" });
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("shows Settings to the project lead even as a plain member", async () => {
    mockApi({ ...KANBAN, lead: { id: "u-avery", displayName: "Avery Founder" } }, { role: "member" });
    await renderOverview("OPS");
    expect(await screen.findByRole("button", { name: "Settings" })).toBeInTheDocument();
  });

  it("saves settings with If-Match and confirms in a toast", async () => {
    mockApi(KANBAN, { extra: { "PATCH /api/v1/projects/p-ops": json({ ...KANBAN, name: "Ops help desk", version: 4 }, 200, "\"v4\"") } });
    await renderOverview("OPS");
    await userEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const dialog = screen.getByRole("dialog", { name: "Project settings" });
    const name = within(dialog).getByLabelText("Project name");
    expect(name).toHaveValue("Ops desk");
    expect(within(dialog).queryByLabelText("Sprint length")).not.toBeInTheDocument();
    await userEvent.clear(name);
    await userEvent.type(name, "Ops help desk");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(patches()).toEqual([{ key: "PATCH /api/v1/projects/p-ops", body: { name: "Ops help desk" }, ifMatch: "\"v3\"" }]);
    expect(screen.getByRole("heading", { level: 1, name: "Ops help desk" })).toBeInTheDocument();
    expect((await screen.findByText("Project settings saved.")).closest("[aria-live]")).not.toBeNull();
  });

  it("offers the sprint length for Scrum projects", async () => {
    mockApi(SCRUM, { extra: { "PATCH /api/v1/projects/p-atlas": json({ ...SCRUM, sprintLengthDays: 21, version: 4 }, 200, "\"v4\"") } });
    await renderOverview("ATLAS");
    await userEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const dialog = screen.getByRole("dialog", { name: "Project settings" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Sprint length"), "3 weeks");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].body).toEqual({ sprintLengthDays: 21 });
  });

  it("shows a teammate's newer values on 412 and saves again with the fresh version", async () => {
    const current = { ...KANBAN, name: "Ops desk (renamed)", description: "Changed elsewhere.", version: 4 };
    let attempt = 0;
    mockApi(KANBAN, {
      extra: {
        "PATCH /api/v1/projects/p-ops": () => {
          attempt += 1;
          return attempt === 1
            ? new Response(JSON.stringify({ status: 412, code: "version_mismatch", detail: "The resource changed since you loaded it.", current }), { status: 412, headers: { "content-type": "application/problem+json" } })
            : new Response(JSON.stringify({ ...current, name: "Ops desk 2", version: 5 }), { status: 200, headers: { "content-type": "application/json", ETag: "\"v5\"" } });
        },
      },
    });
    await renderOverview("OPS");
    await userEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const dialog = screen.getByRole("dialog", { name: "Project settings" });
    await userEvent.clear(within(dialog).getByLabelText("Project name"));
    await userEvent.type(within(dialog).getByLabelText("Project name"), "Ops desk 2");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    expect(await within(dialog).findByText("Updated by a teammate — review the latest values and save again.")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Project settings" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Project name")).toHaveValue("Ops desk (renamed)");
    expect(within(dialog).getByLabelText("Description")).toHaveValue("Changed elsewhere.");

    await userEvent.clear(within(dialog).getByLabelText("Project name"));
    await userEvent.type(within(dialog).getByLabelText("Project name"), "Ops desk 2");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(patches().map((call) => call.ifMatch)).toEqual(["\"v3\"", "\"v4\""]);
    expect(patches()[1].body).toEqual({ name: "Ops desk 2" });
  });
});
