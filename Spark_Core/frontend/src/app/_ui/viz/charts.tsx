"use client";

import { isValidElement, useId, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { formatCount, shortDate } from "./format";
import { motionClass, useReducedMotion } from "./motion";
import { CHART_INK, sequential } from "./palette";

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

/** Series key: a swatch plus the name, so identity never relies on color alone. */
export function ChartLegend({ series }: { series: Array<{ label: string; color: string; value?: ReactNode }> }) {
  return (
    <ul className="vizLegend">
      {series.map((item) => (
        <li key={item.label}>
          <span aria-hidden="true" className="vizLegendSwatch" style={{ background: item.color }} />
          <span>{item.label}</span>
          {item.value !== undefined && <strong>{item.value}</strong>}
        </li>
      ))}
    </ul>
  );
}

export function DataTable({ table, caption }: { table: TableSpec; caption: string }) {
  return (
    <div className="vizChartTableWrap">
      <table className="vizChartTable">
        <caption className="vizSrOnly">{caption}</caption>
        <thead>
          <tr>
            {table.columns.map((column, index) => <th className={index === 0 ? undefined : "vizNum"} key={column} scope="col">{column}</th>)}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (index === 0 ? <th key={index} scope="row">{cell}</th> : <td className="vizNum" key={index}>{cell}</td>))}
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
  /** Replaces the default text-only error state, e.g. so a host app can show its own banner. */
  renderError?: (message: string, onRetry?: () => void) => ReactNode;
  empty?: boolean;
  emptyText?: string;
  height?: number;
  className?: string;
  children: ReactNode;
}

/** Error state for a chart: the message and, when the caller can reload, a text-only Retry button. */
function ChartError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="vizError" role="alert">
      <span>{message}</span>
      {onRetry && (
        <button className="vizBtn vizBtnSecondary vizBtnSm" onClick={onRetry} type="button">
          Retry
        </button>
      )}
    </div>
  );
}

