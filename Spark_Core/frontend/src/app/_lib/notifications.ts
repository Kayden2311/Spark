/** The notification inbox API (/api/v1/notifications). Notifications belong to the user and span every workspace. */

import { workspaceApi } from "../w/_lib/api";

export interface AppNotification {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  resourceType: string | null;
  resourceId: string | null;
  /** An in-app path such as /w/acme/p/ATLAS?issue=…, or null when there is nowhere to go. */
  link: string | null;
  workspace: { id: string; slug: string; name: string };
  /** ISO text with microseconds. Keep it as the server sent it: `before` must carry it verbatim. */
  createdAt: string;
  readAt: string | null;
}

export interface NotificationPage {
  items: AppNotification[];
  nextCursor: string | null;
}

export const NOTIFICATION_PAGE_SIZE = 30;

export type NotificationFilter = "all" | "unread";

export function listPath(filter: NotificationFilter, cursor: string | null): string {
  const params = new URLSearchParams({ limit: String(NOTIFICATION_PAGE_SIZE) });
  if (filter === "unread") params.set("unread", "true");
  if (cursor) params.set("cursor", cursor);
  return `/notifications?${params.toString()}`;
}

export async function fetchNotifications(filter: NotificationFilter, cursor: string | null, signal?: AbortSignal): Promise<NotificationPage> {
  return (await workspaceApi<NotificationPage>(listPath(filter, cursor), { signal })).data;
}

export async function fetchUnreadCount(signal?: AbortSignal): Promise<number> {
  const { data } = await workspaceApi<{ count: number }>("/notifications/unread-count", { signal });
  return data.count;
}

export async function markNotificationRead(id: string): Promise<void> {
  await workspaceApi<void>(`/notifications/${encodeURIComponent(id)}`, { method: "PATCH", body: { read: true } });
}

export async function markAllNotificationsRead(before: string): Promise<number> {
  const { data } = await workspaceApi<{ updated: number }>("/notifications", { method: "PATCH", body: { read: true, before } });
  return data.updated;
}

/** The newest `createdAt` among the loaded items, compared as text (the server formats every value alike). */
export function newestCreatedAt(items: readonly AppNotification[]): string | null {
  let newest: string | null = null;
  for (const item of items) if (newest === null || item.createdAt > newest) newest = item.createdAt;
  return newest;
}

/** Only in-app paths are followed; anything else just marks the notification read. */
export function internalLink(link: string | null): string | null {
  return link && link.startsWith("/") && !link.startsWith("//") && !link.includes("\\") ? link : null;
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const absolute = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });

export function relativeTime(createdAt: string, now: number): string {
  const at = Date.parse(createdAt);
  if (Number.isNaN(at)) return "";
  const seconds = Math.round((at - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return "just now";
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), "hour");
  if (abs < 7 * 86400) return relative.format(Math.round(seconds / 86400), "day");
  return absolute.format(at);
}
