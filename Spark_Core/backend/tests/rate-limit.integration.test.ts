import Redis from "ioredis";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const redisUrl = process.env.TEST_REDIS_URL;
const integration = redisUrl ? describe : describe.skip;
const clients: Redis[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.quit()));
});

async function redisClient(): Promise<Redis> {
  const client = new Redis(redisUrl!, {
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  clients.push(client);
  await client.connect();
  return client;
}

integration("Redis rate limiting", () => {
  it("shares and expires a quota across application instances", async () => {
    const config = {
      ...loadConfig({ NODE_ENV: "test" }),
      rateLimitMax: 1,
      rateLimitWindowMs: 100,
    };
    const first = await buildApp({ config, logger: false, redis: await redisClient() });
    const second = await buildApp({ config, logger: false, redis: await redisClient() });
    first.get("/limited", async () => ({ ok: true }));
    second.get("/limited", async () => ({ ok: true }));

    expect((await first.inject({ method: "GET", url: "/limited" })).statusCode).toBe(200);
    const limited = await second.inject({ method: "GET", url: "/limited" });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect((await second.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await second.inject({ method: "GET", url: "/limited" })).statusCode).toBe(200);

    clients.forEach((client) => client.disconnect());
    const unavailable = await first.inject({ method: "GET", url: "/limited" });
    expect(unavailable.statusCode).toBe(500);
    expect(unavailable.json()).toMatchObject({ code: "internal_error", status: 500 });
    await Promise.all([first.close(), second.close()]);
  });
});
