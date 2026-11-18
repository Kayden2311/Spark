import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detail, json, post, postDetail, stubFetch } from "./community-fixtures";
import type { CommunityDetail } from "../src/app/communities/types";
import type { PostSummary } from "../src/app/communities/_lib/content-api";
import { ContentMenu } from "../src/app/communities/_components/content-menu";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, notFound: vi.fn(), usePathname: () => "/communities/northstar-founders" }));

const auth = { isAuthenticated: true, isLoading: false, user: { id: "u-me" } as null | { id: string } };
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));
vi.mock("../src/app/signal-particles", () => ({ SignalParticles: () => null }));

import { CommunityView } from "../src/app/communities/[slug]/community-view";

const FEED = "/api/v1/communities/c-northstar/posts";

type Handler = (url: URL, init: RequestInit) => Response | undefined;
type Page = { items: PostSummary[]; nextCursor: string | null };

function serve(community: CommunityDetail, items: PostSummary[] | ((url: URL) => Page), extra?: Handler) {
  return stubFetch((url, init) => {
    const handled = extra?.(url, init);
    if (handled) return handled;
    const method = init.method ?? "GET";
    if (url.pathname === "/api/v1/communities/northstar-founders" && method === "GET") return json(community);
    if (url.pathname === FEED && method === "GET") return json(typeof items === "function" ? items(url) : { items, nextCursor: null });
    return undefined;
  });
}

const member = (overrides: Partial<CommunityDetail> = {}) => detail({ viewerStatus: "member", ...overrides });
const feedSection = () => screen.getByRole("region", { name: "Community discussions" });
const AUTHOR = { isAuthor: true, canEdit: true, canDelete: true, canReport: false };

