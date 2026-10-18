import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { hashSessionToken } from "../src/infrastructure/database/session.js";
import { fakePool, principalRow, type QueryHandler } from "./fake-pool.js";

const config = loadConfig({ NODE_ENV: "test" });
const cookie = `spark_session=${"b".repeat(64)}`;
const wsId = "1d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const invId = "3d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const token = "ab".repeat(32);

const workspaceRow = { id: wsId, slug: "acme", name: "Acme", version: 3, created_at: new Date("2026-01-01T00:00:00Z"), role: "owner", member_count: "2" };
const invitationRow = {
  id: invId,
  email: "bob@example.com",
  role: "member",
  status: "pending",
  invited_by_user_id: principalRow.user_id,
  invited_by_name: "Admin",
  expires_at: new Date("2026-02-01T00:00:00Z"),
  created_at: new Date("2026-01-25T00:00:00Z"),
};
const previewRow = {
  status: "pending",
  workspace_name: "Acme",
  inviter_name: "Admin",
  role: "member",
  email_hint: "b***@example.com",
  expires_at: new Date("2026-02-01T00:00:00Z"),
};

type Request = { method: "GET" | "POST" | "DELETE"; url: string; payload?: unknown };

async function call(request: Request, handlers: Array<[string, QueryHandler]> = [], signedIn = true) {
  const { pool, calls } = fakePool([["auth_session_principal", signedIn ? () => [principalRow] : () => []], ...handlers]);
  const app = await buildApp({ config, pool, rateLimit: false, logger: false });
  try {
    const response = await app.inject({ ...request, headers: signedIn ? { cookie } : {} } as Parameters<typeof app.inject>[0]);
    return { response, calls };
  } finally {
    await app.close();
  }
}

const base = `/api/v1/workspaces/${wsId}/invitations`;
const createReq: Request = { method: "POST", url: base, payload: { email: "bob@example.com", role: "member" } };
const resendReq: Request = { method: "POST", url: `${base}/${invId}/resend` };
const listReq: Request = { method: "GET", url: base };
const revokeReq: Request = { method: "DELETE", url: `${base}/${invId}` };
const acceptReq: Request = { method: "POST", url: "/api/v1/invitations/accept", payload: { token } };
const previewReq: Request = { method: "POST", url: "/api/v1/invitations/preview", payload: { token } };

const asOwner: [string, QueryHandler] = ["FROM spark.workspaces w", () => [workspaceRow]];
const asMember: [string, QueryHandler] = ["FROM spark.workspaces w", () => [{ ...workspaceRow, role: "member" }]];
const invitationVisible: [string, QueryHandler] = ["FROM spark.workspace_invitations", () => [invitationRow]];

