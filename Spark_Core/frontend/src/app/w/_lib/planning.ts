/** Planning representations (M4: sprints) and their API calls, plus the pure helpers the planning screens share. */

import { canManage, workspaceApi } from "./api";
import { issueEtag, type BoardState, type IssueCard, type IssueDetail } from "./issues";
import { dayValue } from "./projects";

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
