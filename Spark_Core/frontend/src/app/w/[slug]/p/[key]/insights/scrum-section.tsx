"use client";

import { useState } from "react";

import { ChartCard, ChartLegend, GroupedBars, TrendChart, VIZ, formatCount, groupedBarsTable, shortDate, type ChartSeries } from "../../../../../_ui/viz";
import { burndownSprints, insightPaths, percentText, unitLabel, type Burndown, type SprintOutcome, type VelocityInsights } from "../../../../_lib/insights";
import { sprintsPath, type Sprint } from "../../../../_lib/planning";
import { GroupHeading, useInsight, type InsightQuery } from "../../../../_components/insights/shared";

const BURNDOWN_SERIES: ChartSeries[] = [
  { key: "ideal", label: "Ideal", color: VIZ.violet, dashed: true },
  { key: "remaining", label: "Remaining", color: VIZ.blue },
  { key: "scope", label: "Scope", color: VIZ.orange },
];
const VELOCITY_SERIES: ChartSeries[] = [
  { key: "committed", label: "Committed", color: VIZ.blue },
  { key: "completed", label: "Completed", color: VIZ.aqua },
];
const NO_SPRINTS = "No completed sprints in this period yet";

function amount(value: number | null): string {
  return value === null ? "—" : formatCount(value);
}

/** Committed and completed in the velocity's unit (frozen at start and at completion). */
function velocityRow(sprint: SprintOutcome, unit: string) {
  return unit === "points"
    ? { label: sprint.name, committed: sprint.committedPoints, completed: sprint.completedPoints }
    : { label: sprint.name, committed: sprint.committedCount, completed: sprint.completedCount };
}

/**
 * "Sprint 7: 34 points at the start, 3 already done · Oct 22 – Nov 5". The base is the committed work not done
 * when the sprint started (work finished on day 1 stays in it); committed work already done at the start is the
 * difference to the frozen commitment and is named, so the gap between the scope and remaining lines is explained.
 */
export function burndownSubtitle(data: Burndown): string {
  const committed = data.unit === "points" ? data.sprint.committedPoints : data.sprint.committedCount;
  const alreadyDone = committed === null ? 0 : Math.round((committed - data.base) * 10) / 10;
  const done = alreadyDone > 0 ? `, ${formatCount(alreadyDone)} already done` : "";
  const first = data.days[0]?.day ?? "";
  const last = data.days[data.days.length - 1]?.day ?? "";
  return `${data.sprint.name}: ${formatCount(data.base)} ${unitLabel(data.unit)} at the start${done} · ${shortDate(first)} – ${shortDate(last)}`;
}

/** Scrum: the burndown of one sprint (active by default) and the velocity of the period's completed sprints. */
export function ScrumSection({ projectId, periodId }: { projectId: string; periodId: string | null }) {
  const sprints = useInsight<{ items: Sprint[] }>(sprintsPath(projectId));
  const velocity = useInsight<VelocityInsights>(insightPaths.velocity(projectId, periodId));
  return (
    <section aria-labelledby="insights-scrum" className="wsInsightsGroup">
      <GroupHeading id="insights-scrum" note="Sprint progress and how reliably the team delivers what it commits to." title="Sprints" />
      <div className="wsInsightsGrid">
        <BurndownCard sprints={sprints} />
        <VelocityCard velocity={velocity} />
        <ReliabilityCard velocity={velocity} />
      </div>
    </section>
  );
}

