import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { fakePool, principalRow, type QueryHandler } from "./fake-pool.js";

const config = loadConfig({ NODE_ENV: "test" });
const cookie = `spark_session=${"b".repeat(64)}`;
const wsId = "1d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const otherId = "2d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";

const workspaceRow = {
  id: wsId,
  slug: "acme",
  name: "Acme",
  version: 3,
  created_at: new Date("2026-01-01T00:00:00Z"),
  role: "owner",
  member_count: "2",
};
const memberRow = {
  user_id: otherId,
  display_name: "Bob",
  avatar_url: null,
  email: "bob@example.com",
  role: "member",
  joined_at: new Date("2026-01-02T00:00:00Z"),
};

type Request = { method: "GET" | "POST" | "PATCH" | "DELETE"; url: string; payload?: unknown; headers?: Record<string, string> };

async function call(request: Request, handlers: Array<[string, QueryHandler]> = [], signedIn = true) {
  const { pool, calls } = fakePool([["auth_session_principal", signedIn ? () => [principalRow] : () => []], ...handlers]);
  const app = await buildApp({ config, pool, rateLimit: false, logger: false });
  try {
    const response = await app.inject({ ...request, headers: { ...(signedIn ? { cookie } : {}), ...request.headers } } as Parameters<typeof app.inject>[0]);
    return { response, calls };
  } finally {
    await app.close();
  }
}

const ROUTES: Request[] = [
  { method: "POST", url: "/api/v1/workspaces", payload: { name: "Acme", slug: "acme" } },
  { method: "GET", url: "/api/v1/workspaces" },
  { method: "GET", url: `/api/v1/workspaces/${wsId}` },
  { method: "GET", url: "/api/v1/workspaces/by-slug/acme" },
  { method: "PATCH", url: `/api/v1/workspaces/${wsId}`, payload: { name: "New" }, headers: { "if-match": '"v1"' } },
  { method: "GET", url: `/api/v1/workspaces/${wsId}/members` },
  { method: "PATCH", url: `/api/v1/workspaces/${wsId}/members/${otherId}`, payload: { role: "admin" } },
  { method: "DELETE", url: `/api/v1/workspaces/${wsId}/members/${otherId}` },
];

