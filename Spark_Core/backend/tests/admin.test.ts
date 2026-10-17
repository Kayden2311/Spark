import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { fakePool, principalRow } from "./fake-pool.js";

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

describe("admin user status route", () => {
  const target = "1d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";

  async function suspend(outcome: string) {
    const { pool } = fakePool([
      ["auth_session_principal", () => [principalRow]],
      ["staff_set_user_status", () => [{ outcome }]],
    ]);
    const app = await buildApp({ config, pool, rateLimit: false, logger: false });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${target}/status`,
      payload: { status: "suspended" },
      headers: { cookie: "spark_session=admin-token" },
    });
    await app.close();
    return response;
  }

  it("reports a refused last-super-admin suspension as 409", async () => {
    const response = await suspend("last_super_admin");
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "last_super_admin" });
  });

  it("never reports an unknown outcome as success", async () => {
    expect((await suspend("something_else")).statusCode).toBe(500);
    expect((await suspend("ok")).statusCode).toBe(200);
  });
});
