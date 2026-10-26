"use client";

import { ChartCard, ChartLegend, GroupedBars, VIZ, type ChartSeries } from "../../../../../_ui/viz";
import { insightPaths, milestoneStateLabel, percentText, planStatusLabel, type ScheduleInsights } from "../../../../_lib/insights";
import { varianceDescription, varianceLabel, varianceTone } from "../../../../_lib/planning";
import { formatShortDay } from "../../../../_lib/projects";
import { GroupHeading, StatusPill, useInsight, type InsightQuery } from "../../../../_components/insights/shared";

const PHASE_SERIES: ChartSeries[] = [
  { key: "done", label: "Done", color: VIZ.blue },
  { key: "plan", label: "Plan by today", color: VIZ.orange },
];
const percentFormat = (value: number) => `${Number(value.toFixed(1))}%`;

function VarianceBadge({ days }: { days: number | null }) {
  return <span className="wsTimelineVariance" data-tone={varianceTone(days)} title={varianceDescription(days)}>{varianceLabel(days)}</span>;
}

/** Appended to the subtitles when a past period is selected: phases and milestones are always read as they are now. */
const CURRENT_PLAN = " · Current plan";

/** Waterfall: progress per phase against its plan, milestone outcomes and the schedule variance. */
export function WaterfallSection({ projectId, periodId, pastPeriod = false }: { projectId: string; periodId: string | null; pastPeriod?: boolean }) {
  const schedule = useInsight<ScheduleInsights>(insightPaths.schedule(projectId, periodId));
  const note = pastPeriod ? CURRENT_PLAN : "";
  return (
    <section aria-labelledby="insights-waterfall" className="wsInsightsGroup">
      <GroupHeading id="insights-waterfall" note="Phases against their planned windows and the baseline." title="Schedule" />
      <div className="wsInsightsGrid">
        <VarianceCard note={note} schedule={schedule} />
        <PhaseCard note={note} schedule={schedule} />
        <MilestoneCard note={note} schedule={schedule} />
      </div>
    </section>
  );
}

function VarianceCard({ schedule, note }: { schedule: InsightQuery<ScheduleInsights>; note: string }) {
  const data = schedule.data;
  const days = data?.scheduleVarianceDays ?? null;
  return (
    <ChartCard
      className="wsInsightsWide"
      empty={Boolean(data) && data!.phases.length === 0}
      emptyText="Plan phases on the Timeline to track the schedule."
      error={schedule.error}
      height={72}
      loading={schedule.loading}
      onRetry={schedule.reload}
      subtitle={`The latest planned phase end against the latest baseline end${note}`}
      title="Schedule variance"
    >
      <div className="wsInsightsVariance">
        <strong data-tone={varianceTone(days)}>{varianceLabel(days)}</strong>
        <span>{varianceDescription(days)}</span>
      </div>
    </ChartCard>
  );
}

function PhaseCard({ schedule, note }: { schedule: InsightQuery<ScheduleInsights>; note: string }) {
  const phases = schedule.data?.phases ?? [];
  const rows = phases.map((phase) => ({ label: phase.name, done: phase.donePercent, plan: phase.planPercent }));
  return (
    <ChartCard
      className="wsInsightsWide"
      empty={Boolean(schedule.data) && phases.length === 0}
      emptyText="No phases planned yet."
      error={schedule.error}
      legend={<ChartLegend series={PHASE_SERIES} />}
      loading={schedule.loading}
      onRetry={schedule.reload}
      subtitle={`Share done vs the share of each phase's window already elapsed${note}`}
      table={{
        columns: ["Phase", "Done", "Plan by today", "Variance", "Status"],
        rows: phases.map((phase) => [phase.name, percentText(phase.donePercent), percentText(phase.planPercent), varianceDescription(phase.varianceDays), planStatusLabel(phase.status)]),
      }}
      title="Phase progress"
    >
      <GroupedBars data={rows} series={PHASE_SERIES} valueFormat={percentFormat} />
      <ol className="wsInsightsPhases">
        {phases.map((phase) => (
          <li key={phase.id}>
            <span className="wsInsightsPhaseName">
              {phase.name}
              <small>{formatShortDay(phase.plannedStart)} – {formatShortDay(phase.plannedEnd)} · {percentText(phase.donePercent)} done</small>
            </span>
            <VarianceBadge days={phase.varianceDays} />
            <StatusPill status={phase.status} />
          </li>
        ))}
      </ol>
    </ChartCard>
  );
}

function MilestoneCard({ schedule, note }: { schedule: InsightQuery<ScheduleInsights>; note: string }) {
  const data = schedule.data;
  const milestones = data?.milestones ?? [];
  const phaseName = new Map((data?.phases ?? []).map((phase) => [phase.id, phase.name]));
  const counts = data?.counts;
  return (
    <ChartCard
      className="wsInsightsWide"
      empty={Boolean(data) && milestones.length === 0}
      emptyText="No milestones yet."
      error={schedule.error}
      height={120}
      loading={schedule.loading}
      onRetry={schedule.reload}
      subtitle={counts ? `${counts.hit} hit · ${counts.missed} missed · ${counts.atRisk} at risk · ${counts.upcoming} upcoming${note}` : undefined}
      title="Milestones"
    >
      <div className="vizChartTableWrap wsInsightsTableWrap">
        <table className="vizChartTable wsInsightsTable">
          <caption className="vizSrOnly">Milestones and their state</caption>
          <thead>
            <tr>
              <th scope="col">Milestone</th>
              <th scope="col">Due</th>
              <th scope="col">Baseline</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {milestones.map((milestone) => (
              <tr key={milestone.id}>
                <th scope="row">
                  <span className="wsInsightsCellStack">
                    <span>{milestone.name}</span>
                    {milestone.phaseId && phaseName.has(milestone.phaseId) && <small>{phaseName.get(milestone.phaseId)}</small>}
                  </span>
                </th>
                <td>{formatShortDay(milestone.dueDate)}</td>
                <td>{milestone.baselineDueDate ? formatShortDay(milestone.baselineDueDate) : "—"}</td>
                <td><span className="wsInsightsState" data-state={milestone.state}>{milestoneStateLabel(milestone.state)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}
