import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), push: vi.fn() };
const auth = {
  isAuthenticated: true,
  isLoading: false,
  platformRoles: [] as string[],
  user: { id: "u-casey", displayName: "Casey Member", email: "casey@example.com", avatarUrl: null },
  workspaces: [
    { workspaceId: "w1", workspaceName: "Northstar Labs", workspaceSlug: "northstar-labs", role: "member" },
    { workspaceId: "w2", workspaceName: "Orbit Studio", workspaceSlug: "orbit-studio", role: "member" },
  ],
  logout: vi.fn(),
  refreshSession: vi.fn(async () => {}),
};

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/w/northstar-labs/schedule",
  useSearchParams: () => new URLSearchParams(window.location.search),
  useParams: () => ({ slug: "northstar-labs" }),
}));
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));

import SchedulePage from "../src/app/schedule/page";
import WorkspaceLayout from "../src/app/w/[slug]/layout";
import WorkspaceSchedulePage from "../src/app/w/[slug]/schedule/page";
import { WorkspaceShell } from "../src/app/components";
import { viewerZone, weekBounds } from "../src/app/w/_lib/schedule";

const base = { id: "w1", slug: "northstar-labs", name: "Northstar Labs", role: "member", memberCount: 3, version: 2, createdAt: "2026-10-18T10:00:00.000Z" };
const avery = { id: "u-avery", displayName: "Avery Founder" };
const casey = { id: "u-casey", displayName: "Casey Member" };
const project = { id: "p1", key: "ATLAS", name: "Atlas app", methodology: "scrum" };

const standup = {
  id: "e1", title: "Founder stand-up", description: null, location: "Team room", startsAt: "2026-10-28T12:00:00.000Z", endsAt: "2026-10-28T13:00:00.000Z",
  timezone: "Europe/Berlin", status: "scheduled", organizer: avery, project: null, issue: null,
  attendees: [{ user: avery, response: "accepted" }, { user: casey, response: "pending" }], myResponse: "pending", canEdit: false, version: 1,
};
const review = {
  ...standup, id: "e2", title: "Design review", location: null, startsAt: "2026-10-29T12:00:00.000Z", endsAt: "2026-10-29T13:00:00.000Z",
  attendees: [{ user: avery, response: "accepted" }], myResponse: null,
};
const cancelled = {
  ...standup, id: "e3", title: "Old sync", startsAt: "2026-10-27T12:00:00.000Z", endsAt: "2026-10-27T13:00:00.000Z", status: "cancelled",
  attendees: [{ user: avery, response: "accepted" }, { user: casey, response: "accepted" }], myResponse: "accepted",
};

const CALENDAR = {
  range: { from: "", to: "", tz: "UTC" },
  events: [standup, review, cancelled],
  deadlines: [
    { kind: "task_due", date: "2026-10-29", title: "Fix login", project, issueId: "i1", assignee: casey },
    { kind: "task_due", date: "2026-10-30", title: "Write docs", project, issueId: "i2", assignee: avery },
    { kind: "sprint_end", date: "2026-10-30", title: "Sprint 12", project, sprintId: "s1" },
    { kind: "milestone_due", date: "2026-10-31", title: "Beta launch", project, milestoneId: "m1" },
  ],
  truncated: { events: false, deadlines: false },
};

let calls: string[] = [];
let failing = false;
function mockApi(calendar: unknown = CALENDAR) {
  calls = [];
  failing = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "/api/v1/workspaces/by-slug/northstar-labs") return reply(base);
    if (url === "/api/v1/workspaces/w1/projects") return reply({ items: [] });
    if (url.startsWith("/api/v1/workspaces/w1/calendar")) {
      if (failing) return new Response(JSON.stringify({ code: "boom" }), { status: 500, headers: { "content-type": "application/problem+json" } });
      return reply(calendar);
    }
    return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
  }));
}

function calendarCalls() {
  return calls.filter((url) => url.includes("/calendar"));
}

function renderPage() {
  return render(<WorkspaceLayout><WorkspaceSchedulePage /></WorkspaceLayout>);
}

