"use client";

import { initials } from "../../../../../components";
import { ChartCard, ChartLegend, TrendChart, VIZ, formatCount, shortDate, type ChartSeries } from "../../../../../_ui/viz";
import { daysText, markerLabel, percentText, type FlowInsights, type MemberInsights } from "../../../../_lib/insights";
import type { InsightQuery } from "./shared";

/** Work items by status category, done at the bottom as a cumulative flow diagram reads. */
const CFD_SERIES: ChartSeries[] = [
  { key: "done", label: "Done", color: VIZ.aqua },
  { key: "inProgress", label: "In progress", color: VIZ.blue },
  { key: "todo", label: "To do", color: VIZ.yellow },
  { key: "backlog", label: "Backlog", color: VIZ.violet },
];
const THROUGHPUT_SERIES: ChartSeries[] = [{ key: "completed", label: "Completed", color: VIZ.aqua }];

/** The cumulative flow and the daily throughput, both with the methodology switches in the range. */
export function FlowCards({ flow, days }: { flow: InsightQuery<FlowInsights>; days: number }) {
  const data = flow.data;
  const rows = data?.days ?? [];
  const markers = (data?.markers ?? []).map((marker) => ({ day: marker.at.slice(0, 10), label: markerLabel(marker) }));
  const switches = markers.length > 0 ? ` · ${markers.map((marker) => marker.label).join(" · ")}` : "";
  const empty = Boolean(data) && rows.every((row) => row.backlog + row.todo + row.inProgress + row.done === 0);
  const throughputEmpty = Boolean(data) && rows.every((row) => row.completed === 0);
  const total = rows.reduce((sum, row) => sum + row.completed, 0);
  return (
    <>
      <ChartCard
        className="wsInsightsWide"
        empty={empty}
        emptyText="No work items in this range yet."
        error={flow.error}
        legend={<ChartLegend series={CFD_SERIES} />}
        loading={flow.loading}
        onRetry={flow.reload}
        subtitle={`Work items by category at the end of each day, last ${days} days${switches}`}
        table={{
          columns: ["Day", ...CFD_SERIES.map((item) => item.label)],
          rows: rows.map((row) => [shortDate(row.day), formatCount(row.done), formatCount(row.inProgress), formatCount(row.todo), formatCount(row.backlog)]),
        }}
        title="Cumulative flow"
      >
        <TrendChart data={rows as unknown as Array<Record<string, unknown>>} markers={markers} series={CFD_SERIES} stacked />
      </ChartCard>
      <ChartCard
        className="wsInsightsWide"
        empty={throughputEmpty}
        emptyText="Nothing was finished in this range."
        error={flow.error}
        height={220}
        legend={<ChartLegend series={[{ ...THROUGHPUT_SERIES[0]!, value: formatCount(total) }]} />}
        loading={flow.loading}
        onRetry={flow.reload}
        subtitle="Work items finished per day (reopened and finished again counts again)"
        table={{ columns: ["Day", "Completed", "Points"], rows: rows.map((row) => [shortDate(row.day), formatCount(row.completed), formatCount(row.completedPoints)]) }}
        title="Throughput"
      >
        <TrendChart data={rows as unknown as Array<Record<string, unknown>>} height={220} kind="bar" markers={markers} series={THROUGHPUT_SERIES} />
      </ChartCard>
    </>
  );
}

/** Per current assignee: finished in range, points, on-time rate, open, overdue and median cycle time. Unassigned last. */
export function MembersCard({ members }: { members: InsightQuery<MemberInsights> }) {
  const items = [...(members.data?.items ?? [])].sort((a, b) => Number(a.user === null) - Number(b.user === null));
  return (
    <ChartCard
      className="wsInsightsWide"
      empty={Boolean(members.data) && items.length === 0}
      emptyText="No assigned or unassigned work yet."
      error={members.error}
      height={120}
      loading={members.loading}
      onRetry={members.reload}
      subtitle="Grouped by current assignee; completed counts the selected range"
      title="Members"
    >
      <div className="vizChartTableWrap wsInsightsTableWrap">
        <table className="vizChartTable wsInsightsTable">
          <caption className="vizSrOnly">Members</caption>
          <thead>
            <tr>
              <th scope="col">Member</th>
              <th className="vizNum" scope="col">Completed</th>
              <th className="vizNum" scope="col">Points</th>
              <th className="vizNum" scope="col">On time</th>
              <th className="vizNum" scope="col">Open</th>
              <th className="vizNum" scope="col">Overdue</th>
              <th className="vizNum" scope="col">Median cycle</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const name = item.user?.displayName ?? "Unassigned";
              return (
                <tr key={item.user?.id ?? "unassigned"}>
                  <th scope="row">
                    <span className="wsInsightsPerson">
                      <span aria-hidden="true" className="avatar tiny" data-unassigned={item.user === null || undefined}>{item.user ? initials(name, "?") : "–"}</span>
                      <span>{name}</span>
                    </span>
                  </th>
                  <td className="vizNum">{formatCount(item.completed)}</td>
                  <td className="vizNum">{formatCount(item.completedPoints)}</td>
                  <td className="vizNum">{percentText(item.onTimeRate)}</td>
                  <td className="vizNum">{formatCount(item.open)}</td>
                  <td className="vizNum" data-alert={item.overdue > 0 || undefined}>{formatCount(item.overdue)}</td>
                  <td className="vizNum">{daysText(item.medianCycleDays)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}