describe("community feed", () => {
  beforeEach(() => {
    auth.isAuthenticated = true;
    auth.isLoading = false;
    auth.user = { id: "u-me" };
    router.push.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the composer and the posts to a member", async () => {
    serve(member(), [
      post({ id: "p1", title: "Hello founders", commentCount: 3, editedAt: "2026-10-06T10:00:00.000Z" }),
      post({ id: "p2", title: "Long one", excerpt: "A long excerpt", truncated: true, author: { id: "u-bo", displayName: "Bo Tran", avatarUrl: null } }),
    ]);
    render(<CommunityView slug="northstar-founders" />);

    expect(await screen.findByRole("link", { name: "Hello founders" })).toHaveAttribute("href", "/communities/northstar-founders/posts/p1");
    expect(within(feedSection()).getByLabelText("Title")).toBeInTheDocument();
    const [first, second] = screen.getAllByRole("article");
    expect(within(first!).getByText("Ann Lee")).toBeInTheDocument();
    expect(within(first!).getByText("AL")).toBeInTheDocument();
    expect(within(first!).getByText("Edited")).toBeInTheDocument();
    expect(within(first!).getByText("3 comments")).toBeInTheDocument();
    expect(within(first!).queryByRole("link", { name: "Read more" })).not.toBeInTheDocument();
    expect(within(second!).getByText("A long excerpt")).toBeInTheDocument();
    expect(within(second!).getByRole("link", { name: "Read more" })).toHaveAttribute("href", "/communities/northstar-founders/posts/p2");
    expect(within(second!).getByText("0 comments")).toBeInTheDocument();
  });

  it("lets a signed-out visitor read a public feed and asks them to sign in", async () => {
    auth.isAuthenticated = false;
    auth.user = null;
    serve(detail(), [post()]);
    render(<CommunityView slug="northstar-founders" />);

    expect(await screen.findByRole("link", { name: "Hello founders" })).toBeInTheDocument();
    expect(within(feedSection()).getByRole("link", { name: "Sign in to join the discussion" })).toHaveAttribute("href", "/login?redirect=%2Fcommunities%2Fnorthstar-founders");
    expect(within(feedSection()).queryByLabelText("Title")).not.toBeInTheDocument();
  });

  it("tells a signed-in non-member of a public community to join", async () => {
    serve(detail({ viewerStatus: "none" }), [post()]);
    render(<CommunityView slug="northstar-founders" />);
    expect(await screen.findByRole("link", { name: "Hello founders" })).toBeInTheDocument();
    expect(within(feedSection()).getByText("Join to post")).toBeInTheDocument();
    expect(within(feedSection()).queryByLabelText("Title")).not.toBeInTheDocument();
  });

  it("hides the feed of a private community from non-members without asking for it", async () => {
    const { calls } = serve(detail({ visibility: "private", viewerStatus: "none" }), [post()]);
    render(<CommunityView slug="northstar-founders" />);
    expect(await within(await screen.findByRole("region", { name: "Community discussions" })).findByText("Members only — request access to read the discussions")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Hello founders" })).not.toBeInTheDocument();
    expect(calls.some((call) => call.path === FEED)).toBe(false);
  });

  it("replaces the composer with the paused notice when the community is frozen", async () => {
    serve(member({ frozen: true }), [post()]);
    render(<CommunityView slug="northstar-founders" />);
    expect(await screen.findByRole("link", { name: "Hello founders" })).toBeInTheDocument();
    expect(within(feedSection()).getByText("This community is paused by Spark moderators.")).toBeInTheDocument();
    expect(within(feedSection()).queryByLabelText("Title")).not.toBeInTheDocument();
  });

  it("words the empty feed for members and for everyone else", async () => {
    serve(member(), []);
    const first = render(<CommunityView slug="northstar-founders" />);
    expect(await within(await screen.findByRole("region", { name: "Community discussions" })).findByText("No posts yet — start the first discussion")).toBeInTheDocument();
    first.unmount();

    serve(detail({ viewerStatus: "none" }), []);
    render(<CommunityView slug="northstar-founders" />);
    expect(await screen.findByText("No posts yet")).toBeInTheDocument();
    expect(screen.queryByText("No posts yet — start the first discussion")).not.toBeInTheDocument();
  });

  it("shows an error with Try again when the feed cannot load", async () => {
    let fail = true;
    serve(member(), [post()], (url) => (url.pathname === FEED && fail ? json({ code: "database_unavailable", detail: "The database is unavailable." }, 503) : undefined));
    render(<CommunityView slug="northstar-founders" />);
    expect(await within(await screen.findByRole("region", { name: "Community discussions" })).findByRole("alert")).toHaveTextContent("The database is unavailable.");
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "Hello founders" })).toBeInTheDocument();
  });

  it("appends the next page on Show more without duplicates", async () => {
    const { calls } = serve(member(), (url) =>
      url.searchParams.get("cursor") === "next-1"
        ? { items: [post({ id: "p2", title: "Second" }), post({ id: "p3", title: "Third" })], nextCursor: null }
        : { items: [post({ id: "p1", title: "First" }), post({ id: "p2", title: "Second" })], nextCursor: "next-1" },
    );
    render(<CommunityView slug="northstar-founders" />);
    await userEvent.click(await screen.findByRole("button", { name: "Show more" }));

    await screen.findByRole("link", { name: "Third" });
    expect(screen.getAllByRole("article")).toHaveLength(3);
    expect(screen.getAllByRole("link", { name: "Second" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
    expect(calls.filter((call) => call.path === FEED).map((call) => call.search.get("cursor"))).toEqual([null, "next-1"]);
  });

  describe("composer", () => {
    const created = () => postDetail({ id: "p9", title: "Fresh post", body: "Fresh body", author: { id: "u-me", displayName: "Me", avatarUrl: null }, viewer: AUTHOR });

    it("counts characters and stays disabled while empty", async () => {
      serve(member(), []);
      render(<CommunityView slug="northstar-founders" />);
      const title = await screen.findByLabelText("Title");
      const body = screen.getByLabelText("Body");
      const submit = screen.getByRole("button", { name: "Post" });
      expect(screen.getByText("0/150")).toBeInTheDocument();
      expect(screen.getByText("0/10000")).toBeInTheDocument();
      expect(submit).toBeDisabled();

      await userEvent.type(title, "Hi");
      expect(submit).toBeDisabled();
      await userEvent.type(body, "Body");
      expect(screen.getByText("2/150")).toBeInTheDocument();
      expect(screen.getByText("4/10000")).toBeInTheDocument();
      expect(submit).toBeEnabled();
      await userEvent.clear(title);
      await userEvent.type(title, "   ");
      expect(submit).toBeDisabled();
      expect(title).toHaveAttribute("maxlength", "150");
      expect(body).toHaveAttribute("maxlength", "10000");
    });

    it("posts with an Idempotency-Key, prepends the post and clears the form", async () => {
      const { calls } = serve(member(), [post({ id: "p1", title: "Older" })], (url, init) =>
        url.pathname === FEED && init.method === "POST" ? json(created(), 201, { ETag: '"v1"' }) : undefined,
      );
      render(<CommunityView slug="northstar-founders" />);
      await userEvent.type(await screen.findByLabelText("Title"), "Fresh post");
      await userEvent.type(screen.getByLabelText("Body"), "Fresh body");
      await userEvent.click(screen.getByRole("button", { name: "Post" }));

      await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
      expect(within(screen.getAllByRole("article")[0]!).getByRole("link", { name: "Fresh post" })).toBeInTheDocument();
      expect(screen.getByLabelText("Title")).toHaveValue("");
      expect(screen.getByLabelText("Body")).toHaveValue("");
      const write = calls.find((call) => call.method === "POST")!;
      expect(write.body).toEqual({ title: "Fresh post", body: "Fresh body" });
      expect(write.headers["idempotency-key"]).toMatch(/^[A-Za-z0-9_.:-]{1,100}$/u);
    });

    it("reuses the key when the same post is retried after a failure, and starts a new one when it changes", async () => {
      let attempts = 0;
      const { calls } = serve(member(), [], (url, init) => {
        if (url.pathname !== FEED || init.method !== "POST") return undefined;
        attempts += 1;
        return attempts <= 2 ? json({ code: "retry_later", detail: "The request collided with another change. Try again." }, 503) : json(created(), 201);
      });
      render(<CommunityView slug="northstar-founders" />);
      await userEvent.type(await screen.findByLabelText("Title"), "Fresh post");
      await userEvent.type(screen.getByLabelText("Body"), "Fresh body");
      await userEvent.click(screen.getByRole("button", { name: "Post" }));
      await within(feedSection()).findByRole("alert");
      await userEvent.click(screen.getByRole("button", { name: "Post" }));
      await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(2));
      await within(feedSection()).findByRole("alert");

      await userEvent.type(screen.getByLabelText("Body"), " more");
      await userEvent.click(screen.getByRole("button", { name: "Post" }));
      await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));

      const keys = calls.filter((call) => call.method === "POST").map((call) => call.headers["idempotency-key"]);
      expect(keys).toHaveLength(3);
      expect(keys[0]).toBe(keys[1]);
      expect(keys[2]).not.toBe(keys[0]);
    });

    it("shows the paused message on 409 community_frozen and keeps the text", async () => {
      serve(member(), [], (url, init) =>
        url.pathname === FEED && init.method === "POST" ? json({ code: "community_frozen", detail: "This community is frozen and does not take changes right now." }, 409) : undefined,
      );
      render(<CommunityView slug="northstar-founders" />);
      await userEvent.type(await screen.findByLabelText("Title"), "Hi");
      await userEvent.type(screen.getByLabelText("Body"), "There");
      await userEvent.click(screen.getByRole("button", { name: "Post" }));
      expect(await within(feedSection()).findByRole("alert")).toHaveTextContent("This community is paused by Spark moderators.");
      expect(screen.getByLabelText("Title")).toHaveValue("Hi");
    });

    it("shows an inline message on 403", async () => {
      serve(member(), [], (url, init) =>
        url.pathname === FEED && init.method === "POST" ? json({ code: "not_a_member", detail: "Only active members of the community can do this." }, 403) : undefined,
      );
      render(<CommunityView slug="northstar-founders" />);
      await userEvent.type(await screen.findByLabelText("Title"), "Hi");
      await userEvent.type(screen.getByLabelText("Body"), "There");
      await userEvent.click(screen.getByRole("button", { name: "Post" }));
      expect(await within(feedSection()).findByRole("alert")).toHaveTextContent("Only active members of the community can do this.");
    });

    it("disables Post while sending", async () => {
      let release: (response: Response) => void = () => undefined;
      serve(member(), [], (url, init) =>
        url.pathname === FEED && init.method === "POST" ? (new Promise<Response>((resolve) => (release = resolve)) as unknown as Response) : undefined,
      );
      render(<CommunityView slug="northstar-founders" />);
      await userEvent.type(await screen.findByLabelText("Title"), "Hi");
      await userEvent.type(screen.getByLabelText("Body"), "There");
      await userEvent.click(screen.getByRole("button", { name: "Post" }));
      expect(await screen.findByRole("button", { name: "Posting…" })).toBeDisabled();
      release(json(created(), 201));
      await screen.findByRole("button", { name: "Post" });
    });
  });

  describe("post actions", () => {
    it("deletes the author's post after confirmation and shows a toast", async () => {
      const { calls } = serve(member(), [post({ id: "p1", title: "Mine", viewer: AUTHOR }), post({ id: "p2", title: "Theirs" })], (url, init) =>
        url.pathname === "/api/v1/posts/p1" && init.method === "DELETE" ? new Response(null, { status: 204 }) : undefined,
      );
      render(<CommunityView slug="northstar-founders" />);
      await screen.findByRole("link", { name: "Mine" });
      const card = screen.getAllByRole("article")[0]!;
      await userEvent.click(within(card).getByRole("button", { name: "More actions" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText("Delete this post? This can't be undone.")).toBeInTheDocument();
      expect(calls.some((call) => call.method === "DELETE")).toBe(false);
      await userEvent.click(within(dialog).getByRole("button", { name: "Delete post" }));

      await waitFor(() => expect(screen.queryByRole("link", { name: "Mine" })).not.toBeInTheDocument());
      expect(screen.getByRole("link", { name: "Theirs" })).toBeInTheDocument();
      expect(screen.getByText("Post deleted")).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("returns focus to the menu button on Cancel and Escape, and traps Tab inside the dialog", async () => {
      serve(member(), [post({ viewer: AUTHOR })]);
      render(<CommunityView slug="northstar-founders" />);
      await screen.findByRole("link", { name: "Hello founders" });
      const trigger = screen.getByRole("button", { name: "More actions" });
      const openDialog = async () => {
        await userEvent.click(trigger);
        await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
      };
      await openDialog();
      const dialog = screen.getByRole("dialog");
      const cancel = within(dialog).getByRole("button", { name: "Cancel" });
      const confirm = within(dialog).getByRole("button", { name: "Delete post" });
      expect(cancel).toHaveFocus();
      await userEvent.tab();
      expect(confirm).toHaveFocus();
      await userEvent.tab();
      expect(cancel).toHaveFocus();
      await userEvent.tab({ shift: true });
      expect(confirm).toHaveFocus();
      await userEvent.click(cancel);
      expect(trigger).toHaveFocus();

      await openDialog();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });

    it("moves focus to the feed heading after a delete removes the card", async () => {
      serve(member(), [post({ id: "p1", viewer: AUTHOR })], (url, init) =>
        url.pathname === "/api/v1/posts/p1" && init.method === "DELETE" ? new Response(null, { status: 204 }) : undefined,
      );
      render(<CommunityView slug="northstar-founders" />);
      await screen.findByRole("link", { name: "Hello founders" });
      await userEvent.click(screen.getByRole("button", { name: "More actions" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
      await userEvent.click(screen.getByRole("button", { name: "Delete post" }));
      await waitFor(() => expect(screen.queryByRole("article")).not.toBeInTheDocument());
      expect(screen.getByRole("heading", { name: "Community discussions" })).toHaveFocus();
    });

    it("drops a post that is already gone and says so when the delete answers 404", async () => {
      serve(member(), [post({ id: "p1", viewer: AUTHOR })], (url, init) =>
        url.pathname === "/api/v1/posts/p1" && init.method === "DELETE" ? json({ code: "post_not_found", detail: "Post not found." }, 404) : undefined,
      );
      render(<CommunityView slug="northstar-founders" />);
      await screen.findByRole("link", { name: "Hello founders" });
      await userEvent.click(screen.getByRole("button", { name: "More actions" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
      await userEvent.click(screen.getByRole("button", { name: "Delete post" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(screen.queryByRole("article")).not.toBeInTheDocument();
      expect(screen.getByText("This is no longer available.")).toBeInTheDocument();
    });

    it("cancels the delete confirmation without deleting", async () => {
      const { calls } = serve(member(), [post({ viewer: AUTHOR })]);
      render(<CommunityView slug="northstar-founders" />);
      await screen.findByRole("link", { name: "Hello founders" });
      await userEvent.click(screen.getByRole("button", { name: "More actions" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
      await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    });

    it("opens the editor on the post page from Edit", async () => {
      serve(member(), [post({ id: "p1", viewer: AUTHOR })]);
      render(<CommunityView slug="northstar-founders" />);
      await screen.findByRole("link", { name: "Hello founders" });
      await userEvent.click(screen.getByRole("button", { name: "More actions" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
      expect(router.push).toHaveBeenCalledWith("/communities/northstar-founders/posts/p1?edit=1");
    });

    it("shows a Hidden label to moderators", async () => {
      serve(member({ viewerStatus: "moderator" }), [post({ moderation: "hidden", viewer: { canModerate: true } })]);
      render(<CommunityView slug="northstar-founders" />);
      expect(await within(await screen.findByRole("article")).findByText("Hidden")).toBeInTheDocument();
    });
  });
});

describe("More actions menu", () => {
  const viewer = (overrides: object = {}) => ({ isAuthor: false, reported: false, canEdit: false, canDelete: false, canReport: true, canModerate: false, ...overrides });
  const open = async () => userEvent.click(screen.getByRole("button", { name: "More actions" }));
  const items = () => screen.getAllByRole("menuitem").map((item) => item.textContent);

  it("offers Edit and Delete to the author, not Report", async () => {
    render(<ContentMenu hidden={false} onDelete={vi.fn()} onEdit={vi.fn()} onReport={vi.fn()} viewer={viewer(AUTHOR)} />);
    await open();
    expect(items()).toEqual(["Edit", "Delete"]);
  });

  it("hides Edit when the author cannot edit (paused or hidden) but keeps Delete", async () => {
    render(<ContentMenu hidden={false} onDelete={vi.fn()} onEdit={vi.fn()} viewer={viewer({ ...AUTHOR, canEdit: false })} />);
    await open();
    expect(items()).toEqual(["Delete"]);
  });

  it("offers Report to a signed-in non-author who has not reported, and calls the hook", async () => {
    const onReport = vi.fn();
    render(<ContentMenu hidden={false} onDelete={vi.fn()} onEdit={vi.fn()} onReport={onReport} viewer={viewer()} />);
    await open();
    expect(items()).toEqual(["Report"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Report" }));
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("shows a disabled You reported this once reported, and nothing when signed out", async () => {
    const { rerender } = render(<ContentMenu hidden={false} onReport={vi.fn()} viewer={viewer({ reported: true, canReport: false })} />);
    await open();
    expect(items()).toEqual(["You reported this"]);
    expect(screen.getByRole("menuitem", { name: "You reported this" })).toHaveAttribute("aria-disabled", "true");
    rerender(<ContentMenu hidden={false} onReport={vi.fn()} viewer={viewer({ canReport: false })} />);
    expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
  });

  it("offers Hide or Restore only with canModerate", async () => {
    const onModerate = vi.fn();
    const { rerender } = render(<ContentMenu hidden={false} onModerate={onModerate} onReport={vi.fn()} viewer={viewer({ canModerate: true })} />);
    await open();
    expect(items()).toEqual(["Report", "Hide"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Hide" }));
    expect(onModerate).toHaveBeenCalledWith("hide");

    rerender(<ContentMenu hidden onModerate={onModerate} viewer={viewer({ canModerate: true, canReport: false })} />);
    await open();
    expect(items()).toEqual(["Restore"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Restore" }));
    expect(onModerate).toHaveBeenLastCalledWith("restore");

    rerender(<ContentMenu hidden={false} onModerate={onModerate} viewer={viewer({ canReport: false })} />);
    expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
  });

  it("focuses the first item on open and moves with the arrow, Home and End keys", async () => {
    render(<ContentMenu hidden={false} onDelete={vi.fn()} onEdit={vi.fn()} onModerate={vi.fn()} viewer={viewer({ ...AUTHOR, canModerate: true })} />);
    await open();
    const [edit, remove, hide] = screen.getAllByRole("menuitem");
    expect(edit).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(remove).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(hide).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(edit).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(hide).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(edit).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(hide).toHaveFocus();
  });

  it("closes on Tab", async () => {
    render(<ContentMenu hidden={false} onReport={vi.fn()} viewer={viewer()} />);
    await open();
    await userEvent.tab();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    render(<ContentMenu hidden={false} onReport={vi.fn()} viewer={viewer()} />);
    await open();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
