import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CATALOG } from "./methodology-catalog";
import { KANBAN, KANBAN_BOARD, LIST, SCRUM } from "./project-fixtures";

const navigation = { params: { slug: "northstar-labs", key: "OPS" } as Record<string, string>, pathname: "/w/northstar-labs/p/OPS/settings" };
const router = { push: vi.fn(), replace: vi.fn() };
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
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(),
  useParams: () => navigation.params,
}));
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));

import WorkspaceLayout from "../src/app/w/[slug]/layout";
import ProjectLayout from "../src/app/w/[slug]/p/[key]/layout";
import ProjectSettingsPage from "../src/app/w/[slug]/p/[key]/settings/page";

const workspace = { id: "w1", slug: "northstar-labs", name: "Northstar Labs", role: "owner", memberCount: 3, version: 2, createdAt: "2026-10-18T10:00:00.000Z" };
const plan = (methodology: string) => ({ phases: [], milestones: [], baselinedAt: null, periods: [{ methodology, startedAt: "2026-10-18T09:00:00.000Z", endedAt: null }], version: 3 });

const boardStatus = (id: string, name: string, category: string, position: number, wipLimit: number | null, count: number) => ({ id, name, category, position, wipLimit, count });
const SCRUM_BOARD = {
  project: { id: "p-atlas", key: "ATLAS", name: "Atlas app", methodology: "scrum" },
  statuses: [
    boardStatus("t1", "Backlog", "backlog", 0, null, 4),
    boardStatus("t2", "To do", "todo", 1, null, 9),
    boardStatus("t3", "In progress", "in_progress", 2, null, 2),
    boardStatus("t4", "In review", "in_progress", 3, null, 1),
    boardStatus("t5", "Done", "done", 4, null, 6),
  ],
  issues: [],
  truncated: false,
};
const sprint = (status: string) => ({
  id: `s-${status}`, name: status === "active" ? "Sprint 3" : "Sprint 4", goal: null, status, startsOn: null, endsOn: null, startedAt: null, completedAt: null,
  committedPoints: null, committedCount: null, completedPoints: null, completedCount: null, version: 1,
});

type Handler = (init: RequestInit | undefined) => Response;
let calls: Array<{ key: string; body: unknown; ifMatch: string | null }> = [];
const json = (payload: unknown, status = 200, etag?: string): Handler => () =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...(etag ? { ETag: etag } : {}) } });
const problem = (status: number, code: string, detail: string, extra: Record<string, unknown> = {}): Handler => () =>
  new Response(JSON.stringify({ status, code, detail, ...extra }), { status, headers: { "content-type": "application/problem+json" } });

function mockApi(project: { id: string; key: string; methodology: string }, extra: Record<string, Handler> = {}) {
  calls = [];
  const routes: Record<string, Handler> = {
    "GET /api/v1/workspaces/by-slug/northstar-labs": json(workspace),
    "GET /api/v1/workspaces/w1/projects": json({ items: LIST }),
    "GET /api/v1/workspaces/w1/members": json({ items: [] }),
    "GET /api/v1/methodologies": json({ items: CATALOG }),
    [`GET /api/v1/workspaces/w1/projects/by-key/${project.key}`]: json(project, 200, "\"v3\""),
    "GET /api/v1/projects/p-ops/board": json(KANBAN_BOARD),
    "GET /api/v1/projects/p-atlas/board": json(SCRUM_BOARD),
    [`GET /api/v1/projects/${project.id}/plan`]: json(plan(project.methodology), 200, "\"v3\""),
    "GET /api/v1/projects/p-atlas/sprints": json({ items: [sprint("planned")] }),
    ...extra,
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined, ifMatch: new Headers(init?.headers).get("If-Match") });
    const handler = routes[key];
    return handler ? handler(init) : new Response(JSON.stringify({ code: "not_found", detail: "Not found." }), { status: 404 });
  }));
}

