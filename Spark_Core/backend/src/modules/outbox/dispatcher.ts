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
  /** Milliseconds left on the batch lease. Handlers check it before irreversible steps. */
  leaseRemainingMs(): number;
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

/**
 * Thrown by a handler that must not continue because too little of the lease is left. The event is left
 * claimed (neither completed nor failed) and is claimed again once the lease expires.
 */
export class LeaseBudgetExhausted extends Error {
  constructor() {
    super("lease budget exhausted");
    this.name = "LeaseBudgetExhausted";
  }
}

export type DispatchResult = {
  claimed: number;
  sent: number;
  failed: number;
  /** Events whose completion or failure was refused because the lease had passed to another worker. */
  leaseLost: number;
};

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

/**
 * Worst case for one event is roughly 45 s: a few database calls under the 15 s statement timeout plus
 * the SMTP connect (10 s), greeting (10 s) and socket (20 s) timeouts. Five events under a 300 s lease
 * (the database caps it at 600 s) leave room for all of them, and the budget checks below stop early
 * when an event would not fit.
 */
export const DEFAULT_BATCH_SIZE = 5;
export const DEFAULT_LEASE_SECONDS = 300;
/** An event is only started with at least this much lease left. */
export const EVENT_START_BUDGET_MS = 90_000;
/** A handler never issues a new invitation token with less than this much lease left. */
export const TOKEN_ISSUE_BUDGET_MS = 60_000;

/** Retry delay after the given number of attempts: 2^attempts minutes, at most six hours. */
export function retryDelayMs(attempts: number): number {
  return Math.min(2 ** attempts * 60_000, MAX_BACKOFF_MS);
}

/**
 * Claims a batch of due outbox events under one lease and runs each through its handler. Unknown event
 * types are completed without action. Delivery is at least once: an event whose lease expires mid-send
 * may be delivered again by another worker. When the lease is close to running out the batch stops early
 * and the unprocessed events stay claimed until the lease expires.
 */
export function createDispatcher(options: DispatcherOptions): { runOnce(): Promise<DispatchResult> } {
  const {
    pool, sender, handlers, appBaseUrl, now = () => new Date(), batchSize = DEFAULT_BATCH_SIZE, leaseSeconds = DEFAULT_LEASE_SECONDS,
  } = options;

  async function runOnce(): Promise<DispatchResult> {
    const lockToken = randomUUID();
    // The lease is measured from before the claim, so the local deadline is never later than the database's.
    const deadline = now().getTime() + leaseSeconds * 1000;
    const leaseRemainingMs = () => deadline - now().getTime();
    const context: HandlerContext = { pool, sender, appBaseUrl, leaseRemainingMs };
    const claimed = await pool.query<ClaimedRow>(
      "SELECT id, tenant_id, event_type, aggregate_type, aggregate_id, payload, attempts FROM spark.worker_claim_outbox($1, $2, $3)",
      [lockToken, batchSize, leaseSeconds],
    );
    let sent = 0;
    let failed = 0;
    let leaseLost = 0;
    for (const row of claimed.rows) {
      // Leave the remaining events claimed; they are claimed again after the lease expires.
      if (leaseRemainingMs() < EVENT_START_BUDGET_MS) break;
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
        if (error instanceof LeaseBudgetExhausted) break;
        const code = error instanceof DeliveryError ? error.code : "handler_error";
        const retryAt = new Date(now().getTime() + retryDelayMs(event.attempts));
        const recorded = await pool.query<{ done: boolean }>(
          "SELECT spark.worker_fail_outbox($1, $2, $3, $4) AS done",
          [event.id, lockToken, code, retryAt],
        );
        if (recorded.rows[0]?.done === true) failed += 1;
        else leaseLost += 1;
        continue;
      }
      const completed = await pool.query<{ done: boolean }>("SELECT spark.worker_complete_outbox($1, $2) AS done", [event.id, lockToken]);
      if (completed.rows[0]?.done !== true) leaseLost += 1;
      else if (outcome === "sent") sent += 1;
    }
    return { claimed: claimed.rows.length, sent, failed, leaseLost };
  }

  return { runOnce };
}
