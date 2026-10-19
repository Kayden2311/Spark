import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CATALOG } from "./methodology-catalog";
import { KANBAN, KANBAN_BOARD, LIST, SCRUM, issueDetail } from "./project-fixtures";

const navigation = { params: { slug: "northstar-labs", key: "OPS" } as Record<string, string>, pathname: "/w/northstar-labs/p/OPS", search: "" };
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
  useSearchParams: () => new URLSearchParams(navigation.search),
  useParams: () => navigation.params,
}));
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));

import { columnIssues, moveCard, removeCard, replaceCard } from "../src/app/w/_lib/board-moves";
import { toCard, type BoardState, type IssueCard, type IssueDetail } from "../src/app/w/_lib/issues";
import WorkspaceLayout from "../src/app/w/[slug]/layout";
import ProjectLayout from "../src/app/w/[slug]/p/[key]/layout";
import ProjectBoardPage from "../src/app/w/[slug]/p/[key]/page";

const workspace = { id: "w1", slug: "northstar-labs", name: "Northstar Labs", role: "owner", memberCount: 3, version: 2, createdAt: "2026-10-18T10:00:00.000Z" };
const member = (userId: string, displayName: string, role = "member") => ({ userId, displayName, avatarUrl: null, email: null, role, joinedAt: "2026-10-18T10:00:00.000Z" });
const MEMBERS = { items: [member("u-avery", "Avery Founder", "owner"), member("u-blake", "Blake Rivers"), member("u-sam", "Sam Lee")], nextCursor: null };

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;
type Call = { key: string; body: unknown; ifMatch: string | null };
let calls: Call[] = [];
const json = (payload: unknown, status = 200, headers: Record<string, string> = {}): Handler => () =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });
const problem = (status: number, code: string, detail: string, extra: Record<string, unknown> = {}): Handler => () =>
  new Response(JSON.stringify({ status, code, detail, ...extra }), { status, headers: { "content-type": "application/problem+json" } });

const BOARD_KEY = "GET /api/v1/projects/p-ops/board";
const cards = KANBAN_BOARD.issues as IssueCard[];
const card2 = cards[2];

/** The board the fake API serves: successful PATCHes change it, so the drawer's silent refetch sees them. */
let server: BoardState;

async function applyToServer(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const detail = (await response.clone().json()) as IssueDetail;
  if (detail.archivedAt) {
    server = removeCard(server, detail.id);
  } else {
    const before = server.issues.find((item) => item.id === detail.id);
    if (before && before.statusId !== detail.statusId) server = moveCard(server, detail.id, detail.statusId, columnIssues(server, detail.statusId).at(-1)?.id ?? null);
    server = replaceCard(server, toCard(detail));
  }
  return response;
}

function mockApi(extra: Record<string, Handler> = {}, project: { key: string } = KANBAN, board: unknown = KANBAN_BOARD) {
  calls = [];
  server = structuredClone(board) as BoardState;
  const routes: Record<string, Handler> = {
    "GET /api/v1/workspaces/by-slug/northstar-labs": json(workspace),
    "GET /api/v1/workspaces/w1/projects": json({ items: LIST }),
    "GET /api/v1/methodologies": json({ items: CATALOG }),
    [`GET /api/v1/workspaces/w1/projects/by-key/${project.key}`]: json(project, 200, { ETag: "\"v3\"" }),
    "GET /api/v1/workspaces/w1/members": json(MEMBERS),
    [BOARD_KEY]: () => json(server)(undefined),
    ...extra,
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const headers = new Headers(init?.headers);
    calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined, ifMatch: headers.get("If-Match") });
    const handler = routes[key];
    if (handler) return key.startsWith("PATCH ") ? applyToServer(await handler(init)) : handler(init);
    const detail = /^GET \/api\/v1\/issues\/([^/?]+)$/u.exec(key);
    const found = detail && cards.find((item) => item.id === detail[1]);
    if (found) return json(issueDetail(found as Parameters<typeof issueDetail>[0], { description: "Laptops for the new hires." }), 200, { ETag: `"v${found.version}"` })(init);
    if (/^GET \/api\/v1\/issues\/[^/]+\/events/u.test(key)) return json({ items: [], nextCursor: null })(init);
    return new Response(JSON.stringify({ code: "not_found", detail: "Not found." }), { status: 404 });
  }));
}

