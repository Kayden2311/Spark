import { readFileSync } from "node:fs";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { comment, detail, json, postDetail, stubFetch } from "./community-fixtures";
import type { CommunityDetail } from "../src/app/communities/types";
import type { CommentItem, PostDetail } from "../src/app/communities/_lib/content-api";
import { clearFlash, peekFlash } from "../src/app/communities/_lib/flash";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const notFound = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => router, notFound, usePathname: () => "/communities/northstar-founders/posts/p1" }));

const auth = { isAuthenticated: true, isLoading: false, user: { id: "u-me" } as null | { id: string } };
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));
vi.mock("../src/app/signal-particles", () => ({ SignalParticles: () => null }));

import { PostView } from "../src/app/communities/[slug]/posts/[postId]/post-view";
import { CommunityView } from "../src/app/communities/[slug]/community-view";

const POST = "/api/v1/posts/p1";
const COMMENTS = "/api/v1/posts/p1/comments";
const MINE = { isAuthor: true, canEdit: true, canDelete: true, canReport: false };
const member = (overrides: Partial<CommunityDetail> = {}) => detail({ viewerStatus: "member", ...overrides });

interface World {
  community?: CommunityDetail;
  post?: PostDetail | Response;
  pages?: (url: URL) => { items: CommentItem[]; nextCursor: string | null };
  extra?: (url: URL, init: RequestInit) => Response | undefined;
}

function serve({ community = member(), post = postDetail(), pages, extra }: World = {}) {
  return stubFetch((url, init) => {
    const handled = extra?.(url, init);
    if (handled) return handled;
    const method = init.method ?? "GET";
    if (url.pathname === "/api/v1/communities/northstar-founders" && method === "GET") return json(community);
    if (url.pathname === POST && method === "GET") return post instanceof Response ? post.clone() : json(post, 200, { ETag: `"v${post.version}"` });
    if (url.pathname === COMMENTS && method === "GET") return json(pages ? pages(url) : { items: [], nextCursor: null });
    return undefined;
  });
}

const renderPost = (props: Partial<Parameters<typeof PostView>[0]> = {}) => render(<PostView postId="p1" slug="northstar-founders" {...props} />);

