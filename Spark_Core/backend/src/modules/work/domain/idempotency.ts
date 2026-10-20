import { createHash } from "node:crypto";

const KEY = /^[A-Za-z0-9_.:-]{1,100}$/u;

/** Reads an Idempotency-Key header: null when absent, "invalid" for anything outside the key alphabet or length. */
export function parseIdempotencyKey(header: string | undefined): string | null | "invalid" {
  if (header === undefined) return null;
  return KEY.test(header) ? header : "invalid";
}

// Object keys sorted at every depth; arrays keep their order because order is meaningful there.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

/** SHA-256 (32 bytes) of the canonical JSON of a validated request body. */
export function requestHash(body: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(canonical(body) ?? null), "utf8").digest();
}
