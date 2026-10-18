import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CATALOG } from "./methodology-catalog";

const router = { replace: vi.fn(), push: vi.fn() };
const navigation = { search: "", params: { slug: "northstar-labs" } as Record<string, string> };
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
  usePathname: () => "/w/northstar-labs/projects/new",
  useSearchParams: () => new URLSearchParams(navigation.search),
  useParams: () => navigation.params,
}));
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));

import WorkspaceLayout from "../src/app/w/[slug]/layout";
import NewProjectPage from "../src/app/w/[slug]/projects/new/page";

const workspace = { id: "w1", slug: "northstar-labs", name: "Northstar Labs", role: "owner", memberCount: 2, version: 2, createdAt: "2026-10-18T10:00:00.000Z" };
const avery = { userId: "u-avery", displayName: "Avery Founder", avatarUrl: null, email: "avery@example.com", role: "owner", joinedAt: "2026-10-01T10:00:00.000Z" };
const blake = { userId: "u-blake", displayName: "Blake Rivers", avatarUrl: null, email: "blake@example.com", role: "member", joinedAt: "2026-10-10T10:00:00.000Z" };

type Handler = (body: unknown) => Response;
let calls: Array<{ key: string; body: unknown; credentials: RequestCredentials | undefined }> = [];
function mockApi(routes: Record<string, Handler>) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ key, body, credentials: init?.credentials });
    const handler = routes[key];
    return handler ? handler(body) : new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
  }));
}
const json = (payload: unknown, status = 200): Handler => () => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const created = (key: string): Handler => (body) => new Response(JSON.stringify({ id: "p1", ...(body as object), key }), { status: 201, headers: { "content-type": "application/json", ETag: "\"v1\"" } });

function routes(extra: Record<string, Handler> = {}, role = "owner"): Record<string, Handler> {
  return {
    "GET /api/v1/workspaces/by-slug/northstar-labs": json({ ...workspace, role }),
    "GET /api/v1/workspaces/w1/members": json({ items: [avery, blake] }),
    "GET /api/v1/methodologies": json({ items: CATALOG }),
    ...extra,
  };
}

async function renderPage() {
  render(<WorkspaceLayout><NewProjectPage /></WorkspaceLayout>);
  return screen.findByRole("radiogroup", { name: "How does your team work?" });
}

async function choose(name: string) {
  const group = await renderPage();
  await userEvent.click(within(group).getByRole("radio", { name }));
  // The lead list is loaded and defaults to the current user.
  await waitFor(() => expect(screen.getByLabelText("Project lead")).toHaveValue("u-avery"));
}

const posted = () => calls.filter((call) => call.key === "POST /api/v1/workspaces/w1/projects").map((call) => call.body);

