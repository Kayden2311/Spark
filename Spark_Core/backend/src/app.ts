import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "./config.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerHealthRoute } from "./routes/health.js";

export interface BuildAppOptions {
  readonly config: AppConfig;
  readonly pool?: Pool;
  readonly redis?: Redis;
  readonly rateLimit?: boolean;
  readonly logger?: boolean;
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

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: options.config.logLevel,
            redact: [
              "req.headers.authorization",
              "req.headers.cookie",
              "res.headers.set-cookie",
            ],
          },
    trustProxy:
      options.config.trustedProxies.length > 0
        ? [...options.config.trustedProxies]
        : false,
    bodyLimit: 1_048_576,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
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
    openapi: { info: { title: "Spark API", version: "0.1.0" } },
  });
  await app.register(helmet);
  await app.register(cors, {
    credentials: true,
    origin: [...options.config.corsOrigins],
  });

  if (options.rateLimit !== false) {
    if (!options.redis) throw new Error("Redis is required for rate limiting");
    await app.register(rateLimit, {
      redis: options.redis,
      global: true,
      max: options.config.rateLimitMax,
      timeWindow: options.config.rateLimitWindowMs,
      skipOnError: false,
    });
  }

  registerHealthRoute(app);
  if (options.pool) {
    registerAuthRoutes(app, { pool: options.pool });
    registerAdminRoutes(app, { pool: options.pool });
  }

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
