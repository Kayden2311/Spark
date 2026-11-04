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

// ---------- Event forms ----------

/** The strong entity tag the API expects in If-Match for an event. */
export function eventEtag(version: number): string {
  return `"v${version}"`;
}

export function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz.trim() !== "";
  } catch {
    return false;
  }
}

const TIME_PATTERN = /^(\d{2}):(\d{2})$/;

/**
 * The instant a wall-clock date ("YYYY-MM-DD") and time ("HH:mm") name in an IANA zone, as an ISO string.
 * Null for input that is not a real date/time, an unknown zone, or a time the zone skips (spring-forward gap).
 * A time that happens twice (fall-back) resolves to one of its two occurrences.
 */
export function wallClockInstant(day: string, time: string, tz: string): string | null {
  const stamp = dayStamp(day);
  const clockMatch = TIME_PATTERN.exec(time);
  if (Number.isNaN(stamp) || !clockMatch || !isValidZone(tz)) return null;
  const hours = Number(clockMatch[1]);
  const minutes = Number(clockMatch[2]);
  if (hours > 23 || minutes > 59) return null;
  const wall = stamp + (hours * 60 + minutes) * 60_000;
  // Two passes settle the offset when the wall time lies near a transition.
  let instant = wall - offsetAt(wall, tz);
  instant = wall - offsetAt(instant, tz);
  const back = wallClockOf(instant, tz);
  if (back.date !== day || back.time !== time) return null;
  return new Date(instant).toISOString();
}

/** The date and time ("HH:mm") an instant shows on the wall in `tz`. */
export function wallClockOf(instant: string | number, tz: string): { date: string; time: string } {
  const stamp = typeof instant === "number" ? instant : Date.parse(instant);
  const p = zoneParts(stamp, tz);
  const pad = (value: number) => String(value).padStart(2, "0");
  return { date: dayOfInstant(stamp, tz), time: `${pad(p.hour)}:${pad(p.minute)}` };
}

/** How many of the viewer's live (non-cancelled) events overlap [start, end), ignoring `exceptId`. */
export function overlapCount(events: CalendarEvent[], userId: string | null, start: number, end: number, exceptId: string | null): number {
  if (userId === null || Number.isNaN(start) || Number.isNaN(end)) return 0;
  return events.filter((item) => {
    if (item.id === exceptId || item.status === "cancelled") return false;
    if (item.organizer.id !== userId && !item.attendees.some((attendee) => attendee.user.id === userId)) return false;
    return Date.parse(item.startsAt) < end && Date.parse(item.endsAt) > start;
  }).length;
}

const FALLBACK_ZONES = ["UTC", "Europe/London", "Europe/Berlin", "Europe/Paris", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Asia/Ho_Chi_Minh", "Asia/Singapore", "Asia/Tokyo", "Asia/Kolkata", "Australia/Sydney"];

/** IANA zones for the picker, with the given zones (the viewer's, the event's) first. */
export function zoneChoices(...extra: string[]): string[] {
  let all = FALLBACK_ZONES;
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone");
    if (supported && supported.length > 0) all = supported;
  } catch {
    // Older engines: keep the short list.
  }
  return [...new Set([...extra.filter(isValidZone), "UTC", ...all])];
}

/** Everything the event form edits, as the form holds it. */
export interface EventFormValues {
  title: string;
  description: string;
  location: string;
  date: string;
  startTime: string;
  endDate: string;
  endTime: string;
  timezone: string;
  projectId: string;
  issueId: string;
  attendeeIds: string[];
}

/** The form values an existing event starts from, in its own zone; attendees limited to `activeIds`, the organizer left out. */
export function formValuesOf(item: CalendarEvent, activeIds: ReadonlySet<string>): EventFormValues {
  const start = wallClockOf(item.startsAt, item.timezone);
  const end = wallClockOf(item.endsAt, item.timezone);
  return {
    title: item.title,
    description: item.description ?? "",
    location: item.location ?? "",
    date: start.date,
    startTime: start.time,
    endDate: end.date,
    endTime: end.time,
    timezone: item.timezone,
    projectId: item.project?.id ?? "",
    issueId: item.issue?.id ?? "",
    attendeeIds: item.attendees.map((attendee) => attendee.user.id).filter((id) => id !== item.organizer.id && activeIds.has(id)),
  };
}

/** The most people one event can invite (the organizer attends on top). */
export const MAX_ATTENDEES = 50;

export type EventField = "title" | "description" | "location" | "time" | "timezone" | "project" | "issue" | "attendees";

