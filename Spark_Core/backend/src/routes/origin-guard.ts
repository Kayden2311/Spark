import type { FastifyInstance } from "fastify";

import { problem } from "./responses.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Defence in depth against cross-site request forgery on cookie-authenticated mutations.
 * SameSite=Lax already keeps the session cookie off cross-site requests; this also stops requests
 * from same-site hosts that are not an allowed frontend origin (a sibling subdomain or preview host).
 * Requests without browser metadata (server-to-server calls, tests) carry no Origin and pass through.
 */
export function registerOriginGuard(app: FastifyInstance, allowedOrigins: readonly string[]): void {
  app.addHook("onRequest", async (request, reply) => {
    if (SAFE_METHODS.has(request.method) || !request.url.startsWith("/api/v1/")) return;
    const site = request.headers["sec-fetch-site"];
    const origin = request.headers.origin;
    if (site === "cross-site" || (typeof origin === "string" && !allowedOrigins.includes(origin))) {
      reply.header("Cache-Control", "private, no-store");
      return problem(request, reply, 403, "Forbidden", "origin_not_allowed", "This request did not come from an allowed Spark origin.");
    }
  });
}
