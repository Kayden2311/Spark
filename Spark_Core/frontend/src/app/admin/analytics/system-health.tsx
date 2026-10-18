"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { ChartCard, ChartLegend, Gauge, InlineBar, TrendChart } from "../_components/charts";
import { AlertIcon, ClockIcon, CpuIcon, DatabaseIcon, LayersIcon, PulseIcon, ShieldIcon } from "../_components/icons";
import { Badge, Card, KpiCards, MetricTile, Segmented, SkeletonRows } from "../_components/ui";
import { formatCount, formatDuration, formatPercent, formatRelative, type Tone } from "../_lib/format";
import { VIZ } from "../_lib/palette";

/** Status colors, matched to the `.admTone-*` badge tones so a gauge and its badge always agree. */
const STATUS_HEX = { green: "#10b981", amber: "#f59e0b", red: "#ef4444", blue: "#2563eb" } as const;
import type { HealthCheck, RouteSummary, SystemHealth } from "../_lib/types";
import { useAdminData } from "../_lib/use-admin-data";
import { useQueryState } from "../_lib/use-query-state";

const REFRESH_MS = 30_000;
/** A check that has not answered by now is treated as failed: a hung API is an outage too. */
const SLOW_MS = 20_000;
const WINDOWS = ["60", "360", "1440"] as const;
type Window = (typeof WINDOWS)[number];

const CHECK_TONE: Record<HealthCheck["status"], { tone: Tone; label: string }> = {
  ok: { tone: "green", label: "Healthy" },
  degraded: { tone: "amber", label: "Degraded" },
  down: { tone: "red", label: "Down" },
  unknown: { tone: "neutral", label: "Unknown" },
};

const OVERALL: Record<SystemHealth["status"], { tone: Tone; title: string; text: string }> = {
  operational: { tone: "green", title: "All systems operational", text: "The API, database and Redis are responding normally." },
  degraded: { tone: "amber", title: "Degraded performance", text: "Something is slow or failing more than usual. See the checks below." },
  down: { tone: "red", title: "Major outage", text: "The database is not reachable, so most of Spark is unavailable." },
};

const ms = (value: number | null | undefined) => (value === null || value === undefined ? "–" : `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`);
const minuteLabel = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

function CheckTile({ name, icon, check, children }: { name: string; icon: ReactNode; check: HealthCheck; children?: ReactNode }) {
  const state = CHECK_TONE[check.status];
  return (
    <li className={`admCheck admTone-${state.tone}`} data-status={check.status}>
      <div className="admCheckTop">
        <span aria-hidden="true" className={`admCheckIcon admTone-${state.tone}`}>{icon}</span>
        <span className="admCheckName">{name}</span>
        <Badge tone={state.tone}>{state.label}</Badge>
      </div>
      <p className="admCheckDetail">{check.detail}</p>
      <dl className="admCheckStats">
        <div><dt>Response</dt><dd>{ms(check.latencyMs)}</dd></div>
        {children}
      </dl>
    </li>
  );
}

