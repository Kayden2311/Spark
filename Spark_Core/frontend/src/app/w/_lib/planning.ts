/** Planning representations (M4: sprints, the Waterfall plan) and their API calls, plus the pure helpers the planning screens share. */

import { canManage, workspaceApi } from "./api";
import { issueEtag, type BoardState, type IssueCard, type IssueDetail } from "./issues";
import type { MethodologyId, StatusCategory } from "./methodologies";
import { dayValue, daysBetween, formatShortDay, methodologyName, projectEtag, type ProjectDetail, type ProjectMilestone, type ProjectPhase } from "./projects";

/** Shown wherever a plan is visible but the viewer may not change it (the API's 403 says the same). */
export const PLAN_AUTHORITY_MESSAGE = "Only owners, admins and the project lead can change the plan.";

/** Workspace owners and admins, and the project's current lead, manage sprints, phases, columns and methodology. */
export function canPlan(workspaceRole: string, project: { lead: { id: string } | null }, userId: string | null | undefined): boolean {
  return canManage(workspaceRole) || (Boolean(userId) && project.lead?.id === userId);
}

// ---------- Sprints ----------

export type SprintStatus = "planned" | "active" | "completed" | "cancelled";

/** GET /projects/{id}/sprints items, and the body of every sprint write. Days are YYYY-MM-DD (UTC calendar days). */
export interface Sprint {
  id: string;
  name: string;
  goal: string | null;
  status: SprintStatus | string;
  startsOn: string | null;
  endsOn: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Frozen when the sprint starts. */
  committedPoints: number | null;
  committedCount: number | null;
  /** Frozen when the sprint completes. */
  completedPoints: number | null;
  completedCount: number | null;
  version: number;
}

export interface SprintFields {
  name: string;
  goal: string | null;
  startsOn: string | null;
  endsOn: string | null;
}

export interface CompletedSprint {
  sprint: Sprint;
  /** Unfinished issues carried to the chosen sprint or the backlog. */
  movedIssues: number;
}

/** The API's sprint limits (the database enforces them; the dialogs check first). */
export const SPRINT_NAME_MAX = 80;
export const SPRINT_GOAL_MAX = 500;
export const SPRINT_MAX_DAYS = 28;
export const DEFAULT_SPRINT_DAYS = 14;

export function sprintEtag(version: number): string {
  return `"v${version}"`;
}

