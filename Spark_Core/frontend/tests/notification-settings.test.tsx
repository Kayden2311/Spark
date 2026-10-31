import { render, screen, waitFor } from "@testing-library/react";
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
  usePathname: () => "/settings/notifications",
  useSearchParams: () => new URLSearchParams(window.location.search),
  useParams: () => ({}),
}));
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));

import NotificationSettingsPage from "../src/app/settings/notifications/page";
import { resetUnreadCountForTests } from "../src/app/_lib/use-unread-count";

let puts: unknown[] = [];
let putStatus = 200;
let stored = { email: { taskAssigned: true, dueReminders: true, weeklyDigest: false }, timezone: "Europe/Berlin" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  resetUnreadCountForTests();
  puts = [];
  putStatus = 200;
  stored = { email: { taskAssigned: true, dueReminders: true, weeklyDigest: false }, timezone: "Europe/Berlin" };
  auth.isAuthenticated = true;
  router.replace.mockClear();
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ timeZone: "Asia/Tokyo" } as Intl.ResolvedDateTimeFormatOptions);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/v1/notifications/unread-count") return json({ count: 0 });
    if (init?.method === "PUT") {
      puts.push(JSON.parse(String(init.body)));
      if (putStatus === 400) return json({ code: "invalid_input", detail: "Unknown time zone." }, 400);
      return json(puts.at(-1));
    }
    return json(stored);
  }));
});

afterEach(() => {
  resetUnreadCountForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("email notification settings", () => {
  it("loads and shows the stored values", async () => {
    render(<NotificationSettingsPage />);
    const assigned = await screen.findByRole("switch", { name: "Task assigned to me" });
    expect(assigned).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Due-soon and overdue reminders — daily at 8:00" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Weekly digest — Mondays at 8:00" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByLabelText("Time zone")).toHaveValue("Europe/Berlin");
    expect(screen.getByText(/Invitations and account emails are always sent/)).toBeInTheDocument();
  });

  it("keeps Save disabled until something changes, then sends the exact body", async () => {
    const user = userEvent.setup();
    render(<NotificationSettingsPage />);
    const save = await screen.findByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole("switch", { name: "Weekly digest — Mondays at 8:00" }));
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ email: { taskAssigned: true, dueReminders: true, weeklyDigest: true }, timezone: "Europe/Berlin" });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(save).toBeDisabled();
  });

  it("shows the API's invalid zone message inline", async () => {
    putStatus = 400;
    const user = userEvent.setup();
    render(<NotificationSettingsPage />);
    const zone = await screen.findByLabelText("Time zone");
    await user.clear(zone);
    await user.type(zone, "Mars/Base");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Unknown time zone.")).toBeInTheDocument();
    expect(zone).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("fills the field with the browser's zone", async () => {
    const user = userEvent.setup();
    render(<NotificationSettingsPage />);
    await user.click(await screen.findByRole("button", { name: "Use my browser's zone (Asia/Tokyo)" }));
    expect(screen.getByLabelText("Time zone")).toHaveValue("Asia/Tokyo");
    expect(screen.queryByRole("button", { name: /Use my browser's zone/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("operates the switches with Space and Enter", async () => {
    const user = userEvent.setup();
    render(<NotificationSettingsPage />);
    const assigned = await screen.findByRole("switch", { name: "Task assigned to me" });
    assigned.focus();
    await user.keyboard(" ");
    expect(assigned).toHaveAttribute("aria-checked", "false");
    await user.keyboard("{Enter}");
    expect(assigned).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("redirects to login when signed out", async () => {
    auth.isAuthenticated = false;
    render(<NotificationSettingsPage />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login?redirect=%2Fsettings%2Fnotifications"));
  });
});
