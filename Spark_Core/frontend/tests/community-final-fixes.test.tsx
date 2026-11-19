import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { comment, detail, json, post, postDetail, stubFetch } from "./community-fixtures";
import type { CommunityDetail } from "../src/app/communities/types";
import type { CommentItem, PostDetail } from "../src/app/communities/_lib/content-api";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const pathname = vi.hoisted(() => ({ value: "/communities/northstar-founders" }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  notFound: vi.fn(),
  usePathname: () => pathname.value,
  useParams: () => ({ slug: "northstar-founders" }),
}));

const auth = { isAuthenticated: true, isLoading: false, user: { id: "u-me" } as null | { id: string } };
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));
vi.mock("../src/app/signal-particles", () => ({ SignalParticles: () => null }));

import { CommunityView } from "../src/app/communities/[slug]/community-view";
import { PostView } from "../src/app/communities/[slug]/posts/[postId]/post-view";
import { ConfirmDialog } from "../src/app/communities/_components/confirm-dialog";
import { ModerationDialog } from "../src/app/communities/_components/moderation-dialog";
import { TextField } from "../src/app/communities/_components/text-field";
import { PostUnavailable } from "../src/app/communities/[slug]/posts/[postId]/post-unavailable";

const FEED = "/api/v1/communities/c-northstar/posts";
const member = (overrides: Partial<CommunityDetail> = {}) => detail({ viewerStatus: "member", ...overrides });
const MINE = { isAuthor: true, canEdit: true, canDelete: true, canReport: false };

