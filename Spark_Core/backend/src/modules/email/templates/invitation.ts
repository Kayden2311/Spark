import type { EmailMessage } from "../email-sender.js";
import { renderEmail } from "../layout.js";

export interface InvitationEmailInput {
  inviterName: string;
  workspaceName: string;
  role: string;
  acceptUrl: string;
  expiresAt: Date;
  appBaseUrl: string;
}

/** Collapses whitespace, including CR/LF, so names are safe in a subject line and in prose. */
function plain(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

const EXPIRY_FORMAT = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" });

export function invitationEmail(input: InvitationEmailInput): Omit<EmailMessage, "to"> {
  const inviter = plain(input.inviterName);
  const workspace = plain(input.workspaceName);
  const role = input.role === "admin" ? "an admin" : "a member";
  const expires = `${EXPIRY_FORMAT.format(input.expiresAt)} UTC`;
  const { html, text } = renderEmail({
    preheader: `${inviter} invited you to join ${workspace} on Spark.`,
    heading: `Join ${workspace} on Spark`,
    paragraphs: [
      `${inviter} invited you to join the ${workspace} workspace as ${role}.`,
      `This invitation expires on ${expires}. If you were not expecting it, you can ignore this email.`,
    ],
    action: { label: "Accept invitation", url: input.acceptUrl },
    footerNote: "You received this email because someone invited this address to a Spark workspace.",
    appBaseUrl: input.appBaseUrl,
  });
  return { subject: `${inviter} invited you to ${workspace} on Spark`, html, text };
}
