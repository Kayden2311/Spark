import type { CommunityCard } from "./types";

const compactNumber = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const longDate = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" });

let regionNames: Intl.DisplayNames | null = null;
try {
  regionNames = new Intl.DisplayNames(["en"], { type: "region" });
} catch {
  regionNames = null;
}

export function formatCount(value: number): string {
  return compactNumber.format(value);
}

/** "Vietnam" for "VN"; the code itself when the runtime has no name for it. */
export function countryName(code: string): string {
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

export function formatLocation(location: CommunityCard["location"]): string {
  const parts = [location.city, location.countryCode ? countryName(location.countryCode) : null].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "Remote";
}

/** "November 19, 2026" in the viewer's time zone, or null for a value that is not a date. */
export function formatDate(iso: string): string | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : longDate.format(date);
}

/** "just now", "5m ago", "3h ago", "2d ago", then the date; null for a value that is not a date. */
export function formatRelative(iso: string, now = Date.now()): string | null {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return null;
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
  return formatDate(iso);
}
