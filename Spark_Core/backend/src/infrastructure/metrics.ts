import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

/** Latency bucket upper bounds in milliseconds; the last bucket is open-ended. */
const BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const;
const MINUTE = 60_000;
const KEEP_MINUTES = 24 * 60;

interface Stats {
  count: number;
  clientErrors: number;
  serverErrors: number;
  totalMs: number;
  buckets: number[];
}

function emptyStats(): Stats {
  return { count: 0, clientErrors: 0, serverErrors: 0, totalMs: 0, buckets: new Array<number>(BOUNDS.length + 1).fill(0) };
}

function add(stats: Stats, status: number, ms: number): void {
  stats.count += 1;
  if (status >= 500) stats.serverErrors += 1;
  else if (status >= 400) stats.clientErrors += 1;
  stats.totalMs += ms;
  const index = BOUNDS.findIndex((bound) => ms <= bound);
  stats.buckets[index === -1 ? BOUNDS.length : index]! += 1;
}

function merge(into: Stats, from: Stats): void {
  into.count += from.count;
  into.clientErrors += from.clientErrors;
  into.serverErrors += from.serverErrors;
  into.totalMs += from.totalMs;
  from.buckets.forEach((value, index) => { into.buckets[index]! += value; });
}

/** Percentile estimated from the latency buckets: the upper bound of the bucket holding that rank. */
function percentile(stats: Stats, p: number): number | null {
  if (stats.count === 0) return null;
  const rank = Math.ceil(stats.count * p);
  let seen = 0;
  for (let index = 0; index < stats.buckets.length; index++) {
    seen += stats.buckets[index]!;
    if (seen >= rank) return index < BOUNDS.length ? BOUNDS[index]! : BOUNDS[BOUNDS.length - 1]! * 2;
  }
  return null;
}

export interface MinutePoint {
  /** Start of the bucket (one or more minutes). */
  minute: string;
  requests: number;
  clientErrors: number;
  serverErrors: number;
  p95Ms: number | null;
}

export interface RouteSummary {
  route: string;
  requests: number;
  serverErrors: number;
  clientErrors: number;
  avgMs: number;
  p95Ms: number | null;
}

/**
 * Request metrics for this API process, kept in memory: per-minute buckets for the last 24 hours and
 * per-route totals for the same window. They reset when the process restarts and cover only this instance.
 */
export class RequestMetrics {
  private readonly minutes = new Map<number, { all: Stats; routes: Map<string, Stats> }>();
  private readonly startedAt: number;
  private readonly loop: IntervalHistogram;
  private readonly loopTimer: NodeJS.Timeout;
  private lastLoop: { p99Ms: number; maxMs: number } | null = null;

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
    this.loop = monitorEventLoopDelay({ resolution: 20 });
    this.loop.enable();
    // Event-loop delay is measured in fixed one-minute windows, so reading it never resets what others see.
    this.loopTimer = setInterval(() => {
      this.lastLoop = this.readLoop();
      this.loop.reset();
    }, MINUTE);
    this.loopTimer.unref();
  }

  private readLoop(): { p99Ms: number; maxMs: number } {
    return { p99Ms: Math.round(this.loop.percentile(99) / 1e5) / 10, maxMs: Math.round(this.loop.max / 1e5) / 10 };
  }

  record(method: string, route: string, status: number, ms: number): void {
    const minute = Math.floor(this.now() / MINUTE) * MINUTE;
    let slot = this.minutes.get(minute);
    if (!slot) {
      slot = { all: emptyStats(), routes: new Map() };
      this.minutes.set(minute, slot);
      this.prune(minute);
    }
    add(slot.all, status, ms);
    const key = `${method} ${route}`;
    let routeStats = slot.routes.get(key);
    if (!routeStats) slot.routes.set(key, (routeStats = emptyStats()));
    add(routeStats, status, ms);
  }

  private prune(current: number): void {
    const oldest = current - KEEP_MINUTES * MINUTE;
    for (const minute of this.minutes.keys()) if (minute < oldest) this.minutes.delete(minute);
  }

  /**
   * Series covering the whole of the last `minutes` minutes, oldest first, including empty buckets.
   * Buckets are `step` minutes wide so the series has at most `maxPoints` points.
   */
  series(minutes: number, maxPoints = 180): { step: number; points: MinutePoint[] } {
    const step = Math.max(1, Math.ceil(minutes / maxPoints));
    const count = Math.ceil(minutes / step);
    const current = Math.floor(this.now() / MINUTE) * MINUTE;
    const first = current - (count * step - 1) * MINUTE;
    const points = Array.from({ length: count }, (_, index) => {
      const start = first + index * step * MINUTE;
      const stats = emptyStats();
      for (let offset = 0; offset < step; offset++) {
        const slot = this.minutes.get(start + offset * MINUTE);
        if (slot) merge(stats, slot.all);
      }
      return { minute: new Date(start).toISOString(), requests: stats.count, clientErrors: stats.clientErrors, serverErrors: stats.serverErrors, p95Ms: percentile(stats, 0.95) };
    });
    return { step, points };
  }

  /** Totals and per-route summaries over the last `minutes` minutes. */
  summary(minutes: number): { requests: number; clientErrors: number; serverErrors: number; p50Ms: number | null; p95Ms: number | null; routes: RouteSummary[] } {
    const since = Math.floor(this.now() / MINUTE) * MINUTE - (minutes - 1) * MINUTE;
    const total = emptyStats();
    const routes = new Map<string, Stats>();
    for (const [minute, slot] of this.minutes) {
      if (minute < since) continue;
      merge(total, slot.all);
      for (const [key, stats] of slot.routes) {
        let into = routes.get(key);
        if (!into) routes.set(key, (into = emptyStats()));
        merge(into, stats);
      }
    }
    return {
      requests: total.count,
      clientErrors: total.clientErrors,
      serverErrors: total.serverErrors,
      p50Ms: percentile(total, 0.5),
      p95Ms: percentile(total, 0.95),
      routes: [...routes.entries()].map(([route, stats]) => ({
        route,
        requests: stats.count,
        serverErrors: stats.serverErrors,
        clientErrors: stats.clientErrors,
        avgMs: stats.count ? Math.round((stats.totalMs / stats.count) * 10) / 10 : 0,
        p95Ms: percentile(stats, 0.95),
      })),
    };
  }

  /** Event-loop delay over the last completed minute (or the current one right after start-up). */
  eventLoop(): { p99Ms: number; maxMs: number } {
    return this.lastLoop ?? this.readLoop();
  }

  get collectingSince(): Date {
    return new Date(this.startedAt);
  }

  close(): void {
    clearInterval(this.loopTimer);
    this.loop.disable();
  }
}
