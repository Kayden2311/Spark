import { Pool } from "pg";

import { loadWorkerConfig } from "./config.js";
import { assertWorkerRole } from "./infrastructure/database/roles.js";
import { createSmtpSender } from "./modules/email/smtp-sender.js";
import { dueRemindersJob } from "./modules/jobs/due-reminders.js";
import { createJobRunner } from "./modules/jobs/runner.js";
import type { JobContext } from "./modules/jobs/runner.js";
import { weeklyDigestJob } from "./modules/jobs/weekly-digest.js";
import { createDispatcher } from "./modules/outbox/dispatcher.js";
import { outboxHandlers } from "./modules/outbox/handlers.js";

// Background worker. It alone holds the worker database role (spark_worker), which can only claim and
// settle outbox events, read or re-tokenize invitations, and read task-assigned emails and record their
// delivery. It serves no HTTP traffic. Logs carry counts and error codes only: never addresses, tokens or
// message text.
const IDLE_WAIT_MS = 2_000;
const JOB_INTERVAL_MS = 60_000;
const once = process.argv.includes("--once");
const config = loadWorkerConfig();
const levels = ["debug", "info", "warn", "error", "fatal"];
const minimum = Math.max(0, levels.indexOf(config.logLevel));

function log(level: "info" | "error" | "fatal", msg: string, fields: Record<string, unknown> = {}): void {
  if (levels.indexOf(level) < minimum) return;
  const line = JSON.stringify({ level, time: new Date().toISOString(), service: "worker", msg, ...fields });
  if (level === "info") console.log(line);
  else console.error(line);
}

/** A loggable identifier for an error, without its message (which may echo data). */
function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
    if (error instanceof Error) return error.name;
  }
  return "unknown";
}

const pool = new Pool({
  connectionString: config.workerDatabaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
  max: 2,
  application_name: "spark-worker",
});
pool.on("error", (error) => log("error", "PostgreSQL worker pool error", { code: errorCode(error) }));

const sender = createSmtpSender(config.smtpUrl, config.emailFrom, { requireTls: config.smtpRequireTls });
const dispatcher = createDispatcher({ pool, sender, handlers: outboxHandlers, appBaseUrl: config.appBaseUrl });

// Scheduled emails (due-task reminders, Monday digest): each job runs at most once a minute, after the outbox turn.
let jobFailed = false;
const runner = createJobRunner([dueRemindersJob, weeklyDigestJob], {
  intervalMs: JOB_INTERVAL_MS,
  now: () => new Date(),
  onError: (name, error) => {
    jobFailed = true;
    log("error", "Scheduled job failed", { job: name, code: errorCode(error) });
  },
});
const jobContext: JobContext = { pool, sender, appBaseUrl: config.appBaseUrl, now: () => new Date() };

let stopping = false;
let wake: (() => void) | null = null;

function idle(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      wake = null;
      resolve();
    }
    wake = done;
  });
}

function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  log("info", "Stopping worker", { signal });
  wake?.();
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

try {
  await assertWorkerRole(pool);
  log("info", "Worker started", { once });
  while (!stopping) {
    try {
      const result = await dispatcher.runOnce();
      if (result.claimed > 0) log("info", "Outbox batch processed", result);
      jobFailed = false;
      const jobs = await runner.runDue(jobContext);
      for (const [job, outcome] of Object.entries(jobs)) {
        if (outcome.claimed > 0) log("info", "Scheduled batch processed", { job, ...outcome });
      }
      if (jobFailed && once) process.exitCode = 1;
      if (result.claimed === 0) {
        if (once) break;
        await idle(IDLE_WAIT_MS);
      }
    } catch (error) {
      log("error", "Outbox batch failed", { code: errorCode(error) });
      if (once) {
        process.exitCode = 1;
        break;
      }
      await idle(IDLE_WAIT_MS);
    }
  }
} catch (error) {
  log("fatal", "Worker startup failed", { code: errorCode(error), reason: error instanceof Error ? error.message : "unknown" });
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => undefined);
}
