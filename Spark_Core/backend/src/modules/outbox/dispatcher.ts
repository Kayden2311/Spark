import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import type { EmailSender } from "../email/email-sender.js";

export interface OutboxEvent {
  id: string;
  tenantId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  attempts: number;
}

export interface HandlerContext {
  pool: Pool;
  sender: EmailSender;
  appBaseUrl: string;
}

/** "sent" when an email went out, "skipped" when the event needed no delivery. Throw to retry. */
export type Handler = (event: OutboxEvent, context: HandlerContext) => Promise<"sent" | "skipped">;

/**
 * A delivery failure with a short identifier that is safe to store (never message text or addresses).
 * Any other error is recorded as handler_error.
 */
export class DeliveryError extends Error {
  constructor(readonly code: "smtp_error" | "template_error" | "not_found" | "invalid_payload") {
    super(code);
    this.name = "DeliveryError";
  }
}

export interface DispatcherOptions {
  pool: Pool;
  sender: EmailSender;
  handlers: Record<string, Handler>;
  appBaseUrl: string;
  now?: () => Date;
  batchSize?: number;
  leaseSeconds?: number;
}

interface ClaimedRow {
  id: string;
  tenant_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
  attempts: number;
}

const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

/** Retry delay after the given number of attempts: 2^attempts minutes, at most six hours. */
export function retryDelayMs(attempts: number): number {
  return Math.min(2 ** attempts * 60_000, MAX_BACKOFF_MS);
}

/**
 * Claims a batch of due outbox events under one lease and runs each through its handler. Unknown event
 * types are completed without action. Delivery is at least once: an event whose lease expires mid-send
 * may be delivered again by another worker.
 */
export function createDispatcher(options: DispatcherOptions): { runOnce(): Promise<{ claimed: number; sent: number; failed: number }> } {
  const { pool, sender, handlers, appBaseUrl, now = () => new Date(), batchSize = 20, leaseSeconds = 120 } = options;
  const context: HandlerContext = { pool, sender, appBaseUrl };

  async function runOnce() {
    const lockToken = randomUUID();
    const claimed = await pool.query<ClaimedRow>(
      "SELECT id, tenant_id, event_type, aggregate_type, aggregate_id, payload, attempts FROM spark.worker_claim_outbox($1, $2, $3)",
      [lockToken, batchSize, leaseSeconds],
    );
    let sent = 0;
    let failed = 0;
    for (const row of claimed.rows) {
      const event: OutboxEvent = {
        id: row.id,
        tenantId: row.tenant_id,
        eventType: row.event_type,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        payload: row.payload,
        attempts: row.attempts,
      };
      const handler = Object.hasOwn(handlers, event.eventType) ? handlers[event.eventType] : undefined;
      let outcome: "sent" | "skipped";
      try {
        outcome = handler ? await handler(event, context) : "skipped";
      } catch (error) {
        const code = error instanceof DeliveryError ? error.code : "handler_error";
        const retryAt = new Date(now().getTime() + retryDelayMs(event.attempts));
        await pool.query("SELECT spark.worker_fail_outbox($1, $2, $3, $4) AS done", [event.id, lockToken, code, retryAt]);
        failed += 1;
        continue;
      }
      await pool.query("SELECT spark.worker_complete_outbox($1, $2) AS done", [event.id, lockToken]);
      if (outcome === "sent") sent += 1;
    }
    return { claimed: claimed.rows.length, sent, failed };
  }

  return { runOnce };
}
