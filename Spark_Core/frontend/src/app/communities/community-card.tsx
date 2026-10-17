import Image from "next/image";
import Link from "next/link";
import { formatCount, formatEventDate } from "./format";
import type { CommunityCategory, CommunitySummary } from "./types";

export const categoryTone: Record<CommunityCategory, string> = {
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

function LockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </svg>
  );
}

function StageIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 20h4v-6H4zM10 20h4V9h-4zM16 20h4V4h-4z" />
    </svg>
  );
}

export function CommunityCard({ community }: { community: CommunitySummary }) {
  const isPrivate = community.visibility === "private";

  return (
    <article className={`summaryCard summaryTone-${categoryTone[community.category]}`}>
      <div className="summaryCardMedia">
        {community.image ? (
          <Image alt={community.image.alt} fill sizes="(max-width: 720px) 100vw, (max-width: 1100px) 50vw, 33vw" src={community.image.url} />
        ) : (
          <span aria-hidden="true" className="summaryCardCover" />
        )}
        <span className={`summaryCardBadge${isPrivate ? " summaryCardBadgePrivate" : ""}`}>
          {isPrivate ? <LockIcon /> : <GlobeIcon />}
          {isPrivate ? "Private" : "Public"}
        </span>
        {community.featured && (
          <span className="summaryCardFeatured">
            <StarIcon />
            Featured
          </span>
        )}
      </div>
      <div className="summaryCardBody">
        <span aria-hidden="true" className="summaryCardLogo">{initialsOf(community.name)}</span>
        <p className="summaryCardCategory">{community.category}</p>
        <h3>
          <Link className="summaryCardLink" href={`/communities/${community.slug}`}>
            {community.name}
          </Link>
        </h3>
        <p className="summaryCardTagline">{community.tagline}</p>
        {community.tags.length > 0 && (
          <ul className="summaryCardTags" aria-label="Focus areas">
            {community.tags.slice(0, 3).map((tag) => <li key={tag}>{tag}</li>)}
          </ul>
        )}
        <p className="summaryCardMeta">
          <PinIcon />
          <span>{community.location}</span>
          <StageIcon />
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
