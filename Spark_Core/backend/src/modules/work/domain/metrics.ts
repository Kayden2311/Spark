export type Unit = "points" | "count";
export type PlanStatus = "on_track" | "at_risk" | "behind" | "no_plan";
export type MilestoneState = "hit" | "missed" | "at_risk" | "upcoming";

const DAY_MS = 86_400_000;
const ESTIMATED_SHARE = 0.8;
const AT_RISK_WINDOW_DAYS = 7;

function parseDay(value: string): number {
  return Date.parse(`${value}T00:00:00Z`);
}

function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** Story points when at least 80% of the items are estimated, otherwise counts; no items means counts. */
export function chooseUnit(items: Array<{ points: number | null }>): Unit {
  if (items.length === 0) return "count";
  const estimated = items.filter((item) => item.points !== null).length;
  return estimated >= items.length * ESTIMATED_SHARE ? "points" : "count";
}

export function measure(items: Array<{ points: number | null; done: boolean }>, unit: Unit): { total: number; done: number } {
  let total = 0;
  let done = 0;
  for (const item of items) {
    const value = unit === "points" ? (item.points ?? 0) : 1;
    total += value;
    if (item.done) done += value;
  }
  return { total, done };
}

export function todayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return formatDay(parseDay(day) + n * DAY_MS);
}

/** Whole days from a to b (negative when b is earlier). */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseDay(b) - parseDay(a)) / DAY_MS);
}

/** The `days` UTC calendar days ending today, inclusive. */
export function rangeOf(days: number, today: string): { from: string; to: string } {
  return { from: addDays(today, -(days - 1)), to: today };
}

/** Elapsed share of the plan window as a percentage 0-100; null without a window. */
export function planPercent(window: { start: string; end: string } | null, today: string): number | null {
  if (!window) return null;
  const length = daysBetween(window.start, window.end) + 1;
  if (length <= 0) return null;
  const elapsed = daysBetween(window.start, today) + 1;
  return Math.min(100, Math.max(0, (elapsed / length) * 100));
}

export function planStatus(donePercent: number, plan: number | null): PlanStatus {
  if (plan === null) return "no_plan";
  if (donePercent >= plan - 10) return "on_track";
  if (donePercent >= plan - 25) return "at_risk";
  return "behind";
}

/** Rate is the mean of the daily values given; the date is today + ceil(remaining / rate). */
export function forecast(remaining: number, throughputLast14: number[], today: string): { ratePerDay: number; date: string | null } {
  const sum = throughputLast14.reduce((acc, value) => acc + value, 0);
  const ratePerDay = throughputLast14.length === 0 ? 0 : sum / throughputLast14.length;
  if (remaining <= 0) return { ratePerDay, date: today };
  if (ratePerDay <= 0) return { ratePerDay, date: null };
  return { ratePerDay, date: addDays(today, Math.ceil(remaining / ratePerDay)) };
}

/** Linear ideal burndown from `base` on the first day to 0 on the last, two decimals. */
export function idealLine(base: number, start: string, end: string): Array<{ day: string; ideal: number }> {
  const length = daysBetween(start, end) + 1;
  if (length <= 1) return [{ day: start, ideal: 0 }];
  return Array.from({ length }, (_, index) => ({
    day: addDays(start, index),
    ideal: index === length - 1 ? 0 : round(base * (1 - index / (length - 1)), 2),
  }));
}

export function reliability(base: { total: number; done: number }): number | null {
  if (base.total <= 0) return null;
  return round((base.done / base.total) * 100, 1);
}

export function creepPercent(added: number, base: number): number | null {
  if (base <= 0) return null;
  return round((added / base) * 100, 1);
}

export function milestoneState(m: { dueDate: string; completedAt: string | null }, today: string): MilestoneState {
  if (m.completedAt !== null) return m.completedAt.slice(0, 10) <= m.dueDate ? "hit" : "missed";
  if (m.dueDate < today) return "missed";
  if (daysBetween(today, m.dueDate) <= AT_RISK_WINDOW_DAYS) return "at_risk";
  return "upcoming";
}

/** Planned end minus baseline end in days; null without a baseline. */
export function varianceDays(plannedEnd: string, baselineEnd: string | null): number | null {
  return baselineEnd === null ? null : daysBetween(baselineEnd, plannedEnd);
}

export function roundDays(ms: number): number {
  return round(ms / DAY_MS, 1);
}

/** One SQL aggregate over a scope of non-archived issues: counts arrive as bigint text, points as numeric text. */
export interface ScopeAggregate {
  total_count: string;
  done_count: string;
  estimated_count: string;
  total_points: string;
  done_points: string;
}

export interface Completion {
  unit: Unit;
  total: number;
  done: number;
  donePercent: number;
  planPercent: number | null;
  status: PlanStatus;
}

/** Done toward plan in the scope's unit (points when at least 80% of the issues are estimated). */
export function completion(agg: ScopeAggregate, window: { start: string; end: string } | null, day: string): Completion {
  const count = Number(agg.total_count);
  const estimated = Number(agg.estimated_count);
  // chooseUnit works on items; only the estimated share matters, so a stand-in list keeps the 80% rule in one place.
  const unit = chooseUnit(Array.from({ length: count }, (_, index) => ({ points: index < estimated ? 1 : null })));
  const total = unit === "points" ? Number(agg.total_points) : count;
  const done = unit === "points" ? Number(agg.done_points) : Number(agg.done_count);
  // Both percentages are rounded to the one decimal the UI shows before the status is decided, so the pill never
  // contradicts the numbers next to it at the -10 / -25 edges.
  const donePercent = total > 0 ? round((done / total) * 100, 1) : 0;
  const raw = planPercent(window, day);
  const elapsed = raw === null ? null : round(raw, 1);
  // An empty scope has nothing to be late on.
  const status: PlanStatus = total === 0 && elapsed !== null ? "on_track" : planStatus(donePercent, elapsed);
  return { unit, total, done, donePercent, planPercent: elapsed, status };
}

export interface WindowedProject {
  methodology: string;
  start_date: string | null;
  target_date: string | null;
}

/** Scrum scores the active sprint; Kanban and Waterfall the project window (both dates needed). */
export function planWindow(
  project: WindowedProject,
  sprint: { name: string; starts_on: string | null; ends_on: string | null } | null,
): { window: { start: string; end: string } | null; kind: "sprint" | "project" | null; label: string | null } {
  if (project.methodology === "scrum") {
    return sprint?.starts_on && sprint.ends_on
      ? { window: { start: sprint.starts_on, end: sprint.ends_on }, kind: "sprint", label: sprint.name }
      : { window: null, kind: null, label: null };
  }
  return project.start_date && project.target_date
    ? { window: { start: project.start_date, end: project.target_date }, kind: "project", label: "Project window" }
    : { window: null, kind: null, label: null };
}
