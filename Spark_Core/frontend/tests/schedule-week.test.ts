import { describe, expect, it } from "vitest";

import {
  addDays,
  bucketWeek,
  dayOfInstant,
  formatEventTime,
  formatWeekLabel,
  mondayOf,
  parseWeekParam,
  weekBounds,
  weekDays,
  type CalendarEvent,
  type Deadline,
} from "../src/app/w/_lib/schedule";

const BERLIN = "Europe/Berlin";

function event(over: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "e1", title: "Sync", description: null, location: null, startsAt: "2026-10-28T09:00:00.000Z", endsAt: "2026-10-28T10:00:00.000Z",
    timezone: "UTC", status: "scheduled", organizer: { id: "u1", displayName: "Avery" }, project: null, issue: null, attendees: [],
    myResponse: null, canEdit: false, version: 1, ...over,
  };
}

describe("week math", () => {
  it("finds the Monday of any day", () => {
    expect(mondayOf("2026-10-26")).toBe("2026-10-26");
    expect(mondayOf("2026-11-01")).toBe("2026-10-26");
    expect(mondayOf("2026-10-28")).toBe("2026-10-26");
    expect(mondayOf("2027-01-01")).toBe("2026-12-28");
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-10-26", 7)).toBe("2026-11-02");
    expect(addDays("2026-12-28", 7)).toBe("2027-01-04");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(weekDays("2026-10-26")).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
  });

  it("accepts only a valid week parameter and snaps it to its Monday", () => {
    expect(parseWeekParam("2026-10-28")).toBe("2026-10-26");
    expect(parseWeekParam("nonsense")).toBeNull();
    expect(parseWeekParam("2026-02-31")).toBeNull();
    expect(parseWeekParam(null)).toBeNull();
  });

  it("starts the week at local Monday midnight and spans the DST change in Europe/Berlin", () => {
    // Berlin leaves summer time on Sunday 2026-10-25 (02:00 CEST -> 01:00 CET): that week is 25 hours long.
    const before = weekBounds("2026-10-19", BERLIN);
    expect(before.from).toBe("2026-10-18T22:00:00.000Z");
    expect(before.to).toBe("2026-10-25T23:00:00.000Z");
    const after = weekBounds("2026-10-26", BERLIN);
    expect(after.from).toBe("2026-10-25T23:00:00.000Z");
    expect(after.to).toBe("2026-11-01T23:00:00.000Z");
  });

  it("maps an instant to the day it falls on in the zone", () => {
    expect(dayOfInstant("2026-10-28T23:30:00.000Z", BERLIN)).toBe("2026-10-29");
    expect(dayOfInstant("2026-10-28T23:30:00.000Z", "UTC")).toBe("2026-10-28");
    expect(dayOfInstant("2026-10-28T23:30:00.000Z", "America/Los_Angeles")).toBe("2026-10-28");
  });

  it("labels the week", () => {
    expect(formatWeekLabel("2026-10-26")).toBe("Oct 26 – Nov 1, 2026");
    expect(formatWeekLabel("2026-10-12")).toBe("Oct 12 – Oct 18, 2026");
    expect(formatWeekLabel("2026-12-28")).toBe("Dec 28, 2026 – Jan 3, 2027");
  });
});

describe("bucketing", () => {
  it("shows an event running 23:00-01:00 on both days", () => {
    // 22:00Z-00:00Z is 23:00-01:00 in Berlin (CET) on 2026-11-03.
    const night = event({ id: "night", startsAt: "2026-11-03T22:00:00.000Z", endsAt: "2026-11-04T00:00:00.000Z" });
    const buckets = bucketWeek({ monday: "2026-11-02", events: [night], deadlines: [], tz: BERLIN });
    const withEvent = buckets.filter((bucket) => bucket.events.length > 0).map((bucket) => bucket.day);
    expect(withEvent).toEqual(["2026-11-03", "2026-11-04"]);
  });

  it("does not spill into the next day when an event ends exactly at midnight", () => {
    const evening = event({ startsAt: "2026-11-03T21:00:00.000Z", endsAt: "2026-11-03T23:00:00.000Z" });
    const buckets = bucketWeek({ monday: "2026-11-02", events: [evening], deadlines: [], tz: BERLIN });
    expect(buckets.filter((bucket) => bucket.events.length > 0).map((bucket) => bucket.day)).toEqual(["2026-11-03"]);
  });

  it("orders a day's events by start time and keeps a day only for the week asked", () => {
    const late = event({ id: "late", startsAt: "2026-10-28T15:00:00.000Z", endsAt: "2026-10-28T16:00:00.000Z" });
    const early = event({ id: "early", startsAt: "2026-10-28T08:00:00.000Z", endsAt: "2026-10-28T08:30:00.000Z" });
    const outside = event({ id: "outside", startsAt: "2026-11-09T08:00:00.000Z", endsAt: "2026-11-09T09:00:00.000Z" });
    const buckets = bucketWeek({ monday: "2026-10-26", events: [late, early, outside], deadlines: [], tz: "UTC" });
    expect(buckets).toHaveLength(7);
    expect(buckets[2].events.map((item) => item.id)).toEqual(["early", "late"]);
    expect(buckets.flatMap((bucket) => bucket.events)).toHaveLength(2);
  });

  it("puts a deadline on its own calendar date whatever the zone", () => {
    const due: Deadline = { kind: "task_due", date: "2026-10-30", title: "Ship", project: { id: "p1", key: "WEB", name: "Web", methodology: "scrum" }, issueId: "i1", assignee: null };
    for (const tz of ["Asia/Ho_Chi_Minh", "America/Los_Angeles", "UTC", BERLIN]) {
      const buckets = bucketWeek({ monday: "2026-10-26", events: [], deadlines: [due], tz });
      expect(buckets.find((bucket) => bucket.deadlines.length > 0)?.day).toBe("2026-10-30");
    }
  });
});

describe("event time text", () => {
  const night = event({ startsAt: "2026-11-03T22:00:00.000Z", endsAt: "2026-11-04T00:00:00.000Z" });

  it("renders the range in the viewer's zone", () => {
    const sync = event({ startsAt: "2026-10-28T09:00:00.000Z", endsAt: "2026-10-28T10:30:00.000Z" });
    expect(formatEventTime(sync, "2026-10-28", "UTC")).toBe("09:00 – 10:30");
    expect(formatEventTime(sync, "2026-10-28", "Asia/Ho_Chi_Minh")).toBe("16:00 – 17:30");
  });

  it("marks the two halves of an event that crosses midnight", () => {
    expect(formatEventTime(night, "2026-11-03", BERLIN)).toBe("From 23:00");
    expect(formatEventTime(night, "2026-11-04", BERLIN)).toBe("Until 01:00");
  });
});
