import Link from "next/link";
import { formatCount, formatLocation } from "./format";
import type { CommunityCard as CommunityCardData, CommunityVisibility } from "./types";

/** Cover tone per topic slug; the first topic picks the card's tone. */
export const topicTone: Record<string, string> = {
  "b2b-saas": "blue",
  "climate-tech": "green",
  "ai-data": "sky",
  product: "violet",
  fintech: "amber",
  founders: "rose",
};

export function toneOf(community: Pick<CommunityCardData, "topics">): string {
  const first = community.topics[0];
  return (first && topicTone[first.slug]) || "violet";
}

export const VISIBILITY_LABELS: Record<CommunityVisibility, string> = { public: "Public", private: "Private", hidden: "Hidden" };

/** How someone gets in, by visibility. */
export const ACCESS_LABELS: Record<CommunityVisibility, string> = { public: "Open", private: "On request", hidden: "Invite only" };

export function initialsOf(name: string): string {
  return name
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}

export function LockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

export function GlobeIcon() {
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

function PauseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M9 6v12M15 6v12" />
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

export function CommunityCard({ community }: { community: CommunityCardData }) {
  const isPublic = community.visibility === "public";

  return (
    <article className={`summaryCard summaryTone-${toneOf(community)}${community.frozen ? " summaryCardFrozen" : ""}`}>
      <div className="summaryCardMedia">
        <span aria-hidden="true" className="summaryCardCover" />
        <span className={`summaryCardBadge${isPublic ? "" : " summaryCardBadgePrivate"}`}>
          {isPublic ? <GlobeIcon /> : <LockIcon />}
          {VISIBILITY_LABELS[community.visibility] ?? "Private"}
        </span>
        {community.frozen ? (
          <span className="summaryCardFeatured summaryCardPaused">
            <PauseIcon />
            Paused
          </span>
        ) : (
          community.featured && (
            <span className="summaryCardFeatured">
              <StarIcon />
              Featured
            </span>
          )
        )}
      </div>
      <div className="summaryCardBody">
        <span aria-hidden="true" className="summaryCardLogo">{initialsOf(community.name)}</span>
        <p className="summaryCardCategory">Hosted by {community.host.name}</p>
        <h3>
          <Link className="summaryCardLink" href={`/communities/${encodeURIComponent(community.slug)}`}>
            {community.name}
          </Link>
        </h3>
        <p className="summaryCardTagline">{community.tagline}</p>
        {community.topics.length > 0 && (
          <ul className="summaryCardTags" aria-label="Topics">
            {community.topics.map((topic) => <li key={topic.slug}>{topic.name}</li>)}
          </ul>
        )}
        <p className="summaryCardMeta">
          <PinIcon />
          <span>{formatLocation(community.location)}</span>
          <StageIcon />
          <span>{community.stage.label}</span>
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
            <dt>Access</dt>
            <dd>{ACCESS_LABELS[community.visibility] ?? "On request"}</dd>
          </div>
        </dl>
      </div>
    </article>
  );
}
