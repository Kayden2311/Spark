import type { CSSProperties } from "react";

import { daysBetween, formatDay, formatShortDay, type ProjectMilestone, type ProjectPhase } from "../../../_lib/projects";

const monthLabel = new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" });

function earliest(days: Array<string | null | undefined>): string {
  return days.filter((day): day is string => Boolean(day)).sort()[0] ?? "";
}

function latest(days: Array<string | null | undefined>): string {
  return days.filter((day): day is string => Boolean(day)).sort().at(-1) ?? "";
}

/** The first day of every month after `start` up to `end`, as ISO days. */
function monthStarts(start: string, end: string): string[] {
  const result: string[] = [];
  let year = Number(start.slice(0, 4));
  let month = Number(start.slice(5, 7));
  for (;;) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    const day = `${year}-${String(month).padStart(2, "0")}-01`;
    if (day > end) return result;
    result.push(day);
  }
}

/**
 * A compact Gantt view: one row per phase on a day grid, the baseline as a ghost bar under the plan,
 * milestone diamonds on their due day and a marker for today when it falls inside the range.
 */
export function PhaseTimeline({ phases, milestones, startDate, targetDate, today }: {
  phases: ProjectPhase[];
  milestones: ProjectMilestone[];
  startDate: string | null;
  targetDate: string | null;
  today: string;
}) {
  const start = earliest([startDate, ...phases.flatMap((phase) => [phase.plannedStart, phase.baselineStart]), ...milestones.map((item) => item.dueDate)]);
  const end = latest([targetDate, ...phases.flatMap((phase) => [phase.plannedEnd, phase.baselineEnd]), ...milestones.map((item) => item.dueDate)]);
  if (!start || !end || end < start) return null;

  const days = daysBetween(start, end) + 1;
  const column = (day: string) => daysBetween(start, day) + 1;
  const span = (from: string, to: string) => `${column(from)} / ${column(to) + 1}`;
  const ticks = [start, ...monthStarts(start, end)].filter((day, index, all) => index === 0 ? all.length === 1 || daysBetween(day, all[1]) >= 7 : true);
  const showToday = today >= start && today <= end;
  const style = { "--days": days, "--today": showToday ? (daysBetween(start, today) + 0.5) / days : 0 } as CSSProperties;

  return (
    <div className="wsTimeline" style={style}>
      <div aria-hidden="true" className="wsTimelineScale">
        <span />
        <div className="wsTimelineTrack">
          {ticks.map((day) => (
            <span className="wsTimelineTick" key={day} style={{ gridColumn: `${column(day)} / span 1` }}>
              {day.endsWith("-01") ? monthLabel.format(Date.parse(`${day}T00:00:00Z`)) : formatShortDay(day)}
            </span>
          ))}
        </div>
      </div>
      <ol aria-label="Phases" className="wsTimelineRows">
        {phases.map((phase) => (
          <li className="wsTimelineRow" key={phase.id}>
            <span className="wsTimelineLabel">
              <strong>{phase.name}</strong>
              <small>{formatShortDay(phase.plannedStart)} – {formatShortDay(phase.plannedEnd)}</small>
            </span>
            <div className="wsTimelineTrack">
              <span aria-hidden="true" className="wsTimelineBar" style={{ gridColumn: span(phase.plannedStart, phase.plannedEnd) }} />
              {phase.baselineStart && phase.baselineEnd && (
                <span aria-hidden="true" className="wsTimelineBaseline" data-testid="phase-baseline" style={{ gridColumn: span(phase.baselineStart, phase.baselineEnd) }} />
              )}
              {milestones.filter((item) => item.phaseId === phase.id).map((item) => (
                <span
                  aria-label={`Milestone ${item.name}, due ${formatDay(item.dueDate)}`}
                  className="wsTimelineMilestone"
                  data-done={item.completedAt ? true : undefined}
                  key={item.id}
                  role="img"
                  style={{ gridColumn: `${column(item.dueDate)} / span 1` }}
                />
              ))}
            </div>
          </li>
        ))}
      </ol>
      {showToday && <span aria-hidden="true" className="wsTimelineToday"><span>Today</span></span>}
    </div>
  );
}
