// Response shapes of /api/v1/admin (see Spark_Core/backend/src/routes/admin).

export type PlatformRole = "super_admin" | "platform_admin" | "community_moderator" | "content_moderator" | "campaign_moderator";

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Person {
  id: string;
  displayName: string;
}

export interface Overview {
  communities: { active: number; featured: number; frozen: number; archived: number; flagged: number };
  users: { active: number; suspended: number };
  reports: { open: number };
  campaigns: { pending: number; approved: number };
  workspaces: { active: number };
  auditEvents: number;
}

export interface SystemStatus {
  status: "operational";
  nodeVersion: string;
  uptimeSeconds: number;
  activeSessions: number;
  checkedAt: string;
}

export type ReportStatus = "open" | "reviewing" | "resolved" | "dismissed";

export interface Report {
  id: string;
  status: ReportStatus;
  reasonCode: string;
  details: string | null;
  createdAt: string;
  resolvedAt: string | null;
  community: { id: string; name: string; slug: string };
  reporter: Person;
  target: { kind: "post" | "comment"; id: string; title: string | null; body: string; moderationStatus: "visible" | "hidden" };
}

export type CommunityState = "active" | "featured" | "frozen" | "archived";
export type CommunityAction = "feature" | "unfeature" | "freeze" | "unfreeze" | "archive" | "restore";

export interface Community {
  id: string;
  slug: string;
  name: string;
  description: string;
  visibility: string;
  stage: string | null;
  city: string | null;
  countryCode: string | null;
  state: CommunityState;
  createdAt: string;
  featuredAt: string | null;
  frozenAt: string | null;
  archivedAt: string | null;
  creator: Person;
  memberCount: number;
  openReports: number;
}

export type UserStatus = "active" | "suspended";

export interface UserSummary {
  id: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
  platformRoles: PlatformRole[];
  workspaceCount: number;
}

export interface AuditEntry {
  id: string;
  action: AuditAction;
  reason: string;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
  actor: Person;
  target: { type: "report" | "community" | "user" | "campaign"; id: string; label: string };
}

export interface UserDetail extends UserSummary {
  locale: string;
  timezone: string;
  emailVerified: boolean;
  roles: Array<{ role: PlatformRole; grantedAt: string }>;
  activeSessions: number;
  communityCount: number;
  history: Array<Omit<AuditEntry, "target">>;
}

export type ReviewStatus = "draft" | "pending" | "approved" | "rejected";

export interface Campaign {
  id: string;
  name: string;
  headline: string;
  description: string;
  reviewStatus: ReviewStatus;
  deliveryStatus: string;
  requestedStartAt: string;
  startsAt: string | null;
  endsAt: string | null;
  version: number;
  createdAt: string;
  community: { id: string; name: string; slug: string };
  submitter: Person;
  placement: string | null;
}

export type AuditAction =
  | "report.hide" | "report.restore" | "report.dismiss"
  | "community.feature" | "community.unfeature" | "community.freeze" | "community.unfreeze" | "community.archive" | "community.restore"
  | "user.suspend" | "user.reactivate" | "role.grant" | "role.revoke" | "campaign.approve" | "campaign.reject";
