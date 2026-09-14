import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/infrastructure/database/password.js";

describe("Argon2id password storage", () => {
  it("uses distinct salts, verifies the password and rejects a wrong password", async () => {
    const password = "local-test-password-only";
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    expect(first).toMatch(/^\$argon2id\$v=19\$/u);
    expect(first).not.toBe(second);
    expect(await verifyPassword(first, password)).toBe(true);
    expect(await verifyPassword(first, "incorrect-password")).toBe(false);
  });
  it("rejects invalid input and malformed stored hashes", async () => {
    await expect(hashPassword("short")).rejects.toThrow("Password must");
    await expect(hashPassword("x".repeat(1025))).rejects.toThrow("Password must");
    expect(await verifyPassword("plaintext", "password")).toBe(false);
    const { hash, Algorithm, Version } = await import("@node-rs/argon2");
    const weak = await hash("local-test-password-only", { algorithm: Algorithm.Argon2id, version: Version.V0x13, memoryCost: 8, timeCost: 1, parallelism: 1, outputLen: 16 });
    expect(await verifyPassword(weak, "local-test-password-only")).toBe(false);
  });
});
