import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detail, json, stubFetch } from "./community-fixtures";
import type { CommunityDetail } from "../src/app/communities/types";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const notFound = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => router, notFound, usePathname: () => "/communities/northstar-founders" }));

const auth = { isAuthenticated: true, isLoading: false, user: { id: "u-me" } as null | { id: string } };
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));
vi.mock("../src/app/signal-particles", () => ({ SignalParticles: () => null }));

import { CommunityView } from "../src/app/communities/[slug]/community-view";

function serve(community: CommunityDetail | null, extra?: (url: URL, init: RequestInit) => Response | undefined) {
  return stubFetch((url, init) => {
    const handled = extra?.(url, init);
    if (handled) return handled;
    if (url.pathname === "/api/v1/communities/northstar-founders" && (init.method ?? "GET") === "GET") {
      return community ? json(community, 200, { ETag: `"v${community.version}"` }) : json({ code: "community_not_found", detail: "Community not found." }, 404);
    }
    return undefined;
  });
}

const actions = () => screen.getByRole("region", { name: "Membership" });

describe("community page", () => {
  beforeEach(() => {
    auth.isAuthenticated = true;
    auth.isLoading = false;
    auth.user = { id: "u-me" };
    router.push.mockClear();
    router.replace.mockClear();
    notFound.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders the hero, stats, about and the discussion placeholder as plain text", async () => {
    serve(detail({ visibility: "private", featured: true, description: "<script>alert(1)</script> We meet weekly.", weeklyPosts: 7 }));
    render(<CommunityView slug="northstar-founders" />);

    expect(await screen.findByRole("heading", { level: 1, name: "Northstar Founders" })).toBeInTheDocument();
    expect(screen.getByText("Founders building B2B software.")).toBeInTheDocument();
    expect(screen.getAllByText("Northstar Labs").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Private").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Seed").length).toBeGreaterThan(0);
    expect(screen.queryByText("seed")).not.toBeInTheDocument();
    expect(screen.getAllByText("Hanoi, Vietnam").length).toBeGreaterThan(0);
    expect(screen.getAllByText("B2B SaaS").length).toBeGreaterThan(0);
    const stats = screen.getByRole("list", { name: "Community stats" });
    expect(within(stats).getByText("1.3K")).toBeInTheDocument();
    expect(within(stats).getByText("7")).toBeInTheDocument();
    expect(screen.getByText("<script>alert(1)</script> We meet weekly.")).toBeInTheDocument();
    expect(document.querySelector("main script")).toBeNull();
    expect(screen.getByText("Discussions open in the next update")).toBeInTheDocument();
  });

  it("sends signed-out visitors of a public community to sign in and back", async () => {
    auth.isAuthenticated = false;
    auth.user = null;
    serve(detail());
    render(<CommunityView slug="northstar-founders" />);
    const link = await within(await screen.findByRole("region", { name: "Membership" })).findByRole("link", { name: "Sign in to join" });
    expect(link).toHaveAttribute("href", "/login?redirect=%2Fcommunities%2Fnorthstar-founders");
  });

  it("sends signed-out visitors of a private community to sign in, then to the request page", async () => {
    auth.isAuthenticated = false;
    auth.user = null;
    serve(detail({ visibility: "private" }));
    render(<CommunityView slug="northstar-founders" />);
    const link = await screen.findByRole("link", { name: "Sign in to request access" });
    expect(link).toHaveAttribute("href", "/login?redirect=%2Fcommunities%2Fnorthstar-founders%2Frequest");
  });

  it("joins a public community and switches to the member state", async () => {
    const { calls } = serve(detail({ memberCount: 10 }), (url, init) =>
      url.pathname === "/api/v1/communities/c-northstar/join" && init.method === "POST" ? json({ status: "member", alreadyMember: false }) : undefined,
    );
    render(<CommunityView slug="northstar-founders" />);
    await userEvent.click(await screen.findByRole("button", { name: "Join" }));

    expect(await within(actions()).findByText("You're a member")).toBeInTheDocument();
    expect(within(actions()).getByRole("button", { name: "Leave" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("You joined Northstar Founders.");
    expect(within(screen.getByRole("list", { name: "Community stats" })).getByText("11")).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("sends the user to sign in when the session expired during Join", async () => {
    serve(detail(), (url, init) => (init.method === "POST" ? json({ code: "session_expired", detail: "Session expired or invalid." }, 401) : undefined));
    render(<CommunityView slug="northstar-founders" />);
    await userEvent.click(await screen.findByRole("button", { name: "Join" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/login?redirect=%2Fcommunities%2Fnorthstar-founders"));
  });

  it("offers Request access for a private community", async () => {
    serve(detail({ visibility: "private" }));
    render(<CommunityView slug="northstar-founders" />);
    expect(await screen.findByRole("link", { name: "Request access" })).toHaveAttribute("href", "/communities/northstar-founders/request");
    expect(screen.queryByRole("button", { name: "Join" })).not.toBeInTheDocument();
  });

  it("shows a pending request and withdraws it", async () => {
    const { calls } = serve(detail({ visibility: "private", viewerStatus: "pending" }), (url, init) => {
      if (url.pathname === "/api/v1/me/community-requests") {
        return json({
          items: [
            { id: "r-other", community: { slug: "other", name: "Other" }, status: "pending", message: "", createdAt: "2026-11-01T00:00:00.000Z", reviewedAt: null },
            { id: "r-1", community: { slug: "northstar-founders", name: "Northstar Founders" }, status: "pending", message: "Hi", createdAt: "2026-11-02T00:00:00.000Z", reviewedAt: null },
          ],
        });
      }
      if (url.pathname === "/api/v1/community-requests/r-1" && init.method === "DELETE") return new Response(null, { status: 204 });
      return undefined;
    });
    render(<CommunityView slug="northstar-founders" />);
    expect(await within(await screen.findByRole("region", { name: "Membership" })).findByText("Request pending")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Withdraw" }));

    expect(await screen.findByRole("link", { name: "Request access" })).toBeInTheDocument();
    expect(calls.some((call) => call.method === "DELETE" && call.path === "/api/v1/community-requests/r-1")).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("Request withdrawn.");
  });

  it("asks members to confirm before leaving", async () => {
    const { calls } = serve(detail({ viewerStatus: "member", memberCount: 5 }), (url, init) =>
      url.pathname === "/api/v1/communities/c-northstar/members/u-me" && init.method === "DELETE" ? new Response(null, { status: 204 }) : undefined,
    );
    render(<CommunityView slug="northstar-founders" />);
    expect(await within(await screen.findByRole("region", { name: "Membership" })).findByText("You're a member")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Leave" }));
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Leave" }));
    await userEvent.click(screen.getByRole("button", { name: "Leave community" }));
    expect(await screen.findByRole("button", { name: "Join" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("You left Northstar Founders.");
    expect(within(screen.getByRole("list", { name: "Community stats" })).getByText("4")).toBeInTheDocument();
  });

  it("explains why the last owner cannot leave", async () => {
    serve(detail({ viewerStatus: "owner", canManage: true }), (url, init) =>
      init.method === "DELETE" ? json({ code: "last_owner", detail: "A community needs at least one owner." }, 409) : undefined,
    );
    render(<CommunityView slug="northstar-founders" />);
    await userEvent.click(await screen.findByRole("button", { name: "Leave" }));
    await userEvent.click(screen.getByRole("button", { name: "Leave community" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A community needs at least one owner.");
    expect(within(actions()).getByText("You're a member")).toBeInTheDocument();
  });

  it("gives managers a Manage link", async () => {
    serve(detail({ viewerStatus: "owner", canManage: true }));
    render(<CommunityView slug="northstar-founders" />);
    expect(await screen.findByRole("link", { name: "Manage" })).toHaveAttribute("href", "/communities/northstar-founders/manage");
  });

  it("hides the Manage link from members who cannot manage", async () => {
    serve(detail({ viewerStatus: "member" }));
    render(<CommunityView slug="northstar-founders" />);
    await screen.findByRole("button", { name: "Leave" });
    expect(screen.queryByRole("link", { name: "Manage" })).not.toBeInTheDocument();
  });

  it("disables actions in a frozen community", async () => {
    serve(detail({ frozen: true }));
    render(<CommunityView slug="northstar-founders" />);
    expect(await screen.findByRole("button", { name: "Join" })).toBeDisabled();
    expect(screen.getByText("This community is paused by Spark moderators.")).toBeInTheDocument();
  });

  it("uses the not-found page for a hidden or unknown community", async () => {
    serve(null);
    render(<CommunityView slug="northstar-founders" />);
    await waitFor(() => expect(notFound).toHaveBeenCalled());
  });
});
