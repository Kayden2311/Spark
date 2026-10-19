import type { FastifyReply, FastifyRequest } from "fastify";

import { decodeCursor, type Cursor } from "./pagination.js";
import { problem } from "./responses.js";

export const MUTATION_RATE_LIMIT = { rateLimit: { max: 30, timeWindow: 60 * 1000 } } as const;

export const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
  additionalProperties: false,
} as const;

export const pageQueryProperties = {
  cursor: { type: "string", maxLength: 200 },
  limit: { type: "integer", minimum: 1, maximum: 100 },
} as const;

// Database outcomes are a closed set; anything unexpected must not be reported as success.
export function expectOutcome(outcome: string | undefined, ...allowed: string[]): void {
  if (!outcome || !allowed.includes(outcome)) throw new Error(`Unexpected governance outcome: ${outcome ?? "none"}`);
}

/**
 * Errors our own functions raise for a missing session or platform role; other 42501 errors
 * are real privilege bugs and stay 500s.
 */
export function databaseDenial(error: unknown): "no_session" | "no_role" | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  if (error.code === "28000" && "message" in error && error.message === "Live session required") return "no_session";
  if (error.code === "42501" && "message" in error && error.message === "Platform role required") return "no_role";
  return null;
}

export function isInvalidParameter(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "22023";
}

// Only messages from `known` reach the client; built-in database errors never do.
export function invalidInputDetail(error: unknown, known: ReadonlySet<string>): string {
  const message = typeof error === "object" && error !== null && "message" in error ? String(error.message) : "";
  return known.has(message) ? `${message}.` : "The request contains a value the server does not accept.";
}

export function readCursor(request: FastifyRequest, reply: FastifyReply, value: string | undefined): Cursor | null | undefined {
  const cursor = decodeCursor(value);
  if (cursor === "invalid") {
    void problem(request, reply, 400, "Bad Request", "invalid_cursor", "The cursor is not valid for this collection.");
    return undefined;
  }
  return cursor;
}
