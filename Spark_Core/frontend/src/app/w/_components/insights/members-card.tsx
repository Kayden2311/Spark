"use client";

import { initials } from "../../../components";
import { ChartCard, InlineBar, VIZ, formatCount } from "../../../_ui/viz";
import { daysText, percentText, type MemberStat } from "../../_lib/insights";
import type { InsightQuery } from "./shared";

/** Per current assignee: finished in range, points, on-time rate, open, overdue and median cycle time. Unassigned last. */
export function MembersCard({ members }: { members: InsightQuery<{ items: MemberStat[] }> }) {
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
                  <td className="vizNum">
                    <span className="wsInsightsOnTime">
                      {item.onTimeRate !== null && <InlineBar color={VIZ.aqua} ratio={item.onTimeRate / 100} />}
                      {percentText(item.onTimeRate)}
                    </span>
                  </td>
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
