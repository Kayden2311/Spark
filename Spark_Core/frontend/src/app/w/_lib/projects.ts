/** Project representations from the workspace API and small display helpers shared by the project screens. */

import { METHODOLOGY_ACCENTS, type MethodologyId, type StatusCategory } from "./methodologies";

/** One entry of GET /workspaces/{id}/projects. */
export interface Project {
  id: string;
  key: string;
  name: string;
  description: string | null;
  methodology: string;
  lead: { id: string; displayName: string } | null;
  startDate: string | null;
  targetDate: string | null;
  sprintLengthDays: number | null;
  baselinedAt: string | null;
  version: number;
  createdAt: string;
  progress: { total: number; done: number; open: number };
}

export interface ProjectStatus {
  id: string;
  name: string;
  category: StatusCategory | string;
  position: number;
  wipLimit: number | null;
}

export interface ProjectPhase {
  id: string;
  name: string;
  position: number;
  plannedStart: string;
  plannedEnd: string;
  baselineStart: string | null;
  baselineEnd: string | null;
  status: string;
}

export interface ProjectMilestone {
  id: string;
  name: string;
  phaseId: string | null;
  dueDate: string;
  baselineDueDate: string | null;
  completedAt: string | null;
}

/** GET /workspaces/{id}/projects/by-key/{key}, GET and PATCH /projects/{id}. */
export interface ProjectDetail extends Project {
  statuses: ProjectStatus[];
  phases: ProjectPhase[];
  milestones: ProjectMilestone[];
}

const NAMES: Record<MethodologyId, string> = { scrum: "Scrum", kanban: "Kanban", waterfall: "Waterfall" };

/** Projects created before methodologies existed are shown as Kanban, like the API's backfill. */
export function methodologyOf(value: string): MethodologyId {
  return value === "scrum" || value === "waterfall" ? value : "kanban";
}

export function methodologyName(value: string): string {
  return NAMES[methodologyOf(value)];
}

export function methodologyAccent(value: string): string {
  return METHODOLOGY_ACCENTS[methodologyOf(value)];
}

/** The strong entity tag the API expects back in If-Match for a given version. */
export function projectEtag(version: number): string {
  return `"v${version}"`;
}

const DAY_MS = 86_400_000;
const shortDate = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
const longDate = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Milliseconds of an ISO day at UTC midnight, or NaN. */
export function dayValue(day: string): number {
  return /^\d{4}-\d{2}-\d{2}$/u.test(day) ? Date.parse(`${day}T00:00:00Z`) : Number.NaN;
}

/** Whole days from `from` to `to` (both ISO days). */
export function daysBetween(from: string, to: string): number {
  return Math.round((dayValue(to) - dayValue(from)) / DAY_MS);
}

/** "Nov 2, 2026", or the fallback for a missing or malformed day. */
export function formatDay(day: string | null, fallback = "Not set"): string {
  const value = day ? dayValue(day) : Number.NaN;
  return Number.isNaN(value) ? fallback : longDate.format(value);
}

/** "Nov 2" — for ranges inside one timeline. */
export function formatShortDay(day: string): string {
  const value = dayValue(day);
  return Number.isNaN(value) ? day : shortDate.format(value);
}

/** Today's date in the viewer's time zone as an ISO day. */
export function todayIso(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** "2-week sprints" for whole weeks, otherwise "10-day sprints". */
export function sprintLabel(days: number | null): string {
  const length = days ?? 14;
  return length % 7 === 0 ? `${length / 7}-week sprints` : `${length}-day sprints`;
}
