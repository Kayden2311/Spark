"use client";

import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { formatCount, shortDate } from "../_lib/format";
import { CHART_INK, sequential } from "../_lib/palette";
import { ErrorBanner } from "./ui";

export { Sparkline } from "./sparkline";

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
}

export interface TableSpec {
  columns: string[];
  rows: Array<Array<ReactNode>>;
}

type Formatter = (value: number) => string;

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}

function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, () => window.matchMedia?.(REDUCED_MOTION).matches ?? false, () => false);
}

/** Series key: a swatch plus the name, so identity never relies on color alone. */
export function ChartLegend({ series }: { series: Array<{ label: string; color: string; value?: ReactNode }> }) {
  return (
    <ul className="admLegend">
      {series.map((item) => (
        <li key={item.label}>
          <span aria-hidden="true" className="admLegendSwatch" style={{ background: item.color }} />
          <span>{item.label}</span>
          {item.value !== undefined && <strong>{item.value}</strong>}
        </li>
      ))}
    </ul>
  );
}

export function DataTable({ table, caption }: { table: TableSpec; caption: string }) {
  return (
    <div className="admChartTableWrap">
      <table className="admChartTable">
        <caption className="admSrOnly">{caption}</caption>
        <thead>
          <tr>
            {table.columns.map((column, index) => <th className={index === 0 ? undefined : "admNum"} key={column} scope="col">{column}</th>)}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (index === 0 ? <th key={index} scope="row">{cell}</th> : <td className="admNum" key={index}>{cell}</td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ChartCardProps {
  title: string;
  subtitle?: ReactNode;
  legend?: ReactNode;
  actions?: ReactNode;
  /** Same numbers as the chart, for screen readers, color-blind readers and exact values. */
  table?: TableSpec;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  empty?: boolean;
  emptyText?: string;
  height?: number;
  className?: string;
  children: ReactNode;
}

/** A titled chart with loading, error and empty states, and a switch to view the numbers as a table. */
export function ChartCard({ title, subtitle, legend, actions, table, loading, error, onRetry, empty, emptyText = "No activity in this period yet.", height = 260, className, children }: ChartCardProps) {
  const [asTable, setAsTable] = useState(false);
  const headingId = useId();
  const ready = !loading && !error && !empty;
  return (
    <section aria-labelledby={headingId} className={`admCard admChartCard${className ? ` ${className}` : ""}`}>
      <div className="admChartHead">
        <div className="admChartTitle">
          <h2 id={headingId}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <div className="admChartTools">
          {actions}
          {table && ready && (
            <button aria-pressed={asTable} className="admBtn admBtnGhost admBtnSm" onClick={() => setAsTable((value) => !value)} type="button">
              {asTable ? "Show chart" : "View as table"}
            </button>
          )}
        </div>
      </div>
      {legend && ready && !asTable && <div className="admChartLegendRow">{legend}</div>}
      <div className="admChartBody" style={{ minHeight: height }}>
        {error ? (
          <ErrorBanner message={error} onRetry={onRetry} />
        ) : loading ? (
          <span aria-busy="true" aria-label="Loading chart" className="admSkeleton admChartSkeleton" role="status" style={{ height }} />
        ) : empty ? (
          <p className="admChartEmpty" style={{ height }}>{emptyText}</p>
        ) : asTable && table ? (
          <DataTable caption={title} table={table} />
        ) : (
          children
        )}
      </div>
    </section>
  );
}

interface TooltipEntry {
  name?: string | number;
  value?: unknown;
  color?: string;
  dataKey?: unknown;
  payload?: Record<string, unknown>;
}

function TooltipBox({ active, payload, label, labelFormat, valueFormat, series }: {
  active?: boolean;
  payload?: ReadonlyArray<TooltipEntry>;
  label?: string | number;
  labelFormat: (label: string) => string;
  valueFormat: Formatter;
  series: ChartSeries[];
}) {
  if (!active || !payload || payload.length === 0) return null;
  const byKey = new Map(payload.map((entry) => [String(entry.dataKey), entry]));
  return (
    <div className="admTooltip">
      <p className="admTooltipLabel">{labelFormat(String(label ?? ""))}</p>
      <ul>
        {series.filter((item) => byKey.has(item.key)).map((item) => (
          <li key={item.key}>
            <span aria-hidden="true" className="admLegendSwatch" style={{ background: item.color }} />
            <span>{item.label}</span>
            <strong>{valueFormat(Number(byKey.get(item.key)?.value ?? 0))}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface TrendChartProps {
  data: Array<Record<string, unknown>>;
  series: ChartSeries[];
  xKey?: string;
  kind?: "area" | "line" | "bar";
  stacked?: boolean;
  height?: number;
  valueFormat?: Formatter;
  xFormat?: (value: string) => string;
}

/** Change over time. One y-axis only: measures of different scale go in separate charts. */
export function TrendChart({ data, series, xKey = "day", kind = "area", stacked = false, height = 260, valueFormat = formatCount, xFormat = shortDate }: TrendChartProps) {
  const reduced = useReducedMotion();
  const gradientBase = useId().replace(/:/gu, "");
  const axis = { stroke: CHART_INK.axis, fontSize: 12 };
  const shared = (
    <>
      <CartesianGrid stroke={CHART_INK.grid} strokeDasharray="0" vertical={false} />
      <XAxis axisLine={false} dataKey={xKey} minTickGap={28} tick={axis} tickFormatter={(value: string) => xFormat(String(value))} tickLine={false} tickMargin={8} />
      <YAxis allowDecimals={false} axisLine={false} tick={axis} tickFormatter={(value: number) => valueFormat(value)} tickLine={false} width={52} />
      <Tooltip
        content={(props) => <TooltipBox {...(props as unknown as { active?: boolean; payload?: TooltipEntry[]; label?: string })} labelFormat={xFormat} series={series} valueFormat={valueFormat} />}
        cursor={kind === "bar" ? { fill: "rgba(148, 163, 184, .12)" } : { stroke: CHART_INK.cursor, strokeWidth: 1 }}
        isAnimationActive={false}
      />
    </>
  );
  return (
    <div className="admChartCanvas" style={{ height }}>
      <ResponsiveContainer height="100%" initialDimension={{ width: 640, height }} width="100%">
        {kind === "bar" ? (
          <BarChart barCategoryGap="18%" data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            {shared}
            {series.map((item, index) => (
              <Bar
                dataKey={item.key}
                fill={item.color}
                isAnimationActive={!reduced}
                key={item.key}
                maxBarSize={28}
                name={item.label}
                radius={!stacked || index === series.length - 1 ? [4, 4, 0, 0] : 0}
                stackId={stacked ? "stack" : undefined}
                stroke={CHART_INK.surface}
                strokeWidth={stacked ? 1 : 0}
              />
            ))}
          </BarChart>
        ) : kind === "line" ? (
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            {shared}
            {series.map((item) => (
              <Line activeDot={{ r: 4, stroke: CHART_INK.surface, strokeWidth: 2 }} dataKey={item.key} dot={false} isAnimationActive={!reduced} key={item.key} name={item.label} stroke={item.color} strokeWidth={2} type="monotone" />
            ))}
          </LineChart>
        ) : (
          <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              {series.map((item) => (
                <linearGradient id={`${gradientBase}-${item.key}`} key={item.key} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={item.color} stopOpacity={series.length > 1 ? 0.14 : 0.22} />
                  <stop offset="100%" stopColor={item.color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            {shared}
            {series.map((item) => (
              <Area
                activeDot={{ r: 4, stroke: CHART_INK.surface, strokeWidth: 2 }}
                dataKey={item.key}
                fill={`url(#${gradientBase}-${item.key})`}
                isAnimationActive={!reduced}
                key={item.key}
                name={item.label}
                stackId={stacked ? "stack" : undefined}
                stroke={item.color}
                strokeWidth={2}
                type="monotone"
              />
            ))}
          </AreaChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

/** Part-to-whole for a handful of categories. More than six categories should fold into "Other". */
export function DonutChart({ data, centerValue, centerLabel, valueFormat = formatCount, height = 220 }: {
  data: Array<{ label: string; value: number; color: string }>;
  centerValue: string;
  centerLabel: string;
  valueFormat?: Formatter;
  height?: number;
}) {
  const reduced = useReducedMotion();
  const total = data.reduce((sum, item) => sum + item.value, 0);
  return (
    <div className="admDonut">
      <div className="admDonutCanvas" style={{ height, width: height }}>
        <ResponsiveContainer height="100%" initialDimension={{ width: height, height }} width="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              innerRadius="68%"
              isAnimationActive={!reduced}
              nameKey="label"
              outerRadius="98%"
              paddingAngle={data.length > 1 ? 1.5 : 0}
              stroke={CHART_INK.surface}
              strokeWidth={2}
            >
              {data.map((item) => <Cell fill={item.color} key={item.label} />)}
            </Pie>
            <Tooltip
              content={(props) => {
                const entry = (props as unknown as { active?: boolean; payload?: TooltipEntry[] }).payload?.[0];
                if (!(props as { active?: boolean }).active || !entry) return null;
                const value = Number(entry.value ?? 0);
                return (
                  <div className="admTooltip">
                    <p className="admTooltipLabel">{String(entry.name)}</p>
                    <p className="admTooltipValue">{valueFormat(value)} · {total ? Math.round((value / total) * 100) : 0}%</p>
                  </div>
                );
              }}
              isAnimationActive={false}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="admDonutCenter">
          <strong>{centerValue}</strong>
          <span>{centerLabel}</span>
        </div>
      </div>
      <ul className="admDonutLegend">
        {data.map((item) => (
          <li key={item.label}>
            <span aria-hidden="true" className="admLegendSwatch" style={{ background: item.color }} />
            <span className="admDonutName">{item.label}</span>
            <strong>{valueFormat(item.value)}</strong>
            <span className="admDonutShare">{total ? Math.round((item.value / total) * 100) : 0}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Ranked magnitudes as horizontal bars, labelled with names and values (no legend needed). */
export function BarList({ items, color, valueFormat = formatCount, emptyText = "Nothing to rank yet." }: {
  items: Array<{ key: string; label: ReactNode; value: number; hint?: ReactNode }>;
  color: string;
  valueFormat?: Formatter;
  emptyText?: string;
}) {
  const max = Math.max(1, ...items.map((item) => item.value));
  if (items.length === 0) return <p className="admChartEmpty">{emptyText}</p>;
  return (
    <ol className="admBarList">
      {items.map((item) => (
        <li key={item.key}>
          <div className="admBarListText">
            <span className="admBarListLabel">{item.label}</span>
            {item.hint && <span className="admBarListHint">{item.hint}</span>}
          </div>
          <span className="admBarListValue">{valueFormat(item.value)}</span>
          <span aria-hidden="true" className="admBarListTrack">
            <span style={{ width: `${Math.max(2, (item.value / max) * 100)}%`, background: color }} />
          </span>
        </li>
      ))}
    </ol>
  );
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Day-of-week by hour-of-day activity (UTC), shaded with one hue from light to dark. */
export function Heatmap({ cells }: { cells: Array<{ dow: number; hour: number; events: number }> }) {
  const [hover, setHover] = useState<{ dow: number; hour: number; events: number } | null>(null);
  const grid = new Map(cells.map((cell) => [`${cell.dow}:${cell.hour}`, cell.events]));
  const max = Math.max(1, ...cells.map((cell) => cell.events));
  const busiest = cells.reduce<{ dow: number; hour: number; events: number } | null>((best, cell) => (!best || cell.events > best.events ? cell : best), null);
  const describe = (cell: { dow: number; hour: number; events: number }) =>
    `${DAYS[cell.dow - 1]} ${String(cell.hour).padStart(2, "0")}:00 UTC: ${formatCount(cell.events)} ${cell.events === 1 ? "event" : "events"}`;
  return (
    <div className="admHeatmap">
      <p aria-live="polite" className="admHeatmapReadout">
        {hover ? describe(hover) : busiest && busiest.events > 0 ? `Busiest hour: ${describe(busiest)}` : "No activity recorded in this period."}
      </p>
      <div aria-hidden="true" className="admHeatmapGrid" onMouseLeave={() => setHover(null)}>
        <span />
        {Array.from({ length: 24 }, (_, hour) => <span className="admHeatmapHour" key={hour}>{hour % 3 === 0 ? String(hour).padStart(2, "0") : ""}</span>)}
        {DAYS.map((day, index) => (
          <div className="admHeatmapRow" key={day}>
            <span className="admHeatmapDay">{day}</span>
            {Array.from({ length: 24 }, (_, hour) => {
              const events = grid.get(`${index + 1}:${hour}`) ?? 0;
              const shade = sequential(events / max);
              return (
                <span
                  className="admHeatmapCell"
                  key={hour}
                  onMouseEnter={() => setHover({ dow: index + 1, hour, events })}
                  style={{ background: shade.background }}
                  title={describe({ dow: index + 1, hour, events })}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="admHeatmapScale">
        <span>Less</span>
        {[0, 0.2, 0.4, 0.6, 0.8, 1].map((step) => <span className="admHeatmapScaleCell" key={step} style={{ background: sequential(step).background }} />)}
        <span>More</span>
      </div>
    </div>
  );
}

/** Weekly sign-up cohorts and the share still active in each following week. */
export function CohortGrid({ cohorts, labelFormat = shortDate }: { cohorts: Array<{ week: string; size: number; retained: number[] }>; labelFormat?: (value: string) => string }) {
  const width = Math.max(0, ...cohorts.map((cohort) => cohort.retained.length));
  return (
    <div className="admChartTableWrap">
      <table className="admCohort">
        <caption className="admSrOnly">Share of each weekly sign-up cohort active in the weeks after joining</caption>
        <thead>
          <tr>
            <th scope="col">Cohort</th>
            <th className="admNum" scope="col">Users</th>
            {Array.from({ length: width }, (_, index) => <th className="admNum" key={index} scope="col">{index === 0 ? "Week 0" : `W${index}`}</th>)}
          </tr>
        </thead>
        <tbody>
          {cohorts.map((cohort) => (
            <tr key={cohort.week}>
              <th scope="row">{labelFormat(cohort.week)}</th>
              <td className="admNum">{cohort.size}</td>
              {Array.from({ length: width }, (_, index) => {
                if (index >= cohort.retained.length) return <td aria-hidden="true" className="admCohortEmpty" key={index} />;
                const ratio = cohort.size ? cohort.retained[index]! / cohort.size : 0;
                const shade = sequential(ratio);
                return (
                  <td className="admCohortCell" data-dark={shade.dark} key={index} style={{ background: shade.background }} title={`${cohort.retained[index]} of ${cohort.size} active`}>
                    {Math.round(ratio * 100)}%
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
