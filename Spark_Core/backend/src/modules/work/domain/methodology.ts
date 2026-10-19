export type Methodology = "scrum" | "kanban" | "waterfall";
export type StatusCategory = "backlog" | "todo" | "in_progress" | "done";

export interface StatusTemplate {
  name: string;
  category: StatusCategory;
  wipLimit: number | null;
}

export interface MethodologyTemplate {
  id: Methodology;
  name: string;
  tagline: string;
  bestFor: string;
  planningObject: string;
  practices: string[];
  metrics: string[];
  statuses: StatusTemplate[];
  defaults: { sprintLengthDays: number | null; phaseNames: string[] };
}

const status = (name: string, category: StatusCategory, wipLimit: number | null = null): StatusTemplate => ({ name, category, wipLimit });

export const METHODOLOGIES: readonly MethodologyTemplate[] = [
  {
    id: "scrum",
    name: "Scrum",
    tagline: "Ship in short, focused sprints.",
    bestFor: "Product teams iterating on a backlog with regular releases.",
    planningObject: "Sprints of 1–4 weeks with a goal and story points.",
    practices: [
      "Refine the backlog before each sprint",
      "Commit to one sprint goal",
      "Daily 15-minute stand-up",
      "Review and retro at the end of every sprint",
    ],
    metrics: ["Sprint burndown", "Velocity over the last 6 sprints", "Commitment reliability", "Scope creep"],
    statuses: [
      status("Backlog", "backlog"),
      status("To do", "todo"),
      status("In progress", "in_progress"),
      status("In review", "in_progress"),
      status("Done", "done"),
    ],
    defaults: { sprintLengthDays: 14, phaseNames: [] },
  },
  {
    id: "kanban",
    name: "Kanban",
    tagline: "Keep work flowing, one card at a time.",
    bestFor: "Teams with a steady stream of incoming work — support, ops, continuous delivery.",
    planningObject: "A continuous board with work-in-progress limits per column.",
    practices: [
      "Pull work when you have capacity — don't push",
      "Respect WIP limits to finish before starting",
      "Make blockers visible and swarm them",
      "Review flow metrics weekly",
    ],
    metrics: ["Weekly throughput", "Cycle and lead time (p50 / p85)", "Cumulative flow", "WIP vs limit and aging work"],
    statuses: [
      status("Backlog", "backlog"),
      status("Ready", "todo", 8),
      status("In progress", "in_progress", 4),
      status("Review", "in_progress", 3),
      status("Done", "done"),
    ],
    defaults: { sprintLengthDays: null, phaseNames: [] },
  },
  {
    id: "waterfall",
    name: "Waterfall",
    tagline: "Plan the phases, then deliver them in order.",
    bestFor: "Fixed-scope projects with a deadline — client work, launches, compliance.",
    planningObject: "Sequential phases with baseline dates and a sign-off milestone each.",
    practices: [
      "Agree the scope and dates up front",
      "Sign off each phase before the next starts",
      "Track variance against the baseline",
      "Re-baseline only when scope changes",
    ],
    metrics: ["Phase progress vs baseline", "Schedule variance in days", "Milestones hit, missed or at risk", "Gantt timeline"],
    statuses: [
      status("Not started", "todo"),
      status("In progress", "in_progress"),
      status("In review", "in_progress"),
      status("Done", "done"),
    ],
    defaults: { sprintLengthDays: null, phaseNames: ["Requirements", "Design", "Build", "Test", "Deploy"] },
  },
];

export function getMethodology(id: Methodology): MethodologyTemplate {
  const template = METHODOLOGIES.find((m) => m.id === id);
  if (template === undefined) throw new RangeError("Invalid methodology");
  return template;
}
