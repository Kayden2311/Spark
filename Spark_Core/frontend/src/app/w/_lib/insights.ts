/** Insights representations (M5, read-only) and their paths, plus the pure display helpers the insights screens share. */

import type { MethodologyPeriod, Sprint } from "./planning";
import { formatShortDay, methodologyName } from "./projects";

/** Points when at least 80% of the items in scope carry story points, otherwise counts. */
export type InsightUnit = "points" | "count";
export type PlanStatus = "on_track" | "at_risk" | "behind" | "no_plan";
export type MilestoneState = "hit" | "missed" | "at_risk" | "upcoming";

export interface UserRef {
  id: string;
  displayName: string;
}

export interface DayRange {
  from: string;
  to: string;
}

export interface Percentiles {
  p50: number | null;
  p85: number | null;
}

/** GET /projects/{id}/insights/summary. Percentages are 0–100. */
export interface InsightSummary {
  unit: InsightUnit | string;
  total: number;
  done: number;
  open: number;
  donePercent: number;
  plan: {
    kind: "sprint" | "project" | null;
    label: string | null;
    start: string | null;
    end: string | null;
    planPercent: number | null;
    status: PlanStatus | string;
  };
  forecast: { ratePerDay: number; date: string | null };
  overdue: { count: number; items: OverdueItem[] };
  periods: MethodologyPeriod[];
}

export interface OverdueItem {
  issueId: string;
  key: string;
  title: string;
  dueDate: string;
  assignee: UserRef | null;
}

export interface MemberStat {
  user: UserRef | null;
  completed: number;
  completedPoints: number;
  onTimeRate: number | null;
  open: number;
  overdue: number;
  medianCycleDays: number | null;
}

/** GET /projects/{id}/insights/members?days= */
export interface MemberInsights {
  range: DayRange;
  items: MemberStat[];
}

export interface FlowDay {
  day: string;
  backlog: number;
  todo: number;
  inProgress: number;
  done: number;
  completed: number;
  completedPoints: number;
}

/** A methodology switch inside the range. */
export interface FlowMarker {
  at: string;
  from: string;
  to: string;
}

/** GET /projects/{id}/insights/flow?days= */
export interface FlowInsights {
  range: DayRange;
  days: FlowDay[];
  markers: FlowMarker[];
}

export interface CyclePoint {
  issueId: string;
  key: string;
  title: string;
  completedAt: string;
  cycleDays: number | null;
  leadDays: number;
}

/** GET /projects/{id}/insights/cycle-time?days= */
export interface CycleTimeInsights {
  range: DayRange;
  points: CyclePoint[];
  cycle: Percentiles;
  lead: Percentiles;
  truncated: boolean;
}

export interface AgingItem {
  issueId: string;
  key: string;
  title: string;
  statusName: string;
  assignee: UserRef | null;
  startedAt: string | null;
  ageDays: number;
}

export interface ColumnLoad {
  statusId: string;
  name: string;
  category: string;
  wipLimit: number | null;
  count: number;
}

/** GET /projects/{id}/insights/aging-wip. `cycle` holds the last 90 days' cycle-time percentiles. */
export interface AgingInsights {
  items: AgingItem[];
  columns: ColumnLoad[];
  cycle: Percentiles;
}

export interface SprintOutcome {
  id: string;
  name: string;
  completedAt: string;
  committedPoints: number | null;
  completedPoints: number | null;
  committedCount: number | null;
  completedCount: number | null;
  reliability: number | null;
  alreadyDone: number;
  added: { count: number; points: number };
  removed: number;
  creepPercent: number | null;
}

/** GET /projects/{id}/insights/velocity?period= */
export interface VelocityInsights {
  period: MethodologyPeriod;
  unit: InsightUnit | string;
  sprints: SprintOutcome[];
  /** Mean completed per sprint in `unit` (completed points, or completed counts); null without sprints. */
  averageVelocity: number | null;
}

export interface BurndownDay {
  day: string;
  ideal: number;
  scope: number | null;
  remaining: number | null;
}

/** GET /sprints/{id}/burndown (409 sprint_missing_dates without both dates). */
export interface Burndown {
  sprint: Sprint;
  unit: InsightUnit | string;
  /** Committed work not done at the sprint's start (a planned sprint: its issues not done now), in `unit`. */
  base: number;
  days: BurndownDay[];
}

export interface PhaseSchedule {
  id: string;
  name: string;
  plannedStart: string;
  plannedEnd: string;
  baselineStart: string | null;
  baselineEnd: string | null;
  varianceDays: number | null;
  unit: InsightUnit | string;
  total: number;
  done: number;
  donePercent: number;
  planPercent: number | null;
  status: PlanStatus | string;
}

export interface MilestoneSchedule {
  id: string;
  name: string;
  phaseId: string | null;
  dueDate: string;
  baselineDueDate: string | null;
  completedAt: string | null;
  state: MilestoneState | string;
}

