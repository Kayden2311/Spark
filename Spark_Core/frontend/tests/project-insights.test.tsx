import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CATALOG } from "./methodology-catalog";
import { LIST, SCRUM, WATERFALL } from "./project-fixtures";

const navigation = { params: { slug: "northstar-labs", key: "ATLAS" } as Record<string, string> };
const auth = {
  isAuthenticated: true,
  isLoading: false,
  platformRoles: [] as string[],
  user: { id: "u-casey", displayName: "Casey Member", email: "casey@example.com", avatarUrl: null },
  workspaces: [{ workspaceId: "w1", workspaceName: "Northstar Labs", workspaceSlug: "northstar-labs", role: "member" }],
  logout: vi.fn(),
  refreshSession: vi.fn(async () => {}),
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => `/w/northstar-labs/p/${navigation.params.key}/insights`,
  useSearchParams: () => new URLSearchParams(window.location.search),
  useParams: () => navigation.params,
}));
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));

import WorkspaceLayout from "../src/app/w/[slug]/layout";
import ProjectLayout from "../src/app/w/[slug]/p/[key]/layout";
import ProjectInsightsPage from "../src/app/w/[slug]/p/[key]/insights/page";
import { burndownSubtitle } from "../src/app/w/[slug]/p/[key]/insights/scrum-section";

const workspace = { id: "w1", slug: "northstar-labs", name: "Northstar Labs", role: "member", memberCount: 3, version: 2, createdAt: "2026-10-18T10:00:00.000Z" };
const members = [
  { userId: "u-avery", displayName: "Avery Founder", avatarUrl: null, email: null, role: "owner", joinedAt: "2026-10-01T10:00:00.000Z" },
  { userId: "u-casey", displayName: "Casey Member", avatarUrl: null, email: null, role: "member", joinedAt: "2026-10-10T10:00:00.000Z" },
];

const PERIODS = [
  { id: "pk1", methodology: "kanban", startedAt: "2026-08-19T09:00:00.000Z", endedAt: "2026-10-18T09:00:00.000Z" },
  { id: "ps1", methodology: "scrum", startedAt: "2026-10-18T09:00:00.000Z", endedAt: null },
];

const avery = { id: "u-avery", displayName: "Avery Founder" };

const SUMMARY = {
  unit: "points",
  total: 30,
  done: 12,
  open: 18,
  donePercent: 40,
  plan: { kind: "sprint", label: "Sprint 4", start: "2026-10-19", end: "2026-11-01", planPercent: 55, status: "at_risk" },
  forecast: { ratePerDay: 0, date: null },
  overdue: {
    count: 2,
    items: [
      { issueId: "i4", key: "ATLAS-4", title: "Fix login redirect", dueDate: "2026-10-20", assignee: avery },
      { issueId: "i5", key: "ATLAS-5", title: "Write release notes", dueDate: "2026-10-22", assignee: null },
    ],
  },
  periods: PERIODS,
};

const MEMBERS = {
  range: { from: "2026-09-27", to: "2026-10-26" },
  items: [
    { user: avery, completed: 5, completedPoints: 13, onTimeRate: 80, open: 3, overdue: 1, medianCycleDays: 2.5 },
    { user: null, completed: 1, completedPoints: 0, onTimeRate: null, open: 4, overdue: 1, medianCycleDays: null },
  ],
};

const FLOW = {
  range: { from: "2026-09-27", to: "2026-10-26" },
  days: [
    { day: "2026-10-17", backlog: 6, todo: 4, inProgress: 2, done: 8, completed: 1, completedPoints: 3 },
    { day: "2026-10-18", backlog: 5, todo: 4, inProgress: 3, done: 9, completed: 1, completedPoints: 2 },
    { day: "2026-10-19", backlog: 5, todo: 3, inProgress: 3, done: 11, completed: 2, completedPoints: 5 },
  ],
  markers: [{ at: "2026-10-18T09:00:00.000Z", from: "kanban", to: "scrum" }],
};

const SPRINT = (id: string, name: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  goal: null,
  status,
  startsOn: "2026-10-05",
  endsOn: "2026-10-18",
  startedAt: "2026-10-05T09:00:00.000Z",
  completedAt: null,
  committedPoints: 20,
  committedCount: 8,
  completedPoints: null,
  completedCount: null,
  version: 2,
  ...extra,
});