/** Opens the wizard from the Settings tab once the board's card counts are in. */
async function openWizard(key: string) {
  navigation.params = { slug: "northstar-labs", key };
  navigation.pathname = `/w/northstar-labs/p/${key}/settings`;
  render(<WorkspaceLayout><ProjectLayout><ProjectSettingsPage /></ProjectLayout></WorkspaceLayout>);
  const columns = await screen.findByRole("region", { name: "Board columns" });
  await within(columns).findAllByText(/^\d+ cards?$/u);
  await userEvent.click(await screen.findByRole("button", { name: "Switch methodology" }));
  return screen.getByRole("dialog", { name: "Switch methodology" });
}

async function pick(dialog: HTMLElement, name: string) {
  await userEvent.click(await within(dialog).findByRole("radio", { name }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Next" }));
}

const next = (dialog: HTMLElement) => userEvent.click(within(dialog).getByRole("button", { name: "Next" }));
const currentStep = (dialog: HTMLElement) => within(within(dialog).getByRole("list", { name: "Switch steps" })).getAllByRole("listitem").find((item) => item.getAttribute("aria-current") === "step")?.textContent;
const newColumn = (dialog: HTMLElement, index: number) => within(within(dialog).getByRole("list", { name: "New columns" })).getAllByRole("listitem")[index];
const currentColumn = (dialog: HTMLElement, name: string) => within(within(dialog).getByRole("list", { name: "Current columns" })).getByRole("listitem", { name });
const posts = () => calls.filter((call) => call.key.startsWith("POST"));

beforeEach(() => {
  window.localStorage.clear();
  router.push.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("methodology switch wizard", () => {
  it("proposes the target's template columns, keeps matching columns and shows card counts", async () => {
    mockApi(KANBAN);
    const dialog = await openWizard("OPS");
    expect(currentStep(dialog)).toMatch(/Choose a methodology/u);
    await pick(dialog, "Scrum");
    expect(currentStep(dialog)).toMatch(/Map columns/u);

    const names = within(within(dialog).getByRole("list", { name: "New columns" })).getAllByLabelText(/^New column \d+ name$/u).map((input) => (input as HTMLInputElement).value);
    expect(names).toEqual(["Backlog", "To do", "In progress", "In review", "Done"]);
    expect(within(newColumn(dialog, 0)).getByLabelText("New column 1 source")).toHaveValue("s1");
    expect(within(newColumn(dialog, 1)).getByLabelText("New column 2 source")).toHaveValue("");
    // "To do" receives Ready's two cards.
    expect(within(newColumn(dialog, 1)).getByText("2 cards")).toBeInTheDocument();

    expect(within(currentColumn(dialog, "Backlog")).getByText("Kept as Backlog")).toBeInTheDocument();
    expect(within(currentColumn(dialog, "Ready")).getByText("2 cards")).toBeInTheDocument();
    expect(within(currentColumn(dialog, "Ready")).getByLabelText("Move cards from Ready")).toHaveDisplayValue("To do");
    expect(within(currentColumn(dialog, "Review")).getByLabelText("Move cards from Review")).toHaveDisplayValue("In review");
  });

  it("cannot advance while a current column has no target", async () => {
    mockApi(KANBAN);
    const dialog = await openWizard("OPS");
    // Waterfall has no backlog column, so Backlog's card needs a home.
    await pick(dialog, "Waterfall");
    const backlog = currentColumn(dialog, "Backlog");
    expect(within(backlog).getByLabelText("Move cards from Backlog")).toHaveValue("");
    await next(dialog);
    expect(within(backlog).getByRole("alert")).toHaveTextContent("Choose where the cards in Backlog go.");
    expect(currentStep(dialog)).toMatch(/Map columns/u);

    await userEvent.selectOptions(within(backlog).getByLabelText("Move cards from Backlog"), "Not started");
    await next(dialog);
    expect(currentStep(dialog)).toMatch(/Plan/u);
  });

  it("refuses a proposed WIP limit below the cards the column would hold", async () => {
    mockApi(SCRUM);
    const dialog = await openWizard("ATLAS");
    await pick(dialog, "Kanban");
    // Ready (WIP 8) would take To do's nine cards.
    const ready = newColumn(dialog, 1);
    expect(within(ready).getByLabelText("New column 2 WIP limit")).toHaveValue(8);
    expect(within(ready).getByText("9 cards")).toBeInTheDocument();
    await next(dialog);
    expect(within(ready).getByRole("alert")).toHaveTextContent("9 cards would be in this column; the limit can't be below that.");
    expect(currentStep(dialog)).toMatch(/Map columns/u);

    await userEvent.clear(within(ready).getByLabelText("New column 2 WIP limit"));
    await userEvent.type(within(ready).getByLabelText("New column 2 WIP limit"), "10");
    await next(dialog);
    expect(currentStep(dialog)).toMatch(/Plan/u);
  });

  it("blocks leaving Scrum while a sprint is active and links to the backlog", async () => {
    mockApi(SCRUM, {
      "GET /api/v1/projects/p-atlas/sprints": json({ items: [sprint("active"), sprint("planned")] }),
      "GET /api/v1/projects/p-atlas/board": json({ ...SCRUM_BOARD, statuses: SCRUM_BOARD.statuses.map((status) => ({ ...status, count: 1 })) }),
    });
    const dialog = await openWizard("ATLAS");
    await pick(dialog, "Kanban");
    await next(dialog);
    const blocked = await within(dialog).findByRole("alert");
    expect(blocked).toHaveTextContent("Sprint 3 is still active");
    expect(within(blocked).getByRole("link", { name: "Complete sprint now" })).toHaveAttribute("href", "/w/northstar-labs/p/ATLAS/backlog");
    expect(within(dialog).getByRole("button", { name: "Next" })).toBeDisabled();
    expect(posts()).toEqual([]);
  });

  it("confirms with a summary and a required reason, posts the exact body and opens the board", async () => {
    mockApi(KANBAN, {
      "POST /api/v1/projects/p-ops/methodology": json({ project: { ...SCRUM, id: "p-ops", key: "OPS", name: "Ops desk", version: 4 }, movedIssues: 5 }, 200, "\"v4\""),
    });
    const dialog = await openWizard("OPS");
    await pick(dialog, "Scrum");
    await next(dialog);
    await userEvent.selectOptions(within(dialog).getByLabelText("Sprint length"), "3 weeks");
    await next(dialog);

    expect(within(dialog).getByText("5 cards move, 2 columns removed, periods: Kanban → Scrum")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Switch to Scrum" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Say why the project is switching.");
    expect(posts()).toEqual([]);

    await userEvent.type(within(dialog).getByLabelText("Reason for the switch"), "  Regular releases from now on  ");
    await userEvent.click(within(dialog).getByRole("button", { name: "Switch to Scrum" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/w/northstar-labs/p/OPS"));
    expect(posts()).toEqual([{
      key: "POST /api/v1/projects/p-ops/methodology",
      ifMatch: "\"v3\"",
      body: {
        to: "scrum",
        columns: [
          { id: "s1", name: "Backlog", category: "backlog", wipLimit: null },
          { name: "To do", category: "todo", wipLimit: null },
          { id: "s3", name: "In progress", category: "in_progress", wipLimit: null },
          { name: "In review", category: "in_progress", wipLimit: null },
          { id: "s5", name: "Done", category: "done", wipLimit: null },
        ],
        mapping: { s2: 1, s4: 3 },
        sprintLengthDays: 21,
        reason: "Regular releases from now on",
      },
    }]);
    expect(await screen.findByText("Switched to Scrum. 5 cards moved.")).toBeInTheDocument();
  });

  it("needs dates and a phase plan to enter Waterfall and sends them", async () => {
    mockApi(KANBAN, {
      "POST /api/v1/projects/p-ops/methodology": json({ project: { ...KANBAN, methodology: "waterfall", version: 4 }, movedIssues: 6 }, 200, "\"v4\""),
    });
    const dialog = await openWizard("OPS");
    await pick(dialog, "Waterfall");
    await userEvent.selectOptions(within(currentColumn(dialog, "Backlog")).getByLabelText("Move cards from Backlog"), "Not started");
    await next(dialog);
    await next(dialog);
    expect(within(dialog).getByText("Pick a start date.")).toBeInTheDocument();
    expect(within(dialog).getByText("Pick a target date.")).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText("Start date"), { target: { value: "2026-11-02" } });
    fireEvent.change(within(dialog).getByLabelText("Target date"), { target: { value: "2026-11-11" } });
    // The template's five phases are spread over the ten days.
    expect(within(dialog).getByLabelText("Phase 1 name")).toHaveValue("Requirements");
    expect(within(dialog).getByLabelText("Phase 5 end")).toHaveValue("2026-11-11");
    await next(dialog);
    await userEvent.type(within(dialog).getByLabelText("Reason for the switch"), "Fixed-scope client launch");
    await userEvent.click(within(dialog).getByRole("button", { name: "Switch to Waterfall" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const body = posts()[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ to: "waterfall", startDate: "2026-11-02", targetDate: "2026-11-11", mapping: { s1: 0, s2: 0 }, reason: "Fixed-scope client launch" });
    expect(body).not.toHaveProperty("sprintLengthDays");
    expect(body.phases).toEqual([
      { name: "Requirements", plannedStart: "2026-11-02", plannedEnd: "2026-11-03" },
      { name: "Design", plannedStart: "2026-11-04", plannedEnd: "2026-11-05" },
      { name: "Build", plannedStart: "2026-11-06", plannedEnd: "2026-11-07" },
      { name: "Test", plannedStart: "2026-11-08", plannedEnd: "2026-11-09" },
      { name: "Deploy", plannedStart: "2026-11-10", plannedEnd: "2026-11-11" },
    ]);
  });

  it("shows the teammate message on 412 and switches with the fresh version", async () => {
    const current = { ...KANBAN, name: "Ops desk", version: 4 };
    let attempt = 0;
    mockApi(KANBAN, {
      "POST /api/v1/projects/p-ops/methodology": (init) => {
        attempt += 1;
        return attempt === 1
          ? problem(412, "version_mismatch", "The resource changed since you loaded it.", { current })(init)
          : json({ project: { ...current, methodology: "scrum", version: 5 }, movedIssues: 5 }, 200, "\"v5\"")(init);
      },
    });
    const dialog = await openWizard("OPS");
    await pick(dialog, "Scrum");
    await next(dialog);
    await next(dialog);
    await userEvent.type(within(dialog).getByLabelText("Reason for the switch"), "Regular releases");
    await userEvent.click(within(dialog).getByRole("button", { name: "Switch to Scrum" }));

    expect(await within(dialog).findByText("Updated by a teammate — review the latest values and save again.")).toBeInTheDocument();
    expect(currentStep(dialog)).toMatch(/Map columns/u);
    expect(router.push).not.toHaveBeenCalled();
    await next(dialog);
    await next(dialog);
    expect(within(dialog).getByLabelText("Reason for the switch")).toHaveValue("Regular releases");
    await userEvent.click(within(dialog).getByRole("button", { name: "Switch to Scrum" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/w/northstar-labs/p/OPS"));
    expect(posts().map((call) => call.ifMatch)).toEqual(["\"v3\"", "\"v4\""]);
  });

  it("does not let the current methodology be picked again", async () => {
    mockApi(KANBAN);
    const dialog = await openWizard("OPS");
    await next(dialog);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Pick a methodology.");
    await pick(dialog, "Kanban");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Ops desk already uses Kanban. Pick another way of working.");
    expect(currentStep(dialog)).toMatch(/Choose a methodology/u);
  });
});
