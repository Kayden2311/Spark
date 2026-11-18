"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Byline } from "../../../_components/byline";
import { ConfirmDialog } from "../../../_components/confirm-dialog";
import { ContentMenu, type ModerateAction } from "../../../_components/content-menu";
import { ModerationDialog } from "../../../_components/moderation-dialog";
import { ReportDialog } from "../../../_components/report-dialog";
import { TextField } from "../../../_components/text-field";
import { ApiError, loginPath, messageOf, PAUSED_MESSAGE } from "../../../_lib/api";
import {
  appendUnique,
  asReported,
  CHANGED_ELSEWHERE,
  COMMENT_BODY_MAX,
  contentApi,
  contentErrorMessage,
  currentOf,
  GONE_MESSAGE,
  SubmissionKey,
  type CommentItem,
} from "../../../_lib/content-api";
import type { CommunityDetail } from "../../../types";

const MEMBER_STATUSES = new Set(["owner", "moderator", "member"]);

export const commentCountLabel = (count: number) => `${count} ${count === 1 ? "comment" : "comments"}`;

interface CommentsProps {
  postId: string;
  /** Null until the community has loaded; the composer area waits for it. */
  community: CommunityDetail | null;
  signedIn: boolean;
  postHidden: boolean;
  /** Where to send a signed-out reader back to after signing in. */
  returnTo: string;
  count: number;
  onCountChange: (delta: number) => void;
}

interface Settled {
  key: string;
  items: CommentItem[];
  nextCursor: string | null;
  error: string | null;
}

/** The comment thread of a post: oldest first, "Show more", the composer and the per-comment menu. */
export function Comments({ postId, community, signedIn, postHidden, returnTo, count, onCountChange }: CommentsProps) {
  const [attempt, setAttempt] = useState(0);
  const key = `${attempt}:${postId}`;
  const [settled, setSettled] = useState<Settled>({ key: "", items: [], nextCursor: null, error: null });
  const [more, setMore] = useState<{ key: string; loading: boolean; error: string | null }>({ key: "", loading: false, error: null });
  // Set when a new comment was not appended because older ones are still unloaded.
  const [postedLater, setPostedLater] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    contentApi
      .comments(postId, null, controller.signal)
      .then((page) => setSettled({ key, items: page.items, nextCursor: page.nextCursor, error: null }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setSettled({ key, items: [], nextCursor: null, error: messageOf(error) });
      });
    return () => controller.abort();
  }, [key, postId]);

  const current = settled.key === key;
  const items = current ? settled.items : [];
  const cursor = current ? settled.nextCursor : null;
  const loadingMore = more.key === key && more.loading;

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setMore({ key, loading: true, error: null });
    try {
      const page = await contentApi.comments(postId, cursor);
      setSettled((previous) => (previous.key === key ? { ...previous, items: appendUnique(previous.items, page.items), nextCursor: page.nextCursor } : previous));
      setMore({ key, loading: false, error: null });
      setPostedLater(false);
    } catch (error) {
      setMore({ key, loading: false, error: messageOf(error) });
    }
  }, [cursor, key, loadingMore, postId]);

  const change = (updater: (items: CommentItem[]) => CommentItem[]) =>
    setSettled((previous) => (previous.key === key ? { ...previous, items: updater(previous.items) } : previous));

  const isMember = community?.viewerStatus != null && MEMBER_STATUSES.has(community.viewerStatus);
  let compose: React.ReactNode = null;
  if (community) {
    if (community.frozen) compose = <p className="circleFeedNote">{PAUSED_MESSAGE}</p>;
    else if (postHidden) compose = null;
    else if (isMember) {
      compose = (
        <CommentComposer
          onCreated={(created) => {
            // With older comments still unloaded the new one would sit out of order; Show more brings it in.
            if (cursor) setPostedLater(true);
            else change((list) => appendUnique(list, [created]));
            onCountChange(1);
          }}
          postId={postId}
        />
      );
    } else if (!signedIn) {
      compose = (
        <p className="circleFeedNote">
          <Link href={loginPath(returnTo)}>Sign in to join the discussion</Link>
        </p>
      );
    } else {
      compose = <p className="circleFeedNote">Join to comment</p>;
    }
  }

  let list: React.ReactNode;
  if (!current) {
    list = (
      <p aria-busy="true" className="circleFeedNote" role="status">
        Loading comments…
      </p>
    );
  } else if (settled.error) {
    list = (
      <div className="circleFeedError">
        <p className="circleNotice circleNoticeError" role="alert">
          {settled.error}
        </p>
        <button className="circleGhostBtn" onClick={() => setAttempt((value) => value + 1)} type="button">
          Try again
        </button>
      </div>
    );
  } else if (items.length === 0) {
    list = <p className="circleFeedNote">No comments yet</p>;
  } else {
    list = (
      <ul aria-label="Comments" className="circleCommentList">
        {items.map((item) => (
          <CommentRow
            comment={item}
            key={item.id}
            onChanged={(next) => change((all) => all.map((existing) => (existing.id === next.id ? next : existing)))}
            onDeleted={() => {
              change((all) => all.filter((existing) => existing.id !== item.id));
              onCountChange(-1);
            }}
            onGone={() => setGone(true)}
          />
        ))}
      </ul>
    );
  }

  return (
    <section aria-labelledby="comments-title" className="circleSectionCard">
      <div className="circleSectionHeading">
        <div>
          <span className="circleKicker">Discussion</span>
          <h2 id="comments-title" tabIndex={-1}>Comments</h2>
        </div>
        <span className="circleCount">{commentCountLabel(count)}</span>
      </div>
      {compose}
      {gone && (
        <p className="circleFeedNote" role="status">
          {GONE_MESSAGE}
        </p>
      )}
      {postedLater && (
        <p className="circleFeedNote" role="status">
          Comment posted — it will appear after the earlier comments.
        </p>
      )}
      {list}
      {current && cursor && (
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
    </section>
  );
}

function CommentComposer({ postId, onCreated }: { postId: string; onCreated: (comment: CommentItem) => void }) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(new SubmissionKey());
  const ready = body.trim().length > 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || sending) return;
    setSending(true);
    setError(null);
    try {
      const created = await contentApi.createComment(postId, body, key.current.forContent(body));
      key.current.done();
      setBody("");
      onCreated(created);
    } catch (failure) {
      setError(contentErrorMessage(failure));
    } finally {
      setSending(false);
    }
  };

  return (
    <form className="circleComposer" onSubmit={(event) => void submit(event)}>
      <TextField label="Add a comment" max={COMMENT_BODY_MAX} onChange={setBody} rows={3} value={body} />
      {error && (
        <p className="circleNotice circleNoticeError circleFormError" role="alert">
          {error}
        </p>
      )}
      <div className="circleComposerActions">
        <button className="circleCtaBtn" disabled={!ready || sending} type="submit">
          {sending ? "Posting…" : "Comment"}
        </button>
      </div>
    </form>
  );
}