/** A titled chart with loading, error and empty states, and a switch to view the numbers as a table. */
export function ChartCard({ title, subtitle, legend, actions, table, loading, error, onRetry, renderError, empty, emptyText = "No activity in this period yet.", height = 260, className, children }: ChartCardProps) {
  const [asTable, setAsTable] = useState(false);
  const headingId = useId();
  const ready = !loading && !error && !empty;
  return (
    <section aria-labelledby={headingId} className={`vizCard vizChartCard${className ? ` ${className}` : ""}`}>
      <div className="vizChartHead">
        <div className="vizChartTitle">
          <h2 id={headingId}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <div className="vizChartTools">
          {actions}
          {table && ready && (
            <button aria-pressed={asTable} className="vizBtn vizBtnGhost vizBtnSm" onClick={() => setAsTable((value) => !value)} type="button">
              {asTable ? "Show chart" : "View as table"}
            </button>
          )}
        </div>
      </div>
      {legend && ready && !asTable && <div className="vizChartLegendRow">{legend}</div>}
      <div className="vizChartBody" style={{ minHeight: height }}>
        {error ? (
          renderError ? renderError(error, onRetry) : <ChartError message={error} onRetry={onRetry} />
        ) : loading ? (
          <span aria-busy="true" aria-label="Loading chart" className="vizSkeleton vizChartSkeleton" role="status" style={{ height }} />
        ) : empty ? (
          <p className="vizChartEmpty" style={{ height }}>{emptyText}</p>
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
    <div className="vizTooltip">
      <p className="vizTooltipLabel">{labelFormat(String(label ?? ""))}</p>
      <ul>
        {series.filter((item) => byKey.has(item.key)).map((item) => (
          <li key={item.key}>
            <span aria-hidden="true" className="vizLegendSwatch" style={{ background: item.color }} />
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
    <div className="vizChartCanvas" style={{ height }}>
      <ResponsiveContainer debounce={180} height="100%" initialDimension={{ width: 640, height }} width="100%">
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

/**
 * Part-to-whole for a handful of categories (six at most; fold the rest into "Other"). A thin ring of
 * rounded segments separated by surface gaps. Hovering a segment or its legend row lifts that segment,
 * dims the rest, and swaps the center readout to its value and share — the readout replaces a floating
 * tooltip, so nothing can cover it. Legend rows carry a share bar, so the ring is never the only read.
 */
export function DonutChart({ data, centerValue, centerLabel, valueFormat = formatCount, height = 220 }: {
  data: Array<{ label: string; value: number; color: string }>;
  centerValue: string;
  centerLabel: string;
  valueFormat?: Formatter;
  height?: number;
}) {
  const reduced = useReducedMotion();
  const [active, setActive] = useState<number | null>(null);
  const total = data.reduce((sum, item) => sum + item.value, 0);
  const share = (value: number) => (total ? Math.round((value / total) * 100) : 0);
  const focus = active === null ? null : data[active];
  const sliceClass = (index: number) => `vizDonutSlice${active === index ? " vizDonutSliceActive" : active === null ? "" : " vizDonutSliceDim"}`;
  return (
    <div className="vizDonut" onMouseLeave={() => setActive(null)}>
      <div className="vizDonutCanvas" style={{ height, width: height }}>
        <ResponsiveContainer height="100%" initialDimension={{ width: height, height }} width="100%">
          <PieChart>
            <Pie
              animationDuration={700}
              cornerRadius={5}
              data={data}
              dataKey="value"
              endAngle={-270}
              innerRadius="72%"
              isAnimationActive={!reduced}
              nameKey="label"
              onMouseEnter={(_, index) => setActive(index)}
              outerRadius="92%"
              paddingAngle={data.length > 1 ? 3 : 0}
              startAngle={90}
              stroke="none"
            >
              {data.map((item, index) => <Cell className={sliceClass(index)} fill={item.color} key={item.label} />)}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div aria-live="polite" className="vizDonutCenter">
          {focus ? (
            <>
              <span className="vizDonutCenterKey"><i aria-hidden="true" style={{ background: focus.color }} />{focus.label}</span>
              <strong>{valueFormat(focus.value)}</strong>
              <span>{share(focus.value)}% of {valueFormat(total)}</span>
            </>
          ) : (
            <>
              <strong>{centerValue}</strong>
              <span>{centerLabel}</span>
            </>
          )}
        </div>
      </div>
      <ul className="vizDonutLegend">
        {data.map((item, index) => (
          <li
            className={active === index ? "vizDonutLegendActive" : undefined}
            key={item.label}
            onMouseEnter={() => setActive(index)}
          >
            <span aria-hidden="true" className="vizLegendSwatch" style={{ background: item.color }} />
            <span className="vizDonutName">{item.label}</span>
            <strong>{valueFormat(item.value)}</strong>
            <span className="vizDonutShare">{share(item.value)}%</span>
            <span aria-hidden="true" className="vizDonutBar">
              <span style={{ "--viz-bar-w": `${Math.max(2, share(item.value))}%`, "--viz-bar-delay": `${Math.min(index, 8) * 60}ms`, background: item.color } as CSSProperties} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** True for a label that is itself a link (an <a> or next/link, both of which take `href`). */
function isLinkLabel(label: ReactNode): boolean {
  return isValidElement<{ href?: unknown }>(label) && (label.type === "a" || label.props.href !== undefined);
}

/** Ranked magnitudes as horizontal bars, labelled with names and values (no legend needed). Bars grow
 * in from the left on mount (unless reduced motion is set) and highlight on hover, with the exact value
 * and its share of the total as a tooltip. */
export function BarList({ items, color, valueFormat = formatCount, emptyText = "Nothing to rank yet." }: {
  items: Array<{ key: string; label: ReactNode; value: number; hint?: ReactNode }>;
  color: string;
  valueFormat?: Formatter;
  emptyText?: string;
}) {
  const reduced = useReducedMotion();
  const max = Math.max(1, ...items.map((item) => item.value));
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (items.length === 0) return <p className="vizChartEmpty">{emptyText}</p>;
  return (
    <ol className="vizBarList">
      {items.map((item, index) => {
        const share = total ? Math.round((item.value / total) * 100) : 0;
        return (
          // A row whose label is already a link is reached through that link; any other row is its own tab
          // stop, so the share tooltip below shows on keyboard focus as it does on hover.
          <li key={item.key} tabIndex={isLinkLabel(item.label) ? undefined : 0}>
            <div className="vizBarListText">
              <span className="vizBarListLabel">{item.label}</span>
              {item.hint && <span className="vizBarListHint">{item.hint}</span>}
            </div>
            <span className="vizBarListValue">
              {valueFormat(item.value)}
              <span className="vizBarListPercent">{share}%</span>
            </span>
            <span aria-hidden="true" className="vizBarListTip">{`${valueFormat(item.value)} · ${share}% of ${valueFormat(total)}`}</span>
            <span aria-hidden="true" className="vizBarListTrack">
              <span className={reduced ? undefined : "admGrowIn"} style={{ "--viz-bar-w": `${Math.max(2, (item.value / max) * 100)}%`, "--viz-bar-delay": `${Math.min(index, 8) * 45}ms`, background: color } as CSSProperties} />
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** A thin filled track for one ratio (0–1) next to a value, e.g. "how this compares to the worst row". */
export function InlineBar({ ratio, color, wide, title, className }: { ratio: number; color: string; wide?: boolean; title?: string; className?: string }) {
  return (
    <span aria-hidden="true" className={`vizInlineBarTrack${wide ? " vizInlineBarTrack-wide" : ""}${className ? ` ${className}` : ""}`} title={title}>
      <span className="vizInlineBarFill" style={{ "--viz-bar-w": `${Math.max(4, Math.min(100, ratio * 100))}%`, background: color } as CSSProperties} />
    </span>
  );
}

/**
 * A small ring gauge for one ratio metric (0–1): a status color fills the ring, the value sits in the
 * center. Always paired by the caller with a text label, so meaning never rests on color alone.
 */
export function Gauge({ ratio, valueText, tone, size = 56, thickness = 6 }: { ratio: number; valueText: string; tone: string; size?: number; thickness?: number }) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className="vizGauge" style={{ width: size, height: size }}>
      <svg height={size} viewBox={`0 0 ${size} ${size}`} width={size}>
        <circle cx={size / 2} cy={size / 2} fill="none" r={radius} stroke={CHART_INK.grid} strokeWidth={thickness} />
        <circle
          cx={size / 2}
          cy={size / 2}
          fill="none"
          r={radius}
          stroke={tone}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped)}
          strokeLinecap="round"
          strokeWidth={thickness}
          style={{ transform: "rotate(-90deg)", transformOrigin: "center", transition: "stroke-dashoffset .3s ease" }}
        />
      </svg>
      <span className="vizGaugeValue">{valueText}</span>
    </div>
  );
}

const GAUGE = { cx: 60, cy: 60, r: 48 } as const;
const TARGET_TONES = { within: "#047857", over: "#dc2626" } as const;

/** The half arc from the left end to `ratio` (0–1) of the way round to the right end, over the top. */
function halfArc(ratio: number): string {
  const angle = Math.PI * (1 - ratio);
  const x = GAUGE.cx + GAUGE.r * Math.cos(angle);
  const y = GAUGE.cy - GAUGE.r * Math.sin(angle);
  return `M${GAUGE.cx - GAUGE.r} ${GAUGE.cy} A${GAUGE.r} ${GAUGE.r} 0 0 1 ${Number(x.toFixed(2))} ${Number(y.toFixed(2))}`;
}

/** "Within target", or how many times over it, to one decimal ("2× over target", "1.5× over target"). */
export function targetStatus(value: number, target: number): { over: boolean; text: string } {
  if (target <= 0) return value > 0 ? { over: true, text: "Over target" } : { over: false, text: "Within target" };
  if (value <= target) return { over: false, text: "Within target" };
  return { over: true, text: `${Number((value / target).toFixed(1))}× over target` };
}

/**
 * A half-arc gauge for a count measured against a target (e.g. the report backlog). The arc is full at
 * twice the target; green with "Within target" up to the target, red with "N× over target" beyond it, so
 * the status is always stated in words as well as colour. The fill draws in unless reduced motion is set.
 */
export function TargetGauge({ value, target, label, valueFormat = formatCount }: { value: number; target: number; label: string; valueFormat?: Formatter }) {
  const reduced = useReducedMotion();
  const status = targetStatus(value, target);
  const ratio = target > 0 ? Math.max(0, Math.min(value / (2 * target), 1)) : value > 0 ? 1 : 0;
  const tone = status.over ? TARGET_TONES.over : TARGET_TONES.within;
  return (
    <div aria-label={`${label}: ${valueFormat(value)}, ${status.text}`} className={`vizTargetGauge${status.over ? " vizTargetGaugeOver" : ""}`} role="img">
      <svg aria-hidden="true" className="vizTargetGaugeArc" viewBox="0 0 120 68">
        <path className="vizTargetGaugeTrack" d={halfArc(1)} fill="none" stroke={CHART_INK.grid} strokeLinecap="round" strokeWidth={10} />
        {ratio > 0 && (
          <path className={`vizTargetGaugeFill${motionClass(reduced, "admDrawIn")}`} d={halfArc(ratio)} fill="none" pathLength={1} stroke={tone} strokeLinecap="round" strokeWidth={10} />
        )}
      </svg>
      <div className="vizTargetGaugeText">
        <strong>{valueFormat(value)}</strong>
        <span style={{ color: tone }}>{status.text}</span>
        <span className="vizTargetGaugeTarget">Target {valueFormat(target)}</span>
      </div>
    </div>
  );
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Day-of-week by hour-of-day activity (UTC), shaded with one hue from light to dark. The grid is one
 * keyboard stop: focusing it selects the busiest cell, arrow keys (and Home/End) move the selection,
 * and the polite live readout above states the selected cell's exact value, as hovering does.
 */
export function Heatmap({ cells }: { cells: Array<{ dow: number; hour: number; events: number }> }) {
  const reduced = useReducedMotion();
  const [active, setActive] = useState<{ dow: number; hour: number } | null>(null);
  const grid = new Map(cells.map((cell) => [`${cell.dow}:${cell.hour}`, cell.events]));
  const max = Math.max(1, ...cells.map((cell) => cell.events));
  const busiest = cells.reduce<{ dow: number; hour: number; events: number } | null>((best, cell) => (!best || cell.events > best.events ? cell : best), null);
  const eventsAt = (dow: number, hour: number) => grid.get(`${dow}:${hour}`) ?? 0;
  const describe = (cell: { dow: number; hour: number; events: number }) =>
    `${DAYS[cell.dow - 1]} ${String(cell.hour).padStart(2, "0")}:00 UTC: ${formatCount(cell.events)} ${cell.events === 1 ? "event" : "events"}`;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = active ?? { dow: 1, hour: 0 };
    const moves: Record<string, { dow: number; hour: number }> = {
      ArrowLeft: { dow: from.dow, hour: Math.max(0, from.hour - 1) },
      ArrowRight: { dow: from.dow, hour: Math.min(23, from.hour + 1) },
      ArrowUp: { dow: Math.max(1, from.dow - 1), hour: from.hour },
      ArrowDown: { dow: Math.min(7, from.dow + 1), hour: from.hour },
      Home: { dow: from.dow, hour: 0 },
      End: { dow: from.dow, hour: 23 },
    };
    const next = moves[event.key];
    if (!next) return;
    event.preventDefault();
    setActive(next);
  };
  return (
    <div className="vizHeatmap">
      <p aria-live="polite" className="vizHeatmapReadout">
        {active
          ? describe({ ...active, events: eventsAt(active.dow, active.hour) })
          : busiest && busiest.events > 0 ? `Busiest hour: ${describe(busiest)}` : "No activity recorded in this period."}
      </p>
      <div
        aria-label="Activity by day and hour (UTC). Use the arrow keys to read each hour."
        className="vizHeatmapGrid"
        onBlur={() => setActive(null)}
        onFocus={() => setActive(busiest && busiest.events > 0 ? { dow: busiest.dow, hour: busiest.hour } : { dow: 1, hour: 0 })}
        onKeyDown={onKeyDown}
        onMouseLeave={() => setActive(null)}
        role="group"
        tabIndex={0}
      >
        <span aria-hidden="true" />
        {Array.from({ length: 24 }, (_, hour) => <span aria-hidden="true" className="vizHeatmapHour" key={hour}>{hour % 3 === 0 ? String(hour).padStart(2, "0") : ""}</span>)}
        {DAYS.map((day, index) => (
          <div aria-hidden="true" className="vizHeatmapRow" key={day}>
            <span className="vizHeatmapDay">{day}</span>
            {Array.from({ length: 24 }, (_, hour) => {
              const shade = sequential(eventsAt(index + 1, hour) / max);
              const selected = active?.dow === index + 1 && active.hour === hour;
              return (
                <span
                  className={`vizHeatmapCell${selected ? " vizHeatmapCellActive" : ""}${motionClass(reduced, "admFadeIn")}`}
                  key={hour}
                  onMouseEnter={() => setActive({ dow: index + 1, hour })}
                  style={{ background: shade.background, "--viz-fade-delay": `${index * 70}ms` } as CSSProperties}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="vizHeatmapScale">
        <span>Less</span>
        {[0, 0.2, 0.4, 0.6, 0.8, 1].map((step) => <span className="vizHeatmapScaleCell" key={step} style={{ background: sequential(step).background }} />)}
        <span>More</span>
      </div>
    </div>
  );
}

const DOW_SHORT = ["", "Mon", "", "Wed", "", "Fri", ""];

/**
 * A GitHub-style daily activity calendar: one square per day, grouped into Monday-start week columns,
 * shaded with the same sequential scale as the hour heatmap and cohort grid. Where the hour heatmap
 * answers "what time of day", this answers "is this trending" at a glance over weeks or months.
 */
export function ContributionCalendar({ data, unit = "events" }: { data: Array<{ day: string; value: number }>; unit?: string }) {
  const [hover, setHover] = useState<{ date: string; value: number } | null>(null);
  const sorted = [...data].sort((a, b) => a.day.localeCompare(b.day));
  if (sorted.length === 0) return <p className="vizChartEmpty">No activity in this period yet.</p>;

  const firstDay = sorted[0]!.day;
  const lastDay = sorted[sorted.length - 1]!.day;
  const first = new Date(`${firstDay}T00:00:00Z`);
  const last = new Date(`${lastDay}T00:00:00Z`);
  const gridStart = new Date(first);
  gridStart.setUTCDate(gridStart.getUTCDate() - ((first.getUTCDay() + 6) % 7));
  const gridEnd = new Date(last);
  gridEnd.setUTCDate(gridEnd.getUTCDate() + (6 - ((last.getUTCDay() + 6) % 7)));

  const byDay = new Map(sorted.map((point) => [point.day, point.value]));
  const max = Math.max(1, ...sorted.map((point) => point.value));
  const total = sorted.reduce((sum, point) => sum + point.value, 0);

  type Cell = { date: string; value: number | null };
  const weeks: Cell[][] = [];
  for (const cursor = new Date(gridStart); cursor <= gridEnd; cursor.setUTCDate(cursor.getUTCDate() + 7)) {
    const week: Cell[] = [];
    for (let day = 0; day < 7; day++) {
      const date = new Date(cursor);
      date.setUTCDate(date.getUTCDate() + day);
      const iso = date.toISOString().slice(0, 10);
      week.push({ date: iso, value: iso >= firstDay && iso <= lastDay ? byDay.get(iso) ?? 0 : null });
    }
    weeks.push(week);
  }

  const monthLabel = (week: Cell[]): string | null => {
    const firstOfMonth = week.find((cell) => cell.value !== null && cell.date.endsWith("-01"));
    if (!firstOfMonth) return null;
    return new Date(`${firstOfMonth.date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  };

  const describe = (date: string, value: number) =>
    `${new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" })}: ${formatCount(value)} ${unit}`;

  return (
    <div className="vizContribution">
      <p aria-live="polite" className="vizContributionReadout">
        {hover ? describe(hover.date, hover.value) : `${formatCount(total)} ${unit} over ${sorted.length} days`}
      </p>
      <div className="vizContributionScroll">
        <div aria-hidden="true" className="vizContributionBody" onMouseLeave={() => setHover(null)}>
          <div className="vizContributionDayLabels">
            <span />
            {DOW_SHORT.map((label, index) => <span key={index}>{label}</span>)}
          </div>
          <div className="vizContributionMain">
            <div className="vizContributionMonths">
              {weeks.map((week, index) => <span key={index}>{monthLabel(week)}</span>)}
            </div>
            <div className="vizContributionWeeks">
              {weeks.map((week, weekIndex) => (
                <div className="vizContributionWeek" key={weekIndex}>
                  {week.map((cell) =>
                    cell.value === null ? (
                      <span className="vizContributionCell vizContributionCell-out" key={cell.date} />
                    ) : (
                      <span
                        className="vizContributionCell"
                        key={cell.date}
                        onMouseEnter={() => setHover({ date: cell.date, value: cell.value! })}
                        style={{ background: cell.value === 0 ? "#edf1f6" : sequential(cell.value / max).background }}
                        title={describe(cell.date, cell.value)}
                      />
                    ),
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div aria-hidden="true" className="vizHeatmapScale vizContributionScale">
        <span>Less</span>
        {[0, 0.2, 0.4, 0.6, 0.8, 1].map((step) => <span className="vizHeatmapScaleCell" key={step} style={{ background: sequential(step).background }} />)}
        <span>More</span>
      </div>
    </div>
  );
}

/** Weekly sign-up cohorts and the share still active in each following week. */
export function CohortGrid({ cohorts, labelFormat = shortDate }: { cohorts: Array<{ week: string; size: number; retained: number[] }>; labelFormat?: (value: string) => string }) {
  const width = Math.max(0, ...cohorts.map((cohort) => cohort.retained.length));
  return (
    <div className="vizChartTableWrap">
      <table className="vizCohort">
        <caption className="vizSrOnly">Share of each weekly sign-up cohort active in the weeks after joining</caption>
        <thead>
          <tr>
            <th scope="col">Cohort</th>
            <th className="vizNum" scope="col">Users</th>
            {Array.from({ length: width }, (_, index) => <th className="vizNum" key={index} scope="col">{index === 0 ? "Week 0" : `W${index}`}</th>)}
          </tr>
        </thead>
        <tbody>
          {cohorts.map((cohort) => (
            <tr key={cohort.week}>
              <th scope="row">{labelFormat(cohort.week)}</th>
              <td className="vizNum">{cohort.size}</td>
              {Array.from({ length: width }, (_, index) => {
                if (index >= cohort.retained.length) return <td aria-hidden="true" className="vizCohortEmpty" key={index} />;
                const ratio = cohort.size ? cohort.retained[index]! / cohort.size : 0;
                const shade = sequential(ratio);
                return (
                  <td className="vizCohortCell" data-dark={shade.dark} key={index} style={{ background: shade.background }} title={`${cohort.retained[index]} of ${cohort.size} active`}>
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
