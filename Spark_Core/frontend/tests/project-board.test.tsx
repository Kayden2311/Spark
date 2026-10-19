import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CATALOG } from "./methodology-catalog";
import { KANBAN, KANBAN_BOARD, LIST, SCRUM, WATERFALL, issueDetail } from "./project-fixtures";

const navigation = { params: { slug: "northstar-labs", key: "OPS" } as Record<string, string>, pathname: "/w/northstar-labs/p/OPS" };
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
  useParams: () => navigation.params,
}));
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));

import WorkspaceLayout from "../src/app/w/[slug]/layout";
import ProjectLayout from "../src/app/w/[slug]/p/[key]/layout";
import ProjectBoardPage from "../src/app/w/[slug]/p/[key]/page";

const workspace = { id: "w1", slug: "northstar-labs", name: "Northstar Labs", role: "owner", memberCount: 2, version: 2, createdAt: "2026-10-18T10:00:00.000Z" };

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;
type Call = { key: string; body: unknown; ifMatch: string | null; idempotencyKey: string | null };
let calls: Call[] = [];
const json = (payload: unknown, status = 200, headers: Record<string, string> = {}): Handler => () =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });
const problem = (status: number, code: string, detail: string, extra: Record<string, unknown> = {}): Handler => () =>
  new Response(JSON.stringify({ status, code, detail, ...extra }), { status, headers: { "content-type": "application/problem+json" } });

const BOARD_KEY = "GET /api/v1/projects/p-ops/board";

function mockApi(extra: Record<string, Handler> = {}, project: { key: string } = KANBAN) {
  calls = [];
  const routes: Record<string, Handler> = {
    "GET /api/v1/workspaces/by-slug/northstar-labs": json(workspace),
    "GET /api/v1/workspaces/w1/projects": json({ items: LIST }),
    "GET /api/v1/methodologies": json({ items: CATALOG }),
    [`GET /api/v1/workspaces/w1/projects/by-key/${project.key}`]: json(project, 200, { ETag: "\"v3\"" }),
    [BOARD_KEY]: json(KANBAN_BOARD),
    ...extra,
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const headers = new Headers(init?.headers);
    calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined, ifMatch: headers.get("If-Match"), idempotencyKey: headers.get("Idempotency-Key") });
    const handler = routes[key];
    return handler ? handler(init) : new Response(JSON.stringify({ code: "not_found", detail: "Not found." }), { status: 404 });
  }));
}

async function renderBoard(key = "OPS") {
  navigation.params = { slug: "northstar-labs", key };
  navigation.pathname = `/w/northstar-labs/p/${key}`;
  render(<WorkspaceLayout><ProjectLayout><ProjectBoardPage /></ProjectLayout></WorkspaceLayout>);
  return screen.findByRole("region", { name: "Board" });
}

const column = (name: string) => screen.getByRole("group", { name: new RegExp(`^${name} column`) });
const cardsIn = (name: string) =>
  within(within(column(name)).getByRole("list", { name: `${name} tasks` }))
    .queryAllByRole("button", { name: /^[A-Z]+-\d+:/ })
    .map((element) => element.getAttribute("aria-label")?.split(":")[0]);
const card = (key: string) => screen.getByRole("button", { name: new RegExp(`^${key}:`) });
const liveRegion = () => document.querySelector("[aria-live=\"polite\"]") as HTMLElement;
const requests = (prefix: string) => calls.filter((call) => call.key.startsWith(prefix));
const card1 = KANBAN_BOARD.issues[1];

