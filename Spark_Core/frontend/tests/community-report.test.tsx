import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { comment, detail, json, post, postDetail, stubFetch } from "./community-fixtures";
import type { CommunityDetail } from "../src/app/communities/types";
import type { CommentItem, PostDetail, PostSummary } from "../src/app/communities/_lib/content-api";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, notFound: vi.fn(), usePathname: () => "/communities/northstar-founders" }));

const auth = { isAuthenticated: true, isLoading: false, user: { id: "u-me" } as null | { id: string } };
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));
vi.mock("../src/app/signal-particles", () => ({ SignalParticles: () => null }));

import { CommunityView } from "../src/app/communities/[slug]/community-view";
import { PostView } from "../src/app/communities/[slug]/posts/[postId]/post-view";
import { ModerationDialog } from "../src/app/communities/_components/moderation-dialog";
import { ReportDialog } from "../src/app/communities/_components/report-dialog";

const FEED = "/api/v1/communities/c-northstar/posts";
const THANKS = "Thanks — moderators will review this.";

type Handler = (url: URL, init: RequestInit) => Response | undefined;

function serveFeed(community: CommunityDetail, items: PostSummary[], extra?: Handler) {
  return stubFetch((url, init) => {
    const handled = extra?.(url, init);
    if (handled) return handled;
    const method = init.method ?? "GET";
    if (url.pathname === "/api/v1/communities/northstar-founders" && method === "GET") return json(community);
    if (url.pathname === FEED && method === "GET") return json({ items, nextCursor: null });
    return undefined;
  });
}

function servePost(community: CommunityDetail, postBody: PostDetail, comments: CommentItem[], extra?: Handler) {
  return stubFetch((url, init) => {
    const handled = extra?.(url, init);
    if (handled) return handled;
    const method = init.method ?? "GET";
    if (url.pathname === "/api/v1/communities/northstar-founders" && method === "GET") return json(community);
    if (url.pathname === "/api/v1/posts/p1" && method === "GET") return json(postBody, 200, { ETag: `"v${postBody.version}"` });
    if (url.pathname === "/api/v1/posts/p1/comments" && method === "GET") return json({ items: comments, nextCursor: null });
    return undefined;
  });
}

const member = (overrides: Partial<CommunityDetail> = {}) => detail({ viewerStatus: "member", ...overrides });
const moderator = () => detail({ viewerStatus: "moderator" });
const openMenu = async (scope: HTMLElement) => userEvent.click(within(scope).getByRole("button", { name: /^More actions/u }));

describe("ReportDialog", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("offers the six reasons and needs one before Send", () => {
    const { calls } = stubFetch(() => undefined);
    render(<ReportDialog id="p1" kind="post" onClose={vi.fn()} onReported={vi.fn()} />);
    const labels = ["Spam", "Harassment", "Off-topic", "Misinformation", "Self-promotion", "Something else"];
    for (const label of labels) expect(screen.getByRole("radio", { name: label })).not.toBeChecked();
    expect(screen.getAllByRole("radio")).toHaveLength(6);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(calls).toHaveLength(0);
  });

  it("posts the reason and the details, counts the details and confirms", async () => {
    const { calls } = stubFetch((url, init) => (url.pathname === "/api/v1/posts/p1/reports" && init.method === "POST" ? json({ report: { id: "r1", status: "open" } }, 201) : undefined));
    const onReported = vi.fn();
    render(<ReportDialog id="p1" kind="post" onClose={vi.fn()} onReported={onReported} />);
    await userEvent.click(screen.getByRole("radio", { name: "Harassment" }));
    await userEvent.type(screen.getByLabelText("Details (optional)"), "Insults");
    expect(screen.getByText("7/1000")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(THANKS)).toBeInTheDocument();
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/api/v1/posts/p1/reports", body: { reason: "harassment", details: "Insults" } });
    expect(onReported).toHaveBeenCalledTimes(1);
  });

  it("sends no details when none were typed, and a comment goes to the comment route", async () => {
    const { calls } = stubFetch((url, init) => (url.pathname === "/api/v1/comments/m1/reports" && init.method === "POST" ? json({ report: { id: "r1", status: "open" } }, 200) : undefined));
    render(<ReportDialog id="m1" kind="comment" onClose={vi.fn()} onReported={vi.fn()} />);
    await userEvent.click(screen.getByRole("radio", { name: "Spam" }));
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(THANKS)).toBeInTheDocument();
    expect(calls.at(-1)?.body).toEqual({ reason: "spam" });
  });

  it("shows an API error and stays open", async () => {
    stubFetch(() => json({ code: "own_content", detail: "You cannot report your own content." }, 409));
    const onReported = vi.fn();
    render(<ReportDialog id="p1" kind="post" onClose={vi.fn()} onReported={onReported} />);
    await userEvent.click(screen.getByRole("radio", { name: "Spam" }));
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You cannot report your own content.");
    expect(onReported).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });
});

