import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CATALOG } from "./methodology-catalog";
import { KANBAN, KANBAN_BOARD, LIST, SCRUM } from "./project-fixtures";

const navigation = { params: { slug: "northstar-labs", key: "OPS" } as Record<string, string>, pathname: "/w/northstar-labs/p/OPS/settings" };
const router = { push: vi.fn(), replace: vi.fn() };
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
  useRouter: () => router,
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(),
  useParams: () => navigation.params,
}));
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));

import WorkspaceLayout from "../src/app/w/[slug]/layout";
import ProjectLayout from "../src/app/w/[slug]/p/[key]/layout";
import ProjectSettingsPage from "../src/app/w/[slug]/p/[key]/settings/page";

const workspace = (role: string) => ({ id: "w1", slug: "northstar-labs", name: "Northstar Labs", role, memberCount: 3, version: 2, createdAt: "2026-10-18T10:00:00.000Z" });
const members = [
  { userId: "u-avery", displayName: "Avery Founder", avatarUrl: null, email: null, role: "owner", joinedAt: "2026-10-01T10:00:00.000Z" },
  { userId: "u-blake", displayName: "Blake Rivers", avatarUrl: null, email: null, role: "member", joinedAt: "2026-10-10T10:00:00.000Z" },
];
const PLAN = {
  phases: [],
  milestones: [],
  baselinedAt: null,
  periods: [
    { methodology: "waterfall", startedAt: "2026-09-01T08:00:00.000Z", endedAt: "2026-10-03T08:00:00.000Z" },
    { methodology: "scrum", startedAt: "2026-10-03T08:00:00.000Z", endedAt: "2026-10-18T09:00:00.000Z" },
    { methodology: "kanban", startedAt: "2026-10-18T09:00:00.000Z", endedAt: null },
  ],
  version: 3,
};

type Handler = (init: RequestInit | undefined) => Response;
let calls: Array<{ key: string; body: unknown; ifMatch: string | null }> = [];
const json = (payload: unknown, status = 200, etag?: string): Handler => () =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...(etag ? { ETag: etag } : {}) } });
const problem = (status: number, code: string, detail: string, extra: Record<string, unknown> = {}): Handler => () =>
  new Response(JSON.stringify({ status, code, detail, ...extra }), { status, headers: { "content-type": "application/problem+json" } });

function mockApi(project: { id: string; key: string; [field: string]: unknown } = KANBAN, { role = "owner", extra = {} as Record<string, Handler> } = {}) {
  calls = [];
  const routes: Record<string, Handler> = {
    "GET /api/v1/workspaces/by-slug/northstar-labs": json(workspace(role)),
    "GET /api/v1/workspaces/w1/projects": json({ items: LIST }),
    "GET /api/v1/workspaces/w1/members": json({ items: members }),
    "GET /api/v1/methodologies": json({ items: CATALOG }),
    [`GET /api/v1/workspaces/w1/projects/by-key/${project.key}`]: json(project, 200, "\"v3\""),
    "GET /api/v1/projects/p-ops/board": json(KANBAN_BOARD),
    "GET /api/v1/projects/p-ops/plan": json(PLAN, 200, "\"v3\""),
    "GET /api/v1/projects/p-atlas/board": json({ ...KANBAN_BOARD, statuses: [], issues: [] }),
    "GET /api/v1/projects/p-atlas/plan": json({ ...PLAN, periods: [PLAN.periods[2]] }, 200, "\"v3\""),
    "GET /api/v1/projects/p-atlas/sprints": json({ items: [] }),
    ...extra,
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined, ifMatch: new Headers(init?.headers).get("If-Match") });
    const handler = routes[key];
    return handler ? handler(init) : new Response(JSON.stringify({ code: "not_found", detail: "Not found." }), { status: 404 });
  }));
}

function renderSettings(key = "OPS") {
  navigation.params = { slug: "northstar-labs", key };
  navigation.pathname = `/w/northstar-labs/p/${key}/settings`;
  render(<WorkspaceLayout><ProjectLayout><ProjectSettingsPage /></ProjectLayout></WorkspaceLayout>);
}

const writes = () => calls.filter((call) => !call.key.startsWith("GET"));
const columnRow = (name: string) => screen.getByRole("group", { name: `Column ${name}` });

