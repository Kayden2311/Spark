import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import type { EmailMessage, EmailSender } from "../email/email-sender.js";
import { DeliveryError, retryDelayMs } from "../outbox/dispatcher.js";

export interface JobContext {
  pool: Pool;
  sender: EmailSender;
  appBaseUrl: string;
  now(): Date;
}

export interface JobResult {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  /** Rows whose settlement was refused because the lease had passed to another worker. */
  leaseLost: number;
}

export interface Job {
  name: "due_reminders" | "weekly_digest";
  run(context: JobContext): Promise<JobResult>;
}

export interface JobRunnerOptions {
  intervalMs: number;
  now(): Date;
  /** Called with a job that threw, so the other jobs still run. */
  onError?(name: string, error: unknown): void;
}

/** Runs each job at most once per interval. A job that throws is reported through onError and retried next interval. */
export function createJobRunner(
  jobs: Job[],
  options: JobRunnerOptions,
): { runDue(context: JobContext): Promise<Record<string, JobResult>> } {
  const lastRun = new Map<string, number>();
  return {
    async runDue(context) {
      const results: Record<string, JobResult> = {};
      for (const job of jobs) {
        const started = options.now().getTime();
        const previous = lastRun.get(job.name);
        if (previous !== undefined && started - previous < options.intervalMs) continue;
        lastRun.set(job.name, started);
        try {
          results[job.name] = await job.run(context);
        } catch (error) {
          options.onError?.(job.name, error);
        }
      }
      return results;
    },
  };
}

/** A row leased by spark.worker_claim_scheduled_emails. */
export interface ScheduledRow {
  id: string;
  userId: string;
  tenantId: string | null;
  /** The local period as YYYY-MM-DD. */
  period: string;
}

/** What to do with a claimed row: send a message, or close it unsent. Throw (DeliveryError or anything) to retry. */
export type Prepared = { outcome: "skip" } | { outcome: "send"; message: EmailMessage };

export const SCHEDULED_BATCH_SIZE = 5;
export const SCHEDULED_LEASE_SECONDS = 300;
/** A row is only started with at least this much lease left. */
export const SCHEDULED_START_BUDGET_MS = 30_000;

interface ClaimedRow {
  id: string;
  user_id: string;
  tenant_id: string | null;
  period: string;
}

/**
 * Builds a job from a per-row preparation step. The job claims a batch in its own autocommit statement,
 * prepares and sends each row, and settles every row it started: sent, suppressed (nothing to send) or retry
 * with a 2^attempts minute backoff on a send or template error. Delivery is at least once: a crash between the
 * send and the settlement repeats the email once the lease is over. Rows left unstarted when the lease runs
 * short stay claimed and come back after the lease expires.
 */
export function createScheduledJob(
  name: Job["name"],
  prepare: (row: ScheduledRow, lockToken: string, context: JobContext) => Promise<Prepared>,
): Job {
  // The claim does not return the attempt count, so failures are counted per row in this process.
  const failures = new Map<string, number>();

  return {
    name,
    async run(context) {
      const { pool, sender, now } = context;
      const lockToken = randomUUID();
      // Measured from before the claim so the local deadline is never later than the database's.
      const deadline = now().getTime() + SCHEDULED_LEASE_SECONDS * 1000;
      const claimed = await pool.query<ClaimedRow>(
        "SELECT id, user_id, tenant_id, period::text AS period FROM spark.worker_claim_scheduled_emails($1, $2, $3, $4)",
        [name, lockToken, SCHEDULED_BATCH_SIZE, SCHEDULED_LEASE_SECONDS],
      );
      const result: JobResult = { claimed: claimed.rows.length, sent: 0, skipped: 0, failed: 0, leaseLost: 0 };

      // A settlement that throws (connection loss) is treated like a lost lease: the row comes back after the
      // lease ends and the rest of the batch still runs. The error text is never kept.
      const settle = async (id: string, status: "sent" | "suppressed" | "retry", code: string | null, retryAt: Date | null) => {
        try {
          const settled = await pool.query<{ done: boolean }>(
            "SELECT spark.worker_settle_scheduled_email($1, $2, $3, $4, $5) AS done",
            [id, lockToken, status, code, retryAt],
          );
          return settled.rows[0]?.done === true;
        } catch {
          return false;
        }
      };

      for (const claimedRow of claimed.rows) {
        if (deadline - now().getTime() < SCHEDULED_START_BUDGET_MS) break;
        const row: ScheduledRow = {
          id: claimedRow.id,
          userId: claimedRow.user_id,
          tenantId: claimedRow.tenant_id,
          period: claimedRow.period,
        };
        let code: DeliveryError["code"] | "handler_error" | null = null;
        let prepared: Prepared = { outcome: "skip" };
        try {
          prepared = await prepare(row, lockToken, context);
        } catch (error) {
          code = error instanceof DeliveryError ? error.code : "handler_error";
        }
        if (code === null && prepared.outcome === "send") {
          try {
            await sender.send(prepared.message);
          } catch {
            code = "smtp_error";
          }
        }

        if (code !== null) {
          const attempts = (failures.get(row.id) ?? 0) + 1;
          failures.set(row.id, attempts);
          const done = await settle(row.id, "retry", code, new Date(now().getTime() + retryDelayMs(attempts)));
          if (done) result.failed += 1;
          else result.leaseLost += 1;
          continue;
        }
        failures.delete(row.id);
        const sending = prepared.outcome === "send";
        const done = await settle(row.id, sending ? "sent" : "suppressed", null, null);
        if (!done) result.leaseLost += 1;
        else if (sending) result.sent += 1;
        else result.skipped += 1;
      }
      return result;
    },
  };
}
