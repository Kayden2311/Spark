import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), push: vi.fn() };
const navigation = { pathname: "/w/northstar-labs/members", params: { slug: "northstar-labs" } as Record<string, string> };
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
import MembersPage from "../src/app/w/[slug]/members/page";

const workspace = { id: "w1", slug: "northstar-labs", name: "Northstar Labs", role: "owner", memberCount: 2, version: 2, createdAt: "2026-10-18T10:00:00.000Z" };
const avery = { userId: "u-avery", displayName: "Avery Founder", avatarUrl: null, email: "avery@example.com", role: "owner", joinedAt: "2026-10-01T10:00:00.000Z" };
const blake = { userId: "u-blake", displayName: "Blake Rivers", avatarUrl: null, email: "blake@example.com", role: "member", joinedAt: "2026-10-10T10:00:00.000Z" };
const pending = {
  id: "inv-1",
  email: "casey@example.com",
  role: "member",
  status: "pending",
  invitedBy: { id: "u-avery", displayName: "Avery Founder" },
  expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000 + 60_000).toISOString(),
  createdAt: "2026-10-17T10:00:00.000Z",
};

type Handler = (body: unknown) => Response;
let calls: Array<{ key: string; body: unknown }> = [];
function mockApi(routes: Record<string, Handler>) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ key, body });
    const handler = routes[key];
    return handler ? handler(body) : new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
  }));
}
const json = (payload: unknown, status = 200): Handler => () => new Response(status === 204 ? null : JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

function ownerRoutes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    "GET /api/v1/workspaces/by-slug/northstar-labs": json(workspace),
    "GET /api/v1/workspaces/w1/members": json({ items: [avery, blake] }),
    "GET /api/v1/workspaces/w1/invitations?status=pending": json({ items: [pending] }),
    ...extra,
  };
}

async function renderMembers() {
  render(<WorkspaceLayout><MembersPage /></WorkspaceLayout>);
  return screen.findByRole("table", { name: "Members" });
}

