"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth-context";
import { ConfirmDialog } from "../_components/confirm-dialog";
import type { ModerateAction } from "../_components/content-menu";
import { ModerationDialog } from "../_components/moderation-dialog";
import { ReportDialog } from "../_components/report-dialog";
import { ApiError, loginPath, messageOf, PAUSED_MESSAGE } from "../_lib/api";
import { appendUnique, asReported, contentApi, GONE_MESSAGE, summaryOf, type PostDetail, type PostSummary } from "../_lib/content-api";
import type { CommunityDetail } from "../types";
import { Composer } from "./composer";
import { PostCard } from "./post-card";

const MEMBER_STATUSES = new Set(["owner", "moderator", "member"]);

interface FeedProps {
  community: CommunityDetail;
  notify: (text: string) => void;
}

interface Settled {
  key: string;
  items: PostSummary[];
  nextCursor: string | null;
  /** "members_only": the API refused the read (401 or 403) even though the page expected to read it. */
  error: { message: string; membersOnly: boolean } | null;
}

export const MEMBERS_ONLY_MESSAGE = "Members only — request access to read the discussions";

/** The Discussions section: composer or the reason there is none, then the posts. */
export function Feed({ community, notify }: FeedProps) {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const base = `/communities/${encodeURIComponent(community.slug)}`;
  const status = community.viewerStatus;
  const isMember = status !== null && MEMBER_STATUSES.has(status);
  const readable = community.visibility === "public" || isMember;

  const [attempt, setAttempt] = useState(0);
  const key = `${attempt}:${community.id}`;
  const [settled, setSettled] = useState<Settled>({ key: "", items: [], nextCursor: null, error: null });
  const [more, setMore] = useState<{ key: string; loading: boolean; error: string | null }>({ key: "", loading: false, error: null });
  const [deleting, setDeleting] = useState<PostSummary | null>(null);
  const [reporting, setReporting] = useState<PostSummary | null>(null);
  const [moderating, setModerating] = useState<{ post: PostSummary; action: ModerateAction } | null>(null);

  useEffect(() => {
    if (!readable) return;
    const controller = new AbortController();
    contentApi
      .feed(community.id, null, controller.signal)
      .then((page) => setSettled({ key, items: page.items, nextCursor: page.nextCursor, error: null }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const membersOnly = error instanceof ApiError && (error.status === 401 || error.status === 403);
        setSettled({ key, items: [], nextCursor: null, error: { message: messageOf(error), membersOnly } });
      });
    return () => controller.abort();
  }, [community.id, key, readable]);

  const current = settled.key === key;
  const items = current ? settled.items : [];
  const cursor = current ? settled.nextCursor : null;
  const loadingMore = more.key === key && more.loading;

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setMore({ key, loading: true, error: null });
    try {
      const page = await contentApi.feed(community.id, cursor);
      setSettled((previous) => (previous.key === key ? { ...previous, items: appendUnique(previous.items, page.items), nextCursor: page.nextCursor } : previous));
      setMore({ key, loading: false, error: null });
    } catch (error) {
      setMore({ key, loading: false, error: messageOf(error) });
    }
  }, [community.id, cursor, key, loadingMore]);

  const prepend = (post: PostDetail) =>
    setSettled((previous) => (previous.key === key ? { ...previous, items: appendUnique([summaryOf(post)], previous.items) } : previous));

  const remove = (id: string) =>
    setSettled((previous) => (previous.key === key ? { ...previous, items: previous.items.filter((item) => item.id !== id) } : previous));

  const patch = (id: string, change: (post: PostSummary) => PostSummary) =>
    setSettled((previous) => (previous.key === key ? { ...previous, items: previous.items.map((item) => (item.id === id ? change(item) : item)) } : previous));

  let compose: React.ReactNode = null;
  if (community.frozen) {
    compose = <p className="circleFeedNote">{PAUSED_MESSAGE}</p>;
  } else if (isMember) {
    compose = <Composer communityId={community.id} onCreated={prepend} />;
  } else if (isLoading) {
    compose = null;
  } else if (!isAuthenticated) {
    compose = (
      <p className="circleFeedNote">
        <Link href={loginPath(base)}>Sign in to join the discussion</Link>
      </p>
    );
  } else if (readable) {
    compose = <p className="circleFeedNote">Join to post</p>;
  }

  let list: React.ReactNode;
  if (!readable || (current && settled.error?.membersOnly)) {
    list = <p className="circleFeedNote">{MEMBERS_ONLY_MESSAGE}</p>;
  } else if (!current) {
    list = (
      <p aria-busy="true" className="circleFeedNote" role="status">
        Loading discussions…
      </p>
    );
  } else if (settled.error) {
    list = (
      <div className="circleFeedError">
        <p className="circleNotice circleNoticeError" role="alert">
          {settled.error.message}
        </p>
        <button className="circleGhostBtn" onClick={() => setAttempt((value) => value + 1)} type="button">
          Try again
        </button>
      </div>
    );
  } else if (items.length === 0) {
    list = <p className="circleFeedNote">{isMember && !community.frozen ? "No posts yet — start the first discussion" : "No posts yet"}</p>;
  } else {
    list = (
      <>
        <div className="circlePostList">
          {items.map((post) => (
            <PostCard
              key={post.id}
              onDelete={setDeleting}
              onEdit={(target) => router.push(`${base}/posts/${encodeURIComponent(target.id)}?edit=1`)}
              onModerate={(target, action) => setModerating({ post: target, action })}
              onReport={setReporting}
              post={post}
              slug={community.slug}
            />
          ))}
        </div>
        {cursor && (
          <div className="circleShowMore">
            <button className="circleGhostBtn" disabled={loadingMore} onClick={() => void loadMore()} type="button">
              {loadingMore ? "Loading…" : "Show more"}
            </button>
            {more.key === key && more.error && (
              <p className="circleNotice circleNoticeError" role="alert">
                {more.error}
              </p>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <section aria-labelledby="discussions-title" className="circleSectionCard">
      <div className="circleSectionHeading">
        <div>
          <span className="circleKicker">Discussions</span>
          <h2 id="discussions-title" tabIndex={-1}>Community discussions</h2>
        </div>
      </div>
      {compose}
      {list}
      {reporting && (
        <ReportDialog
          fallbackFocus={() => document.getElementById("discussions-title")}
          id={reporting.id}
          kind="post"
          onClose={() => setReporting(null)}
          onReported={() => patch(reporting.id, asReported)}
        />
      )}
      {moderating && (
        <ModerationDialog
          action={moderating.action}
          fallbackFocus={() => document.getElementById("discussions-title")}
          id={moderating.post.id}
          kind="post"
          onClose={() => setModerating(null)}
          onDone={(result) => patch(moderating.post.id, (item) => ({ ...item, moderation: result.moderation }))}
        />
      )}
      {deleting && (
        <ConfirmDialog
          confirmLabel="Delete post"
          message="Delete this post? This can't be undone."
          fallbackFocus={() => document.getElementById("discussions-title")}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await contentApi.deletePost(deleting.id);
              notify("Post deleted");
            } catch (failure) {
              // Already gone: drop it from the list and say so instead of leaving a dead card.
              if (!(failure instanceof ApiError && failure.status === 404)) throw failure;
              notify(GONE_MESSAGE);
            }
            remove(deleting.id);
            setDeleting(null);
          }}
        />
      )}
    </section>
  );
}