export function sprintsPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/sprints`;
}

const sprintPath = (sprintId: string) => `/sprints/${encodeURIComponent(sprintId)}`;

export async function createSprint(projectId: string, fields: SprintFields): Promise<Sprint> {
  const { data } = await workspaceApi<Sprint>(sprintsPath(projectId), { method: "POST", body: fields });
  return data;
}

export async function updateSprint(sprint: Pick<Sprint, "id" | "version">, patch: Partial<SprintFields>): Promise<Sprint> {
  const { data } = await workspaceApi<Sprint>(sprintPath(sprint.id), { method: "PATCH", body: patch, ifMatch: sprintEtag(sprint.version) });
  return data;
}

export async function startSprint(sprint: Pick<Sprint, "id" | "version">): Promise<Sprint> {
  const { data } = await workspaceApi<Sprint>(`${sprintPath(sprint.id)}/start`, { method: "POST", ifMatch: sprintEtag(sprint.version) });
  return data;
}

/** `carryToSprintId` null sends unfinished work to the backlog. */
export async function completeSprint(sprint: Pick<Sprint, "id" | "version">, carryToSprintId: string | null): Promise<CompletedSprint> {
  const { data } = await workspaceApi<CompletedSprint>(`${sprintPath(sprint.id)}/complete`, { method: "POST", body: { carryToSprintId }, ifMatch: sprintEtag(sprint.version) });
  return data;
}

/** Puts an issue in a sprint (or the backlog, null). Any active member may; the planning screens limit it to planners. */
export async function assignIssueToSprint(issue: Pick<IssueCard, "id" | "version">, sprintId: string | null): Promise<IssueDetail> {
  const { data } = await workspaceApi<IssueDetail>(`/issues/${encodeURIComponent(issue.id)}`, { method: "PATCH", body: { sprintId }, ifMatch: issueEtag(issue.version) });
  return data;
}

// ---------- Days and points ----------

const DAY_MS = 86_400_000;

/** The ISO day `days` after `day` (calendar arithmetic in UTC, so no daylight-saving drift). */
export function addDays(day: string, days: number): string {
  const value = dayValue(day);
  return Number.isNaN(value) ? day : new Date(value + days * DAY_MS).toISOString().slice(0, 10);
}

const pointsFormat = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

/** "21", "2.5". */
export function formatPoints(points: number): string {
  return pointsFormat.format(points);
}

/** "1 pt", "21 pts", "2.5 pts". */
export function pointsLabel(points: number): string {
  return `${formatPoints(points)} ${points === 1 ? "pt" : "pts"}`;
}

export function taskCountLabel(count: number): string {
  return `${count} ${count === 1 ? "task" : "tasks"}`;
}

export function sumPoints(issues: readonly Pick<IssueCard, "storyPoints">[]): number {
  return issues.reduce((total, issue) => total + (issue.storyPoints ?? 0), 0);
}

// ---------- Velocity ----------

export interface Velocity {
  /** Average completed points per sprint. */
  points: number;
  /** How many completed sprints the average covers (1–3). */
  sprints: number;
}

/** Average completed points of the last three completed sprints; null before any sprint is completed. */
export function velocityOf(sprints: readonly Sprint[], window = 3): Velocity | null {
  const done = sprints
    .filter((sprint) => sprint.status === "completed")
    .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
    .slice(0, window);
  if (done.length === 0) return null;
  const total = done.reduce((sum, sprint) => sum + (sprint.completedPoints ?? 0), 0);
  return { points: total / done.length, sprints: done.length };
}

/** "Velocity 21 pts (last 3)" or "No velocity yet". Whole points: velocity is a rough guide. */
export function velocityLabel(velocity: Velocity | null): string {
  return velocity ? `Velocity ${pointsLabel(Math.round(velocity.points))} (last ${velocity.sprints})` : "No velocity yet";
}

/** Planned points as a share of velocity in percent, unrounded (114.3 for 114.3%), or null without a positive velocity. */
export function capacityPercent(plannedPoints: number, velocity: Velocity | null): number | null {
  if (!velocity || velocity.points <= 0) return null;
  return (plannedPoints / velocity.points) * 100;
}

/** Planning more than 110% of velocity is flagged. */
export const OVER_CAPACITY_PERCENT = 110;

// ---------- Lanes ----------

/** The Backlog lane's key; sprint lanes use their sprint id. */
export const BACKLOG_LANE = "backlog";

export interface PlanLane {
  key: string;
  /** The sprint the lane plans, or null for the Backlog. */
  sprint: Sprint | null;
  name: string;
  issues: IssueCard[];
}

/** The sprints work can be planned into: the active one first, then planned ones in the API's order. */
export function openSprints(sprints: readonly Sprint[]): Sprint[] {
  return [...sprints.filter((sprint) => sprint.status === "active"), ...sprints.filter((sprint) => sprint.status === "planned")];
}

/** The lane an issue shows in: its sprint while that sprint is open, otherwise the Backlog. */
export function laneKeyOf(issue: Pick<IssueCard, "sprintId">, openIds: ReadonlySet<string>): string {
  return issue.sprintId && openIds.has(issue.sprintId) ? issue.sprintId : BACKLOG_LANE;
}

/** The sprintId a lane stands for in an issue write. */
export function laneSprintId(laneKey: string): string | null {
  return laneKey === BACKLOG_LANE ? null : laneKey;
}

/**
 * Lanes top to bottom — active sprint, planned sprints, Backlog — each with its issues in board order.
 * The Backlog holds issues without a sprint and open issues still pointing at a finished sprint (reopened
 * later); finished issues of finished sprints are history and stay out.
 */
export function planLanes(sprints: readonly Sprint[], board: BoardState): PlanLane[] {
  const open = openSprints(sprints);
  const openIds = new Set(open.map((sprint) => sprint.id));
  const done = new Set(board.statuses.filter((status) => status.category === "done").map((status) => status.id));
  const lanes: PlanLane[] = [...open.map((sprint) => ({ key: sprint.id, sprint, name: sprint.name, issues: [] as IssueCard[] })), { key: BACKLOG_LANE, sprint: null, name: "Backlog", issues: [] }];
  const byKey = new Map(lanes.map((lane) => [lane.key, lane]));
  for (const issue of board.issues) {
    const key = laneKeyOf(issue, openIds);
    if (key === BACKLOG_LANE && issue.sprintId && done.has(issue.statusId)) continue;
    byKey.get(key)?.issues.push(issue);
  }
  return lanes;
}

/** A copy of the board with one issue in another sprint (board order is unchanged). */
export function withSprint(board: BoardState, issueId: string, sprintId: string | null): BoardState {
  return { ...board, issues: board.issues.map((issue) => (issue.id === issueId ? { ...issue, sprintId } : issue)) };
}

// ---------- Waterfall plan: phases, milestones and the baseline ----------

/** A milestone as the plan routes return it: the M2 shape plus its version (for If-Match). */
export interface PlanMilestone extends ProjectMilestone {
  version: number;
}

/** Which methodology a project used when; `endedAt` null is the current period. */
export interface MethodologyPeriod {
  /** Selects the period for the methodology-specific insights (`?period=`). */
  id: string;
  methodology: string;
  startedAt: string;
  endedAt: string | null;
}

/** GET /projects/{id}/plan, and the body of the phase-plan and re-baseline commands. `version` is the project's. */
export interface ProjectPlan {
  phases: ProjectPhase[];
  milestones: PlanMilestone[];
  baselinedAt: string | null;
  /** Methodology history, oldest first. */
  periods: MethodologyPeriod[];
  version: number;
}

/** One entry of PUT /projects/{id}/phases: with `id` it keeps that phase (and its baseline), without it adds one. */
export interface PhasePlanEntry {
  id?: string;
  name: string;
  plannedStart: string;
  plannedEnd: string;
}

export interface MilestoneFields {
  name: string;
  dueDate: string;
  phaseId: string | null;
}

export type MilestonePatch = Partial<MilestoneFields> & { completed?: boolean };

export const MILESTONE_NAME_MAX = 80;
export const BASELINE_REASON_MAX = 200;

export function milestoneEtag(version: number): string {
  return `"v${version}"`;
}

export function planPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/plan`;
}

