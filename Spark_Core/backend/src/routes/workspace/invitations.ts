import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";

import { hashSessionToken } from "../../infrastructure/database/session.js";
import { problem } from "../responses.js";
import { expectOutcome } from "../session-guard.js";
import type { MemberGuard } from "./guard.js";
import { readWorkspace } from "./workspaces.js";

const STATUSES = ["pending", "accepted", "revoked", "expired"] as const;
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = "^[0-9a-f]{64}$";

// Create and resend: 20 per 10 minutes. Preview and accept are token guessing surfaces: 10 per minute.
const INVITE_RATE_LIMIT = { rateLimit: { max: 20, timeWindow: 10 * 60 * 1000 } } as const;
const TOKEN_RATE_LIMIT = { rateLimit: { max: 10, timeWindow: 60 * 1000 } } as const;

const invitationSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    email: { type: "string" },
    role: { type: "string", enum: ["admin", "member"] },
    status: { type: "string", enum: STATUSES },
    invitedBy: { type: "object", properties: { id: { type: "string" }, displayName: { type: "string" } } },
    expiresAt: { type: "string", format: "date-time" },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

const wrapped = { type: "object", properties: { invitation: invitationSchema } } as const;

const workspaceParams = {
  type: "object",
  required: ["workspaceId"],
  properties: { workspaceId: { type: "string", format: "uuid" } },
  additionalProperties: false,
} as const;

const invitationParams = {
  type: "object",
  required: ["workspaceId", "invitationId"],
  properties: { workspaceId: { type: "string", format: "uuid" }, invitationId: { type: "string", format: "uuid" } },
  additionalProperties: false,
} as const;

const tokenBody = {
  type: "object",
  required: ["token"],
  properties: { token: { type: "string", pattern: TOKEN_PATTERN } },
  additionalProperties: false,
} as const;

interface InvitationRow {
  id: string;
  email: string;
  role: string;
  status: string;
  invited_by_user_id: string;
  invited_by_name: string;
  expires_at: Date;
  created_at: Date;
}

function toInvitation(row: InvitationRow) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    invitedBy: { id: row.invited_by_user_id, displayName: row.invited_by_name },
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

// Explicit columns only: token_hash is neither granted to the runtime role nor ever selected. A pending
// invitation past its expiry reads as expired even before the database settles it.
const SELECT_INVITATIONS = `SELECT * FROM (
  SELECT i.id, i.email_normalized AS email, i.role,
    CASE WHEN i.status = 'pending' AND i.expires_at <= now() THEN 'expired' ELSE i.status END AS status,
    i.invited_by_user_id, COALESCE(u.display_name, 'Former member') AS invited_by_name, i.expires_at, i.created_at
  FROM spark.workspace_invitations i
  LEFT JOIN spark.users u ON u.id = i.invited_by_user_id
  WHERE i.tenant_id = $1
) x`;

async function readInvitation(client: PoolClient, workspaceId: string, invitationId: string): Promise<InvitationRow | null> {
  const result = await client.query<InvitationRow>(`${SELECT_INVITATIONS} WHERE x.id = $2`, [workspaceId, invitationId]);
  return result.rows[0] ?? null;
}

type Mapped = [number, string, string, string];

const workspaceNotFound: Mapped = [404, "Not Found", "workspace_not_found", "Workspace does not exist."];
const invitationNotFound: Mapped = [404, "Not Found", "invitation_not_found", "Invitation does not exist in this workspace."];
const insufficientRole: Mapped = [403, "Forbidden", "insufficient_role", "Only an owner or admin can manage invitations."];
const invalidInvitation: Mapped = [404, "Not Found", "invalid_invitation", "This invitation link is not valid."];

const createOutcomes: Record<string, Mapped> = {
  not_found: workspaceNotFound,
  forbidden: [403, "Forbidden", "insufficient_role", "Your role does not allow inviting with that role."],
  already_member: [409, "Conflict", "already_member", "That person is already a member of this workspace."],
  invitation_pending: [409, "Conflict", "invitation_pending", "A pending invitation already exists for that email."],
  too_many_invitations: [409, "Conflict", "too_many_invitations", "This workspace has too many pending invitations."],
};

const settleOutcomes: Record<string, Mapped> = {
  not_found: invitationNotFound,
  forbidden: [403, "Forbidden", "insufficient_role", "Your role does not allow changing this invitation."],
  not_pending: [409, "Conflict", "not_pending", "The invitation is no longer pending."],
};

