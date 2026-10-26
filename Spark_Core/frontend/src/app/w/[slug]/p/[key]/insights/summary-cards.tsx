"use client";

import Link from "next/link";
import type { CSSProperties } from "react";

import { initials } from "../../../../../components";
import { ChartCard, ChartLegend, VIZ, formatCount } from "../../../../../_ui/viz";
import { percentText, unitLabel, type InsightSummary } from "../../../../_lib/insights";
import { formatDay, formatShortDay } from "../../../../_lib/projects";
import { StatusPill, type InsightQuery as Query } from "./shared";

const PLAN_COLOR = VIZ.orange;
const DONE_COLOR = VIZ.blue;

/** Done %, plan %, status, forecast and overdue count, from the summary. */
export function KpiStrip({ summary }: { summary: Query<InsightSummary> }) {
  if (summary.error) {
    return (
      <div className="vizError wsInsightsKpiError" role="alert">
        <span>{summary.error}</span>
        <button className="vizBtn vizBtnSecondary vizBtnSm" onClick={summary.reload} type="button">Retry</button>
      </div>
    );
  }
  const data = summary.data;
  if (!data) {
    return (
      <div aria-busy="true" className="wsInsightsKpis" role="status">
        <span className="wsSrOnly">Loading key numbers…</span>
        {Array.from({ length: 5 }, (_, index) => <span className="vizSkeleton wsInsightsKpiSkeleton" key={index} />)}
      </div>
    );
  }
  const { plan, forecast } = data;
  const unit = unitLabel(data.unit);
  return (
    <ul aria-label="Key numbers" className="wsInsightsKpis">
      <li>
        <span className="wsInsightsKpiLabel">Done</span>
        <strong>{percentText(data.donePercent)}</strong>
        <span className="wsInsightsKpiNote">{formatCount(data.done)} of {formatCount(data.total)} {unit}</span>
      </li>
      <li>
        <span className="wsInsightsKpiLabel">Plan</span>
        <strong>{percentText(plan.planPercent)}</strong>
        <span className="wsInsightsKpiNote">{plan.label ?? "No plan window"}</span>
      </li>
      <li>
        <span className="wsInsightsKpiLabel">Status</span>
        <StatusPill status={plan.status} />
        <span className="wsInsightsKpiNote">{plan.start && plan.end ? `${formatShortDay(plan.start)} – ${formatShortDay(plan.end)}` : "Set dates to track a plan"}</span>
      </li>
      <li>
        <span className="wsInsightsKpiLabel">Forecast</span>
        <strong className={forecast.date ? undefined : "wsInsightsKpiQuiet"}>{forecast.date ? formatDay(forecast.date) : "No forecast yet"}</strong>
        <span className="wsInsightsKpiNote">{forecast.ratePerDay > 0 ? `${Number(forecast.ratePerDay.toFixed(2))} ${unit} a day (last 14 days)` : "Nothing finished in the last 14 days"}</span>
      </li>
      <li>
        <span className="wsInsightsKpiLabel">Overdue</span>
        <strong data-alert={data.overdue.count > 0 || undefined}>{formatCount(data.overdue.count)}</strong>
        <span className="wsInsightsKpiNote">open past their due date</span>
      </li>
    </ul>
  );
}

/** One bar: how much is done, with a tick where the plan says it should be by today. */
export function PlanVsDone({ summary }: { summary: Query<InsightSummary> }) {
  const data = summary.data;
  const planPercent = data?.plan.planPercent ?? null;
  const series = [
    { label: "Done", color: DONE_COLOR, value: data ? percentText(data.donePercent) : undefined },
    ...(planPercent === null ? [] : [{ label: "Plan by today", color: PLAN_COLOR, value: percentText(planPercent) }]),
  ];
  return (
    <ChartCard
      className="wsInsightsWide"
      error={summary.error}
      height={56}
      legend={<ChartLegend series={series} />}
      loading={summary.loading}
      onRetry={summary.reload}
      subtitle={data ? `${formatCount(data.done)} of ${formatCount(data.total)} ${unitLabel(data.unit)} done${data.plan.label ? ` · ${data.plan.label}` : ""}` : undefined}
      table={data ? { columns: ["Measure", "Percent"], rows: [["Done", percentText(data.donePercent)], ["Plan by today", percentText(planPercent)]] } : undefined}
      title="Plan vs done"
    >
      {data && (
        <div className="wsInsightsPlanBar">
          <div aria-label="Done" aria-valuemax={100} aria-valuemin={0} aria-valuenow={Math.round(data.donePercent)} aria-valuetext={`${percentText(data.donePercent)} done`} className="wsInsightsPlanTrack" role="meter">
            <span className="wsInsightsPlanFill" style={{ "--insights-w": `${Math.min(100, Math.max(0, data.donePercent))}%`, background: DONE_COLOR } as CSSProperties} />
            {planPercent !== null && (
              <span aria-hidden="true" className="wsInsightsPlanTick" style={{ "--insights-x": `${Math.min(100, Math.max(0, planPercent))}%`, background: PLAN_COLOR } as CSSProperties} />
            )}
          </div>
          {planPercent === null && <p className="wsInsightsMuted">No plan window: set the project&apos;s dates (or start a sprint) to compare progress with the plan.</p>}
        </div>
      )}
    </ChartCard>
  );
}

/** Open work past its due date, oldest first; each row opens the task drawer on the board. */
export function OverdueCard({ summary, boardHref }: { summary: Query<InsightSummary>; boardHref: string }) {
  const data = summary.data;
  const items = data?.overdue.items ?? [];
  return (
    <ChartCard
      emptyText="Nothing is overdue."
      empty={Boolean(data) && items.length === 0}
      error={summary.error}
      height={120}
      loading={summary.loading}
      onRetry={summary.reload}
      subtitle={data && data.overdue.count > items.length ? `The ${items.length} oldest of ${formatCount(data.overdue.count)}` : "Open work past its due date"}
      title="Overdue work"
    >
      <ul className="wsInsightsList">
        {items.map((item) => (
          <li key={item.issueId}>
            <Link className="wsInsightsListLink" href={`${boardHref}?issue=${encodeURIComponent(item.key)}`}>
              <span className="wsKeyTag">{item.key}</span>
              <span className="wsInsightsListTitle">{item.title}</span>
            </Link>
            <span className="wsInsightsListMeta">
              <span className="wsInsightsDue">Due {formatShortDay(item.dueDate)}</span>
              {item.assignee
                ? <span aria-label={item.assignee.displayName} className="avatar tiny" role="img" title={item.assignee.displayName}>{initials(item.assignee.displayName, "?")}</span>
                : <span className="wsInsightsMuted">Unassigned</span>}
            </span>
          </li>
        ))}
      </ul>
    </ChartCard>
  );
}
