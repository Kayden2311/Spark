import { initialsOf } from "../community-card";
import { formatDate, formatRelative } from "../format";
import type { ContentAuthor } from "../_lib/content-api";

interface BylineProps {
  author: ContentAuthor;
  createdAt: string;
  editedAt: string | null;
  hidden: boolean;
}

/** Initials avatar, author name, relative time, and the Edited and Hidden labels. */
export function Byline({ author, createdAt, editedAt, hidden }: BylineProps) {
  return (
    <div className="circleByline">
      <span aria-hidden="true" className="circleAvatar">
        {initialsOf(author.displayName) || "?"}
      </span>
      <span className="circleBylineText">
        <strong>{author.displayName}</strong>
        <time dateTime={createdAt} title={formatDate(createdAt) ?? undefined}>
          {formatRelative(createdAt) ?? ""}
        </time>
        {editedAt && <span className="circleBylineTag">Edited</span>}
        {hidden && <span className="circleBylineTag circleBylineHidden">Hidden</span>}
      </span>
    </div>
  );
}
