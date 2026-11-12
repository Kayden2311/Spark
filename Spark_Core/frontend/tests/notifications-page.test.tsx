import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), push: vi.fn() };
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
  useRouter: () => router,
  usePathname: () => "/notifications",
  useSearchParams: () => new URLSearchParams(window.location.search),
  useParams: () => ({}),
}));
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));

import NotificationsPage from "../src/app/notifications/page";
import { resetUnreadCountForTests } from "../src/app/_lib/use-unread-count";

const northstar = { id: "w1", slug: "northstar-labs", name: "Northstar Labs" };
const orbit = { id: "w2", slug: "orbit-studio", name: "Orbit Studio" };
const stamp = (n: number) => `2026-10-31T10:00:0${n}.12345${n}+00:00`;
const item = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `n${n}`, kind: "task_assigned", title: `Task ${n} assigned`, body: null, resourceType: "issue", resourceId: `i${n}`,
  link: `/w/northstar-labs/p/ATLAS?issue=i${n}`, workspace: northstar, createdAt: stamp(n), readAt: null, ...extra,
});

let urls: string[] = [];
let patches: Array<{ url: string; body: unknown }> = [];
let unread = 2;
let listFail = false;
let patchStatus = 204;
let patchHangs = false;
let markAllUpdated = 2;
let pages: Array<{ items: unknown[]; nextCursor: string | null }> = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  resetUnreadCountForTests();
  urls = [];
  patches = [];
  unread = 2;
  listFail = false;
  patchStatus = 204;
  patchHangs = false;
  markAllUpdated = 2;
  window.history.replaceState(null, "", "/notifications");
  router.push.mockClear();
  router.replace.mockClear();
  pages = [{ items: [item(3, { workspace: orbit, link: null }), item(2), item(1, { readAt: "2026-10-31T09:00:00.000Z" })], nextCursor: null }];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      patches.push({ url, body: JSON.parse(String(init.body)) });
      if (patchHangs) return new Promise<Response>(() => undefined);
      if (patchStatus !== 204) return json({ code: "boom" }, patchStatus);
      return url === "/api/v1/notifications" ? json({ updated: markAllUpdated }) : new Response(null, { status: 204 });
    }
    if (url === "/api/v1/notifications/unread-count") return json({ count: unread });
    urls.push(url);
    if (listFail) return json({ code: "boom" }, 500);
    return json(pages.shift() ?? { items: [], nextCursor: null });
  }));
});

afterEach(() => {
  resetUnreadCountForTests();
  vi.unstubAllGlobals();
});

