"use client";

import { useState, type CSSProperties } from "react";

import { initials } from "../../../../../components";
import { ChartCard, ChartLegend, InlineBar, ScatterPlot, TargetGauge, VIZ, formatCount, scatterTable, type ScatterSeries } from "../../../../../_ui/viz";
import { ageBand, ageBandLabel, daysText, insightPaths, type AgeBand, type AgingInsights, type CycleTimeInsights } from "../../../../_lib/insights";
import { categoryLabel } from "../../../../_lib/planning";
import { GroupHeading, useInsight, type InsightQuery } from "../../../../_components/insights/shared";

const BAND_COLORS: Record<AgeBand, string> = { under: "#047857", between: "#b45309", over: "#dc2626", none: "#64748b" };
const CYCLE_COLOR = VIZ.blue;
const LEAD_COLOR = VIZ.orange;
const P50_COLOR = "#475569";
const P85_COLOR = VIZ.violet;

/** Kanban: column load against WIP limits, how old the work in progress is, and cycle and lead times. */
export function KanbanSection({ projectId, days }: { projectId: string; days: number }) {
  const aging = useInsight<AgingInsights>(insightPaths.agingWip(projectId));
  const cycle = useInsight<CycleTimeInsights>(insightPaths.cycleTime(projectId, days));
  return (
    <section aria-labelledby="insights-kanban" className="wsInsightsGroup">
      <GroupHeading id="insights-kanban" note="Limit work in progress, finish what is started, and keep items moving." title="Work in progress" />
      <div className="wsInsightsGrid">
        <WipCard aging={aging} />
        <AgingCard aging={aging} />
        <CycleCard cycle={cycle} days={days} />
      </div>
    </section>
  );
}

function WipCard({ aging }: { aging: InsightQuery<AgingInsights> }) {
  const columns = (aging.data?.columns ?? []).filter((column) => column.category !== "done");
  return (
    <ChartCard
      className="wsInsightsWide"
      empty={Boolean(aging.data) && columns.length === 0}
      emptyText="This board has no open columns."
      error={aging.error}
      height={150}
      loading={aging.loading}
      onRetry={aging.reload}
      subtitle="Cards in each column now; columns without a limit show the count only"
      table={{ columns: ["Column", "Category", "Cards", "WIP limit"], rows: columns.map((column) => [column.name, categoryLabel(column.category), formatCount(column.count), column.wipLimit === null ? "None" : formatCount(column.wipLimit)]) }}
      title="WIP vs limit"
    >
      <ul className="wsInsightsWip">
        {columns.map((column) => (
          <li key={column.statusId}>
            <p className="wsInsightsWipName">{column.name}</p>
            {column.wipLimit === null ? (
              <div className="wsInsightsWipCount">
                <strong>{formatCount(column.count)}</strong>
                <span>No limit</span>
              </div>
            ) : (
              <TargetGauge label={column.name} target={column.wipLimit} value={column.count} />
            )}
          </li>
        ))}
      </ul>
    </ChartCard>
  );
}

