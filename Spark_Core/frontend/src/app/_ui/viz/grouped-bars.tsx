"use client";

import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { ChartSeries, TableSpec } from "./charts";
import { formatCount } from "./format";
import { useReducedMotion } from "./motion";
import { CHART_INK } from "./palette";

type Formatter = (value: number) => string;
type Row = Record<string, unknown>;

interface GroupedBarsProps {
  data: Row[];
  /** One bar per series in every category, side by side (never stacked), so the values compare directly. */
  series: ChartSeries[];
  /** The category field of each row (a name such as "Sprint 3"). */
  xKey?: string;
  height?: number;
  valueFormat?: Formatter;
}

const MARGIN = { top: 8, right: 12, bottom: 0, left: 0 } as const;

function GroupTooltip({ active, payload, label, series, valueFormat }: {
  active?: boolean;
  payload?: ReadonlyArray<{ dataKey?: unknown; value?: unknown }>;
  label?: string | number;
  series: ChartSeries[];
  valueFormat: Formatter;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const byKey = new Map(payload.map((entry) => [String(entry.dataKey), entry.value]));
  return (
    <div className="vizTooltip">
      <p className="vizTooltipLabel">{String(label ?? "")}</p>
      <ul>
        {series.filter((item) => byKey.has(item.key)).map((item) => (
          <li key={item.key}>
            <span aria-hidden="true" className="vizLegendSwatch" style={{ background: item.color }} />
            <span>{item.label}</span>
            <strong>{byKey.get(item.key) === null ? "—" : valueFormat(Number(byKey.get(item.key) ?? 0))}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Two or more measures per category side by side, e.g. committed vs completed per sprint, or done vs plan per phase. */
export function GroupedBars({ data, series, xKey = "label", height = 240, valueFormat = formatCount }: GroupedBarsProps) {
  const reduced = useReducedMotion();
  const axis = { stroke: CHART_INK.axis, fontSize: 12 };
  return (
    <div className="vizChartCanvas vizGroupedBars" style={{ height }}>
      <ResponsiveContainer debounce={180} height="100%" initialDimension={{ width: 640, height }} width="100%">
        <BarChart barCategoryGap="22%" barGap={3} data={data} margin={MARGIN}>
          <CartesianGrid stroke={CHART_INK.grid} vertical={false} />
          <XAxis axisLine={false} dataKey={xKey} interval="preserveStartEnd" tick={axis} tickLine={false} tickMargin={8} />
          <YAxis allowDecimals={false} axisLine={false} tick={axis} tickFormatter={(value: number) => valueFormat(value)} tickLine={false} width={48} />
          <Tooltip
            content={(props) => <GroupTooltip {...(props as unknown as { active?: boolean; payload?: Array<{ dataKey?: unknown; value?: unknown }>; label?: string })} series={series} valueFormat={valueFormat} />}
            cursor={{ fill: "rgba(148, 163, 184, .12)" }}
            isAnimationActive={false}
          />
          {series.map((item) => (
            <Bar dataKey={item.key} fill={item.color} isAnimationActive={!reduced} key={item.key} maxBarSize={26} name={item.label} radius={[4, 4, 0, 0]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** The same numbers as a table: one row per category, one column per series ("—" for a missing value). */
export function groupedBarsTable(data: Row[], series: ChartSeries[], { xKey = "label", valueFormat = formatCount }: { xKey?: string; valueFormat?: Formatter } = {}): TableSpec {
  return {
    columns: ["", ...series.map((item) => item.label)],
    rows: data.map((row) => [
      String(row[xKey] ?? "") as ReactNode,
      ...series.map((item) => (row[item.key] === null || row[item.key] === undefined ? "—" : valueFormat(Number(row[item.key])))),
    ]),
  };
}
