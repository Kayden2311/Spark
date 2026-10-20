"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { useReducedMotion } from "../../_ui/viz/motion";
import { Bento, Tile } from "../_components/bento";
import { BarList, ChartCard, ChartLegend, Gauge, TrendChart } from "../_components/charts";
import { ClockIcon, CpuIcon, DatabaseIcon, LayersIcon, PulseIcon } from "../_components/icons";
import { TrendCards, type TrendCardItem } from "../_components/trend-cards";
import { Badge, Card, MetricTile, Segmented, SkeletonRows } from "../_components/ui";
import { formatCount, formatDuration, formatPercent, formatRelative, type Tone } from "../_lib/format";
import { VIZ } from "../_lib/palette";
import type { HealthCheck, SystemHealth } from "../_lib/types";
import { useAdminData } from "../_lib/use-admin-data";
import { useQueryState } from "../_lib/use-query-state";

/** Status colors, matched to the `.admTone-*` badge tones so a gauge and its badge always agree. */
const STATUS_HEX = { green: "#10b981", amber: "#f59e0b", red: "#ef4444", blue: "#2563eb" } as const;

const REFRESH_MS = 30_000;
/** A check that has not answered by now is treated as failed: a hung API is an outage too. */
const SLOW_MS = 20_000;
const WINDOWS = ["60", "360", "1440"] as const;
type Window = (typeof WINDOWS)[number];
const WINDOW_SHORT: Record<number, string> = { 60: "1h", 360: "6h", 1440: "24h" };
const WINDOW_LABEL: Record<number, string> = { 60: "last hour", 360: "last 6 hours", 1440: "last 24 hours" };

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