const acceptOutcomes: Record<string, Mapped> = {
  invalid_invitation: invalidInvitation,
  invitation_expired: [409, "Conflict", "invitation_expired", "This invitation has expired."],
  invitation_revoked: [409, "Conflict", "invitation_revoked", "This invitation was revoked."],
  invitation_used: [409, "Conflict", "invitation_used", "This invitation was already used."],
  membership_suspended: [403, "Forbidden", "membership_suspended", "Your membership in this workspace is suspended."],
};

interface PreviewRow {
  status: string;
  workspace_name: string | null;
  inviter_name: string | null;
  role: string | null;
  email_hint: string | null;
  expires_at: Date | null;
}

const PREVIEW = "SELECT status, workspace_name, inviter_name, role, email_hint, expires_at FROM spark.ws_invitation_preview($1)";

interface AcceptRow {
  outcome: string;
  workspace_id: string | null;
  workspace_slug: string | null;
  role: string | null;
}

/** Owner/admin gate shared by resend and revoke: the invitation must belong to the workspace in the path. */
async function gateManagedInvitation(client: PoolClient, userId: string, workspaceId: string, invitationId: string): Promise<Mapped | null> {
  const workspace = await readWorkspace(client, userId, { id: workspaceId });
  if (!workspace) return workspaceNotFound;
  if (workspace.role === "member") return insufficientRole;
  return (await readInvitation(client, workspaceId, invitationId)) ? null : invitationNotFound;
}

