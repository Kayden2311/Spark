import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CATALOG } from "./methodology-catalog";
import { KANBAN, LIST, SCRUM } from "./project-fixtures";

const navigation = { params: { slug: "northstar-labs", key: "ATLAS" } as Record<string, string>, pathname: "/w/northstar-labs/p/ATLAS/backlog" };
const OWNER = { id: "u-avery", displayName: "Avery Founder", email: "avery@example.com", avatarUrl: null };
const MEMBER = { id: "u-casey", displayName: "Casey Member", email: "casey@example.com", avatarUrl: null };
const auth = {
  isAuthenticated: true,
  isLoading: false,
  platformRoles: [] as string[],
  user: OWNER,
  workspaces: [{ workspaceId: "w1", workspaceName: "Northstar Labs", workspaceSlug: "northstar-labs", role: "owner" }],
  logout: vi.fn(),
  refreshSession: vi.fn(async () => {}),
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(),
  useParams: () => navigation.params,
}));
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));

import WorkspaceLayout from "../src/app/w/[slug]/layout";
import ProjectBacklogPage from "../src/app/w/[slug]/p/[key]/backlog/page";
import ProjectLayout from "../src/app/w/[slug]/p/[key]/layout";

const DAY = 86_400_000;
/** An ISO day `offset` days from today, in the viewer's time zone like the page's "today". */
function day(offset: number): string {
  const date = new Date(Date.now() + offset * DAY);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const workspace = (role: string) => ({ id: "w1", slug: "northstar-labs", name: "Northstar Labs", role, memberCount: 3, version: 2, createdAt: "2026-10-18T10:00:00.000Z" });

const sprint = (id: string, name: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  goal: null as string | null,
  status,
  startsOn: null as string | null,
  endsOn: null as string | null,
  startedAt: null as string | null,
  completedAt: null as string | null,
  committedPoints: null as number | null,
  committedCount: null as number | null,
  completedPoints: null as number | null,
  completedCount: null as number | null,
  version: 1,
  ...extra,
});

const ACTIVE = sprint("s-active", "Sprint 3", "active", { goal: "Ship the new checkout", startsOn: day(-9), endsOn: day(5), startedAt: "2026-10-14T09:00:00.000Z", committedPoints: 8, committedCount: 2, version: 4 });
const NEXT = sprint("s-next", "Sprint 4", "planned", { goal: "Search", startsOn: day(5), endsOn: day(19), version: 2 });
const LATER = sprint("s-later", "Sprint 5", "planned", { version: 1 });
const completed = (id: string, name: string, points: number, daysAgo: number) =>
  sprint(id, name, "completed", { startsOn: day(-daysAgo - 14), endsOn: day(-daysAgo), completedAt: new Date(Date.now() - daysAgo * DAY).toISOString(), committedPoints: points, completedPoints: points, completedCount: 4, version: 5 });
const DONE_SPRINTS = [completed("s-2", "Sprint 2", 18, 10), completed("s-1", "Sprint 1", 24, 24), completed("s-0", "Sprint 0", 21, 38), completed("s-old", "Sprint -1", 100, 52)];
const SPRINTS = [ACTIVE, NEXT, LATER, ...DONE_SPRINTS];

const card = (id: string, number: number, statusId: string, title: string, sprintId: string | null, storyPoints: number | null) => ({
  id,
  number,
  key: `ATLAS-${number}`,
  title,
  type: "story",
  priority: "medium",
  statusId,
  assignee: null as { id: string; displayName: string; avatarUrl: string | null } | null,
  storyPoints,
  dueDate: null as string | null,
  phaseId: null as string | null,
  sprintId,
  version: 1,
  completedAt: null as string | null,
  createdAt: "2026-10-19T09:00:00.000Z",
});

const boardStatus = (id: string, name: string, category: string, position: number) => ({ id, name, category, position, wipLimit: null, count: 0 });

