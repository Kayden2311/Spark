/** Pure board helpers: the optimistic copy of a move, WIP checks and keyboard targets. Ranking itself happens in the API. */

import type { BoardState, IssueCard } from "./issues";

export type ArrowKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

export interface MoveTarget {
  statusId: string;
  afterIssueId: string | null;
}

/** The cards of one column, top to bottom. */
export function columnIssues(board: BoardState, statusId: string): IssueCard[] {
  return board.issues.filter((issue) => issue.statusId === statusId);
}

/** Where a card sits now, as a target the API understands. */
export function currentTarget(board: BoardState, issueId: string): MoveTarget | null {
  const issue = board.issues.find((item) => item.id === issueId);
  if (!issue) return null;
  const column = columnIssues(board, issue.statusId);
  const index = column.findIndex((item) => item.id === issueId);
  return { statusId: issue.statusId, afterIssueId: index > 0 ? column[index - 1].id : null };
}

/** 1-based position of a card in its column and the column's size, for announcements. */
export function positionOf(board: BoardState, issueId: string): { statusId: string; position: number; size: number } | null {
  const issue = board.issues.find((item) => item.id === issueId);
  if (!issue) return null;
  const column = columnIssues(board, issue.statusId);
  return { statusId: issue.statusId, position: column.findIndex((item) => item.id === issueId) + 1, size: column.length };
}

/**
 * Moves a card to `toStatusId`, right after `afterIssueId` (null: first). Counts follow a change of column.
 * Returns a new board; the input is not changed. Unknown cards or statuses leave the board as it is.
 */
export function moveCard(board: BoardState, issueId: string, toStatusId: string, afterIssueId: string | null): BoardState {
  const moving = board.issues.find((issue) => issue.id === issueId);
  if (!moving || !board.statuses.some((status) => status.id === toStatusId)) return board;
  const fromStatusId = moving.statusId;
  const moved: IssueCard = { ...moving, statusId: toStatusId };
  const rest = board.issues.filter((issue) => issue.id !== issueId);

  const target = rest.filter((issue) => issue.statusId === toStatusId);
  const afterIndex = afterIssueId === null ? -1 : target.findIndex((issue) => issue.id === afterIssueId);
  // A missing anchor (a card that left meanwhile) puts the card at the end, like the API.
  const insertAt = afterIssueId === null ? 0 : afterIndex === -1 ? target.length : afterIndex + 1;
  target.splice(insertAt, 0, moved);

  const known = new Set(board.statuses.map((status) => status.id));
  const issues = board.statuses.flatMap((status) => (status.id === toStatusId ? target : rest.filter((issue) => issue.statusId === status.id)));
  issues.push(...rest.filter((issue) => !known.has(issue.statusId)));

  const statuses = fromStatusId === toStatusId
    ? board.statuses
    : board.statuses.map((status) => {
      if (status.id === fromStatusId) return { ...status, count: Math.max(0, status.count - 1) };
      if (status.id === toStatusId) return { ...status, count: status.count + 1 };
      return status;
    });
  return { ...board, statuses, issues };
}

/** Adds a new card at the end of its column (once, even if a replayed create returns it again). */
export function addCard(board: BoardState, card: IssueCard): BoardState {
  if (board.issues.some((issue) => issue.id === card.id)) return board;
  const placed = moveCard({ ...board, issues: [...board.issues, card] }, card.id, card.statusId, columnIssues(board, card.statusId).at(-1)?.id ?? null);
  return { ...placed, statuses: placed.statuses.map((status) => (status.id === card.statusId ? { ...status, count: status.count + 1 } : status)) };
}

/** Replaces a card's fields (after a successful write) without moving it. */
export function replaceCard(board: BoardState, card: IssueCard): BoardState {
  return { ...board, issues: board.issues.map((issue) => (issue.id === card.id ? card : issue)) };
}

/** True when the column has a WIP limit that is reached. Never true for a reorder inside the card's own column. */
export function wipBlocked(board: BoardState, issueId: string | null, toStatusId: string): boolean {
  const current = issueId === null ? null : board.issues.find((issue) => issue.id === issueId);
  if (current && current.statusId === toStatusId) return false;
  const status = board.statuses.find((item) => item.id === toStatusId);
  return Boolean(status && status.wipLimit !== null && status.count >= status.wipLimit);
}

/**
 * Where an arrow key takes a picked-up card: left/right to the neighbouring column at the same
 * position (clamped), up/down one place inside the column. Null at an edge.
 */
export function keyboardTarget(board: BoardState, issueId: string, key: ArrowKey): MoveTarget | null {
  const issue = board.issues.find((item) => item.id === issueId);
  if (!issue) return null;
  const column = columnIssues(board, issue.statusId);
  const index = column.findIndex((item) => item.id === issueId);

  if (key === "ArrowUp" || key === "ArrowDown") {
    if (key === "ArrowUp") {
      if (index === 0) return null;
      return { statusId: issue.statusId, afterIssueId: index >= 2 ? column[index - 2].id : null };
    }
    if (index === column.length - 1) return null;
    return { statusId: issue.statusId, afterIssueId: column[index + 1].id };
  }

  const statusIndex = board.statuses.findIndex((status) => status.id === issue.statusId);
  const next = board.statuses[statusIndex + (key === "ArrowRight" ? 1 : -1)];
  if (statusIndex === -1 || !next) return null;
  const target = columnIssues(board, next.id);
  const at = Math.min(index, target.length);
  return { statusId: next.id, afterIssueId: at > 0 ? target[at - 1].id : null };
}
