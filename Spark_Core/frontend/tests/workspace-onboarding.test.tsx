import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), push: vi.fn() };
const auth = {
  isAuthenticated: true,
  isLoading: false,
  platformRoles: [] as string[],
  user: { id: "me", displayName: "Avery Founder", email: "avery@example.com", avatarUrl: null },
  workspaces: [] as Array<{ workspaceId: string; workspaceName: string; workspaceSlug: string; role: string }>,
  logout: vi.fn(),
  refreshSession: vi.fn(async () => {}),
};

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/onboarding",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));

import OnboardingPage from "../src/app/onboarding/page";
import { deriveSlug } from "../src/app/onboarding/slug";

let posts: Array<{ url: string; body: unknown }> = [];

function stubCreate(response: () => Response) {
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return response();
  }));
}

const created = { id: "w1", slug: "northstar-labs", name: "Northstar Labs!", role: "owner", memberCount: 1, version: 1, createdAt: "2026-10-18T10:00:00.000Z" };

beforeEach(() => {
  auth.isAuthenticated = true;
  auth.isLoading = false;
  router.replace.mockClear();
  router.push.mockClear();
  auth.refreshSession.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("deriveSlug", () => {
  it("lowercases, replaces other characters with hyphens and trims to 40", () => {
    expect(deriveSlug("Northstar Labs!")).toBe("northstar-labs");
    expect(deriveSlug("  Ünïcode & Co.  ")).toBe("unicode-co");
    expect(deriveSlug("a".repeat(60))).toHaveLength(40);
  });
});

describe("onboarding", () => {
  it("previews the address derived from the workspace name", async () => {
    stubCreate(() => new Response("{}", { status: 500 }));
    render(<OnboardingPage />);
    expect(screen.getByText("Get started")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Name your workspace" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Workspace name"), "Northstar Labs!");
    expect(screen.getByLabelText("Workspace address")).toHaveValue("northstar-labs");
    expect(screen.getByTestId("slug-preview")).toHaveTextContent("spark.app/w/northstar-labs");
    expect(screen.getByText(/Next: choose how your team works/)).toBeInTheDocument();
    expect(screen.getByLabelText("Workspace name")).toHaveAttribute("maxLength", "80");
  });

  it("creates the workspace, refreshes the session and starts the first project", async () => {
    stubCreate(() => new Response(JSON.stringify(created), { status: 201, headers: { "content-type": "application/json", ETag: "\"v1\"" } }));
    render(<OnboardingPage />);
    await userEvent.type(screen.getByLabelText("Workspace name"), "Northstar Labs!");
    await userEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/w/northstar-labs/projects/new?first=1"));
    expect(posts).toEqual([{ url: "/api/v1/workspaces", body: { name: "Northstar Labs!", slug: "northstar-labs" } }]);
    expect(auth.refreshSession).toHaveBeenCalledTimes(1);
  });

  it("shows an inline message on the address when the slug is taken", async () => {
    stubCreate(() => new Response(JSON.stringify({ code: "slug_taken", detail: "Slug is taken" }), { status: 409 }));
    render(<OnboardingPage />);
    await userEvent.type(screen.getByLabelText("Workspace name"), "Northstar Labs!");
    await userEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(await screen.findByText("That address is taken. Try another.")).toBeInTheDocument();
    expect(screen.getByLabelText("Workspace address")).toHaveAttribute("aria-invalid", "true");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("keeps a slug the person edited when the name changes", async () => {
    stubCreate(() => new Response("{}", { status: 500 }));
    render(<OnboardingPage />);
    const slug = screen.getByLabelText("Workspace address");
    await userEvent.type(screen.getByLabelText("Workspace name"), "Northstar");
    await userEvent.clear(slug);
    await userEvent.type(slug, "north-hq");
    await userEvent.type(screen.getByLabelText("Workspace name"), " Labs");
    expect(slug).toHaveValue("north-hq");
  });

  it("rejects an invalid address before sending", async () => {
    stubCreate(() => new Response("{}", { status: 500 }));
    render(<OnboardingPage />);
    await userEvent.type(screen.getByLabelText("Workspace name"), "N");
    await userEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(await screen.findByText(/3–40 lowercase letters/)).toBeInTheDocument();
    expect(posts).toEqual([]);
  });

  it("sends signed-out visitors to sign in", () => {
    auth.isAuthenticated = false;
    render(<OnboardingPage />);
    expect(router.replace).toHaveBeenCalledWith("/login?redirect=%2Fonboarding");
  });
});
