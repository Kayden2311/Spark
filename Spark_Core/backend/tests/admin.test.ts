import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig({ NODE_ENV: "test" });

function createFakePool() {
  return {
    connect: async () => ({
      query: async () => ({ rows: [] }),
      release: () => {},
    }),
    query: async () => ({ rows: [] }),
    on: () => {},
    end: async () => {},
  } as unknown as Pool;
}

describe("Admin & Moderator Governance API", () => {
  it("rejects unauthenticated requests to /api/v1/admin/overview with 401", async () => {
    const pool = createFakePool();
    const app = await buildApp({ config, pool, rateLimit: false, logger: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/overview",
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      status: 401,
      code: "unauthenticated",
    });
    await app.close();
  });

  it("rejects unauthenticated requests to /api/v1/admin/reports with 401", async () => {
    const pool = createFakePool();
    const app = await buildApp({ config, pool, rateLimit: false, logger: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/reports",
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects unauthenticated requests to /api/v1/admin/communities with 401", async () => {
    const pool = createFakePool();
    const app = await buildApp({ config, pool, rateLimit: false, logger: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/communities",
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects unauthenticated requests to /api/v1/admin/campaigns with 401", async () => {
    const pool = createFakePool();
    const app = await buildApp({ config, pool, rateLimit: false, logger: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/campaigns",
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects unauthenticated requests to /api/v1/admin/audit-logs with 401", async () => {
    const pool = createFakePool();
    const app = await buildApp({ config, pool, rateLimit: false, logger: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/audit-logs",
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects unauthenticated requests to /api/v1/admin/system with 401", async () => {
    const pool = createFakePool();
    const app = await buildApp({ config, pool, rateLimit: false, logger: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/system",
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
