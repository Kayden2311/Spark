import { describe, expect, it } from "vitest";

import { parseIdempotencyKey, requestHash } from "../src/modules/work/domain/idempotency.js";

describe("idempotency keys", () => {
  it("treats a missing header as no key", () => {
    expect(parseIdempotencyKey(undefined)).toBeNull();
  });

  it.each(["a", "retry-1:2026.10", "A_b.c:d-9", "x".repeat(100)])("accepts %s", (key) => {
    expect(parseIdempotencyKey(key)).toBe(key);
  });

  it.each([["empty", ""], ["101 characters", "x".repeat(101)], ["spaces", "retry 1"], ["a comma list", "a, b"], ["non-ASCII", "clé"]])(
    "rejects %s",
    (_label, key) => {
      expect(parseIdempotencyKey(key)).toBe("invalid");
    },
  );
});

describe("request hash", () => {
  it("ignores object key order at every depth and is 32 bytes", () => {
    const a = requestHash({ b: 1, a: { d: 2, c: 3 } });
    const b = requestHash({ a: { c: 3, d: 2 }, b: 1 });
    expect(a.equals(b)).toBe(true);
    expect(a).toHaveLength(32);
  });

  it("distinguishes different values and array order", () => {
    expect(requestHash({ title: "A" }).equals(requestHash({ title: "B" }))).toBe(false);
    expect(requestHash({ list: [1, 2] }).equals(requestHash({ list: [2, 1] }))).toBe(false);
    expect(requestHash({ a: null }).equals(requestHash({}))).toBe(false);
  });
});