beforeEach(() => {
  navigation.search = "";
  router.push.mockClear();
  router.replace.mockClear();
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("new project page", () => {
  it("tells plain members that only owners and admins create projects", async () => {
    mockApi(routes({}, "member"));
    render(<WorkspaceLayout><NewProjectPage /></WorkspaceLayout>);
    expect(await screen.findByRole("heading", { name: "Only owners and admins can create projects" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to workspace home" })).toHaveAttribute("href", "/w/northstar-labs");
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Project name")).not.toBeInTheDocument();
    expect(calls.some((call) => call.key.startsWith("POST"))).toBe(false);
  });

  it("shows the picker first and reveals the form after a choice", async () => {
    mockApi(routes());
    const group = await renderPage();
    expect(screen.getByText("New project")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "How does your team work?" })).toBeInTheDocument();
    expect(within(group).getAllByRole("radio")).toHaveLength(3);
    expect(screen.queryByLabelText("Project name")).not.toBeInTheDocument();
    expect(calls.find((call) => call.key === "GET /api/v1/methodologies")?.credentials).toBe("omit");
    await userEvent.click(within(group).getByRole("radio", { name: "Kanban" }));
    expect(screen.getByLabelText("Project name")).toBeInTheDocument();
    expect(screen.getByText("Practices we'll suggest")).toBeInTheDocument();
    expect(screen.getByText("Respect WIP limits to finish before starting")).toBeInTheDocument();
  });

  it("says first project when arriving from onboarding", async () => {
    navigation.search = "first=1";
    mockApi(routes());
    await renderPage();
    expect(screen.getByText("Your first project")).toBeInTheDocument();
  });

  it("creates a Kanban project with a live-derived key and opens it", async () => {
    mockApi(routes({ "POST /api/v1/workspaces/w1/projects": created("PL") }));
    await choose("Kanban");
    await userEvent.type(screen.getByLabelText("Project name"), "Product Launch");
    expect(screen.getByLabelText("Project key")).toHaveValue("PL");
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/w/northstar-labs/p/PL"));
    expect(posted()).toEqual([{ key: "PL", name: "Product Launch", methodology: "kanban", leadUserId: "u-avery" }]);
  });

  it("creates a Scrum project with the chosen sprint length, description, lead and edited key", async () => {
    mockApi(routes({ "POST /api/v1/workspaces/w1/projects": created("ATLAS") }));
    await choose("Scrum");
    expect(screen.getByLabelText("Sprint length")).toHaveValue("14");
    await userEvent.type(screen.getByLabelText("Project name"), "Atlas");
    expect(screen.getByLabelText("Project key")).toHaveValue("ATL");
    await userEvent.clear(screen.getByLabelText("Project key"));
    await userEvent.type(screen.getByLabelText("Project key"), "atlas");
    // An edited key no longer follows the name.
    await userEvent.type(screen.getByLabelText("Project name"), " app");
    expect(screen.getByLabelText("Project key")).toHaveValue("ATLAS");
    await userEvent.type(screen.getByLabelText("Description"), "Mobile app rebuild");
    await userEvent.selectOptions(screen.getByLabelText("Sprint length"), "3 weeks");
    await userEvent.selectOptions(screen.getByLabelText("Project lead"), "Blake Rivers");
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/w/northstar-labs/p/ATLAS"));
    expect(posted()).toEqual([{ key: "ATLAS", name: "Atlas app", description: "Mobile app rebuild", methodology: "scrum", leadUserId: "u-blake", sprintLengthDays: 21 }]);
  });

  it("rejects an invalid key inline before posting", async () => {
    mockApi(routes());
    await choose("Kanban");
    await userEvent.type(screen.getByLabelText("Project name"), "Atlas");
    await userEvent.clear(screen.getByLabelText("Project key"));
    await userEvent.type(screen.getByLabelText("Project key"), "1A");
    const key = screen.getByLabelText("Project key");
    expect(key).toHaveAttribute("aria-invalid", "true");
    expect(key).toHaveAccessibleDescription("Use 2–10 capital letters or digits, starting with a letter.");
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(posted()).toEqual([]);
  });

  it("creates a Waterfall project with phases spread over the dates", async () => {
    mockApi(routes({ "POST /api/v1/workspaces/w1/projects": created("WR2Q") }));
    await choose("Waterfall");
    await userEvent.type(screen.getByLabelText("Project name"), "Website redesign 2027 Q1");
    expect(screen.getByLabelText("Project key")).toHaveValue("WR2Q");
    expect(screen.getByLabelText("Phase 1 name")).toHaveValue("Requirements");
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-11-02" } });
    fireEvent.change(screen.getByLabelText("Target date"), { target: { value: "2026-12-11" } });
    expect(screen.getByLabelText("Phase 1 end")).toHaveValue("2026-11-09");
    expect(screen.getByLabelText("Phase 5 start")).toHaveValue("2026-12-04");
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/w/northstar-labs/p/WR2Q"));
    expect(posted()).toEqual([{
      key: "WR2Q",
      name: "Website redesign 2027 Q1",
      methodology: "waterfall",
      leadUserId: "u-avery",
      startDate: "2026-11-02",
      targetDate: "2026-12-11",
      phases: [
        { name: "Requirements", plannedStart: "2026-11-02", plannedEnd: "2026-11-09" },
        { name: "Design", plannedStart: "2026-11-10", plannedEnd: "2026-11-17" },
        { name: "Build", plannedStart: "2026-11-18", plannedEnd: "2026-11-25" },
        { name: "Test", plannedStart: "2026-11-26", plannedEnd: "2026-12-03" },
        { name: "Deploy", plannedStart: "2026-12-04", plannedEnd: "2026-12-11" },
      ],
    }]);
  });

  it("blocks a Waterfall range shorter than its phases", async () => {
    mockApi(routes());
    await choose("Waterfall");
    await userEvent.type(screen.getByLabelText("Project name"), "Launch");
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-11-02" } });
    fireEvent.change(screen.getByLabelText("Target date"), { target: { value: "2026-11-04" } });
    const message = "Give each phase at least one day — move the target date or remove a phase.";
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByLabelText("Target date")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Target date")).toHaveAccessibleDescription(message);
    expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();

    // Three phases fit in three days.
    await userEvent.click(screen.getByRole("button", { name: "Remove phase 5" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove phase 4" }));
    expect(screen.queryByText(message)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Phase 3 end")).toHaveValue("2026-11-04");
    expect(screen.getByRole("button", { name: "Create project" })).toBeEnabled();
  });

  it("keeps hand-edited phase dates until the user re-spreads them", async () => {
    mockApi(routes());
    await choose("Waterfall");
    await userEvent.type(screen.getByLabelText("Project name"), "Launch");
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-11-02" } });
    fireEvent.change(screen.getByLabelText("Target date"), { target: { value: "2026-12-11" } });
    fireEvent.change(screen.getByLabelText("Phase 2 end"), { target: { value: "2026-11-20" } });

    // A later target date no longer overwrites the edited dates.
    fireEvent.change(screen.getByLabelText("Target date"), { target: { value: "2026-12-16" } });
    expect(screen.getByLabelText("Phase 1 end")).toHaveValue("2026-11-09");
    expect(screen.getByLabelText("Phase 2 end")).toHaveValue("2026-11-20");
    expect(screen.getByLabelText("Phase 5 end")).toHaveValue("2026-12-11");

    // A new phase runs from the day after the last one to the target date; removing it keeps the rest.
    await userEvent.click(screen.getByRole("button", { name: "Add phase" }));
    expect(screen.getByLabelText("Phase 6 start")).toHaveValue("2026-12-12");
    expect(screen.getByLabelText("Phase 6 end")).toHaveValue("2026-12-16");
    expect(screen.getByLabelText("Phase 2 end")).toHaveValue("2026-11-20");
    await userEvent.click(screen.getByRole("button", { name: "Remove phase 6" }));
    expect(screen.getByLabelText("Phase 2 end")).toHaveValue("2026-11-20");

    // Phase 2 now overlaps phase 3: validation flags it instead of posting.
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByText("Each phase needs a name and dates inside the project dates, in order and without overlapping.")).toBeInTheDocument();
    expect(posted()).toEqual([]);

    await userEvent.click(screen.getByRole("button", { name: "Re-spread dates evenly" }));
    expect(screen.getByLabelText("Phase 1 end")).toHaveValue("2026-11-10");
    expect(screen.getByLabelText("Phase 2 end")).toHaveValue("2026-11-19");
    expect(screen.getByLabelText("Phase 5 end")).toHaveValue("2026-12-16");
    expect(screen.queryByText(/without overlapping/)).not.toBeInTheDocument();

    // Back in automatic mode, date changes re-spread again.
    fireEvent.change(screen.getByLabelText("Target date"), { target: { value: "2026-12-11" } });
    expect(screen.getByLabelText("Phase 1 end")).toHaveValue("2026-11-09");
  });

  it("caps the phase list at twelve rows", async () => {
    mockApi(routes());
    await choose("Waterfall");
    const add = screen.getByRole("button", { name: "Add phase" });
    for (let i = 0; i < 7; i += 1) await userEvent.click(add);
    expect(screen.getByLabelText("Phase 12 name")).toHaveValue("Phase 12");
    expect(add).toBeDisabled();
  });

  it("shows a taken key inline on the key field", async () => {
    mockApi(routes({ "POST /api/v1/workspaces/w1/projects": json({ code: "key_taken", detail: "That project key is already used in this workspace." }, 409) }));
    await choose("Kanban");
    await userEvent.type(screen.getByLabelText("Project name"), "Product Launch");
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));
    const key = screen.getByLabelText("Project key");
    await waitFor(() => expect(key).toHaveAttribute("aria-invalid", "true"));
    expect(key).toHaveAccessibleDescription("That key is already used in this workspace.");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("shows an invalid lead inline on the lead field", async () => {
    mockApi(routes({ "POST /api/v1/workspaces/w1/projects": json({ code: "invalid_lead", detail: "The project lead must be an active member of the workspace." }, 422) }));
    await choose("Kanban");
    await userEvent.type(screen.getByLabelText("Project name"), "Product Launch");
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));
    const lead = screen.getByLabelText("Project lead");
    await waitFor(() => expect(lead).toHaveAttribute("aria-invalid", "true"));
    expect(lead).toHaveAccessibleDescription("The project lead must be an active member of the workspace.");
  });
});
