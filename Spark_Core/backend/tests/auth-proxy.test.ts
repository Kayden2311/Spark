import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp, buildAuthApp } from "../src/app.js";
import { loadAuthConfig, loadConfig } from "../src/config.js";
import { hashPassword } from "../src/infrastructure/database/password.js";
import { fakePool, principalRow } from "./fake-pool.js";

const open: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

// A real auth process on an ephemeral loopback port, backed by a fake login pool.
async function startAuthService(handlers: Parameters<typeof fakePool>[0]) {
  const auth = await buildAuthApp({ config: loadAuthConfig({ NODE_ENV: "test" }), pool: fakePool(handlers).pool, rateLimit: false, logger: false });
  open.push(auth);
  const seen: Array<{ forwardedFor: string | undefined; cookie: string | undefined; ip: string; id: string }> = [];
  auth.addHook("onRequest", async (request) => {
    seen.push({ forwardedFor: request.headers["x-forwarded-for"] as string | undefined, cookie: request.headers.cookie, ip: request.ip, id: request.id });
  });
  const address = await auth.listen({ host: "127.0.0.1", port: 0 });
  return { url: address, seen };
}

async function api(authServiceUrl: string, fetchImpl?: typeof fetch) {
  const app = await buildApp({ config: loadConfig({ NODE_ENV: "test", AUTH_SERVICE_URL: authServiceUrl }), pool: fakePool().pool, rateLimit: false, logger: false, fetchImpl });
  open.push(app);
  return app;
}

describe("API forwarding to the auth process", () => {
  it("relays status, body and the session cookie, and forwards the client address", async () => {
    const hash = await hashPassword("the-right-password");
    const service = await startAuthService([
      ["auth_password_login", () => [{ user_id: principalRow.user_id, password_hash: hash, status: "active" }]],
      ["auth_start_session", () => [principalRow]],
    ]);
    const app = await api(service.url);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password/sign-in",
      payload: { email: "admin@example.com", password: "the-right-password" },
      headers: { cookie: "theme=dark; spark_session=old-token" },
      remoteAddress: "203.0.113.7",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { id: principalRow.user_id } });
    expect(String(response.headers["set-cookie"])).toMatch(/^spark_session=[0-9a-f]{64};.*HttpOnly/);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    // The auth process trusts the API hop, so its rate limiter keys on the real client address,
    // and both processes log the same request id.
    expect(service.seen[0]).toEqual({ forwardedFor: "203.0.113.7", cookie: "spark_session=old-token", ip: "203.0.113.7", id: response.headers["x-request-id"] });
  });

  it("relays auth-process problem responses with the public URL", async () => {
    const service = await startAuthService([]);
    const app = await api(service.url);
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/password/sign-in", payload: { email: "nobody@example.com", password: "whatever-123" } });
    expect(response.statusCode).toBe(401);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({ code: "invalid_credentials", instance: "/api/v1/auth/password/sign-in" });
  });

  it("relays every Set-Cookie value, Retry-After, non-JSON bodies and the query string", async () => {
    let forwardedUrl = "";
    let forwardedBody: unknown;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      forwardedUrl = String(input);
      forwardedBody = init?.body;
      const headers = new Headers({ "content-type": "text/plain", "retry-after": "30" });
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2; Path=/");
      return new Response("slow down", { status: 429, headers });
    }) as typeof fetch;
    const app = await api("http://127.0.0.1:4100", fetchImpl);
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/password/sign-in?next=%2Fworkspace", payload: { email: "a@example.com", password: "x" } });
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("30");
    expect(response.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toBe("slow down");
    expect(forwardedUrl).toBe("http://127.0.0.1:4100/api/v1/auth/password/sign-in?next=%2Fworkspace");
    expect(forwardedBody).toBe(JSON.stringify({ email: "a@example.com", password: "x" }));
  });

  it("forwards a JSON null body unchanged so validation errors stay the same", async () => {
    const service = await startAuthService([]);
    const app = await api(service.url);
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/password/sign-up", payload: "null", headers: { "content-type": "application/json" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toMatch(/body must be object/);
  });

  it("answers 503 when the response body stalls or the request times out", async () => {
    const timedOut = (async () => { throw new DOMException("timed out", "TimeoutError"); }) as typeof fetch;
    expect((await (await api("http://127.0.0.1:4100", timedOut)).inject({ method: "POST", url: "/api/v1/auth/password/sign-in", payload: {} })).statusCode).toBe(503);
    const brokenBody = (async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("stalled")); } }), { status: 200 })) as typeof fetch;
    const response = await (await api("http://127.0.0.1:4100", brokenBody)).inject({ method: "POST", url: "/api/v1/auth/password/sign-in", payload: {} });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "auth_unavailable" });
  });

  it("answers 503 when the auth process is unreachable", async () => {
    const app = await api("http://127.0.0.1:9");
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/password/sign-up", payload: { displayName: "A", email: "a@example.com", password: "a-long-password-123" } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "auth_unavailable" });
  });
});