const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

/** Replaces the phase plan; `version` is the plan's (the project's settings version). */
export async function savePhasePlan(projectId: string, version: number, phases: PhasePlanEntry[]): Promise<ProjectPlan> {
  const { data } = await workspaceApi<ProjectPlan>(`${projectPath(projectId)}/phases`, { method: "PUT", body: { phases }, ifMatch: projectEtag(version) });
  return data;
}

/** Copies today's planned dates of every phase and milestone into the baseline. */
export async function rebaselinePlan(projectId: string, version: number, reason: string): Promise<ProjectPlan> {
  const { data } = await workspaceApi<ProjectPlan>(`${projectPath(projectId)}/baseline`, { method: "POST", body: { reason }, ifMatch: projectEtag(version) });
  return data;
}

export async function createMilestone(projectId: string, fields: MilestoneFields): Promise<PlanMilestone> {
  const { data } = await workspaceApi<PlanMilestone>(`${projectPath(projectId)}/milestones`, { method: "POST", body: fields });
  return data;
}

export async function updateMilestone(milestone: Pick<PlanMilestone, "id" | "version">, patch: MilestonePatch): Promise<PlanMilestone> {
  const { data } = await workspaceApi<PlanMilestone>(`/milestones/${encodeURIComponent(milestone.id)}`, { method: "PATCH", body: patch, ifMatch: milestoneEtag(milestone.version) });
  return data;
}

/** Days the planned end moved past the baseline end (negative when ahead), or null for a phase without a baseline. */
export function phaseVariance(phase: Pick<ProjectPhase, "plannedEnd" | "baselineEnd">): number | null {
  if (!phase.baselineEnd) return null;
  const days = daysBetween(phase.baselineEnd, phase.plannedEnd);
  return Number.isNaN(days) ? null : days;
}

export type VarianceTone = "none" | "on" | "ahead" | "late" | "very-late";

/** More than a week behind the baseline reads red; up to a week amber. */
export const VARIANCE_RED_DAYS = 7;

export function varianceTone(days: number | null): VarianceTone {
  if (days === null) return "none";
  if (days === 0) return "on";
  if (days < 0) return "ahead";
  return days > VARIANCE_RED_DAYS ? "very-late" : "late";
}

/** "+6 d", "−2 d", "on baseline" or "no baseline". */
export function varianceLabel(days: number | null): string {
  if (days === null) return "no baseline";
  if (days === 0) return "on baseline";
  return days > 0 ? `+${days} d` : `−${-days} d`;
}

/** The variance in words, for screen readers and the plan table. */
export function varianceDescription(days: number | null): string {
  if (days === null) return "No baseline yet";
  if (days === 0) return "On baseline";
  const count = Math.abs(days);
  return `${count} ${count === 1 ? "day" : "days"} ${days > 0 ? "behind" : "ahead of"} baseline`;
}

export interface PhaseProgress {
  done: number;
  total: number;
}

/**
 * Per phase, the tasks in it and how many are in a done column; plus the tasks without a phase (phaseId
 * null, the same cards the board's `?phase=none` filter shows). A task whose phase is not in `phaseIds` is
 * counted nowhere (the API refuses to delete a phase that tasks still use). Counts the loaded board, so a
 * board cut at 500 tasks undercounts.
 */
