export type CommunityCategory = "B2B SaaS" | "Climate Tech" | "AI & Data" | "Product" | "FinTech" | "Founders Circle";

export type CommunityStage = "Idea to Pre-seed" | "Pre-seed to Seed" | "Seed to Series A" | "Growth" | "Any stage";

export type CommunityVisibility = "public" | "private";

/**
 * Card-sized community record returned by the future community listing API
 * (`GET /api/v1/communities`). Mock fixtures must use this shape exactly:
 * structured fields only, never preformatted display strings.
 */
export interface CommunitySummary {
  slug: string;
  name: string;
  /** One sentence, at most 90 characters. */
  tagline: string;
  category: CommunityCategory;
  location: string;
  stage: CommunityStage;
  visibility: CommunityVisibility;
  memberCount: number;
  /** Posts and comments published in the last 7 days. */
  weeklyPosts: number;
  /** ISO 8601 start time of the next scheduled event, or null. */
  nextEventAt: string | null;
  /** Searchable focus areas, at most four. */
  tags: string[];
  featured: boolean;
  /** Cover photo; null renders a generated cover from the name and category. */
  image: {
    url: string;
    alt: string;
  } | null;
}
