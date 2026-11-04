import { describe, expect, it } from "vitest";

import {
  addDays,
  chooseUnit,
  completion,
  creepPercent,
  daysBetween,
  forecast,
  idealLine,
  measure,
  milestoneState,
  planPercent,
  planStatus,
  planWindow,
  rangeOf,
  reliability,
  roundDays,
  todayUtc,
  varianceDays,
} from "../src/modules/work/domain/metrics.js";

const pts = (n: number | null) => ({ points: n });

describe("units", () => {
  it("uses points at 80% estimated and counts below", () => {
    expect(chooseUnit([pts(1), pts(2), pts(3), pts(5), pts(null)])).toBe("points");
    expect(chooseUnit([pts(1), pts(2), pts(3), pts(null)])).toBe("count");
    expect(chooseUnit([])).toBe("count");
  });

  it("measures totals in the chosen unit, null points as 0", () => {
    const items = [
      { points: 3, done: true },
      { points: null, done: true },
      { points: 5, done: false },
    ];
    expect(measure(items, "points")).toEqual({ total: 8, done: 3 });
    expect(measure(items, "count")).toEqual({ total: 3, done: 2 });
    expect(measure([], "points")).toEqual({ total: 0, done: 0 });
  });
});

describe("dates", () => {
  it("computes ranges and day arithmetic in UTC", () => {
    expect(rangeOf(30, "2026-10-26")).toEqual({ from: "2026-09-27", to: "2026-10-26" });
    expect(rangeOf(1, "2026-10-26")).toEqual({ from: "2026-10-26", to: "2026-10-26" });
    expect(todayUtc(new Date("2026-10-26T23:59:59Z"))).toBe("2026-10-26");
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-10-01", "2026-10-26")).toBe(25);
    expect(daysBetween("2026-10-26", "2026-10-01")).toBe(-25);
  });

  it("rounds milliseconds to days with one decimal", () => {
    expect(roundDays(86_400_000)).toBe(1);
    expect(roundDays(86_400_000 * 1.26)).toBe(1.3);
    expect(roundDays(0)).toBe(0);
  });
});

describe("plan completion", () => {
  const window = { start: "2026-10-01", end: "2026-10-10" };

  it("returns the elapsed share and clamps", () => {
    expect(planPercent(window, "2026-09-20")).toBe(0);
    expect(planPercent(window, "2026-10-01")).toBe(10);
    expect(planPercent(window, "2026-10-05")).toBe(50);
    expect(planPercent(window, "2026-10-10")).toBe(100);
    expect(planPercent(window, "2026-11-01")).toBe(100);
    expect(planPercent(null, "2026-10-05")).toBeNull();
  });

  it("applies the status thresholds in percentage points", () => {
    expect(planStatus(40, 50)).toBe("on_track");
    expect(planStatus(60, 50)).toBe("on_track");
    expect(planStatus(39.99, 50)).toBe("at_risk");
    expect(planStatus(25, 50)).toBe("at_risk");
    expect(planStatus(24.99, 50)).toBe("behind");
    expect(planStatus(0, 100)).toBe("behind");
    expect(planStatus(50, null)).toBe("no_plan");
  });
});

describe("forecast", () => {
  const today = "2026-10-26";

  it("divides remaining by the mean daily rate and rounds up", () => {
    const days = Array.from({ length: 14 }, (_, i) => (i < 7 ? 2 : 0)); // 14 / 14 = 1 per day
    expect(forecast(10, days, today)).toEqual({ ratePerDay: 1, date: "2026-11-05" });
    expect(forecast(10.5, days, today).date).toBe("2026-11-06");
  });

  it("returns null with no throughput and today with nothing remaining", () => {
    expect(forecast(5, new Array(14).fill(0), today)).toEqual({ ratePerDay: 0, date: null });
    expect(forecast(5, [], today)).toEqual({ ratePerDay: 0, date: null });
    expect(forecast(0, new Array(14).fill(0), today).date).toBe(today);
    expect(forecast(0, new Array(14).fill(3), today).date).toBe(today);
  });
});

describe("ideal line", () => {
  it("falls linearly from the base to 0 over a 10-day sprint", () => {
    const line = idealLine(9, "2026-10-01", "2026-10-10");
    expect(line).toHaveLength(10);
    expect(line[0]).toEqual({ day: "2026-10-01", ideal: 9 });
    expect(line[1]).toEqual({ day: "2026-10-02", ideal: 8 });
    expect(line[9]).toEqual({ day: "2026-10-10", ideal: 0 });
  });

  it("rounds to two decimals", () => {
    const line = idealLine(10, "2026-10-01", "2026-10-07");
    expect(line.map((p) => p.ideal)).toEqual([10, 8.33, 6.67, 5, 3.33, 1.67, 0]);
  });

  it("handles a one-day sprint", () => {
    expect(idealLine(5, "2026-10-01", "2026-10-01")).toEqual([{ day: "2026-10-01", ideal: 0 }]);
  });
});