const SPRINTS = {
  items: [
    SPRINT("sp3", "Sprint 3", "completed", { completedAt: "2026-10-18T17:00:00.000Z", completedPoints: 16, completedCount: 6 }),
    SPRINT("sp4", "Sprint 4", "active", { startsOn: "2026-10-19", endsOn: "2026-11-01", startedAt: "2026-10-19T09:00:00.000Z", committedPoints: 23 }),
    SPRINT("sp5", "Sprint 5", "planned", { startsOn: null, endsOn: null, startedAt: null, committedPoints: null, committedCount: null }),
  ],
};

const BURNDOWN = (sprint: ReturnType<typeof SPRINT>) => ({
  sprint,
  unit: "points",
  // The base is the committed work not done at the sprint's start: 6 points finished on day 1 still count in it.
  base: 20,
  days: [
    { day: "2026-10-19", ideal: 20, scope: 20, remaining: 14 },
    { day: "2026-10-20", ideal: 10, scope: 22, remaining: 15 },
    { day: "2026-10-21", ideal: 0, scope: null, remaining: null },
  ],
});

const VELOCITY = {
  period: PERIODS[1],
  unit: "points",
  sprints: [
    {
      id: "sp3",
      name: "Sprint 3",
      completedAt: "2026-10-18T17:00:00.000Z",
      committedPoints: 20,
      completedPoints: 16,
      committedCount: 8,
      completedCount: 6,
      reliability: 75,
      alreadyDone: 2,
      added: { count: 1, points: 3 },
      removed: 1,
      creepPercent: 16.7,
    },
  ],
  averageVelocity: 16,
};

const AGING = {
  items: [
    { issueId: "i8", key: "ATLAS-8", title: "Migrate billing", statusName: "In progress", assignee: avery, startedAt: "2026-10-01T09:00:00.000Z", ageDays: 25.2 },
    { issueId: "i9", key: "ATLAS-9", title: "Tidy styles", statusName: "In review", assignee: null, startedAt: "2026-10-24T09:00:00.000Z", ageDays: 2 },
  ],
  columns: [
    { statusId: "t1", name: "Backlog", category: "backlog", wipLimit: null, count: 5 },
    { statusId: "t3", name: "In progress", category: "in_progress", wipLimit: 3, count: 4 },
    { statusId: "t4", name: "In review", category: "in_progress", wipLimit: null, count: 1 },
    { statusId: "t5", name: "Done", category: "done", wipLimit: null, count: 11 },
  ],
  cycle: { p50: 3, p85: 9.5 },
};

const CYCLE = {
  range: { from: "2026-09-27", to: "2026-10-26" },
  points: [
    { issueId: "i1", key: "ATLAS-1", title: "Sign-up form", completedAt: "2026-10-10T12:00:00.000Z", cycleDays: 2.5, leadDays: 6 },
    { issueId: "i2", key: "ATLAS-2", title: "Billing page", completedAt: "2026-10-12T12:00:00.000Z", cycleDays: null, leadDays: 3.1 },
  ],
  cycle: { p50: 2.5, p85: 2.5 },
  lead: { p50: 4.6, p85: 5.6 },
  truncated: false,
};

const SCHEDULE = {
  period: { id: "pw1", methodology: "waterfall", startedAt: "2026-10-18T09:00:00.000Z", endedAt: null },
  phases: [
    { id: "ph1", name: "Requirements", plannedStart: "2026-11-02", plannedEnd: "2026-11-09", baselineStart: "2026-11-02", baselineEnd: "2026-11-09", varianceDays: 0, unit: "count", total: 4, done: 4, donePercent: 100, planPercent: 100, status: "on_track" },
    { id: "ph2", name: "Design", plannedStart: "2026-11-10", plannedEnd: "2026-11-23", baselineStart: "2026-11-10", baselineEnd: "2026-11-17", varianceDays: 6, unit: "count", total: 5, done: 1, donePercent: 20, planPercent: 60, status: "behind" },
  ],
  milestones: [
    { id: "ms1", name: "Requirements sign-off", phaseId: "ph1", dueDate: "2026-11-09", baselineDueDate: "2026-11-09", completedAt: "2026-11-08T10:00:00.000Z", state: "hit" },
    { id: "ms2", name: "Design sign-off", phaseId: "ph2", dueDate: "2026-10-20", baselineDueDate: "2026-10-20", completedAt: null, state: "missed" },
  ],
  counts: { hit: 1, missed: 1, atRisk: 0, upcoming: 0 },
  scheduleVarianceDays: 6,
};