export function registerInvitationRoutes(app: FastifyInstance, guard: MemberGuard, pool: Pool): void {
  app.post<{ Params: { workspaceId: string }; Body: { email: string; role: "admin" | "member" } }>(
    "/api/v1/workspaces/:workspaceId/invitations",
    {
      config: INVITE_RATE_LIMIT,
      schema: {
        params: workspaceParams,
        body: {
          type: "object",
          required: ["email", "role"],
          properties: { email: { type: "string", minLength: 3, maxLength: 254 }, role: { type: "string", enum: ["admin", "member"] } },
          additionalProperties: false,
        },
        response: { 201: wrapped },
      },
    },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const { workspaceId } = request.params;
      const result = await guard.run(request, reply, member, async (client) => {
        const created = await client.query<{ outcome: string; invitation_id: string | null }>(
          "SELECT outcome, invitation_id FROM spark.ws_create_invitation($1, $2, $3, $4)",
          [workspaceId, request.body.email, request.body.role, new Date(Date.now() + INVITATION_TTL_MS)],
        );
        const row = created.rows[0];
        const mapped = row ? createOutcomes[row.outcome] : undefined;
        if (mapped) return { mapped };
        expectOutcome(row?.outcome, "ok");
        const invitation = row?.invitation_id ? await readInvitation(client, workspaceId, row.invitation_id) : null;
        if (!invitation) throw new Error("Created invitation is not readable");
        return { invitation };
      });
      if (reply.sent || !result) return reply;
      if (result.mapped) return problem(request, reply, ...result.mapped);
      return reply
        .code(201)
        .header("Location", `/api/v1/workspaces/${workspaceId}/invitations/${result.invitation.id}`)
        .send({ invitation: toInvitation(result.invitation) });
    },
  );

  app.post<{ Params: { workspaceId: string; invitationId: string } }>(
    "/api/v1/workspaces/:workspaceId/invitations/:invitationId/resend",
    { config: INVITE_RATE_LIMIT, schema: { params: invitationParams, response: { 202: wrapped } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const { workspaceId, invitationId } = request.params;
      const result = await guard.run(request, reply, member, async (client) => {
        const gate = await gateManagedInvitation(client, member.userId, workspaceId, invitationId);
        if (gate) return { mapped: gate };
        const resent = await client.query<{ outcome: string }>("SELECT spark.ws_resend_invitation($1) AS outcome", [invitationId]);
        const outcome = resent.rows[0]?.outcome;
        const mapped = outcome ? settleOutcomes[outcome] : undefined;
        if (mapped) return { mapped };
        expectOutcome(outcome, "ok");
        const invitation = await readInvitation(client, workspaceId, invitationId);
        if (!invitation) throw new Error("Resent invitation is not readable");
        return { invitation };
      });
      if (reply.sent || !result) return reply;
      if (result.mapped) return problem(request, reply, ...result.mapped);
      return reply.code(202).send({ invitation: toInvitation(result.invitation) });
    },
  );

  app.get<{ Params: { workspaceId: string }; Querystring: { status?: (typeof STATUSES)[number] } }>(
    "/api/v1/workspaces/:workspaceId/invitations",
    {
      schema: {
        params: workspaceParams,
        querystring: { type: "object", properties: { status: { type: "string", enum: STATUSES } }, additionalProperties: false },
        response: { 200: { type: "object", properties: { items: { type: "array", items: invitationSchema } } } },
      },
    },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const { workspaceId } = request.params;
      const { status } = request.query;
      const result = await guard.run(request, reply, member, async (client) => {
        // The role is checked first so a plain member gets a clear 403 instead of an empty, RLS-filtered list.
        const workspace = await readWorkspace(client, member.userId, { id: workspaceId });
        if (!workspace) return { mapped: workspaceNotFound };
        if (workspace.role === "member") return { mapped: insufficientRole };
        const filter = status ? " WHERE x.status = $2" : "";
        const rows = await client.query<InvitationRow>(
          `${SELECT_INVITATIONS}${filter} ORDER BY x.created_at DESC, x.id`,
          status ? [workspaceId, status] : [workspaceId],
        );
        return { rows: rows.rows };
      });
      if (reply.sent || !result) return reply;
      if (result.mapped) return problem(request, reply, ...result.mapped);
      return { items: result.rows.map(toInvitation) };
    },
  );

  app.delete<{ Params: { workspaceId: string; invitationId: string } }>(
    "/api/v1/workspaces/:workspaceId/invitations/:invitationId",
    { config: INVITE_RATE_LIMIT, schema: { params: invitationParams } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const { workspaceId, invitationId } = request.params;
      const mapped = await guard.run(request, reply, member, async (client) => {
        const gate = await gateManagedInvitation(client, member.userId, workspaceId, invitationId);
        if (gate) return gate;
        const revoked = await client.query<{ outcome: string }>("SELECT spark.ws_revoke_invitation($1) AS outcome", [invitationId]);
        const outcome = revoked.rows[0]?.outcome;
        const known = outcome ? settleOutcomes[outcome] : undefined;
        if (known) return known;
        expectOutcome(outcome, "ok");
        return null;
      });
      if (reply.sent || mapped === undefined) return reply;
      if (mapped) return problem(request, reply, ...mapped);
      return reply.code(204).send();
    },
  );

  // Public: the emailed token is the credential. It is hashed here and never logged or echoed.
  app.post<{ Body: { token: string } }>(
    "/api/v1/invitations/preview",
    {
      config: TOKEN_RATE_LIMIT,
      schema: {
        body: tokenBody,
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string", enum: STATUSES },
              workspaceName: { type: ["string", "null"] },
              inviterName: { type: ["string", "null"] },
              role: { type: ["string", "null"] },
              emailHint: { type: ["string", "null"] },
              expiresAt: { type: ["string", "null"], format: "date-time" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const result = await pool.query<PreviewRow>(PREVIEW, [hashSessionToken(request.body.token)]);
      const row = result.rows[0];
      if (!row) return problem(request, reply, ...invalidInvitation);
      return {
        status: row.status,
        workspaceName: row.workspace_name,
        inviterName: row.inviter_name,
        role: row.role,
        emailHint: row.email_hint,
        expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
      };
    },
  );

  app.post<{ Body: { token: string } }>(
    "/api/v1/invitations/accept",
    {
      config: TOKEN_RATE_LIMIT,
      schema: {
        body: tokenBody,
        response: {
          200: {
            type: "object",
            properties: {
              workspace: { type: "object", properties: { id: { type: "string" }, slug: { type: "string" } } },
              role: { type: "string", enum: ["owner", "admin", "member"] },
              alreadyMember: { type: "boolean" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const tokenHash = hashSessionToken(request.body.token);
      const result = await guard.run(request, reply, member, async (client) => {
        const accepted = await client.query<AcceptRow>(
          "SELECT outcome, workspace_id, workspace_slug, role FROM spark.ws_accept_invitation($1)",
          [tokenHash],
        );
        const row = accepted.rows[0];
        const outcome = row?.outcome;
        if (outcome === "recipient_mismatch") {
          // Still pending, so the preview carries the masked address that tells the user which account to use.
          const hint = (await client.query<PreviewRow>(PREVIEW, [tokenHash])).rows[0]?.email_hint;
          const detail = hint
            ? `This invitation was sent to ${hint}. Sign in with that account to accept it.`
            : "This invitation was sent to a different email address.";
          const mapped: Mapped = [403, "Forbidden", "recipient_mismatch", detail];
          return { mapped };
        }
        const mapped = outcome ? acceptOutcomes[outcome] : undefined;
        if (mapped) return { mapped };
        expectOutcome(outcome, "ok", "already_member");
        if (!row?.workspace_id || !row.workspace_slug || !row.role) throw new Error("Accepted invitation has no workspace");
        return { joined: { workspace: { id: row.workspace_id, slug: row.workspace_slug }, role: row.role, alreadyMember: outcome === "already_member" } };
      });
      if (reply.sent || !result) return reply;
      if (result.mapped) return problem(request, reply, ...result.mapped);
      return result.joined;
    },
  );
}
