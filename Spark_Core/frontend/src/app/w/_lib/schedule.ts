/** Workspace schedule: calendar types, the request path and the week math (all in the viewer's time zone, no date library). */

export interface UserRef {
  id: string;
  displayName: string;
}

export type AttendeeResponse = "pending" | "accepted" | "declined" | "tentative";

export interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
  status: string;
  organizer: UserRef;
  project: { id: string; key: string; name: string } | null;
  issue: { id: string; key: string; title: string } | null;
  attendees: Array<{ user: UserRef; response: string }>;
  myResponse: string | null;
  canEdit: boolean;
  version: number;
}

export interface Deadline {
  kind: "task_due" | "sprint_end" | "milestone_due";
  /** A calendar date (YYYY-MM-DD), not an instant. */
  date: string;
  title: string;
  project: { id: string; key: string; name: string; methodology: string };
  issueId?: string;
  assignee?: UserRef | null;
  sprintId?: string;
  milestoneId?: string;
}

export interface CalendarResponse {
  range: { from: string; to: string; tz: string };
  events: CalendarEvent[];
  deadlines: Deadline[];
  truncated: { events: boolean; deadlines: boolean };
}

export function calendarPath(workspaceId: string, range: { from: string; to: string }, tz: string): string {
  return `/workspaces/${workspaceId}/calendar?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&tz=${encodeURIComponent(tz)}`;
}

/** The browser's IANA zone ("UTC" when it cannot be told). */
export function viewerZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// ---------- Calendar days (YYYY-MM-DD) ----------

const DAY_MS = 86_400_000;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayStamp(day: string): number {
  const match = DAY_PATTERN.exec(day);
  if (!match) return Number.NaN;
  const stamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  // Rejects overflow such as 2026-02-31.
  return new Date(stamp).toISOString().slice(0, 10) === day ? stamp : Number.NaN;
}

function stampDay(stamp: number): string {
  return new Date(stamp).toISOString().slice(0, 10);
}

export function addDays(day: string, count: number): string {
  return stampDay(dayStamp(day) + count * DAY_MS);
}

/** The Monday on or before `day`. */
export function mondayOf(day: string): string {
  const stamp = dayStamp(day);
  return stampDay(stamp - ((new Date(stamp).getUTCDay() + 6) % 7) * DAY_MS);
}

export function weekDays(monday: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

/** A `?week=` value as the Monday it names; null when it is missing or not a real date. */
export function parseWeekParam(value: string | null): string | null {
  if (!value || Number.isNaN(dayStamp(value))) return null;
  return mondayOf(value);
}

// ---------- Zones ----------

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

function zoneFormat(tz: string): Intl.DateTimeFormat {
  let format = zoneFormats.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    zoneFormats.set(tz, format);
  }
  return format;
}

function zoneParts(stamp: number, tz: string): Record<string, number> {
  const parts: Record<string, number> = {};
  for (const part of zoneFormat(tz).formatToParts(new Date(stamp))) if (part.type !== "literal") parts[part.type] = Number(part.value);
  return parts;
}

/** Offset of `tz` from UTC at an instant, in milliseconds. */
function offsetAt(stamp: number, tz: string): number {
  const p = zoneParts(stamp, tz);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(stamp / 1000) * 1000;
}

/** The instant a calendar day starts in `tz`. */
function dayStart(day: string, tz: string): number {
  const wall = dayStamp(day);
  const first = wall - offsetAt(wall, tz);
  return wall - offsetAt(first, tz);
}

/** The calendar day an instant falls on in `tz`. */
export function dayOfInstant(instant: string | number, tz: string): string {
  const p = zoneParts(typeof instant === "number" ? instant : Date.parse(instant), tz);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** [from, to) of the week starting `monday`, as ISO instants: local Monday 00:00 to the next Monday 00:00. */
export function weekBounds(monday: string, tz: string): { from: string; to: string } {
  return { from: new Date(dayStart(monday, tz)).toISOString(), to: new Date(dayStart(addDays(monday, 7), tz)).toISOString() };
}

// ---------- Bucketing ----------

export interface DayBucket {
  day: string;
  deadlines: Deadline[];
  events: CalendarEvent[];
}

const MAX_SPAN_DAYS = 15;

/** Seven buckets for the week: each deadline on its date, each event on every local day it touches, in start order. */
export function bucketWeek({ monday, events, deadlines, tz }: { monday: string; events: CalendarEvent[]; deadlines: Deadline[]; tz: string }): DayBucket[] {
  const buckets = weekDays(monday).map((day): DayBucket => ({ day, deadlines: [], events: [] }));
  const byDay = new Map(buckets.map((bucket) => [bucket.day, bucket]));
  const ordered = [...events].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id));
  for (const item of ordered) {
    const start = Date.parse(item.startsAt);
    const end = Date.parse(item.endsAt);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    // The end is exclusive: an event ending exactly at midnight stays on the earlier day.
    const last = dayOfInstant(Math.max(start, end - 1), tz);
    let day = dayOfInstant(start, tz);
    for (let step = 0; step < MAX_SPAN_DAYS && day <= last; step += 1) {
      byDay.get(day)?.events.push(item);
      day = addDays(day, 1);
    }
  }
  for (const deadline of deadlines) byDay.get(deadline.date)?.deadlines.push(deadline);
  return buckets;
}

// ---------- Text ----------

const monthDay = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
const monthDayYear = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "Oct 26 – Nov 1, 2026". */
export function formatWeekLabel(monday: string): string {
  const start = dayStamp(monday);
  const end = dayStamp(addDays(monday, 6));
  const crossesYear = new Date(start).getUTCFullYear() !== new Date(end).getUTCFullYear();
  return `${(crossesYear ? monthDayYear : monthDay).format(start)} – ${monthDayYear.format(end)}`;
}

const clockFormats = new Map<string, Intl.DateTimeFormat>();

function clock(stamp: number, tz: string): string {
  let format = clockFormats.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    clockFormats.set(tz, format);
  }
  return format.format(stamp);
}

/** The time of an event as shown under `day` in the viewer's zone: a range, or From/Until/All day for a multi-day event. */
export function formatEventTime(item: Pick<CalendarEvent, "startsAt" | "endsAt">, day: string, tz: string): string {
  const start = Date.parse(item.startsAt);
  const end = Date.parse(item.endsAt);
  const startsToday = dayOfInstant(start, tz) === day;
  const endsToday = dayOfInstant(Math.max(start, end - 1), tz) === day;
  if (startsToday && endsToday) return `${clock(start, tz)} – ${clock(end, tz)}`;
  if (startsToday) return `From ${clock(start, tz)}`;
  if (endsToday) return `Until ${clock(end, tz)}`;
  return "All day";
}

export const RESPONSE_LABELS: Record<string, string> = { pending: "Awaiting reply", accepted: "Going", declined: "Declined", tentative: "Maybe" };
