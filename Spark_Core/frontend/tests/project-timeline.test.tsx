import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CATALOG } from "./methodology-catalog";
import { KANBAN, LIST, WATERFALL } from "./project-fixtures";

const navigation = { params: { slug: "northstar-labs", key: "WEB" } as Record<string, string>, pathname: "/w/northstar-labs/p/WEB/timeline" };
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
import ProjectLayout from "../src/app/w/[slug]/p/[key]/layout";
import ProjectTimelinePage from "../src/app/w/[slug]/p/[key]/timeline/page";

const workspace = (role: string) => ({ id: "w1", slug: "northstar-labs", name: "Northstar Labs", role, memberCount: 3, version: 2, createdAt: "2026-10-18T10:00:00.000Z" });

const phase = (id: string, position: number, name: string, plannedStart: string, plannedEnd: string, baseline: [string, string] | null) => ({
  id,
  name,
  position,
  plannedStart,
  plannedEnd,
  baselineStart: baseline?.[0] ?? null,
  baselineEnd: baseline?.[1] ?? null,
  status: "not_started",
});

const milestone = (id: string, name: string, phaseId: string | null, dueDate: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  phaseId,
  dueDate,
  baselineDueDate: dueDate,
  completedAt: null as string | null,
  version: 1,
  ...extra,
});

// The project runs Nov 2 – Dec 11, 2026 (40 days); "today" is Nov 20.
const PLAN = {
  phases: [
    phase("ph1", 0, "Requirements", "2026-11-02", "2026-11-09", ["2026-11-02", "2026-11-09"]),
    phase("ph2", 1, "Design", "2026-11-10", "2026-11-23", ["2026-11-10", "2026-11-17"]),
    phase("ph3", 2, "Build", "2026-11-24", "2026-11-30", ["2026-11-18", "2026-12-08"]),
    // Added after the last re-baseline: no baseline yet.
    phase("ph4", 3, "Test", "2026-12-01", "2026-12-05", null),
    phase("ph5", 4, "Deploy", "2026-12-06", "2026-12-11", ["2026-11-25", "2026-11-30"]),
  ],
  milestones: [
    milestone("ms1", "Requirements sign-off", "ph1", "2026-11-09", { completedAt: "2026-11-09T15:00:00.000Z" }),
    milestone("ms2", "Design review", "ph2", "2026-11-23", { baselineDueDate: "2026-11-17", version: 3 }),
    milestone("ms3", "Build demo", "ph3", "2026-11-18"),
    // From an earlier Kanban period: before the project start, without a phase.
    milestone("ms4", "Legacy kickoff", null, "2026-09-15", { baselineDueDate: null }),
  ],
  baselinedAt: "2026-10-18T10:00:00.000Z",
  version: 3,
};

const card = (id: string, number: number, statusId: string, phaseId: string | null) => ({
  id,
  number,
  key: `WEB-${number}`,
  title: `Task ${number}`,
  type: "task",
  priority: "medium",
  statusId,
  assignee: null,
  storyPoints: null,
  dueDate: null,
  phaseId,
  sprintId: null,
  version: 1,
  completedAt: null,
  createdAt: "2026-10-19T09:00:00.000Z",
});

