import { describe, expect, it } from "vitest";

import { spreadPhases } from "../src/app/w/_lib/phases";
import { cleanKeyInput, deriveProjectKey, isValidProjectKey } from "../src/app/w/_lib/project-key";

const NAMES = ["Requirements", "Design", "Build", "Test", "Deploy"];

describe("deriveProjectKey", () => {
  it.each([
    ["Product Launch", "PL"],
    ["Website redesign 2027 Q1", "WR2Q"],
    ["Atlas", "ATL"],
    ["42", "PRJ"],
    ["", "PRJ"],
    ["  mobile   app  v2 extra words ", "MAVE"],
    ["Ünïcode café", "UC"],
  ])("derives %j as %s", (name, key) => {
    expect(deriveProjectKey(name)).toBe(key);
  });

  it("always returns a valid key", () => {
    for (const name of ["x", "A", "!!", "a b", "Product Launch", "9 lives"]) expect(isValidProjectKey(deriveProjectKey(name))).toBe(true);
  });
});

describe("project key input", () => {
  it("uppercases, drops other characters and keeps 10", () => {
    expect(cleanKeyInput("ab-c 1")).toBe("ABC1");
    expect(cleanKeyInput("abcdefghijklmn")).toBe("ABCDEFGHIJ");
  });

  it("validates against the key pattern", () => {
    expect(isValidProjectKey("PL")).toBe(true);
    expect(isValidProjectKey("P")).toBe(false);
    expect(isValidProjectKey("1PL")).toBe(false);
    expect(isValidProjectKey("ABCDEFGHIJK")).toBe(false);
  });
});

// Same vectors as the backend copy in Spark_Core/backend/tests/methodology.test.ts.
describe("spreadPhases (frontend copy)", () => {
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