/** Client-side checks; the instants are null when they cannot be built. */
export function validateEventForm(values: EventFormValues): { errors: Partial<Record<EventField, string>>; startsAt: string | null; endsAt: string | null } {
  const errors: Partial<Record<EventField, string>> = {};
  if (values.title.trim() === "") errors.title = "Enter a title.";
  else if (values.title.trim().length > 200) errors.title = "Use 200 characters or fewer.";
  if (values.location.trim().length > 200) errors.location = "Use 200 characters or fewer.";
  if (values.description.length > 2000) errors.description = "Use 2000 characters or fewer.";
  if (values.attendeeIds.length > MAX_ATTENDEES) errors.attendees = `Invite at most ${MAX_ATTENDEES} people.`;
  let startsAt: string | null = null;
  let endsAt: string | null = null;
  if (!isValidZone(values.timezone)) {
    errors.timezone = "Choose a time zone from the list.";
  } else {
    startsAt = wallClockInstant(values.date, values.startTime, values.timezone);
    endsAt = wallClockInstant(values.endDate, values.endTime, values.timezone);
    if (startsAt === null || endsAt === null) errors.time = "Enter a valid date and time. Times skipped by a clock change do not exist.";
    else if (Date.parse(endsAt) <= Date.parse(startsAt)) errors.time = "The event must end after it starts.";
  }
  return { errors, startsAt, endsAt };
}

export interface EventCreateBody {
  title: string;
  description?: string;
  location?: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  projectId?: string;
  issueId?: string;
  attendeeUserIds: string[];
}

export function createEventBody(values: EventFormValues, startsAt: string, endsAt: string): EventCreateBody {
  const body: EventCreateBody = { title: values.title.trim(), startsAt, endsAt, timezone: values.timezone, attendeeUserIds: values.attendeeIds };
  if (values.description.trim() !== "") body.description = values.description;
  if (values.location.trim() !== "") body.location = values.location.trim();
  if (values.projectId !== "") {
    body.projectId = values.projectId;
    if (values.issueId !== "") body.issueId = values.issueId;
  }
  return body;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));

/**
 * The PATCH body for what changed between the form's starting values and now (empty when nothing did).
 * `attendeesKnown` false (the member list did not load) leaves the attendees out.
 */
export function eventPatchBody(initial: EventFormValues, values: EventFormValues, startsAt: string, endsAt: string, attendeesKnown: boolean): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (values.title.trim() !== initial.title.trim()) patch.title = values.title.trim();
  if (values.description !== initial.description) patch.description = values.description.trim() === "" ? null : values.description;
  if (values.location.trim() !== initial.location.trim()) patch.location = values.location.trim() === "" ? null : values.location.trim();
  const timeChanged = values.date !== initial.date || values.startTime !== initial.startTime || values.endDate !== initial.endDate || values.endTime !== initial.endTime || values.timezone !== initial.timezone;
  if (timeChanged) {
    patch.startsAt = startsAt;
    patch.endsAt = endsAt;
  }
  if (values.timezone !== initial.timezone) patch.timezone = values.timezone;
  if (values.projectId !== initial.projectId) {
    patch.projectId = values.projectId === "" ? null : values.projectId;
    // Clearing the project must clear the task in the same patch.
    patch.issueId = values.projectId === "" || values.issueId === "" ? null : values.issueId;
  } else if (values.issueId !== initial.issueId) {
    patch.issueId = values.issueId === "" ? null : values.issueId;
  }
  if (attendeesKnown && !sameSet(initial.attendeeIds, values.attendeeIds)) patch.attendeeUserIds = values.attendeeIds;
  return patch;
}

// ---------- Event text ----------

const dayFormats = new Map<string, Intl.DateTimeFormat>();

function dayFormat(tz: string): Intl.DateTimeFormat {
  let format = dayFormats.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat("en", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });
    dayFormats.set(tz, format);
  }
  return format;
}

/** "Wed, Oct 28, 12:00 – 13:00" in `tz`; both ends with their dates when the event crosses midnight. */
export function formatEventRange(item: Pick<CalendarEvent, "startsAt" | "endsAt">, tz: string): string {
  const start = Date.parse(item.startsAt);
  const end = Date.parse(item.endsAt);
  const first = dayOfInstant(start, tz);
  const last = dayOfInstant(Math.max(start, end - 1), tz);
  if (first === last) return `${dayFormat(tz).format(start)}, ${clock(start, tz)} – ${clock(end, tz)}`;
  return `${dayFormat(tz).format(start)}, ${clock(start, tz)} – ${dayFormat(tz).format(end)}, ${clock(end, tz)}`;
}
