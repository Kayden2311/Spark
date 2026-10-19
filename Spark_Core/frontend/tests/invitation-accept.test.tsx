import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), push: vi.fn() };
const search = { params: new URLSearchParams() };
const auth = {
  isAuthenticated: false,
  isLoading: false,
  platformRoles: [] as string[],
  user: null as null | { id: string; displayName: string; email: string; avatarUrl: null },
  workspaces: [] as unknown[],
  login: vi.fn(),
  signup: vi.fn(async () => ({ success: true })),
  logout: vi.fn(async () => {}),
  refreshSession: vi.fn(async () => {}),
};

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/invitations/accept",
  useSearchParams: () => search.params,
  useParams: () => ({}),
}));
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));

import AcceptInvitationPage from "../src/app/invitations/accept/page";
import SignupPage from "../src/app/signup/page";

const TOKEN = "ab".repeat(32);
const STORAGE_KEY = "spark:invite-token";
const preview = { status: "pending", workspaceName: "Northstar Labs", inviterName: "Avery Founder", role: "admin", emailHint: "b***@example.com", expiresAt: "2026-10-25T10:00:00.000Z" };

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
const json = (payload: unknown, status = 200): Handler => () => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

function signIn() {
  auth.isAuthenticated = true;
  auth.user = { id: "u-blake", displayName: "Blake Rivers", email: "blake@example.com", avatarUrl: null };
}

beforeEach(() => {
  auth.isAuthenticated = false;
  auth.isLoading = false;
  auth.user = null;
  router.replace.mockClear();
  router.push.mockClear();
  auth.refreshSession.mockClear();
  auth.logout.mockClear();
  search.params = new URLSearchParams();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/invitations/accept");
});
afterEach(() => vi.unstubAllGlobals());

describe("accept invitation page", () => {
  it("moves the token from the URL hash into session storage and strips it", async () => {
    mockApi({ "POST /api/v1/invitations/preview": json(preview) });
    window.history.replaceState(null, "", `/invitations/accept#token=${TOKEN}`);
    render(<AcceptInvitationPage />);
    await screen.findByRole("heading", { name: "Join Northstar Labs" });
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(TOKEN);
    expect(calls).toEqual([{ key: "POST /api/v1/invitations/preview", body: { token: TOKEN } }]);
  });

  it("asks signed-out visitors to sign in or sign up and come back", async () => {
    mockApi({ "POST /api/v1/invitations/preview": json(preview) });
    window.sessionStorage.setItem(STORAGE_KEY, TOKEN);
    render(<AcceptInvitationPage />);
    expect(await screen.findByText(/Avery Founder invited you/)).toBeInTheDocument();
    expect(screen.getByText("b***@example.com")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in to accept" })).toHaveAttribute("href", "/login?redirect=/invitations/accept");
    expect(screen.getByRole("link", { name: "Create account" })).toHaveAttribute("href", "/signup?redirect=/invitations/accept");
    expect(screen.queryByRole("button", { name: /^Join/ })).not.toBeInTheDocument();
  });

  it("accepts for a signed-in person, clears the token and opens the workspace", async () => {
    signIn();
    mockApi({
      "POST /api/v1/invitations/preview": json(preview),
      "POST /api/v1/invitations/accept": json({ workspace: { id: "w1", slug: "northstar-labs" }, role: "admin", alreadyMember: false }),
    });
    window.sessionStorage.setItem(STORAGE_KEY, TOKEN);
    render(<AcceptInvitationPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Join Northstar Labs" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/w/northstar-labs"));
    expect(calls.find((call) => call.key === "POST /api/v1/invitations/accept")?.body).toEqual({ token: TOKEN });
    expect(auth.refreshSession).toHaveBeenCalled();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("names the invited address when the signed-in account does not match", async () => {
    signIn();
    mockApi({
      "POST /api/v1/invitations/preview": json(preview),
      "POST /api/v1/invitations/accept": json({ code: "recipient_mismatch", detail: "This invitation was sent to b***@example.com. Sign in with that account to accept it." }, 403),
    });
    window.sessionStorage.setItem(STORAGE_KEY, TOKEN);
    render(<AcceptInvitationPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Join Northstar Labs" }));
    expect(await screen.findByText("This invitation was sent to b***@example.com. Sign out and use that account.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(auth.logout).toHaveBeenCalled();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(TOKEN);
  });

  it("explains an expired invitation and links home", async () => {
    mockApi({ "POST /api/v1/invitations/preview": json({ status: "expired", workspaceName: null, inviterName: null, role: null, emailHint: null, expiresAt: null }) });
    window.sessionStorage.setItem(STORAGE_KEY, TOKEN);
    render(<AcceptInvitationPage />);
    expect(await screen.findByRole("heading", { name: "This invitation has expired" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Spark" })).toHaveAttribute("href", "/");
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("treats an unknown link as invalid", async () => {
    mockApi({ "POST /api/v1/invitations/preview": json({ code: "invalid_invitation" }, 404) });
    window.sessionStorage.setItem(STORAGE_KEY, TOKEN);
    render(<AcceptInvitationPage />);
    expect(await screen.findByRole("heading", { name: "This invitation link isn't valid" })).toBeInTheDocument();
  });

  it("shows the invalid state without calling the API when there is no token", async () => {
    mockApi({});
    render(<AcceptInvitationPage />);
    expect(await screen.findByRole("heading", { name: "This invitation link isn't valid" })).toBeInTheDocument();
    expect(calls).toEqual([]);
  });
});

describe("sign-up from an invitation", () => {
  it("returns to the accept page after creating the account", async () => {
    search.params = new URLSearchParams("redirect=/invitations/accept");
    render(<SignupPage />);
    await userEvent.type(screen.getByLabelText(/Full name/), "Blake Rivers");
    await userEvent.type(screen.getByLabelText("Work email"), "blake@example.com");
    await userEvent.type(screen.getByLabelText("Password (min 12 characters)"), "a-long-password-123");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/invitations/accept"));
  });
});
