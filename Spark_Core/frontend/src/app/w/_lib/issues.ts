/** Issue representations from the workspace API and the board calls. */

import { workspaceApi } from "./api";

export interface IssueAssignee {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

/** One card of GET /projects/{id}/board (and of issue lists). */
export interface IssueCard {
  id: string;
  number: number;
  key: string;
  title: string;
  type: string;
  priority: string;
  statusId: string;
  assignee: IssueAssignee | null;
  storyPoints: number | null;
  dueDate: string | null;
  phaseId: string | null;
  version: number;
  completedAt: string | null;
  createdAt: string;
}

/** GET /issues/{id}, and the body of every issue write. */
export interface IssueDetail extends IssueCard {
  projectId: string;
  description: string | null;
  reporter: { id: string; displayName: string } | null;
  startedAt: string | null;
  updatedAt: string;
  archivedAt: string | null;
}

export interface BoardStatus {
  id: string;
  name: string;
  category: string;
  position: number;
  wipLimit: number | null;
  /** Non-archived issues in the status, including any beyond the board's 500-card cut. */
  count: number;
}

/** GET /projects/{id}/board: issues are ordered by status position, then rank. */
export interface BoardState {
  project: { id: string; key: string; name: string; methodology: string };
  statuses: BoardStatus[];
  issues: IssueCard[];
  truncated: boolean;
}

export interface IssueMove {
  statusId?: string;
  afterIssueId: string | null;
}

/** The strong entity tag the API expects back in If-Match. */
export function issueEtag(version: number): string {
  return `"v${version}"`;
}

/** The card fields of an issue representation (drops detail-only fields). */
export function toCard(issue: IssueCard): IssueCard {
  const { id, number, key, title, type, priority, statusId, assignee, storyPoints, dueDate, phaseId, version, completedAt, createdAt } = issue;
  return { id, number, key, title, type, priority, statusId, assignee, storyPoints, dueDate, phaseId, version, completedAt, createdAt };
}

export function boardPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/board`;
}

export async function moveIssue(issue: Pick<IssueCard, "id" | "version">, move: IssueMove): Promise<IssueDetail> {
  const { data } = await workspaceApi<IssueDetail>(`/issues/${encodeURIComponent(issue.id)}`, { method: "PATCH", body: move, ifMatch: issueEtag(issue.version) });
  return data;
}

export async function createIssue(projectId: string, body: { title: string; statusId: string }, idempotencyKey: string): Promise<IssueDetail> {
  const { data } = await workspaceApi<IssueDetail>(`/projects/${encodeURIComponent(projectId)}/issues`, { method: "POST", body, idempotencyKey });
  return data;
}

const TYPE_LABELS: Record<string, string> = { task: "Task", bug: "Bug", story: "Story", epic: "Epic", subtask: "Subtask" };
const PRIORITY_LABELS: Record<string, string> = { lowest: "Lowest", low: "Low", medium: "Medium", high: "High", highest: "Highest" };

export function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? "Task";
}

export function priorityLabel(priority: string): string {
  return PRIORITY_LABELS[priority] ?? "Medium";
}