const BOARD = {
  project: { id: "p-web", key: "WEB", name: "Website relaunch", methodology: "waterfall" },
  statuses: [
    { id: "w1", name: "Not started", category: "todo", position: 0, wipLimit: null, count: 4 },
    { id: "w2", name: "In progress", category: "in_progress", position: 1, wipLimit: null, count: 2 },
    { id: "w4", name: "Done", category: "done", position: 3, wipLimit: null, count: 3 },
  ],
  issues: [
    card("i1", 1, "w4", "ph1"),
    card("i2", 2, "w4", "ph1"),
    card("i3", 3, "w4", "ph2"),
    card("i4", 4, "w2", "ph2"),
    card("i5", 5, "w1", "ph2"),
    card("i6", 6, "w1", "ph2"),
    card("i7", 7, "w1", null),
    card("i8", 8, "w2", null),
    card("i9", 9, "w1", null),
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

const PLAN_KEY = "GET /api/v1/projects/p-web/plan";
const PUT_PHASES = "PUT /api/v1/projects/p-web/phases";
const POST_BASELINE = "POST /api/v1/projects/p-web/baseline";
const POST_MILESTONE = "POST /api/v1/projects/p-web/milestones";

function mockApi({ routes: extra = {}, role = "owner", project = WATERFALL as { key: string } }: { routes?: Record<string, Handler>; role?: string; project?: { key: string; [field: string]: unknown } } = {}) {
  calls = [];
  const routes: Record<string, Handler> = {
    "GET /api/v1/workspaces/by-slug/northstar-labs": json(workspace(role)),
    "GET /api/v1/workspaces/w1/projects": json({ items: LIST }),
    "GET /api/v1/methodologies": json({ items: CATALOG }),
    [`GET /api/v1/workspaces/w1/projects/by-key/${project.key}`]: json(project, 200, { ETag: "\"v3\"" }),
    [PLAN_KEY]: json(PLAN, 200, { ETag: "\"v3\"" }),
    "GET /api/v1/projects/p-web/board": json(BOARD),
    ...extra,
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined, ifMatch: new Headers(init?.headers).get("If-Match") });
    const handler = routes[key];
    return handler ? handler(init) : new Response(JSON.stringify({ code: "not_found", detail: "Not found." }), { status: 404 });
  }));
}

function renderTimeline(key = "WEB") {
  navigation.params = { slug: "northstar-labs", key };
  navigation.pathname = `/w/northstar-labs/p/${key}/timeline`;
  render(<WorkspaceLayout><ProjectLayout><ProjectTimelinePage /></ProjectLayout></WorkspaceLayout>);
}

const gantt = () => screen.findByRole("region", { name: "Phases and milestones" });
const row = (phaseId: string) => document.querySelector<HTMLElement>(`[data-phase-id="${phaseId}"]`)!;
const requests = (prefix: string) => calls.filter((call) => call.key.startsWith(prefix));
const liveRegion = () => document.querySelector("[aria-live=\"polite\"]") as HTMLElement;

