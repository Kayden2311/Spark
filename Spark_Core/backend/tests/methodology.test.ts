import { describe, expect, it } from "vitest";

import { METHODOLOGIES, getMethodology } from "../src/modules/work/domain/methodology.js";
import { spreadPhases } from "../src/modules/work/domain/phases.js";

const NAMES = ["Requirements", "Design", "Build", "Test", "Deploy"];

describe("methodology templates", () => {
  it("lists scrum, kanban, waterfall in order", () => {
    expect(METHODOLOGIES.map((m) => m.id)).toEqual(["scrum", "kanban", "waterfall"]);
    expect(getMethodology("kanban").name).toBe("Kanban");
  });

  it.each(METHODOLOGIES)("$id satisfies the status rules", (template) => {
    const { statuses } = template;
    expect(statuses.length).toBeGreaterThanOrEqual(2);
    expect(statuses.length).toBeLessThanOrEqual(12);
    const names = statuses.map((s) => s.name.trim().toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(statuses.some((s) => s.category === "done")).toBe(true);
    expect(statuses.some((s) => s.category !== "done")).toBe(true);
    for (const s of statuses) {
      expect(s.name.trim()).toBe(s.name);
      expect(s.name.length).toBeGreaterThanOrEqual(1);
      expect(s.name.length).toBeLessThanOrEqual(40);
      if (s.wipLimit !== null) {
        expect(s.wipLimit).toBeGreaterThanOrEqual(1);
        expect(s.wipLimit).toBeLessThanOrEqual(99);
      }
    }
  });

  it("uses the exact Kanban WIP limits", () => {
    expect(getMethodology("kanban").statuses).toEqual([
      { name: "Backlog", category: "backlog", wipLimit: null },
      { name: "Ready", category: "todo", wipLimit: 8 },
      { name: "In progress", category: "in_progress", wipLimit: 4 },
      { name: "Review", category: "in_progress", wipLimit: 3 },
      { name: "Done", category: "done", wipLimit: null },
    ]);
  });

  it("has the exact defaults", () => {
    expect(getMethodology("scrum").defaults).toEqual({ sprintLengthDays: 14, phaseNames: [] });
    expect(getMethodology("kanban").defaults).toEqual({ sprintLengthDays: null, phaseNames: [] });
    expect(getMethodology("waterfall").defaults).toEqual({ sprintLengthDays: null, phaseNames: NAMES });
    expect(getMethodology("scrum").statuses.map((s) => s.name)).toEqual(["Backlog", "To do", "In progress", "In review", "Done"]);
    expect(getMethodology("waterfall").statuses.map((s) => s.name)).toEqual(["Not started", "In progress", "In review", "Done"]);
  });
});

describe("spreadPhases", () => {
  it("spreads 40 days over five phases", () => {
    expect(spreadPhases("2026-11-02", "2026-12-11", NAMES)).toEqual([
      { name: "Requirements", plannedStart: "2026-11-02", plannedEnd: "2026-11-09" },
      { name: "Design", plannedStart: "2026-11-10", plannedEnd: "2026-11-17" },
      { name: "Build", plannedStart: "2026-11-18", plannedEnd: "2026-11-25" },
      { name: "Test", plannedStart: "2026-11-26", plannedEnd: "2026-12-03" },
      { name: "Deploy", plannedStart: "2026-12-04", plannedEnd: "2026-12-11" },
    ]);
  });

  it("rejects fewer days than phases", () => {
    expect(() => spreadPhases("2026-11-02", "2026-11-04", NAMES)).toThrow(new RangeError("Invalid project dates"));
  });

  it("rejects a target before the start", () => {
    expect(() => spreadPhases("2026-11-05", "2026-11-02", ["A"])).toThrow("Invalid project dates");
  });

  it("covers every day with uneven splits", () => {
    const phases = spreadPhases("2026-01-01", "2026-01-07", ["A", "B", "C"]);
    expect(phases.map((p) => [p.plannedStart, p.plannedEnd])).toEqual([
      ["2026-01-01", "2026-01-02"],
      ["2026-01-03", "2026-01-04"],
      ["2026-01-05", "2026-01-07"],
    ]);
  });
});