export function planProgress(board: Pick<BoardState, "statuses" | "issues">, phaseIds: readonly string[]): { byPhase: Map<string, PhaseProgress>; unphased: number } {
  const done = new Set(board.statuses.filter((status) => status.category === "done").map((status) => status.id));
  const byPhase = new Map(phaseIds.map((id) => [id, { done: 0, total: 0 }]));
  let unphased = 0;
  for (const issue of board.issues) {
    const progress = issue.phaseId ? byPhase.get(issue.phaseId) : undefined;
    if (!progress) {
      if (!issue.phaseId) unphased += 1;
      continue;
    }
    progress.total += 1;
    if (done.has(issue.statusId)) progress.done += 1;
  }
  return { byPhase, unphased };
}

/** A copy of the plan with one milestone added or replaced. */
export function withMilestone(plan: ProjectPlan, milestone: PlanMilestone): ProjectPlan {
  const exists = plan.milestones.some((item) => item.id === milestone.id);
  return { ...plan, milestones: exists ? plan.milestones.map((item) => (item.id === milestone.id ? milestone : item)) : [...plan.milestones, milestone] };
}

// ---------- Board columns and the methodology switch ----------

/** The API's column limits (the database enforces them; the screens check first). */
export const COLUMN_NAME_MAX = 40;
export const WIP_LIMIT_MAX = 99;
export const COLUMNS_MIN = 2;
export const COLUMNS_MAX = 12;
export const SWITCH_REASON_MAX = 200;

export interface StatusPatch {
  name?: string;
  /** null removes the limit. */
  wipLimit?: number | null;
}

/** Renames a column or changes its WIP limit; answers with the whole project (its version is the next If-Match). */
export async function updateStatus(projectId: string, statusId: string, etag: string, patch: StatusPatch): Promise<{ project: ProjectDetail; etag: string }> {
  const { data, etag: next } = await workspaceApi<ProjectDetail>(`${projectPath(projectId)}/statuses/${encodeURIComponent(statusId)}`, { method: "PATCH", body: patch, ifMatch: etag });
  return { project: data, etag: next ?? projectEtag(data.version) };
}

/** One column of the board after a switch: with `id` it keeps that column (and its cards). */
export interface SwitchColumn {
  id?: string;
  name: string;
  category: StatusCategory;
  wipLimit: number | null;
}

/** POST /projects/{id}/methodology. `mapping` sends each removed column's cards to an index of `columns`. */
export interface SwitchRequest {
  to: MethodologyId;
  columns: SwitchColumn[];
  mapping: Record<string, number>;
  sprintLengthDays?: number;
  startDate?: string;
  targetDate?: string;
  phases?: PhasePlanEntry[];
  reason: string;
}

export interface SwitchResult {
  project: ProjectDetail;
  movedIssues: number;
}

export async function switchMethodology(projectId: string, etag: string, request: SwitchRequest): Promise<SwitchResult> {
  const { data } = await workspaceApi<SwitchResult>(`${projectPath(projectId)}/methodology`, { method: "POST", body: request, ifMatch: etag });
  return data;
}

export const WIP_RULE = `Use a whole number from 1 to ${WIP_LIMIT_MAX}, or leave it empty for no limit.`;

/** A WIP field's value: "" is no limit, otherwise a whole number 1–99; undefined when it is neither. */
export function parseWipLimit(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/u.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= 1 && value <= WIP_LIMIT_MAX ? value : undefined;
}

/** Why a column name can't be used, or null. */
export function columnNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Give the column a name.";
  return trimmed.length > COLUMN_NAME_MAX ? `Keep column names to ${COLUMN_NAME_MAX} characters.` : null;
}

const CATEGORY_LABELS: Record<string, string> = { backlog: "Backlog", todo: "To do", in_progress: "In progress", done: "Done" };

/** A status category in words ("In progress"). */
export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

/** "2 cards", "1 card", "No cards". */
export function cardCountLabel(count: number): string {
  return count === 0 ? "No cards" : `${count} ${count === 1 ? "card" : "cards"}`;
}

/** The refusal for a WIP limit below the cards a column would hold after a switch (the API can't name the column). */
export function wipBelowOccupancyMessage(cards: number): string {
  return `${cards} ${cards === 1 ? "card" : "cards"} would be in this column; the limit can't be below that.`;
}

/** "Kanban since Oct 18" for the current period, "Scrum Oct 3–Oct 18" for a closed one (UTC calendar days). */
export function periodLabel(period: MethodologyPeriod): string {
  const from = formatShortDay(period.startedAt.slice(0, 10));
  const name = methodologyName(period.methodology);
  return period.endedAt ? `${name} ${from}–${formatShortDay(period.endedAt.slice(0, 10))}` : `${name} since ${from}`;
}
