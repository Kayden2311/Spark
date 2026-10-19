import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";

import type { AppConfig, AuthConfig } from "./config.js";
import { registerAdminRoutes } from "./routes/admin/index.js";
import { registerWorkspaceRoutes } from "./routes/workspace/index.js";
import { registerOriginGuard } from "./routes/origin-guard.js";
import { registerCredentialRoutes } from "./routes/auth-credentials.js";
import { registerAuthProxyRoutes } from "./routes/auth-proxy.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerHealthRoute } from "./routes/health.js";
import { RequestMetrics } from "./infrastructure/metrics.js";

export interface BuildAppOptions {
  readonly config: AppConfig;
  /** Runtime pool (spark_app). */
  readonly pool?: Pool;
  readonly redis?: Redis;
  readonly rateLimit?: boolean;
  readonly logger?: boolean;
  /** Overrides fetch for the auth-service forwarding routes (tests). */
  readonly fetchImpl?: typeof fetch;
  /** Request metrics shown on the admin system health page; one is created when omitted. */
  readonly metrics?: RequestMetrics;
}

export interface BuildAuthAppOptions {
  readonly config: AuthConfig;
  /** Login-only pool (spark_auth). */
  readonly pool?: Pool;
  readonly redis?: Redis;
  readonly rateLimit?: boolean;
  readonly logger?: boolean;
}

interface BaseAppOptions {
  readonly title: string;
  readonly logLevel: string;
  readonly trustedProxies: readonly string[];
  readonly corsOrigins?: readonly string[];
  /** Accept a UUID X-Request-Id from the caller (only the trusted API reaches the auth process). */
  readonly acceptRequestId?: boolean;
  readonly rateLimitMax: number;
  readonly rateLimitWindowMs: number;
  /** Redis key prefix; each process needs its own so one request is not counted twice. */
  readonly rateLimitNamespace: string;
  readonly redis?: Redis | undefined;
  readonly rateLimit?: boolean | undefined;
  readonly logger?: boolean | undefined;
}

function statusCode(error: unknown): number {
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  ) {
    return error.statusCode;
  }
  return 500;
}

function problemTitle(code: number): string {
  switch (code) {
    case 400: return "Bad Request";
    case 401: return "Unauthorized";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 409: return "Conflict";
    case 429: return "Too Many Requests";
    case 500: return "Internal Server Error";
    default: return code >= 500 ? "Internal Server Error" : "Request Failed";
  }
}

function problemCode(code: number): string {
  switch (code) {
    case 400: return "bad_request";
    case 401: return "unauthenticated";
    case 403: return "forbidden";
    case 404: return "not_found";
    case 409: return "conflict";
    case 429: return "rate_limit_exceeded";
    case 500: return "internal_error";
    default: return code >= 500 ? "internal_error" : "request_failed";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

async function createBaseApp(options: BaseAppOptions): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: options.logLevel,
            redact: [
              "req.headers.authorization",
              "req.headers.cookie",
              "res.headers.set-cookie",
            ],
          },
    trustProxy: options.trustedProxies.length > 0 ? [...options.trustedProxies] : false,
    bodyLimit: 1_048_576,
    requestIdHeader: false,
    genReqId: (request) => {
      const incoming = request.headers["x-request-id"];
      return options.acceptRequestId && typeof incoming === "string" && UUID.test(incoming) ? incoming : randomUUID();
    },
  });

  app.addHook("onSend", async (request, reply) => {
    reply.header("X-Request-Id", request.id);
  });

  app.setErrorHandler(async (error, request, reply) => {
    const code = statusCode(error);
    if (code >= 500) {
      request.log.error({ err: error }, "Request failed");
    }
    const message =
      typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
        ? error.message
        : "The request could not be processed.";

    return reply
      .code(code)
      .header("Cache-Control", "private, no-store")
      .type("application/problem+json")
      .send({
        type: "about:blank",
        title: problemTitle(code),
        status: code,
        code: problemCode(code),
        detail: code === 500 ? "An unexpected error occurred." : message,
        instance: request.url,
        requestId: request.id,
      });
  });

  await app.register(swagger, {
    openapi: { info: { title: options.title, version: "0.1.0" } },
  });
  await app.register(helmet);
  if (options.corsOrigins) {
    await app.register(cors, {
      credentials: true,
      origin: [...options.corsOrigins],
    });
  }

  if (options.rateLimit !== false) {
    if (!options.redis) throw new Error("Redis is required for rate limiting");
    await app.register(rateLimit, {
      redis: options.redis,
      global: true,
      max: options.rateLimitMax,
      timeWindow: options.rateLimitWindowMs,
      nameSpace: options.rateLimitNamespace,
      skipOnError: false,
    });
  }

  registerHealthRoute(app);

  app.setNotFoundHandler(async (request, reply) =>
    reply
      .code(404)
      .header("Cache-Control", "private, no-store")
      .type("application/problem+json")
      .send({
        type: "about:blank",
        title: "Not Found",
        status: 404,
        code: "not_found",
        detail: "The requested resource was not found.",
        instance: request.url,
        requestId: request.id,
      }),
  );

  return app;
}

/** Public API process: runtime pool only; credential routes are forwarded to the auth process. */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options;
  const app = await createBaseApp({
    title: "Spark API",
    rateLimitNamespace: "spark-api-rate-limit-",
    logLevel: config.logLevel,
    trustedProxies: config.trustedProxies,
    corsOrigins: config.corsOrigins,
    rateLimitMax: config.rateLimitMax,
    rateLimitWindowMs: config.rateLimitWindowMs,
    redis: options.redis,
    rateLimit: options.rateLimit,
    logger: options.logger,
  });
  const metrics = options.metrics ?? new RequestMetrics();
  // Route patterns, not raw URLs, so ids in paths do not create one entry per item.
  app.addHook("onResponse", async (request, reply) => {
    metrics.record(request.method, request.routeOptions.url ?? "unmatched", reply.statusCode, reply.elapsedTime);
  });
  app.addHook("onClose", async () => metrics.close());
  registerOriginGuard(app, config.corsOrigins);
  registerAuthProxyRoutes(app, { authServiceUrl: config.authServiceUrl, fetchImpl: options.fetchImpl });
  if (options.pool) {
    registerAuthRoutes(app, { pool: options.pool });
    registerAdminRoutes(app, { pool: options.pool, redis: options.redis, metrics });
    registerWorkspaceRoutes(app, { pool: options.pool });
  }
  return app;
}

/** Private auth process: the only holder of the login-only database role. No CORS: it is not browser-facing. */
export async function buildAuthApp(options: BuildAuthAppOptions): Promise<FastifyInstance> {
  const { config } = options;
  const app = await createBaseApp({
    title: "Spark Auth",
    acceptRequestId: true,
    rateLimitNamespace: "spark-auth-rate-limit-",
    logLevel: config.logLevel,
    trustedProxies: config.trustedProxies,
    rateLimitMax: config.rateLimitMax,
    rateLimitWindowMs: config.rateLimitWindowMs,
    redis: options.redis,
    rateLimit: options.rateLimit,
    logger: options.logger,
  });
  if (options.pool) registerCredentialRoutes(app, { pool: options.pool });
  return app;
}