type Handler = () => Response | Promise<Response>;
let calls: string[] = [];
const json = (payload: unknown, status = 200): Handler => () =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ETag: "\"v3\"" } });
const failure = (status = 500): Handler => () =>
  new Response(JSON.stringify({ code: "internal", detail: "The server could not load this." }), { status, headers: { "content-type": "application/problem+json" } });

/** Routes match on the full URL first, then on the path; the query string is recorded in `calls` for assertions. */
function mockApi(project: { id: string; key: string }, overrides: Record<string, Handler> = {}, periods = PERIODS) {
  calls = [];
  const p = `/api/v1/projects/${project.id}`;
  const routes: Record<string, Handler> = {
    "/api/v1/workspaces/by-slug/northstar-labs": json(workspace),
    "/api/v1/workspaces/w1/projects": json({ items: LIST }),
    "/api/v1/workspaces/w1/members": json({ items: members }),
    "/api/v1/methodologies": json({ items: CATALOG }),
    [`/api/v1/workspaces/w1/projects/by-key/${project.key}`]: json(project),
    [`${p}/plan`]: json({ phases: [], milestones: [], baselinedAt: null, periods, version: 3 }),
    [`${p}/insights/summary`]: json({ ...SUMMARY, periods }),
    [`${p}/insights/members`]: json(MEMBERS),
    [`${p}/insights/flow`]: json(FLOW),
    [`${p}/insights/cycle-time`]: json(CYCLE),
    [`${p}/insights/aging-wip`]: json(AGING),
    [`${p}/insights/velocity`]: json(VELOCITY),
    [`${p}/insights/schedule`]: json(SCHEDULE),
    [`${p}/sprints`]: json(SPRINTS),
    "/api/v1/sprints/sp4/burndown": json(BURNDOWN(SPRINTS.items[1]!)),
    "/api/v1/sprints/sp3/burndown": json(BURNDOWN(SPRINTS.items[0]!)),
    ...overrides,
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") !== "GET") throw new Error(`Unexpected write ${init?.method} ${url}`);
    calls.push(url);
    const handler = routes[url] ?? routes[url.split("?")[0]!];
    return handler ? handler() : new Response(JSON.stringify({ code: "project_not_found", detail: "Project does not exist." }), { status: 404 });
  }));
}