function stubWidth(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width") ? matches : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-28T10:00:00.000Z") });
  window.history.replaceState(null, "", "/w/northstar-labs/schedule");
  window.localStorage.clear();
  router.replace.mockClear();
  auth.workspaces = [
    { workspaceId: "w1", workspaceName: "Northstar Labs", workspaceSlug: "northstar-labs", role: "member" },
    { workspaceId: "w2", workspaceName: "Orbit Studio", workspaceSlug: "orbit-studio", role: "member" },
  ];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("workspace schedule", () => {
  it("asks for the viewer's local week and shows the week label", async () => {
    mockApi();
    renderPage();
    expect(await screen.findByRole("heading", { name: "Schedule" })).toBeInTheDocument();
    expect(screen.getByText("Oct 26 – Nov 1, 2026")).toBeInTheDocument();
    const { from, to } = weekBounds("2026-10-26", viewerZone());
    await waitFor(() => expect(calendarCalls()).toEqual([`/api/v1/workspaces/w1/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&tz=${encodeURIComponent(viewerZone())}`]));
  });

  it("renders seven days, events with their details and deadline chips that link to their screens", async () => {
    mockApi();
    renderPage();
    const wednesday = await screen.findByRole("region", { name: "Wednesday, Oct 28" });
    expect(within(wednesday).getByText("Founder stand-up")).toBeInTheDocument();
    expect(within(wednesday).getByText("Team room")).toBeInTheDocument();
    expect(within(wednesday).getByText("Awaiting reply")).toBeInTheDocument();
    expect(within(wednesday).getByText("Today")).toBeInTheDocument();
    expect(screen.getAllByRole("region", { name: /^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, / })).toHaveLength(7);

    const thursday = screen.getByRole("region", { name: "Thursday, Oct 29" });
    expect(within(thursday).getByText("Design review")).toBeInTheDocument();
    expect(within(thursday).getByRole("link", { name: /Fix login/ })).toHaveAttribute("href", "/w/northstar-labs/p/ATLAS?issue=i1");

    const friday = screen.getByRole("region", { name: "Friday, Oct 30" });
    expect(within(friday).getByRole("link", { name: /Sprint 12/ })).toHaveAttribute("href", "/w/northstar-labs/p/ATLAS/backlog");
    const saturday = screen.getByRole("region", { name: "Saturday, Oct 31" });
    expect(within(saturday).getByRole("link", { name: /Beta launch/ })).toHaveAttribute("href", "/w/northstar-labs/p/ATLAS/timeline");
  });

  it("strikes through cancelled events", async () => {
    mockApi();
    renderPage();
    const tuesday = await screen.findByRole("region", { name: "Tuesday, Oct 27" });
    const card = within(tuesday).getByText("Old sync").closest("[data-status]");
    expect(card).toHaveAttribute("data-status", "cancelled");
    expect(within(tuesday).getByText("Cancelled")).toBeInTheDocument();
  });

  it("moves between weeks with ?week= and refetches the right bounds", async () => {
    mockApi();
    renderPage();
    await screen.findByText("Founder stand-up");
    await userEvent.click(screen.getByRole("button", { name: "Next week" }));
    expect(window.location.search).toBe("?week=2026-11-02");
    expect(screen.getByText("Nov 2 – Nov 8, 2026")).toBeInTheDocument();
    const next = weekBounds("2026-11-02", viewerZone());
    await waitFor(() => expect(calendarCalls().at(-1)).toContain(`from=${encodeURIComponent(next.from)}&to=${encodeURIComponent(next.to)}`));

    await userEvent.click(screen.getByRole("button", { name: "Previous week" }));
    await userEvent.click(screen.getByRole("button", { name: "Previous week" }));
    expect(window.location.search).toBe("?week=2026-10-19");
    const previous = weekBounds("2026-10-19", viewerZone());
    await waitFor(() => expect(calendarCalls().at(-1)).toContain(`from=${encodeURIComponent(previous.from)}`));

    await userEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(window.location.search).toBe("");
    expect(screen.getByText("Oct 26 – Nov 1, 2026")).toBeInTheDocument();
  });

  it("opens on the week named in ?week=", async () => {
    mockApi();
    window.history.replaceState(null, "", "/w/northstar-labs/schedule?week=2026-11-04");
    renderPage();
    expect(await screen.findByText("Nov 2 – Nov 8, 2026")).toBeInTheDocument();
  });

  it("only mine keeps my events, my deadlines and every sprint or milestone date", async () => {
    mockApi();
    renderPage();
    await screen.findByText("Founder stand-up");
    const toggle = screen.getByRole("button", { name: "Only mine" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Founder stand-up")).toBeInTheDocument();
    expect(screen.getByText("Old sync")).toBeInTheDocument();
    expect(screen.queryByText("Design review")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Fix login/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Write docs/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Sprint 12/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Beta launch/ })).toBeInTheDocument();
  });

  it("shows an agenda grouped by day at phone width and omits empty days", async () => {
    stubWidth(false);
    mockApi();
    renderPage();
    const agenda = await screen.findByRole("list", { name: "Agenda" });
    const headings = within(agenda).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["Tuesday, Oct 27", "Wednesday, Oct 28", "Thursday, Oct 29", "Friday, Oct 30", "Saturday, Oct 31"]);
    expect(within(agenda).getByText("Founder stand-up")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Monday, Oct 26" })).not.toBeInTheDocument();
  });

  it("says nothing is scheduled for an empty week", async () => {
    stubWidth(false);
    mockApi({ ...CALENDAR, events: [], deadlines: [] });
    renderPage();
    expect(await screen.findByText("Nothing scheduled this week")).toBeInTheDocument();
  });

  it("shows an error with Retry, then the week", async () => {
    mockApi();
    failing = true;
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/went wrong/i);
    failing = false;
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Founder stand-up")).toBeInTheDocument();
  });

  it("refetches when the window regains focus", async () => {
    mockApi();
    renderPage();
    await screen.findByText("Founder stand-up");
    const before = calendarCalls().length;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(calendarCalls().length).toBe(before + 1));
  });

  it("reloads once when focus and visibilitychange fire together", async () => {
    mockApi();
    renderPage();
    await screen.findByText("Founder stand-up");
    const before = calendarCalls().length;
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(calendarCalls().length).toBe(before + 1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calendarCalls().length).toBe(before + 1);
  });

  it("moves Today to the new day when the tab regains focus after midnight", async () => {
    mockApi();
    renderPage();
    await screen.findByText("Founder stand-up");
    expect(screen.getByRole("region", { name: /Wednesday, Oct 28/u })).toHaveAttribute("data-today", "true");
    vi.setSystemTime(new Date("2026-10-29T10:00:00.000Z"));
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(screen.getByRole("region", { name: /Thursday, Oct 29/u })).toHaveAttribute("data-today", "true"));
    expect(screen.getByRole("region", { name: /Wednesday, Oct 28/u })).not.toHaveAttribute("data-today");
  });

  it("offers a New event button for the event dialog to wire", async () => {
    mockApi();
    renderPage();
    expect(await screen.findByRole("button", { name: "New event" })).toBeInTheDocument();
  });
});

describe("schedule entry points", () => {
  it("/schedule goes to the last used workspace's schedule", async () => {
    window.localStorage.setItem("spark:last-workspace", "orbit-studio");
    render(<SchedulePage />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/w/orbit-studio/schedule"));
  });

  it("/schedule goes to onboarding without a workspace", async () => {
    auth.workspaces = [];
    render(<SchedulePage />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/onboarding"));
  });

  it("the shell Schedule link targets the active workspace and is current on the schedule page", async () => {
    mockApi();
    renderPage();
    const nav = await screen.findByRole("navigation", { name: "Workspace navigation" });
    const link = within(nav).getByRole("link", { name: "Schedule" });
    expect(link).toHaveAttribute("href", "/w/northstar-labs/schedule");
    await waitFor(() => expect(link).toHaveAttribute("aria-current", "page"));
  });

  it("the shell falls back to the resolver without a workspace", () => {
    auth.workspaces = [];
    render(<WorkspaceShell current="Home"><p>Inside</p></WorkspaceShell>);
    expect(within(screen.getByRole("navigation", { name: "Workspace navigation" })).getByRole("link", { name: "Schedule" })).toHaveAttribute("href", "/schedule");
  });
});