function AgingCard({ aging }: { aging: InsightQuery<AgingInsights> }) {
  const data = aging.data;
  const items = data?.items ?? [];
  const reference = data?.cycle ?? { p50: null, p85: null };
  const max = Math.max(1, ...items.map((item) => item.ageDays), reference.p85 ?? 0);
  const bands: AgeBand[] = reference.p50 === null ? ["none"] : ["under", "between", "over"];
  const bandNote: Record<AgeBand, string> = {
    under: `≤ ${daysText(reference.p50)}`,
    between: `≤ ${daysText(reference.p85)}`,
    over: `> ${daysText(reference.p85)}`,
    none: "no finished work in 90 days",
  };
  return (
    <ChartCard
      className="wsInsightsWide"
      empty={Boolean(data) && items.length === 0}
      emptyText="Nothing is in progress right now."
      error={aging.error}
      height={140}
      legend={<ChartLegend series={bands.map((band) => ({ label: `${ageBandLabel(band)} · ${bandNote[band]}`, color: BAND_COLORS[band] }))} />}
      loading={aging.loading}
      onRetry={aging.reload}
      subtitle="Oldest first, against the last 90 days' cycle time (p50 / p85)"
      table={{ columns: ["Item", "Status", "Assignee", "Age", "Band"], rows: items.map((item) => [`${item.key} ${item.title}`, item.statusName, item.assignee?.displayName ?? "Unassigned", daysText(item.ageDays), ageBandLabel(ageBand(item.ageDays, reference))]) }}
      title="Aging work in progress"
    >
      <ol className="wsInsightsAging">
        {items.map((item) => {
          const band = ageBand(item.ageDays, reference);
          return (
            <li key={item.issueId}>
              <span className="wsInsightsAgingMain">
                <span className="wsKeyTag">{item.key}</span>
                <span className="wsInsightsListTitle">{item.title}</span>
              </span>
              <span className="wsInsightsAgingMeta">
                <span className="wsInsightsMuted">{item.statusName}</span>
                {item.assignee && <span aria-label={item.assignee.displayName} className="avatar tiny" role="img" title={item.assignee.displayName}>{initials(item.assignee.displayName, "?")}</span>}
                <strong>{daysText(item.ageDays)}</strong>
                <span className="wsInsightsBand" data-band={band}>{ageBandLabel(band)}</span>
              </span>
              <span className="wsInsightsAgingTrack" style={{ "--insights-p50": `${((reference.p50 ?? 0) / max) * 100}%`, "--insights-p85": `${((reference.p85 ?? 0) / max) * 100}%` } as CSSProperties}>
                <InlineBar color={BAND_COLORS[band]} ratio={item.ageDays / max} wide />
              </span>
            </li>
          );
        })}
      </ol>
    </ChartCard>
  );
}

function CycleCard({ cycle, days }: { cycle: InsightQuery<CycleTimeInsights>; days: number }) {
  const [measure, setMeasure] = useState<"cycle" | "lead">("cycle");
  const data = cycle.data;
  const isCycle = measure === "cycle";
  const series: ScatterSeries[] = [{
    key: measure,
    label: isCycle ? "Cycle time" : "Lead time",
    color: isCycle ? CYCLE_COLOR : LEAD_COLOR,
    points: (data?.points ?? []).flatMap((point) => {
      const value = isCycle ? point.cycleDays : point.leadDays;
      return value === null ? [] : [{ x: Date.parse(point.completedAt), y: value, label: point.key }];
    }),
  }];
  const percentiles = data ? (isCycle ? data.cycle : data.lead) : { p50: null, p85: null };
  const references = [
    ...(percentiles.p50 === null ? [] : [{ y: percentiles.p50, label: `p50 ${daysText(percentiles.p50)}`, color: P50_COLOR }]),
    ...(percentiles.p85 === null ? [] : [{ y: percentiles.p85, label: `p85 ${daysText(percentiles.p85)}`, color: P85_COLOR }]),
  ];
  return (
    <ChartCard
      actions={(
        <div aria-label="Measure" className="wsInsightsSegment" role="group">
          <button aria-pressed={isCycle} onClick={() => setMeasure("cycle")} type="button">Cycle</button>
          <button aria-pressed={!isCycle} onClick={() => setMeasure("lead")} type="button">Lead</button>
        </div>
      )}
      className="wsInsightsWide"
      empty={Boolean(data) && series[0]!.points.length === 0}
      emptyText={`No work finished in the last ${days} days.`}
      error={cycle.error}
      legend={<ChartLegend series={[...series, ...references.map((reference) => ({ label: reference.label, color: reference.color }))]} />}
      loading={cycle.loading}
      onRetry={cycle.reload}
      subtitle={`${isCycle ? "Started to finished" : "Created to finished"}, in days, per item finished in the last ${days} days${data?.truncated ? " (the 500 most recent)" : ""}`}
      table={scatterTable(series, { yFormat: daysText, itemLabel: "Task", xLabel: "Finished" })}
      title="Cycle and lead time"
    >
      <ScatterPlot references={references} series={series} yFormat={(value) => `${Number(value.toFixed(1))} d`} />
    </ChartCard>
  );
}
