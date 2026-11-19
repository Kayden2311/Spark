"use client";

import Link from "next/link";
import { Byline } from "../_components/byline";
import { ContentMenu, type ModerateAction } from "../_components/content-menu";
import type { PostSummary } from "../_lib/content-api";

interface PostCardProps {
  post: PostSummary;
  slug: string;
  onEdit?: (post: PostSummary) => void;
  onDelete?: (post: PostSummary) => void;
  onReport?: (post: PostSummary) => void;
  onModerate?: (post: PostSummary, action: ModerateAction) => void;
}

export const commentCountLabel = (count: number) => `${count} ${count === 1 ? "comment" : "comments"}`;

/** One post in the feed: byline, title linking to the post page, an excerpt and the comment count. */
export function PostCard({ post, slug, onEdit, onDelete, onReport, onModerate }: PostCardProps) {
  const href = `/communities/${encodeURIComponent(slug)}/posts/${encodeURIComponent(post.id)}`;
  const hidden = post.moderation === "hidden";
  return (
    <article className={`circlePostCard${hidden ? " circlePostCardHidden" : ""}`}>
      <div className="circlePostHead">
        <Byline author={post.author} createdAt={post.createdAt} editedAt={post.editedAt} hidden={hidden} />
        <ContentMenu
          hidden={hidden}
          onDelete={onDelete && (() => onDelete(post))}
          onEdit={onEdit && (() => onEdit(post))}
          onModerate={onModerate && ((action) => onModerate(post, action))}
          onReport={onReport && (() => onReport(post))}
          subject={post.title}
          viewer={post.viewer}
        />
      </div>
      <h3 className="circlePostTitle">
        <Link href={href}>{post.title}</Link>
      </h3>
      <p className="circlePostExcerpt">{post.excerpt}</p>
      <div className="circlePostFoot">
        <span>{commentCountLabel(post.commentCount)}</span>
        {post.truncated && (
          <Link className="circlePostMore" href={href}>
            Read more
          </Link>
        )}
      </div>
    </article>
  );
}
