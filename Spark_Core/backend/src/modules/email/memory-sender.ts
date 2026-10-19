import type { EmailMessage, EmailSender } from "./email-sender.js";

/** Keeps sent messages in memory; for tests and local experiments only. */
export function createMemorySender(): EmailSender & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
      return { messageId: `memory-${sent.length}` };
    },
  };
}