describe("scrum reliability and creep", () => {
  it("returns a one-decimal percentage or null", () => {
    expect(reliability({ total: 3, done: 2 })).toBe(66.7);
    expect(reliability({ total: 4, done: 4 })).toBe(100);
    expect(reliability({ total: 0, done: 0 })).toBeNull();
    expect(creepPercent(1, 3)).toBe(33.3);
    expect(creepPercent(0, 5)).toBe(0);
    expect(creepPercent(2, 0)).toBeNull();
  });
});

describe("waterfall milestones", () => {
  const today = "2026-10-26";

  it("classifies completed milestones by the UTC completion day", () => {
    expect(milestoneState({ dueDate: today, completedAt: "2026-10-26T23:59:59Z" }, today)).toBe("hit");
    expect(milestoneState({ dueDate: "2026-10-20", completedAt: "2026-10-19T08:00:00Z" }, today)).toBe("hit");
    expect(milestoneState({ dueDate: "2026-10-20", completedAt: "2026-10-21T00:00:00Z" }, today)).toBe("missed");
  });

  it("classifies open milestones on the boundary days", () => {
    expect(milestoneState({ dueDate: "2026-10-25", completedAt: null }, today)).toBe("missed");
    expect(milestoneState({ dueDate: today, completedAt: null }, today)).toBe("at_risk");
    expect(milestoneState({ dueDate: "2026-11-02", completedAt: null }, today)).toBe("at_risk");
    expect(milestoneState({ dueDate: "2026-11-03", completedAt: null }, today)).toBe("upcoming");
  });

  it("computes schedule variance, null without a baseline", () => {
    expect(varianceDays("2026-10-10", "2026-10-05")).toBe(5);
    expect(varianceDays("2026-10-05", "2026-10-10")).toBe(-5);
    expect(varianceDays("2026-10-05", "2026-10-05")).toBe(0);
    expect(varianceDays("2026-10-05", null)).toBeNull();
  });
});

describe("completion and plan window (shared with the digest)", () => {
  const aggregate = { total_count: "10", done_count: "4", estimated_count: "9", total_points: "20", done_points: "5" };

  it("scores in points when at least 80% are estimated and counts otherwise", () => {
    const window = { start: "2026-10-01", end: "2026-10-10" };
    expect(completion(aggregate, window, "2026-10-05")).toEqual({
      unit: "points", total: 20, done: 5, donePercent: 25, planPercent: 50, status: "at_risk",
    });
    expect(completion({ ...aggregate, estimated_count: "7" }, window, "2026-10-05")).toMatchObject({
      unit: "count", total: 10, done: 4, donePercent: 40, planPercent: 50, status: "on_track",
    });
  });

  it("has no plan without a window and treats an empty scope as on track", () => {
    expect(completion(aggregate, null, "2026-10-05")).toMatchObject({ planPercent: null, status: "no_plan" });
    const empty = { total_count: "0", done_count: "0", estimated_count: "0", total_points: "0", done_points: "0" };
    expect(completion(empty, { start: "2026-10-01", end: "2026-10-10" }, "2026-10-05")).toMatchObject({
      unit: "count", total: 0, donePercent: 0, status: "on_track",
    });
  });

  it("picks the sprint for Scrum and the project dates otherwise", () => {
    const sprint = { name: "Sprint 4", starts_on: "2026-10-01", ends_on: "2026-10-14" };
    expect(planWindow({ methodology: "scrum", start_date: null, target_date: null }, sprint)).toEqual({
      window: { start: "2026-10-01", end: "2026-10-14" }, kind: "sprint", label: "Sprint 4",
    });
    expect(planWindow({ methodology: "scrum", start_date: "2026-01-01", target_date: "2026-02-01" }, null).window).toBeNull();
    expect(planWindow({ methodology: "kanban", start_date: "2026-01-01", target_date: "2026-02-01" }, sprint)).toEqual({
      window: { start: "2026-01-01", end: "2026-02-01" }, kind: "project", label: "Project window",
    });
    expect(planWindow({ methodology: "waterfall", start_date: "2026-01-01", target_date: null }, null).window).toBeNull();
  });
});
