import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detail, json, stubFetch } from "./community-fixtures";
import type { CommunityDetail } from "../src/app/communities/types";
import { formatDate } from "../src/app/communities/format";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const notFound = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => router, notFound }));

const auth = { isAuthenticated: true, isLoading: false, user: { id: "u-me" } as null | { id: string } };
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));

import { MAX_MESSAGE_LENGTH, RequestForm } from "../src/app/communities/[slug]/request/request-form";

const privateCommunity = detail({ visibility: "private" });

function serve(community: CommunityDetail | null, onRequest?: (body: unknown) => Response, myRequests?: unknown[]) {
  return stubFetch((url, init) => {
    if (url.pathname === "/api/v1/me/community-requests" && myRequests) return json({ items: myRequests });
    if (url.pathname === "/api/v1/communities/northstar-founders") {
      return community ? json(community) : json({ code: "community_not_found", detail: "Community not found." }, 404);
    }
    if (url.pathname === "/api/v1/communities/c-northstar/requests" && init.method === "POST" && onRequest) {
      return onRequest(JSON.parse(String(init.body)));
    }
    return undefined;
  });
}

const created = json({ request: { id: "r-1", status: "pending", message: "Hello", createdAt: "2026-11-05T00:00:00.000Z" } }, 201);

describe("RequestForm", () => {
  beforeEach(() => {
    router.push.mockClear();
    router.replace.mockClear();
    notFound.mockClear();
    auth.isAuthenticated = true;
    auth.isLoading = false;
    auth.user = { id: "u-me" };
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends signed-out visitors to sign in and returns them to the request page", async () => {
    auth.isAuthenticated = false;
    auth.user = null;
    const { calls } = serve(privateCommunity);
    render(<RequestForm slug="northstar-founders" />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login?redirect=%2Fcommunities%2Fnorthstar-founders%2Frequest"));
    expect(screen.queryByRole("button", { name: "Send request" })).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("waits for the session check before deciding", () => {
    auth.isAuthenticated = false;
    auth.isLoading = true;
    serve(privateCommunity);
    render(<RequestForm slug="northstar-founders" />);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("posts the message, counts characters and navigates to the sent page", async () => {
    let sent: unknown;
    serve(privateCommunity, (body) => {
      sent = body;
      return created;
    });
    render(<RequestForm slug="northstar-founders" />);
    expect(await screen.findByRole("heading", { name: "Request access to Northstar Founders" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/message to the owners/i), "  Hello  ");
    expect(screen.getByText(`9/${MAX_MESSAGE_LENGTH}`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Send request" }));

    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/communities/northstar-founders/request/sent"));
    expect(sent).toEqual({ message: "Hello" });
  });

  it("shows when the user can request again after a rejection", async () => {
    serve(privateCommunity, () =>
      json({ code: "request_cooldown", detail: "You can request again later.", retryAfter: "2026-11-19T12:00:00.000Z" }, 409),
    );
    render(<RequestForm slug="northstar-founders" />);
    await userEvent.click(await screen.findByRole("button", { name: "Send request" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You can request again on November 19, 2026");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("shows the cooldown date up front for a recently declined request", async () => {
    const reviewedAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const again = formatDate(new Date(Date.parse(reviewedAt) + 14 * 86_400_000).toISOString());
    serve(detail({ visibility: "private", viewerStatus: "none" }), undefined, [
      { id: "r-old", community: { slug: "northstar-founders", name: "Northstar Founders" }, status: "rejected", message: null, createdAt: "2026-10-01T00:00:00.000Z", reviewedAt },
    ]);
    render(<RequestForm slug="northstar-founders" />);
    expect(await screen.findByText(`You can request again on ${again}`)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send request" })).not.toBeInTheDocument();
  });

  it("offers the form again once the cooldown is over", async () => {
    const reviewedAt = new Date(Date.now() - 15 * 86_400_000).toISOString();
    serve(detail({ visibility: "private", viewerStatus: "none" }), undefined, [
      { id: "r-old", community: { slug: "northstar-founders", name: "Northstar Founders" }, status: "rejected", message: null, createdAt: "2026-10-01T00:00:00.000Z", reviewedAt },
    ]);
    render(<RequestForm slug="northstar-founders" />);
    expect(await screen.findByRole("button", { name: "Send request" })).toBeInTheDocument();
  });

  it("never offers a request to someone who already manages the community", async () => {
    serve(detail({ visibility: "private", viewerStatus: "none", canManage: true }));
    render(<RequestForm slug="northstar-founders" />);
    expect(await screen.findByRole("heading", { name: "You manage this community" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send request" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage community" })).toHaveAttribute("href", "/communities/northstar-founders/manage");
  });

  it("shows the existing pending request instead of the form", async () => {
    serve(detail({ visibility: "private", viewerStatus: "pending" }));
    render(<RequestForm slug="northstar-founders" />);
    expect(await screen.findByRole("heading", { name: "Request pending" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send request" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to northstar founders/i })).toHaveAttribute("href", "/communities/northstar-founders");
  });

  it("tells members they are already in", async () => {
    serve(detail({ visibility: "private", viewerStatus: "member" }));
    render(<RequestForm slug="northstar-founders" />);
    expect(await screen.findByRole("heading", { name: "You're already a member" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send request" })).not.toBeInTheDocument();
  });

  it("sends visitors of a public community back to the community page to join", async () => {
    serve(detail({ visibility: "public" }));
    render(<RequestForm slug="northstar-founders" />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/communities/northstar-founders"));
  });

  it("follows join_instead to the community page", async () => {
    serve(privateCommunity, () => json({ code: "join_instead", detail: "This community is public. Join it instead." }, 409));
    render(<RequestForm slug="northstar-founders" />);
    await userEvent.click(await screen.findByRole("button", { name: "Send request" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/communities/northstar-founders"));
  });

  it("sends the user to sign in when the session expired while sending", async () => {
    serve(privateCommunity, () => json({ code: "session_expired", detail: "Session expired or invalid." }, 401));
    render(<RequestForm slug="northstar-founders" />);
    await userEvent.click(await screen.findByRole("button", { name: "Send request" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/login?redirect=%2Fcommunities%2Fnorthstar-founders%2Frequest"));
  });

  it("rejects an over-long message and does not send it", async () => {
    const { calls } = serve(privateCommunity, () => created);
    render(<RequestForm slug="northstar-founders" />);
    const box = await screen.findByLabelText(/message to the owners/i);
    await userEvent.click(box);
    await userEvent.paste("a".repeat(MAX_MESSAGE_LENGTH + 1));
    await userEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(screen.getByRole("alert")).toHaveTextContent(String(MAX_MESSAGE_LENGTH));
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("shows the paused notice instead of the form in a frozen community", async () => {
    serve(detail({ visibility: "private", frozen: true }));
    render(<RequestForm slug="northstar-founders" />);
    expect(await screen.findByText("This community is paused by Spark moderators.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send request" })).not.toBeInTheDocument();
  });

  it("uses the not-found page for a hidden or unknown community", async () => {
    serve(null);
    render(<RequestForm slug="northstar-founders" />);
    await waitFor(() => expect(notFound).toHaveBeenCalled());
  });
});
