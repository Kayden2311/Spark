import { randomBytes } from "node:crypto";

import { hashSessionToken } from "../../infrastructure/database/session.js";
import type { EmailMessage } from "../email/email-sender.js";
import { invitationEmail } from "../email/templates/invitation.js";
import { taskAssignedEmail } from "../email/templates/task-assigned.js";
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

interface TaskAssignedEmailRow {
  status: string;
  email: string;
  recipient_name: string;
  actor_name: string;
  workspace_name: string;
  workspace_slug: string;
  project_key: string;
  project_name: string;
  issue_number: string;
  issue_title: string;
}

/** The notification an issue event asks the worker to email, or null when the event needs no email. */
function assignmentNotificationId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) throw new DeliveryError("invalid_payload");
  if (!Object.hasOwn(payload, "notificationId")) return null;
  const id = (payload as { notificationId?: unknown }).notificationId;
  if (typeof id !== "string" || !UUID.test(id)) throw new DeliveryError("invalid_payload");
  return id;
}

/**
 * Emails the assignee of an issue_assigned notification once. The database decides whether the email is
 * still wanted (assignee, membership, archive state, preference, earlier delivery); a refused email is
 * recorded as suppressed. Delivery is at least once: a send whose lease expires before it is recorded may
 * be repeated by another worker.
 */
const deliverTaskAssigned: Handler = async (event, { pool, sender, appBaseUrl }) => {
  const id = assignmentNotificationId(event.payload);
  if (id === null) return "skipped";
  const found = await pool.query<TaskAssignedEmailRow>(
    `SELECT status, email, recipient_name, actor_name, workspace_name, workspace_slug, project_key, project_name, issue_number, issue_title
     FROM spark.worker_task_assigned_email($1)`,
    [id],
  );
  const row = found.rows[0];
  if (!row) throw new DeliveryError("not_found");
  if (row.status !== "pending") {
    await pool.query("SELECT spark.worker_record_email_delivery($1, $2) AS recorded", [id, "suppressed"]);
    return "skipped";
  }

  const issueKey = `${row.project_key}-${row.issue_number}`;
  let message: Omit<EmailMessage, "to">;
  try {
    message = taskAssignedEmail({
      actorName: row.actor_name,
      recipientName: row.recipient_name,
      issueKey,
      issueTitle: row.issue_title,
      projectName: row.project_name,
      workspaceName: row.workspace_name,
      issueUrl: `${appBaseUrl}/w/${encodeURIComponent(row.workspace_slug)}/p/${encodeURIComponent(row.project_key)}?issue=${encodeURIComponent(issueKey)}`,
      preferencesUrl: `${appBaseUrl}/settings/notifications`,
    });
  } catch {
    throw new DeliveryError("template_error");
  }

  try {
    await sender.send({ to: row.email, ...message });
  } catch {
    throw new DeliveryError("smtp_error");
  }
  await pool.query("SELECT spark.worker_record_email_delivery($1, $2) AS recorded", [id, "sent"]);
  return "sent";
};

/** Event types the worker acts on. Every other event type is completed without action. */
export const outboxHandlers: Record<string, Handler> = {
  "invitation.created": deliverInvitation,
  "invitation.resent": deliverInvitation,
  "issue.created": deliverTaskAssigned,
  "issue.updated": deliverTaskAssigned,
};