describe("notifications inbox", () => {
  it("lists notifications with workspace names", async () => {
    render(<NotificationsPage />);
    const list = await screen.findByRole("list", { name: "Notifications" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText("Orbit Studio")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Northstar Labs")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Task 3 assigned")).toBeInTheDocument();
    expect(within(rows[0]!).getByLabelText("Unread")).toBeInTheDocument();
    expect(within(rows[2]!).queryByLabelText("Unread")).toBeNull();
    expect(urls[0]).toBe("/api/v1/notifications?limit=30");
  });

  it("requests only unread notifications on the Unread tab", async () => {
    const user = userEvent.setup();
    render(<NotificationsPage />);
    await screen.findByRole("list", { name: "Notifications" });
    await user.click(screen.getByRole("button", { name: "Unread" }));
    await waitFor(() => expect(urls.at(-1)).toBe("/api/v1/notifications?limit=30&unread=true"));
    expect(window.location.search).toBe("?filter=unread");
    expect(screen.getByRole("button", { name: "Unread" })).toHaveAttribute("aria-pressed", "true");
  });

  it("reaches and selects the Unread filter from the keyboard", async () => {
    const user = userEvent.setup();
    render(<NotificationsPage />);
    await screen.findByRole("list", { name: "Notifications" });
    const unreadTab = screen.getByRole("button", { name: "Unread" });
    for (let step = 0; step < 30 && document.activeElement !== unreadTab; step += 1) await user.tab();
    expect(unreadTab).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(urls.at(-1)).toBe("/api/v1/notifications?limit=30&unread=true"));
    await user.keyboard("[Space]");
    expect(unreadTab).toHaveAttribute("aria-pressed", "true");
  });

  it("opens on the Unread tab for ?filter=unread", async () => {
    window.history.replaceState(null, "", "/notifications?filter=unread");
    render(<NotificationsPage />);
    await screen.findByRole("list", { name: "Notifications" });
    expect(urls[0]).toBe("/api/v1/notifications?limit=30&unread=true");
  });

  it("marks a row read, then follows its link", async () => {
    const user = userEvent.setup();
    render(<NotificationsPage />);
    await user.click(await screen.findByRole("button", { name: /Task 2 assigned/u }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/w/northstar-labs/p/ATLAS?issue=i2"));
    expect(patches).toEqual([{ url: "/api/v1/notifications/n2", body: { read: true } }]);
  });

  it("marks the row read before it navigates", async () => {
    const user = userEvent.setup();
    render(<NotificationsPage />);
    const order: string[] = [];
    router.push.mockImplementationOnce(() => { order.push(`push after ${patches.length} patch`); });
    await user.click(await screen.findByRole("button", { name: /Task 2 assigned/u }));
    await waitFor(() => expect(order).toEqual(["push after 1 patch"]));
  });

  it("reverts, shows a notice and still navigates when marking read fails", async () => {
    patchStatus = 500;
    const user = userEvent.setup();
    render(<NotificationsPage />);
    const row = await screen.findByRole("button", { name: /Task 2 assigned/u });
    await user.click(row);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/w/northstar-labs/p/ATLAS?issue=i2"));
    expect(await screen.findByText("That notification could not be marked as read.")).toBeInTheDocument();
    expect(within(row).getByLabelText("Unread")).toBeInTheDocument();
  });

  it("navigates once on a double click", async () => {
    const user = userEvent.setup();
    render(<NotificationsPage />);
    await user.dblClick(await screen.findByRole("button", { name: /Task 2 assigned/u }));
    await waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(patches).toHaveLength(1);
  });

  it("follows the link after a moment when the request hangs", async () => {
    patchHangs = true;
    const user = userEvent.setup();
    render(<NotificationsPage />);
    await user.click(await screen.findByRole("button", { name: /Task 2 assigned/u }));
    expect(router.push).not.toHaveBeenCalled();
    await waitFor(() => expect(router.push).toHaveBeenCalledTimes(1), { timeout: 2500 });
  });

  it("does not follow the link once the page is gone", async () => {
    patchHangs = true;
    const user = userEvent.setup();
    const { unmount } = render(<NotificationsPage />);
    await user.click(await screen.findByRole("button", { name: /Task 2 assigned/u }));
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(router.push).not.toHaveBeenCalled();
  });

  it("handles a click on another row while the first is still working", async () => {
    patchHangs = true;
    const user = userEvent.setup();
    render(<NotificationsPage />);
    await user.click(await screen.findByRole("button", { name: /Task 3 assigned/u }));
    await user.click(screen.getByRole("button", { name: /Task 2 assigned/u }));
    expect(patches.map((entry) => entry.url)).toEqual(["/api/v1/notifications/n3", "/api/v1/notifications/n2"]);
  });

  it("does not navigate after the session ended", async () => {
    patchStatus = 401;
    const user = userEvent.setup();
    render(<NotificationsPage />);
    await user.click(await screen.findByRole("button", { name: /Task 2 assigned/u }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login?redirect=%2Fnotifications"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(router.push).not.toHaveBeenCalled();
  });

  it("marks a row without a link read and stays", async () => {
    const user = userEvent.setup();
    render(<NotificationsPage />);
    const row = await screen.findByRole("button", { name: /Task 3 assigned/u });
    await user.click(row);
    await waitFor(() => expect(within(row).queryByLabelText("Unread")).toBeNull());
    expect(patches).toEqual([{ url: "/api/v1/notifications/n3", body: { read: true } }]);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("marks all as read with the newest createdAt verbatim", async () => {
    const user = userEvent.setup();
    render(<NotificationsPage />);
    await screen.findByRole("list", { name: "Notifications" });
    await user.click(screen.getByRole("button", { name: "Mark all as read" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ url: "/api/v1/notifications", body: { read: true, before: stamp(3) } });
    await waitFor(() => expect(screen.queryAllByLabelText("Unread")).toHaveLength(0));
    expect(screen.getByText("Marked 2 as read")).toBeInTheDocument();
  });

  it("reloads the list when Mark all marked nothing but unread notifications remain", async () => {
    markAllUpdated = 0;
    const user = userEvent.setup();
    render(<NotificationsPage />);
    await screen.findByRole("list", { name: "Notifications" });
    await waitFor(() => expect(screen.getByRole("button", { name: /Mark all as read/ })).toBeEnabled());
    pages = [{ items: [item(4), item(3), item(2)], nextCursor: null }];
    await user.click(screen.getByRole("button", { name: "Mark all as read" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(await screen.findByText("Task 4 assigned")).toBeInTheDocument();
    expect(urls).toHaveLength(2);
    expect(screen.queryAllByLabelText("Unread").length).toBeGreaterThan(0);
  });

  it("ignores a second Mark all click while one is running", async () => {
    const user = userEvent.setup();
    render(<NotificationsPage />);
    await screen.findByRole("list", { name: "Notifications" });
    const button = screen.getByRole("button", { name: "Mark all as read" });
    await user.dblClick(button);
    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    expect(patches).toHaveLength(1);
  });

  it("drops Load more after Mark all on the Unread tab", async () => {
    window.history.replaceState(null, "", "/notifications?filter=unread");
    pages = [{ items: [item(3), item(2)], nextCursor: "CUR" }];
    const user = userEvent.setup();
    render(<NotificationsPage />);
    await screen.findByRole("button", { name: "Load more" });
    await user.click(screen.getByRole("button", { name: "Mark all as read" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).toBeNull());
  });

  it("loads more with the cursor and appends", async () => {
    pages = [{ items: [item(3), item(2)], nextCursor: "CUR" }, { items: [item(1)], nextCursor: null }];
    const user = userEvent.setup();
    render(<NotificationsPage />);
    await screen.findByRole("list", { name: "Notifications" });
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Notifications" })).getAllByRole("listitem")).toHaveLength(3));
    expect(urls[1]).toBe("/api/v1/notifications?limit=30&cursor=CUR");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("shows the empty states", async () => {
    pages = [{ items: [], nextCursor: null }];
    const { unmount } = render(<NotificationsPage />);
    expect(await screen.findByText("No notifications yet")).toBeInTheDocument();
    unmount();
    window.history.replaceState(null, "", "/notifications?filter=unread");
    pages = [{ items: [], nextCursor: null }];
    render(<NotificationsPage />);
    expect(await screen.findByText("You're all caught up")).toBeInTheDocument();
  });

  it("shows an error with retry", async () => {
    listFail = true;
    const user = userEvent.setup();
    render(<NotificationsPage />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    listFail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("list", { name: "Notifications" })).toBeInTheDocument();
  });

  it("shows the unread badge in the navigation, capped at 99+", async () => {
    unread = 100;
    render(<NotificationsPage />);
    expect(await screen.findByLabelText("99+ unread notifications")).toHaveTextContent("99+");
  });

  it("hides the badge at zero", async () => {
    unread = 3;
    render(<NotificationsPage />);
    expect(await screen.findByLabelText("3 unread notifications")).toBeInTheDocument();
    unread = 0;
    await act(async () => { fireEvent.focus(window); });
    await waitFor(() => expect(screen.queryByLabelText(/unread notification/u)).toBeNull());
  });

  it("shows a count in the badge", async () => {
    unread = 7;
    render(<NotificationsPage />);
    expect(await screen.findByLabelText("7 unread notifications")).toHaveTextContent("7");
  });

  it("marks the collapsed mobile menu button while there are unread notifications", async () => {
    unread = 4;
    render(<NotificationsPage />);
    const toggle = screen.getByRole("button", { name: /^Menu/u });
    await waitFor(() => expect(within(toggle).getByText("4 unread")).toBeInTheDocument());
    expect(toggle.querySelector(".sidebarMenuDot")).not.toBeNull();
    await userEvent.setup().click(toggle);
    expect(screen.getByRole("button", { name: "Close" }).querySelector(".sidebarMenuDot")).toBeNull();
  });
});

describe("community notifications", () => {
  const host = { id: "w9", slug: "acme-host", name: "Acme Host" };
  const community = (n: number, kind: string, title: string, link: string) =>
    item(n, { kind, title, resourceType: "community", resourceId: "c1", link, workspace: host });

  beforeEach(() => {
    pages = [{
      items: [
        community(3, "community_request_received", "Dana Requester asked to join Climate Circle", "/communities/climate-circle/manage"),
        community(2, "community_request_approved", "Your request to join Climate Circle was approved", "/communities/climate-circle"),
        community(1, "community_request_rejected", "Your request to join Climate Circle was declined", "/communities/climate-circle"),
      ],
      nextCursor: null,
    }];
  });

  it("labels the three community kinds without presenting the host as the reader's workspace", async () => {
    render(<NotificationsPage />);
    const rows = within(await screen.findByRole("list", { name: "Notifications" })).getAllByRole("listitem");
    expect(within(rows[0]!).getByText("Join request")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Request approved")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Request declined")).toBeInTheDocument();
    for (const row of rows) {
      expect(within(row).getByText("Community · hosted by Acme Host")).toBeInTheDocument();
      expect(within(row).queryByText("AH")).toBeNull();
    }
  });

  it("opens the manage page for a join request and the community for a decision", async () => {
    const user = userEvent.setup();
    render(<NotificationsPage />);
    await user.click(await screen.findByRole("button", { name: /asked to join Climate Circle/u }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/communities/climate-circle/manage"));
    await user.click(screen.getByRole("button", { name: /was approved/u }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/communities/climate-circle"));
  });
});