async function pickUpFirst() {
  (await screen.findByRole("button", { name: /^OPS-1:/ })).focus();
  await userEvent.keyboard(" ");
}

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("project board", () => {
  it("renders columns in order with counts, WIP chips, cards and the project tabs", async () => {
    mockApi();
    const board = await renderBoard();
    expect(await within(board).findByText("Reset VPN tokens")).toBeInTheDocument();
    const names = within(board).getAllByRole("group").map((group) => group.getAttribute("aria-label"));
    expect(names).toEqual(["Backlog column, 1 task", "Ready column, 2 tasks", "In progress column, 0 tasks", "Review column, 3 tasks", "Done column, 1 task"]);

    expect(within(column("In progress")).getByText("WIP 4")).toHaveAttribute("data-state", "ok");
    expect(within(column("Review")).getByText("WIP 3")).toHaveAttribute("data-state", "at");
    expect(cardsIn("Ready")).toEqual(["OPS-1", "OPS-2"]);

    const first = card("OPS-1");
    expect(within(first).getByText("Bug")).toBeInTheDocument();
    expect(within(first).getByText("High")).toBeInTheDocument();
    expect(within(first).getByText("BR")).toBeInTheDocument();
    expect(within(first).getByText("Jan 1, 2020")).toHaveAttribute("data-overdue", "true");
    expect(within(card("OPS-7")).getByText("Jan 1, 2020")).not.toHaveAttribute("data-overdue");

    // Quick-add sits under every column except Done; a full column explains why it is disabled.
    expect(screen.getAllByRole("textbox", { name: /^Add a task to / })).toHaveLength(4);
    expect(screen.queryByRole("textbox", { name: "Add a task to Done" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Add a task to Review" })).toBeDisabled();
    expect(within(column("Review")).getByText("Review is at its WIP limit (3). Finish or move a task out first.")).toBeInTheDocument();

    const tabs = screen.getByRole("navigation", { name: "Project views" });
    expect(within(tabs).getByRole("link", { name: "Board" })).toHaveAttribute("aria-current", "page");
    expect(within(tabs).getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/w/northstar-labs/p/OPS/overview");
    expect(screen.getByRole("heading", { level: 1, name: "Ops desk" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByText("Showing the first 500 tasks.")).not.toBeInTheDocument();
  });

  it("marks a column over its limit from legacy data", async () => {
    const over = { ...KANBAN_BOARD, statuses: KANBAN_BOARD.statuses.map((status) => (status.id === "s4" ? { ...status, count: 5 } : status)) };
    mockApi({ [BOARD_KEY]: json(over) });
    await renderBoard();
    expect(await within(column("Review")).findByText("WIP 3")).toHaveAttribute("data-state", "over");
  });

  it("shows the truncation banner and story points on a Scrum board", async () => {
    const scrumBoard = { ...KANBAN_BOARD, project: { id: "p-atlas", key: "ATLAS", name: "Atlas app", methodology: "scrum" }, truncated: true, issues: [{ ...KANBAN_BOARD.issues[0], storyPoints: 5 }] };
    mockApi({ "GET /api/v1/projects/p-atlas/board": json(scrumBoard) }, SCRUM);
    await renderBoard("ATLAS");
    expect(await screen.findByText("5 pts")).toBeInTheDocument();
    expect(screen.getByText("Showing the first 500 tasks.")).toBeInTheDocument();
  });

  it("tags cards with their phase on a Waterfall board", async () => {
    const waterfallBoard = { ...KANBAN_BOARD, project: { id: "p-web", key: "WEB", name: "Website relaunch", methodology: "waterfall" }, issues: [{ ...KANBAN_BOARD.issues[0], phaseId: "ph2" }] };
    mockApi({ "GET /api/v1/projects/p-web/board": json(waterfallBoard) }, WATERFALL);
    await renderBoard("WEB");
    expect(await screen.findByText("Design")).toHaveClass("wsBoardPhase");
  });

  it("moves a card with the keyboard and announces each step", async () => {
    mockApi({ "PATCH /api/v1/issues/i1": json(issueDetail(card1, { statusId: "s3", version: 2 }), 200, { ETag: "\"v2\"" }) });
    await renderBoard();
    await pickUpFirst();
    expect(liveRegion()).toHaveTextContent("Picked up OPS-1. Use arrow keys to move, Enter to drop, Escape to cancel.");
    await userEvent.keyboard("{ArrowRight}");
    expect(liveRegion()).toHaveTextContent("OPS-1 in In progress, position 1 of 1");
    expect(cardsIn("In progress")).toEqual(["OPS-1"]);
    expect(card("OPS-1")).toHaveFocus();
    expect(requests("PATCH")).toHaveLength(0);

    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(requests("PATCH")).toHaveLength(1));
    expect(requests("PATCH")[0]).toMatchObject({ key: "PATCH /api/v1/issues/i1", ifMatch: "\"v1\"", body: { statusId: "s3", afterIssueId: null } });
    expect(liveRegion()).toHaveTextContent("Dropped OPS-1 in In progress, position 1 of 1.");
    expect(cardsIn("In progress")).toEqual(["OPS-1"]);
    expect(column("In progress")).toHaveAccessibleName("In progress column, 1 task");
    expect(column("Ready")).toHaveAccessibleName("Ready column, 1 task");
    expect(card("OPS-1")).toHaveFocus();
  });

  it("reorders inside a column with only afterIssueId", async () => {
    mockApi({ "PATCH /api/v1/issues/i1": json(issueDetail(card1, { version: 2 }), 200, { ETag: "\"v2\"" }) });
    await renderBoard();
    await pickUpFirst();
    await userEvent.keyboard("{ArrowDown}");
    expect(liveRegion()).toHaveTextContent("OPS-1 in Ready, position 2 of 2");
    await userEvent.keyboard(" ");
    await waitFor(() => expect(requests("PATCH")).toHaveLength(1));
    expect(requests("PATCH")[0].body).toEqual({ afterIssueId: "i2" });
    expect(cardsIn("Ready")).toEqual(["OPS-2", "OPS-1"]);
  });

  it("restores the card without a request when the move is cancelled", async () => {
    mockApi();
    await renderBoard();
    await pickUpFirst();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(cardsIn("Review")).toEqual(["OPS-1", "OPS-4", "OPS-5", "OPS-6"]);
    await userEvent.keyboard("{Escape}");
    expect(cardsIn("Ready")).toEqual(["OPS-1", "OPS-2"]);
    expect(cardsIn("Review")).toEqual(["OPS-4", "OPS-5", "OPS-6"]);
    expect(liveRegion()).toHaveTextContent("Move cancelled. OPS-1 is back in Ready, position 1 of 2.");
    expect(requests("PATCH")).toHaveLength(0);
  });

  it("refuses a drop on a full column without a request", async () => {
    mockApi();
    await renderBoard();
    await pickUpFirst();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}{Enter}");
    expect(within(column("Review")).getAllByText("Review is at its WIP limit (3). Finish or move a task out first.").length).toBeGreaterThan(0);
    expect(cardsIn("Ready")).toEqual(["OPS-1", "OPS-2"]);
    expect(requests("PATCH")).toHaveLength(0);
  });

  it("rolls a card back when the API reports the WIP limit and explains in the column", async () => {
    mockApi({ "PATCH /api/v1/issues/i1": problem(409, "wip_limit_reached", "In progress is at its WIP limit (4).") });
    await renderBoard();
    await pickUpFirst();
    await userEvent.keyboard("{ArrowRight}{Enter}");
    expect(await within(column("In progress")).findByText("In progress is at its WIP limit (4). Finish or move a task out first.")).toBeInTheDocument();
    expect(cardsIn("Ready")).toEqual(["OPS-1", "OPS-2"]);
    expect(cardsIn("In progress")).toEqual([]);
    expect(column("In progress")).toHaveAccessibleName("In progress column, 0 tasks");
  });

  it("rolls back with the API message on other errors", async () => {
    mockApi({ "PATCH /api/v1/issues/i1": problem(404, "issue_not_found", "Issue does not exist.") });
    await renderBoard();
    await pickUpFirst();
    await userEvent.keyboard("{ArrowRight}{Enter}");
    expect(await screen.findByText("Issue does not exist.")).toBeInTheDocument();
    expect(cardsIn("Ready")).toEqual(["OPS-1", "OPS-2"]);
  });

  it("refreshes the board and says so when a teammate changed the card first", async () => {
    let boards = 0;
    const refreshed = { ...KANBAN_BOARD, issues: KANBAN_BOARD.issues.map((issue) => (issue.id === "i1" ? { ...issue, title: "Reset VPN tokens (urgent)", version: 2 } : issue)) };
    mockApi({
      [BOARD_KEY]: () => {
        boards += 1;
        return json(boards === 1 ? KANBAN_BOARD : refreshed)(undefined);
      },
      "PATCH /api/v1/issues/i1": problem(412, "version_mismatch", "The resource changed since you loaded it.", { current: issueDetail(card1, { version: 2 }) }),
    });
    await renderBoard();
    await pickUpFirst();
    await userEvent.keyboard("{ArrowRight}{Enter}");
    const toast = await screen.findByText("Updated by a teammate — the board was refreshed.");
    expect(toast.closest("[aria-live]")).toBe(liveRegion());
    expect(await screen.findByText("Reset VPN tokens (urgent)")).toBeInTheDocument();
    expect(requests(BOARD_KEY)).toHaveLength(2);
    expect(cardsIn("Ready")).toEqual(["OPS-1", "OPS-2"]);
  });

  it("offers a Move to menu with the current column marked and full columns disabled", async () => {
    mockApi({ "PATCH /api/v1/issues/i1": json(issueDetail(card1, { statusId: "s5", version: 2 }), 200, { ETag: "\"v2\"" }) });
    await renderBoard();
    await screen.findByRole("button", { name: /^OPS-1:/ });
    await userEvent.click(screen.getByRole("button", { name: "Move OPS-1 to…" }));
    const menu = screen.getByRole("menu", { name: "Move OPS-1 to" });
    expect(within(menu).getByRole("menuitemradio", { name: "Ready (current)" })).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getByRole("menuitemradio", { name: "Review (full)" })).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: "Review (full)" }));
    expect(requests("PATCH")).toHaveLength(0);
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: "Done" }));
    await waitFor(() => expect(requests("PATCH")).toHaveLength(1));
    expect(requests("PATCH")[0].body).toEqual({ statusId: "s5", afterIssueId: "i7" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(cardsIn("Done")).toEqual(["OPS-7", "OPS-1"]);
  });

  it("moves a card by dragging it onto another column", async () => {
    mockApi({ "PATCH /api/v1/issues/i2": json(issueDetail(KANBAN_BOARD.issues[2], { statusId: "s1", version: 2 }), 200, { ETag: "\"v2\"" }) });
    await renderBoard();
    const dragged = await screen.findByRole("button", { name: /^OPS-2:/ });
    const target = within(column("Backlog")).getByRole("list", { name: "Backlog tasks" });
    const dataTransfer = { setData: vi.fn(), getData: () => "i2", effectAllowed: "move", dropEffect: "move" };
    fireEvent.dragStart(dragged, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer, clientY: 9999 });
    fireEvent.drop(target, { dataTransfer, clientY: 9999 });
    await waitFor(() => expect(requests("PATCH")).toHaveLength(1));
    expect(requests("PATCH")[0].body).toEqual({ statusId: "s1", afterIssueId: "i0" });
    expect(cardsIn("Backlog")).toEqual(["OPS-9", "OPS-2"]);
  });

  it("quick-adds with one Idempotency-Key that survives a network retry", async () => {
    let attempts = 0;
    const created = issueDetail({ ...KANBAN_BOARD.issues[0], id: "i10", number: 10, key: "OPS-10", title: "Renew certificates" });
    mockApi({
      "POST /api/v1/projects/p-ops/issues": () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError("Failed to fetch");
        return json(attempts === 2 ? created : { ...created, id: `i${attempts + 9}`, number: attempts + 8, key: `OPS-${attempts + 8}`, title: "Another task" }, 201, { ETag: "\"v1\"" })(undefined);
      },
    });
    await renderBoard();
    const input = await screen.findByRole("textbox", { name: "Add a task to Backlog" });
    await userEvent.type(input, "Renew certificates{Enter}");
    expect(await within(column("Backlog")).findByText("Spark could not be reached. Check your connection and try again.")).toBeInTheDocument();
    expect(input).toHaveValue("Renew certificates");
    await userEvent.type(input, "{Enter}");
    await waitFor(() => expect(cardsIn("Backlog")).toEqual(["OPS-9", "OPS-10"]));
    const posts = requests("POST");
    expect(posts).toHaveLength(2);
    expect(posts[0].body).toEqual({ title: "Renew certificates", statusId: "s1" });
    expect(posts[0].idempotencyKey).toMatch(/^[A-Za-z0-9_.:-]{1,100}$/u);
    expect(posts[1].idempotencyKey).toBe(posts[0].idempotencyKey);
    expect(input).toHaveValue("");
    expect(column("Backlog")).toHaveAccessibleName("Backlog column, 2 tasks");

    await userEvent.type(input, "Another task{Enter}");
    await waitFor(() => expect(requests("POST")).toHaveLength(3));
    expect(requests("POST")[2].idempotencyKey).not.toBe(posts[0].idempotencyKey);
  });

  it("explains a WIP refusal from quick-add in the column", async () => {
    mockApi({ "POST /api/v1/projects/p-ops/issues": problem(409, "wip_limit_reached", "In progress is at its WIP limit (4).") });
    await renderBoard();
    await userEvent.type(await screen.findByRole("textbox", { name: "Add a task to In progress" }), "Patch servers{Enter}");
    expect(await within(column("In progress")).findByText("In progress is at its WIP limit (4). Finish or move a task out first.")).toBeInTheDocument();
  });
});