// Board order: status position, then rank.
const BOARD = {
  project: { id: "p-atlas", key: "ATLAS", name: "Atlas app", methodology: "scrum" },
  statuses: [
    boardStatus("t1", "Backlog", "backlog", 0),
    boardStatus("t2", "To do", "todo", 1),
    boardStatus("t3", "In progress", "in_progress", 2),
    boardStatus("t4", "In review", "in_progress", 3),
    boardStatus("t5", "Done", "done", 4),
  ],
  issues: [
    card("a4", 4, "t1", "Onboarding copy", null, 2),
    card("a7", 7, "t1", "Pricing spike", null, null),
    card("a3", 3, "t2", "Search filters", "s-next", 8),
    // Reopened after its sprint was completed: shown in the Backlog lane.
    card("a5", 5, "t2", "Legacy cleanup", "s-2", 1),
    card("a1", 1, "t3", "Checkout flow", "s-active", 5),
    card("a2", 2, "t5", "Payment errors", "s-active", 3),
    // Finished in a completed sprint: history, not on the backlog.
    card("a6", 6, "t5", "Old release notes", "s-2", 3),
  ],
  truncated: false,
};

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;
type Call = { key: string; body: unknown; ifMatch: string | null };
let calls: Call[] = [];
const json = (payload: unknown, status = 200, headers: Record<string, string> = {}): Handler => () =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });
const problem = (status: number, code: string, detail: string, extra: Record<string, unknown> = {}): Handler => () =>
  new Response(JSON.stringify({ status, code, detail, ...extra }), { status, headers: { "content-type": "application/problem+json" } });

const BOARD_KEY = "GET /api/v1/projects/p-atlas/board";
const SPRINTS_KEY = "GET /api/v1/projects/p-atlas/sprints";
const PATCH_ISSUE = /^PATCH \/api\/v1\/issues\/([^/]+)$/u;

let board: typeof BOARD;

/** A successful sprint assignment: the issue gets the new sprint and the next version. */
function assign(issueId: string, init: RequestInit | undefined): Response {
  const body = JSON.parse(String(init?.body)) as { sprintId: string | null };
  const issue = board.issues.find((item) => item.id === issueId);
  if (!issue) return new Response(JSON.stringify({ code: "issue_not_found", detail: "Issue does not exist." }), { status: 404 });
  const moved = { ...issue, sprintId: body.sprintId, version: issue.version + 1 };
  board = { ...board, issues: board.issues.map((item) => (item.id === issueId ? moved : item)) };
  const detail = { ...moved, projectId: "p-atlas", description: null, reporter: null, startedAt: null, updatedAt: "2026-10-23T10:00:00.000Z", archivedAt: null };
  return new Response(JSON.stringify(detail), { status: 200, headers: { "content-type": "application/json", ETag: `"v${moved.version}"` } });
}

function mockApi({ routes: extra = {}, sprints = SPRINTS, project = SCRUM, role = "owner" }: { routes?: Record<string, Handler>; sprints?: unknown[]; project?: { key: string }; role?: string } = {}) {
  calls = [];
  board = structuredClone(BOARD);
  const routes: Record<string, Handler> = {
    "GET /api/v1/workspaces/by-slug/northstar-labs": json(workspace(role)),
    "GET /api/v1/workspaces/w1/projects": json({ items: LIST }),
    "GET /api/v1/methodologies": json({ items: CATALOG }),
    [`GET /api/v1/workspaces/w1/projects/by-key/${project.key}`]: json(project, 200, { ETag: "\"v3\"" }),
    [BOARD_KEY]: () => json(board)(undefined),
    [SPRINTS_KEY]: json({ items: sprints }),
    "GET /api/v1/projects/p-ops/sprints": json({ items: [] }),
    "GET /api/v1/projects/p-ops/board": json({ ...BOARD, project: { id: "p-ops", key: "OPS", name: "Ops desk", methodology: "kanban" }, issues: [] }),
    ...extra,
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined, ifMatch: new Headers(init?.headers).get("If-Match") });
    const handler = routes[key];
    if (handler) return handler(init);
    const patch = PATCH_ISSUE.exec(key);
    return patch ? assign(patch[1], init) : new Response(JSON.stringify({ code: "not_found", detail: "Not found." }), { status: 404 });
  }));
}

async function renderBacklog(key = "ATLAS") {
  navigation.params = { slug: "northstar-labs", key };
  navigation.pathname = `/w/northstar-labs/p/${key}/backlog`;
  render(<WorkspaceLayout><ProjectLayout><ProjectBacklogPage /></ProjectLayout></WorkspaceLayout>);
}

async function planning() {
  return screen.findByRole("region", { name: "Sprint planning" });
}

const lane = (name: string) => screen.getByRole("region", { name });
const laneNames = () => Array.from(document.querySelectorAll<HTMLElement>(".wsBacklogLane")).map((element) => element.querySelector("h2")?.textContent);
const cardsIn = (name: string) =>
  within(within(lane(name)).getByRole("list", { name: `${name} tasks` }))
    .queryAllByRole("button", { name: /^ATLAS-\d+:/ })
    .map((element) => element.getAttribute("aria-label")?.split(":")[0]);
