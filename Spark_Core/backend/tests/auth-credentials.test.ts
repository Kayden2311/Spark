import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { buildAuthApp } from "../src/app.js";
import { loadAuthConfig } from "../src/config.js";
import { hashPassword } from "../src/infrastructure/database/password.js";
import { dbError, fakePool, principalRow } from "./fake-pool.js";

const config = loadAuthConfig({ NODE_ENV: "test" });
const signUpBody = { displayName: "New User", email: "new@example.com", password: "a-long-password-123" };

async function authApp(pool: ReturnType<typeof fakePool>["pool"]) {
  return buildAuthApp({ config, pool, rateLimit: false, logger: false });
}

describe("auth process credential routes", () => {
  it("maps only the duplicate-email constraint to 409", async () => {
    const duplicate = await authApp(fakePool([["auth_register_password", () => dbError("23505", "user_emails_normalized_email_key")]]).pool);
    const response = await duplicate.inject({ method: "POST", url: "/api/v1/auth/password/sign-up", payload: signUpBody });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "email_already_exists" });
    await duplicate.close();

    const otherConflict = await authApp(fakePool([["auth_register_password", () => dbError("23505", "workspaces_slug_key")]]).pool);
    expect((await otherConflict.inject({ method: "POST", url: "/api/v1/auth/password/sign-up", payload: signUpBody })).statusCode).toBe(500);
    await otherConflict.close();
  });

  it("returns the same 401 for unknown emails and wrong passwords", async () => {
    const hash = await hashPassword("the-right-password");
    const app = await authApp(fakePool([
      ["auth_password_login", (_sql, params) => (params[0] === "known@example.com" ? [{ user_id: principalRow.user_id, password_hash: hash, status: "active" }] : [])],
    ]).pool);
    for (const email of ["unknown@example.com", "known@example.com"]) {
      const response = await app.inject({ method: "POST", url: "/api/v1/auth/password/sign-in", payload: { email, password: "a-wrong-password" } });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: "invalid_credentials" });
    }
    await app.close();
  });

  it("refuses sign-in without a cookie when the database cannot start the session", async () => {
    const hash = await hashPassword("the-right-password");
    const app = await authApp(fakePool([
      ["auth_password_login", () => [{ user_id: principalRow.user_id, password_hash: hash, status: "active" }]],
      ["auth_start_session", () => []],
    ]).pool);
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/password/sign-in", payload: { email: "known@example.com", password: "the-right-password" } });
    expect(response.statusCode).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
    await app.close();
  });

  it("revokes the presented session and issues a new one on sign-in", async () => {
    const hash = await hashPassword("the-right-password");
    const { pool, calls } = fakePool([
      ["auth_password_login", () => [{ user_id: principalRow.user_id, password_hash: hash, status: "active" }]],
      ["auth_start_session", () => [principalRow]],
    ]);
    const app = await authApp(pool);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password/sign-in",
      payload: { email: "known@example.com", password: "the-right-password" },
      headers: { cookie: "spark_session=previous-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers["set-cookie"])).toMatch(/^spark_session=[0-9a-f]{64};/);
    const revoke = calls.find((call) => call.sql.includes("auth_revoke_session"));
    expect(revoke?.params[0]).toEqual(createHash("sha256").update("previous-token").digest());
    await app.close();
  });

  it("exposes no runtime routes and no CORS", async () => {
    const app = await authApp(fakePool().pool);
    expect((await app.inject({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/overview" })).statusCode).toBe(404);
    const preflight = await app.inject({ method: "OPTIONS", url: "/api/v1/auth/password/sign-in", headers: { origin: "http://localhost:3000", "access-control-request-method": "POST" } });
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });
});
