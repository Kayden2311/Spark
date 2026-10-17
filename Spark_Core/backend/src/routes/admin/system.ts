import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Pool } from "pg";

import type { RequestMetrics } from "../../infrastructure/metrics.js";
import { problem } from "../responses.js";
import { ADMINS, type StaffGuard } from "./guard.js";

type CheckStatus = "ok" | "degraded" | "down" | "unknown";

const num = { type: ["number", "null"] } as const;
const check = {
  type: "object",
  properties: { status: { type: "string", enum: ["ok", "degraded", "down", "unknown"] }, latencyMs: num, detail: { type: "string" } },
} as const;

const healthResponse = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["operational", "degraded", "down"] },
    checkedAt: { type: "string", format: "date-time" },
    collectingSince: { type: "string", format: "date-time" },
    checks: { type: "object", properties: { api: check, database: check, redis: check } },
    process: {
      type: "object",
      properties: {
        nodeVersion: { type: "string" },
        uptimeSeconds: { type: "integer" },
        rssMb: { type: "number" },
        heapUsedMb: { type: "number" },
        heapTotalMb: { type: "number" },
        eventLoopP99Ms: { type: "number" },
        eventLoopMaxMs: { type: "number" },
      },
    },
    database: {
      type: "object",
      properties: {
        poolTotal: { type: "integer" },
        poolIdle: { type: "integer" },
        poolWaiting: { type: "integer" },
        sizeMb: num,
        connections: num,
        cacheHitRatio: num,
        activeSessions: num,
      },
    },
    redis: { type: "object", properties: { usedMemoryMb: num, connectedClients: num, version: { type: ["string", "null"] } } },
    traffic: {
      type: "object",
      properties: {
        windowMinutes: { type: "integer" },
        stepMinutes: { type: "integer" },
        requests: { type: "integer" },
        clientErrors: { type: "integer" },
        serverErrors: { type: "integer" },
        p50Ms: num,
        p95Ms: num,
        series: {
          type: "array",
          items: { type: "object", properties: { minute: { type: "string" }, requests: { type: "integer" }, clientErrors: { type: "integer" }, serverErrors: { type: "integer" }, p95Ms: num } },
        },
        slowest: { type: "array", items: { $ref: "routeSummary#" } },
        failing: { type: "array", items: { $ref: "routeSummary#" } },
      },
    },
  },
} as const;

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await work();
  return { value, ms: Math.round((performance.now() - start) * 10) / 10 };
}

/** Reads one `key:value` line from Redis INFO output. */
function infoValue(info: string, key: string): string | null {
  const line = info.split(/\r?\n/u).find((entry) => entry.startsWith(`${key}:`));
  return line ? line.slice(key.length + 1).trim() : null;
}

/** Errors that mean PostgreSQL itself is unreachable, as opposed to a bug or a permission problem. */
function isConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && (code.startsWith("08") || code === "57P01" || code === "57P03" || ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(code))) return true;
  return error instanceof Error && /timeout exceeded when trying to connect|Connection terminated/iu.test(error.message);
}

/**
 * The health route does not use the Redis-backed rate limiter, so it can still report a Redis outage.
 * This small in-process limit (per client address) keeps it from being hammered instead.
 */
const HEALTH_LIMIT = 30;

