/** The methodology switch wizard's model: the proposed columns, their occupancy and the POST body. Pure, so it is unit-tested. */

import type { MethodologyId, StatusCategory, StatusTemplate } from "./methodologies";
import { parseWipLimit, type PhasePlanEntry, type SwitchColumn, type SwitchRequest } from "./planning";
import type { ProjectStatus } from "./projects";

/** A column of the board after the switch; `sourceId` keeps that current column (and its cards). */
export interface TargetColumn {
  /** Stable while editing; turned into an index only in the request. */
  key: number;
  sourceId: string | null;
  name: string;
  category: StatusCategory;
  /** The WIP field's text ("" is no limit). */
  wip: string;
}

export interface ColumnPlan {
  columns: TargetColumn[];
  /** Current column id → key of the target column its cards move to (null: not chosen yet). Kept columns are absent. */
  mapping: Record<string, number | null>;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The target column a not-kept current column's cards go to by default: same category, a new column first. */
function defaultTarget(category: string, columns: readonly TargetColumn[]): number | null {
  const same = columns.filter((column) => column.category === category);
  return (same.find((column) => column.sourceId === null) ?? same[0])?.key ?? null;
}

/**
 * The target template's columns. A current column with the same name and category is kept (its cards stay);
 * every other current column moves its cards to a target column of the same category, a new one first, or
 * waits for a choice when the target has no such category.
 */
export function proposeColumns(statuses: readonly ProjectStatus[], template: { statuses: readonly StatusTemplate[] }): ColumnPlan {
  const kept = new Set<string>();
  const columns = template.statuses.map((column, index): TargetColumn => {
    const match = statuses.find((status) => !kept.has(status.id) && status.category === column.category && sameName(status.name, column.name));
    if (match) kept.add(match.id);
    return { key: index, sourceId: match?.id ?? null, name: column.name, category: column.category, wip: column.wipLimit === null ? "" : String(column.wipLimit) };
  });
  const mapping: ColumnPlan["mapping"] = {};
  for (const status of statuses) {
    if (!kept.has(status.id)) mapping[status.id] = defaultTarget(status.category, columns);
  }
  return { columns, mapping };
}

/**
 * The user's plan re-applied to a newer set of current columns (after a teammate changed them): edited target
 * columns stay; a kept column whose source is gone becomes a new column, one whose source remains takes that
 * source's category; mappings of columns that still exist stay, new columns get the default target.
 */
export function reconcileColumns(plan: ColumnPlan, statuses: readonly ProjectStatus[]): ColumnPlan {
  const byId = new Map(statuses.map((status) => [status.id, status]));
  const columns = plan.columns.map((column) => {
    const source = column.sourceId ? byId.get(column.sourceId) : undefined;
    if (column.sourceId && !source) return { ...column, sourceId: null };
    return source ? { ...column, category: source.category as StatusCategory } : column;
  });
  const kept = new Set(columns.map((column) => column.sourceId).filter((id): id is string => id !== null));
  const keys = new Set(columns.map((column) => column.key));
  const mapping: ColumnPlan["mapping"] = {};
  for (const status of statuses) {
    if (kept.has(status.id)) continue;
    const previous = plan.mapping[status.id];
    mapping[status.id] = previous !== undefined && previous !== null && keys.has(previous) ? previous : defaultTarget(status.category, columns);
  }
  return { columns, mapping };
}

/** Cards each target column would hold: its kept column's own plus every column mapped to it. */
export function columnOccupancy(plan: ColumnPlan, counts: ReadonlyMap<string, number>): Map<number, number> {
  const totals = new Map(plan.columns.map((column) => [column.key, column.sourceId ? counts.get(column.sourceId) ?? 0 : 0]));
  for (const [statusId, key] of Object.entries(plan.mapping)) {
    if (key !== null && totals.has(key)) totals.set(key, (totals.get(key) ?? 0) + (counts.get(statusId) ?? 0));
  }
  return totals;
}

/** The ids of current columns a target column keeps. */
export function keptIds(plan: ColumnPlan): Set<string> {
  return new Set(plan.columns.map((column) => column.sourceId).filter((id): id is string => id !== null));
}

export interface PlanningChoices {
  sprintLengthDays: number;
  startDate: string;
  targetDate: string;
  phases: ReadonlyArray<{ id?: string; name: string; plannedStart: string; plannedEnd: string }>;
}

/** The POST body: planning keys only for the methodology they belong to (the API refuses the others). */
export function buildSwitchRequest(to: MethodologyId, plan: ColumnPlan, planning: PlanningChoices, reason: string): SwitchRequest {
  const kept = keptIds(plan);
  const body: SwitchRequest = {
    to,
    columns: plan.columns.map((column): SwitchColumn => ({
      ...(column.sourceId ? { id: column.sourceId } : {}),
      name: column.name.trim(),
      category: column.category,
      wipLimit: parseWipLimit(column.wip) ?? null,
    })),
    mapping: Object.fromEntries(
      Object.entries(plan.mapping)
        .filter(([statusId]) => !kept.has(statusId))
        .map(([statusId, key]) => [statusId, plan.columns.findIndex((column) => column.key === key)]),
    ),
    reason: reason.trim(),
  };
  if (to === "scrum") body.sprintLengthDays = planning.sprintLengthDays;
  if (to === "waterfall") {
    body.startDate = planning.startDate;
    body.targetDate = planning.targetDate;
    body.phases = planning.phases.map((row): PhasePlanEntry => ({ ...(row.id ? { id: row.id } : {}), name: row.name.trim(), plannedStart: row.plannedStart, plannedEnd: row.plannedEnd }));
  }
  return body;
}
