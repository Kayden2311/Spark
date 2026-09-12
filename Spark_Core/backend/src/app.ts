import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "./config.js";
import { registerHealthRoute } from "./routes/health.js";

export interface BuildAppOptions {
  readonly config: AppConfig;
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

function problemCode(code: number): string {
  if (code === 404) return "not_found";
  if (code >= 500) return "internal_error";
  return "request_failed";
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
    request.log.error({ err: error }, "Request failed");
    return reply
      .code(code)
      .header("Cache-Control", "private, no-store")
      .type("application/problem+json")
      .send({
        type: "about:blank",
        title: code === 500 ? "Internal Server Error" : "Request Failed",
        status: code,
        code: problemCode(code),
        detail:
          code === 500
            ? "An unexpected error occurred."
            : "The request could not be processed.",
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