describe("ModerationDialog", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["hide", "post", "Hide this post"],
    ["restore", "post", "Restore this post"],
    ["dismiss", "post", "Keep and dismiss reports"],
    ["hide", "comment", "Hide this comment"],
  ] as const)("titles %s of a %s", (action, kind, title) => {
    render(<ModerationDialog action={action} id="x" kind={kind} onClose={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: title })).toBeInTheDocument();
  });

  it("blocks reasons under 3 characters and posts the action with the reason", async () => {
    const { calls } = stubFetch((url, init) => (url.pathname === "/api/v1/posts/p1/moderation" && init.method === "POST" ? json({ moderation: "hidden", reportsClosed: 2, changed: true, version: 2 }) : undefined));
    const onDone = vi.fn();
    render(<ModerationDialog action="hide" id="p1" kind="post" onClose={vi.fn()} onDone={onDone} />);
    const send = screen.getByRole("button", { name: "Hide post" });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Reason"), "ab");
    expect(send).toBeDisabled();
    expect(calls).toHaveLength(0);
    await userEvent.type(screen.getByLabelText("Reason"), "c");
    expect(screen.getByText("3/500")).toBeInTheDocument();
    await userEvent.click(send);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ moderation: "hidden", reportsClosed: 2, changed: true, version: 2 }));
    expect(calls.at(-1)?.body).toEqual({ action: "hide", reason: "abc" });
  });

  it("fills the reason from a staff template", async () => {
    stubFetch(() => undefined);
    render(<ModerationDialog action="hide" id="p1" kind="post" onClose={vi.fn()} onDone={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Spam or unsolicited promotion." }));
    expect(screen.getByLabelText("Reason")).toHaveValue("Spam or unsolicited promotion.");
  });

  it("keeps the dialog open with the error when the call fails", async () => {
    stubFetch(() => json({ code: "forbidden", detail: "You cannot moderate here." }, 403));
    const onDone = vi.fn();
    render(<ModerationDialog action="dismiss" id="p1" kind="post" onClose={vi.fn()} onDone={onDone} />);
    await userEvent.type(screen.getByLabelText("Reason"), "Fine as it is");
    await userEvent.click(screen.getByRole("button", { name: "Keep and dismiss" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You cannot moderate here.");
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe("report and moderation in the feed", () => {
  beforeEach(() => {
    auth.isAuthenticated = true;
    auth.user = { id: "u-me" };
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reports a post, then the menu says You reported this, and focus returns to the trigger", async () => {
    serveFeed(member(), [post({ id: "p1" })], (url, init) =>
      url.pathname === "/api/v1/posts/p1/reports" && init.method === "POST" ? json({ report: { id: "r1", status: "open" } }, 201) : undefined,
    );
    render(<CommunityView slug="northstar-founders" />);
    const card = await screen.findByRole("article");
    await openMenu(card);
    await userEvent.click(screen.getByRole("menuitem", { name: "Report" }));
    await userEvent.click(screen.getByRole("radio", { name: "Spam" }));
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(THANKS)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const trigger = within(card).getByRole("button", { name: /^More actions/u });
    expect(trigger).toHaveFocus();
    await userEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: "You reported this" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("menuitem", { name: "Report" })).not.toBeInTheDocument();
  });

  it("traps Tab inside the report dialog and returns focus on Escape", async () => {
    serveFeed(member(), [post({ id: "p1" })]);
    render(<CommunityView slug="northstar-founders" />);
    const card = await screen.findByRole("article");
    await openMenu(card);
    await userEvent.click(screen.getByRole("menuitem", { name: "Report" }));
    const dialog = screen.getByRole("dialog");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    cancel.focus();
    await userEvent.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await userEvent.tab({ shift: true });
    await userEvent.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /^More actions/u })).toHaveFocus();
  });

  it("hides a post in place for a moderator, badges it, and offers Restore", async () => {
    const { calls } = serveFeed(moderator(), [post({ id: "p1", viewer: { canModerate: true, canReport: true } })], (url, init) =>
      url.pathname === "/api/v1/posts/p1/moderation" && init.method === "POST" ? json({ moderation: "hidden", reportsClosed: 0, changed: true, version: 2 }) : undefined,
    );
    render(<CommunityView slug="northstar-founders" />);
    const card = await screen.findByRole("article");
    expect(within(card).queryByText("Hidden")).not.toBeInTheDocument();
    await openMenu(card);
    await userEvent.click(screen.getByRole("menuitem", { name: "Hide" }));
    expect(screen.getByRole("dialog", { name: "Hide this post" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Reason"), "Spam link");
    await userEvent.click(screen.getByRole("button", { name: "Hide post" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.at(-1)?.body).toEqual({ action: "hide", reason: "Spam link" });
    expect(within(screen.getByRole("article")).getByText("Hidden")).toBeInTheDocument();
    await openMenu(screen.getByRole("article"));
    expect(screen.getByRole("menuitem", { name: "Restore" })).toBeInTheDocument();
  });

  it("restores a hidden post and drops the badge", async () => {
    serveFeed(moderator(), [post({ id: "p1", moderation: "hidden", viewer: { canModerate: true } })], (url, init) =>
      url.pathname === "/api/v1/posts/p1/moderation" && init.method === "POST" ? json({ moderation: "visible", reportsClosed: 0, changed: true, version: 2 }) : undefined,
    );
    render(<CommunityView slug="northstar-founders" />);
    const card = await screen.findByRole("article");
    expect(within(card).getByText("Hidden")).toBeInTheDocument();
    await openMenu(card);
    await userEvent.click(screen.getByRole("menuitem", { name: "Restore" }));
    await userEvent.type(screen.getByLabelText("Reason"), "Reviewed, fine");
    await userEvent.click(screen.getByRole("button", { name: "Restore post" }));
    await waitFor(() => expect(within(screen.getByRole("article")).queryByText("Hidden")).not.toBeInTheDocument());
  });
});

describe("report and moderation on the post page", () => {
  beforeEach(() => {
    auth.isAuthenticated = true;
    auth.user = { id: "u-me" };
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reports a comment and marks only that comment as reported", async () => {
    const { calls } = servePost(member(), postDetail(), [comment({ id: "m1" }), comment({ id: "m2", body: "Other" })], (url, init) =>
      url.pathname === "/api/v1/comments/m1/reports" && init.method === "POST" ? json({ report: { id: "r1", status: "open" } }, 201) : undefined,
    );
    render(<PostView postId="p1" slug="northstar-founders" />);
    const first = (await screen.findByText("Count me in.")).closest("li")!;
    await openMenu(first);
    await userEvent.click(screen.getByRole("menuitem", { name: "Report" }));
    await userEvent.click(screen.getByRole("radio", { name: "Off-topic" }));
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(THANKS)).toBeInTheDocument();
    expect(calls.at(-1)).toMatchObject({ path: "/api/v1/comments/m1/reports", body: { reason: "off_topic" } });
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.click(within(first).getByRole("button", { name: /^More actions/u }));
    expect(screen.getByRole("menuitem", { name: "You reported this" })).toBeInTheDocument();
    const second = screen.getByText("Other").closest("li")!;
    await userEvent.keyboard("{Escape}");
    await userEvent.click(within(second).getByRole("button", { name: /^More actions/u }));
    expect(screen.getByRole("menuitem", { name: "Report" })).toBeInTheDocument();
  });

  it("hides the post and a comment in place for a moderator", async () => {
    const { calls } = servePost(moderator(), postDetail({ viewer: { canModerate: true } }), [comment({ id: "m1", viewer: { canModerate: true } })], (url, init) =>
      init.method === "POST" && url.pathname.endsWith("/moderation") ? json({ moderation: "hidden", reportsClosed: 1, changed: true, version: 2 }) : undefined,
    );
    render(<PostView postId="p1" slug="northstar-founders" />);
    const article = (await screen.findByRole("heading", { level: 1, name: "Hello founders" })).closest("article")!;
    await openMenu(article);
    await userEvent.click(screen.getByRole("menuitem", { name: "Hide" }));
    await userEvent.type(screen.getByLabelText("Reason"), "Not allowed");
    await userEvent.click(screen.getByRole("button", { name: "Hide post" }));
    await waitFor(() => expect(within(article).getByText("Hidden")).toBeInTheDocument());
    expect(calls.at(-1)?.path).toBe("/api/v1/posts/p1/moderation");

    const row = screen.getByText("Count me in.").closest("li")!;
    await openMenu(row);
    await userEvent.click(screen.getByRole("menuitem", { name: "Hide" }));
    expect(screen.getByRole("dialog", { name: "Hide this comment" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Reason"), "Rude");
    await userEvent.click(screen.getByRole("button", { name: "Hide comment" }));
    await waitFor(() => expect(within(row).getByText("Hidden")).toBeInTheDocument());
    expect(calls.at(-1)?.path).toBe("/api/v1/comments/m1/moderation");
  });
});

describe("ReportDialog focus", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps Shift+Tab and Tab inside the dialog when a radio other than the first is checked", async () => {
    stubFetch(() => undefined);
    render(<ReportDialog id="p1" kind="post" onClose={vi.fn()} onReported={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    const radio = screen.getByRole("radio", { name: "Misinformation" });
    await userEvent.click(radio);
    expect(radio).toHaveFocus();
    await userEvent.tab({ shift: true });
    const send = within(dialog).getByRole("button", { name: "Send" });
    expect(send).toHaveFocus();
    await userEvent.tab();
    expect(radio).toHaveFocus();
  });

  it("returns focus to the checked radio after an error", async () => {
    stubFetch(() => json({ code: "own_content", detail: "You cannot report your own content." }, 409));
    render(<ReportDialog id="p1" kind="post" onClose={vi.fn()} onReported={vi.fn()} />);
    await userEvent.click(screen.getByRole("radio", { name: "Harassment" }));
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Harassment" })).toHaveFocus());
  });
});

describe("moderation states", () => {
  beforeEach(() => {
    auth.isAuthenticated = true;
    auth.user = { id: "u-me" };
  });
  afterEach(() => vi.unstubAllGlobals());

  it("says the item stays hidden when keeping a hidden item", () => {
    const { rerender } = render(<ModerationDialog action="dismiss" hidden id="p1" kind="post" onClose={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getByText("The reports are closed and the post stays hidden.")).toBeInTheDocument();
    rerender(<ModerationDialog action="dismiss" hidden id="m1" kind="comment" onClose={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getByText("The reports are closed and the comment stays hidden.")).toBeInTheDocument();
    rerender(<ModerationDialog action="dismiss" id="m1" kind="comment" onClose={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getByText(/stays visible/)).toBeInTheDocument();
  });

  it("raises the local version after a changed moderation so the next edit sends the new If-Match", async () => {
    const mine = { isAuthor: true, canEdit: true, canDelete: true, canReport: false, canModerate: true };
    const { calls } = servePost(moderator(), postDetail({ version: 1, viewer: mine }), [], (url, init) => {
      if (url.pathname === "/api/v1/posts/p1/moderation" && init.method === "POST") return json({ moderation: "hidden", reportsClosed: 0, changed: true, version: 2 });
      if (url.pathname === "/api/v1/posts/p1" && init.method === "PATCH") return json(postDetail({ version: 3, title: "New title", viewer: mine }));
      return undefined;
    });
    render(<PostView postId="p1" slug="northstar-founders" />);
    const article = (await screen.findByRole("heading", { level: 1, name: "Hello founders" })).closest("article")!;
    await openMenu(article);
    await userEvent.click(screen.getByRole("menuitem", { name: "Hide" }));
    await userEvent.type(screen.getByLabelText("Reason"), "Testing");
    await userEvent.click(screen.getByRole("button", { name: "Hide post" }));
    await waitFor(() => expect(within(article).getByText("Hidden")).toBeInTheDocument());
    await openMenu(article);
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    await userEvent.clear(screen.getByLabelText("Title"));
    await userEvent.type(screen.getByLabelText("Title"), "New title");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    expect(calls.find((call) => call.method === "PATCH")?.headers["if-match"]).toBe('"v2"');
  });
});
