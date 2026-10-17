import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { SESSION_COOKIE, parseCookies } from "../infrastructure/database/session.js";
import { CREDENTIAL_RATE_LIMITS, SIGN_IN_PATH, SIGN_UP_PATH } from "./auth-credentials.js";
import { problem } from "./responses.js";

export interface AuthProxyOptions {
  /** Base URL of the auth process, e.g. http://127.0.0.1:4100. */
  readonly authServiceUrl: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch | undefined;
}

/**
 * Forwards the public sign-up and sign-in routes to the auth process. The API never holds the
 * login database credentials; it relays the request and the auth process's response verbatim.
 */
export function registerAuthProxyRoutes(app: FastifyInstance, options: AuthProxyOptions): void {
  const fetchImpl = options.fetchImpl ?? fetch;
  // Above worst-case Argon2id hashing plus the database call, so a slow sign-up that commits is not
  // reported to the client as unavailable.
  const timeoutMs = options.timeoutMs ?? 15_000;

  for (const path of [SIGN_UP_PATH, SIGN_IN_PATH] as const) {
    app.post(
      path,
      { config: { rateLimit: { max: CREDENTIAL_RATE_LIMITS[path], timeWindow: 60 * 1000 } } },
      async (request: FastifyRequest, reply: FastifyReply) => {
        reply.header("Cache-Control", "private, no-store");

        // Only the client address, request id and session cookie (for rotation) cross the boundary.
        const headers: Record<string, string> = { "x-forwarded-for": request.ip, "x-request-id": request.id };
        const sessionToken = parseCookies(request.headers.cookie)[SESSION_COOKIE];
        if (sessionToken) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}`;
        // Forward the parsed body as-is (including null) so validation errors match the old single process.
        const body = request.body === undefined ? undefined : JSON.stringify(request.body);
        if (body !== undefined) headers["content-type"] = "application/json";

        let upstream: Response;
        let payload: string;
        try {
          upstream = await fetchImpl(new URL(request.url, options.authServiceUrl), {
            method: "POST",
            headers,
            ...(body === undefined ? {} : { body }),
            redirect: "manual",
            signal: AbortSignal.timeout(timeoutMs),
          });
          // The timeout also covers reading the body, so read it inside the same guard.
          payload = await upstream.text();
        } catch (error) {
          request.log.error({ err: error }, "Auth service unreachable");
          return problem(request, reply, 503, "Service Unavailable", "auth_unavailable", "Sign-in is temporarily unavailable. Try again shortly.");
        }

        const setCookie = upstream.headers.getSetCookie();
        if (setCookie.length > 0) reply.header("Set-Cookie", setCookie);
        const retryAfter = upstream.headers.get("retry-after");
        if (retryAfter) reply.header("Retry-After", retryAfter);
        reply.type(upstream.headers.get("content-type") ?? "application/json");
        return reply.code(upstream.status).send(payload);
      },
    );
  }
}
