export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Delivers one message. Implementations throw on failure; callers decide whether to retry. */
export interface EmailSender {
  send(message: EmailMessage): Promise<{ messageId: string | null }>;
}