describe("workspace invitation routes", () => {
  it.each([createReq, resendReq, listReq, revokeReq, acceptReq])("$method $url requires a session", async (route) => {
    const { response } = await call(route, [], false);
    expect(response.statusCode).toBe(401);
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  describe("create", () => {
    const created: Array<[string, QueryHandler]> = [["ws_create_invitation", () => [{ outcome: "ok", invitation_id: invId }]], invitationVisible];

    it("returns 201 with Location, never a token, and a four-parameter SQL call", async () => {
      const { response, calls } = await call(createReq, created);
      expect(response.statusCode).toBe(201);
      expect(response.headers.location).toBe(`${base}/${invId}`);
      expect(response.json()).toEqual({
        invitation: {
          id: invId,
          email: "bob@example.com",
          role: "member",
          status: "pending",
          invitedBy: { id: principalRow.user_id, displayName: "Admin" },
          expiresAt: "2026-02-01T00:00:00.000Z",
          createdAt: "2026-01-25T00:00:00.000Z",
        },
      });
      expect(response.body.toLowerCase()).not.toContain("token");
      const sql = calls.find((c) => c.sql.includes("ws_create_invitation"));
      expect(sql?.params).toHaveLength(4);
      expect(sql?.params.slice(0, 3)).toEqual([wsId, "bob@example.com", "member"]);
      const expires = (sql?.params[3] as Date).getTime() - Date.now();
      expect(Math.abs(expires - 7 * 24 * 3600 * 1000)).toBeLessThan(60_000);
    });

    it.each([
      ["forbidden", 403, "insufficient_role"],
      ["not_found", 404, "workspace_not_found"],
      ["already_member", 409, "already_member"],
      ["invitation_pending", 409, "invitation_pending"],
      ["too_many_invitations", 409, "too_many_invitations"],
    ])("maps outcome %s", async (outcome, status, code) => {
      const { response } = await call(createReq, [["ws_create_invitation", () => [{ outcome, invitation_id: null }]]]);
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
    });

    it.each([
      [{ email: "x".repeat(250) + "@a.io", role: "member" }],
      [{ email: "bob@example.com", role: "owner" }],
      [{ email: "bob@example.com" }],
    ])("rejects invalid body %j", async (payload) => {
      const { response, calls } = await call({ ...createReq, payload });
      expect(response.statusCode).toBe(400);
      expect(calls.some((c) => c.sql.includes("ws_create_invitation"))).toBe(false);
    });
  });

  describe("resend", () => {
    it("returns 202 with the invitation", async () => {
      const { response, calls } = await call(resendReq, [asOwner, invitationVisible, ["ws_resend_invitation", () => [{ outcome: "ok" }]]]);
      expect(response.statusCode).toBe(202);
      expect(response.json().invitation.id).toBe(invId);
      expect(response.body.toLowerCase()).not.toContain("token");
      expect(calls.find((c) => c.sql.includes("ws_resend_invitation"))?.params).toEqual([invId]);
    });

    it.each([
      ["forbidden", 403, "insufficient_role"],
      ["not_found", 404, "invitation_not_found"],
      ["not_pending", 409, "not_pending"],
    ])("maps outcome %s", async (outcome, status, code) => {
      const { response } = await call(resendReq, [asOwner, invitationVisible, ["ws_resend_invitation", () => [{ outcome }]]]);
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
    });

    it("is 404 for an invitation of another workspace without calling SQL", async () => {
      const { response, calls } = await call(resendReq, [asOwner]);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "invitation_not_found" });
      expect(calls.some((c) => c.sql.includes("ws_resend_invitation"))).toBe(false);
    });

    it("is 403 for a plain member without calling SQL", async () => {
      const { response, calls } = await call(resendReq, [asMember, invitationVisible]);
      expect(response.statusCode).toBe(403);
      expect(calls.some((c) => c.sql.includes("ws_resend_invitation"))).toBe(false);
    });
  });

  describe("list", () => {
    it("lists invitations without token fields and never selects token_hash", async () => {
      const { response, calls } = await call(listReq, [asOwner, invitationVisible]);
      expect(response.statusCode).toBe(200);
      expect(response.json().items).toHaveLength(1);
      expect(response.body).not.toMatch(/token/i);
      const reads = calls.filter((c) => c.sql.includes("spark.workspace_invitations"));
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every((c) => !c.sql.includes("token_hash"))).toBe(true);
    });

    it("rejects a plain member before querying invitations", async () => {
      const { response, calls } = await call(listReq, [asMember, invitationVisible]);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "insufficient_role" });
      expect(calls.some((c) => c.sql.includes("FROM spark.workspace_invitations"))).toBe(false);
    });

    it("is 404 for a non-member", async () => {
      const { response } = await call(listReq);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "workspace_not_found" });
    });

    it("passes the status filter and rejects unknown statuses", async () => {
      const ok = await call({ ...listReq, url: `${base}?status=revoked` }, [asOwner, invitationVisible]);
      expect(ok.response.statusCode).toBe(200);
      expect(ok.calls.find((c) => c.sql.includes("FROM spark.workspace_invitations"))?.params).toContain("revoked");
      const bad = await call({ ...listReq, url: `${base}?status=nope` }, [asOwner]);
      expect(bad.response.statusCode).toBe(400);
    });
  });

  describe("revoke", () => {
    it("returns an empty 204", async () => {
      const { response } = await call(revokeReq, [asOwner, invitationVisible, ["ws_revoke_invitation", () => [{ outcome: "ok" }]]]);
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
    });

    it.each([
      ["forbidden", 403, "insufficient_role"],
      ["not_found", 404, "invitation_not_found"],
      ["not_pending", 409, "not_pending"],
    ])("maps outcome %s", async (outcome, status, code) => {
      const { response } = await call(revokeReq, [asOwner, invitationVisible, ["ws_revoke_invitation", () => [{ outcome }]]]);
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
    });
  });

  describe("preview", () => {
    it("needs no session and hashes the token before SQL", async () => {
      const { response, calls } = await call(previewReq, [["ws_invitation_preview", () => [previewRow]]], false);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: "pending",
        workspaceName: "Acme",
        inviterName: "Admin",
        role: "member",
        emailHint: "b***@example.com",
        expiresAt: "2026-02-01T00:00:00.000Z",
      });
      const sql = calls.find((c) => c.sql.includes("ws_invitation_preview"));
      expect(sql?.params[0]).toEqual(hashSessionToken(token));
      expect(JSON.stringify(sql?.params)).not.toContain(token);
    });

    it("returns only the status for a settled invitation", async () => {
      const row = { status: "revoked", workspace_name: null, inviter_name: null, role: null, email_hint: null, expires_at: null };
      const { response } = await call(previewReq, [["ws_invitation_preview", () => [row]]], false);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "revoked", workspaceName: null, inviterName: null, role: null, emailHint: null, expiresAt: null });
    });

    it("is 404 for an unknown token", async () => {
      const { response } = await call(previewReq, [], false);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "invalid_invitation" });
    });

    it.each(["short", "z".repeat(64), "AB".repeat(32)])("rejects malformed token %s", async (bad) => {
      const { response } = await call({ ...previewReq, payload: { token: bad } }, [], false);
      expect(response.statusCode).toBe(400);
    });
  });

  describe("accept", () => {
    const accepted = (outcome: string, extra: object = {}) =>
      ["ws_accept_invitation", () => [{ outcome, workspace_id: null, workspace_slug: null, role: null, ...extra }]] as [string, QueryHandler];

    it("joins the workspace", async () => {
      const { response, calls } = await call(acceptReq, [accepted("ok", { workspace_id: wsId, workspace_slug: "acme", role: "member" })]);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ workspace: { id: wsId, slug: "acme" }, role: "member", alreadyMember: false });
      expect(calls.find((c) => c.sql.includes("ws_accept_invitation"))?.params[0]).toEqual(hashSessionToken(token));
    });

    it("reports alreadyMember with 200", async () => {
      const { response } = await call(acceptReq, [accepted("already_member", { workspace_id: wsId, workspace_slug: "acme", role: "admin" })]);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ role: "admin", alreadyMember: true });
    });

    it.each([
      ["invalid_invitation", 404],
      ["invitation_expired", 409],
      ["invitation_revoked", 409],
      ["invitation_used", 409],
      ["membership_suspended", 403],
    ])("maps outcome %s", async (outcome, status) => {
      const { response } = await call(acceptReq, [accepted(outcome)]);
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code: outcome });
    });

    it("names the masked email on recipient_mismatch", async () => {
      const { response } = await call(acceptReq, [accepted("recipient_mismatch"), ["ws_invitation_preview", () => [previewRow]]]);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "recipient_mismatch" });
      expect(response.json().detail).toContain("b***@example.com");
    });

    it("still answers recipient_mismatch when the hint is unavailable", async () => {
      const { response } = await call(acceptReq, [accepted("recipient_mismatch")]);
      expect(response.statusCode).toBe(403);
    });

    it("fails closed on an unknown outcome", async () => {
      const { response } = await call(acceptReq, [accepted("weird")]);
      expect(response.statusCode).toBe(500);
    });

    it("rejects a short token before SQL", async () => {
      const { response, calls } = await call({ ...acceptReq, payload: { token: "short" } });
      expect(response.statusCode).toBe(400);
      expect(calls.some((c) => c.sql.includes("ws_accept_invitation"))).toBe(false);
    });
  });
});
