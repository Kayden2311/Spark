/** GET /issues/{id}/events and the sentences the task drawer tells its history in. */

import { formatDay } from "./projects";

/** The allowlisted snapshot an event carries: ids only, never title or description text. */
export interface IssueEventSnapshot {
  statusId?: string | null;
  category?: string | null;
  assigneeUserId?: string | null;
  storyPoints?: number | null;
  phaseId?: string | null;
  sprintId?: string | null;
  archived?: boolean | null;
}

export interface IssueEvent {
  id: string;
  type: string;
  actor: { id: string; displayName: string } | null;
  fromVersion: number;
  toVersion: number;
  changes: { fields?: string[]; after?: IssueEventSnapshot };
  createdAt: string;
}

export interface IssueEventPage {
  items: IssueEvent[];
  nextCursor: string | null;
}

/** Names for the ids in a snapshot; undefined when the id is no longer known (a removed status or a former member). */
export interface HistoryNames {
  status(id: string): string | undefined;
  member(id: string): string | undefined;
  phase(id: string): string | undefined;
}

function list(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** "Avery Founder moved it to In progress", "Blake Rivers assigned it to Sam Lee", "Avery Founder created the task". */
export function describeEvent(event: IssueEvent, names: HistoryNames): string {
  const actor = event.actor?.displayName ?? "Someone";
  if (event.type === "issue.created") return `${actor} created the task`;
  if (event.type === "issue.reranked") return `${actor} reordered the column`;

  const fields = new Set(event.changes.fields ?? []);
  const after = event.changes.after ?? {};
  const parts: string[] = [];
  if (fields.has("archived")) parts.push(after.archived ? "archived it" : "restored it");
  if (fields.has("statusId")) {
    const status = after.statusId ? names.status(after.statusId) : undefined;
    parts.push(status ? `moved it to ${status}` : "moved it to another status");
  } else if (fields.has("position")) {
    parts.push("reordered it");
  }
  if (fields.has("assigneeUserId")) {
    const assignee = after.assigneeUserId ?? null;
    if (assignee === null) parts.push("unassigned it");
    else if (assignee === event.actor?.id) parts.push("assigned it to themselves");
    else parts.push(`assigned it to ${names.member(assignee) ?? "a former member"}`);
  }
  if (fields.has("title")) parts.push("renamed it");
  if (fields.has("description")) parts.push("edited the description");
  if (fields.has("type")) parts.push("changed the type");
  if (fields.has("priority")) parts.push("changed the priority");
  if (fields.has("storyPoints")) {
    const points = after.storyPoints ?? null;
    parts.push(points === null ? "cleared the story points" : `set the story points to ${points}`);
  }
  if (fields.has("dueDate")) parts.push("changed the due date");
  if (fields.has("phaseId")) {
    const phase = after.phaseId ? names.phase(after.phaseId) : undefined;
    parts.push(after.phaseId ? `moved it to the ${phase ?? "another"} phase` : "removed the phase");
  }
  return `${actor} ${parts.length > 0 ? list(parts) : "updated it"}`;
}

/** "just now", "5 min ago", "2 h ago", "3 d ago", then the date. */
export function timeAgo(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  return formatDay(iso.slice(0, 10));
}
