"use client";

import Link from "next/link";

import { Bento, Tile } from "../_components/bento";
import { BarList, ChartCard, ChartLegend, TargetGauge, TrendChart, targetStatus } from "../_components/charts";
import { type Read, valueOf } from "../_components/overview-tiles";
import { TrendCards, type TrendCardItem } from "../_components/trend-cards";
import { formatCount, humanize, shortDate } from "../_lib/format";
import { SERIES, VIZ } from "../_lib/palette";
import type { ReportStats } from "../_lib/types";

/** Open reports the team aims to stay under. The gauge is full at twice this and red once it is passed. */
export const REPORT_BACKLOG_TARGET = 10;

const hours = (value: number) => `${value.toFixed(1)} h`;

type Rows = Array<Record<string, unknown>>;

/**
 * The report stats read has no earlier period to compare with, so the cards carry no change chips; each
 * sparkline is the read's own daily series (median time only over the days on which reports were closed).
 */
function reportTrendCards(stats: Read<ReportStats>): TrendCardItem[] {
  const series = stats.data?.series ?? [];
  const backlog = stats.data?.backlog ?? 0;
  return [
    {
      label: "Open now",
      value: valueOf(stats, (data) => formatCount(data.backlog)),
      dot: SERIES.reportBacklog.color,
      color: SERIES.reportBacklog.color,
      series: series.map((point) => point.backlog),
      valueTone: backlog > REPORT_BACKLOG_TARGET ? "bad" : "default",
    },
    {
      label: "Opened",
      value: valueOf(stats, (data) => formatCount(data.opened)),
      dot: SERIES.reportsOpened.color,
      color: SERIES.reportsOpened.color,
      series: series.map((point) => point.opened),
    },
    {
      label: "Closed",
      value: valueOf(stats, (data) => formatCount(data.closed)),
      dot: SERIES.reportsClosed.color,
      color: SERIES.reportsClosed.color,
      series: series.map((point) => point.closed),
    },
    {
      label: "Median time to decision",
      value: valueOf(stats, (data) => (data.medianHoursToClose === null ? "–" : hours(data.medianHoursToClose))),
      dot: VIZ.blue,
      color: VIZ.blue,
      series: series.flatMap((point) => (point.medianHoursToClose === null ? [] : [point.medianHoursToClose])),
    },
  ];
}

/** Queue numbers and charts above the triage desk, all from `/admin/reports/stats` over the last `days`. */
export function ReportInsights({ stats, days }: { stats: Read<ReportStats>; days: number }) {
  const data = stats.data;
  const loading = stats.loading && !data;
  const series = data?.series ?? [];
  const reasons = data?.reasons ?? [];
  const communities = data?.topCommunities ?? [];
  const backlog = data?.backlog ?? 0;
  const status = targetStatus(backlog, REPORT_BACKLOG_TARGET);
  const quiet = data !== null && series.every((point) => point.opened === 0 && point.closed === 0);
  const tileState = { error: stats.error, loading, onRetry: stats.reload };

  return (
    <>
      <TrendCards items={reportTrendCards(stats)} label="Report numbers" />
      <Bento label="Report charts">
        <Tile span={4}>
          <ChartCard
            {...tileState}
            height={150}
            subtitle={`Open reports against a target of ${REPORT_BACKLOG_TARGET}`}
            table={{ columns: ["Measure", "Value"], rows: [["Open now", backlog], ["Target", REPORT_BACKLOG_TARGET], ["Status", status.text]] }}
            title="Backlog"
          >
            <TargetGauge label="Open reports" target={REPORT_BACKLOG_TARGET} value={backlog} />
          </ChartCard>
        </Tile>
        <Tile span={8}>
          <ChartCard
            {...tileState}
            empty={quiet}
            emptyText="No reports opened or closed in this period yet."
            height={200}
            legend={<ChartLegend series={[SERIES.reportsOpened, SERIES.reportsClosed]} />}
            subtitle={`Reports filed and closed each day · last ${days} days (UTC)`}
            table={{ columns: ["Day", "Opened", "Closed", "Open at day end"], rows: series.map((point) => [shortDate(point.day), point.opened, point.closed, point.backlog]) }}
            title="Opened vs closed"
          >
            <TrendChart data={series as unknown as Rows} height={200} kind="bar" series={[{ key: "opened", ...SERIES.reportsOpened }, { key: "closed", ...SERIES.reportsClosed }]} />
          </ChartCard>
        </Tile>
        <Tile span={6}>
          <ChartCard
            {...tileState}
            empty={data !== null && reasons.length === 0}
            emptyText="No open reports."
            height={120}
            subtitle="Every open report, by the reason given"
            table={{ columns: ["Reason", "Open reports"], rows: reasons.map((row) => [humanize(row.reason), row.count]) }}
            title="Reports by reason"
          >
            <BarList color={VIZ.violet} items={reasons.map((row) => ({ key: row.reason, label: humanize(row.reason), value: row.count }))} />
          </ChartCard>
        </Tile>
        <Tile span={6}>
          <ChartCard
            {...tileState}
            empty={data !== null && communities.length === 0}
            emptyText="No community has open reports."
            height={120}
            subtitle="The five communities with the most open reports"
            table={{ columns: ["Community", "Open reports"], rows: communities.map((row) => [row.name, row.count]) }}
            title="Most reported communities"
          >
            <BarList color={VIZ.orange} items={communities.map((row) => ({ key: row.id, label: <Link href={`/admin/communities/${row.id}`}>{row.name}</Link>, value: row.count }))} />
          </ChartCard>
        </Tile>
      </Bento>
    </>
  );
}
