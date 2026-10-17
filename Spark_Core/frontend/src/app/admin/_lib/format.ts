import type { AuditAction, AuditEntry, CommunityState, PlatformRole, ReportStatus, ReviewStatus, UserStatus } from "./types";

export type Tone = "neutral" | "blue" | "green" | "amber" | "red" | "violet" | "navy";

export const ROLE_LABELS: Record<PlatformRole, string> = {
  super_admin: "Super admin",
  platform_admin: "Platform admin",
  community_moderator: "Community moderator",
  content_moderator: "Content moderator",
  campaign_moderator: "Campaign moderator",
};

export const ROLE_DESCRIPTIONS: Record<PlatformRole, string> = {
  super_admin: "Full access, including granting and revoking platform roles.",
  platform_admin: "Manages users, every moderation queue and the audit log.",
  community_moderator: "Features, freezes and archives communities.",
  content_moderator: "Resolves reported posts and comments.",
  campaign_moderator: "Approves or rejects sponsored campaigns.",
};

export const ROLE_TONES: Record<PlatformRole, Tone> = {
  super_admin: "navy",
  platform_admin: "blue",
  community_moderator: "green",
  content_moderator: "amber",
  campaign_moderator: "violet",
};

export const COMMUNITY_STATE: Record<CommunityState, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "green" },
  featured: { label: "Featured", tone: "blue" },
  frozen: { label: "Frozen", tone: "amber" },
  archived: { label: "Archived", tone: "neutral" },
};

export const REPORT_STATUS: Record<ReportStatus, { label: string; tone: Tone }> = {
  open: { label: "Open", tone: "amber" },
  reviewing: { label: "In review", tone: "blue" },
  resolved: { label: "Resolved", tone: "green" },
  dismissed: { label: "Dismissed", tone: "neutral" },
};

export const REVIEW_STATUS: Record<ReviewStatus, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  pending: { label: "Pending review", tone: "amber" },
  approved: { label: "Approved", tone: "green" },
  rejected: { label: "Rejected", tone: "red" },
};

export const USER_STATUS: Record<UserStatus, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "green" },
  suspended: { label: "Suspended", tone: "red" },
};

export const AUDIT_ACTIONS: Record<AuditAction, { label: string; tone: Tone }> = {
  "report.hide": { label: "Hid reported content", tone: "red" },
  "report.restore": { label: "Kept reported content", tone: "green" },
  "report.dismiss": { label: "Dismissed report", tone: "neutral" },
  "community.feature": { label: "Featured community", tone: "blue" },
  "community.unfeature": { label: "Removed from featured", tone: "neutral" },
  "community.freeze": { label: "Froze community", tone: "amber" },
  "community.unfreeze": { label: "Unfroze community", tone: "green" },
  "community.archive": { label: "Archived community", tone: "neutral" },
  "community.restore": { label: "Restored community", tone: "green" },
  "user.suspend": { label: "Suspended user", tone: "red" },
  "user.reactivate": { label: "Reactivated user", tone: "green" },
  "role.grant": { label: "Granted role", tone: "violet" },
  "role.revoke": { label: "Revoked role", tone: "amber" },
  "campaign.approve": { label: "Approved campaign", tone: "green" },
  "campaign.reject": { label: "Rejected campaign", tone: "red" },
};

/** Adds the role name to role changes, e.g. "Granted role: Content moderator". */
export function describeAction(entry: Pick<AuditEntry, "action" | "metadata">): string {
  const base = AUDIT_ACTIONS[entry.action]?.label ?? entry.action;
  const role = entry.metadata.role;
  return typeof role === "string" && role in ROLE_LABELS ? `${base}: ${ROLE_LABELS[role as PlatformRole]}` : base;
}

const dateTime = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const dateOnly = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const relative = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

export function formatDateTime(iso: string | null): string {
  return iso ? dateTime.format(new Date(iso)) : "Never";
}

export function formatDate(iso: string | null): string {
  return iso ? dateOnly.format(new Date(iso)) : "Not set";
}

export function formatRelative(iso: string | null, now = Date.now()): string {
  if (!iso) return "Never";
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60]];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

export function formatDuration(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function initials(name: string): string {
  const letters = name.split(/\s+/u).filter(Boolean).slice(0, 2).map((word) => word[0]!.toUpperCase());
  return letters.join("") || "?";
}

export function humanize(code: string): string {
  const text = code.replace(/[_-]+/gu, " ").trim();
  return text ? text[0]!.toUpperCase() + text.slice(1) : code;
}