/** GET /projects/{id}/insights/schedule?period= */
export interface ScheduleInsights {
  period: MethodologyPeriod;
  phases: PhaseSchedule[];
  milestones: MilestoneSchedule[];
  counts: { hit: number; missed: number; atRisk: number; upcoming: number };
  scheduleVarianceDays: number | null;
}

/** GET /workspaces/{id}/insights?days= */
export interface WorkspaceInsights {
  range: DayRange;
  projects: Array<{
    id: string;
    key: string;
    name: string;
    methodology: string;
    unit: InsightUnit | string;
    donePercent: number;
    planPercent: number | null;
    status: PlanStatus | string;
    open: number;
    overdue: number;
  }>;
  members: MemberStat[];
  calendar: Array<{ day: string; value: number }>;
  overdue: Array<OverdueItem & { projectKey: string }>;
}

// ---------- Paths ----------

export const RANGE_OPTIONS = [7, 30, 90, 180] as const;
export const DEFAULT_RANGE = 30;

/** A `?days=` value the API accepts, or the default. */
export function parseRange(value: string | null): number {
  const days = Number(value);
  return (RANGE_OPTIONS as readonly number[]).includes(days) ? days : DEFAULT_RANGE;
}

const projectInsights = (projectId: string, name: string) => `/projects/${encodeURIComponent(projectId)}/insights/${name}`;

export const insightPaths = {
  summary: (projectId: string) => projectInsights(projectId, "summary"),
  members: (projectId: string, days: number) => `${projectInsights(projectId, "members")}?days=${days}`,
  flow: (projectId: string, days: number) => `${projectInsights(projectId, "flow")}?days=${days}`,
  cycleTime: (projectId: string, days: number) => `${projectInsights(projectId, "cycle-time")}?days=${days}`,
  agingWip: (projectId: string) => projectInsights(projectId, "aging-wip"),
  velocity: (projectId: string, periodId: string | null) => `${projectInsights(projectId, "velocity")}${periodId ? `?period=${encodeURIComponent(periodId)}` : ""}`,
  schedule: (projectId: string, periodId: string | null) => `${projectInsights(projectId, "schedule")}${periodId ? `?period=${encodeURIComponent(periodId)}` : ""}`,
  burndown: (sprintId: string) => `/sprints/${encodeURIComponent(sprintId)}/burndown`,
  workspace: (workspaceId: string, days: number) => `/workspaces/${encodeURIComponent(workspaceId)}/insights?days=${days}`,
};

// ---------- Display helpers ----------

const STATUS_LABELS: Record<PlanStatus, string> = { on_track: "On track", at_risk: "At risk", behind: "Behind", no_plan: "No plan" };

export function planStatusLabel(status: string): string {
  return STATUS_LABELS[status as PlanStatus] ?? "No plan";
}

const MILESTONE_LABELS: Record<MilestoneState, string> = { hit: "Hit", missed: "Missed", at_risk: "At risk", upcoming: "Upcoming" };

export function milestoneStateLabel(state: string): string {
  return MILESTONE_LABELS[state as MilestoneState] ?? "Upcoming";
}

/** "points" or "tasks", for a measured amount. */
export function unitLabel(unit: string): string {
  return unit === "points" ? "points" : "tasks";
}

/** "40%" or "12.5%" for a 0–100 percentage; "—" for none. */
export function percentText(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${Number(value.toFixed(1))}%`;
}

/** "2.5 d", or "—" for none. */
export function daysText(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : `${Number(value.toFixed(1))} d`;
}

/** "Switched Kanban → Scrum on Oct 3". */
export function markerLabel(marker: FlowMarker): string {
  return `Switched ${methodologyName(marker.from)} → ${methodologyName(marker.to)} on ${formatShortDay(marker.at.slice(0, 10))}`;
}

/** The period the screen shows: the requested one when it exists, else the open period (else the latest). */
export function selectedPeriod(periods: readonly MethodologyPeriod[], requested: string | null): MethodologyPeriod | null {
  const found = requested ? periods.find((period) => period.id === requested) : undefined;
  return found ?? periods.find((period) => period.endedAt === null) ?? periods[periods.length - 1] ?? null;
}

/** Sprints that have a burndown worth showing: the active one, then completed ones, newest first. */
export function burndownSprints(sprints: readonly Sprint[]): Sprint[] {
  const active = sprints.filter((sprint) => sprint.status === "active");
  const completed = sprints
    .filter((sprint) => sprint.status === "completed")
    .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
  return [...active, ...completed];
}

/** Where an item's age sits against the cycle-time percentiles. */
export type AgeBand = "under" | "between" | "over" | "none";

export function ageBand(ageDays: number, cycle: Percentiles): AgeBand {
  if (cycle.p50 === null) return "none";
  if (ageDays <= cycle.p50) return "under";
  if (cycle.p85 === null || ageDays <= cycle.p85) return "between";
  return "over";
}

const AGE_BAND_LABELS: Record<AgeBand, string> = { under: "Under p50", between: "p50–p85", over: "Over p85", none: "No reference yet" };

export function ageBandLabel(band: AgeBand): string {
  return AGE_BAND_LABELS[band];
}
