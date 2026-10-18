import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { createMemberGuard, preconditionFailed, preconditionRequired } from "../src/routes/workspace/guard.js";
import { fakePool, principalRow, type QueryHandler } from "./fake-pool.js";

const token = "a".repeat(64);
const cookie = `spark_session=${token}`;

async function harness(work: () => Promise<unknown>, session: QueryHandler = () => [principalRow]) {
  const { pool, calls } = fakePool([["auth_session_principal", session]]);
  const guard = createMemberGuard(pool);
  const app = Fastify();
  app.get("/probe", async (request, reply) => {
    const member = await guard.authenticate(request, reply);
    if (!member) return reply;
    const result = await guard.run(request, reply, member, work);
    return result === undefined ? reply : { ok: true };
  });
  app.get("/412", async (request, reply) => preconditionFailed(request, reply, { id: "x", version: 2 }));
  app.get("/428", async (request, reply) => preconditionRequired(request, reply));
  return { app, calls };
}

describe("member guard", () => {
  it("answers 401 unauthenticated without a cookie", async () => {
    const { app } = await harness(async () => 1);
    const response = await app.inject({ method: "GET", url: "/probe" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "unauthenticated" });
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("answers 401 session_expired for an unknown session", async () => {
    const { app } = await harness(async () => 1, () => []);
    const response = await app.inject({ method: "GET", url: "/probe", headers: { cookie } });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "session_expired" });
  });

  it("runs work in a session transaction with a statement timeout", async () => {
    const { app, calls } = await harness(async () => 1);
    const response = await app.inject({ method: "GET", url: "/probe", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(calls.some((call) => call.sql.includes("statement_timeout = '5s'"))).toBe(true);
  });

  it("maps a revoked session to 401 session_expired", async () => {
    const { app } = await harness(async () => {
      throw Object.assign(new Error("Live session required"), { code: "28000" });
    });
    const response = await app.inject({ method: "GET", url: "/probe", headers: { cookie } });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "session_expired" });
  });

  it("surfaces whitelisted 22023 messages and hides unknown ones", async () => {
    const known = await harness(async () => {
      throw Object.assign(new Error("Invalid workspace slug"), { code: "22023" });
    });
    const knownResponse = await known.app.inject({ method: "GET", url: "/probe", headers: { cookie } });
    expect(knownResponse.statusCode).toBe(400);
    expect(knownResponse.json()).toMatchObject({ code: "invalid_input", detail: "Invalid workspace slug." });

    const unknown = await harness(async () => {
      throw Object.assign(new Error("secret internals"), { code: "22023" });
    });
    const unknownResponse = await unknown.app.inject({ method: "GET", url: "/probe", headers: { cookie } });
    expect(unknownResponse.statusCode).toBe(400);
    expect(unknownResponse.json().detail).not.toContain("secret");
  });

  it("rethrows other errors as 500", async () => {
    const { app } = await harness(async () => {
      throw new Error("boom");
    });
    const response = await app.inject({ method: "GET", url: "/probe", headers: { cookie } });
    expect(response.statusCode).toBe(500);
  });

  it("builds 412 and 428 problems", async () => {
    const { app } = await harness(async () => 1);
    const stale = await app.inject({ method: "GET", url: "/412" });
    expect(stale.statusCode).toBe(412);
    expect(stale.json()).toMatchObject({ code: "version_mismatch", current: { id: "x", version: 2 } });
    const missing = await app.inject({ method: "GET", url: "/428" });
    expect(missing.statusCode).toBe(428);
    expect(missing.json()).toMatchObject({ code: "precondition_required" });
  });
});
