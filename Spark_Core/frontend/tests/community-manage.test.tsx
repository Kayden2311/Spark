import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detail, json, stubFetch, type Route } from "./community-fixtures";
import type { CommunityDetail } from "../src/app/communities/types";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/communities/northstar-founders/manage" }));

const auth = { isAuthenticated: true, isLoading: false, user: { id: "u-owner" } as null | { id: string } };
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));

import { ManageCommunity } from "../src/app/communities/[slug]/manage/manage-view";
import { REQUEST_GONE } from "../src/app/communities/[slug]/manage/requests-tab";

const RESTRICTED = "Only community owners and moderators can manage this community";

const requestRow = (id: string, name: string, message: string | null = "We build climate software.") => ({
  id,
  requester: { id: `u-${id}`, displayName: name },
  message,
  status: "pending",
  createdAt: "2026-11-02T09:00:00.000Z",
  reviewedAt: null,
});

const memberRow = (userId: string, displayName: string, role: string) => ({ userId, displayName, avatarUrl: null, role, joinedAt: "2026-10-05T10:00:00.000Z" });

function manager(overrides: Partial<CommunityDetail> = {}) {
  return detail({ visibility: "private", viewerStatus: "owner", canManage: true, canGovern: true, version: 3, ...overrides });
}

/** Serves the community detail plus whatever the test adds; the detail handler runs last. */
function serve(community: CommunityDetail | null, extra?: Route) {
  return stubFetch((url, init) => {
    const handled = extra?.(url, init);
    if (handled) return handled;
    if (url.pathname === "/api/v1/communities/northstar-founders" && (init.method ?? "GET") === "GET") {
      return community ? json(community, 200, { ETag: `"v${community.version}"` }) : json({ code: "community_not_found", detail: "Community not found." }, 404);
    }
    if (url.pathname === "/api/v1/communities/c-northstar/requests") return json({ items: [] });
    if (url.pathname === "/api/v1/communities/c-northstar/members" && (init.method ?? "GET") === "GET") return json({ items: [] });
    return undefined;
  });
}

async function openTab(name: string) {
  await userEvent.click(await screen.findByRole("tab", { name: new RegExp(`^${name}`) }));
}