beforeEach(() => {
  window.localStorage.clear();
  auth.user = OWNER;
  router.push.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("project settings tab", () => {
  it("shows General, the board columns with their cards and the methodology history", async () => {
    mockApi();
    renderSettings();
    const general = await screen.findByRole("region", { name: "General" });
    expect(await within(general).findByLabelText("Project name")).toHaveValue("Ops desk");

    const tabs = screen.getByRole("navigation", { name: "Project views" });
    expect(within(tabs).getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
    // The tab is the one way into settings: the header has no Settings button any more.
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();

    const columns = screen.getByRole("region", { name: "Board columns" });
    // Occupancy comes from the loaded board.
    expect(await within(columnRow("Review")).findByText("3 cards")).toBeInTheDocument();
    expect(within(columnRow("Ready")).getByText("2 cards")).toBeInTheDocument();
    expect(within(columnRow("In progress")).getByText("No cards")).toBeInTheDocument();
    expect(within(columnRow("Review")).getByLabelText("WIP limit")).toHaveValue(3);
    expect(within(columnRow("Backlog")).getByLabelText("WIP limit")).toHaveValue(null);
    expect(within(columns).getAllByRole("group")).toHaveLength(5);

    const methodology = screen.getByRole("region", { name: "Methodology" });
    const history = await within(methodology).findByRole("list", { name: "Methodology history" });
    expect(within(history).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Kanban since Oct 18", "Scrum Oct 3–Oct 18", "Waterfall Sep 1–Oct 3"]);
    expect(within(methodology).getByRole("button", { name: "Switch methodology" })).toBeInTheDocument();
  });

  it("renames a column and changes its WIP limit with the project If-Match", async () => {
    const saved = { ...KANBAN, version: 4, statuses: KANBAN.statuses.map((status) => (status.id === "s4" ? { ...status, name: "Code review", wipLimit: 5 } : status)) };
    mockApi(KANBAN, { extra: { "PATCH /api/v1/projects/p-ops/statuses/s4": json(saved, 200, "\"v4\"") } });
    renderSettings();
    const row = await screen.findByRole("group", { name: "Column Review" });
    await userEvent.clear(within(row).getByLabelText("Column name"));
    await userEvent.type(within(row).getByLabelText("Column name"), "Code review");
    await userEvent.clear(within(row).getByLabelText("WIP limit"));
    await userEvent.type(within(row).getByLabelText("WIP limit"), "5");
    await userEvent.click(within(row).getByRole("button", { name: "Save Review" }));

    expect(await screen.findByText("Code review saved.")).toBeInTheDocument();
    expect(writes()).toEqual([{ key: "PATCH /api/v1/projects/p-ops/statuses/s4", body: { name: "Code review", wipLimit: 5 }, ifMatch: "\"v3\"" }]);
    expect(within(screen.getByRole("group", { name: "Column Code review" })).getByLabelText("WIP limit")).toHaveValue(5);
  });

  it("clears a WIP limit with null and sends only the changed key", async () => {
    const saved = { ...KANBAN, version: 4, statuses: KANBAN.statuses.map((status) => (status.id === "s2" ? { ...status, wipLimit: null } : status)) };
    mockApi(KANBAN, { extra: { "PATCH /api/v1/projects/p-ops/statuses/s2": json(saved, 200, "\"v4\"") } });
    renderSettings();
    const row = await screen.findByRole("group", { name: "Column Ready" });
    await userEvent.clear(within(row).getByLabelText("WIP limit"));
    await userEvent.click(within(row).getByRole("button", { name: "Save Ready" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ wipLimit: null });
  });

  it("refuses a WIP limit below the cards in the column inline and keeps the old value", async () => {
    mockApi(KANBAN, {
      extra: { "PATCH /api/v1/projects/p-ops/statuses/s4": problem(409, "wip_below_occupancy", "3 cards are in this column; the limit can't be below that.") },
    });
    renderSettings();
    const row = await screen.findByRole("group", { name: "Column Review" });
    await userEvent.clear(within(row).getByLabelText("WIP limit"));
    await userEvent.type(within(row).getByLabelText("WIP limit"), "2");
    await userEvent.click(within(row).getByRole("button", { name: "Save Review" }));

    expect(await within(row).findByRole("alert")).toHaveTextContent("3 cards are in this column; the limit can't be below that.");
    expect(within(row).getByLabelText("WIP limit")).toHaveValue(3);
    expect(within(row).getByLabelText("WIP limit")).toHaveAttribute("aria-invalid", "true");
    expect(writes()).toHaveLength(1);
  });

  it("checks the column name and limit before sending", async () => {
    mockApi();
    renderSettings();
    const row = await screen.findByRole("group", { name: "Column Review" });
    await userEvent.clear(within(row).getByLabelText("Column name"));
    await userEvent.click(within(row).getByRole("button", { name: "Save Review" }));
    expect(await within(row).findByRole("alert")).toHaveTextContent("Give the column a name.");
    await userEvent.type(within(row).getByLabelText("Column name"), "Review");
    await userEvent.clear(within(row).getByLabelText("WIP limit"));
    await userEvent.type(within(row).getByLabelText("WIP limit"), "100");
    await userEvent.click(within(row).getByRole("button", { name: "Save Review" }));
    expect(await within(row).findByRole("alert")).toHaveTextContent("Use a whole number from 1 to 99, or leave it empty for no limit.");
    expect(writes()).toEqual([]);
  });

  it("shows a taken column name inline", async () => {
    mockApi(KANBAN, { extra: { "PATCH /api/v1/projects/p-ops/statuses/s4": problem(409, "name_taken", "Another column in this project already has that name.") } });
    renderSettings();
    const row = await screen.findByRole("group", { name: "Column Review" });
    await userEvent.clear(within(row).getByLabelText("Column name"));
    await userEvent.type(within(row).getByLabelText("Column name"), "Ready");
    await userEvent.click(within(row).getByRole("button", { name: "Save Review" }));
    expect(await within(row).findByRole("alert")).toHaveTextContent("Another column in this project already has that name.");
  });

  it("shows a teammate's newer columns on 412 and saves again with the fresh version", async () => {
    const current = { ...KANBAN, version: 4, statuses: KANBAN.statuses.map((status) => (status.id === "s4" ? { ...status, wipLimit: 6 } : status)) };
    let attempt = 0;
    mockApi(KANBAN, {
      extra: {
        "PATCH /api/v1/projects/p-ops/statuses/s4": (init) => {
          attempt += 1;
          return attempt === 1
            ? problem(412, "version_mismatch", "The resource changed since you loaded it.", { current })(init)
            : json({ ...current, version: 5, statuses: current.statuses.map((status) => (status.id === "s4" ? { ...status, wipLimit: 7 } : status)) }, 200, "\"v5\"")(init);
        },
      },
    });
    renderSettings();
    const row = await screen.findByRole("group", { name: "Column Review" });
    await userEvent.clear(within(row).getByLabelText("WIP limit"));
    await userEvent.type(within(row).getByLabelText("WIP limit"), "7");
    await userEvent.click(within(row).getByRole("button", { name: "Save Review" }));

    expect(await within(row).findByRole("alert")).toHaveTextContent("Updated by a teammate — review the latest values and save again.");
    expect(within(row).getByLabelText("WIP limit")).toHaveValue(6);
    await userEvent.clear(within(row).getByLabelText("WIP limit"));
    await userEvent.type(within(row).getByLabelText("WIP limit"), "7");
    await userEvent.click(within(row).getByRole("button", { name: "Save Review" }));
    expect(await screen.findByText("Review saved.")).toBeInTheDocument();
    expect(writes().map((call) => call.ifMatch)).toEqual(["\"v3\"", "\"v4\""]);
  });

  describe("General", () => {
    it("saves settings with If-Match and confirms in a toast", async () => {
      mockApi(KANBAN, { extra: { "PATCH /api/v1/projects/p-ops": json({ ...KANBAN, name: "Ops help desk", version: 4 }, 200, "\"v4\"") } });
      renderSettings();
      const general = await screen.findByRole("region", { name: "General" });
      const name = within(general).getByLabelText("Project name");
      expect(name).toHaveValue("Ops desk");
      expect(within(general).queryByLabelText("Sprint length")).not.toBeInTheDocument();
      await userEvent.clear(name);
      await userEvent.type(name, "Ops help desk");
      await userEvent.click(within(general).getByRole("button", { name: "Save changes" }));
      expect((await screen.findByText("Project settings saved.")).closest("[aria-live]")).not.toBeNull();
      expect(writes()).toEqual([{ key: "PATCH /api/v1/projects/p-ops", body: { name: "Ops help desk" }, ifMatch: "\"v3\"" }]);
      expect(screen.getByRole("heading", { level: 1, name: "Ops help desk" })).toBeInTheDocument();
    });

    it("offers the sprint length for Scrum projects", async () => {
      mockApi(SCRUM, { extra: { "PATCH /api/v1/projects/p-atlas": json({ ...SCRUM, sprintLengthDays: 21, version: 4 }, 200, "\"v4\"") } });
      renderSettings("ATLAS");
      const general = await screen.findByRole("region", { name: "General" });
      await userEvent.selectOptions(within(general).getByLabelText("Sprint length"), "3 weeks");
      await userEvent.click(within(general).getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0].body).toEqual({ sprintLengthDays: 21 });
    });

    it("shows a teammate's newer values on 412 and saves again with the fresh version", async () => {
      const current = { ...KANBAN, name: "Ops desk (renamed)", description: "Changed elsewhere.", version: 4 };
      let attempt = 0;
      mockApi(KANBAN, {
        extra: {
          "PATCH /api/v1/projects/p-ops": (init) => {
            attempt += 1;
            return attempt === 1
              ? problem(412, "version_mismatch", "The resource changed since you loaded it.", { current })(init)
              : json({ ...current, name: "Ops desk 2", version: 5 }, 200, "\"v5\"")(init);
          },
        },
      });
      renderSettings();
      const general = await screen.findByRole("region", { name: "General" });
      await userEvent.clear(within(general).getByLabelText("Project name"));
      await userEvent.type(within(general).getByLabelText("Project name"), "Ops desk 2");
      await userEvent.click(within(general).getByRole("button", { name: "Save changes" }));

      expect(await within(general).findByText("Updated by a teammate — review the latest values and save again.")).toBeInTheDocument();
      expect(within(general).getByLabelText("Project name")).toHaveValue("Ops desk (renamed)");
      expect(within(general).getByLabelText("Description")).toHaveValue("Changed elsewhere.");

      await userEvent.clear(within(general).getByLabelText("Project name"));
      await userEvent.type(within(general).getByLabelText("Project name"), "Ops desk 2");
      await userEvent.click(within(general).getByRole("button", { name: "Save changes" }));
      expect(await screen.findByText("Project settings saved.")).toBeInTheDocument();
      expect(writes().map((call) => call.ifMatch)).toEqual(["\"v3\"", "\"v4\""]);
      expect(writes()[1].body).toEqual({ name: "Ops desk 2" });
    });
  });

  describe("General after a change from outside the form", () => {
    const renamed = { ...KANBAN, name: "Ops desk (renamed)", version: 4, statuses: KANBAN.statuses.map((status) => (status.id === "s4" ? { ...status, wipLimit: 6 } : status)) };
    /** A column save answered with 412: the page now holds the teammate's renamed project. */
    async function columnConflict() {
      const row = await screen.findByRole("group", { name: "Column Review" });
      await userEvent.clear(within(row).getByLabelText("WIP limit"));
      await userEvent.type(within(row).getByLabelText("WIP limit"), "7");
      await userEvent.click(within(row).getByRole("button", { name: "Save Review" }));
      await within(row).findByText("Updated by a teammate — review the latest values and save again.");
    }
    const staleColumn = { "PATCH /api/v1/projects/p-ops/statuses/s4": problem(412, "version_mismatch", "The resource changed since you loaded it.", { current: renamed }) };

    it("shows the teammate's values in untouched fields, so saving doesn't overwrite them", async () => {
      mockApi(KANBAN, { extra: { ...staleColumn, "PATCH /api/v1/projects/p-ops": json({ ...renamed, version: 5 }, 200, "\"v5\"") } });
      renderSettings();
      const general = await screen.findByRole("region", { name: "General" });
      await columnConflict();
      expect(within(general).getByLabelText("Project name")).toHaveValue("Ops desk (renamed)");
      await userEvent.click(within(general).getByRole("button", { name: "Save changes" }));
      expect(await within(general).findByText("Nothing to save — no field changed.")).toBeInTheDocument();
      expect(writes().filter((call) => call.key === "PATCH /api/v1/projects/p-ops")).toEqual([]);
    });

    it("keeps the user's own edits and sends only them with the fresh version", async () => {
      mockApi(KANBAN, { extra: { ...staleColumn, "PATCH /api/v1/projects/p-ops": json({ ...renamed, description: "Support and IT.", version: 5 }, 200, "\"v5\"") } });
      renderSettings();
      const general = await screen.findByRole("region", { name: "General" });
      await userEvent.clear(within(general).getByLabelText("Description"));
      await userEvent.type(within(general).getByLabelText("Description"), "Support and IT.");
      await columnConflict();
      expect(within(general).getByLabelText("Description")).toHaveValue("Support and IT.");
      expect(within(general).queryByText("Updated by a teammate — review the latest values and save again.")).not.toBeInTheDocument();
      await userEvent.click(within(general).getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(writes().filter((call) => call.key === "PATCH /api/v1/projects/p-ops")).toHaveLength(1));
      expect(writes().find((call) => call.key === "PATCH /api/v1/projects/p-ops")).toEqual({ key: "PATCH /api/v1/projects/p-ops", body: { description: "Support and IT." }, ifMatch: "\"v4\"" });
    });

    it("warns when the user's edit collides with the teammate's change", async () => {
      mockApi(KANBAN, { extra: staleColumn });
      renderSettings();
      const general = await screen.findByRole("region", { name: "General" });
      await userEvent.clear(within(general).getByLabelText("Project name"));
      await userEvent.type(within(general).getByLabelText("Project name"), "Ops helpdesk");
      await columnConflict();
      expect(within(general).getByText("Updated by a teammate — review the latest values and save again.")).toBeInTheDocument();
      expect(within(general).getByLabelText("Project name")).toHaveValue("Ops helpdesk");
    });
  });

  describe("authority", () => {
    it("hides the Settings tab from a member who does not lead the project", async () => {
      auth.user = MEMBER;
      mockApi(KANBAN, { role: "member" });
      navigation.pathname = "/w/northstar-labs/p/OPS/overview";
      navigation.params = { slug: "northstar-labs", key: "OPS" };
      render(<WorkspaceLayout><ProjectLayout><p>Overview</p></ProjectLayout></WorkspaceLayout>);
      const tabs = await screen.findByRole("navigation", { name: "Project views" });
      expect(within(tabs).getAllByRole("link").map((link) => link.textContent)).toEqual(["Board", "Overview", "Insights"]);
      expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
    });

    it("shows the Settings tab to the project lead even as a plain member", async () => {
      mockApi({ ...KANBAN, lead: { id: "u-avery", displayName: "Avery Founder" } }, { role: "member" });
      renderSettings();
      const tabs = await screen.findByRole("navigation", { name: "Project views" });
      expect(within(tabs).getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/w/northstar-labs/p/OPS/settings");
      expect(await screen.findByRole("button", { name: "Switch methodology" })).toBeInTheDocument();
    });

    it("shows a member who opens Settings directly the columns and history read-only", async () => {
      auth.user = MEMBER;
      mockApi(KANBAN, { role: "member" });
      renderSettings();
      expect(await screen.findByText("Only owners, admins and the project lead can change the plan.")).toBeInTheDocument();
      const columns = screen.getByRole("region", { name: "Board columns" });
      expect(await within(columns).findByText("3 cards")).toBeInTheDocument();
      expect(within(columns).getByText("WIP 3")).toBeInTheDocument();
      expect(within(columns).queryByRole("textbox")).not.toBeInTheDocument();
      expect(within(columns).queryByRole("button")).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "General" })).not.toBeInTheDocument();
      expect(await screen.findByRole("list", { name: "Methodology history" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Switch methodology" })).not.toBeInTheDocument();
      expect(writes()).toEqual([]);
    });
  });
});
