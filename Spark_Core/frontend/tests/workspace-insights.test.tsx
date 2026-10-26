import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  usePathname: () => "/w/northstar-labs/insights",
  useSearchParams: () => new URLSearchParams(window.location.search),
  useParams: () => ({ slug: "northstar-labs" }),
}));
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));

import WorkspaceLayout from "../src/app/w/[slug]/layout";
import WorkspaceInsightsPage from "../src/app/w/[slug]/insights/page";

const base = { id: "w1", slug: "northstar-labs", name: "Northstar Labs", memberCount: 3, version: 2, createdAt: "2026-10-18T10:00:00.000Z" };
const avery = { id: "u-avery", displayName: "Avery Founder" };

const CALENDAR = Array.from({ length: 30 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 8, 27 + index));
  return { day: date.toISOString().slice(0, 10), value: index % 4 };
});

const INSIGHTS = {
  range: { from: "2026-09-27", to: "2026-10-26" },
  projects: [
    { id: "p1", key: "ATLAS", name: "Atlas app", methodology: "scrum", unit: "points", donePercent: 40, planPercent: 55, status: "at_risk", open: 18, overdue: 2 },
    { id: "p2", key: "OPS", name: "Ops board", methodology: "kanban", unit: "count", donePercent: 70, planPercent: null, status: "no_plan", open: 5, overdue: 0 },
  ],
  members: [
    { user: avery, completed: 5, completedPoints: 13, onTimeRate: 80, open: 3, overdue: 1, medianCycleDays: 2.5 },
    { user: { id: "u-casey", displayName: "Casey Member" }, completed: 2, completedPoints: 4, onTimeRate: null, open: 1, overdue: 0, medianCycleDays: null },
    { user: null, completed: 1, completedPoints: 0, onTimeRate: null, open: 4, overdue: 1, medianCycleDays: null },
  ],
  calendar: CALENDAR,
  overdue: [
    { issueId: "i4", key: "ATLAS-4", title: "Fix login redirect", projectKey: "ATLAS", dueDate: "2026-10-20", assignee: avery },
    { issueId: "i5", key: "OPS-2", title: "Rotate keys", projectKey: "OPS", dueDate: "2026-10-22", assignee: null },
  ],
};

const EMPTY = { range: INSIGHTS.range, projects: [], members: [], calendar: CALENDAR, overdue: [] };

let calls: string[] = [];
function mockApi(role: string, insights: unknown = INSIGHTS) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "/api/v1/workspaces/by-slug/northstar-labs") return reply({ ...base, role });
    if (url === "/api/v1/workspaces/w1/projects") return reply({ items: [] });
    if (url.startsWith("/api/v1/workspaces/w1/insights")) return reply(insights);
    return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
  }));
}

function renderPage() {
  return render(<WorkspaceLayout><WorkspaceInsightsPage /></WorkspaceLayout>);
}

beforeEach(() => window.history.replaceState(null, "", "/w/northstar-labs/insights"));
afterEach(() => vi.unstubAllGlobals());