async function renderBoard(key = "OPS") {
  navigation.params = { slug: "northstar-labs", key };
  navigation.pathname = `/w/northstar-labs/p/${key}`;
  render(<WorkspaceLayout><ProjectLayout><ProjectBoardPage /></ProjectLayout></WorkspaceLayout>);
  return screen.findByRole("region", { name: "Board" });
}

const card = (key: string) => screen.getByRole("button", { name: new RegExp(`^${key}:`) });
const requests = (prefix: string) => calls.filter((call) => call.key.startsWith(prefix));
const liveRegion = () => document.querySelector("[aria-live=\"polite\"]") as HTMLElement;

async function openDrawer(key = "OPS-2") {
  await renderBoard();
  await userEvent.click(await screen.findByRole("button", { name: new RegExp(`^${key}:`) }));
  const drawer = await screen.findByRole("dialog", { name: key });
  await within(drawer).findByDisplayValue(cards.find((item) => item.key === key)!.title);
  return drawer;
}

beforeEach(() => {
  window.localStorage.clear();
  navigation.search = "";
  window.history.replaceState(null, "", "/w/northstar-labs/p/OPS");
});
afterEach(() => vi.unstubAllGlobals());

describe("task drawer", () => {
  it("opens from a card click and from Enter, while Space still picks the card up", async () => {
    mockApi();
    await renderBoard();
    const target = await screen.findByRole("button", { name: /^OPS-2:/ });
    target.focus();
    await userEvent.keyboard("{Enter}");
    const drawer = await screen.findByRole("dialog", { name: "OPS-2" });
    expect(drawer).toHaveAttribute("data-variant", "drawer");
    expect(await within(drawer).findByDisplayValue("Order new laptops")).toBeInTheDocument();
    expect(within(drawer).getByLabelText("Description")).toHaveValue("Laptops for the new hires.");
    expect(window.location.search).toBe("?issue=OPS-2");

    await userEvent.click(within(drawer).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(window.location.search).toBe("");
    expect(card("OPS-2")).toHaveFocus();

    await userEvent.keyboard(" ");
    expect(liveRegion()).toHaveTextContent("Picked up OPS-2.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("saves only the changed fields with If-Match and updates the card", async () => {
    mockApi({
      "PATCH /api/v1/issues/i2": json(issueDetail(card2 as Parameters<typeof issueDetail>[0], { title: "Order new laptops and docks", priority: "high", version: 2 }), 200, { ETag: "\"v2\"" }),
    });
    const drawer = await openDrawer();
    const title = within(drawer).getByLabelText("Title");
    await userEvent.clear(title);
    await userEvent.type(title, "Order new laptops and docks");
    await userEvent.selectOptions(within(drawer).getByLabelText("Priority"), "high");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(requests("PATCH")).toHaveLength(1));
    expect(requests("PATCH")[0]).toMatchObject({ key: "PATCH /api/v1/issues/i2", ifMatch: "\"v1\"", body: { title: "Order new laptops and docks", priority: "high" } });
    expect(Object.keys(requests("PATCH")[0].body as object).sort()).toEqual(["priority", "title"]);
    expect(await screen.findByText("Saved OPS-2.")).toBeInTheDocument();
    expect(screen.getByText("Saved OPS-2.").closest("[aria-live]")).toBe(liveRegion());
    expect(card("OPS-2")).toHaveAccessibleName("OPS-2: Order new laptops and docks");
    expect(within(card("OPS-2")).getByText("High")).toBeInTheDocument();
  });

  it("keeps the toast and a screen-reader announcement apart in the live region", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mockApi({ "PATCH /api/v1/issues/i2": json(issueDetail(card2 as Parameters<typeof issueDetail>[0], { priority: "high", version: 2 }), 200) });
    await renderBoard();
    (await screen.findByRole("button", { name: /^OPS-2:/ })).focus();
    await userEvent.keyboard(" ");
    await userEvent.click(card("OPS-2"));
    const drawer = await screen.findByRole("dialog", { name: "OPS-2" });
    await userEvent.selectOptions(await within(drawer).findByLabelText("Priority"), "high");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    await screen.findByText("Saved OPS-2.");
    expect(liveRegion()).toHaveTextContent("Picked up OPS-2.");
    expect(errors.mock.calls.filter((call) => String(call[0]).includes("same key"))).toEqual([]);
    errors.mockRestore();
  });

  it("swaps in a teammate's newer values on 412", async () => {
    mockApi({
      "PATCH /api/v1/issues/i2": problem(412, "version_mismatch", "The resource changed since you loaded it.", { current: issueDetail(card2 as Parameters<typeof issueDetail>[0], { title: "Order laptops (approved)", version: 3 }) }),
    });
    const drawer = await openDrawer();
    await userEvent.selectOptions(within(drawer).getByLabelText("Type"), "story");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    expect(await within(drawer).findByText("Updated by a teammate — review the latest values and save again.")).toBeInTheDocument();
    expect(within(drawer).getByLabelText("Title")).toHaveValue("Order laptops (approved)");
    expect(within(drawer).getByLabelText("Type")).toHaveValue("task");

    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    // Nothing changed against the newer values, so nothing is sent.
    expect(requests("PATCH")).toHaveLength(1);
  });

  it("lists members and Unassigned as assignee options and explains an invalid assignee", async () => {
    mockApi({ "PATCH /api/v1/issues/i2": problem(422, "invalid_assignee", "The assignee must be an active member of the workspace.") });
    const drawer = await openDrawer();
    const assignee = within(drawer).getByLabelText("Assignee");
    await waitFor(() => expect(within(assignee).getAllByRole("option").map((option) => option.textContent)).toEqual(["Unassigned", "Avery Founder", "Blake Rivers", "Sam Lee"]));
    expect(assignee).toHaveValue("");
    await userEvent.selectOptions(assignee, "u-sam");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests("PATCH")).toHaveLength(1));
    expect(requests("PATCH")[0].body).toEqual({ assigneeUserId: "u-sam" });
    expect(await within(drawer).findByText("The assignee must be an active member of the workspace.")).toBeInTheDocument();
    expect(assignee).toHaveAttribute("aria-invalid", "true");
  });

  it("disables full columns in the status select and shows a WIP refusal on the field", async () => {
    mockApi({ "PATCH /api/v1/issues/i2": problem(409, "wip_limit_reached", "In progress is at its WIP limit (4).") });
    const drawer = await openDrawer();
    const status = within(drawer).getByLabelText("Status");
    expect(status).toHaveValue("s2");
    expect(within(status).getByRole("option", { name: "Review (full)" })).toBeDisabled();
    await userEvent.selectOptions(status, "s3");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests("PATCH")).toHaveLength(1));
    expect(requests("PATCH")[0].body).toEqual({ statusId: "s3" });
    expect(await within(drawer).findByText("In progress is at its WIP limit (4). Finish or move a task out first.")).toBeInTheDocument();
    expect(status).toHaveAttribute("aria-invalid", "true");
  });

  it("moves the card when the status changes", async () => {
    mockApi({ "PATCH /api/v1/issues/i2": json(issueDetail(card2 as Parameters<typeof issueDetail>[0], { statusId: "s3", version: 2 }), 200, { ETag: "\"v2\"" }) });
    const drawer = await openDrawer();
    await userEvent.selectOptions(within(drawer).getByLabelText("Status"), "s3");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    await screen.findByText("Saved OPS-2.");
    const inProgress = screen.getByRole("group", { name: /^In progress column/ });
    expect(inProgress).toHaveAccessibleName("In progress column, 1 task");
    expect(within(inProgress).getByRole("button", { name: /^OPS-2:/ })).toBeInTheDocument();
  });

  it("asks before archiving and then removes the card", async () => {
    mockApi({ "PATCH /api/v1/issues/i2": json(issueDetail(card2 as Parameters<typeof issueDetail>[0], { version: 2, archivedAt: "2026-10-19T11:00:00.000Z" }), 200, { ETag: "\"v2\"" }) });
    const drawer = await openDrawer();
    await userEvent.click(within(drawer).getByRole("button", { name: "Archive task" }));
    expect(requests("PATCH")).toHaveLength(0);
    expect(within(drawer).getByText(/Archive OPS-2\?/u)).toBeInTheDocument();
    await userEvent.click(within(drawer).getByRole("button", { name: "Keep task" }));
    expect(within(drawer).queryByText(/Archive OPS-2\?/u)).not.toBeInTheDocument();

    await userEvent.click(within(drawer).getByRole("button", { name: "Archive task" }));
    await userEvent.click(within(drawer).getByRole("button", { name: "Yes, archive" }));
    await waitFor(() => expect(requests("PATCH")).toHaveLength(1));
    expect(requests("PATCH")[0]).toMatchObject({ ifMatch: "\"v1\"", body: { archived: true } });
    expect(await screen.findByText("Archived OPS-2.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^OPS-2:/ })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: /^Ready column/ })).toHaveAccessibleName("Ready column, 1 task");
    expect(window.location.search).toBe("");
    expect(screen.queryByText("That task no longer exists.")).not.toBeInTheDocument();
  });

  it("tells the history in sentences and loads more", async () => {
    const now = Date.now();
    const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
    const after = (extra: Record<string, unknown>) => ({ statusId: "s2", category: "todo", assigneeUserId: null, storyPoints: null, phaseId: null, sprintId: null, archived: false, ...extra });
    const event = (id: string, type: string, fields: string[], extra: Record<string, unknown>, minutes: number, actor = { id: "u-avery", displayName: "Avery Founder" }) =>
      ({ id, type, actor, fromVersion: 1, toVersion: 2, changes: { fields, after: after(extra) }, createdAt: ago(minutes) });
    mockApi({
      "GET /api/v1/issues/i2/events": json({
        items: [
          event("e3", "issue.updated", ["assigneeUserId"], { assigneeUserId: "u-sam" }, 5, { id: "u-blake", displayName: "Blake Rivers" }),
          event("e2", "issue.updated", ["position", "statusId"], { statusId: "s3", category: "in_progress" }, 125),
        ],
        nextCursor: "c1",
      }),
      "GET /api/v1/issues/i2/events?cursor=c1": json({ items: [event("e1", "issue.created", ["title"], {}, 60 * 24 * 3)], nextCursor: null }),
    });
    const drawer = await openDrawer();
    const history = within(drawer).getByRole("list", { name: "History" });
    expect(await within(history).findByText("Blake Rivers assigned it to Sam Lee")).toBeInTheDocument();
    expect(within(history).getByText("Avery Founder moved it to In progress")).toBeInTheDocument();
    expect(within(history).getByText("5 min ago")).toBeInTheDocument();
    expect(within(history).getByText("2 h ago")).toBeInTheDocument();

    await userEvent.click(within(drawer).getByRole("button", { name: "Load more" }));
    expect(await within(history).findByText("Avery Founder created the task")).toBeInTheDocument();
    expect(within(history).getByText("3 d ago")).toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("shows story points on Scrum projects only", async () => {
    const scrumBoard = { ...KANBAN_BOARD, project: { id: "p-atlas", key: "ATLAS", name: "Atlas app", methodology: "scrum" } };
    mockApi({ "GET /api/v1/projects/p-atlas/board": () => json(server)(undefined), "PATCH /api/v1/issues/i2": json(issueDetail(card2 as Parameters<typeof issueDetail>[0], { storyPoints: 3, version: 2 }), 200) }, SCRUM, scrumBoard);
    navigation.params = { slug: "northstar-labs", key: "ATLAS" };
    navigation.pathname = "/w/northstar-labs/p/ATLAS";
    render(<WorkspaceLayout><ProjectLayout><ProjectBoardPage /></ProjectLayout></WorkspaceLayout>);
    await userEvent.click(await screen.findByRole("button", { name: /^OPS-2:/ }));
    const drawer = await screen.findByRole("dialog", { name: "OPS-2" });
    const points = await within(drawer).findByLabelText("Story points");
    await userEvent.type(points, "100.5");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    expect(within(drawer).getByText("Use a number from 0 to 100 with at most two decimals.")).toBeInTheDocument();
    await userEvent.clear(points);
    await userEvent.type(points, "3");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests("PATCH")).toHaveLength(1));
    expect(requests("PATCH")[0].body).toEqual({ storyPoints: 3 });
    expect(within(drawer).queryByLabelText("Phase")).not.toBeInTheDocument();
  });
});

describe("task deep link", () => {
  it("opens the task named in ?issue= and drops the parameter on close", async () => {
    mockApi();
    navigation.search = "?issue=OPS-2";
    window.history.replaceState(null, "", "/w/northstar-labs/p/OPS?issue=OPS-2");
    await renderBoard();
    const drawer = await screen.findByRole("dialog", { name: "OPS-2" });
    expect(await within(drawer).findByDisplayValue("Order new laptops")).toBeInTheDocument();
    expect(requests("GET /api/v1/issues/i2")).not.toHaveLength(0);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/w/northstar-labs/p/OPS");
    expect(window.location.search).toBe("");
  });

  it("says when the linked task no longer exists", async () => {
    mockApi();
    navigation.search = "?issue=OPS-404";
    window.history.replaceState(null, "", "/w/northstar-labs/p/OPS?issue=OPS-404");
    await renderBoard();
    expect(await screen.findByText("That task no longer exists.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(window.location.search).toBe("");
    expect((KANBAN_BOARD as BoardState).issues).toHaveLength(7);
  });
});
