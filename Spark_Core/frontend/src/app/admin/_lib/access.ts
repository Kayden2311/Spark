import type { PlatformRole } from "./types";

export type SectionId = "overview" | "analytics" | "reports" | "communities" | "campaigns" | "users" | "billing" | "audit";

export interface Section {
  id: SectionId;
  label: string;
  href: string;
  group: "Insights" | "Moderation" | "Administration";
  /** Mirrors the API's role checks; the API stays the authority and answers 403 regardless. */
  roles: readonly PlatformRole[];
}

const ADMINS: readonly PlatformRole[] = ["super_admin", "platform_admin"];

export const SECTIONS: readonly Section[] = [
  { id: "overview", label: "Overview", href: "/admin", group: "Insights", roles: ["super_admin", "platform_admin", "community_moderator", "content_moderator", "campaign_moderator"] },
  { id: "analytics", label: "Analytics", href: "/admin/analytics", group: "Insights", roles: ADMINS },
  { id: "reports", label: "Reports", href: "/admin/reports", group: "Moderation", roles: [...ADMINS, "content_moderator"] },
  { id: "communities", label: "Communities", href: "/admin/communities", group: "Moderation", roles: [...ADMINS, "community_moderator"] },
  { id: "campaigns", label: "Campaigns", href: "/admin/campaigns", group: "Moderation", roles: [...ADMINS, "campaign_moderator"] },
  { id: "users", label: "Users", href: "/admin/users", group: "Administration", roles: ADMINS },
  { id: "billing", label: "Billing", href: "/admin/billing", group: "Administration", roles: ADMINS },
  { id: "audit", label: "Audit log", href: "/admin/audit", group: "Administration", roles: ADMINS },
];

export const PLATFORM_ROLES: readonly PlatformRole[] = ["super_admin", "platform_admin", "community_moderator", "content_moderator", "campaign_moderator"];

export function isStaff(roles: readonly string[]): boolean {
  return roles.some((role) => (PLATFORM_ROLES as readonly string[]).includes(role));
}

export function canAccess(roles: readonly string[], section: SectionId): boolean {
  const target = SECTIONS.find((entry) => entry.id === section);
  return Boolean(target && roles.some((role) => (target.roles as readonly string[]).includes(role)));
}

export function visibleSections(roles: readonly string[]): Section[] {
  return SECTIONS.filter((section) => canAccess(roles, section.id));
}

/** Only super admins grant or revoke platform roles. */
export function canManageRoles(roles: readonly string[]): boolean {
  return roles.includes("super_admin");
}

/** The section whose href is the longest prefix of the path, so /admin/users/123 highlights Users. */
export function sectionForPath(pathname: string): Section | undefined {
  return [...SECTIONS].sort((a, b) => b.href.length - a.href.length).find((section) => pathname === section.href || pathname.startsWith(`${section.href}/`));
}
