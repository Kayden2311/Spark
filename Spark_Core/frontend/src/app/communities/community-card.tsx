import Image from "next/image";
import Link from "next/link";
import { formatCount, formatEventDate } from "./format";
import type { CommunityCategory, CommunitySummary } from "./types";

const categoryTone: Record<CommunityCategory, string> = {
  "B2B SaaS": "blue",
  "Climate Tech": "green",
  "AI & Data": "sky",
  Product: "violet",
  FinTech: "amber",
  "Founders Circle": "rose",
};

export function initialsOf(name: string): string {
  return name
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("");
}

export function CommunityCard({ community }: { community: CommunitySummary }) {
  const isPrivate = community.visibility === "private";

  return (
    <article className="summaryCard">
      <div className={`summaryCardMedia summaryTone-${categoryTone[community.category]}`}>
        {community.image ? (
          <Image alt={community.image.alt} fill sizes="(max-width: 720px) 100vw, (max-width: 1100px) 50vw, 33vw" src={community.image.url} />
        ) : (
          <span aria-hidden="true" className="summaryCardMonogram">{initialsOf(community.name)}</span>
        )}
        <span className={`summaryCardBadge${isPrivate ? " summaryCardBadgePrivate" : ""}`}>
          {isPrivate ? "Private" : "Public"}
        </span>
        {community.featured && <span className="summaryCardFeatured">Featured</span>}
      </div>
      <div className="summaryCardBody">
        <p className="summaryCardCategory">{community.category}</p>
        <h3>
          <Link className="summaryCardLink" href={`/communities/${community.slug}`}>
            {community.name}
          </Link>
        </h3>
        <p className="summaryCardTagline">{community.tagline}</p>
        <p className="summaryCardMeta">
          <span>{community.location}</span>
          <span aria-hidden="true">·</span>
          <span>{community.stage}</span>
        </p>
        <dl className="summaryCardStats">
          <div>
            <dt>Members</dt>
            <dd>{formatCount(community.memberCount)}</dd>
          </div>
          <div>
            <dt>Posts / week</dt>
            <dd>{formatCount(community.weeklyPosts)}</dd>
          </div>
          <div>
            <dt>Next event</dt>
            <dd>
              {community.nextEventAt ? (
                <time dateTime={community.nextEventAt}>{formatEventDate(community.nextEventAt)}</time>
              ) : (
                formatEventDate(null)
              )}
            </dd>
          </div>
        </dl>
      </div>
    </article>
  );
}
