import { describe, expect, it } from "vitest";

import { buildSwitchRequest, columnOccupancy, plannedSprintNote, proposeColumns, reconcileColumns, type ColumnPlan } from "../src/app/w/_lib/switch";
import { CATALOG } from "./methodology-catalog";
import { KANBAN, SCRUM } from "./project-fixtures";

const template = (id: string) => CATALOG.find((item) => item.id === id) as (typeof CATALOG)[number];
const planning = { sprintLengthDays: 21, startDate: "2026-11-02", targetDate: "2026-11-11", phases: [{ id: "ph1", name: " Build ", plannedStart: "2026-11-02", plannedEnd: "2026-11-11" }] };

describe("proposeColumns", () => {
  it("keeps same-name same-category columns and maps the rest by category, new columns first", () => {
    const plan = proposeColumns(KANBAN.statuses, template("scrum"));
    expect(plan.columns.map((column) => [column.name, column.sourceId])).toEqual([
      ["Backlog", "s1"], ["To do", null], ["In progress", "s3"], ["In review", null], ["Done", "s5"],
    ]);
    // Ready (todo) → To do; Review (in_progress) prefers the new "In review" over the kept "In progress".
    expect(plan.mapping).toEqual({ s2: 1, s4: 3 });
  });

  it("proposes Kanban's WIP limits and leaves a column without a same-category target unmapped", () => {
    expect(proposeColumns(SCRUM.statuses, template("kanban")).columns.map((column) => column.wip)).toEqual(["", "8", "4", "3", ""]);
    expect(proposeColumns(KANBAN.statuses, template("waterfall")).mapping.s1).toBeNull();
  });
});

describe("columnOccupancy", () => {
  it("adds the kept column's cards and every column mapped to a target", () => {
    const plan = proposeColumns(KANBAN.statuses, template("scrum"));
    const counts = new Map([["s1", 1], ["s2", 2], ["s3", 0], ["s4", 3], ["s5", 1]]);
    expect([...columnOccupancy(plan, counts).values()]).toEqual([1, 2, 0, 3, 1]);
  });
});

describe("reconcileColumns", () => {
  it("keeps the user's edits, frees columns whose source is gone and maps new current columns", () => {
    const edited: ColumnPlan = proposeColumns(KANBAN.statuses, template("scrum"));
    edited.columns[1] = { ...edited.columns[1], name: "Next up", wip: "5" };
    const statuses = [...KANBAN.statuses.filter((status) => status.id !== "s3"), { id: "s9", name: "Blocked", category: "in_progress", position: 5, wipLimit: null }];
    const plan = reconcileColumns(edited, statuses);
    expect(plan.columns[1]).toMatchObject({ name: "Next up", wip: "5" });
    expect(plan.columns[2]).toMatchObject({ name: "In progress", sourceId: null });
    // Existing choices stay; the new column goes to a new in-progress column.
    expect(plan.mapping).toEqual({ s2: 1, s4: 3, s9: 2 });
  });
});

describe("buildSwitchRequest", () => {
  const plan = proposeColumns(KANBAN.statuses, template("scrum"));

  it("sends ids only for kept columns, indexes for the mapping and a trimmed reason", () => {
    const body = buildSwitchRequest("scrum", plan, planning, "  Releases  ");
    expect(body).toEqual({
      to: "scrum",
      columns: [
        { id: "s1", name: "Backlog", category: "backlog", wipLimit: null },
        { name: "To do", category: "todo", wipLimit: null },
        { id: "s3", name: "In progress", category: "in_progress", wipLimit: null },
        { name: "In review", category: "in_progress", wipLimit: null },
        { id: "s5", name: "Done", category: "done", wipLimit: null },
      ],
      mapping: { s2: 1, s4: 3 },
      sprintLengthDays: 21,
      reason: "Releases",
    });
  });

  it("leaves every planning key out for Kanban", () => {
    const body = buildSwitchRequest("kanban", proposeColumns(SCRUM.statuses, template("kanban")), planning, "Flow");
    expect(Object.keys(body).sort()).toEqual(["columns", "mapping", "reason", "to"]);
  });

  it("sends dates and phases, with kept phase ids, only for Waterfall", () => {
    const body = buildSwitchRequest("waterfall", plan, planning, "Launch");
    expect(body).not.toHaveProperty("sprintLengthDays");
    expect(body).toMatchObject({ startDate: "2026-11-02", targetDate: "2026-11-11", phases: [{ id: "ph1", name: "Build", plannedStart: "2026-11-02", plannedEnd: "2026-11-11" }] });
  });
});

describe("plannedSprintNote", () => {
  const statuses = SCRUM.statuses;
  const card = (statusId: string, sprintId: string | null) => ({ statusId, sprintId });
  const sprints = [{ id: "a", status: "planned" }, { id: "b", status: "planned" }, { id: "c", status: "completed" }];

  it("counts the planned sprints and their open cards", () => {
    const cards = [card("t2", "a"), card("t5", "a"), card("t3", "b"), card("t2", "c"), card("t1", null)];
    expect(plannedSprintNote(sprints, cards, statuses)).toBe("2 planned sprints are cancelled and 2 open cards return to the backlog.");
    expect(plannedSprintNote(sprints.slice(0, 1), [card("t2", "a")], statuses)).toBe("1 planned sprint is cancelled and 1 open card returns to the backlog.");
  });

  it("stays general while sprints or cards are unknown, and says nothing without planned sprints", () => {
    expect(plannedSprintNote(null, [], statuses)).toBe("Planned sprints are cancelled and their open cards return to the backlog.");
    expect(plannedSprintNote(sprints, null, statuses)).toBe("2 planned sprints are cancelled and their open cards return to the backlog.");
    expect(plannedSprintNote(sprints.slice(2), [card("t2", "c")], statuses)).toBeNull();
  });
});
