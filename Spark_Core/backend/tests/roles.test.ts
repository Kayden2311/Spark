import { describe, expect, it } from "vitest";

import { assertLoginRole, assertRuntimeRole, assertWorkerRole } from "../src/infrastructure/database/roles.js";
import { fakePool } from "./fake-pool.js";

const base = { role: "spark_auth", superuser: false, bypass_rls: false, memberships: 0 };

function probe(row: Record<string, unknown> | undefined) {
  return fakePool([["pg_roles", () => (row ? [row] : [])]]).pool;
}

describe("login role probe", () => {
  it("accepts a least-privilege login role", async () => {
    await expect(assertLoginRole(probe({ ...base, reads_users: false }))).resolves.toBeUndefined();
  });

  it.each([
    ["superuser", { superuser: true }],
    ["RLS bypass", { bypass_rls: true }],
    ["role memberships", { memberships: 1 }],
    ["application table access", { reads_users: true }],
  ])("rejects %s", async (_name, override) => {
    await expect(assertLoginRole(probe({ ...base, reads_users: false, ...override }))).rejects.toThrow("too privileged");
  });

  it("fails closed when the Spark schema is not visible", async () => {
    await expect(assertLoginRole(probe({ ...base, reads_users: null }))).rejects.toThrow("not connected to the Spark database");
  });
});

describe("runtime role probe", () => {
  it("accepts a runtime role that cannot create sessions", async () => {
    await expect(assertRuntimeRole(probe({ ...base, role: "spark_app", starts_sessions: false }))).resolves.toBeUndefined();
  });

  it("rejects a runtime role holding login power directly or through membership", async () => {
    await expect(assertRuntimeRole(probe({ ...base, role: "spark_app", starts_sessions: true }))).rejects.toThrow("must not be able to create sessions");
    await expect(assertRuntimeRole(probe({ ...base, role: "spark_app", starts_sessions: false, memberships: 1 }))).rejects.toThrow("must not be able to create sessions");
  });

  it("fails closed against an unmigrated database", async () => {
    await expect(assertRuntimeRole(probe({ ...base, role: "spark_app", starts_sessions: null }))).rejects.toThrow("not connected to a migrated");
  });
});

describe("worker role probe", () => {
  const worker = { ...base, role: "spark_worker", reads_users: false, claims_outbox: true };

  it("accepts a least-privilege worker role", async () => {
    await expect(assertWorkerRole(probe(worker))).resolves.toBeUndefined();
  });

  it.each([
    ["superuser", { superuser: true }],
    ["RLS bypass", { bypass_rls: true }],
    ["role memberships", { memberships: 1 }],
    ["application table access", { reads_users: true }],
  ])("rejects %s", async (_name, override) => {
    await expect(assertWorkerRole(probe({ ...worker, ...override }))).rejects.toThrow("too privileged");
  });

  it("fails closed when the Spark schema or the worker functions are not visible", async () => {
    await expect(assertWorkerRole(probe({ ...worker, reads_users: null }))).rejects.toThrow("not connected to the Spark database");
    await expect(assertWorkerRole(probe({ ...worker, claims_outbox: false }))).rejects.toThrow("cannot claim outbox events");
  });
});