function BurndownCard({ sprints }: { sprints: InsightQuery<{ items: Sprint[] }> }) {
  const options = burndownSprints(sprints.data?.items ?? []);
  const [chosen, setChosen] = useState<string | null>(null);
  const selected = options.find((sprint) => sprint.id === chosen) ?? options[0] ?? null;
  const burndown = useInsight<Burndown>(selected ? insightPaths.burndown(selected.id) : null);
  const missingDates = burndown.errorCode === "sprint_missing_dates";
  const data = burndown.data && burndown.data.sprint.id === selected?.id ? burndown.data : null;
  const rows = data?.days ?? [];
  const noSprints = Boolean(sprints.data) && options.length === 0;
  return (
    <ChartCard
      actions={options.length > 0 && (
        <select aria-label="Sprint" className="wsSelect wsInsightsSelect" onChange={(event) => setChosen(event.target.value)} value={selected?.id ?? ""}>
          {options.map((sprint) => <option key={sprint.id} value={sprint.id}>{sprint.status === "active" ? `${sprint.name} (active)` : sprint.name}</option>)}
        </select>
      )}
      className="wsInsightsWide"
      empty={noSprints || missingDates}
      emptyText={missingDates ? burndown.error ?? "Set the sprint's start and end dates to see its burndown." : "No active or completed sprint yet."}
      error={sprints.error ?? (missingDates ? null : burndown.error)}
      legend={<ChartLegend series={BURNDOWN_SERIES} />}
      loading={sprints.loading || (Boolean(selected) && !data && !burndown.error)}
      onRetry={sprints.error ? sprints.reload : burndown.reload}
      subtitle={data ? burndownSubtitle(data) : "Work left in the sprint each day"}
      table={{
        columns: ["Day", "Ideal", "Remaining", "Scope"],
        rows: rows.map((row) => [shortDate(row.day), amount(Number(row.ideal.toFixed(1))), amount(row.remaining), amount(row.scope)]),
      }}
      title="Sprint burndown"
    >
      <TrendChart data={rows as unknown as Array<Record<string, unknown>>} kind="line" series={BURNDOWN_SERIES} />
    </ChartCard>
  );
}

function VelocityCard({ velocity }: { velocity: InsightQuery<VelocityInsights> }) {
  const data = velocity.data;
  const unit = data?.unit ?? "count";
  const rows = (data?.sprints ?? []).map((sprint) => velocityRow(sprint, unit));
  // The API averages completed work in the list's unit.
  const average = rows.length === 0 ? null : (data?.averageVelocity ?? null);
  return (
    <ChartCard
      empty={Boolean(data) && rows.length === 0}
      emptyText={NO_SPRINTS}
      error={velocity.error}
      height={240}
      legend={<ChartLegend series={VELOCITY_SERIES} />}
      loading={velocity.loading}
      onRetry={velocity.reload}
      subtitle={average !== null ? `Average ${formatCount(average)} ${unitLabel(unit)} a sprint · last ${rows.length} completed` : `Committed vs completed ${unitLabel(unit)}, last 6 sprints`}
      table={groupedBarsTable(rows, VELOCITY_SERIES, { xLabel: "Sprint" })}
      title="Velocity"
    >
      <GroupedBars data={rows} series={VELOCITY_SERIES} />
    </ChartCard>
  );
}

function ReliabilityCard({ velocity }: { velocity: InsightQuery<VelocityInsights> }) {
  const data = velocity.data;
  const points = data?.unit === "points";
  const sprints = [...(data?.sprints ?? [])].reverse();
  return (
    <ChartCard
      empty={Boolean(data) && sprints.length === 0}
      emptyText={NO_SPRINTS}
      error={velocity.error}
      height={160}
      loading={velocity.loading}
      onRetry={velocity.reload}
      subtitle="Committed work finished by sprint end; work already done at the start is left out"
      title="Commitment reliability"
    >
      <div className="vizChartTableWrap wsInsightsTableWrap">
        <table className="vizChartTable wsInsightsTable">
          <caption className="vizSrOnly">Commitment reliability and scope change per sprint</caption>
          <thead>
            <tr>
              <th scope="col">Sprint</th>
              <th className="vizNum" scope="col">Reliability</th>
              <th className="vizNum" scope="col">Added</th>
              <th className="vizNum" scope="col">Removed</th>
              <th className="vizNum" scope="col">Creep</th>
            </tr>
          </thead>
          <tbody>
            {sprints.map((sprint) => (
              <tr key={sprint.id}>
                <th scope="row">
                  <span className="wsInsightsCellStack">
                    <span>{sprint.name}</span>
                    {sprint.alreadyDone > 0 && <small>{sprint.alreadyDone} already done at start</small>}
                  </span>
                </th>
                <td className="vizNum">{percentText(sprint.reliability)}</td>
                <td className="vizNum">{sprint.added.count === 0 ? "0" : `+${sprint.added.count}${points ? ` (${formatCount(sprint.added.points)} pts)` : ""}`}</td>
                <td className="vizNum">{formatCount(sprint.removed)}</td>
                <td className="vizNum">{percentText(sprint.creepPercent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}
