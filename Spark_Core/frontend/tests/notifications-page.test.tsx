import { render, screen, waitFor, within } from "@testing-library/react";
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
let pages: Array<{ items: unknown[]; nextCursor: string | null }> = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  urls = [];
  patches = [];
  unread = 2;
  listFail = false;
  window.history.replaceState(null, "", "/notifications");
  router.push.mockClear();
  router.replace.mockClear();
  pages = [{ items: [item(3, { workspace: orbit, link: null }), item(2), item(1, { readAt: "2026-10-31T09:00:00.000Z" })], nextCursor: null }];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      patches.push({ url, body: JSON.parse(String(init.body)) });
      return url === "/api/v1/notifications" ? json({ updated: 2 }) : new Response(null, { status: 204 });
    }
    if (url === "/api/v1/notifications/unread-count") return json({ count: unread });
    urls.push(url);
    if (listFail) return json({ code: "boom" }, 500);
    return json(pages.shift() ?? { items: [], nextCursor: null });
  }));
});

afterEach(() => {
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
    await user.click(screen.getByRole("tab", { name: "Unread" }));
    await waitFor(() => expect(urls.at(-1)).toBe("/api/v1/notifications?limit=30&unread=true"));
    expect(window.location.search).toBe("?filter=unread");
    expect(screen.getByRole("tab", { name: "Unread" })).toHaveAttribute("aria-selected", "true");
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
  });

  it("loads more with the cursor and appends", async () => {
    pages = [{ items: [item(3), item(2)], nextCursor: "CUR" }, { items: [item(1)], nextCursor: null }];
    const user = userEvent.setup();
    render(<NotificationsPage />);
    await screen.findByRole("list", { name: "Notifications" });
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));
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
    unread = 0;
    render(<NotificationsPage />);
    await screen.findByRole("list", { name: "Notifications" });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/v1/notifications/unread-count", expect.anything()));
    expect(screen.queryByLabelText(/unread notification/u)).toBeNull();
  });

  it("shows a count in the badge", async () => {
    unread = 7;
    render(<NotificationsPage />);
    expect(await screen.findByLabelText("7 unread notifications")).toHaveTextContent("7");
  });
});
