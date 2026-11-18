"use client";

import Link from "next/link";
import { notFound, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "../../../../auth-context";
import { SignalParticles } from "../../../../signal-particles";
import { Byline } from "../../../_components/byline";
import { ConfirmDialog } from "../../../_components/confirm-dialog";
import { ContentMenu, type ModerateAction } from "../../../_components/content-menu";
import { ModerationDialog } from "../../../_components/moderation-dialog";
import { ReportDialog } from "../../../_components/report-dialog";
import { TextField } from "../../../_components/text-field";
import { SiteFooter, SiteHeader } from "../../../site-chrome";
import { ApiError, loginPath, messageOf } from "../../../_lib/api";
import {
  asReported,
  CHANGED_ELSEWHERE,
  GONE_MESSAGE,
  contentApi,
  contentErrorMessage,
  currentOf,
  POST_BODY_MAX,
  POST_TITLE_MAX,
  type PostDetail,
} from "../../../_lib/content-api";
import { setFlash } from "../../../_lib/flash";
import { useCommunity } from "../../../_lib/use-communities";
import { MEMBERS_ONLY_MESSAGE } from "../../feed";
import { Comments } from "./comments";

interface PostViewProps {
  slug: string;
  postId: string;
  /** The post the server already resolved; without it the page reads it itself. */
  initial?: PostDetail | null;
  /** Open the editor straight away (the feed's Edit item sends people here with ?edit=1). */
  startEditing?: boolean;
}

interface LoadError {
  status: number;
  message: string;
}

export function PostView({ slug, postId, initial = null, startEditing = false }: PostViewProps) {
  const { isAuthenticated } = useAuth();
  const router = useRouter();
  const { community, status: communityStatus } = useCommunity(slug);
  const [post, setPost] = useState<PostDetail | null>(initial);
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState(startEditing);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [moderating, setModerating] = useState<ModerateAction | null>(null);

  useEffect(() => {
    if (initial && attempt === 0) return;
    const controller = new AbortController();
    contentApi
      .post(postId, controller.signal)
      .then((loaded) => setPost(loaded))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError({ status: error instanceof ApiError ? error.status : 0, message: messageOf(error) });
      });
    return () => controller.abort();
  }, [attempt, initial, postId]);

  const base = `/communities/${encodeURIComponent(slug)}`;
  if (loadError?.status === 404 || communityStatus === "not_found") notFound();

  let content: React.ReactNode;
  if (loadError) {
    const denied = loadError.status === 401 || loadError.status === 403;
    content = (
      <section className="circleSectionCard circleStateCard">
        <h1 className="circleMainTitle">{denied ? "Discussion unavailable" : "This post could not load"}</h1>
        {loadError.status === 401 ? (
          <p>
            <Link href={loginPath(`${base}/posts/${encodeURIComponent(postId)}`)}>Sign in to read this discussion</Link>
          </p>
        ) : denied ? (
          <p role="alert">{MEMBERS_ONLY_MESSAGE}</p>
        ) : (
          <>
            <p role="alert">{loadError.message}</p>
            <button
              className="circleCtaBtn"
              onClick={() => {
                setLoadError(null);
                setAttempt((value) => value + 1);
              }}
              type="button"
            >
              Try again
            </button>
          </>
        )}
      </section>
    );
  } else if (!post) {
    content = (
      <section aria-busy="true" className="circleSectionCard circleStateCard">
        <p role="status">Loading post…</p>
      </section>
    );
  } else {
    const hidden = post.moderation === "hidden";
    const showEditor = editing && post.viewer.canEdit;
    content = (
      <>
        <article className={`circleSectionCard circlePostFull${hidden ? " circlePostCardHidden" : ""}`}>
          <div className="circlePostHead">
            <Byline author={post.author} createdAt={post.createdAt} editedAt={post.editedAt} hidden={hidden} />
            {!showEditor && (
              <ContentMenu
                hidden={hidden}
                onDelete={() => setConfirmingDelete(true)}
                onEdit={() => {
                  setNotice(null);
                  setEditing(true);
                }}
                onModerate={setModerating}
                onReport={() => setReporting(true)}
                viewer={post.viewer}
              />
            )}
          </div>
          {showEditor ? (
            <PostEditor
              onCancel={() => setEditing(false)}
              onSaved={(saved) => {
                setPost(saved);
                setEditing(false);
              }}
              onStale={(latest) => {
                if (latest) setPost(latest);
                else setAttempt((value) => value + 1);
                setNotice(CHANGED_ELSEWHERE);
                setEditing(false);
              }}
              post={post}
            />
          ) : (
            <>
              <h1 className="circleMainTitle circlePostPageTitle">{post.title}</h1>
              <div className="circlePostBody">{post.body}</div>
            </>
          )}
          {notice && (
            <p className="circleNotice circleFormError" role="status">
              {notice}
            </p>
          )}
        </article>

        <Comments
          community={community}
          count={post.commentCount}
          onCountChange={(delta) => setPost((current) => (current ? { ...current, commentCount: Math.max(0, current.commentCount + delta) } : current))}
          postHidden={hidden}
          postId={post.id}
          returnTo={`${base}/posts/${encodeURIComponent(post.id)}`}
          signedIn={isAuthenticated}
        />

        {reporting && (
          <ReportDialog
            fallbackFocus={() => document.getElementById("comments-title")}
            id={post.id}
            kind="post"
            onClose={() => setReporting(false)}
            onReported={() => setPost((current) => (current ? asReported(current) : current))}
          />
        )}
        {moderating && (
          <ModerationDialog
            action={moderating}
            fallbackFocus={() => document.getElementById("comments-title")}
            id={post.id}
            kind="post"
            onClose={() => setModerating(null)}
            onDone={(result) => setPost((current) => (current ? { ...current, moderation: result.moderation } : current))}
          />
        )}

        {confirmingDelete && (
          <ConfirmDialog
            confirmLabel="Delete post"
            message="Delete this post? This can't be undone."
            onClose={() => setConfirmingDelete(false)}
            onConfirm={async () => {
              try {
                await contentApi.deletePost(post.id);
                setFlash("Post deleted");
              } catch (failure) {
                if (!(failure instanceof ApiError && failure.status === 404)) throw failure;
                setFlash(GONE_MESSAGE);
              }
              router.push(base);
            }}
          />
        )}
      </>
    );
  }

  return (
    <main className="sparkLanding circleDetailRoot">
      <SignalParticles />
      <SiteHeader />

      <nav className="circleBreadcrumbHeader" aria-label="Breadcrumb">
        <div className="circleBreadcrumbContainer">
          <Link href={base} className="circleBackLink">
            {community ? `Back to ${community.name}` : "Back to community"}
          </Link>
        </div>
      </nav>

      <div className="circlePageContainer circlePostPage">{content}</div>

      <SiteFooter />
    </main>
  );
}

