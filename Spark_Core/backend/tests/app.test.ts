import { describe, expect, it } from "vitest";
import type { Redis } from "ioredis";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig({ NODE_ENV: "test" });

function fakeRedis(failure?: Error): Redis {
  const counters = new Map<string, number>();
  const redis: Record<string, unknown> = {
    defineCommand(name: string) {
      if (name === "rateLimit") {
        redis[name] = (
          key: string,
          timeWindow: number,
          _max: number,
          _continueExceeding: boolean,
          _exponentialBackoff: boolean,
          callback: (error: Error | null, result?: number[]) => void,
        ) => {
          if (failure) return callback(failure);
          const count = (counters.get(key) ?? 0) + 1;
          counters.set(key, count);
          callback(null, [count, timeWindow]);
        };
      } else {
        redis[name] = (_key: string, callback: (error: null, result: number[]) => void) =>
          callback(null, [0, 0]);
      }
    },
  };
  return redis as unknown as Redis;
}

describe("Spark API", () => {
  it("serves a small, non-cacheable health response", async () => {
    const app = await buildApp({ config, rateLimit: false, logger: false });
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toBeDefined();
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("returns a sanitized problem response for unknown routes", async () => {
    const app = await buildApp({ config, rateLimit: false, logger: false });
    const response = await app.inject({ method: "GET", url: "/missing" });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      code: "not_found",
      status: 404,
      title: "Not Found",
    });
    await app.close();
  });

  it("publishes the health route in OpenAPI", async () => {
    const app = await buildApp({ config, rateLimit: false, logger: false });
    await app.ready();
    const operation = app.swagger().paths["/health"]?.get;
    expect(operation).toBeDefined();
    expect(operation?.responses?.["200"]?.headers).toHaveProperty("Cache-Control");
    expect(operation?.responses?.["200"]?.headers).toHaveProperty("X-Request-Id");
    await app.close();
  });

  it("limits normal traffic while leaving health available", async () => {
    const limitedConfig = { ...config, rateLimitMax: 1 };
    const app = await buildApp({ config: limitedConfig, logger: false, redis: fakeRedis() });
    app.get("/limited", async () => ({ ok: true }));

    expect((await app.inject({ method: "GET", url: "/limited" })).statusCode).toBe(200);
    const limited = await app.inject({ method: "GET", url: "/limited" });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    await app.close();
  });

  it("fails closed with a sanitized response when the limiter store fails", async () => {
    const app = await buildApp({
      config,
      logger: false,
      redis: fakeRedis(new Error("private Redis detail")),
    });
    app.get("/limited", async () => ({ ok: true }));

    const response = await app.inject({ method: "GET", url: "/limited" });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("private Redis detail");
    expect(response.json()).toMatchObject({ code: "internal_error", status: 500 });
    await app.close();
  });

  it("keeps production transport requirements fail-closed", () => {
    const base = {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://spark_app:secret@db.internal/spark",
      DATABASE_SSL: "true",
      REDIS_URL: "rediss://redis.internal:6380",
      CORS_ORIGINS: "https://spark.example",
      TRUSTED_PROXIES: "10.0.0.0/8",
    };

    expect(() => loadConfig({ ...base, DATABASE_SSL: "false" })).toThrow();
    expect(() => loadConfig({ ...base, REDIS_URL: "redis://redis.internal" })).toThrow();
    expect(() => loadConfig({ ...base, CORS_ORIGINS: "http://spark.example" })).toThrow();
    expect(() => loadConfig({ ...base, TRUSTED_PROXIES: "0.0.0.0/0" })).toThrow();
  });
});