beforeEach(() => {
  auth.isAuthenticated = true;
  auth.isLoading = false;
  router.replace.mockClear();
  router.push.mockClear();
  auth.refreshSession.mockClear();
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("members page", () => {
  it("lets owners change roles and invite", async () => {
    mockApi(ownerRoutes());
    const table = await renderMembers();
    const blakeRow = within(table).getByText("Blake Rivers").closest("tr")!;
    expect(within(blakeRow).getByText("blake@example.com")).toBeInTheDocument();
    expect(within(blakeRow).getByRole("combobox", { name: "Role for Blake Rivers" })).toHaveValue("member");
    expect(within(blakeRow).getByRole("button", { name: "Remove Blake Rivers" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invite people" })).toBeInTheDocument();
    const averyRow = within(table).getByText("Avery Founder").closest("tr")!;
    expect(within(averyRow).getByRole("button", { name: "Leave workspace" })).toBeInTheDocument();
    expect(within(averyRow).queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
  });

  it("shows plain members neither role controls nor invitations, but lets them leave", async () => {
    auth.user = { ...auth.user, id: "u-blake", displayName: "Blake Rivers", email: "blake@example.com" };
    mockApi({
      "GET /api/v1/workspaces/by-slug/northstar-labs": json({ ...workspace, role: "member" }),
      "GET /api/v1/workspaces/w1/members": json({ items: [{ ...avery, email: null }, { ...blake, email: null }] }),
    });
    const table = await renderMembers();
    expect(within(table).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(table).queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Invite people" })).not.toBeInTheDocument();
    expect(within(table).getByText("Owner", { selector: ".wsRole" })).toBeInTheDocument();
    const own = within(table).getByText("Blake Rivers").closest("tr")!;
    expect(within(own).getByRole("button", { name: "Leave workspace" })).toBeInTheDocument();
    const other = within(table).getByText("Avery Founder").closest("tr")!;
    expect(within(other).queryByRole("button", { name: "Leave workspace" })).not.toBeInTheDocument();
    expect(calls.some((call) => call.key.includes("/invitations"))).toBe(false);
    auth.user = { id: "u-avery", displayName: "Avery Founder", email: "avery@example.com", avatarUrl: null };
  });

  it("explains that the last owner cannot be demoted", async () => {
    mockApi(ownerRoutes({
      "PATCH /api/v1/workspaces/w1/members/u-avery": json({ code: "last_owner", detail: "A workspace must keep at least one active owner." }, 409),
    }));
    const table = await renderMembers();
    const select = within(table).getByRole("combobox", { name: "Role for Avery Founder" });
    await userEvent.selectOptions(select, "member");
    const dialog = await screen.findByRole("dialog", { name: "Change your own role?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Change my role" }));
    expect(await screen.findByText("A workspace needs at least one owner.")).toBeInTheDocument();
    expect(calls.find((call) => call.key === "PATCH /api/v1/workspaces/w1/members/u-avery")?.body).toEqual({ role: "member" });
    await waitFor(() => expect(select).toHaveValue("owner"));
  });

  it("asks an owner to confirm before giving up their own owner role, and cancel keeps it", async () => {
    mockApi(ownerRoutes({ "PATCH /api/v1/workspaces/w1/members/u-avery": json({ ...avery, role: "admin" }) }));
    const table = await renderMembers();
    const select = within(table).getByRole("combobox", { name: "Role for Avery Founder" });
    await userEvent.selectOptions(select, "admin");
    const dialog = await screen.findByRole("dialog", { name: "Change your own role?" });
    expect(dialog).toHaveTextContent("You'll lose owner rights");
    expect(calls.some((call) => call.key.startsWith("PATCH"))).toBe(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(select).toHaveValue("owner");
    expect(calls.some((call) => call.key.startsWith("PATCH"))).toBe(false);

    await userEvent.selectOptions(select, "admin");
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Change your own role?" })).getByRole("button", { name: "Change my role" }));
    await waitFor(() => expect(calls.find((call) => call.key === "PATCH /api/v1/workspaces/w1/members/u-avery")?.body).toEqual({ role: "admin" }));
  });

  it("changes a role and reloads the list", async () => {
    mockApi(ownerRoutes({ "PATCH /api/v1/workspaces/w1/members/u-blake": json({ ...blake, role: "admin" }) }));
    const table = await renderMembers();
    await userEvent.selectOptions(within(table).getByRole("combobox", { name: "Role for Blake Rivers" }), "admin");
    await waitFor(() => expect(calls.filter((call) => call.key === "GET /api/v1/workspaces/w1/members")).toHaveLength(2));
  });

  it("removes a member after confirmation", async () => {
    mockApi(ownerRoutes({ "DELETE /api/v1/workspaces/w1/members/u-blake": json(null, 204) }));
    const table = await renderMembers();
    await userEvent.click(within(table).getByRole("button", { name: "Remove Blake Rivers" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Blake Rivers?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(calls.some((call) => call.key === "DELETE /api/v1/workspaces/w1/members/u-blake")).toBe(true));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("leaves the workspace, refreshes the session and goes to /workspace", async () => {
    mockApi(ownerRoutes({ "DELETE /api/v1/workspaces/w1/members/u-avery": json(null, 204) }));
    const table = await renderMembers();
    await userEvent.click(within(table).getByRole("button", { name: "Leave workspace" }));
    const dialog = await screen.findByRole("dialog", { name: "Leave Northstar Labs?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Leave workspace" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/workspace"));
    expect(auth.refreshSession).toHaveBeenCalled();
  });

  it("falls back to the not-found state when access was removed meanwhile", async () => {
    let removed = false;
    mockApi({
      "GET /api/v1/workspaces/by-slug/northstar-labs": () => (removed ? json({ code: "workspace_not_found" }, 404) : json(workspace))(undefined),
      "GET /api/v1/workspaces/w1/members": () => {
        removed = true;
        return json({ code: "workspace_not_found" }, 404)(undefined);
      },
      "GET /api/v1/workspaces/w1/invitations?status=pending": json({ items: [] }),
    });
    render(<WorkspaceLayout><MembersPage /></WorkspaceLayout>);
    expect(await screen.findByRole("heading", { name: "This workspace isn't available to you" })).toBeInTheDocument();
    await waitFor(() => expect(auth.refreshSession).toHaveBeenCalled());
  });

  it("lists pending invitations with expiry and resends through the resend endpoint", async () => {
    mockApi(ownerRoutes({ "POST /api/v1/workspaces/w1/invitations/inv-1/resend": json({ invitation: pending }, 202) }));
    await renderMembers();
    const panel = await screen.findByRole("region", { name: "Pending invitations" });
    const row = (await within(panel).findByText("casey@example.com")).closest("li")!;
    expect(within(row).getByText("Expires in 5 days")).toBeInTheDocument();
    // One polite live region is always mounted, so the announcement is not lost when the toast appears.
    const live = screen.getByRole("status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toBeEmptyDOMElement();
    await userEvent.click(within(row).getByRole("button", { name: "Resend invitation to casey@example.com" }));
    await waitFor(() => expect(live).toHaveTextContent("New link sent; the previous link no longer works."));
    expect(screen.getByRole("status")).toBe(live);
    expect(calls.some((call) => call.key === "POST /api/v1/workspaces/w1/invitations/inv-1/resend")).toBe(true);
  });

  it("hides resend and revoke on admin invitations from admins, who may not settle them", async () => {
    const adminInvite = { ...pending, id: "inv-2", email: "dana@example.com", role: "admin" };
    mockApi(ownerRoutes({
      "GET /api/v1/workspaces/by-slug/northstar-labs": json({ ...workspace, role: "admin" }),
      "GET /api/v1/workspaces/w1/invitations?status=pending": json({ items: [pending, adminInvite] }),
    }));
    await renderMembers();
    const panel = await screen.findByRole("region", { name: "Pending invitations" });
    const adminRow = (await within(panel).findByText("dana@example.com")).closest("li")!;
    expect(within(adminRow).queryByRole("button")).not.toBeInTheDocument();
    const memberRow = within(panel).getByText("casey@example.com").closest("li")!;
    expect(within(memberRow).getByRole("button", { name: "Resend invitation to casey@example.com" })).toBeInTheDocument();
    expect(within(memberRow).getByRole("button", { name: "Revoke invitation to casey@example.com" })).toBeInTheDocument();
  });

  it("revokes a pending invitation", async () => {
    mockApi(ownerRoutes({ "DELETE /api/v1/workspaces/w1/invitations/inv-1": json(null, 204) }));
    await renderMembers();
    const panel = await screen.findByRole("region", { name: "Pending invitations" });
    await userEvent.click(await within(panel).findByRole("button", { name: "Revoke invitation to casey@example.com" }));
    await waitFor(() => expect(calls.some((call) => call.key === "DELETE /api/v1/workspaces/w1/invitations/inv-1")).toBe(true));
  });
});

describe("invite dialog", () => {
  it("sends the invitation and confirms without ever showing a link or token", async () => {
    const created = { ...pending, id: "inv-2", email: "dana@example.com", role: "admin" };
    mockApi(ownerRoutes({ "POST /api/v1/workspaces/w1/invitations": json({ invitation: created }, 201) }));
    await renderMembers();
    await userEvent.click(screen.getByRole("button", { name: "Invite people" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite people" });
    await userEvent.type(within(dialog).getByLabelText("Email address"), "dana@example.com");
    await userEvent.selectOptions(within(dialog).getByLabelText("Role"), "admin");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send invitation" }));
    expect(await within(dialog).findByText("Invitation sent to dana@example.com. The link works once and expires in 7 days.")).toBeInTheDocument();
    expect(calls.find((call) => call.key === "POST /api/v1/workspaces/w1/invitations")?.body).toEqual({ email: "dana@example.com", role: "admin" });
    expect(document.body.textContent).not.toMatch(/[0-9a-f]{64}|token=|#token/u);
    expect(within(dialog).queryByRole("link")).not.toBeInTheDocument();
  });

  it("maps conflicts to inline messages", async () => {
    mockApi(ownerRoutes({ "POST /api/v1/workspaces/w1/invitations": json({ code: "invitation_pending", detail: "A pending invitation already exists for that email." }, 409) }));
    await renderMembers();
    await userEvent.click(screen.getByRole("button", { name: "Invite people" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite people" });
    await userEvent.type(within(dialog).getByLabelText("Email address"), "casey@example.com");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send invitation" }));
    expect(await within(dialog).findByText(/already has a pending invitation/)).toBeInTheDocument();
  });

  it("only offers the member role to admins", async () => {
    mockApi(ownerRoutes({ "GET /api/v1/workspaces/by-slug/northstar-labs": json({ ...workspace, role: "admin" }) }));
    await renderMembers();
    await userEvent.click(screen.getByRole("button", { name: "Invite people" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite people" });
    const role = within(dialog).getByLabelText("Role");
    expect(within(role).getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual(["member"]);
  });
});
