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
