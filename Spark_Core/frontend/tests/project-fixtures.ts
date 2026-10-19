/** Test copies of the project API representations (GET /workspaces/{id}/projects and /projects/by-key/{key}). */

const base = {
  description: null as string | null,
  startDate: null as string | null,
  targetDate: null as string | null,
  sprintLengthDays: null as number | null,
  baselinedAt: null as string | null,
  version: 3,
  createdAt: "2026-10-18T10:00:00.000Z",
  progress: { total: 0, done: 0, open: 0 },
};

const avery = { id: "u-avery", displayName: "Avery Founder" };
const blake = { id: "u-blake", displayName: "Blake Rivers" };

export const LIST = [
  { ...base, id: "p-atlas", key: "ATLAS", name: "Atlas app", methodology: "scrum", lead: avery, sprintLengthDays: 14, progress: { total: 8, done: 3, open: 5 } },
  { ...base, id: "p-ops", key: "OPS", name: "Ops desk", methodology: "kanban", lead: blake },
  { ...base, id: "p-web", key: "WEB", name: "Website relaunch", methodology: "waterfall", lead: null, startDate: "2026-11-02", targetDate: "2026-12-11" },
];

const status = (id: string, name: string, category: string, position: number, wipLimit: number | null = null) => ({ id, name, category, position, wipLimit });

export const KANBAN = {
  ...LIST[1],
  description: "Requests from the support team.",
  statuses: [
    status("s1", "Backlog", "backlog", 0),
    status("s2", "Ready", "todo", 1, 8),
    status("s3", "In progress", "in_progress", 2, 4),
    status("s4", "Review", "in_progress", 3, 3),
    status("s5", "Done", "done", 4),
  ],
  phases: [],
  milestones: [],
};

export const SCRUM = {
  ...LIST[0],
  statuses: [
    status("t1", "Backlog", "backlog", 0),
    status("t2", "To do", "todo", 1),
    status("t3", "In progress", "in_progress", 2),
    status("t4", "In review", "in_progress", 3),
    status("t5", "Done", "done", 4),
  ],
  phases: [],
  milestones: [],
};

const PHASES = [
  ["Requirements", "2026-11-02", "2026-11-09"],
  ["Design", "2026-11-10", "2026-11-17"],
  ["Build", "2026-11-18", "2026-11-25"],
  ["Test", "2026-11-26", "2026-12-03"],
  ["Deploy", "2026-12-04", "2026-12-11"],
] as const;

export const WATERFALL = {
  ...LIST[2],
  baselinedAt: "2026-10-18T10:00:00.000Z",
  statuses: [
    status("w1", "Not started", "todo", 0),
    status("w2", "In progress", "in_progress", 1),
    status("w3", "In review", "in_progress", 2),
    status("w4", "Done", "done", 3),
  ],
  phases: PHASES.map(([name, start, end], index) => ({
    id: `ph${index + 1}`,
    name,
    position: index,
    plannedStart: start,
    plannedEnd: end,
    baselineStart: start,
    baselineEnd: end,
    status: "not_started",
  })),
  milestones: PHASES.map(([name, , end], index) => ({
    id: `ms${index + 1}`,
    name: `${name} sign-off`,
    phaseId: `ph${index + 1}`,
    dueDate: end,
    baselineDueDate: end,
    completedAt: null,
  })),
};

/** Test copies of GET /projects/{id}/board. */
const card = (id: string, number: number, statusId: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  number,
  key: `OPS-${number}`,
  title,
  type: "task",
  priority: "medium",
  statusId,
  assignee: null as { id: string; displayName: string; avatarUrl: string | null } | null,
  storyPoints: null as number | null,
  dueDate: null as string | null,
  phaseId: null as string | null,
  version: 1,
  completedAt: null as string | null,
  createdAt: "2026-10-19T09:00:00.000Z",
  ...extra,
});

const boardStatus = (id: string, name: string, category: string, position: number, wipLimit: number | null, count: number) => ({ id, name, category, position, wipLimit, count });

export const KANBAN_BOARD = {
  project: { id: "p-ops", key: "OPS", name: "Ops desk", methodology: "kanban" },
  statuses: [
    boardStatus("s1", "Backlog", "backlog", 0, null, 1),
    boardStatus("s2", "Ready", "todo", 1, 8, 2),
    boardStatus("s3", "In progress", "in_progress", 2, 4, 0),
    boardStatus("s4", "Review", "in_progress", 3, 3, 3),
    boardStatus("s5", "Done", "done", 4, null, 1),
  ],
  issues: [
    card("i0", 9, "s1", "Collect feedback themes"),
    card("i1", 1, "s2", "Reset VPN tokens", { type: "bug", priority: "high", assignee: { id: "u-blake", displayName: "Blake Rivers", avatarUrl: null }, dueDate: "2020-01-01" }),
    card("i2", 2, "s2", "Order new laptops"),
    card("i4", 4, "s4", "Rotate on-call schedule"),
    card("i5", 5, "s4", "Update runbook"),
    card("i6", 6, "s4", "Audit shared drives"),
    card("i7", 7, "s5", "Archive old tickets", { dueDate: "2020-01-01", completedAt: "2026-10-18T10:00:00.000Z" }),
  ],
  truncated: false,
};

/** The IssueDetail the API returns for a card after a write. */
export function issueDetail(base: ReturnType<typeof card>, changes: Record<string, unknown> = {}) {
  return {
    ...base,
    projectId: "p-ops",
    description: null,
    reporter: { id: "u-avery", displayName: "Avery Founder" },
    startedAt: null,
    updatedAt: "2026-10-19T10:00:00.000Z",
    archivedAt: null,
    ...changes,
  };
}
