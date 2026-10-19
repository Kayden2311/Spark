import { randomBytes } from "node:crypto";

import { hashSessionToken } from "../../infrastructure/database/session.js";
import type { EmailMessage } from "../email/email-sender.js";
import { invitationEmail } from "../email/templates/invitation.js";
import { DeliveryError, LeaseBudgetExhausted, TOKEN_ISSUE_BUDGET_MS } from "./dispatcher.js";
import type { Handler } from "./dispatcher.js";

interface InvitationEmailRow {
  status: string;
  email: string;
  workspace_name: string;
  inviter_name: string;
  role: string;
  expires_at: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function invitationId(payload: unknown): string {
  const id = typeof payload === "object" && payload !== null ? (payload as { invitationId?: unknown }).invitationId : undefined;
  if (typeof id !== "string" || !UUID.test(id)) throw new DeliveryError("invalid_payload");
  return id;
}

/**
 * Sends (or re-sends) an invitation email. A fresh token is generated for every send; only its SHA-256
 * hash is stored, which also invalidates any earlier link. The raw token lives only in this function's
 * memory and in the email itself, in the URL fragment so it never reaches a server log.
 */
const deliverInvitation: Handler = async (event, { pool, sender, appBaseUrl, leaseRemainingMs }) => {
  const id = invitationId(event.payload);
  const found = await pool.query<InvitationEmailRow>(
    "SELECT status, email, workspace_name, inviter_name, role, expires_at FROM spark.worker_invitation_email($1)",
    [id],
  );
  const invitation = found.rows[0];
  if (!invitation) throw new DeliveryError("not_found");
  if (invitation.status !== "pending") return "skipped";

  const token = randomBytes(32).toString("hex");
  let message: Omit<EmailMessage, "to">;
  try {
    message = invitationEmail({
      inviterName: invitation.inviter_name,
      workspaceName: invitation.workspace_name,
      role: invitation.role,
      acceptUrl: `${appBaseUrl}/invitations/accept#token=${token}`,
      expiresAt: invitation.expires_at,
    });
  } catch {
    throw new DeliveryError("template_error");
  }

  // Issuing a token invalidates the previous link, so only do it when the send can still finish in the lease.
  if (leaseRemainingMs() < TOKEN_ISSUE_BUDGET_MS) throw new LeaseBudgetExhausted();
  const issued = await pool.query<{ issued: boolean }>(
    "SELECT spark.worker_issue_invitation_token($1, $2) AS issued",
    [id, hashSessionToken(token)],
  );
  // Revoked, accepted or expired since it was read: nothing to send.
  if (issued.rows[0]?.issued !== true) return "skipped";

  try {
    await sender.send({ to: invitation.email, ...message });
  } catch {
    throw new DeliveryError("smtp_error");
  }
  return "sent";
};

/** Event types the worker acts on. Every other event type is completed without action. */
export const outboxHandlers: Record<string, Handler> = {
  "invitation.created": deliverInvitation,
  "invitation.resent": deliverInvitation,
};