function createHealthLimiter() {
  const hits = new Map<string, { start: number; count: number }>();
  return (key: string, now = Date.now()): boolean => {
    const entry = hits.get(key);
    if (!entry || now - entry.start >= 60_000) {
      if (hits.size >= 1000) {
        for (const [k, v] of hits) if (now - v.start >= 60_000) hits.delete(k);
        // Still full of live entries: drop the oldest (Map keeps insertion order), so memory stays bounded.
        while (hits.size >= 1000) hits.delete(hits.keys().next().value!);
      }
      hits.delete(key);
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= HEALTH_LIMIT;
  };
}

export interface SystemDeps {
  pool: Pool;
  redis?: Redis | undefined;
  metrics?: RequestMetrics | undefined;
}

export function registerSystemRoutes(app: FastifyInstance, guard: StaffGuard, deps: SystemDeps): void {
  const healthAllowed = createHealthLimiter();
  app.addSchema({
    $id: "routeSummary",
    type: "object",
    properties: { route: { type: "string" }, requests: { type: "integer" }, serverErrors: { type: "integer" }, clientErrors: { type: "integer" }, avgMs: { type: "number" }, p95Ms: num },
  });

  // Platform health for admins: API traffic and errors, database, Redis and the API process itself.
  app.get<{ Querystring: { minutes: number } }>(
    "/api/v1/admin/system/health",
    {
      config: { rateLimit: false },
      schema: {
        querystring: { type: "object", properties: { minutes: { type: "integer", minimum: 15, maximum: 1440, default: 60 } }, additionalProperties: false },
        response: { 200: healthResponse },
      },
    },
    async (request, reply) => {
      if (!healthAllowed(request.ip)) {
        reply.header("Retry-After", "60");
        return problem(request, reply, 429, "Too Many Requests", "rate_limited", "Too many health checks. Wait a minute and try again.");
      }
      let staff: Awaited<ReturnType<StaffGuard["authorize"]>>;
      try {
        staff = await guard.authorize(request, reply, ADMINS);
      } catch (error) {
        // Checking the session needs the database. When it is unreachable, say so plainly instead of a generic 500.
        if (!isConnectionError(error)) throw error;
        request.log.error({ err: error }, "Health check could not reach the database");
        reply.header("Cache-Control", "private, no-store");
        return problem(request, reply, 503, "Service Unavailable", "database_unavailable", "Spark's database is not reachable, so most of Spark is down.");
      }
      if (!staff) return reply;
      const minutes = request.query.minutes;

      // Database: round trip plus server statistics, read inside the caller's session like every staff query.
      let database: { status: CheckStatus; latencyMs: number | null; detail: string; sizeMb: number | null; connections: number | null; cacheHitRatio: number | null; activeSessions: number | null };
      try {
        const result = await guard.run(request, reply, staff, async (client) => {
          const ping = await timed(() => client.query("SELECT 1"));
          const stats = await client.query<{ size: string; connections: string; hits: string | null; reads: string | null }>(
            `SELECT pg_database_size(current_database())::text AS size,
               (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::text AS connections,
               (SELECT blks_hit::text FROM pg_stat_database WHERE datname = current_database()) AS hits,
               (SELECT blks_read::text FROM pg_stat_database WHERE datname = current_database()) AS reads`,
          );
          const sessions = await client.query<{ total: string }>("SELECT spark.staff_active_session_count() AS total");
          return { ms: ping.ms, row: stats.rows[0], sessions: Number(sessions.rows[0]?.total ?? 0) };
        });
        if (reply.sent) return reply;
        const hits = Number(result?.row?.hits ?? 0);
        const reads = Number(result?.row?.reads ?? 0);
        database = {
          status: (result?.ms ?? 0) > 250 ? "degraded" : "ok",
          latencyMs: result?.ms ?? null,
          detail: (result?.ms ?? 0) > 250 ? "Slow round trip" : "Responding",
          sizeMb: result?.row ? mb(Number(result.row.size)) : null,
          connections: result?.row ? Number(result.row.connections) : null,
          cacheHitRatio: hits + reads > 0 ? Math.round((hits / (hits + reads)) * 10_000) / 10_000 : null,
          activeSessions: result?.sessions ?? null,
        };
      } catch (error) {
        // Only an unreachable database is reported as down; any other failure is a bug and stays a 500.
        if (!isConnectionError(error)) throw error;
        request.log.warn({ err: error }, "Database health check failed");
        database = { status: "down", latencyMs: null, detail: "Not reachable", sizeMb: null, connections: null, cacheHitRatio: null, activeSessions: null };
      }

      // Redis backs rate limiting. When it is down, rate-limited API requests fail until it recovers.
      let redis: { status: CheckStatus; latencyMs: number | null; detail: string; usedMemoryMb: number | null; connectedClients: number | null; version: string | null };
      if (!deps.redis) {
        redis = { status: "unknown", latencyMs: null, detail: "Not configured for this process", usedMemoryMb: null, connectedClients: null, version: null };
      } else {
        try {
          const ping = await timed(() => deps.redis!.ping());
          const info = await deps.redis.info();
          const memory = infoValue(info, "used_memory");
          const clients = infoValue(info, "connected_clients");
          redis = {
            status: ping.ms > 100 ? "degraded" : "ok",
            latencyMs: ping.ms,
            detail: ping.ms > 100 ? "Slow round trip" : "Responding",
            usedMemoryMb: memory ? mb(Number(memory)) : null,
            connectedClients: clients ? Number(clients) : null,
            version: infoValue(info, "redis_version"),
          };
        } catch {
          redis = { status: "down", latencyMs: null, detail: "Not reachable; most API requests fail until it recovers", usedMemoryMb: null, connectedClients: null, version: null };
        }
      }

      const summary = deps.metrics?.summary(minutes);
      const series = deps.metrics?.series(minutes) ?? { step: 1, points: [] };
      const loop = deps.metrics?.eventLoop() ?? { p99Ms: 0, maxMs: 0 };
      const errorRate = summary && summary.requests > 0 ? summary.serverErrors / summary.requests : 0;
      const apiStatus: CheckStatus = !deps.metrics ? "unknown" : errorRate > 0.05 || (summary?.p95Ms ?? 0) > 1000 || loop.p99Ms > 200 ? "degraded" : "ok";
      const memory = process.memoryUsage();
      const overall = database.status === "down" ? "down" : [apiStatus, database.status, redis.status].some((status) => status === "degraded" || status === "down") ? "degraded" : "operational";

      return {
        status: overall,
        checkedAt: new Date().toISOString(),
        collectingSince: (deps.metrics?.collectingSince ?? new Date()).toISOString(),
        checks: {
          api: {
            status: apiStatus,
            latencyMs: summary?.p95Ms ?? null,
            detail: apiStatus === "degraded" ? (errorRate > 0.05 ? "High server error rate" : "Slow responses") : apiStatus === "ok" ? "Serving requests" : "Metrics not collected",
          },
          database: { status: database.status, latencyMs: database.latencyMs, detail: database.detail },
          redis: { status: redis.status, latencyMs: redis.latencyMs, detail: redis.detail },
        },
        process: {
          nodeVersion: process.version,
          uptimeSeconds: Math.floor(process.uptime()),
          rssMb: mb(memory.rss),
          heapUsedMb: mb(memory.heapUsed),
          heapTotalMb: mb(memory.heapTotal),
          eventLoopP99Ms: loop.p99Ms,
          eventLoopMaxMs: loop.maxMs,
        },
        database: {
          poolTotal: deps.pool.totalCount,
          poolIdle: deps.pool.idleCount,
          poolWaiting: deps.pool.waitingCount,
          sizeMb: database.sizeMb,
          connections: database.connections,
          cacheHitRatio: database.cacheHitRatio,
          activeSessions: database.activeSessions,
        },
        redis: { usedMemoryMb: redis.usedMemoryMb, connectedClients: redis.connectedClients, version: redis.version },
        traffic: {
          windowMinutes: minutes,
          stepMinutes: series.step,
          requests: summary?.requests ?? 0,
          clientErrors: summary?.clientErrors ?? 0,
          serverErrors: summary?.serverErrors ?? 0,
          p50Ms: summary?.p50Ms ?? null,
          p95Ms: summary?.p95Ms ?? null,
          series: series.points,
          slowest: [...(summary?.routes ?? [])].filter((route) => route.requests >= 3).sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0) || b.avgMs - a.avgMs).slice(0, 6),
          failing: [...(summary?.routes ?? [])].filter((route) => route.serverErrors + route.clientErrors > 0).sort((a, b) => b.serverErrors - a.serverErrors || b.clientErrors - a.clientErrors).slice(0, 6),
        },
      };
    },
  );
}