describe("workspace routes", () => {
  it.each(ROUTES)("$method $url requires a session", async (route) => {
    const { response } = await call(route, [], false);
    expect(response.statusCode).toBe(401);
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("creates a workspace with Location and ETag", async () => {
    const { response, calls } = await call(
      { method: "POST", url: "/api/v1/workspaces", payload: { name: "Acme", slug: "acme" } },
      [
        ["ws_create_workspace", () => [{ outcome: "ok", workspace_id: wsId }]],
        ["FROM spark.workspaces w", () => [workspaceRow]],
      ],
    );
    expect(response.statusCode).toBe(201);
    expect(response.headers.location).toBe(`/api/v1/workspaces/${wsId}`);
    expect(response.headers.etag).toBe('"v3"');
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toMatchObject({ id: wsId, slug: "acme", role: "owner", memberCount: 2, version: 3 });
    expect(calls.some((c) => c.sql.includes("ws_create_workspace") && c.params[1] === "acme")).toBe(true);
  });

  it.each([["slug_taken"], ["too_many_workspaces"]])("maps create outcome %s to 409", async (outcome) => {
    const { response } = await call(
      { method: "POST", url: "/api/v1/workspaces", payload: { name: "Acme", slug: "acme" } },
      [["ws_create_workspace", () => [{ outcome, workspace_id: null }]]],
    );
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: outcome });
  });

  it("rejects an invalid slug before touching the database", async () => {
    const { response, calls } = await call({ method: "POST", url: "/api/v1/workspaces", payload: { name: "Acme", slug: "A b" } });
    expect(response.statusCode).toBe(400);
    expect(calls.some((c) => c.sql.includes("ws_create_workspace"))).toBe(false);
  });

  it("rejects a cross-origin create", async () => {
    const { response } = await call({ method: "POST", url: "/api/v1/workspaces", payload: { name: "Acme", slug: "acme" }, headers: { origin: "https://evil.example" } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "origin_not_allowed" });
  });

  it("lists the actor's workspaces scoped to their user id", async () => {
    const { response, calls } = await call({ method: "GET", url: "/api/v1/workspaces" }, [["FROM spark.workspaces w", () => [workspaceRow]]]);
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect(calls.find((c) => c.sql.includes("FROM spark.workspaces w"))?.params[0]).toBe(principalRow.user_id);
  });

  it.each([`/api/v1/workspaces/${wsId}`, "/api/v1/workspaces/by-slug/acme"])("GET %s returns the workspace with an ETag", async (url) => {
    const { response } = await call({ method: "GET", url }, [["FROM spark.workspaces w", () => [workspaceRow]]]);
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"v3"');
    expect(response.json()).toMatchObject({ slug: "acme", createdAt: "2026-01-01T00:00:00.000Z" });
  });

  it.each([`/api/v1/workspaces/${wsId}`, "/api/v1/workspaces/by-slug/acme"])("GET %s is 404 for a non-member", async (url) => {
    const { response } = await call({ method: "GET", url });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "workspace_not_found" });
  });

  describe("PATCH workspace", () => {
    const patch = (headers: Record<string, string> = {}): Request => ({ method: "PATCH", url: `/api/v1/workspaces/${wsId}`, payload: { name: "New" }, headers });

    it("requires If-Match", async () => {
      const { response } = await call(patch());
      expect(response.statusCode).toBe(428);
      expect(response.json()).toMatchObject({ code: "precondition_required" });
    });

    it("rejects a malformed If-Match", async () => {
      const { response } = await call(patch({ "if-match": "W/\"v1\"" }));
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_if_match" });
    });

    it("renames and returns the new ETag", async () => {
      const { response, calls } = await call(patch({ "if-match": '"v3"' }), [
        ["ws_update_workspace", () => [{ outcome: "ok", version: 4 }]],
        ["FROM spark.workspaces w", () => [{ ...workspaceRow, name: "New", version: 4 }]],
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"v4"');
      expect(calls.find((c) => c.sql.includes("ws_update_workspace"))?.params).toEqual([wsId, 3, "New"]);
    });

    it("answers 412 with the current workspace on a stale version", async () => {
      const { response } = await call(patch({ "if-match": '"v1"' }), [
        ["ws_update_workspace", () => [{ outcome: "version_mismatch", version: 3 }]],
        ["FROM spark.workspaces w", () => [workspaceRow]],
      ]);
      expect(response.statusCode).toBe(412);
      expect(response.json()).toMatchObject({ code: "version_mismatch", current: { id: wsId, version: 3 } });
    });

    it.each([
      ["forbidden", 403, "insufficient_role"],
      ["not_found", 404, "workspace_not_found"],
    ])("maps %s", async (outcome, status, code) => {
      const { response } = await call(patch({ "if-match": '"v1"' }), [["ws_update_workspace", () => [{ outcome, version: null }]]]);
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
    });

    it("fails closed on an unknown outcome", async () => {
      const { response } = await call(patch({ "if-match": '"v1"' }), [["ws_update_workspace", () => [{ outcome: "weird", version: null }]]]);
      expect(response.statusCode).toBe(500);
    });
  });

  describe("members", () => {
    const list = { method: "GET", url: `/api/v1/workspaces/${wsId}/members` } as const;
    const setRole = { method: "PATCH", url: `/api/v1/workspaces/${wsId}/members/${otherId}`, payload: { role: "admin" } } as const;
    const remove = { method: "DELETE", url: `/api/v1/workspaces/${wsId}/members/${otherId}` } as const;

    it("lists members", async () => {
      const { response } = await call(list, [["ws_list_members", () => [memberRow]]]);
      expect(response.statusCode).toBe(200);
      expect(response.json().items[0]).toEqual({
        userId: otherId,
        displayName: "Bob",
        avatarUrl: null,
        email: "bob@example.com",
        role: "member",
        joinedAt: "2026-01-02T00:00:00.000Z",
      });
    });

    it("is 404 for a non-member", async () => {
      const { response } = await call(list);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "workspace_not_found" });
    });

    it("changes a role", async () => {
      const { response } = await call(setRole, [
        ["ws_set_member_role", () => [{ outcome: "ok" }]],
        ["ws_list_members", () => [{ ...memberRow, role: "admin" }]],
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ userId: otherId, role: "admin" });
    });

    it("rejects an unknown role in the schema", async () => {
      const { response } = await call({ ...setRole, payload: { role: "god" } });
      expect(response.statusCode).toBe(400);
    });

    it.each([
      ["forbidden", 403, "insufficient_role"],
      ["last_owner", 409, "last_owner"],
    ])("maps role change outcome %s", async (outcome, status, code) => {
      const { response } = await call(setRole, [["ws_set_member_role", () => [{ outcome }]]]);
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
    });

    it("distinguishes a missing member from a missing workspace", async () => {
      const visible = await call(setRole, [
        ["ws_set_member_role", () => [{ outcome: "not_found" }]],
        ["FROM spark.workspaces w", () => [workspaceRow]],
      ]);
      expect(visible.response.json()).toMatchObject({ code: "member_not_found" });
      const hidden = await call(setRole, [["ws_set_member_role", () => [{ outcome: "not_found" }]]]);
      expect(hidden.response.json()).toMatchObject({ code: "workspace_not_found" });
    });

    it("removes a member with an empty 204", async () => {
      const { response } = await call(remove, [["ws_remove_member", () => [{ outcome: "ok" }]]]);
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
    });

    it("maps remove outcome last_owner to 409", async () => {
      const { response } = await call(remove, [["ws_remove_member", () => [{ outcome: "last_owner" }]]]);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "last_owner" });
    });

    it("maps remove outcome forbidden to 403", async () => {
      const { response } = await call(remove, [["ws_remove_member", () => [{ outcome: "forbidden" }]]]);
      expect(response.statusCode).toBe(403);
    });
  });
});