interface World {
  community?: CommunityDetail;
  post?: PostDetail;
  comments?: CommentItem[];
  extra?: (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;
}
function servePost({ community = member(), post: body = postDetail(), comments = [], extra }: World = {}) {
  return stubFetch((url, init) => {
    const handled = extra?.(url, init);
    if (handled) return handled;
    const method = init.method ?? "GET";
    if (url.pathname === "/api/v1/communities/northstar-founders" && method === "GET") return json(community);
    if (url.pathname === "/api/v1/posts/p1" && method === "GET") return json(body, 200, { ETag: `"v${body.version}"` });
    if (url.pathname === "/api/v1/posts/p1/comments" && method === "GET") return json({ items: comments, nextCursor: null });
    return undefined;
  });
}
const renderPost = (props: Partial<Parameters<typeof PostView>[0]> = {}) => render(<PostView postId="p1" slug="northstar-founders" {...props} />);

beforeEach(() => {
  auth.isAuthenticated = true;
  auth.isLoading = false;
  auth.user = { id: "u-me" };
  router.push.mockClear();
  router.replace.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("composer", () => {
  it("locks the title and body while a post is being sent", async () => {
    let release: (response: Response) => void = () => undefined;
    stubFetch((url, init) => {
      if (url.pathname === "/api/v1/communities/northstar-founders") return json(member());
      if (url.pathname === FEED && init.method === "POST") return new Promise<Response>((resolve) => (release = resolve)) as unknown as Response;
      if (url.pathname === FEED) return json({ items: [], nextCursor: null });
      return undefined;
    });
    render(<CommunityView slug="northstar-founders" />);
    await userEvent.type(await screen.findByLabelText("Title"), "Hi");
    await userEvent.type(screen.getByLabelText("Body"), "There");
    await userEvent.click(screen.getByRole("button", { name: "Post" }));
    expect(await screen.findByRole("button", { name: "Posting…" })).toBeDisabled();
    expect(screen.getByLabelText("Title")).toBeDisabled();
    expect(screen.getByLabelText("Body")).toBeDisabled();
    release(json({ ...postDetail({ id: "p9", title: "Hi" }) }, 201));
    await waitFor(() => expect(screen.getByLabelText("Title")).toBeEnabled());
    expect(screen.getByLabelText("Title")).toHaveValue("");
  });

  it("locks the comment field while a comment is being sent", async () => {
    let release: (response: Response) => void = () => undefined;
    servePost({
      extra: (url, init) =>
        url.pathname === "/api/v1/posts/p1/comments" && init.method === "POST" ? (new Promise<Response>((resolve) => (release = resolve)) as unknown as Response) : undefined,
    });
    renderPost();
    await userEvent.type(await screen.findByLabelText("Add a comment"), "Nice");
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(await screen.findByRole("button", { name: "Posting…" })).toBeDisabled();
    expect(screen.getByLabelText("Add a comment")).toBeDisabled();
    release(json(comment({ id: "m9", body: "Nice" }), 201));
    await waitFor(() => expect(screen.getByLabelText("Add a comment")).toBeEnabled());
  });

  it("links the counter to its field with aria-describedby", () => {
    render(<TextField label="Title" max={150} onChange={() => undefined} value="abc" />);
    const field = screen.getByLabelText("Title");
    const counter = document.getElementById(field.getAttribute("aria-describedby") ?? "none");
    expect(counter).toHaveTextContent("3/150");
  });
});

describe("moderation answer", () => {
  it("uses the version the API returns for the next If-Match (post)", async () => {
    const viewer = { ...MINE, canModerate: true };
    const { calls } = servePost({
      community: member({ viewerStatus: "moderator" }),
      post: postDetail({ version: 1, viewer }),
      extra: (url, init) => {
        if (url.pathname === "/api/v1/posts/p1/moderation" && init.method === "POST") return json({ moderation: "hidden", reportsClosed: 0, changed: true, version: 6 });
        if (url.pathname === "/api/v1/posts/p1" && init.method === "PATCH") return json(postDetail({ version: 7, title: "New", viewer }));
        return undefined;
      },
    });
    renderPost();
    const article = (await screen.findByRole("heading", { level: 1, name: "Hello founders" })).closest("article")!;
    await userEvent.click(within(article).getByRole("button", { name: /^More actions/u }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Hide" }));
    await userEvent.type(screen.getByLabelText("Reason"), "Testing");
    await userEvent.click(screen.getByRole("button", { name: "Hide post" }));
    await waitFor(() => expect(within(article).getByText("Hidden")).toBeInTheDocument());
    await userEvent.click(within(article).getByRole("button", { name: /^More actions/u }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    await userEvent.clear(screen.getByLabelText("Title"));
    await userEvent.type(screen.getByLabelText("Title"), "New");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    expect(calls.find((call) => call.method === "PATCH")?.headers["if-match"]).toBe('"v6"');
  });

  it("uses the returned version for a comment and adjusts the count by one for hide and restore", async () => {
    const viewer = { ...MINE, canModerate: true };
    const { calls } = servePost({
      community: member({ viewerStatus: "moderator" }),
      post: postDetail({ commentCount: 1 }),
      comments: [comment({ id: "m1", body: "Mine", version: 2, viewer })],
      extra: (url, init) => {
        if (url.pathname === "/api/v1/comments/m1/moderation" && init.method === "POST") {
          const action = JSON.parse(String(init.body)).action as string;
          return json({ moderation: action === "hide" ? "hidden" : "visible", reportsClosed: 0, changed: true, version: action === "hide" ? 8 : 9 });
        }
        if (url.pathname === "/api/v1/comments/m1" && init.method === "PATCH") return json(comment({ id: "m1", body: "Edited", version: 10, viewer }));
        return undefined;
      },
    });
    renderPost();
    const row = (await screen.findByText("Mine")).closest("li")!;
    expect(screen.getByText("1 comment")).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: /^More actions/u }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Hide" }));
    await userEvent.type(screen.getByLabelText("Reason"), "Testing");
    await userEvent.click(screen.getByRole("button", { name: "Hide comment" }));
    await waitFor(() => expect(screen.getByText("0 comments")).toBeInTheDocument());

    await userEvent.click(within(row).getByRole("button", { name: /^More actions/u }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Restore" }));
    await userEvent.type(screen.getByLabelText("Reason"), "Fine");
    await userEvent.click(screen.getByRole("button", { name: "Restore comment" }));
    await waitFor(() => expect(screen.getByText("1 comment")).toBeInTheDocument());

    await userEvent.click(within(row).getByRole("button", { name: /^More actions/u }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    await userEvent.clear(within(row).getByLabelText("Edit comment"));
    await userEvent.type(within(row).getByLabelText("Edit comment"), "Edited");
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    expect(calls.find((call) => call.method === "PATCH")?.headers["if-match"]).toBe('"v9"');
  });

  it("does not lower the visible count when a hidden comment is deleted", async () => {
    const viewer = { ...MINE, canModerate: true };
    servePost({
      community: member({ viewerStatus: "moderator" }),
      post: postDetail({ commentCount: 2 }),
      comments: [comment({ id: "m1", body: "Hidden one", moderation: "hidden", viewer }), comment({ id: "m2", body: "Visible one", viewer })],
      extra: (url, init) => (url.pathname.startsWith("/api/v1/comments/") && init.method === "DELETE" ? new Response(null, { status: 204 }) : undefined),
    });
    renderPost();
    const hidden = (await screen.findByText("Hidden one")).closest("li")!;
    await userEvent.click(within(hidden).getByRole("button", { name: /^More actions/u }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete comment" }));
    await waitFor(() => expect(screen.queryByText("Hidden one")).not.toBeInTheDocument());
    expect(screen.getByText("2 comments")).toBeInTheDocument();

    const visible = screen.getByText("Visible one").closest("li")!;
    await userEvent.click(within(visible).getByRole("button", { name: /^More actions/u }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete comment" }));
    await waitFor(() => expect(screen.getByText("1 comment")).toBeInTheDocument());
  });
});

describe("post page", () => {
  it("treats loaded comments as not editable while the post is hidden", async () => {
    servePost({
      community: member({ viewerStatus: "moderator" }),
      post: postDetail({ moderation: "hidden", viewer: { canModerate: true } }),
      comments: [comment({ id: "m1", body: "Mine", viewer: MINE })],
    });
    renderPost();
    const row = (await screen.findByText("Mine")).closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: /^More actions/u }));
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("labels each menu button with what it acts on", async () => {
    servePost({
      post: postDetail({ title: "Launch plans", viewer: MINE }),
      comments: [comment({ id: "m1", body: "Mine", author: { id: "u-bo", displayName: "Bo Tran", avatarUrl: null }, viewer: MINE })],
    });
    renderPost();
    expect(await screen.findByRole("button", { name: "More actions for Launch plans" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "More actions for Bo Tran's comment" })).toBeInTheDocument();
  });

  it("clears ?edit=1 after Cancel and after Save", async () => {
    const mine = postDetail({ title: "Old", body: "Body", version: 3, viewer: MINE });
    servePost({ post: mine, extra: (url, init) => (url.pathname === "/api/v1/posts/p1" && init.method === "PATCH" ? json(postDetail({ title: "New", version: 4, viewer: MINE })) : undefined) });
    const first = renderPost({ startEditing: true, initial: mine });
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(router.replace).toHaveBeenCalledWith("/communities/northstar-founders/posts/p1");
    first.unmount();

    router.replace.mockClear();
    renderPost({ startEditing: true, initial: mine });
    await userEvent.clear(await screen.findByLabelText("Title"));
    await userEvent.type(screen.getByLabelText("Title"), "New");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/communities/northstar-founders/posts/p1"));
  });

  it("shows the generic load error for a 403 (no members-only branch on this page)", async () => {
    servePost({ extra: (url) => (url.pathname === "/api/v1/posts/p1" ? json({ code: "forbidden", detail: "Nope." }, 403) : undefined) });
    renderPost();
    expect(await screen.findByRole("heading", { name: "This post could not load" })).toBeInTheDocument();
    expect(screen.queryByText("Discussion unavailable")).not.toBeInTheDocument();
  });
});

describe("post not-found page", () => {
  it("says the discussion is not available without revealing anything, with a way back", () => {
    pathname.value = "/communities/northstar-founders/posts/p1";
    render(<PostUnavailable signedIn />);
    expect(screen.getByRole("heading", { name: "This discussion isn't available." })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Back to the community/u })).toHaveAttribute("href", "/communities/northstar-founders");
    expect(screen.queryByRole("link", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("offers Sign in with the current path when there is no session", () => {
    pathname.value = "/communities/northstar-founders/posts/p1";
    render(<PostUnavailable signedIn={false} />);
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", `/login?redirect=${encodeURIComponent("/communities/northstar-founders/posts/p1")}`);
  });
});

describe("dialogs keep focus after a failed request", () => {
  it("returns focus to Cancel in the confirm dialog", async () => {
    render(<ConfirmDialog confirmLabel="Delete post" message="Delete?" onClose={() => undefined} onConfirm={async () => Promise.reject(new Error("boom"))} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete post" }));
    await screen.findByRole("alert");
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
  });

  it("returns focus to the reason field in the moderation dialog", async () => {
    stubFetch(() => json({ code: "forbidden", detail: "You cannot moderate here." }, 403));
    render(<ModerationDialog action="hide" id="p1" kind="post" onClose={() => undefined} onDone={() => undefined} />);
    await userEvent.type(screen.getByLabelText("Reason"), "Spam ad");
    await userEvent.click(screen.getByRole("button", { name: "Hide post" }));
    await screen.findByRole("alert");
    await waitFor(() => expect(screen.getByLabelText("Reason")).toHaveFocus());
  });
});

describe("pending request on a public community", () => {
  const pending = () =>
    stubFetch((url, init) => {
      if (url.pathname === "/api/v1/communities/northstar-founders") return json(detail({ visibility: "public", viewerStatus: "pending" }));
      if (url.pathname === "/api/v1/communities/c-northstar/join" && init.method === "POST") return json({ status: "member", alreadyMember: false });
      if (url.pathname === "/api/v1/me/community-requests") {
        return json({ items: [{ id: "r-1", community: { slug: "northstar-founders", name: "Northstar Founders" }, status: "pending", message: "", createdAt: "2026-11-02T00:00:00.000Z", reviewedAt: null }] });
      }
      if (url.pathname === "/api/v1/community-requests/r-1" && init.method === "DELETE") return new Response(null, { status: 204 });
      if (url.pathname.endsWith("/posts")) return json({ items: [post()], nextCursor: null });
      return undefined;
    });

  it("offers Join and keeps Withdraw request as a secondary action", async () => {
    const { calls } = pending();
    render(<CommunityView slug="northstar-founders" />);
    const region = await screen.findByRole("region", { name: "Membership" });
    expect(await within(region).findByText("Request pending")).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Withdraw request" })).toBeInTheDocument();
    await userEvent.click(within(region).getByRole("button", { name: "Join" }));
    expect(await within(region).findByText("You're a member")).toBeInTheDocument();
    expect(calls.some((call) => call.method === "POST" && call.path === "/api/v1/communities/c-northstar/join")).toBe(true);
  });

  it("can still withdraw the request", async () => {
    const { calls } = pending();
    render(<CommunityView slug="northstar-founders" />);
    await userEvent.click(await screen.findByRole("button", { name: "Withdraw request" }));
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.path === "/api/v1/community-requests/r-1")).toBe(true));
  });

  it("disables both while the community is frozen", async () => {
    stubFetch((url) => (url.pathname === "/api/v1/communities/northstar-founders" ? json(detail({ visibility: "public", viewerStatus: "pending", frozen: true })) : json({ items: [], nextCursor: null })));
    render(<CommunityView slug="northstar-founders" />);
    const region = await screen.findByRole("region", { name: "Membership" });
    expect(await within(region).findByRole("button", { name: "Join" })).toBeDisabled();
    expect(within(region).getByRole("button", { name: "Withdraw request" })).toBeDisabled();
  });
});
