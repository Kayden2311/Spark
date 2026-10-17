import type { FastifyReply, FastifyRequest } from "fastify";

import { SESSION_COOKIE } from "../infrastructure/database/session.js";

export function problem(request: FastifyRequest, reply: FastifyReply, status: number, title: string, code: string, detail: string) {
  return reply.code(status).type("application/problem+json").send({
    type: "about:blank",
    title,
    status,
    code,
    detail,
    instance: request.url,
    requestId: request.id,
  });
}

function cookieFlags(value: string, maxAgeSeconds: number, expired: boolean): string {
  const flags = [`${SESSION_COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
  if (expired) flags.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  if (process.env.NODE_ENV === "production") flags.push("Secure");
  return flags.join("; ");
}

export function setSessionCookie(reply: FastifyReply, token: string, maxAgeSeconds: number): void {
  reply.header("Set-Cookie", cookieFlags(encodeURIComponent(token), maxAgeSeconds, false));
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.header("Set-Cookie", cookieFlags("", 0, true));
}
