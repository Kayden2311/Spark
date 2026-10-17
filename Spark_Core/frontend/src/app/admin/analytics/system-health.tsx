"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { ChartCard, ChartLegend, TrendChart } from "../_components/charts";
import { AlertIcon, ClockIcon, PulseIcon, ShieldIcon } from "../_components/icons";
import { Badge, Card, KpiCards, Segmented, SkeletonRows } from "../_components/ui";
import { formatCount, formatDuration, formatPercent, formatRelative, type Tone } from "../_lib/format";
import { VIZ } from "../_lib/palette";
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

function CheckTile({ name, check, children }: { name: string; check: HealthCheck; children?: ReactNode }) {
  const state = CHECK_TONE[check.status];
  return (
    <li className="admCheck" data-status={check.status}>
      <div className="admCheckTop">
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

function RouteTable({ routes, empty, focus }: { routes: RouteSummary[]; empty: string; focus: "latency" | "errors" }) {
  if (routes.length === 0) return <p className="admCardEmpty">{empty}</p>;
  return (
    <table className="admTable admRouteTable">
      <thead>
        <tr>
          <th scope="col">Endpoint</th>
          <th className="admNum" scope="col">Requests</th>
          {focus === "errors" ? <><th className="admNum" scope="col">5xx</th><th className="admNum" scope="col">4xx</th></> : <><th className="admNum" scope="col">Average</th><th className="admNum" scope="col">p95</th></>}
        </tr>
      </thead>
      <tbody>
        {routes.map((route) => {
          const [method, ...path] = route.route.split(" ");
          return (
            <tr key={route.route}>
              <td data-label="Endpoint"><span className="admRoute"><span className="admMethod">{method}</span><code>{path.join(" ")}</code></span></td>
              <td className="admNum" data-label="Requests">{formatCount(route.requests)}</td>
              {focus === "errors" ? (
                <>
                  <td className="admNum" data-label="5xx">{route.serverErrors > 0 ? <Badge tone="red">{route.serverErrors}</Badge> : 0}</td>
                  <td className="admNum" data-label="4xx">{route.clientErrors}</td>
                </>
              ) : (
                <>
                  <td className="admNum" data-label="Average">{ms(route.avgMs)}</td>
                  <td className="admNum" data-label="p95">{route.p95Ms !== null && route.p95Ms > 1000 ? <Badge tone="amber">{ms(route.p95Ms)}</Badge> : ms(route.p95Ms)}</td>
                </>
              )}
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
      <ul aria-label="Service checks" className="admChecks" data-stale={failure ? "true" : undefined}>
        <CheckTile check={data.checks.api} name="API">
          <div><dt>Uptime</dt><dd>{formatDuration(data.process.uptimeSeconds)}</dd></div>
        </CheckTile>
        <CheckTile check={data.checks.database} name="PostgreSQL">
          <div><dt>Pool in use</dt><dd>{data.database.poolTotal - data.database.poolIdle} / {data.database.poolTotal}{data.database.poolWaiting > 0 ? `, ${data.database.poolWaiting} waiting` : ""}</dd></div>
        </CheckTile>
        <CheckTile check={data.checks.redis} name="Redis (rate limits)">
          <div><dt>Memory</dt><dd>{data.redis.usedMemoryMb === null ? "–" : `${data.redis.usedMemoryMb} MB`}</dd></div>
        </CheckTile>
      </ul>

      <KpiCards
        items={[
          { label: `Requests, ${windowLabel}`, value: formatCount(traffic.requests), hint: `${formatCount(traffic.clientErrors)} client errors (4xx)`, icon: <PulseIcon />, tone: "blue", trend: { values: traffic.series.map((point) => point.requests), color: VIZ.blue } },
          { label: "Server error rate", value: formatPercent(errorRate, 2), hint: `${formatCount(traffic.serverErrors)} responses with 5xx`, icon: <AlertIcon />, tone: errorRate > 0.05 ? "red" : errorRate > 0 ? "amber" : "green" },
          { label: "Response time (p95)", value: ms(traffic.p95Ms), hint: `Median ${ms(traffic.p50Ms)}`, icon: <ClockIcon />, tone: (traffic.p95Ms ?? 0) > 1000 ? "amber" : "violet", trend: { values: traffic.series.map((point) => point.p95Ms ?? 0), color: VIZ.violet } },
          { label: "Active sessions", value: data.database.activeSessions === null ? "–" : formatCount(data.database.activeSessions), hint: "Signed-in browsers right now", icon: <ShieldIcon />, tone: "green" },
        ]}
        label="Traffic summary"
      />

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

      <div className="admGrid2">
        <Card flush subtitle={`Highest p95 response time, ${windowLabel} (endpoints with 3+ requests)`} title="Slowest endpoints">
          <RouteTable empty="Not enough traffic to rank endpoints yet." focus="latency" routes={traffic.slowest} />
        </Card>
        <Card flush subtitle={`Endpoints that returned errors, ${windowLabel}`} title="Endpoints with errors">
          <RouteTable empty="No errors in this window." focus="errors" routes={traffic.failing} />
        </Card>
      </div>

      <div className="admGrid3">
        <Card subtitle="Size, connections and how often reads are served from memory" title="Database">
          <ul className="admStatList">
            <li><span>Round trip</span><strong>{ms(data.checks.database.latencyMs)}</strong></li>
            <li><span>Database size</span><strong>{data.database.sizeMb === null ? "–" : `${data.database.sizeMb} MB`}</strong></li>
            <li><span>Open connections</span><strong>{data.database.connections ?? "–"}</strong></li>
            <li><span>Cache hit ratio</span>{data.database.cacheHitRatio === null ? <strong>–</strong> : data.database.cacheHitRatio < 0.95 ? <Badge tone="amber">{formatPercent(data.database.cacheHitRatio, 1)}</Badge> : <strong>{formatPercent(data.database.cacheHitRatio, 1)}</strong>}</li>
            <li><span>API pool</span><strong>{data.database.poolTotal - data.database.poolIdle} busy · {data.database.poolIdle} idle</strong></li>
          </ul>
        </Card>
        <Card subtitle="The API process that answered this request" title="API process">
          <ul className="admStatList">
            <li><span>Memory (RSS)</span><strong>{data.process.rssMb} MB</strong></li>
            <li><span>Heap used</span><strong>{data.process.heapUsedMb} / {data.process.heapTotalMb} MB</strong></li>
            <li><span>Event loop delay (p99)</span>{data.process.eventLoopP99Ms > 200 ? <Badge tone="amber">{ms(data.process.eventLoopP99Ms)}</Badge> : <strong>{ms(data.process.eventLoopP99Ms)}</strong>}</li>
            <li><span>Runtime</span><strong>Node.js {data.process.nodeVersion.replace(/^v/u, "")}</strong></li>
            <li><span>Redis</span><strong>{data.redis.version ? `v${data.redis.version} · ${data.redis.connectedClients ?? "–"} clients` : "–"}</strong></li>
          </ul>
        </Card>
      </div>
      <p className="admMuted admSmall">Traffic figures come from the API process that answered, collected since {new Date(data.collectingSince).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}. They reset when it restarts and do not include other instances.</p>
    </>
  );
}