/** One route per row: the endpoint with its traffic as a caption, and one metric with a bar showing it relative to the worst row in the list. */
function RouteTable({ routes, empty, focus }: { routes: RouteSummary[]; empty: string; focus: "latency" | "errors" }) {
  if (routes.length === 0) return <p className="admCardEmpty">{empty}</p>;
  const weight = (route: RouteSummary) => (focus === "latency" ? (route.p95Ms ?? 0) : route.serverErrors * 3 + route.clientErrors);
  const max = Math.max(1, ...routes.map(weight));
  return (
    <table className="admTable admRouteTable">
      <thead>
        <tr>
          <th scope="col">Endpoint</th>
          <th className="admNum" scope="col">{focus === "latency" ? "Response time" : "Errors"}</th>
        </tr>
      </thead>
      <tbody>
        {routes.map((route) => {
          const [method, ...path] = route.route.split(" ");
          const warn = focus === "latency" ? (route.p95Ms ?? 0) > 1000 : route.serverErrors > 0;
          const color = focus === "latency" ? ((route.p95Ms ?? 0) > 1000 ? STATUS_HEX.amber : VIZ.violet) : (route.serverErrors > 0 ? STATUS_HEX.red : STATUS_HEX.amber);
          return (
            <tr key={route.route}>
              <td data-label="Endpoint">
                <div className="admRouteCell">
                  <span className="admRoute"><span className="admMethod">{method}</span><code>{path.join(" ")}</code></span>
                  <span className="admRouteSub">{formatCount(route.requests)} {route.requests === 1 ? "request" : "requests"}</span>
                </div>
              </td>
              <td className="admNum" data-label={focus === "latency" ? "Response time" : "Errors"}>
                <div className="admRouteMetric">
                  <span className="admRouteMetricTop">
                    <strong className={warn ? "admRouteMetricWarn" : undefined}>{focus === "latency" ? ms(route.p95Ms) : `${route.serverErrors} 5xx`}</strong>
                    <span className="admRouteSub">{focus === "latency" ? `avg ${ms(route.avgMs)}` : `${route.clientErrors} 4xx`}</span>
                  </span>
                  <InlineBar color={color} ratio={weight(route) / max} />
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function FailureBanner({ failure, onRetry, retrying }: { failure: { tone: Tone; title: string; text: string }; onRetry: () => void; retrying: boolean }) {
  return (
    <section aria-live="polite" className={`admStatusBanner admTone-${failure.tone}`} role="status">
      <span aria-hidden="true" className="admStatusPulse" />
      <div className="admStatusText">
        <h2>{failure.title}</h2>
        <p>{failure.text}</p>
      </div>
      <button className="admBtn admBtnSecondary admBtnSm" disabled={retrying} onClick={onRetry} type="button">{retrying ? "Checking…" : "Check again"}</button>
    </section>
  );
}

/** Live platform health: overall status, service checks, API traffic and the slowest or failing endpoints. */
export function SystemHealthPanel() {
  const [span, setSpan] = useQueryState<Window>("window", "60", WINDOWS);
  const health = useAdminData<SystemHealth>(`/system/health?minutes=${span}`);
  const { reload, loading, attempt } = health;
  const loadingRef = useRef(loading);
  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);
  const [slowAttempt, setSlowAttempt] = useState<string | null>(null);

  // Refresh on a timer, but never cancel a check that is still running.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !loadingRef.current) reload();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);

  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => setSlowAttempt(attempt), SLOW_MS);
    return () => clearTimeout(timer);
  }, [loading, attempt]);

  // A failed or hung check is itself a health signal. The banner follows the most recent attempt, so a
  // refresh in progress never brings back an earlier "operational" banner.
  const hung = loading && slowAttempt === attempt;
  const failure = hung
    ? { tone: "red" as Tone, title: "Health check not responding", text: "The API has not answered for 20 seconds. It may be down or overloaded." }
    : health.lastError
      ? { tone: "red" as Tone, title: health.lastErrorCode === "database_unavailable" ? "Major outage" : "Health check failed", text: health.lastError }
      : null;
  if (!health.data) {
    if (failure) return <FailureBanner failure={failure} onRetry={reload} retrying={health.loading && !hung} />;
    return <SkeletonRows rows={6} />;
  }
  const data = health.data;
  const overall = failure ?? OVERALL[data.status];
  const traffic = data.traffic;
  const errorRate = traffic.requests ? traffic.serverErrors / traffic.requests : 0;
  // Labels follow the data on screen, not the window just picked (which may still be loading).
  const windowLabel = traffic.windowMinutes === 60 ? "last hour" : traffic.windowMinutes === 360 ? "last 6 hours" : "last 24 hours";
  const perBucket = traffic.stepMinutes === 1 ? "per minute" : `per ${traffic.stepMinutes} minutes`;
  const charted = traffic.series.reduce((sum, point) => sum + point.requests, 0);
  const series = traffic.series.map((point) => ({ ...point, ok: point.requests - point.clientErrors - point.serverErrors }));
  const cacheHitText = data.database.cacheHitRatio === null ? "–" : formatPercent(data.database.cacheHitRatio, 1);

  return (
    <>
      <section aria-live="polite" className={`admStatusBanner admTone-${overall.tone}`} role="status">
        <span aria-hidden="true" className="admStatusPulse" />
        <div className="admStatusText">
          <h2>{overall.title}</h2>
          <p>{overall.text}</p>
        </div>
        <div className="admStatusMeta">
          <span>{failure ? `Last good check ${formatRelative(data.checkedAt)}; the figures below may be out of date` : `Checked ${formatRelative(data.checkedAt)} · refreshes every 30 s`}</span>
          <div className="admStatusTools">
            <Segmented label="Traffic window" onChange={setSpan} options={[{ value: "60", label: "1h" }, { value: "360", label: "6h" }, { value: "1440", label: "24h" }]} value={span} />
            <button className="admBtn admBtnSecondary admBtnSm" disabled={health.loading && !hung} onClick={reload} type="button">{health.loading && !hung ? "Checking…" : "Check now"}</button>
          </div>
        </div>
      </section>
      <p className="admEyebrow">Live checks</p>
      <ul aria-label="Service checks" className="admChecks" data-stale={failure ? "true" : undefined}>
        <CheckTile check={data.checks.api} icon={<PulseIcon />} name="API">
          <div><dt>Uptime</dt><dd>{formatDuration(data.process.uptimeSeconds)}</dd></div>
        </CheckTile>
        <CheckTile check={data.checks.database} icon={<DatabaseIcon />} name="PostgreSQL">
          <div><dt>Pool in use</dt><dd>{data.database.poolTotal - data.database.poolIdle} / {data.database.poolTotal}{data.database.poolWaiting > 0 ? `, ${data.database.poolWaiting} waiting` : ""}</dd></div>
        </CheckTile>
        <CheckTile check={data.checks.redis} icon={<LayersIcon />} name="Redis (rate limits)">
          <div><dt>Memory</dt><dd>{data.redis.usedMemoryMb === null ? "–" : `${data.redis.usedMemoryMb} MB`}</dd></div>
        </CheckTile>
      </ul>

      <p className="admEyebrow">Traffic summary</p>
      <KpiCards
        items={[
          { label: `Requests, ${windowLabel}`, value: formatCount(traffic.requests), hint: `${formatCount(traffic.clientErrors)} client errors (4xx)`, icon: <PulseIcon />, tone: "blue", trend: { values: traffic.series.map((point) => point.requests), color: VIZ.blue } },
          { label: "Server error rate", value: formatPercent(errorRate, 2), hint: `${formatCount(traffic.serverErrors)} responses with 5xx`, icon: <AlertIcon />, tone: errorRate > 0.05 ? "red" : errorRate > 0 ? "amber" : "green" },
          { label: "Response time (p95)", value: ms(traffic.p95Ms), hint: `Median ${ms(traffic.p50Ms)}`, icon: <ClockIcon />, tone: (traffic.p95Ms ?? 0) > 1000 ? "amber" : "violet", trend: { values: traffic.series.map((point) => point.p95Ms ?? 0), color: VIZ.violet } },
          { label: "Active sessions", value: data.database.activeSessions === null ? "–" : formatCount(data.database.activeSessions), hint: "Signed-in browsers right now", icon: <ShieldIcon />, tone: "green" },
        ]}
        label="Traffic summary"
      />

      <p className="admEyebrow">Traffic over time</p>
      <div className="admGrid2">
        <ChartCard
          empty={charted === 0}
          emptyText="No requests in this window yet."
          legend={<ChartLegend series={[{ label: "Successful", color: VIZ.blue }, { label: "Client errors (4xx)", color: VIZ.yellow }, { label: "Server errors (5xx)", color: VIZ.orange }]} />}
          subtitle={`Requests ${perBucket}, ${windowLabel}`}
          table={{ columns: ["From", "Successful", "4xx", "5xx"], rows: series.filter((point) => point.requests > 0).map((point) => [minuteLabel(point.minute), point.ok, point.clientErrors, point.serverErrors]) }}
          title="API traffic"
        >
          <TrendChart
            data={series as unknown as Array<Record<string, unknown>>}
            kind="bar"
            series={[{ key: "ok", label: "Successful", color: VIZ.blue }, { key: "clientErrors", label: "Client errors (4xx)", color: VIZ.yellow }, { key: "serverErrors", label: "Server errors (5xx)", color: VIZ.orange }]}
            stacked
            xFormat={minuteLabel}
            xKey="minute"
          />
        </ChartCard>
        <ChartCard
          empty={charted === 0}
          emptyText="No requests in this window yet."
          subtitle={`95% of requests finished within this time, ${perBucket}`}
          table={{ columns: ["From", "p95 (ms)"], rows: traffic.series.filter((point) => point.p95Ms !== null).map((point) => [minuteLabel(point.minute), point.p95Ms ?? 0]) }}
          title="Response time"
        >
          <TrendChart
            data={traffic.series.map((point) => ({ ...point, p95: point.p95Ms ?? 0 }))}
            kind="line"
            series={[{ key: "p95", label: "p95 response time", color: VIZ.violet }]}
            valueFormat={(value) => `${value} ms`}
            xFormat={minuteLabel}
            xKey="minute"
          />
        </ChartCard>
      </div>

      <p className="admEyebrow">Slowest &amp; failing endpoints</p>
      <div className="admGrid2">
        <Card flush subtitle={`Highest p95 response time, ${windowLabel} (endpoints with 3+ requests)`} title="Slowest endpoints">
          <RouteTable empty="Not enough traffic to rank endpoints yet." focus="latency" routes={traffic.slowest} />
        </Card>
        <Card flush subtitle={`Endpoints that returned errors, ${windowLabel}`} title="Endpoints with errors">
          <RouteTable empty="No errors in this window." focus="errors" routes={traffic.failing} />
        </Card>
      </div>

      <p className="admEyebrow">Infrastructure</p>
      <div className="admGrid2">
        <Card subtitle="Size, connections and how often reads are served from memory" title="Database">
          <div className="admMetricTiles">
            <MetricTile
              hint="share of reads from memory, not disk"
              icon={
                <Gauge
                  ratio={data.database.cacheHitRatio ?? 0}
                  tone={data.database.cacheHitRatio === null ? STATUS_HEX.blue : data.database.cacheHitRatio < 0.95 ? STATUS_HEX.amber : STATUS_HEX.green}
                  valueText={cacheHitText}
                />
              }
              label="Cache hit ratio"
              value={cacheHitText}
            />
            <MetricTile icon={<span aria-hidden="true" className="admMetricIcon admTone-blue"><ClockIcon /></span>} label="Round trip" value={ms(data.checks.database.latencyMs)} />
            <MetricTile icon={<span aria-hidden="true" className="admMetricIcon admTone-blue"><DatabaseIcon /></span>} label="Database size" value={data.database.sizeMb === null ? "–" : `${data.database.sizeMb} MB`} />
            <MetricTile icon={<span aria-hidden="true" className="admMetricIcon admTone-blue"><LayersIcon /></span>} label="Open connections" value={data.database.connections ?? "–"} />
            <MetricTile hint={data.database.poolWaiting > 0 ? `${data.database.poolWaiting} waiting` : undefined} icon={<span aria-hidden="true" className="admMetricIcon admTone-blue"><CpuIcon /></span>} label="API pool" value={`${data.database.poolTotal - data.database.poolIdle} / ${data.database.poolTotal}`} />
          </div>
        </Card>
        <Card subtitle="The API process that answered this request" title="API process">
          <div className="admMetricTiles">
            <MetricTile
              hint="p99 over the last minute"
              icon={
                <Gauge
                  ratio={Math.min(1, data.process.eventLoopP99Ms / 200)}
                  tone={data.process.eventLoopP99Ms > 200 ? STATUS_HEX.red : data.process.eventLoopP99Ms > 100 ? STATUS_HEX.amber : STATUS_HEX.green}
                  valueText={ms(data.process.eventLoopP99Ms)}
                />
              }
              label="Event loop delay"
              value={ms(data.process.eventLoopP99Ms)}
            />
            <MetricTile icon={<span aria-hidden="true" className="admMetricIcon admTone-violet"><CpuIcon /></span>} label="Memory (RSS)" value={`${data.process.rssMb} MB`} />
            <MetricTile
              hint={<span className="admInlineBarTrack admMetricBarTrack"><span className="admInlineBarFill" style={{ width: `${Math.min(100, (data.process.heapUsedMb / Math.max(1, data.process.heapTotalMb)) * 100)}%`, background: VIZ.violet }} /></span>}
              icon={<span aria-hidden="true" className="admMetricIcon admTone-violet"><CpuIcon /></span>}
              label="Heap used"
              value={`${data.process.heapUsedMb} / ${data.process.heapTotalMb} MB`}
            />
          </div>
          <p className="admMetricFootnote">Node.js {data.process.nodeVersion.replace(/^v/u, "")} · Redis {data.redis.version ? `v${data.redis.version}, ${data.redis.connectedClients ?? "–"} clients` : "–"}</p>
        </Card>
      </div>
      <p className="admMuted admSmall">Traffic figures come from the API process that answered, collected since {new Date(data.collectingSince).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}. They reset when it restarts and do not include other instances.</p>
    </>
  );
}
