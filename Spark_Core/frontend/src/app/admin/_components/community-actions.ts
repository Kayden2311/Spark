import type { Community, CommunityAction, CommunityState } from "../_lib/types";

// Mirrors the transitions staff_moderate_community accepts; the database is the authority.
export const AVAILABLE: Record<CommunityState, CommunityAction[]> = {
  active: ["feature", "freeze", "archive"],
  featured: ["unfeature", "freeze", "archive"],
  frozen: ["unfreeze", "archive"],
  archived: ["restore"],
};

export const RESULT: Record<CommunityAction, CommunityState> = {
  feature: "featured",
  unfeature: "active",
  freeze: "frozen",
  unfreeze: "active",
  archive: "archived",
  restore: "active",
};

export const COPY: Record<CommunityAction, { label: string; title: string; description: string; tone: "primary" | "danger"; done: string; templates: string[] }> = {
  feature: { label: "Feature", title: "Feature this community?", description: "Marks the community as featured so it can be promoted to members.", tone: "primary", done: "Community featured.", templates: ["Consistently high-quality discussion.", "Fast-growing and well moderated."] },
  unfeature: { label: "Unfeature", title: "Remove from featured?", description: "The community stays live but is no longer highlighted.", tone: "primary", done: "Community removed from featured.", templates: ["Rotating the featured slots.", "Activity has dropped off."] },
  freeze: { label: "Freeze", title: "Freeze this community?", description: "Members can still read it, but nobody can publish new posts or comments until it is unfrozen. Freezing also removes it from featured.", tone: "danger", done: "Community frozen.", templates: ["Spike in spam reports; pausing while owners clean up.", "Ongoing harassment in threads."] },
  unfreeze: { label: "Unfreeze", title: "Unfreeze this community?", description: "Members can publish posts and comments again.", tone: "primary", done: "Community unfrozen.", templates: ["Owners resolved the reported issues."] },
  archive: { label: "Archive", title: "Archive this community?", description: "The community becomes read-only and leaves the directory. You can restore it later.", tone: "danger", done: "Community archived.", templates: ["Inactive for months.", "The owner asked to wind it down."] },
  restore: { label: "Restore", title: "Restore this community?", description: "The community becomes active again. It is not re-featured automatically.", tone: "primary", done: "Community restored.", templates: ["The owner is reviving it.", "Archived by mistake."] },
};

export type Health = { label: string; tone: "red" | "green" | "amber" | "neutral" | "blue" };

/** A plain-language health signal from reports and the last 8 weeks of activity. */
export function healthOf(community: Pick<Community, "openReports" | "weeklyActivity" | "state">): Health {
  if (community.state === "archived") return { label: "Archived", tone: "neutral" };
  if (community.openReports > 0) return { label: "Needs review", tone: "red" };
  const weeks = community.weeklyActivity ?? [];
  const recent = weeks.slice(-4).reduce((sum, value) => sum + value, 0);
  const before = weeks.slice(0, -4).reduce((sum, value) => sum + value, 0);
  if (recent === 0) return { label: "Quiet", tone: "neutral" };
  if (before === 0 || recent >= before * 1.25) return { label: "Growing", tone: "green" };
  if (recent <= before * 0.6) return { label: "Slowing", tone: "amber" };
  return { label: "Steady", tone: "blue" };
}
