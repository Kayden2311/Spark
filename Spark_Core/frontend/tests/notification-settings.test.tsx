import { act, render, screen, waitFor } from "@testing-library/react";
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
let getStatus = 200;
let putGate: Promise<void> | null = null;
let stored = { email: { taskAssigned: true, dueReminders: true, weeklyDigest: false }, timezone: "Europe/Berlin" };

const ZONE_COPY = "That time zone is not recognized. Pick one from the list, for example Europe/London.";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  resetUnreadCountForTests();
  puts = [];
  putStatus = 200;
  getStatus = 200;
  putGate = null;
  stored = { email: { taskAssigned: true, dueReminders: true, weeklyDigest: false }, timezone: "Europe/Berlin" };
  auth.isAuthenticated = true;
  router.replace.mockClear();
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ timeZone: "Asia/Tokyo" } as Intl.ResolvedDateTimeFormatOptions);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/v1/notifications/unread-count") return json({ count: 0 });
    if (init?.method === "PUT") {
      puts.push(JSON.parse(String(init.body)));
      if (putGate) await putGate;
      if (putStatus === 500) return json({ code: "boom" }, 500);
      if (putStatus === 401) return json({ code: "unauthorized" }, 401);
      if (putStatus === 422) return json({ code: "invalid_input", detail: "Invalid notification preferences" }, 400);
      if (putStatus === 403) return json({ code: "bad_request", detail: 'body/timezone must match pattern "^[A-Za-z0-9_+\-/]+$"' }, 400);
      if (putStatus === 400) return json({ code: "invalid_input", detail: "Unknown time zone." }, 400);
      return json(puts.at(-1));
    }
    if (getStatus !== 200) return json({ code: "boom" }, getStatus);
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

  it("explains an invalid zone inline", async () => {
    putStatus = 400;
    const user = userEvent.setup();
    render(<NotificationSettingsPage />);
    const zone = await screen.findByLabelText("Time zone");
    await user.clear(zone);
    await user.type(zone, "Mars/Base");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(ZONE_COPY)).toBeInTheDocument();
    expect(zone).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("explains a schema rejection of the zone inline", async () => {
    putStatus = 403;
    const user = userEvent.setup();
    render(<NotificationSettingsPage />);
    const zone = await screen.findByLabelText("Time zone");
    await user.clear(zone);
    await user.type(zone, "Mars Base");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(ZONE_COPY)).toBeInTheDocument();
    expect(zone).toHaveAttribute("aria-invalid", "true");
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

  it("sends one PUT on a double click and shows the saving state", async () => {
    let release!: () => void;
    putGate = new Promise<void>((resolve) => { release = resolve; });
    const user = userEvent.setup();
    render(<NotificationSettingsPage />);
    await user.click(await screen.findByRole("switch", { name: "Weekly digest — Mondays at 8:00" }));
    const save = screen.getByRole("button", { name: "Save" });
    await user.dblClick(save);
    const busy = await screen.findByRole("button", { name: "Saving…" });
    expect(busy).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Task assigned to me" })).toBeDisabled();
    expect(screen.getByLabelText("Time zone")).toBeDisabled();
    expect(screen.getByRole("button", { name: /Use my browser's zone/ })).toBeDisabled();
    await act(async () => { release(); });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(puts).toHaveLength(1);
  });

  it("keeps an edit made while a save is in flight and does not claim Saved", async () => {
    let release!: () => void;
    putGate = new Promise<void>((resolve) => { release = resolve; });
    const user = userEvent.setup();
    render(<NotificationSettingsPage />);
    await user.click(await screen.findByRole("switch", { name: "Weekly digest — Mondays at 8:00" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: "Saving…" });
    // A disabled fieldset blocks user input; force the edit through the DOM to exercise the defence.
    const zone = screen.getByLabelText("Time zone") as HTMLInputElement;
    const fieldset = zone.closest("fieldset")!;
    fieldset.disabled = false;
    zone.disabled = false;
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(zone, { target: { value: "Asia/Tokyo" } });
    await act(async () => { release(); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    expect(screen.getByLabelText("Time zone")).toHaveValue("Asia/Tokyo");
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("shows a load error with a working retry", async () => {
    getStatus = 500;
    const user = userEvent.setup();
    render(<NotificationSettingsPage />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    getStatus = 200;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("switch", { name: "Task assigned to me" })).toBeInTheDocument();
  });

  it("shows a non-400 save failure in an alert, not on the zone field", async () => {
    putStatus = 500;
    const user = userEvent.setup();
    render(<NotificationSettingsPage />);
    await user.click(await screen.findByRole("switch", { name: "Weekly digest — Mondays at 8:00" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByLabelText("Time zone")).not.toHaveAttribute("aria-invalid");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("uses the alert for a 400 that is not about the zone", async () => {
    putStatus = 422;
    const user = userEvent.setup();
    render(<NotificationSettingsPage />);
    await user.click(await screen.findByRole("switch", { name: "Weekly digest — Mondays at 8:00" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid notification preferences");
    expect(screen.getByLabelText("Time zone")).not.toHaveAttribute("aria-invalid");
  });

  it("clears a stale zone error when a field changes", async () => {
    putStatus = 400;
    const user = userEvent.setup();
    render(<NotificationSettingsPage />);
    const zone = await screen.findByLabelText("Time zone");
    await user.type(zone, "x");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(ZONE_COPY);
    await user.click(screen.getByRole("switch", { name: "Task assigned to me" }));
    expect(screen.queryByText(ZONE_COPY)).toBeNull();
  });

  it("redirects to login on a session expiry during save without an error alert", async () => {
    putStatus = 401;
    const user = userEvent.setup();
    render(<NotificationSettingsPage />);
    await user.click(await screen.findByRole("switch", { name: "Weekly digest — Mondays at 8:00" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login?redirect=%2Fsettings%2Fnotifications"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not flash an error when loading hits a 401", async () => {
    getStatus = 401;
    render(<NotificationSettingsPage />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login?redirect=%2Fsettings%2Fnotifications"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("links to the settings from the sidebar with the current page marked", async () => {
    render(<NotificationSettingsPage />);
    const link = await screen.findByRole("link", { name: "Settings" });
    expect(link).toHaveAttribute("href", "/settings/notifications");
    expect(link).toHaveAttribute("aria-current", "page");
  });

  it("hides the browser-zone link when the zones are equal", async () => {
    stored.timezone = "Asia/Tokyo";
    render(<NotificationSettingsPage />);
    await screen.findByLabelText("Time zone");
    expect(screen.queryByRole("button", { name: /Use my browser's zone/ })).toBeNull();
  });
});
