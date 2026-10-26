import type { CSSProperties } from "react";

import { phaseVariance, varianceDescription, varianceLabel, varianceTone, type PhaseProgress } from "../../../_lib/planning";
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

/** "2/5 done", "No tasks". */
export function progressLabel(progress: PhaseProgress): string {
  return progress.total === 0 ? "No tasks" : `${progress.done}/${progress.total} done`;
}

/**
 * A compact Gantt view: one row per phase on a day grid, the baseline as a ghost bar under the plan,
 * milestone diamonds on their due day and a marker for today when it falls inside the range.
 *
 * With `detailed` (the Timeline tab) the grid runs from the project start to its target: each planned bar
 * fills with its share of done tasks once `progress` is known (no fill while it isn't), each phase carries a variance badge ("no baseline" for a phase added
 * after the last re-baseline), overdue milestones are marked, milestones without a phase get their own row,
 * and anything outside the project dates (a milestone from another methodology period) sits at the edge.
 */
export function PhaseTimeline({ phases, milestones, startDate, targetDate, today, detailed = false, progress = null }: {
  phases: ProjectPhase[];
  milestones: ProjectMilestone[];
  startDate: string | null;
  targetDate: string | null;
  today: string;
  detailed?: boolean;
  /** Done and total tasks per phase; null while unknown (loading or failed). */
  progress?: ReadonlyMap<string, PhaseProgress> | null;
}) {
  const fixed = detailed && Boolean(startDate && targetDate) && (targetDate ?? "") >= (startDate ?? "");
  const start = fixed ? startDate ?? "" : earliest([startDate, ...phases.flatMap((phase) => [phase.plannedStart, phase.baselineStart]), ...milestones.map((item) => item.dueDate)]);
  const end = fixed ? targetDate ?? "" : latest([targetDate, ...phases.flatMap((phase) => [phase.plannedEnd, phase.baselineEnd]), ...milestones.map((item) => item.dueDate)]);
  if (!start || !end || end < start) return null;

  const days = daysBetween(start, end) + 1;
  const column = (day: string) => Math.min(days, Math.max(1, daysBetween(start, day) + 1));
  const span = (from: string, to: string) => `${column(from)} / ${column(to) + 1}`;
  const ticks = [start, ...monthStarts(start, end)].filter((day, index, all) => index === 0 ? all.length === 1 || daysBetween(day, all[1]) >= 7 : true);
  const showToday = today >= start && today <= end;
  const style = { "--days": days, "--today": showToday ? (daysBetween(start, today) + 0.5) / days : 0 } as CSSProperties;
  const phaseIds = new Set(phases.map((phase) => phase.id));
  const loose = detailed ? milestones.filter((item) => !item.phaseId || !phaseIds.has(item.phaseId)) : [];

  const diamond = (item: ProjectMilestone) => {
    const done = Boolean(item.completedAt);
    const overdue = detailed && !done && item.dueDate < today;
    const edge = item.dueDate < start ? "start" : item.dueDate > end ? "end" : undefined;
    let label = `Milestone ${item.name}, due ${formatDay(item.dueDate)}`;
    if (detailed && done) label += ", completed";
    if (overdue) label += ", overdue";
    if (detailed && edge) label += ", outside the project dates";
    return (
      <span
        aria-label={label}
        className="wsTimelineMilestone"
        data-done={done || undefined}
        data-edge={detailed ? edge : undefined}
        data-overdue={overdue || undefined}
        key={item.id}
        role="img"
        style={{ gridColumn: `${column(item.dueDate)} / span 1` }}
      />
    );
  };

  return (
    <div className="wsTimeline" data-detailed={detailed || undefined} style={style}>
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
        {phases.map((phase) => {
          const counts = progress?.get(phase.id);
          const share = counts && counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0;
          const variance = phaseVariance(phase);
          return (
            <li className="wsTimelineRow" data-phase-id={phase.id} key={phase.id}>
              <span className="wsTimelineLabel">
                <span className="wsTimelineName">
                  <strong>{phase.name}</strong>
                  {detailed && (
                    <span className="wsTimelineVariance" data-tone={varianceTone(variance)} title={varianceDescription(variance)}>
                      <span aria-hidden="true">{varianceLabel(variance)}</span>
                      <span className="wsSrOnly">{varianceDescription(variance)}</span>
                    </span>
                  )}
                </span>
                <small>
                  {formatShortDay(phase.plannedStart)} – {formatShortDay(phase.plannedEnd)}
                  {counts && ` · ${progressLabel(counts)}`}
                </small>
              </span>
              <div className="wsTimelineTrack">
                <span aria-hidden="true" className="wsTimelineBar" data-progress={detailed || undefined} data-testid="phase-bar" style={{ gridColumn: span(phase.plannedStart, phase.plannedEnd) }}>
                  {detailed && counts && <span className="wsTimelineFill" data-testid="phase-fill" style={{ width: `${share}%` }} />}
                </span>
                {phase.baselineStart && phase.baselineEnd && (
                  <span aria-hidden="true" className="wsTimelineBaseline" data-testid="phase-baseline" style={{ gridColumn: span(phase.baselineStart, phase.baselineEnd) }} />
                )}
                {milestones.filter((item) => item.phaseId === phase.id).map(diamond)}
              </div>
            </li>
          );
        })}
        {loose.length > 0 && (
          <li className="wsTimelineRow" data-loose>
            <span className="wsTimelineLabel">
              <strong>Other milestones</strong>
              <small>Not tied to a phase</small>
            </span>
            <div className="wsTimelineTrack">{loose.map(diamond)}</div>
          </li>
        )}
      </ol>
      {showToday && <span aria-hidden="true" className="wsTimelineToday"><span>Today</span></span>}
    </div>
  );
}