interface RowProps {
  comment: CommentItem;
  onChanged: (comment: CommentItem) => void;
  onDeleted: () => void;
  /** The comment was already gone when the delete ran. */
  onGone: () => void;
}

function CommentRow({ comment, onChanged, onDeleted, onGone }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [moderating, setModerating] = useState<ModerateAction | null>(null);
  const hidden = comment.moderation === "hidden";
  const changed = draft.trim().length > 0 && draft !== comment.body;

  const save = async () => {
    if (!changed || saving) return;
    setSaving(true);
    setError(null);
    try {
      onChanged(await contentApi.updateComment(comment.id, comment.version, draft));
      setNotice(null);
      setEditing(false);
    } catch (failure) {
      const latest = currentOf<CommentItem>(failure);
      if (latest) {
        onChanged(latest);
        setNotice(CHANGED_ELSEWHERE);
        setEditing(false);
      } else {
        setError(contentErrorMessage(failure));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className={`circleComment${hidden ? " circlePostCardHidden" : ""}`}>
      <div className="circlePostHead">
        <Byline author={comment.author} createdAt={comment.createdAt} editedAt={comment.editedAt} hidden={hidden} />
        {!editing && (
          <ContentMenu
            hidden={hidden}
            onDelete={() => setConfirming(true)}
            onEdit={() => {
              setDraft(comment.body);
              setError(null);
              setNotice(null);
              setEditing(true);
            }}
            onModerate={setModerating}
            onReport={() => setReporting(true)}
            viewer={comment.viewer}
          />
        )}
      </div>
      {editing ? (
        <div className="circleComposer">
          <TextField label="Edit comment" max={COMMENT_BODY_MAX} onChange={setDraft} rows={3} value={draft} />
          {error && (
            <p className="circleNotice circleNoticeError circleFormError" role="alert">
              {error}
            </p>
          )}
          <div className="circleComposerActions">
            <button className="circleGhostBtn" disabled={saving} onClick={() => setEditing(false)} type="button">
              Cancel
            </button>
            <button className="circleCtaBtn" disabled={!changed || saving} onClick={() => void save()} type="button">
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : (
        <p className="circleCommentBody">{comment.body}</p>
      )}
      {notice && (
        <p className="circleNotice circleFormError" role="status">
          {notice}
        </p>
      )}
      {reporting && (
        <ReportDialog
          fallbackFocus={() => document.getElementById("comments-title")}
          id={comment.id}
          kind="comment"
          onClose={() => setReporting(false)}
          onReported={() => onChanged(asReported(comment))}
        />
      )}
      {moderating && (
        <ModerationDialog
          action={moderating}
          fallbackFocus={() => document.getElementById("comments-title")}
          id={comment.id}
          kind="comment"
          onClose={() => setModerating(null)}
          onDone={(result) => onChanged({ ...comment, moderation: result.moderation, version: result.changed ? comment.version + 1 : comment.version })}
        />
      )}
      {confirming && (
        <ConfirmDialog
          confirmLabel="Delete comment"
          message="Delete this comment? This can't be undone."
          fallbackFocus={() => document.getElementById("comments-title")}
          onClose={() => setConfirming(false)}
          onConfirm={async () => {
            try {
              await contentApi.deleteComment(comment.id);
            } catch (failure) {
              if (!(failure instanceof ApiError && failure.status === 404)) throw failure;
              onGone();
            }
            onDeleted();
          }}
        />
      )}
    </li>
  );
}