beforeEach(() => {
  window.localStorage.clear();
  auth.user = OWNER;
  // Only Date is faked, so timers and user-event keep running.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 20, 12, 0, 0));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("waterfall timeline", () => {
  it("draws each phase with its baseline ghost, progress fill and variance badge", async () => {
    mockApi();
    renderTimeline();
    const chart = await gantt();
    // Progress arrives with the board.
    await within(chart).findByText(/1\/4 done/u);

    // Six days late: planned end Nov 23 against a baseline end of Nov 17.
    expect(within(row("ph2")).getByText("+6 d")).toBeInTheDocument();
    expect(within(row("ph2")).getByText("6 days behind baseline")).toBeInTheDocument();
    expect(within(row("ph2")).getByText("+6 d").closest(".wsTimelineVariance")).toHaveAttribute("data-tone", "late");
    expect(within(row("ph1")).getByText("on baseline").closest(".wsTimelineVariance")).toHaveAttribute("data-tone", "on");
    expect(within(row("ph3")).getByText("−8 d").closest(".wsTimelineVariance")).toHaveAttribute("data-tone", "ahead");
    expect(within(row("ph5")).getByText("+11 d").closest(".wsTimelineVariance")).toHaveAttribute("data-tone", "very-late");
    // A phase added after the last re-baseline has no ghost bar and no variance.
    expect(within(row("ph4")).getByText("no baseline")).toBeInTheDocument();
    expect(within(row("ph4")).queryByTestId("phase-baseline")).not.toBeInTheDocument();
    expect(within(chart).getAllByTestId("phase-baseline")).toHaveLength(4);

    // Day columns from the project start (Nov 2 = column 1).
    expect(within(row("ph2")).getByTestId("phase-bar").style.gridColumn).toBe("9 / 23");
    expect(within(row("ph2")).getByTestId("phase-baseline").style.gridColumn).toBe("9 / 17");
    // Progress: done tasks ÷ tasks in the phase.
    expect(within(row("ph1")).getByText(/2\/2 done/u)).toBeInTheDocument();
    expect(within(row("ph1")).getByTestId("phase-fill").style.width).toBe("100%");
    expect(within(row("ph2")).getByTestId("phase-fill").style.width).toBe("25%");
    expect(within(row("ph4")).getByText(/No tasks/u)).toBeInTheDocument();
    expect(within(row("ph4")).getByTestId("phase-fill").style.width).toBe("0%");

    expect(within(chart).getByText("Nov 2, 2026 – Dec 11, 2026 · Baseline from Oct 18, 2026")).toBeInTheDocument();
    expect(document.querySelector(".wsTimelineToday")).toBeInTheDocument();

    const tabs = screen.getByRole("navigation", { name: "Project views" });
    expect(within(tabs).getByRole("link", { name: "Timeline" })).toHaveAttribute("aria-current", "page");
  });

  it("places milestone diamonds on their due days, marks done and overdue ones, and clamps outside dates to the edge", async () => {
    mockApi();
    renderTimeline();
    const chart = await gantt();

    const done = within(chart).getByRole("img", { name: "Milestone Requirements sign-off, due Nov 9, 2026, completed" });
    expect(done.style.gridColumn).toBe("8 / span 1");
    expect(done).toHaveAttribute("data-done");
    const review = within(chart).getByRole("img", { name: "Milestone Design review, due Nov 23, 2026" });
    expect(review.style.gridColumn).toBe("22 / span 1");
    expect(review).not.toHaveAttribute("data-overdue");
    expect(row("ph2")).toContainElement(review);
    const overdue = within(chart).getByRole("img", { name: "Milestone Build demo, due Nov 18, 2026, overdue" });
    expect(overdue).toHaveAttribute("data-overdue");
    expect(overdue.style.gridColumn).toBe("17 / span 1");
    // Before the project start and without a phase: its own row, at the left edge.
    const legacy = within(chart).getByRole("img", { name: "Milestone Legacy kickoff, due Sep 15, 2026, overdue, outside the project dates" });
    expect(legacy.style.gridColumn).toBe("1 / span 1");
    expect(legacy).toHaveAttribute("data-edge", "start");
    expect(within(chart).getByText("Other milestones")).toBeInTheDocument();

    // The text alternative lists every phase and milestone.
    const phases = screen.getByRole("table", { name: "Phases" });
    const design = within(phases).getByRole("row", { name: /^Design/u });
    expect(within(design).getByText("Nov 10 – Nov 23")).toBeInTheDocument();
    expect(within(design).getByText("Nov 10 – Nov 17")).toBeInTheDocument();
    expect(within(design).getByText("+6 d")).toBeInTheDocument();
    expect(within(design).getByText("1/4 done")).toBeInTheDocument();
    expect(within(within(phases).getByRole("row", { name: /^Test/u })).getByText("No baseline")).toBeInTheDocument();

    const milestones = screen.getByRole("table", { name: "Milestones" });
    expect(within(milestones).getAllByRole("row")).toHaveLength(5);
    const legacyRow = within(milestones).getByRole("row", { name: /^Legacy kickoff/u });
    expect(within(legacyRow).getByText("Outside the project dates")).toBeInTheDocument();
    expect(within(legacyRow).getByText("Overdue")).toBeInTheDocument();
    expect(within(within(milestones).getByRole("row", { name: /^Requirements sign-off/u })).getByText("Done")).toBeInTheDocument();
    expect(within(within(milestones).getByRole("row", { name: /^Design review/u })).getByText("Nov 17, 2026")).toBeInTheDocument();
  });

  it("links the unphased count to the board filtered to unphased tasks", async () => {
    mockApi();
    renderTimeline();
    const link = await screen.findByRole("link", { name: /^Unphased 3/u });
    expect(link).toHaveAttribute("href", "/w/northstar-labs/p/WEB?phase=none");
    expect(link).toHaveAccessibleName("Unphased 3 tasks — show them on the board");
  });

  it("saves the phase plan with PUT and If-Match, keeping phase ids", async () => {
    const saved = { ...PLAN, version: 4, phases: PLAN.phases.map((item) => (item.id === "ph2" ? { ...item, name: "UX design" } : item)) };
    mockApi({ routes: { [PUT_PHASES]: json(saved, 200, { ETag: "\"v4\"" }) } });
    renderTimeline();
    await userEvent.click(await screen.findByRole("button", { name: "Edit phases" }));
    const dialog = screen.getByRole("dialog", { name: "Edit phases" });
    const name = within(dialog).getByLabelText("Phase 2 name");
    await userEvent.clear(name);
    await userEvent.type(name, "UX design");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save phases" }));

    await waitFor(() => expect(requests("PUT")).toHaveLength(1));
    const call = requests("PUT")[0];
    expect(call.ifMatch).toBe("\"v3\"");
    expect(call.body).toEqual({
      phases: [
        { id: "ph1", name: "Requirements", plannedStart: "2026-11-02", plannedEnd: "2026-11-09" },
        { id: "ph2", name: "UX design", plannedStart: "2026-11-10", plannedEnd: "2026-11-23" },
        { id: "ph3", name: "Build", plannedStart: "2026-11-24", plannedEnd: "2026-11-30" },
        { id: "ph4", name: "Test", plannedStart: "2026-12-01", plannedEnd: "2026-12-05" },
        { id: "ph5", name: "Deploy", plannedStart: "2026-12-06", plannedEnd: "2026-12-11" },
      ],
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(within(row("ph2")).getByText("UX design")).toBeInTheDocument();
    expect(liveRegion()).toHaveTextContent("Phases saved.");
  });

  it("adds a phase without an id after the last one", async () => {
    const lastShorter = { ...PLAN, phases: PLAN.phases.map((item) => (item.id === "ph5" ? { ...item, plannedEnd: "2026-12-08" } : item)) };
    mockApi({ routes: { [PLAN_KEY]: json(lastShorter), [PUT_PHASES]: json({ ...lastShorter, version: 4 }) } });
    renderTimeline();
    await userEvent.click(await screen.findByRole("button", { name: "Edit phases" }));
    const dialog = screen.getByRole("dialog", { name: "Edit phases" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Add phase" }));
    expect(within(dialog).getByLabelText("Phase 6 name")).toHaveValue("Phase 6");
    expect(within(dialog).getByLabelText("Phase 6 start")).toHaveValue("2026-12-09");
    expect(within(dialog).getByLabelText("Phase 6 end")).toHaveValue("2026-12-11");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save phases" }));
    await waitFor(() => expect(requests("PUT")).toHaveLength(1));
    expect((requests("PUT")[0].body as { phases: unknown[] }).phases.at(-1)).toEqual({ name: "Phase 6", plannedStart: "2026-12-09", plannedEnd: "2026-12-11" });
  });

  it("checks the M2 phase rules before sending and explains a removed phase that is still in use", async () => {
    mockApi({ routes: { [PUT_PHASES]: problem(400, "invalid_input", "Invalid phase.") } });
    renderTimeline();
    await userEvent.click(await screen.findByRole("button", { name: "Edit phases" }));
    const dialog = screen.getByRole("dialog", { name: "Edit phases" });
    // Overlapping the previous phase.
    const start = within(dialog).getByLabelText("Phase 2 start");
    fireEvent.change(start, { target: { value: "2026-11-05" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save phases" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Each phase needs a name and dates inside the project dates, in order and without overlapping.");
    expect(requests("PUT")).toHaveLength(0);

    fireEvent.change(start, { target: { value: "2026-11-10" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove phase 1" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save phases" }));
    await waitFor(() => expect(requests("PUT")).toHaveLength(1));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("A phase you removed still has tasks or milestones. Move them to another phase first, or keep the phase.");
    expect((requests("PUT")[0].body as { phases: Array<{ id?: string }> }).phases.map((item) => item.id)).toEqual(["ph2", "ph3", "ph4", "ph5"]);
  });

  it("shows a teammate's newer plan on 412 and saves next with its version", async () => {
    const newer = { ...PLAN, version: 7, phases: PLAN.phases.map((item) => (item.id === "ph1" ? { ...item, name: "Discovery" } : item)) };
    let puts = 0;
    mockApi({
      routes: {
        [PUT_PHASES]: (init) => {
          puts += 1;
          return puts === 1
            ? problem(412, "version_mismatch", "The resource changed since you loaded it.", { current: newer })(init)
            : json({ ...newer, version: 8 })(init);
        },
      },
    });
    renderTimeline();
    await userEvent.click(await screen.findByRole("button", { name: "Edit phases" }));
    const dialog = screen.getByRole("dialog", { name: "Edit phases" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save phases" }));

    expect(await within(dialog).findByText("Updated by a teammate — review the latest values and save again.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Phase 1 name")).toHaveValue("Discovery");
    // The chart behind the dialog shows the newer plan too.
    expect(within(row("ph1")).getByText("Discovery")).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "Save phases" }));
    await waitFor(() => expect(requests("PUT")).toHaveLength(2));
    expect(requests("PUT")[0].ifMatch).toBe("\"v3\"");
    expect(requests("PUT")[1].ifMatch).toBe("\"v7\"");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("requires a reason to re-baseline and sends it with If-Match", async () => {
    const rebaselined = {
      ...PLAN,
      version: 4,
      baselinedAt: "2026-11-20T11:00:00.000Z",
      phases: PLAN.phases.map((item) => ({ ...item, baselineStart: item.plannedStart, baselineEnd: item.plannedEnd })),
    };
    mockApi({ routes: { [POST_BASELINE]: json(rebaselined) } });
    renderTimeline();
    await userEvent.click(await screen.findByRole("button", { name: "Re-baseline" }));
    const dialog = screen.getByRole("dialog", { name: "Re-baseline the plan?" });
    expect(dialog).toHaveAccessibleDescription(/5 phases and 4 milestones become the new baseline/u);
    await userEvent.click(within(dialog).getByRole("button", { name: "Re-baseline" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Give a reason for the new baseline.");
    await userEvent.type(within(dialog).getByLabelText("Reason"), "   ");
    await userEvent.click(within(dialog).getByRole("button", { name: "Re-baseline" }));
    expect(requests("POST /api/v1/projects/p-web/baseline")).toHaveLength(0);

    await userEvent.type(within(dialog).getByLabelText("Reason"), "Scope change approved");
    await userEvent.click(within(dialog).getByRole("button", { name: "Re-baseline" }));
    await waitFor(() => expect(requests(POST_BASELINE)).toHaveLength(1));
    expect(requests(POST_BASELINE)[0]).toMatchObject({ body: { reason: "Scope change approved" }, ifMatch: "\"v3\"" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(within(row("ph2")).getByText("on baseline")).toBeInTheDocument();
    expect(within(row("ph4")).getByText("on baseline")).toBeInTheDocument();
    expect(screen.getByText(/Baseline from Nov 20, 2026/u)).toBeInTheDocument();
    expect(liveRegion()).toHaveTextContent("New baseline saved.");
  });

  it("adds a milestone and completes one with If-Match", async () => {
    const created = milestone("ms9", "Launch", "ph5", "2026-12-11", { baselineDueDate: null });
    const completed = { ...PLAN.milestones[1], completedAt: "2026-11-20T11:00:00.000Z", version: 4 };
    mockApi({
      routes: {
        [POST_MILESTONE]: json(created, 201, { ETag: "\"v1\"" }),
        "PATCH /api/v1/milestones/ms2": json(completed),
      },
    });
    renderTimeline();
    await userEvent.click(await screen.findByRole("button", { name: "Add milestone" }));
    const dialog = screen.getByRole("dialog", { name: "Add milestone" });
    await userEvent.type(within(dialog).getByLabelText("Milestone name"), "Launch");
    // Outside the project dates.
    fireEvent.change(within(dialog).getByLabelText("Due date"), { target: { value: "2026-12-20" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Add milestone" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Pick a due date between Nov 2, 2026 and Dec 11, 2026.");
    expect(requests("POST")).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText("Due date"), { target: { value: "2026-12-11" } });
    await userEvent.selectOptions(within(dialog).getByLabelText("Phase"), "Deploy");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add milestone" }));
    await waitFor(() => expect(requests(POST_MILESTONE)).toHaveLength(1));
    expect(requests(POST_MILESTONE)[0].body).toEqual({ name: "Launch", dueDate: "2026-12-11", phaseId: "ph5" });
    expect(await screen.findByRole("img", { name: "Milestone Launch, due Dec 11, 2026" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Mark Design review complete" }));
    await waitFor(() => expect(requests("PATCH")).toHaveLength(1));
    expect(requests("PATCH")[0]).toEqual({ key: "PATCH /api/v1/milestones/ms2", body: { completed: true }, ifMatch: "\"v3\"" });
    expect(await screen.findByRole("img", { name: "Milestone Design review, due Nov 23, 2026, completed" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reopen Design review" })).toHaveFocus();
  });

  it("edits a milestone with only the changed fields and refreshes it on 412", async () => {
    const newer = { ...PLAN.milestones[1], name: "Design review (moved)", version: 5 };
    mockApi({ routes: { "PATCH /api/v1/milestones/ms2": problem(412, "version_mismatch", "The resource changed since you loaded it.", { current: newer }) } });
    renderTimeline();
    await userEvent.click(await screen.findByRole("button", { name: "Edit Design review" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Design review" });
    fireEvent.change(within(dialog).getByLabelText("Due date"), { target: { value: "2026-11-24" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save milestone" }));
    await waitFor(() => expect(requests("PATCH")).toHaveLength(1));
    expect(requests("PATCH")[0]).toEqual({ key: "PATCH /api/v1/milestones/ms2", body: { dueDate: "2026-11-24" }, ifMatch: "\"v3\"" });
    expect(await within(dialog).findByText("Updated by a teammate — review the milestone and save again.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Milestone name")).toHaveValue("Design review (moved)");
  });

  it("shows a plain member the plan read-only with the authority message", async () => {
    auth.user = MEMBER;
    mockApi({ role: "member" });
    renderTimeline();
    await gantt();
    expect(await screen.findByText("Only owners, admins and the project lead can change the plan.")).toBeInTheDocument();
    for (const name of ["Edit phases", "Add milestone", "Re-baseline", "Edit Design review", "Mark Design review complete"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(screen.getByRole("table", { name: "Milestones" })).toBeInTheDocument();
    expect(within(row("ph2")).getByText("+6 d")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /^Unphased 3/u })).toBeInTheDocument();
    expect(calls.filter((call) => call.key.split(" ")[0] !== "GET")).toHaveLength(0);
  });

  it("gives the project lead the planner controls", async () => {
    auth.user = MEMBER;
    mockApi({ role: "member", project: { ...WATERFALL, lead: { id: MEMBER.id, displayName: MEMBER.displayName } } });
    renderTimeline();
    expect(await screen.findByRole("button", { name: "Edit phases" })).toBeInTheDocument();
    expect(screen.queryByText("Only owners, admins and the project lead can change the plan.")).not.toBeInTheDocument();
  });

  it("keeps progress unknown while the board loads and offers a retry when it fails", async () => {
    let boardFails = true;
    mockApi({ routes: { "GET /api/v1/projects/p-web/board": (init) => (boardFails ? problem(500, "internal", "Boom")(init) : json(BOARD)(init)) } });
    renderTimeline();
    const chart = await gantt();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Progress couldn't load.");
    // No fake 0% fills and no fake counts.
    expect(within(chart).queryAllByTestId("phase-fill")).toHaveLength(0);
    expect(within(chart).queryByText(/\d+\/\d+ done|No tasks/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Unphased/u })).not.toBeInTheDocument();
    expect(screen.getByText("Unphased").closest(".wsTimelineUnphased")).toHaveTextContent("Unphased —");

    boardFails = false;
    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: /^Unphased 3/u })).toBeInTheDocument();
    expect(within(row("ph2")).getByTestId("phase-fill").style.width).toBe("25%");
    expect(screen.queryByText("Progress couldn't load.")).not.toBeInTheDocument();
  });

  it("shows an unphased count of 0 as text, not a link", async () => {
    mockApi({ routes: { "GET /api/v1/projects/p-web/board": json({ ...BOARD, issues: BOARD.issues.filter((issue) => issue.phaseId !== null) }) } });
    renderTimeline();
    await within(await gantt()).findAllByText(/2\/2 done/u);
    expect(screen.getByText("Unphased").closest(".wsTimelineUnphased")).toHaveTextContent("Unphased 0");
    expect(screen.queryByRole("link", { name: /^Unphased/u })).not.toBeInTheDocument();
  });

  it("clamps a milestone after the target date to the right edge", async () => {
    mockApi({ routes: { [PLAN_KEY]: json({ ...PLAN, milestones: [milestone("ms8", "Late handover", null, "2027-01-10")] }) } });
    renderTimeline();
    const late = await within(await gantt()).findByRole("img", { name: "Milestone Late handover, due Jan 10, 2027, outside the project dates" });
    expect(late.style.gridColumn).toBe("40 / span 1");
    expect(late).toHaveAttribute("data-edge", "end");
  });

  it("maps the phase plan's input errors to inline messages", async () => {
    let detail = "Invalid project phases.";
    mockApi({ routes: { [PUT_PHASES]: (init) => problem(400, "invalid_input", detail)(init) } });
    renderTimeline();
    await userEvent.click(await screen.findByRole("button", { name: "Edit phases" }));
    const dialog = screen.getByRole("dialog", { name: "Edit phases" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save phases" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Each phase needs a name and dates inside the project dates, in order and without overlapping.");
    expect(within(dialog).getByLabelText("Phase 1 name")).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).getByLabelText("Phase 1 start")).toHaveAttribute("aria-invalid", "true");

    detail = "Invalid project dates.";
    await userEvent.click(within(dialog).getByRole("button", { name: "Save phases" }));
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("Set the project's start and target dates in Settings before planning phases."));
    expect(requests("PUT")).toHaveLength(2);
  });

  it("moves focus to a remaining phase after removing one", async () => {
    mockApi();
    renderTimeline();
    await userEvent.click(await screen.findByRole("button", { name: "Edit phases" }));
    const dialog = screen.getByRole("dialog", { name: "Edit phases" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove phase 5" }));
    expect(within(dialog).getByLabelText("Phase 4 name")).toHaveFocus();
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove phase 1" }));
    expect(within(dialog).getByLabelText("Phase 1 name")).toHaveValue("Design");
    expect(within(dialog).getByLabelText("Phase 1 name")).toHaveFocus();
  });

  it("maps a refused milestone date and a refused baseline reason to inline messages", async () => {
    mockApi({
      routes: {
        [POST_MILESTONE]: problem(400, "invalid_input", "Invalid milestone."),
        [POST_BASELINE]: problem(400, "invalid_input", "Invalid baseline reason."),
      },
    });
    renderTimeline();
    await userEvent.click(await screen.findByRole("button", { name: "Add milestone" }));
    let dialog = screen.getByRole("dialog", { name: "Add milestone" });
    await userEvent.type(within(dialog).getByLabelText("Milestone name"), "Launch");
    fireEvent.change(within(dialog).getByLabelText("Due date"), { target: { value: "2026-12-01" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Add milestone" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Pick a due date between Nov 2, 2026 and Dec 11, 2026.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await userEvent.click(screen.getByRole("button", { name: "Re-baseline" }));
    dialog = screen.getByRole("dialog", { name: "Re-baseline the plan?" });
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Scope change");
    await userEvent.click(within(dialog).getByRole("button", { name: "Re-baseline" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Give a reason of 1 to 200 characters.");
  });

  it("refreshes the plan on a re-baseline 412 and confirms with the new version", async () => {
    const newer = { ...PLAN, version: 6, phases: PLAN.phases.map((item) => (item.id === "ph1" ? { ...item, name: "Discovery" } : item)) };
    let posts = 0;
    mockApi({
      routes: {
        [POST_BASELINE]: (init) => {
          posts += 1;
          return posts === 1 ? problem(412, "version_mismatch", "The resource changed since you loaded it.", { current: newer })(init) : json({ ...newer, version: 7 })(init);
        },
      },
    });
    renderTimeline();
    await userEvent.click(await screen.findByRole("button", { name: "Re-baseline" }));
    const dialog = screen.getByRole("dialog", { name: "Re-baseline the plan?" });
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Scope change");
    await userEvent.click(within(dialog).getByRole("button", { name: "Re-baseline" }));
    expect(await within(dialog).findByText("Updated by a teammate — the plan was refreshed. Review it and confirm again.")).toBeInTheDocument();
    expect(within(row("ph1")).getByText("Discovery")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Re-baseline" }));
    await waitFor(() => expect(requests(POST_BASELINE)).toHaveLength(2));
    expect(requests(POST_BASELINE).map((call) => call.ifMatch)).toEqual(["\"v3\"", "\"v6\""]);
  });

  it("shows a teammate's newer milestone on the page after an edit 412", async () => {
    const newer = { ...PLAN.milestones[1], name: "Design review (moved)", version: 5 };
    mockApi({ routes: { "PATCH /api/v1/milestones/ms2": problem(412, "version_mismatch", "The resource changed since you loaded it.", { current: newer }) } });
    renderTimeline();
    await userEvent.click(await screen.findByRole("button", { name: "Edit Design review" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Design review" });
    fireEvent.change(within(dialog).getByLabelText("Due date"), { target: { value: "2026-11-24" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save milestone" }));
    await within(dialog).findByText("Updated by a teammate — review the milestone and save again.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(within(screen.getByRole("table", { name: "Milestones" })).getByRole("row", { name: /^Design review \(moved\)/u })).toBeInTheDocument();
  });

  it("keeps the Waterfall period's plan as read-only history after a switch, with milestones still editable", async () => {
    const switched = { ...KANBAN, startDate: null, targetDate: null, phases: WATERFALL.phases, milestones: WATERFALL.milestones };
    const created = milestone("ms9", "Retro", null, "2026-12-20", { baselineDueDate: null });
    mockApi({
      project: switched,
      routes: {
        "GET /api/v1/projects/p-ops/plan": json(PLAN),
        "GET /api/v1/projects/p-ops/board": json({ ...BOARD, project: { id: "p-ops", key: "OPS", name: "Ops desk", methodology: "kanban" } }),
        "POST /api/v1/projects/p-ops/milestones": json(created, 201),
      },
    });
    renderTimeline("OPS");
    const chart = await gantt();
    const tabs = screen.getByRole("navigation", { name: "Project views" });
    expect(within(tabs).getByRole("link", { name: "Timeline" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Plan from the Waterfall period. Phases are kept as history and can't change; milestones stay editable.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit phases" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Re-baseline" })).not.toBeInTheDocument();
    expect(screen.queryByText("Unphased")).not.toBeInTheDocument();
    expect(within(chart).getByRole("img", { name: /^Milestone Design review/u })).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Mark Design review complete" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add milestone" }));
    const dialog = screen.getByRole("dialog", { name: "Add milestone" });
    await userEvent.type(within(dialog).getByLabelText("Milestone name"), "Retro");
    fireEvent.change(within(dialog).getByLabelText("Due date"), { target: { value: "2026-12-20" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Add milestone" }));
    await waitFor(() => expect(requests("POST /api/v1/projects/p-ops/milestones")).toHaveLength(1));
    expect(requests("PUT")).toHaveLength(0);
  });

  it("lists the Timeline tab for Waterfall projects and for others only while they keep a plan", async () => {
    mockApi({ project: { ...KANBAN, milestones: [WATERFALL.milestones[0]] } });
    renderTimeline("OPS");
    const tabs = await screen.findByRole("navigation", { name: "Project views" });
    expect(within(tabs).getAllByRole("link").map((link) => link.textContent)).toEqual(["Board", "Timeline", "Overview", "Insights", "Settings"]);
  });

  it("leaves the Timeline tab out for a project without a plan", async () => {
    mockApi({ project: KANBAN });
    renderTimeline("OPS");
    const tabs = await screen.findByRole("navigation", { name: "Project views" });
    expect(within(tabs).getAllByRole("link").map((link) => link.textContent)).toEqual(["Board", "Overview", "Insights", "Settings"]);
  });

  it("points other methodologies to the board", async () => {
    mockApi({ project: KANBAN });
    renderTimeline("OPS");
    expect(await screen.findByRole("heading", { name: "The timeline is for Waterfall projects" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the board" })).toHaveAttribute("href", "/w/northstar-labs/p/OPS");
    expect(requests("GET /api/v1/projects/p-ops/plan")).toHaveLength(0);
  });
});