function renderInsights(key: string, search = "") {
  navigation.params = { slug: "northstar-labs", key };
  window.history.replaceState(null, "", `/w/northstar-labs/p/${key}/insights${search}`);
  render(<WorkspaceLayout><ProjectLayout><ProjectInsightsPage /></ProjectLayout></WorkspaceLayout>);
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("project insights", () => {
  it("shows the Insights tab to a plain member, right after Overview", async () => {
    mockApi(SCRUM);
    renderInsights("ATLAS");
    const tabs = await screen.findByRole("navigation", { name: "Project views" });
    const labels = within(tabs).getAllByRole("link").map((link) => link.textContent);
    expect(labels.indexOf("Insights")).toBe(labels.indexOf("Overview") + 1);
    expect(within(tabs).getByRole("link", { name: "Insights" })).toHaveAttribute("href", "/w/northstar-labs/p/ATLAS/insights");
    expect(within(tabs).getByRole("link", { name: "Insights" })).toHaveAttribute("aria-current", "page");
    expect(within(tabs).queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("fills the KPI strip from the summary", async () => {
    mockApi(SCRUM);
    renderInsights("ATLAS");
    const strip = await screen.findByRole("list", { name: "Key numbers" });
    await within(strip).findByText("40%");
    expect(within(strip).getByText("12 of 30 points")).toBeInTheDocument();
    expect(within(strip).getByText("55%")).toBeInTheDocument();
    expect(within(strip).getByText("Sprint 4")).toBeInTheDocument();
    expect(within(strip).getByText("At risk")).toHaveAttribute("data-status", "at_risk");
    expect(within(strip).getByText("No forecast yet")).toBeInTheDocument();
    expect(within(strip).getByText("2")).toBeInTheDocument();
    const progress = screen.getByRole("region", { name: "Plan vs done" });
    expect(within(progress).getByRole("meter", { name: "Done" })).toHaveAttribute("aria-valuenow", "40");
  });

  it("shows the Scrum section for a Scrum project: burndown of the active sprint and velocity with reliability", async () => {
    mockApi(SCRUM);
    renderInsights("ATLAS");
    const burndown = await screen.findByRole("region", { name: "Sprint burndown" });
    const picker = await within(burndown).findByRole("combobox", { name: "Sprint" });
    expect(picker).toHaveValue("sp4");
    expect(within(picker).getAllByRole("option").map((option) => option.textContent)).toEqual(["Sprint 4 (active)", "Sprint 3"]);
    await waitFor(() => expect(calls).toContain("/api/v1/sprints/sp4/burndown"));
    expect(await within(burndown).findByText("Ideal")).toBeInTheDocument();
    expect(within(burndown).getByText("Sprint 4: 20 points at the start, 3 already done · Oct 19 – Oct 21")).toBeInTheDocument();
    await userEvent.click(within(burndown).getByRole("button", { name: /table/iu }));
    const firstDay = within(burndown).getAllByRole("row")[1]!;
    expect(within(firstDay).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["20", "14", "20"]);

    const velocity = await screen.findByRole("region", { name: "Velocity" });
    expect(await within(velocity).findByText("Committed")).toBeInTheDocument();
    const reliability = await screen.findByRole("region", { name: "Commitment reliability" });
    expect(await within(reliability).findByText("75%")).toBeInTheDocument();
    expect(within(reliability).getByText("2 already done at start")).toBeInTheDocument();
    expect(within(reliability).getByText("+1 (3 pts)")).toBeInTheDocument();
    expect(within(reliability).getByText("16.7%")).toBeInTheDocument();

    expect(screen.getByRole("region", { name: "Cumulative flow" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Throughput" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "WIP vs limit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Aging work in progress" })).not.toBeInTheDocument();
    expect(calls.some((url) => url.includes("/insights/aging-wip"))).toBe(false);

    await userEvent.selectOptions(picker, "sp3");
    await waitFor(() => expect(calls).toContain("/api/v1/sprints/sp3/burndown"));
  });

  it("says when no sprint has completed in the period", async () => {
    mockApi(SCRUM, { "/api/v1/projects/p-atlas/insights/velocity": json({ ...VELOCITY, sprints: [], averageVelocity: null }) });
    renderInsights("ATLAS");
    const velocity = await screen.findByRole("region", { name: "Velocity" });
    expect(await within(velocity).findByText("No completed sprints in this period yet")).toBeInTheDocument();
  });

  it("shows the API's count-unit average in tasks", async () => {
    const counted = {
      ...VELOCITY,
      unit: "count",
      sprints: [
        { ...VELOCITY.sprints[0]!, committedPoints: 0, completedPoints: 0, committedCount: 8, completedCount: 6 },
        { ...VELOCITY.sprints[0]!, id: "sp2", name: "Sprint 2", committedPoints: 0, completedPoints: 0, committedCount: 5, completedCount: 3 },
      ],
      averageVelocity: 4.5,
    };
    mockApi(SCRUM, { "/api/v1/projects/p-atlas/insights/velocity": json(counted) });
    renderInsights("ATLAS");
    const velocity = await screen.findByRole("region", { name: "Velocity" });
    expect(await within(velocity).findByText("Average 4.5 tasks a sprint · last 2 completed")).toBeInTheDocument();
    const reliability = screen.getByRole("region", { name: "Commitment reliability" });
    expect(await within(reliability).findAllByText("+1")).toHaveLength(2);
  });

  it("opens with the range and period already in the URL", async () => {
    mockApi(SCRUM);
    renderInsights("ATLAS", "?days=90&period=pk1");
    const range = await screen.findByRole("group", { name: "Range" });
    expect(within(range).getByRole("button", { name: "90 days" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("combobox", { name: "Period" })).toHaveValue("pk1");
    expect(await screen.findByRole("region", { name: "WIP vs limit" })).toBeInTheDocument();
    await waitFor(() => expect(calls).toContain("/api/v1/projects/p-atlas/insights/cycle-time?days=90"));
    expect(calls).toContain("/api/v1/projects/p-atlas/insights/flow?days=90");
    expect(calls.some((url) => url.includes("days=30"))).toBe(false);
    expect(screen.queryByRole("region", { name: "Sprint burndown" })).not.toBeInTheDocument();
  });

  it("falls back to the open period for an unknown ?period=", async () => {
    mockApi(SCRUM);
    renderInsights("ATLAS", "?period=00000000-0000-4000-8000-000000000000");
    expect(await screen.findByRole("combobox", { name: "Period" })).toHaveValue("ps1");
    expect(await screen.findByRole("region", { name: "Velocity" })).toBeInTheDocument();
    await waitFor(() => expect(calls).toContain("/api/v1/projects/p-atlas/insights/velocity"));
    expect(calls.some((url) => url.includes("period="))).toBe(false);
    expect(screen.queryByRole("region", { name: "WIP vs limit" })).not.toBeInTheDocument();
  });

  it("shows the loading state, not the old range's numbers, while a new range loads", async () => {
    let release: (() => void) | null = null;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    mockApi(SCRUM, { "/api/v1/projects/p-atlas/insights/flow?days=90": async () => { await pending; return json(FLOW)(); } });
    renderInsights("ATLAS");
    const flow = await screen.findByRole("region", { name: "Cumulative flow" });
    await waitFor(() => expect(flow.querySelector(".recharts-area")).not.toBeNull());
    await userEvent.click(within(await screen.findByRole("group", { name: "Range" })).getByRole("button", { name: "90 days" }));
    expect(await within(flow).findByRole("status", { name: "Loading chart" })).toBeInTheDocument();
    expect(flow.querySelector(".recharts-area")).toBeNull();
    release!();
    await waitFor(() => expect(flow.querySelector(".recharts-area")).not.toBeNull());
  });

  it("switches to the Kanban section when the Kanban period is selected", async () => {
    mockApi(SCRUM);
    renderInsights("ATLAS");
    const period = await screen.findByRole("combobox", { name: "Period" });
    expect(within(period).getAllByRole("option").map((option) => option.textContent)).toEqual(["Scrum since Oct 18", "Kanban Aug 19–Oct 18"]);
    await userEvent.selectOptions(period, "pk1");
    expect(window.location.search).toContain("period=pk1");

    const wip = await screen.findByRole("region", { name: "WIP vs limit" });
    expect(await within(wip).findByRole("img", { name: "In progress: 4, 1.3× over target" })).toBeInTheDocument();
    expect(within(wip).getByText("In review")).toBeInTheDocument();
    expect(within(wip).getByText(/· Current board$/u)).toBeInTheDocument();
    expect(within(wip).queryByText("Done")).not.toBeInTheDocument();
    const aging = screen.getByRole("region", { name: "Aging work in progress" });
    expect(await within(aging).findByText("Migrate billing")).toBeInTheDocument();
    expect(within(aging).getByText("Over p85")).toBeInTheDocument();
    expect(within(aging).getByText(/· Current board$/u)).toBeInTheDocument();
    const cycleCard = screen.getByRole("region", { name: "Cycle and lead time" });
    expect(within(cycleCard).queryByText(/Current board/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Sprint burndown" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Velocity" })).not.toBeInTheDocument();
  });

  it("refetches the range-bound cards with ?days=90", async () => {
    mockApi(SCRUM);
    renderInsights("ATLAS");
    const range = await screen.findByRole("group", { name: "Range" });
    expect(within(range).getByRole("button", { name: "30 days" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(calls).toContain("/api/v1/projects/p-atlas/insights/flow?days=30"));
    await userEvent.click(within(range).getByRole("button", { name: "90 days" }));
    await waitFor(() => expect(calls).toContain("/api/v1/projects/p-atlas/insights/flow?days=90"));
    expect(calls).toContain("/api/v1/projects/p-atlas/insights/members?days=90");
    expect(window.location.search).toContain("days=90");
  });

  it("keeps the other cards when one endpoint fails, and retries that card", async () => {
    let fail = true;
    mockApi(SCRUM, { "/api/v1/projects/p-atlas/insights/members": () => (fail ? failure()() : json(MEMBERS)()) });
    renderInsights("ATLAS");
    const membersCard = await screen.findByRole("region", { name: "Members" });
    expect(await within(membersCard).findByRole("alert")).toHaveTextContent(/./u);
    const flow = screen.getByRole("region", { name: "Cumulative flow" });
    await waitFor(() => expect(flow.querySelector(".recharts-area")).not.toBeNull());
    expect(await screen.findByRole("list", { name: "Key numbers" })).toBeInTheDocument();
    fail = false;
    await userEvent.click(within(membersCard).getByRole("button", { name: "Retry" }));
    expect(await within(membersCard).findByText("Avery Founder")).toBeInTheDocument();
    const rows = within(membersCard).getAllByRole("row");
    expect(rows[rows.length - 1]).toHaveTextContent("Unassigned");
  });

  it("lists overdue work with links to the task drawer and marks the switch on the flow", async () => {
    mockApi(SCRUM);
    renderInsights("ATLAS");
    const overdue = await screen.findByRole("region", { name: "Overdue work" });
    expect(await within(overdue).findByRole("link", { name: /Fix login redirect/u })).toHaveAttribute("href", "/w/northstar-labs/p/ATLAS?issue=ATLAS-4");
    const flow = screen.getByRole("region", { name: "Cumulative flow" });
    await waitFor(() => expect(flow.querySelector(".vizMarkerLabel")).not.toBeNull());
    const lines = Array.from(flow.querySelectorAll(".vizMarkerLabel tspan"), (tspan) => tspan.textContent);
    expect(lines).toEqual(["Switched Kanban → Scrum", "on Oct 18"]);
    expect(within(flow).getByText(/· Switched Kanban → Scrum on Oct 18/)).toBeInTheDocument();
  });

  it("shows phases, milestone states and the schedule variance for Waterfall", async () => {
    const periods = [{ id: "pw1", methodology: "waterfall", startedAt: "2026-10-18T09:00:00.000Z", endedAt: null }];
    mockApi(WATERFALL, {}, periods);
    renderInsights("WEB");
    expect(screen.queryByRole("combobox", { name: "Period" })).not.toBeInTheDocument();
    const phases = await screen.findByRole("region", { name: "Phase progress" });
    expect(await within(phases).findByText("+6 d")).toHaveAttribute("data-tone", "late");
    const milestones = screen.getByRole("region", { name: "Milestones" });
    expect(await within(milestones).findByText("Missed")).toHaveAttribute("data-state", "missed");
    expect(within(milestones).getByText("Hit")).toHaveAttribute("data-state", "hit");
    const variance = screen.getByRole("region", { name: "Schedule variance" });
    expect(await within(variance).findByText("6 days behind baseline")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Period" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Current plan/u)).not.toBeInTheDocument();
  });

  it("marks the Waterfall cards as the current plan when a past Waterfall period is selected", async () => {
    const periods = [
      { id: "pw1", methodology: "waterfall", startedAt: "2026-08-19T09:00:00.000Z", endedAt: "2026-10-18T09:30:00.000Z" },
      { id: "ps1", methodology: "scrum", startedAt: "2026-10-18T09:30:00.000Z", endedAt: null },
    ];
    mockApi(SCRUM, {}, periods);
    renderInsights("ATLAS", "?period=pw1");
    for (const name of ["Schedule variance", "Phase progress", "Milestones"]) {
      const card = await screen.findByRole("region", { name });
      expect(await within(card).findByText(/· Current plan$/u)).toBeInTheDocument();
    }
    await waitFor(() => expect(calls).toContain("/api/v1/projects/p-atlas/insights/schedule?period=pw1"));
  });
});

describe("burndown subtitle", () => {
  const sprint = SPRINT("sp4", "Sprint 4", "active", { committedPoints: 20, committedCount: 8 });
  const days = [{ day: "2026-10-19", ideal: 20, scope: 20, remaining: 20 }, { day: "2026-10-21", ideal: 0, scope: null, remaining: null }];

  it("names committed work already done at the start in the burndown's unit", () => {
    expect(burndownSubtitle({ sprint: { ...sprint, committedPoints: 23 }, unit: "points", base: 20, days })).toBe("Sprint 4: 20 points at the start, 3 already done · Oct 19 – Oct 21");
    expect(burndownSubtitle({ sprint, unit: "count", base: 6, days })).toBe("Sprint 4: 6 tasks at the start, 2 already done · Oct 19 – Oct 21");
  });

  it("says nothing about already-done work when there is none, the base exceeds the commitment or nothing was frozen", () => {
    expect(burndownSubtitle({ sprint, unit: "points", base: 20, days })).toBe("Sprint 4: 20 points at the start · Oct 19 – Oct 21");
    expect(burndownSubtitle({ sprint, unit: "points", base: 22, days })).toBe("Sprint 4: 22 points at the start · Oct 19 – Oct 21");
    expect(burndownSubtitle({ sprint: { ...sprint, committedPoints: null }, unit: "points", base: 20, days })).toBe("Sprint 4: 20 points at the start · Oct 19 – Oct 21");
  });
});
