/** Shapes of the community discovery and membership API (/api/v1). */

export type CommunityVisibility = "public" | "private" | "hidden";

/** The viewer's active community role, "pending" for an open join request, or null. */
export type ViewerStatus = "owner" | "moderator" | "member" | "pending" | null;

export interface CommunityCard {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  visibility: CommunityVisibility;
  location: { countryCode: string | null; city: string | null };
  /** `label` is for people; never show `code`. */
  stage: { code: string; label: string };
  topics: { slug: string; name: string }[];
  memberCount: number;
  /** Posts and comments published in the last 7 days. */
  weeklyPosts: number;
  featured: boolean;
  /** Paused by Spark moderators: visible, but joins and requests are refused. */
  frozen: boolean;
  host: { name: string };
  viewerStatus: ViewerStatus;
}

export interface CommunityDetail extends CommunityCard {
  description: string;
  createdAt: string;
  canManage: boolean;
  version: number;
}

export interface CommunityPage {
  items: CommunityCard[];
  nextCursor: string | null;
}

export interface FilterOption {
  value: string;
  label: string;
  count: number;
}

export interface CommunityFilterOptions {
  topics: FilterOption[];
  stages: FilterOption[];
  countries: FilterOption[];
}

export interface JoinResult {
  status: "member";
  alreadyMember: boolean;
}

export interface JoinRequest {
  id: string;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  message: string | null;
  createdAt: string;
}

export interface MyCommunityRequest {
  id: string;
  community: { slug: string; name: string };
  status: JoinRequest["status"];
  message: string | null;
  createdAt: string;
  reviewedAt: string | null;
}
