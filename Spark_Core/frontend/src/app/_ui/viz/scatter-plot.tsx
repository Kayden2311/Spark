"use client";

import { CartesianGrid, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from "recharts";

import { DASH, type TableSpec } from "./charts";
import { formatCount, shortDate } from "./format";
import { useReducedMotion } from "./motion";
import { CHART_INK } from "./palette";

type Formatter = (value: number) => string;

export interface ScatterPoint {
  /** Usually a time in epoch milliseconds. */
  x: number;
  y: number;
  /** Names the point in the tooltip and the table (e.g. an item key). */
  label?: string;
}

export interface ScatterSeries {
  key: string;
  label: string;
  color: string;
  points: ScatterPoint[];
}

export interface ScatterReference {
  y: number;
  label: string;
  color?: string;
}

interface ScatterPlotProps {
  series: ScatterSeries[];
  /** Horizontal labelled lines, e.g. percentiles. */
  references?: ScatterReference[];
  height?: number;
  xFormat?: (value: number) => string;
  yFormat?: Formatter;
}

const MARGIN = { top: 12, right: 22, bottom: 0, left: 0 } as const;

/** Day label for an epoch-milliseconds x value ("Oct 2"). */
export function epochDay(value: number): string {
  return shortDate(new Date(value).toISOString());
}

function PointTooltip({ active, payload, xFormat, yFormat }: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: ScatterPoint & { series?: string } }>;
  xFormat: (value: number) => string;
  yFormat: Formatter;
}) {
  const point = active ? payload?.[0]?.payload : undefined;
  if (!point) return null;
  return (
    <div className="vizTooltip">
      <p className="vizTooltipLabel">{point.label ?? xFormat(point.x)}</p>
      <p className="vizTooltipValue">{point.series ? `${point.series}: ` : ""}{yFormat(point.y)} · {xFormat(point.x)}</p>
    </div>
  );
}

/** One dot per item (x usually time, y a duration), with optional reference lines such as p50/p85. */
export function ScatterPlot({ series, references = [], height = 260, xFormat = epochDay, yFormat = formatCount }: ScatterPlotProps) {
  const reduced = useReducedMotion();
  const axis = { stroke: CHART_INK.axis, fontSize: 12 };
  return (
    <div className="vizChartCanvas vizScatter" style={{ height }}>
      <ResponsiveContainer debounce={180} height="100%" initialDimension={{ width: 640, height }} width="100%">
        <ScatterChart margin={MARGIN}>
          <CartesianGrid stroke={CHART_INK.grid} vertical={false} />
          <XAxis axisLine={false} dataKey="x" domain={["dataMin", "dataMax"]} minTickGap={28} scale="time" tick={axis} tickFormatter={(value: number) => xFormat(value)} tickLine={false} tickMargin={8} type="number" />
          <YAxis axisLine={false} dataKey="y" tick={axis} tickFormatter={(value: number) => yFormat(value)} tickLine={false} type="number" width={52} />
          <Tooltip content={(props) => <PointTooltip {...(props as unknown as { active?: boolean; payload?: Array<{ payload?: ScatterPoint }> })} xFormat={xFormat} yFormat={yFormat} />} cursor={{ stroke: CHART_INK.cursor, strokeWidth: 1 }} isAnimationActive={false} />
          {references.map((reference) => (
            <ReferenceLine
              key={reference.label}
              label={{ value: reference.label, position: "insideTopRight", fill: reference.color ?? CHART_INK.axis, fontSize: 11 }}
              stroke={reference.color ?? CHART_INK.axis}
              strokeDasharray={DASH}
              y={reference.y}
            />
          ))}
          {series.map((item) => (
            <Scatter
              data={item.points.map((point) => ({ ...point, series: item.label }))}
              fill={item.color}
              fillOpacity={0.75}
              isAnimationActive={!reduced}
              key={item.key}
              name={item.label}
            />
          ))}
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

/** The points as a table: one row per point (its label or x), with x and the series' y. */
export function scatterTable(series: ScatterSeries[], { xFormat = epochDay, yFormat = formatCount, itemLabel = "Item", xLabel = "Day" }: { xFormat?: (value: number) => string; yFormat?: Formatter; itemLabel?: string; xLabel?: string } = {}): TableSpec {
  return {
    columns: [itemLabel, xLabel, ...series.map((item) => item.label)],
    rows: series.flatMap((item, index) =>
      item.points.map((point) => [
        point.label ?? xFormat(point.x),
        xFormat(point.x),
        ...series.map((_, column) => (column === index ? yFormat(point.y) : "—")),
      ]),
    ),
  };
}