interface EditorProps {
  post: PostDetail;
  onSaved: (post: PostDetail) => void;
  /** The post changed since it was loaded; `latest` is the newer version when the API sent it. */
  onStale: (latest: PostDetail | null) => void;
  onCancel: () => void;
}

function PostEditor({ post, onSaved, onStale, onCancel }: EditorProps) {
  const [title, setTitle] = useState(post.title);
  const [body, setBody] = useState(post.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = title.trim().length > 0 && body.trim().length > 0;
  const changed = title !== post.title || body !== post.body;

  const save = async () => {
    if (!valid || !changed || saving) return;
    setSaving(true);
    setError(null);
    const patch: { title?: string; body?: string } = {};
    if (title !== post.title) patch.title = title;
    if (body !== post.body) patch.body = body;
    try {
      onSaved(await contentApi.updatePost(post.id, post.version, patch));
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 412) {
        onStale(currentOf<PostDetail>(failure));
        return;
      }
      setError(contentErrorMessage(failure));
      setSaving(false);
    }
  };

  return (
    <div className="circleComposer">
      <TextField label="Title" max={POST_TITLE_MAX} onChange={setTitle} value={title} />
      <TextField label="Body" max={POST_BODY_MAX} onChange={setBody} rows={8} value={body} />
      {error && (
        <p className="circleNotice circleNoticeError circleFormError" role="alert">
          {error}
        </p>
      )}
      <div className="circleComposerActions">
        <button className="circleGhostBtn" disabled={saving} onClick={onCancel} type="button">
          Cancel
        </button>
        <button className="circleCtaBtn" disabled={!valid || !changed || saving} onClick={() => void save()} type="button">
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