const card$ = (key: string) => screen.getByRole("button", { name: new RegExp(`^${key}:`) });
const liveRegion = () => document.querySelector("[aria-live=\"polite\"]") as HTMLElement;
const requests = (prefix: string) => calls.filter((call) => call.key.startsWith(prefix));

beforeEach(() => {
  window.localStorage.clear();
  auth.user = OWNER;
});
afterEach(() => vi.unstubAllGlobals());

describe("scrum backlog", () => {
  it("shows the active sprint, planned sprints and the backlog with their totals", async () => {
    mockApi();
    await renderBacklog();
    await planning();
    await screen.findByText("Checkout flow");
    expect(laneNames()).toEqual(["Sprint 3", "Sprint 4", "Sprint 5", "Backlog"]);

    expect(cardsIn("Sprint 3")).toEqual(["ATLAS-1", "ATLAS-2"]);
    expect(cardsIn("Sprint 4")).toEqual(["ATLAS-3"]);
    expect(cardsIn("Sprint 5")).toEqual([]);
    // Issues without a sprint and open issues of a finished sprint, in board order; finished history stays out.
    expect(cardsIn("Backlog")).toEqual(["ATLAS-4", "ATLAS-7", "ATLAS-5"]);
    expect(screen.queryByText("Old release notes")).not.toBeInTheDocument();

    expect(within(lane("Sprint 3")).getByText("2 tasks · 8 pts")).toBeInTheDocument();
    expect(within(lane("Sprint 4")).getByText("1 task · 8 pts")).toBeInTheDocument();
    expect(within(lane("Sprint 5")).getByText("0 tasks · 0 pts")).toBeInTheDocument();
    expect(within(lane("Backlog")).getByText("3 tasks · 3 pts")).toBeInTheDocument();

    const active = lane("Sprint 3");
    expect(within(active).getByText("Ship the new checkout")).toBeInTheDocument();
    expect(within(active).getByText("5 days left")).toBeInTheDocument();
    expect(within(active).getByText("3 of 8 committed pts done")).toBeInTheDocument();
    expect(within(active).getByText("Active")).toBeInTheDocument();
    expect(within(lane("Sprint 4")).getByText("Planned")).toBeInTheDocument();

    const tabs = screen.getByRole("navigation", { name: "Project views" });
    expect(within(tabs).getAllByRole("link").map((link) => link.textContent)).toEqual(["Board", "Backlog", "Overview", "Settings"]);
    expect(within(tabs).getByRole("link", { name: "Backlog" })).toHaveAttribute("aria-current", "page");
    expect(within(tabs).getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/w/northstar-labs/p/ATLAS/settings");
  });

  it("shows velocity from the last three completed sprints next to the next sprint's plan", async () => {
    mockApi();
    await renderBacklog();
    await screen.findByText("Checkout flow");
    const next = lane("Sprint 4");
    // (18 + 24 + 21) / 3; the fourth, older sprint is not counted.
    expect(within(next).getByText("Velocity 21 pts (last 3)")).toBeInTheDocument();
    expect(within(next).getByText("8 pts planned")).toBeInTheDocument();
    expect(within(next).queryByText(/Over capacity/u)).not.toBeInTheDocument();
    // Only the next sprint compares with velocity.
    expect(within(lane("Sprint 5")).queryByText(/Velocity/u)).not.toBeInTheDocument();
  });

  it("shows velocity from a single completed sprint", async () => {
    mockApi({ sprints: [ACTIVE, NEXT, DONE_SPRINTS[0]] });
    await renderBacklog();
    expect(await screen.findByText("Velocity 18 pts (last 1)")).toBeInTheDocument();
  });

  it("says there is no velocity before any sprint is completed", async () => {
    mockApi({ sprints: [ACTIVE, NEXT, sprint("s-x", "Sprint X", "cancelled")] });
    await renderBacklog();
    expect(await within(await screen.findByRole("region", { name: "Sprint 4" })).findByText("No velocity yet")).toBeInTheDocument();
  });

  it("warns when the next sprint is planned above 110% of velocity", async () => {
    const heavy = { ...BOARD, issues: BOARD.issues.map((issue) => (issue.id === "a3" ? { ...issue, storyPoints: 24 } : issue)) };
    mockApi({ routes: { [BOARD_KEY]: json(heavy) } });
    await renderBacklog();
    const warning = await within(await screen.findByRole("region", { name: "Sprint 4" })).findByText(/Over capacity/u);
    expect(warning).toHaveTextContent("Over capacity: 24 pts planned is 114% of velocity.");
  });

  it("compares capacity unrounded, so 110.5% is flagged", async () => {
    // 23.2 / 21 = 110.48%: above 110% although it reads "110%".
    const heavy = { ...BOARD, issues: BOARD.issues.map((issue) => (issue.id === "a3" ? { ...issue, storyPoints: 23.2 } : issue)) };
    mockApi({ routes: { [BOARD_KEY]: json(heavy) } });
    await renderBacklog();
    const warning = await within(await screen.findByRole("region", { name: "Sprint 4" })).findByText(/Over capacity/u);
    expect(warning).toHaveTextContent("Over capacity: 23.2 pts planned is 110% of velocity.");
  });

  it("moves a task between lanes with the keyboard and sends sprintId with If-Match", async () => {
    mockApi();
    await renderBacklog();
    (await screen.findByRole("button", { name: /^ATLAS-4:/ })).focus();
    await userEvent.keyboard(" ");
    expect(liveRegion()).toHaveTextContent("Picked up ATLAS-4. Use arrow keys to move between sprints, Enter to drop, Escape to cancel.");
    await userEvent.keyboard("{ArrowUp}");
    expect(liveRegion()).toHaveTextContent("ATLAS-4 in Sprint 5");
    expect(cardsIn("Sprint 5")).toEqual(["ATLAS-4"]);
    expect(card$("ATLAS-4")).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(cardsIn("Sprint 4")).toEqual(["ATLAS-4", "ATLAS-3"]);
    expect(requests("PATCH")).toHaveLength(0);

    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(requests("PATCH")).toHaveLength(1));
    expect(requests("PATCH")[0]).toEqual({ key: "PATCH /api/v1/issues/a4", body: { sprintId: "s-next" }, ifMatch: "\"v1\"" });
    expect(liveRegion()).toHaveTextContent("Dropped ATLAS-4 in Sprint 4.");
    expect(cardsIn("Sprint 4")).toEqual(["ATLAS-4", "ATLAS-3"]);
    expect(within(lane("Sprint 4")).getByText("2 tasks · 10 pts")).toBeInTheDocument();
    expect(within(lane("Backlog")).getByText("2 tasks · 1 pt")).toBeInTheDocument();
    await waitFor(() => expect(card$("ATLAS-4")).toHaveFocus());

    // The next move carries the new version.
    await userEvent.keyboard(" {ArrowDown}{ArrowDown}{Enter}");
    await waitFor(() => expect(requests("PATCH")).toHaveLength(2));
    expect(requests("PATCH")[1]).toEqual({ key: "PATCH /api/v1/issues/a4", body: { sprintId: null }, ifMatch: "\"v2\"" });
  });

  it("cancels a keyboard move with Escape without a request", async () => {
    mockApi();
    await renderBacklog();
    (await screen.findByRole("button", { name: /^ATLAS-3:/ })).focus();
    await userEvent.keyboard(" {ArrowDown}{Escape}");
    expect(cardsIn("Sprint 4")).toEqual(["ATLAS-3"]);
    expect(liveRegion()).toHaveTextContent("Move cancelled. ATLAS-3 is back in Sprint 4.");
    expect(requests("PATCH")).toHaveLength(0);
  });

  it("moves a task from the Move to menu", async () => {
    mockApi();
    await renderBacklog();
    await userEvent.click(await screen.findByRole("button", { name: "Move to… (ATLAS-3)" }));
    const menu = screen.getByRole("menu", { name: "Move ATLAS-3 to" });
    expect(menu.parentElement).toBe(document.body);
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.getAttribute("aria-label"))).toEqual(["Sprint 3", "Sprint 4 (current)", "Sprint 5", "Backlog"]);
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: "Backlog" }));
    await waitFor(() => expect(requests("PATCH")).toHaveLength(1));
    expect(requests("PATCH")[0]).toMatchObject({ body: { sprintId: null }, ifMatch: "\"v1\"" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(cardsIn("Backlog")).toEqual(["ATLAS-4", "ATLAS-7", "ATLAS-3", "ATLAS-5"]);
  });

  it("moves a task by dragging it onto a lane", async () => {
    mockApi();
    await renderBacklog();
    const dragged = await screen.findByRole("button", { name: /^ATLAS-7:/ });
    const target = within(lane("Sprint 5")).getByRole("list", { name: "Sprint 5 tasks" });
    const dataTransfer = { setData: vi.fn(), getData: () => "a7", effectAllowed: "move", dropEffect: "move" };
    fireEvent.dragStart(dragged, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    await waitFor(() => expect(requests("PATCH")).toHaveLength(1));
    expect(requests("PATCH")[0]).toMatchObject({ key: "PATCH /api/v1/issues/a7", body: { sprintId: "s-later" } });
    expect(cardsIn("Sprint 5")).toEqual(["ATLAS-7"]);
  });

  it("rolls back and refreshes with the teammate toast on 412", async () => {
    let boards = 0;
    const refreshed = { ...BOARD, issues: BOARD.issues.map((issue) => (issue.id === "a4" ? { ...issue, title: "Onboarding copy (v2)", version: 2 } : issue)) };
    mockApi({
      routes: {
        [BOARD_KEY]: () => {
          boards += 1;
          return json(boards === 1 ? BOARD : refreshed)(undefined);
        },
        "PATCH /api/v1/issues/a4": problem(412, "version_mismatch", "The resource changed since you loaded it.", { current: { ...BOARD.issues[0], version: 2 } }),
      },
    });
    await renderBacklog();
    (await screen.findByRole("button", { name: /^ATLAS-4:/ })).focus();
    await userEvent.keyboard(" {ArrowUp}{Enter}");
    const toast = await screen.findByText("Updated by a teammate — the backlog was refreshed.");
    expect(toast.closest("[aria-live]")).toBe(liveRegion());
    expect(await screen.findByText("Onboarding copy (v2)")).toBeInTheDocument();
    expect(cardsIn("Backlog")).toEqual(["ATLAS-4", "ATLAS-7", "ATLAS-5"]);
  });

  it("rolls back with the API message on other errors", async () => {
    mockApi({ routes: { "PATCH /api/v1/issues/a4": problem(400, "invalid_input", "Invalid sprint.") } });
    await renderBacklog();
    (await screen.findByRole("button", { name: /^ATLAS-4:/ })).focus();
    await userEvent.keyboard(" {ArrowUp}{Enter}");
    expect(await screen.findByText("Invalid sprint.")).toBeInTheDocument();
    expect(cardsIn("Backlog")).toEqual(["ATLAS-4", "ATLAS-7", "ATLAS-5"]);
    expect(cardsIn("Sprint 5")).toEqual([]);
  });

  it("starts a planned sprint with its saved dates", async () => {
    const started = { ...NEXT, status: "active", startedAt: "2026-10-23T10:00:00.000Z", committedPoints: 8, committedCount: 1, version: 3 };
    let isStarted = false;
    mockApi({
      routes: {
        [SPRINTS_KEY]: () => json({ items: [isStarted ? started : NEXT, LATER, ...DONE_SPRINTS] })(undefined),
        "POST /api/v1/sprints/s-next/start": () => {
          isStarted = true;
          return json(started, 200, { ETag: "\"v3\"" })(undefined);
        },
      },
    });
    await renderBacklog();
    await userEvent.click(await within(await screen.findByRole("region", { name: "Sprint 4" })).findByRole("button", { name: "Start sprint" }));
    const dialog = screen.getByRole("dialog", { name: "Start Sprint 4" });
    expect(within(dialog).getByLabelText("Start date")).toHaveValue(NEXT.startsOn);
    expect(within(dialog).getByLabelText("End date")).toHaveValue(NEXT.endsOn);
    expect(within(dialog).getByText("1 task · 8 pts will be committed.")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Start sprint" }));
    await waitFor(() => expect(requests("POST")).toHaveLength(1));
    expect(requests("POST")[0]).toEqual({ key: "POST /api/v1/sprints/s-next/start", body: undefined, ifMatch: "\"v2\"" });
    expect(requests("PATCH /api/v1/sprints")).toHaveLength(0);
    expect(await screen.findByText("Sprint 4 started.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(requests(SPRINTS_KEY)).toHaveLength(2));
    // The Start buttons are gone, so focus lands on the new active lane's Complete button, not <body>.
    await waitFor(() => expect(within(lane("Sprint 4")).getByRole("button", { name: "Complete sprint" })).toHaveFocus());
    expect(within(lane("Sprint 4")).getByText("Active")).toBeInTheDocument();
  });

  it("pre-fills a sprint without dates with the project's sprint length and saves them before starting", async () => {
    const dated = { ...LATER, startsOn: day(0), endsOn: day(14), version: 2 };
    mockApi({
      sprints: [NEXT, LATER],
      routes: {
        "PATCH /api/v1/sprints/s-later": json(dated, 200, { ETag: "\"v2\"" }),
        "POST /api/v1/sprints/s-later/start": json({ ...dated, status: "active", version: 3 }),
      },
    });
    await renderBacklog();
    await userEvent.click(await within(await screen.findByRole("region", { name: "Sprint 5" })).findByRole("button", { name: "Start sprint" }));
    const dialog = screen.getByRole("dialog", { name: "Start Sprint 5" });
    expect(within(dialog).getByLabelText("Start date")).toHaveValue(day(0));
    expect(within(dialog).getByLabelText("End date")).toHaveValue(day(14));
    await userEvent.click(within(dialog).getByRole("button", { name: "Start sprint" }));
    await waitFor(() => expect(requests("POST")).toHaveLength(1));
    expect(requests("PATCH")[0]).toEqual({ key: "PATCH /api/v1/sprints/s-later", body: { startsOn: day(0), endsOn: day(14) }, ifMatch: "\"v1\"" });
    expect(requests("POST")[0]).toMatchObject({ key: "POST /api/v1/sprints/s-later/start", ifMatch: "\"v2\"" });
  });

  it("explains when another sprint was started first", async () => {
    mockApi({
      sprints: [NEXT, LATER],
      routes: { "POST /api/v1/sprints/s-next/start": problem(409, "sprint_already_active", "Another sprint is already active in this project. Complete it first.") },
    });
    await renderBacklog();
    await userEvent.click(await within(await screen.findByRole("region", { name: "Sprint 4" })).findByRole("button", { name: "Start sprint" }));
    const dialog = screen.getByRole("dialog", { name: "Start Sprint 4" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Start sprint" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Another sprint is already active in this project. Complete it first.");
    expect(screen.getByRole("dialog", { name: "Start Sprint 4" })).toBeInTheDocument();
  });

  it("reloads the plan after a refused start so the teammate's active sprint appears", async () => {
    let refused = false;
    mockApi({
      routes: {
        [SPRINTS_KEY]: () => json({ items: refused ? [ACTIVE, NEXT, LATER] : [NEXT, LATER] })(undefined),
        "POST /api/v1/sprints/s-next/start": () => {
          refused = true;
          return problem(409, "sprint_already_active", "Another sprint is already active in this project. Complete it first.")(undefined);
        },
      },
    });
    await renderBacklog();
    await userEvent.click(await within(await screen.findByRole("region", { name: "Sprint 4" })).findByRole("button", { name: "Start sprint" }));
    const dialog = screen.getByRole("dialog", { name: "Start Sprint 4" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Start sprint" }));
    await within(dialog).findByRole("alert");
    await waitFor(() => expect(requests(SPRINTS_KEY)).toHaveLength(2));
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(await within(await screen.findByRole("region", { name: "Sprint 3" })).findByRole("button", { name: "Complete sprint" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start sprint" })).not.toBeInTheDocument();
  });

  it("reloads the plan when the dates were saved but the start failed, and retries without saving them again", async () => {
    const dated = { ...LATER, startsOn: day(0), endsOn: day(14), version: 2 };
    let attempts = 0;
    mockApi({
      sprints: [NEXT, LATER],
      routes: {
        "PATCH /api/v1/sprints/s-later": json(dated),
        "POST /api/v1/sprints/s-later/start": () => {
          attempts += 1;
          return attempts === 1 ? problem(503, "database_unavailable", "The database is unavailable.")(undefined) : json({ ...dated, status: "active", version: 3 })(undefined);
        },
      },
    });
    await renderBacklog();
    await userEvent.click(await within(await screen.findByRole("region", { name: "Sprint 5" })).findByRole("button", { name: "Start sprint" }));
    const dialog = screen.getByRole("dialog", { name: "Start Sprint 5" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Start sprint" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The database is unavailable.");
    await waitFor(() => expect(requests(SPRINTS_KEY)).toHaveLength(2));
    await userEvent.click(within(dialog).getByRole("button", { name: "Start sprint" }));
    await waitFor(() => expect(requests("POST")).toHaveLength(2));
    expect(requests("PATCH")).toHaveLength(1);
    expect(requests("POST")[1]).toMatchObject({ key: "POST /api/v1/sprints/s-later/start", ifMatch: "\"v2\"" });
  });

  it("takes a teammate's newer sprint on 412 in the start dialog and starts with its version", async () => {
    const newer = { ...NEXT, goal: "Search, revised", version: 3 };
    let attempts = 0;
    mockApi({
      sprints: [NEXT, LATER],
      routes: {
        "POST /api/v1/sprints/s-next/start": () => {
          attempts += 1;
          return attempts === 1
            ? problem(412, "version_mismatch", "The resource changed since you loaded it.", { current: newer })(undefined)
            : json({ ...newer, status: "active", version: 4 })(undefined);
        },
      },
    });
    await renderBacklog();
    await userEvent.click(await within(await screen.findByRole("region", { name: "Sprint 4" })).findByRole("button", { name: "Start sprint" }));
    const dialog = screen.getByRole("dialog", { name: "Start Sprint 4" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Start sprint" }));
    expect(await within(dialog).findByText("Updated by a teammate — review the sprint and try again.")).toBeInTheDocument();
    expect(within(dialog).getByText("Search, revised")).toBeInTheDocument();
    await waitFor(() => expect(requests(SPRINTS_KEY)).toHaveLength(2));
    await userEvent.click(within(dialog).getByRole("button", { name: "Start sprint" }));
    await waitFor(() => expect(requests("POST")).toHaveLength(2));
    expect(requests("POST")[1].ifMatch).toBe("\"v3\"");
    expect(await screen.findByText("Sprint 4 started.")).toBeInTheDocument();
  });

  it("refuses a sprint longer than 28 days before sending anything", async () => {
    mockApi({ sprints: [NEXT] });
    await renderBacklog();
    await userEvent.click(await within(await screen.findByRole("region", { name: "Sprint 4" })).findByRole("button", { name: "Start sprint" }));
    const dialog = screen.getByRole("dialog", { name: "Start Sprint 4" });
    fireEvent.change(within(dialog).getByLabelText("End date"), { target: { value: day(60) } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Start sprint" }));
    expect(within(dialog).getByText("A sprint lasts 1 to 28 days, ending after it starts.")).toBeInTheDocument();
    expect(requests("POST")).toHaveLength(0);
  });

  it("completes the active sprint and carries unfinished work to the next sprint", async () => {
    mockApi({ routes: { "POST /api/v1/sprints/s-active/complete": json({ sprint: { ...ACTIVE, status: "completed", version: 5 }, movedIssues: 1 }) } });
    await renderBacklog();
    await userEvent.click(await within(await screen.findByRole("region", { name: "Sprint 3" })).findByRole("button", { name: "Complete sprint" }));
    const dialog = screen.getByRole("dialog", { name: "Complete Sprint 3" });
    expect(within(dialog).getByText("1 of 2 tasks done · 1 unfinished task")).toBeInTheDocument();
    const choices = within(dialog).getByRole("radiogroup", { name: "Move unfinished work to" });
    expect(within(choices).getByRole("radio", { name: "Sprint 4 (next)" })).toBeChecked();
    expect(within(choices).getByRole("radio", { name: "Sprint 5" })).not.toBeChecked();
    expect(within(choices).getByRole("radio", { name: "Backlog" })).not.toBeChecked();
    await userEvent.click(within(dialog).getByRole("button", { name: "Complete sprint" }));
    await waitFor(() => expect(requests("POST")).toHaveLength(1));
    expect(requests("POST")[0]).toEqual({ key: "POST /api/v1/sprints/s-active/complete", body: { carryToSprintId: "s-next" }, ifMatch: "\"v4\"" });
    expect(await screen.findByText("Sprint 3 completed. 1 unfinished task moved to Sprint 4.")).toBeInTheDocument();
    // The Complete button left with the active lane; focus goes to Create sprint instead of <body>.
    await waitFor(() => expect(screen.getByRole("button", { name: "Create sprint" })).toHaveFocus());
  });

  it("completes the active sprint sending unfinished work to the backlog", async () => {
    mockApi({ routes: { "POST /api/v1/sprints/s-active/complete": json({ sprint: { ...ACTIVE, status: "completed", version: 5 }, movedIssues: 1 }) } });
    await renderBacklog();
    await userEvent.click(await within(await screen.findByRole("region", { name: "Sprint 3" })).findByRole("button", { name: "Complete sprint" }));
    const dialog = screen.getByRole("dialog", { name: "Complete Sprint 3" });
    await userEvent.click(within(dialog).getByRole("radio", { name: "Backlog" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Complete sprint" }));
    await waitFor(() => expect(requests("POST")).toHaveLength(1));
    expect(requests("POST")[0].body).toEqual({ carryToSprintId: null });
    expect(await screen.findByText("Sprint 3 completed. 1 unfinished task moved to the backlog.")).toBeInTheDocument();
  });

  it("creates a sprint pre-filled after the last planned one", async () => {
    mockApi({ routes: { "POST /api/v1/projects/p-atlas/sprints": json(sprint("s-new", "Sprint 8", "planned"), 201, { ETag: "\"v1\"" }) } });
    await renderBacklog();
    await userEvent.click(await screen.findByRole("button", { name: "Create sprint" }));
    const dialog = screen.getByRole("dialog", { name: "Create sprint" });
    expect(within(dialog).getByLabelText("Sprint name")).toHaveValue("Sprint 8");
    // Sprint 4 ends latest of the open sprints; the new one follows it with the project's 14 days.
    expect(within(dialog).getByLabelText("Start date")).toHaveValue(NEXT.endsOn);
    expect(within(dialog).getByLabelText("End date")).toHaveValue(day(33));
    await userEvent.type(within(dialog).getByLabelText("Sprint goal"), "Polish");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create sprint" }));
    await waitFor(() => expect(requests("POST")).toHaveLength(1));
    expect(requests("POST")[0]).toEqual({ key: "POST /api/v1/projects/p-atlas/sprints", body: { name: "Sprint 8", goal: "Polish", startsOn: NEXT.endsOn, endsOn: day(33) }, ifMatch: null });
    expect(await screen.findByText("Sprint 8 created.")).toBeInTheDocument();
  });

  it("edits a planned sprint's name with If-Match", async () => {
    mockApi({ routes: { "PATCH /api/v1/sprints/s-later": json({ ...LATER, name: "Hardening", version: 2 }) } });
    await renderBacklog();
    await userEvent.click(await within(await screen.findByRole("region", { name: "Sprint 5" })).findByRole("button", { name: "Edit Sprint 5" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Sprint 5" });
    const name = within(dialog).getByLabelText("Sprint name");
    await userEvent.clear(name);
    await userEvent.type(name, "Hardening");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save sprint" }));
    await waitFor(() => expect(requests("PATCH")).toHaveLength(1));
    expect(requests("PATCH")[0]).toEqual({ key: "PATCH /api/v1/sprints/s-later", body: { name: "Hardening" }, ifMatch: "\"v1\"" });
  });

  it("shows a plain member the plan read-only with the authority message", async () => {
    auth.user = MEMBER;
    mockApi({ role: "member" });
    await renderBacklog();
    await planning();
    await screen.findByText("Checkout flow");
    expect(screen.getByText("Only owners, admins and the project lead can change the plan.")).toBeInTheDocument();
    expect(laneNames()).toEqual(["Sprint 3", "Sprint 4", "Sprint 5", "Backlog"]);
    expect(screen.getByText("Velocity 21 pts (last 3)")).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "Create sprint" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start sprint" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Complete sprint" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Edit / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Move to…/u })).not.toBeInTheDocument();
    expect(card$("ATLAS-4")).not.toHaveAttribute("draggable", "true");

    card$("ATLAS-4").focus();
    await userEvent.keyboard(" {ArrowUp}{Escape}");
    expect(cardsIn("Backlog")).toEqual(["ATLAS-4", "ATLAS-7", "ATLAS-5"]);
    expect(requests("PATCH")).toHaveLength(0);

    // Members see neither the Settings tab nor the header's Settings button.
    const tabs = screen.getByRole("navigation", { name: "Project views" });
    expect(within(tabs).getAllByRole("link").map((link) => link.textContent)).toEqual(["Board", "Backlog", "Overview"]);
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("shows the project lead the planning controls", async () => {
    auth.user = { ...MEMBER, id: "u-avery" };
    mockApi({ role: "member" });
    await renderBacklog();
    expect(await screen.findByRole("button", { name: "Create sprint" })).toBeInTheDocument();
    expect(screen.queryByText("Only owners, admins and the project lead can change the plan.")).not.toBeInTheDocument();
  });

  it("explains that the backlog belongs to Scrum projects and shows the Kanban tabs", async () => {
    mockApi({ project: KANBAN });
    await renderBacklog("OPS");
    expect(await screen.findByRole("heading", { name: "The backlog is for Scrum projects" })).toBeInTheDocument();
    const tabs = screen.getByRole("navigation", { name: "Project views" });
    expect(within(tabs).getAllByRole("link").map((link) => link.textContent)).toEqual(["Board", "Overview", "Settings"]);
    expect(requests(SPRINTS_KEY)).toHaveLength(0);
  });
});
