"use client";

import { formatDateTime, formatRelative } from "../_lib/format";
import type { PreviewContent, ReportPreview } from "../_lib/types";
import { ChatIcon } from "./icons";
import { Avatar, Badge, ErrorBanner, SkeletonRows } from "./ui";

function Byline({ content, community }: { content: PreviewContent; community?: string }) {
  const name = content.author?.displayName ?? "Deleted account";
  return (
    <header className="admPostHead">
      <Avatar name={name} size="md" />
      <div className="admPostWho">
        <strong>{name}</strong>
        <span>
          {community && <>in {community} · </>}
          {content.createdAt ? <time dateTime={content.createdAt} title={formatDateTime(content.createdAt)}>{formatRelative(content.createdAt)}</time> : "Unknown time"}
        </span>
      </div>
      <div className="admPostFlags">
        {content.deleted && <Badge tone="neutral">Deleted by author</Badge>}
        {content.moderationStatus === "hidden" && <Badge tone="red">Hidden from members</Badge>}
      </div>
    </header>
  );
}

/**
 * The reported content as members see it in the feed. A reported comment is shown under its parent post,
 * highlighted, so the moderator judges it in context.
 */
export function PostPreview({ preview, community, loading, error, onRetry, fallback }: {
  preview: ReportPreview | null;
  community: string;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** Text from the report itself, shown if the preview cannot be loaded. */
  fallback: { title: string | null; body: string };
}) {
  if (error && !preview) {
    return (
      <>
        <ErrorBanner message={error} onRetry={onRetry} />
        <article className="admContentPreview">{fallback.title && <p><strong>{fallback.title}</strong></p>}<p>{fallback.body}</p></article>
      </>
    );
  }
  if (loading && !preview) return <SkeletonRows rows={3} />;
  if (!preview?.post && !preview?.comment) {
    return <p className="admMuted">The reported content no longer exists.</p>;
  }
  const { post, comment } = preview;
  return (
    <div className="admPostPreview" data-kind={comment ? "comment" : "post"}>
      {post && (
        <article aria-label={comment ? "Post the comment replied to" : "Reported post"} className="admPost">
          {comment && <p className="admPostContext">Replying to this post</p>}
          <Byline community={community} content={post} />
          {post.title && <h3 className="admPostTitle">{post.title}</h3>}
          <p className="admPostBody">{post.body}</p>
          <footer className="admPostFoot">
            <span><ChatIcon /> {post.commentCount ?? 0} {post.commentCount === 1 ? "comment" : "comments"}</span>
          </footer>
        </article>
      )}
      {comment && (
        <article aria-label="Reported comment" className="admPost admPostComment">
          <p className="admPostReported">Reported comment</p>
          <Byline content={comment} />
          <p className="admPostBody">{comment.body}</p>
        </article>
      )}
    </div>
  );
}
