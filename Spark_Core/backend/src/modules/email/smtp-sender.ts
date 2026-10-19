import { createTransport } from "nodemailer";

import type { EmailSender } from "./email-sender.js";

/**
 * SMTP delivery through nodemailer. Timeouts stay well inside the worker's outbox lease. With `requireTls`
 * (always in production) a plain smtp:// connection must upgrade with STARTTLS or the send fails;
 * smtps:// connects with TLS from the start.
 */
export function createSmtpSender(smtpUrl: string, from: string, { requireTls }: { requireTls: boolean }): EmailSender {
  const transport = createTransport({
    url: smtpUrl,
    requireTLS: requireTls,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    async send(message) {
      // An address object is used verbatim; a plain string would be parsed as a list (for example at commas).
      const to = { name: "", address: message.to };
      const info = await transport.sendMail({ from, to, subject: message.subject, html: message.html, text: message.text });
      return { messageId: typeof info.messageId === "string" ? info.messageId : null };
    },
  };
}