function CheckTile({ name, icon, check, lift, children }: { name: string; icon: ReactNode; check: HealthCheck; lift: boolean; children?: ReactNode }) {
  const state = CHECK_TONE[check.status];
  return (
    <li className={`admCheck admTone-${state.tone}${lift ? " admLift" : ""}`} data-status={check.status}>
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

/** An endpoint as "GET /api/v1/…", the method in a small caps tag. */
function RouteLabel({ route }: { route: string }) {
  const [method, ...path] = route.split(" ");
  return <span className="admRoute"><span className="admMethod">{method}</span><code>{path.join(" ")}</code></span>;
}

const plural = (count: number, word: string) => `${formatCount(count)} ${count === 1 ? word : `${word}s`}`;

/**
 * The four key numbers. Requests, error rate and p95 are drawn from the traffic buckets the health read
 * returns (in memory, reset when the API restarts). Active sessions has no history, so no sparkline, and
 * no card has a change chip because there is no earlier window to compare with.
 */
function trafficCards(data: SystemHealth | null, failed: boolean, window: number): TrendCardItem[] {
  const value = (format: (health: SystemHealth) => string) => (data ? format(data) : failed ? "–" : undefined);
  const traffic = data?.traffic;
  const buckets = traffic?.series ?? [];
  const errorRate = traffic && traffic.requests ? traffic.serverErrors / traffic.requests : 0;
  return [
    {
      label: `Requests, ${WINDOW_SHORT[traffic?.windowMinutes ?? window] ?? `${traffic?.windowMinutes ?? window} min`}`,
      value: value((health) => formatCount(health.traffic.requests)),
      dot: VIZ.blue,
      color: VIZ.blue,
      series: buckets.map((point) => point.requests),
    },
    {
      label: "Error rate",
      value: value(() => formatPercent(errorRate, 2)),
      dot: VIZ.orange,
      color: VIZ.orange,
      // A bucket with no requests had no errors either.
      series: buckets.map((point) => (point.requests ? point.serverErrors / point.requests : 0)),
      valueTone: errorRate > 0.05 ? "bad" : "default",
    },
    {
      label: "Response p95",
      value: value((health) => ms(health.traffic.p95Ms)),
      dot: VIZ.violet,
      color: VIZ.violet,
      // Buckets without requests have no p95; they are left out rather than drawn as 0 ms.
      series: buckets.flatMap((point) => (point.p95Ms === null ? [] : [point.p95Ms])),
      valueTone: (traffic?.p95Ms ?? 0) > 1000 ? "bad" : "default",
    },
    {
      label: "Active sessions",
      value: value((health) => (health.database.activeSessions === null ? "–" : formatCount(health.database.activeSessions))),
      dot: VIZ.aqua,
      color: VIZ.aqua,
    },
  ];
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
  const reduced = useReducedMotion();
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
  const data = health.data;
  const cards = trafficCards(data, failure !== null, Number(span));
  if (!data) {
    return (
      <>
        <TrendCards items={cards} label="Traffic numbers" />
        {failure ? <FailureBanner failure={failure} onRetry={reload} retrying={health.loading && !hung} /> : <SkeletonRows rows={6} />}
      </>
    );
  }
  const overall = failure ?? OVERALL[data.status];
  const traffic = data.traffic;
  // Labels follow the data on screen, not the window just picked (which may still be loading).
  const windowLabel = WINDOW_LABEL[traffic.windowMinutes] ?? `last ${traffic.windowMinutes} minutes`;
  const perBucket = traffic.stepMinutes === 1 ? "per minute" : `per ${traffic.stepMinutes} minutes`;
  const charted = traffic.series.reduce((sum, point) => sum + point.requests, 0);
  const series = traffic.series.map((point) => ({ ...point, ok: point.requests - point.clientErrors - point.serverErrors }));
  const cacheHit = data.database.cacheHitRatio;
  const cacheHitText = cacheHit === null ? "–" : formatPercent(cacheHit, 1);
  const heapRatio = data.process.heapUsedMb / Math.max(1, data.process.heapTotalMb);

  return (
    <>
      <TrendCards items={cards} label="Traffic numbers" />
      <Bento label="System health">
        <Tile span={12}>
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
        </Tile>
        <Tile lift={false} span={12}>
          {/* The three live checks sit side by side (stacked on tablets and phones) and stay one list. */}
          <ul aria-label="Service checks" className="admChecks" data-stale={failure ? "true" : undefined}>
            <CheckTile check={data.checks.api} icon={<PulseIcon />} lift={!reduced} name="API">
              <div><dt>Uptime</dt><dd>{formatDuration(data.process.uptimeSeconds)}</dd></div>
            </CheckTile>
            <CheckTile check={data.checks.database} icon={<DatabaseIcon />} lift={!reduced} name="PostgreSQL">
              <div><dt>Pool in use</dt><dd>{data.database.poolTotal - data.database.poolIdle} / {data.database.poolTotal}{data.database.poolWaiting > 0 ? `, ${data.database.poolWaiting} waiting` : ""}</dd></div>
            </CheckTile>
            <CheckTile check={data.checks.redis} icon={<LayersIcon />} lift={!reduced} name="Redis (rate limits)">
              <div><dt>Memory</dt><dd>{data.redis.usedMemoryMb === null ? "–" : `${data.redis.usedMemoryMb} MB`}</dd></div>
            </CheckTile>
          </ul>
        </Tile>
        <Tile span={8}>
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
        </Tile>
        <Tile span={4}>
          <ChartCard
            empty={charted === 0}
            emptyText="No requests in this window yet."
            subtitle={`95th percentile ${perBucket}`}
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
        </Tile>
        <Tile span={6}>
          <ChartCard
            empty={traffic.slowest.length === 0}
            emptyText="Not enough traffic to rank endpoints yet."
            height={120}
            subtitle={`Highest p95, ${windowLabel} (3+ requests)`}
            table={{ columns: ["Endpoint", "p95 (ms)", "Average (ms)", "Requests"], rows: traffic.slowest.map((route) => [route.route, route.p95Ms ?? "–", Math.round(route.avgMs), route.requests]) }}
            title="Slowest endpoints"
          >
            <BarList
              color={VIZ.violet}
              items={traffic.slowest.map((route) => ({ key: route.route, label: <RouteLabel route={route.route} />, value: route.p95Ms ?? 0, hint: `avg ${ms(route.avgMs)} · ${plural(route.requests, "request")}` }))}
              share={false}
              valueFormat={ms}
            />
          </ChartCard>
        </Tile>
        <Tile span={6}>
          <ChartCard
            empty={traffic.failing.length === 0}
            emptyText="No errors in this window."
            height={120}
            subtitle={`5xx and 4xx responses, ${windowLabel}`}
            table={{ columns: ["Endpoint", "5xx", "4xx", "Requests"], rows: traffic.failing.map((route) => [route.route, route.serverErrors, route.clientErrors, route.requests]) }}
            title="Endpoints with errors"
          >
            <BarList
              color={STATUS_HEX.red}
              items={traffic.failing.map((route) => ({ key: route.route, label: <RouteLabel route={route.route} />, value: route.serverErrors + route.clientErrors, hint: `${route.serverErrors} 5xx · ${route.clientErrors} 4xx` }))}
            />
          </ChartCard>
        </Tile>
        <Tile span={6}>
          <Card subtitle="Size, connections and how often reads are served from memory" title="Database">
            <div className="admMetricTiles">
              <MetricTile
                hint="share of reads from memory, not disk"
                icon={<Gauge ratio={cacheHit ?? 0} tone={cacheHit === null ? STATUS_HEX.blue : cacheHit < 0.95 ? STATUS_HEX.amber : STATUS_HEX.green} valueText={cacheHitText} />}
                label="Cache hit ratio"
                value={cacheHitText}
              />
              <MetricTile icon={<span aria-hidden="true" className="admMetricIcon admTone-blue"><ClockIcon /></span>} label="Round trip" value={ms(data.checks.database.latencyMs)} />
              <MetricTile icon={<span aria-hidden="true" className="admMetricIcon admTone-blue"><DatabaseIcon /></span>} label="Database size" value={data.database.sizeMb === null ? "–" : `${data.database.sizeMb} MB`} />
              <MetricTile icon={<span aria-hidden="true" className="admMetricIcon admTone-blue"><LayersIcon /></span>} label="Open connections" value={data.database.connections ?? "–"} />
              <MetricTile hint={data.database.poolWaiting > 0 ? `${data.database.poolWaiting} waiting` : undefined} icon={<span aria-hidden="true" className="admMetricIcon admTone-blue"><CpuIcon /></span>} label="API pool" value={`${data.database.poolTotal - data.database.poolIdle} / ${data.database.poolTotal}`} />
            </div>
          </Card>
        </Tile>
        <Tile span={6}>
          <Card subtitle="The API process that answered this request" title="API process">
            <div className="admMetricTiles">
              <MetricTile
                hint="of the JavaScript heap in use"
                // No warning colour: V8 grows the committed heap (heapTotal) only as needed, so 85–95% in use is normal.
                icon={<Gauge ratio={heapRatio} tone={VIZ.violet} valueText={formatPercent(heapRatio)} />}
                label="Heap used"
                value={`${data.process.heapUsedMb} / ${data.process.heapTotalMb} MB`}
              />
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
            </div>
            <p className="admMetricFootnote">Node.js {data.process.nodeVersion.replace(/^v/u, "")} · Redis {data.redis.version ? `v${data.redis.version}, ${data.redis.connectedClients ?? "–"} clients` : "–"}</p>
          </Card>
        </Tile>
      </Bento>
      <p className="admMuted admSmall">Traffic figures come from the API process that answered, collected since {new Date(data.collectingSince).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}. They reset when it restarts and do not include other instances.</p>
    </>
  );
}