describe("post page", () => {
  beforeEach(() => {
    auth.isAuthenticated = true;
    auth.isLoading = false;
    auth.user = { id: "u-me" };
    router.push.mockClear();
    notFound.mockClear();
    clearFlash();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders the whole body as text with its line breaks, never as HTML", async () => {
    const body = "<script>alert(1)</script>\nsecond line\n\n<b>third</b>";
    serve({ post: postDetail({ title: "<img src=x onerror=alert(1)>", body }) });
    renderPost();

    const text = await screen.findByText((_, element) => element?.textContent === body && element.classList.contains("circlePostBody"));
    expect(text.textContent).toBe(body);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(document.querySelector("main script, main img, main b")).toBeNull();
    const css = readFileSync("src/app/globals.css", "utf8");
    expect(css).toMatch(/\.circlePostBody[^{]*\{[^}]*white-space:\s*pre-wrap[^}]*overflow-wrap:\s*anywhere/u);
    expect(css).toMatch(/\.circleCommentBody[^{]*\{[^}]*white-space:\s*pre-wrap[^}]*overflow-wrap:\s*anywhere/u);
  });

  it("links back to the community and shows author, edited and hidden labels", async () => {
    serve({ community: member({ viewerStatus: "moderator" }), post: postDetail({ editedAt: "2026-10-06T10:00:00.000Z", moderation: "hidden", viewer: { canModerate: true } }) });
    renderPost();
    expect(await screen.findByRole("heading", { level: 1, name: "Hello founders" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /Back to Northstar Founders/u })).toHaveAttribute("href", "/communities/northstar-founders");
    expect(screen.getByText("Ann Lee")).toBeInTheDocument();
    expect(screen.getByText("Edited")).toBeInTheDocument();
    expect(screen.getByText("Hidden")).toBeInTheDocument();
  });

  it("uses the post the server already resolved without asking again", async () => {
    const { calls } = serve();
    renderPost({ initial: postDetail({ title: "From the server" }) });
    expect(await screen.findByRole("heading", { level: 1, name: "From the server" })).toBeInTheDocument();
    await waitFor(() => expect(calls.some((call) => call.path === COMMENTS)).toBe(true));
    expect(calls.some((call) => call.path === POST)).toBe(false);
  });

  it("falls back to the not-found page when the post is gone", async () => {
    serve({ post: json({ code: "post_not_found", detail: "Post not found." }, 404) });
    renderPost();
    await waitFor(() => expect(notFound).toHaveBeenCalled());
  });

  it("shows an error with Try again for other failures", async () => {
    let fail = true;
    serve({ extra: (url) => (url.pathname === POST && fail ? json({ code: "database_unavailable", detail: "The database is unavailable." }, 503) : undefined) });
    renderPost();
    expect(await screen.findByRole("alert")).toHaveTextContent("The database is unavailable.");
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Hello founders" })).toBeInTheDocument();
  });

  describe("comments", () => {
    it("lists comments oldest first and appends the next page without duplicates", async () => {
      const { calls } = serve({
        post: postDetail({ commentCount: 3 }),
        pages: (url) =>
          url.searchParams.get("cursor") === "c-2"
            ? { items: [comment({ id: "m2", body: "Second" }), comment({ id: "m3", body: "Third" })], nextCursor: null }
            : { items: [comment({ id: "m1", body: "First" }), comment({ id: "m2", body: "Second" })], nextCursor: "c-2" },
      });
      renderPost();
      await screen.findByText("First");
      await userEvent.click(screen.getByRole("button", { name: "Show more" }));

      await screen.findByText("Third");
      const list = screen.getByRole("list", { name: "Comments" });
      expect(within(list).getAllByRole("listitem").map((item) => item.querySelector(".circleCommentBody")?.textContent)).toEqual(["First", "Second", "Third"]);
      expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
      expect(calls.filter((call) => call.path === COMMENTS).map((call) => call.search.get("cursor"))).toEqual([null, "c-2"]);
      expect(screen.getByText("3 comments")).toBeInTheDocument();
    });

    it("renders a comment body with line breaks as text", async () => {
      serve({ pages: () => ({ items: [comment({ body: "<i>hi</i>\nthere" })], nextCursor: null }) });
      renderPost();
      const body = await screen.findByText((_, element) => element?.textContent === "<i>hi</i>\nthere" && element.classList.contains("circleCommentBody"));
      expect(body).toBeInTheDocument();
      expect(document.querySelector("main i")).toBeNull();
    });

    it("posts a comment with an Idempotency-Key and appends it", async () => {
      const created = comment({ id: "m9", body: "Nice one", author: { id: "u-me", displayName: "Me", avatarUrl: null }, viewer: MINE });
      const { calls } = serve({
        post: postDetail({ commentCount: 1 }),
        pages: () => ({ items: [comment({ id: "m1", body: "First" })], nextCursor: null }),
        extra: (url, init) => (url.pathname === COMMENTS && init.method === "POST" ? json(created, 201) : undefined),
      });
      renderPost();
      await screen.findByText("First");
      const field = screen.getByLabelText("Add a comment");
      const submit = screen.getByRole("button", { name: "Comment" });
      expect(screen.getByText("0/2000")).toBeInTheDocument();
      expect(submit).toBeDisabled();
      expect(field).toHaveAttribute("maxlength", "2000");
      await userEvent.type(field, "Nice one");
      expect(screen.getByText("8/2000")).toBeInTheDocument();
      await userEvent.click(submit);

      await screen.findByText("Nice one");
      expect(field).toHaveValue("");
      expect(screen.getByText("2 comments")).toBeInTheDocument();
      const write = calls.find((call) => call.method === "POST")!;
      expect(write.body).toEqual({ body: "Nice one" });
      expect(write.headers["idempotency-key"]).toMatch(/^[A-Za-z0-9_.:-]{1,100}$/u);
      const items = within(screen.getByRole("list", { name: "Comments" })).getAllByRole("listitem");
      expect(items).toHaveLength(2);
      expect(items[1]).toHaveTextContent("Nice one");
    });

    it("appends a new comment when everything is loaded", async () => {
      serve({
        pages: () => ({ items: [comment({ id: "m1", body: "First" })], nextCursor: null }),
        extra: (url, init) => (url.pathname === COMMENTS && init.method === "POST" ? json(comment({ id: "m9", body: "Last", viewer: MINE }), 201) : undefined),
      });
      renderPost();
      await screen.findByText("First");
      await userEvent.type(screen.getByLabelText("Add a comment"), "Last");
      await userEvent.click(screen.getByRole("button", { name: "Comment" }));
      await screen.findByText("Last");
      expect(screen.queryByText("Comment posted — it will appear after the earlier comments.")).not.toBeInTheDocument();
    });

    it("keeps a new comment out of the list while older ones are unloaded, and Show more brings it in once", async () => {
      const created = comment({ id: "m9", body: "Newest", viewer: MINE });
      serve({
        post: postDetail({ commentCount: 2 }),
        pages: (url) =>
          url.searchParams.get("cursor") === "c-2"
            ? { items: [comment({ id: "m2", body: "Second" }), created], nextCursor: null }
            : { items: [comment({ id: "m1", body: "First" })], nextCursor: "c-2" },
        extra: (url, init) => (url.pathname === COMMENTS && init.method === "POST" ? json(created, 201) : undefined),
      });
      renderPost();
      await screen.findByText("First");
      await userEvent.type(screen.getByLabelText("Add a comment"), "Newest");
      await userEvent.click(screen.getByRole("button", { name: "Comment" }));

      const note = await screen.findByText("Comment posted — it will appear after the earlier comments.");
      expect(note).toHaveAttribute("role", "status");
      expect(screen.queryByText("Newest")).not.toBeInTheDocument();
      expect(screen.getByText("3 comments")).toBeInTheDocument();
      expect(screen.getByLabelText("Add a comment")).toHaveValue("");

      await userEvent.click(screen.getByRole("button", { name: "Show more" }));
      await screen.findByText("Newest");
      expect(screen.getAllByText("Newest")).toHaveLength(1);
      expect(screen.queryByText("Comment posted — it will appear after the earlier comments.")).not.toBeInTheDocument();
      const list = screen.getByRole("list", { name: "Comments" });
      expect(within(list).getAllByRole("listitem").map((item) => item.querySelector(".circleCommentBody")?.textContent)).toEqual(["First", "Second", "Newest"]);
    });

    it("returns focus on Escape, then moves it to the comments heading after a delete that answers 404", async () => {
      serve({
        post: postDetail({ commentCount: 1, viewer: { canReport: false } }),
        pages: () => ({ items: [comment({ id: "m1", body: "Mine", viewer: MINE })], nextCursor: null }),
        extra: (url, init) => (url.pathname === "/api/v1/comments/m1" && init.method === "DELETE" ? json({ code: "comment_not_found", detail: "Comment not found." }, 404) : undefined),
      });
      renderPost();
      await screen.findByText("Mine");
      const trigger = screen.getByRole("button", { name: "More actions" });
      await userEvent.click(trigger);
      await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
      await userEvent.keyboard("{Escape}");
      expect(trigger).toHaveFocus();
      await userEvent.click(trigger);
      await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
      await userEvent.click(screen.getByRole("button", { name: "Delete comment" }));
      await waitFor(() => expect(screen.queryByText("Mine")).not.toBeInTheDocument());
      expect(screen.getByRole("heading", { name: "Comments" })).toHaveFocus();
      expect(screen.getByText("This is no longer available.")).toBeInTheDocument();
    });

    it("reuses the key when the same comment is retried", async () => {
      let attempts = 0;
      const { calls } = serve({
        extra: (url, init) => {
          if (url.pathname !== COMMENTS || init.method !== "POST") return undefined;
          attempts += 1;
          return attempts === 1 ? json({ code: "retry_later", detail: "The request collided with another change. Try again." }, 503) : json(comment({ id: "m9", body: "Again", viewer: MINE }), 201);
        },
      });
      renderPost();
      await userEvent.type(await screen.findByLabelText("Add a comment"), "Again");
      await userEvent.click(screen.getByRole("button", { name: "Comment" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("The request collided with another change. Try again.");
      await userEvent.click(screen.getByRole("button", { name: "Comment" }));
      await screen.findByText("Again");
      const keys = calls.filter((call) => call.method === "POST").map((call) => call.headers["idempotency-key"]);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(keys[1]);
    });

    it("shows who can comment: sign in, join, paused, or a hidden post", async () => {
      auth.isAuthenticated = false;
      auth.user = null;
      serve({ community: detail() });
      const first = renderPost();
      expect(await screen.findByRole("link", { name: "Sign in to join the discussion" })).toHaveAttribute("href", "/login?redirect=%2Fcommunities%2Fnorthstar-founders%2Fposts%2Fp1");
      expect(screen.queryByLabelText("Add a comment")).not.toBeInTheDocument();
      first.unmount();

      auth.isAuthenticated = true;
      auth.user = { id: "u-me" };
      serve({ community: detail({ viewerStatus: "none" }) });
      const second = renderPost();
      expect(await screen.findByText("Join to comment")).toBeInTheDocument();
      second.unmount();

      serve({ community: member({ frozen: true }) });
      const third = renderPost();
      expect(await screen.findByText("This community is paused by Spark moderators.")).toBeInTheDocument();
      expect(screen.queryByLabelText("Add a comment")).not.toBeInTheDocument();
      third.unmount();

      serve({ post: postDetail({ moderation: "hidden", viewer: { canModerate: true } }) });
      renderPost();
      expect(await screen.findByText("Hidden")).toBeInTheDocument();
      expect(screen.queryByLabelText("Add a comment")).not.toBeInTheDocument();
    });

    it("edits and deletes the author's comment, and shows Report for others", async () => {
      const { calls } = serve({
        post: postDetail({ commentCount: 2 }),
        pages: () => ({ items: [comment({ id: "m1", body: "Mine", version: 4, viewer: MINE }), comment({ id: "m2", body: "Theirs" })], nextCursor: null }),
        extra: (url, init) => {
          if (url.pathname === "/api/v1/comments/m1" && init.method === "PATCH") return json(comment({ id: "m1", body: "Mine, edited", version: 5, editedAt: "2026-10-06T10:00:00.000Z", viewer: MINE }));
          if (url.pathname === "/api/v1/comments/m1" && init.method === "DELETE") return new Response(null, { status: 204 });
          return undefined;
        },
      });
      renderPost();
      await screen.findByText("Mine");
      const [mine, theirs] = within(screen.getByRole("list", { name: "Comments" })).getAllByRole("listitem");

      await userEvent.click(within(mine!).getByRole("button", { name: "More actions" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
      const editor = within(mine!).getByLabelText("Edit comment");
      expect(editor).toHaveValue("Mine");
      await userEvent.clear(editor);
      await userEvent.type(editor, "Mine, edited");
      await userEvent.click(within(mine!).getByRole("button", { name: "Save" }));
      await screen.findByText("Mine, edited");
      expect(within(mine!).getByText("Edited")).toBeInTheDocument();
      const patch = calls.find((call) => call.method === "PATCH")!;
      expect(patch.headers["if-match"]).toBe('"v4"');
      expect(patch.body).toEqual({ body: "Mine, edited" });

      await userEvent.click(within(mine!).getByRole("button", { name: "More actions" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
      expect(within(screen.getByRole("dialog")).getByText("Delete this comment? This can't be undone.")).toBeInTheDocument();
      await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete comment" }));
      await waitFor(() => expect(screen.queryByText("Mine, edited")).not.toBeInTheDocument());
      expect(screen.getByText("1 comment")).toBeInTheDocument();
      expect(theirs).toBeInTheDocument();
    });

    it("reloads a comment that changed elsewhere on 412", async () => {
      serve({
        post: postDetail({ viewer: { canReport: false } }),
        pages: () => ({ items: [comment({ id: "m1", body: "Mine", version: 1, viewer: MINE })], nextCursor: null }),
        extra: (url, init) =>
          url.pathname === "/api/v1/comments/m1" && init.method === "PATCH"
            ? json({ code: "version_mismatch", detail: "stale", current: comment({ id: "m1", body: "Newer text", version: 2, viewer: MINE }) }, 412)
            : undefined,
      });
      renderPost();
      await screen.findByText("Mine");
      await userEvent.click(screen.getByRole("button", { name: "More actions" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
      await userEvent.type(screen.getByLabelText("Edit comment"), "!");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByText("This was changed elsewhere — reloaded the latest version")).toBeInTheDocument();
      expect(screen.getByText("Newer text")).toBeInTheDocument();
      expect(screen.queryByLabelText("Edit comment")).not.toBeInTheDocument();
    });
  });

  describe("editing the post", () => {
    const mine = () => postDetail({ title: "Old title", body: "Old body", version: 3, viewer: MINE });

    it("saves with If-Match and shows the result", async () => {
      const { calls } = serve({
        post: mine(),
        extra: (url, init) =>
          url.pathname === POST && init.method === "PATCH"
            ? json(postDetail({ title: "New title", body: "Old body", version: 4, editedAt: "2026-10-06T10:00:00.000Z", viewer: MINE }), 200, { ETag: '"v4"' })
            : undefined,
      });
      renderPost();
      await screen.findByRole("heading", { level: 1, name: "Old title" });
      await userEvent.click(screen.getByRole("button", { name: "More actions" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
      const title = screen.getByLabelText("Title");
      expect(title).toHaveValue("Old title");
      expect(screen.getByText("9/150")).toBeInTheDocument();
      expect(screen.getByText("8/10000")).toBeInTheDocument();
      await userEvent.clear(title);
      await userEvent.type(title, "New title");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(await screen.findByRole("heading", { level: 1, name: "New title" })).toBeInTheDocument();
      expect(screen.getByText("Edited")).toBeInTheDocument();
      const patch = calls.find((call) => call.method === "PATCH")!;
      expect(patch.headers["if-match"]).toBe('"v3"');
      expect(patch.body).toEqual({ title: "New title" });
    });

    it("opens straight in the editor when asked and Cancel restores the text", async () => {
      serve({ post: mine() });
      renderPost({ startEditing: true });
      const title = await screen.findByLabelText("Title");
      await userEvent.type(title, " more");
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.getByRole("heading", { level: 1, name: "Old title" })).toBeInTheDocument();
      expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
    });

    it("keeps Save disabled for blank or unchanged text", async () => {
      serve({ post: mine() });
      renderPost({ startEditing: true });
      const save = await screen.findByRole("button", { name: "Save" });
      expect(save).toBeDisabled();
      await userEvent.clear(screen.getByLabelText("Title"));
      expect(save).toBeDisabled();
    });

    it("reloads the latest version on 412", async () => {
      serve({
        post: mine(),
        extra: (url, init) =>
          url.pathname === POST && init.method === "PATCH"
            ? json({ code: "version_mismatch", detail: "stale", current: postDetail({ title: "Changed elsewhere", body: "Old body", version: 4, viewer: MINE }) }, 412)
            : undefined,
      });
      renderPost({ startEditing: true });
      await userEvent.type(await screen.findByLabelText("Title"), "!");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(await screen.findByText("This was changed elsewhere — reloaded the latest version")).toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 1, name: "Changed elsewhere" })).toBeInTheDocument();
      expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
    });

    it("hides Edit when the author cannot edit", async () => {
      serve({ post: postDetail({ viewer: { ...MINE, canEdit: false } }) });
      renderPost();
      await screen.findByRole("heading", { level: 1 });
      await userEvent.click(screen.getByRole("button", { name: "More actions" }));
      expect(screen.queryByRole("menuitem", { name: "Edit" })).not.toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
    });
  });

  describe("deleting the post", () => {
    it("confirms, deletes, goes back to the community and leaves a toast for it", async () => {
      const { calls } = serve({
        post: postDetail({ viewer: MINE }),
        extra: (url, init) => (url.pathname === POST && init.method === "DELETE" ? new Response(null, { status: 204 }) : undefined),
      });
      renderPost();
      await screen.findByRole("heading", { level: 1 });
      await userEvent.click(screen.getByRole("button", { name: "More actions" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText("Delete this post? This can't be undone.")).toBeInTheDocument();
      expect(calls.some((call) => call.method === "DELETE")).toBe(false);
      await userEvent.click(within(dialog).getByRole("button", { name: "Delete post" }));

      await waitFor(() => expect(router.push).toHaveBeenCalledWith("/communities/northstar-founders"));
      expect(peekFlash()).toBe("Post deleted");
    });

    it("goes back with the unavailable message when the post is already gone", async () => {
      serve({
        post: postDetail({ viewer: MINE }),
        extra: (url, init) => (url.pathname === POST && init.method === "DELETE" ? json({ code: "post_not_found", detail: "Post not found." }, 404) : undefined),
      });
      renderPost();
      await screen.findByRole("heading", { level: 1 });
      await userEvent.click(screen.getByRole("button", { name: "More actions" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
      await userEvent.click(screen.getByRole("button", { name: "Delete post" }));
      await waitFor(() => expect(router.push).toHaveBeenCalledWith("/communities/northstar-founders"));
      expect(peekFlash()).toBe("This is no longer available.");
    });

    it("keeps the dialog open with the error when the delete fails", async () => {
      serve({
        post: postDetail({ viewer: MINE }),
        extra: (url, init) => (url.pathname === POST && init.method === "DELETE" ? json({ code: "request_failed", detail: "Could not delete." }, 500) : undefined),
      });
      renderPost();
      await screen.findByRole("heading", { level: 1 });
      await userEvent.click(screen.getByRole("button", { name: "More actions" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
      await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete post" }));
      expect(await within(screen.getByRole("dialog")).findByRole("alert")).toBeInTheDocument();
      expect(router.push).not.toHaveBeenCalled();
    });

    it("shows the leftover toast on the community page", async () => {
      vi.useRealTimers();
      stubFetch((url) => (url.pathname === "/api/v1/communities/northstar-founders" ? json(detail({ viewerStatus: "member" })) : url.pathname.endsWith("/posts") ? json({ items: [], nextCursor: null }) : undefined));
      const { setFlash } = await import("../src/app/communities/_lib/flash");
      setFlash("Post deleted");
      render(<CommunityView slug="northstar-founders" />);
      expect(await screen.findByText("Post deleted")).toBeInTheDocument();
      expect(peekFlash()).toBeNull();
    });
  });
});
