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
  newMembers30d: number;
  posts30d: number;
  comments30d: number;
  /** Posts plus comments for the last 8 weeks, oldest first. */
  weeklyActivity: number[];
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
  risk?: { hiddenPosts: number; hiddenComments: number; reportsAgainst: number };
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

// ---------- Insights (0012_admin_insights) ----------

export interface ActivityPoint {
  day: string;
  signups: number;
  activeUsers: number;
  signIns: number;
  posts: number;
  comments: number;
  reportsOpened: number;
  reportsClosed: number;
}

export interface PeriodTotals {
  signups: number;
  signIns: number;
  posts: number;
  comments: number;
  reportsOpened: number;
  reportsClosed: number;
  avgActiveUsers: number;
}

export interface ActivityResponse {
  days: number;
  series: ActivityPoint[];
  current: PeriodTotals;
  previous: PeriodTotals | null;
  audience: { dau: number; wau: number; mau: number; totalUsers: number };
}

export interface EngagementResponse {
  days: number;
  cells: Array<{ dow: number; hour: number; events: number }>;
}

export interface RetentionResponse {
  weeks: number;
  cohorts: Array<{ week: string; size: number; retained: number[] }>;
}

export interface TopCommunity {
  id: string;
  name: string;
  slug: string;
  posts: number;
  comments: number;
  newMembers: number;
  contributors: number;
}

export interface CommunityDetail {
  community: Community;
  series: Array<{ day: string; newMembers: number; posts: number; comments: number; reportsOpened: number }>;
  history: Array<{ id: string; action: AuditAction; reason: string; createdAt: string; actor: Person }>;
}

export interface UserActivityResponse {
  days: number;
  series: Array<{ day: string; signIns: number; posts: number; comments: number }>;
}

export interface UserSession {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  method: string;
  state: "active" | "expired" | "revoked";
}

export interface ReportContext {
  author: { id: string; displayName: string; status: string; joinedAt: string; reportsAgainst: number; hiddenContent: number } | null;
  communityOpenReports: number;
  reporterReportsFiled: number;
}

export interface ReportStats {
  days: number;
  opened: number;
  closed: number;
  backlog: number;
  medianHoursToClose: number | null;
}

export type SubscriptionStatus = "incomplete" | "trialing" | "active" | "past_due" | "paused" | "cancelled" | "expired";
export type InvoiceStatus = "draft" | "open" | "paid" | "void" | "uncollectible";

export interface BillingOverview {
  counts: { freeWorkspaces: number; trialing: number; paying: number; pastDue: number; cancelled30d: number; newPaid30d: number; failedPayments30d: number };
  revenue: Array<{ currency: string; mrrMinor: number; arrMinor: number; collected30dMinor: number; openMinor: number; uncollectibleMinor: number }>;
  planMix: Array<{ code: string; name: string; billingKind: string; subscriptions: number; currency: string | null; mrrMinor: number }>;
}

export interface MrrResponse {
  months: number;
  series: Array<{ month: string; currency: string; mrrMinor: number; newPaid: number; churned: number }>;
}

export interface Subscription {
  id: string;
  createdAt: string;
  workspace: { id: string; name: string; slug: string };
  plan: { code: string; name: string; billingKind: string };
  status: SubscriptionStatus;
  interval: string | null;
  amountMinor: number | null;
  currency: string | null;
  mrrMinor: number;
  periodEnd: string | null;
  trialEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  cancelledAt: string | null;
  provider: string | null;
}

export interface Invoice {
  id: string;
  issuedAt: string;
  workspace: { id: string; name: string };
  planName: string;
  status: InvoiceStatus;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  dueAt: string | null;
  paidAt: string | null;
}