describe("workspace insights", () => {
  it("shows the Insights nav link to a plain member, marked current", async () => {
    mockApi("member");
    renderPage();
    const nav = await screen.findByRole("navigation", { name: "Workspace navigation" });
    const link = within(nav).getByRole("link", { name: "Insights" });
    expect(link).toHaveAttribute("href", "/w/northstar-labs/insights");
    expect(link).toHaveAttribute("aria-current", "page");
  });

  it("renders a card per project with accent, bars, status, counts and a link to its insights", async () => {
    mockApi("member");
    renderPage();
    const section = await screen.findByRole("region", { name: "Projects" });
    const atlas = await within(section).findByRole("link", { name: /Atlas app/ });
    expect(atlas).toHaveAttribute("href", "/w/northstar-labs/p/ATLAS/insights");
    expect(within(atlas).getByText("ATLAS")).toBeInTheDocument();
    expect(within(atlas).getByText("Scrum")).toHaveAttribute("data-methodology", "scrum");
    expect(within(atlas).getByText("At risk")).toBeInTheDocument();
    expect(within(atlas).getByRole("meter", { name: "Atlas app done" })).toHaveAttribute("aria-valuenow", "40");
    expect(atlas.querySelector(".wsInsightsPlanTick")).toHaveStyle({ "--insights-x": "55%" });
    expect(within(section).getByRole("link", { name: /Ops board/ }).querySelector(".wsInsightsPlanTick")).toBeNull();
    expect(within(atlas).getByText("18 open")).toBeInTheDocument();
    expect(within(atlas).getByText("2 overdue")).toBeInTheDocument();
    const ops = within(section).getByRole("link", { name: /Ops board/ });
    expect(within(ops).getByText("No plan")).toBeInTheDocument();
    expect(within(ops).getByText("Kanban")).toHaveAttribute("data-methodology", "kanban");
  });

  it("lists members in API order with Unassigned last, visible to a plain member", async () => {
    mockApi("member");
    renderPage();
    const table = await screen.findByRole("table", { name: "Members" });
    const names = within(table).getAllByRole("rowheader").map((cell) => cell.textContent);
    expect(names).toHaveLength(3);
    expect(names[0]).toContain("Avery Founder");
    expect(names[1]).toContain("Casey Member");
    expect(names[2]).toContain("Unassigned");
    expect(within(table).getByText("80%")).toBeInTheDocument();
    const averyRow = within(table).getByText("Avery Founder").closest("tr")!;
    expect(averyRow.querySelector(".vizInlineBarTrack")).not.toBeNull();
    expect(within(table).getByText("Casey Member").closest("tr")!.querySelector(".vizInlineBarTrack")).toBeNull();
  });

  it("shows a dash for points when nothing finished in the range carried points", async () => {
    const unestimated = { ...INSIGHTS, members: INSIGHTS.members.map((item) => ({ ...item, completedPoints: 0 })) };
    mockApi("member", unestimated);
    renderPage();
    const table = await screen.findByRole("table", { name: "Members" });
    const pointsColumn = within(table).getAllByRole("columnheader").findIndex((cell) => cell.textContent === "Points");
    const points = within(table).getAllByRole("row").slice(1).map((row) => row.children[pointsColumn]!.textContent);
    expect(points).toEqual(["—", "—", "—"]);
  });

  it("keeps points, zeros included, when some finished work carried points", async () => {
    mockApi("member");
    renderPage();
    const table = await screen.findByRole("table", { name: "Members" });
    const pointsColumn = within(table).getAllByRole("columnheader").findIndex((cell) => cell.textContent === "Points");
    const points = within(table).getAllByRole("row").slice(1).map((row) => row.children[pointsColumn]!.textContent);
    expect(points).toEqual(["13", "4", "0"]);
  });

  it("draws the activity calendar and the overdue list across projects", async () => {
    mockApi("member");
    renderPage();
    expect(await screen.findByRole("heading", { name: "Activity" })).toBeInTheDocument();
    expect(await screen.findByText("43 events over 30 days")).toBeInTheDocument();
    expect(document.querySelector('[title="Monday, Sep 28: 1 events"]')).not.toBeNull();
    const overdue = screen.getByRole("list", { name: "Overdue work" });
    expect(within(overdue).getByRole("link", { name: /Fix login redirect/ })).toHaveAttribute("href", "/w/northstar-labs/p/ATLAS?issue=ATLAS-4");
    expect(within(overdue).getByRole("link", { name: /Rotate keys/ })).toHaveAttribute("href", "/w/northstar-labs/p/OPS?issue=OPS-2");
    expect(within(overdue).getByText("ATLAS-4")).toBeInTheDocument();
  });

  it("keeps the range in the URL and requests it", async () => {
    mockApi("member");
    renderPage();
    await screen.findByRole("region", { name: "Projects" });
    await waitFor(() => expect(calls).toContain("/api/v1/workspaces/w1/insights?days=30"));
    await userEvent.click(screen.getByRole("button", { name: "90 days" }));
    await waitFor(() => expect(calls).toContain("/api/v1/workspaces/w1/insights?days=90"));
    expect(window.location.search).toBe("?days=90");
    expect(screen.getByRole("button", { name: "90 days" })).toHaveAttribute("aria-pressed", "true");
  });

  it("reads ?days= from the URL", async () => {
    window.history.replaceState(null, "", "/w/northstar-labs/insights?days=7");
    mockApi("member");
    renderPage();
    await waitFor(() => expect(calls).toContain("/api/v1/workspaces/w1/insights?days=7"));
  });

  it("empty workspace: members see plain text, owners and admins see a create link", async () => {
    mockApi("member", EMPTY);
    const first = renderPage();
    expect(await screen.findByRole("heading", { name: "No projects yet" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Create a project/ })).not.toBeInTheDocument();
    first.unmount();

    mockApi("owner", EMPTY);
    renderPage();
    expect(await screen.findByRole("heading", { name: "No projects yet" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Create a project/ })).toHaveAttribute("href", "/w/northstar-labs/projects/new");
  });

  it("shows a retry when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "/api/v1/workspaces/by-slug/northstar-labs") return reply({ ...base, role: "member" });
      if (url === "/api/v1/workspaces/w1/projects") return reply({ items: [] });
      return new Response(JSON.stringify({ code: "internal", detail: "The server could not load this." }), { status: 500, headers: { "content-type": "application/problem+json" } });
    }));
    renderPage();
    expect((await screen.findAllByRole("button", { name: "Retry" })).length).toBeGreaterThan(0);
  });
});