describe("community manage page", () => {
  beforeEach(() => {
    auth.isAuthenticated = true;
    auth.isLoading = false;
    auth.user = { id: "u-owner" };
    router.push.mockClear();
    router.replace.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("refuses people who cannot manage the community", async () => {
    const { calls } = serve(detail({ viewerStatus: "member", canManage: false }));
    render(<ManageCommunity slug="northstar-founders" />);
    expect(await screen.findByText(RESTRICTED)).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the community" })).toHaveAttribute("href", "/communities/northstar-founders");
    expect(calls.some((call) => call.path.endsWith("/requests"))).toBe(false);
  });

  it("keeps the page when a list answers 403, with an inline error in that tab", async () => {
    serve(manager(), (url) =>
      url.pathname === "/api/v1/communities/c-northstar/requests" ? json({ code: "insufficient_role", detail: "You can't manage this community." }, 403) : undefined,
    );
    render(<ManageCommunity slug="northstar-founders" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("You can't manage this community.");
    expect(screen.getByRole("tab", { name: "Requests" })).toBeInTheDocument();
    expect(screen.queryByText(RESTRICTED)).not.toBeInTheDocument();
  });

  it("keeps the page when one decision answers 403 or 404, with an inline error", async () => {
    serve(manager(), (url, init) => {
      if (url.pathname === "/api/v1/communities/c-northstar/requests") return json({ items: [requestRow("r1", "Dana Requester"), requestRow("r2", "Eli Quiet")] });
      if (url.pathname === "/api/v1/community-requests/r1/decision" && init.method === "POST") return json({ code: "insufficient_role", detail: "You can't decide requests here." }, 403);
      if (url.pathname === "/api/v1/community-requests/r2/decision" && init.method === "POST") return json({ code: "community_not_found", detail: "Community not found." }, 404);
      return undefined;
    });
    render(<ManageCommunity slug="northstar-founders" />);
    await userEvent.click(await screen.findByRole("button", { name: "Approve Dana Requester" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You can't decide requests here.");
    expect(screen.getByText("Dana Requester")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve Eli Quiet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Community not found.");
    expect(screen.getByText("Eli Quiet")).toBeInTheDocument();
    expect(screen.queryByText(RESTRICTED)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "This community isn't available" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Members" })).toBeInTheDocument();
  });

  it("keeps the page when removing a member answers 403, with the error in the dialog", async () => {
    serve(manager(), (url, init) => {
      if (url.pathname === "/api/v1/communities/c-northstar/members" && (init.method ?? "GET") === "GET") {
        return json({ items: [memberRow("u-owner", "Avery Owner", "owner"), memberRow("u-m", "Max Member", "member")] });
      }
      if (url.pathname === "/api/v1/communities/c-northstar/members/u-m" && init.method === "DELETE") return json({ code: "insufficient_role", detail: "You can't remove members here." }, 403);
      return undefined;
    });
    render(<ManageCommunity slug="northstar-founders" />);
    await openTab("Members");
    await userEvent.click(await screen.findByRole("button", { name: "Remove Max Member" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Max Member?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("You can't remove members here.");
    expect(screen.queryByText(RESTRICTED)).not.toBeInTheDocument();
  });

  it("sends the user to sign in when the detail load answers 401", async () => {
    serve(null, (url) =>
      url.pathname === "/api/v1/communities/northstar-founders" ? json({ code: "session_expired", detail: "Session expired or invalid." }, 401) : undefined,
    );
    render(<ManageCommunity slug="northstar-founders" />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login?redirect=%2Fcommunities%2Fnorthstar-founders%2Fmanage"));
    expect(screen.queryByText(RESTRICTED)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "We couldn't open this community" })).not.toBeInTheDocument();
  });

  it("sends the user to sign in when a decision answers 401", async () => {
    serve(manager(), (url, init) => {
      if (url.pathname === "/api/v1/communities/c-northstar/requests") return json({ items: [requestRow("r1", "Dana Requester")] });
      if (url.pathname === "/api/v1/community-requests/r1/decision" && init.method === "POST") return json({ code: "session_expired", detail: "Session expired or invalid." }, 401);
      return undefined;
    });
    render(<ManageCommunity slug="northstar-founders" />);
    await userEvent.click(await screen.findByRole("button", { name: "Approve Dana Requester" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/login?redirect=%2Fcommunities%2Fnorthstar-founders%2Fmanage"));
  });

  it("says when the community is not available", async () => {
    serve(null);
    render(<ManageCommunity slug="northstar-founders" />);
    expect(await screen.findByRole("heading", { name: "This community isn't available" })).toBeInTheDocument();
  });

  it("sends signed-out visitors to sign in and back", async () => {
    auth.isAuthenticated = false;
    auth.user = null;
    const { calls } = serve(manager());
    render(<ManageCommunity slug="northstar-founders" />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login?redirect=%2Fcommunities%2Fnorthstar-founders%2Fmanage"));
    expect(calls).toHaveLength(0);
  });

  it("lists pending requests and approves one with optimistic removal", async () => {
    let releaseDecision: () => void = () => undefined;
    const { calls } = serve(manager(), (url, init) => {
      if (url.pathname === "/api/v1/communities/c-northstar/requests") {
        return json({ items: [requestRow("r1", "Dana Requester"), requestRow("r2", "Eli Quiet", null)] });
      }
      if (url.pathname === "/api/v1/community-requests/r1/decision" && init.method === "POST") {
        return new Promise<Response>((resolve) => { releaseDecision = () => resolve(json({ status: "approved" })); }) as unknown as Response;
      }
      return undefined;
    });
    render(<ManageCommunity slug="northstar-founders" />);

    const list = await screen.findByRole("list", { name: "Pending requests" });
    const dana = within(list).getByText("Dana Requester").closest("li") as HTMLElement;
    expect(within(dana).getByText("DR")).toBeInTheDocument();
    expect(within(dana).getByText("We build climate software.")).toBeInTheDocument();
    expect(within(dana).getByText("Nov 2, 2026")).toBeInTheDocument();
    expect(within(within(list).getByText("Eli Quiet").closest("li") as HTMLElement).getByText("No message")).toBeInTheDocument();
    expect(calls.find((call) => call.path === "/api/v1/communities/c-northstar/requests")?.search.get("status")).toBe("pending");

    await userEvent.click(within(dana).getByRole("button", { name: "Approve Dana Requester" }));
    // Removed before the server answers.
    expect(within(list).queryByText("Dana Requester")).not.toBeInTheDocument();
    releaseDecision();
    expect(await screen.findByText("Dana Requester is now a member.")).toBeInTheDocument();
    expect(calls.find((call) => call.path === "/api/v1/community-requests/r1/decision")?.body).toEqual({ decision: "approve" });
  });

  it("refreshes the list when someone already decided the request", async () => {
    let listCalls = 0;
    serve(manager(), (url, init) => {
      if (url.pathname === "/api/v1/communities/c-northstar/requests") {
        listCalls += 1;
        return json({ items: listCalls === 1 ? [requestRow("r1", "Dana Requester"), requestRow("r2", "Eli Quiet")] : [requestRow("r2", "Eli Quiet")] });
      }
      if (url.pathname === "/api/v1/community-requests/r1/decision" && init.method === "POST") {
        return json({ code: "already_decided", detail: "This request was already decided." }, 409);
      }
      return undefined;
    });
    render(<ManageCommunity slug="northstar-founders" />);
    await userEvent.click(await screen.findByRole("button", { name: "Decline Dana Requester" }));

    expect(await screen.findByText("Someone already decided this request")).toBeInTheDocument();
    await waitFor(() => expect(listCalls).toBe(2));
    expect(screen.queryByText("Dana Requester")).not.toBeInTheDocument();
    expect(screen.getByText("Eli Quiet")).toBeInTheDocument();
  });

  it("drops a request that no longer exists instead of putting it back", async () => {
    serve(manager(), (url, init) => {
      if (url.pathname === "/api/v1/communities/c-northstar/requests") return json({ items: [requestRow("r1", "Dana Requester"), requestRow("r2", "Eli Quiet")] });
      if (url.pathname === "/api/v1/community-requests/r1/decision" && init.method === "POST") {
        return json({ code: "request_not_found", detail: "Join request not found." }, 404);
      }
      return undefined;
    });
    render(<ManageCommunity slug="northstar-founders" />);
    await userEvent.click(await screen.findByRole("button", { name: "Approve Dana Requester" }));
    expect(await screen.findByText(REQUEST_GONE)).toBeInTheDocument();
    expect(screen.queryByText("Dana Requester")).not.toBeInTheDocument();
    expect(screen.getByText("Eli Quiet")).toBeInTheDocument();
    expect(screen.queryByText(RESTRICTED)).not.toBeInTheDocument();
  });

  it("refreshes the member count after someone else already decided", async () => {
    let detailCalls = 0;
    serve(null, (url, init) => {
      if (url.pathname === "/api/v1/communities/northstar-founders" && (init.method ?? "GET") === "GET") {
        detailCalls += 1;
        return json(manager({ memberCount: detailCalls === 1 ? 5 : 6 }));
      }
      if (url.pathname === "/api/v1/communities/c-northstar/requests") return json({ items: detailCalls <= 1 ? [requestRow("r1", "Dana Requester")] : [] });
      if (url.pathname === "/api/v1/community-requests/r1/decision" && init.method === "POST") {
        return json({ code: "already_decided", detail: "This request was already decided." }, 409);
      }
      return undefined;
    });
    render(<ManageCommunity slug="northstar-founders" />);
    expect(await screen.findByText(/5 members/u)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Approve Dana Requester" }));
    expect(await screen.findByText("Someone already decided this request")).toBeInTheDocument();
    expect(await screen.findByText(/6 members/u)).toBeInTheDocument();
    expect(detailCalls).toBe(2);
  });

  it("puts a request back when the decision fails for another reason", async () => {
    serve(manager(), (url, init) => {
      if (url.pathname === "/api/v1/communities/c-northstar/requests") return json({ items: [requestRow("r1", "Dana Requester")] });
      if (url.pathname === "/api/v1/community-requests/r1/decision" && init.method === "POST") {
        return json({ code: "community_frozen", detail: "Frozen." }, 409);
      }
      return undefined;
    });
    render(<ManageCommunity slug="northstar-founders" />);
    await userEvent.click(await screen.findByRole("button", { name: "Approve Dana Requester" }));
    expect(await screen.findByText("This community is paused by Spark moderators.")).toBeInTheDocument();
    expect(screen.getByText("Dana Requester")).toBeInTheDocument();
  });

  it("lets owners change roles and explains the last-owner rule inline", async () => {
    const { calls } = serve(manager(), (url, init) => {
      if (url.pathname === "/api/v1/communities/c-northstar/members" && (init.method ?? "GET") === "GET") {
        return json({ items: [memberRow("u-owner", "Avery Owner", "owner"), memberRow("u-mod", "Mo Moderator", "moderator")] });
      }
      if (url.pathname === "/api/v1/communities/c-northstar/members/u-owner" && init.method === "PATCH") {
        return json({ code: "last_owner", detail: "A community must keep at least one active owner." }, 409);
      }
      return undefined;
    });
    render(<ManageCommunity slug="northstar-founders" />);
    await openTab("Members");

    const select = await screen.findByRole("combobox", { name: "Role for Avery Owner" });
    await userEvent.selectOptions(select, "member");
    expect(await screen.findByText("A community must keep at least one owner. Make someone else an owner first.")).toBeInTheDocument();
    expect(select).toHaveValue("owner");
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ role: "member" });
  });

  it("shows role pills to moderators and lets them remove plain members only", async () => {
    const { calls } = serve(manager({ viewerStatus: "moderator", canGovern: false }), (url, init) => {
      if (url.pathname === "/api/v1/communities/c-northstar/members" && (init.method ?? "GET") === "GET") {
        return json({ items: [memberRow("u-owner", "Avery Owner", "owner"), memberRow("u-mod", "Mo Moderator", "moderator"), memberRow("u-m", "Max Member", "member")] });
      }
      if (url.pathname === "/api/v1/communities/c-northstar/members/u-m" && init.method === "DELETE") return new Response(null, { status: 204 });
      return undefined;
    });
    auth.user = { id: "u-mod" };
    render(<ManageCommunity slug="northstar-founders" />);
    await openTab("Members");

    const table = await screen.findByRole("table", { name: "Community members" });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(table).getByText("Owner")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Avery Owner" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Settings" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Remove Max Member" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Max Member?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(within(table).queryByText("Max Member")).not.toBeInTheDocument());
    expect(calls.some((call) => call.method === "DELETE" && call.path === "/api/v1/communities/c-northstar/members/u-m")).toBe(true);
  });

  it("adds people from the host workspace who are not members yet", async () => {
    let members = [memberRow("u-owner", "Avery Owner", "owner")];
    const { calls } = serve(manager({ visibility: "hidden" }), (url, init) => {
      if (url.pathname === "/api/v1/communities/c-northstar/members" && (init.method ?? "GET") === "GET") return json({ items: members });
      if (url.pathname === "/api/v1/communities/c-northstar/member-candidates") {
        return json({ items: [{ userId: "u-blake", displayName: "Blake Rivers", avatarUrl: null }, { userId: "u-casey", displayName: "Casey Lane", avatarUrl: null }] });
      }
      if (url.pathname === "/api/v1/communities/c-northstar/members" && init.method === "POST") {
        const added = memberRow("u-blake", "Blake Rivers", "member");
        members = [...members, added];
        return json(added, 201);
      }
      return undefined;
    });
    render(<ManageCommunity slug="northstar-founders" />);
    await openTab("Members");
    await userEvent.click(await screen.findByRole("button", { name: "Add from workspace" }));

    const dialog = await screen.findByRole("dialog", { name: "Add from Northstar Labs" });
    const picker = await within(dialog).findByRole("list", { name: "Workspace members" });
    expect(within(picker).getAllByRole("listitem")).toHaveLength(2);
    expect(within(picker).queryByText("Avery Owner")).not.toBeInTheDocument();

    await userEvent.click(within(picker).getByRole("button", { name: "Add Blake Rivers" }));
    await waitFor(() => expect(within(picker).queryByText("Blake Rivers")).not.toBeInTheDocument());
    expect(calls.find((call) => call.method === "POST" && call.path === "/api/v1/communities/c-northstar/members")?.body).toEqual({ userId: "u-blake" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(await within(screen.getByRole("table", { name: "Community members" })).findByText("Blake Rivers")).toBeInTheDocument();
  });

  it("saves settings with If-Match and only the changed fields", async () => {
    const { calls } = serve(manager(), (url, init) => {
      if (url.pathname === "/api/v1/communities/c-northstar" && init.method === "PATCH") {
        return json(manager({ tagline: "Founders shipping B2B software.", version: 4 }), 200, { ETag: '"v4"' });
      }
      return undefined;
    });
    render(<ManageCommunity slug="northstar-founders" />);
    await openTab("Settings");

    const tagline = await screen.findByRole("textbox", { name: "Tagline" });
    await userEvent.clear(tagline);
    await userEvent.type(tagline, "Founders shipping B2B software.");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Settings saved.")).toBeInTheDocument();
    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.body).toEqual({ tagline: "Founders shipping B2B software." });
    const init = (vi.mocked(fetch).mock.calls.find(([, options]) => options?.method === "PATCH")?.[1] ?? {}) as RequestInit;
    expect((init.headers as Record<string, string>)["If-Match"]).toBe('"v3"');
  });

  it("reloads a teammate's newer settings on 412", async () => {
    let patches = 0;
    const { fetchMock } = serve(manager(), (url, init) => {
      if (url.pathname === "/api/v1/communities/c-northstar" && init.method === "PATCH") {
        patches += 1;
        if (patches === 1) {
          return json({ code: "version_mismatch", detail: "The resource changed since you loaded it.", current: manager({ name: "Northstar Builders", version: 5 }) }, 412);
        }
        return json(manager({ name: "Northstar Builders", tagline: "New line.", version: 6 }), 200, { ETag: '"v6"' });
      }
      return undefined;
    });
    render(<ManageCommunity slug="northstar-founders" />);
    await openTab("Settings");

    const tagline = await screen.findByRole("textbox", { name: "Tagline" });
    await userEvent.clear(tagline);
    await userEvent.type(tagline, "New line.");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText(/Updated by a teammate/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Northstar Builders");
    expect(screen.getByRole("textbox", { name: "Tagline" })).toHaveValue("Founders building B2B software.");

    await userEvent.clear(screen.getByRole("textbox", { name: "Tagline" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Tagline" }), "New line.");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Settings saved.")).toBeInTheDocument();
    const second = fetchMock.mock.calls.filter(([, options]) => options?.method === "PATCH")[1]?.[1] as RequestInit;
    expect((second.headers as Record<string, string>)["If-Match"]).toBe('"v5"');
  });

  it("explains what a visibility change does", async () => {
    serve(manager({ visibility: "private" }));
    render(<ManageCommunity slug="northstar-founders" />);
    await openTab("Settings");
    await userEvent.click(await screen.findByRole("radio", { name: /Hidden/ }));
    expect(screen.getByText(/disappears from the directory/)).toBeInTheDocument();
  });
  it("moves between tabs with the arrow, Home and End keys", async () => {
    serve(manager());
    render(<ManageCommunity slug="northstar-founders" />);
    const requests = await screen.findByRole("tab", { name: "Requests" });
    expect(requests).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Members" })).toHaveAttribute("tabindex", "-1");
    requests.focus();

    await userEvent.keyboard("{ArrowRight}");
    const members = screen.getByRole("tab", { name: "Members" });
    expect(members).toHaveAttribute("aria-selected", "true");
    expect(members).toHaveFocus();
    expect(await screen.findByRole("button", { name: "Add from workspace" })).toBeInTheDocument();

    await userEvent.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Requests" })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Requests" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Requests" })).toHaveAttribute("aria-selected", "true");
  });

  it("lets a host workspace admin who moderates the community change roles and settings", async () => {
    serve(manager({ viewerStatus: "moderator", canGovern: true }), (url, init) =>
      url.pathname === "/api/v1/communities/c-northstar/members" && (init.method ?? "GET") === "GET"
        ? json({ items: [memberRow("u-owner", "Avery Owner", "owner"), memberRow("u-hostadmin", "Hana Admin", "moderator")] })
        : undefined,
    );
    auth.user = { id: "u-hostadmin" };
    render(<ManageCommunity slug="northstar-founders" />);
    expect(await screen.findByRole("tab", { name: "Settings" })).toBeInTheDocument();
    await openTab("Members");
    expect(await screen.findByRole("combobox", { name: "Role for Avery Owner" })).toBeInTheDocument();
  });

  it("asks the server again after changing your own role", async () => {
    let detailCalls = 0;
    serve(null, (url, init) => {
      if (url.pathname === "/api/v1/communities/northstar-founders" && (init.method ?? "GET") === "GET") {
        detailCalls += 1;
        return json(detailCalls === 1 ? manager() : manager({ viewerStatus: "moderator", canGovern: false }));
      }
      if (url.pathname === "/api/v1/communities/c-northstar/members" && (init.method ?? "GET") === "GET") {
        return json({ items: [memberRow("u-owner", "Avery Owner", "owner"), memberRow("u-other", "Olive Owner", "owner")] });
      }
      if (url.pathname === "/api/v1/communities/c-northstar/members/u-owner" && init.method === "PATCH") return json(memberRow("u-owner", "Avery Owner", "moderator"));
      return undefined;
    });
    render(<ManageCommunity slug="northstar-founders" />);
    await openTab("Members");
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Role for Avery Owner" }), "moderator");
    await waitFor(() => expect(detailCalls).toBe(2));
    await waitFor(() => expect(screen.queryByRole("tab", { name: "Settings" })).not.toBeInTheDocument());
  });
});

const REPORTS = "/api/v1/communities/c-northstar/reports";

const queueItem = (overrides: Record<string, unknown> = {}, target: Record<string, unknown> = {}) => ({
  target: { kind: "post", id: "p1", postId: "p1", title: "Buy cheap watches", excerpt: "Click here for deals", authorName: "Sam Spammer", moderation: "visible", ...target },
  openReports: 3,
  reasons: [{ reason: "spam", count: 2 }, { reason: "off_topic", count: 1 }],
  latestDetails: ["Looks like an ad"],
  firstReportedAt: "2026-11-01T09:00:00.000Z",
  lastReportedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
  ...overrides,
});

function serveReports(community: CommunityDetail, items: unknown[], extra?: Route) {
  return serve(community, (url, init) => {
    const handled = extra?.(url, init);
    if (handled) return handled;
    if (url.pathname === REPORTS && (init.method ?? "GET") === "GET") return json({ items });
    return undefined;
  });
}

describe("community manage page: Reports tab", () => {
  beforeEach(() => {
    auth.isAuthenticated = true;
    auth.isLoading = false;
    auth.user = { id: "u-owner" };
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(["owner", "moderator"] as const)("shows the tab to a community %s", async (viewerStatus) => {
    serveReports(manager({ viewerStatus }), []);
    render(<ManageCommunity slug="northstar-founders" />);
    expect(await screen.findByRole("tab", { name: "Reports" })).toBeInTheDocument();
  });

  it("hides the tab and never asks for reports for a host admin with no community role", async () => {
    const { calls } = serveReports(manager({ viewerStatus: null, canGovern: true }), []);
    render(<ManageCommunity slug="northstar-founders" />);
    expect(await screen.findByRole("tab", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Reports" })).not.toBeInTheDocument();
    expect(calls.some((call) => call.path === REPORTS)).toBe(false);
  });

  it("hides the tab from a plain member", async () => {
    serveReports(detail({ viewerStatus: "member", canManage: true }), []);
    render(<ManageCommunity slug="northstar-founders" />);
    await screen.findByRole("tab", { name: /^Requests/ });
    expect(screen.queryByRole("tab", { name: "Reports" })).not.toBeInTheDocument();
  });

  it("lists one row per reported item without ever naming a reporter", async () => {
    serveReports(manager(), [
      queueItem(),
      queueItem({ openReports: 1, reasons: [{ reason: "harassment", count: 1 }], latestDetails: [] }, { kind: "comment", id: "m1", postId: "p2", title: "Roadmap", excerpt: "You are all fools", authorName: "Rob Rude" }),
    ]);
    render(<ManageCommunity slug="northstar-founders" />);
    await openTab("Reports");
    const list = await screen.findByRole("list", { name: "Open reports" });
    const rows = [screen.getByRole("link", { name: "Buy cheap watches" }), screen.getByRole("link", { name: "You are all fools" })].map((link) => link.closest("li")!);
    expect(list.querySelectorAll(":scope > li")).toHaveLength(2);
    expect(within(rows[0]!).getByRole("link", { name: "Buy cheap watches" })).toHaveAttribute("href", "/communities/northstar-founders/posts/p1");
    expect(within(rows[0]!).getByText("Click here for deals")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Sam Spammer")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("3 open reports")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Spam ×2")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Off-topic ×1")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Looks like an ad")).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/2h ago/)).toBeInTheDocument();
    expect(within(rows[1]!).getByRole("link", { name: "You are all fools" })).toHaveAttribute("href", "/communities/northstar-founders/posts/p2");
    expect(within(rows[1]!).getByText("1 open report")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Comment")).toBeInTheDocument();
    expect(screen.queryByText(/reported by/i)).not.toBeInTheDocument();
  });

  it("says No open reports when the queue is empty", async () => {
    serveReports(manager(), []);
    render(<ManageCommunity slug="northstar-founders" />);
    await openTab("Reports");
    expect(await screen.findByText("No open reports")).toBeInTheDocument();
  });

  it("removes the row after Hide, with the reason posted to the moderation route", async () => {
    const { calls } = serveReports(manager(), [queueItem(), queueItem({}, { id: "p9", postId: "p9", title: "Second one" })], (url, init) =>
      url.pathname === "/api/v1/posts/p1/moderation" && init.method === "POST" ? json({ moderation: "hidden", reportsClosed: 3, changed: true }) : undefined,
    );
    render(<ManageCommunity slug="northstar-founders" />);
    await openTab("Reports");
    await userEvent.click((await screen.findAllByRole("button", { name: "Hide post by Sam Spammer" }))[0]!);
    expect(screen.getByRole("dialog", { name: "Hide this post" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Reason"), "Spam ad");
    await userEvent.click(screen.getByRole("button", { name: "Hide post" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Buy cheap watches" })).not.toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Second one" })).toBeInTheDocument();
    expect(calls.find((call) => call.path === "/api/v1/posts/p1/moderation")?.body).toEqual({ action: "hide", reason: "Spam ad" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("removes the row after Keep, which dismisses the reports", async () => {
    const { calls } = serveReports(manager(), [queueItem({}, { kind: "comment", id: "m1", postId: "p1", authorName: "Rob Rude", excerpt: "Fine comment" })], (url, init) =>
      url.pathname === "/api/v1/comments/m1/moderation" && init.method === "POST" ? json({ moderation: "visible", reportsClosed: 3, changed: true }) : undefined,
    );
    render(<ManageCommunity slug="northstar-founders" />);
    await openTab("Reports");
    await userEvent.click(await screen.findByRole("button", { name: "Keep comment by Rob Rude" }));
    expect(screen.getByRole("dialog", { name: "Keep and dismiss reports" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Reason"), "Within guidelines");
    await userEvent.click(screen.getByRole("button", { name: "Keep and dismiss" }));
    expect(await screen.findByText("No open reports")).toBeInTheDocument();
    expect(calls.find((call) => call.path === "/api/v1/comments/m1/moderation")?.body).toEqual({ action: "dismiss", reason: "Within guidelines" });
  });

  it("keeps the row and shows the error when moderation fails", async () => {
    serveReports(manager(), [queueItem()], (url, init) =>
      init.method === "POST" ? json({ code: "forbidden", detail: "You cannot moderate here." }, 403) : undefined,
    );
    render(<ManageCommunity slug="northstar-founders" />);
    await openTab("Reports");
    await userEvent.click(await screen.findByRole("button", { name: "Hide post by Sam Spammer" }));
    await userEvent.type(screen.getByLabelText("Reason"), "Spam ad");
    await userEvent.click(screen.getByRole("button", { name: "Hide post" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You cannot moderate here.");
    expect(screen.getByRole("link", { name: "Buy cheap watches" })).toBeInTheDocument();
  });
});
