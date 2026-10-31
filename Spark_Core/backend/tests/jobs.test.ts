import { describe, expect, it } from "vitest";

import type { EmailSender } from "../src/modules/email/email-sender.js";
import { createMemorySender } from "../src/modules/email/memory-sender.js";
import { dueRemindersJob } from "../src/modules/jobs/due-reminders.js";
import { createJobRunner } from "../src/modules/jobs/runner.js";
import type { Job, JobContext, JobResult } from "../src/modules/jobs/runner.js";
import { weeklyDigestJob } from "../src/modules/jobs/weekly-digest.js";
import { fakePool } from "./fake-pool.js";
import type { QueryHandler } from "./fake-pool.js";

const empty: JobResult = { claimed: 0, sent: 0, skipped: 0, failed: 0, leaseLost: 0 };
const callsTo = (calls: Array<{ sql: string; params: unknown[] }>, fragment: string) => calls.filter((call) => call.sql.includes(fragment));

describe("job runner", () => {
  function setup(onError?: (name: string, error: unknown) => void) {
    let time = Date.parse("2026-10-31T10:00:00Z");
    const runs: string[] = [];
    const job = (name: Job["name"], fail = false): Job => ({
      name,
      async run() {
        runs.push(name);
        if (fail) throw new Error("boom");
        return empty;
      },
    });
    const runner = createJobRunner([job("due_reminders", true), job("weekly_digest")], { intervalMs: 60_000, now: () => new Date(time), ...(onError ? { onError } : {}) });
    const context = { pool: fakePool().pool, sender: createMemorySender(), appBaseUrl: "http://localhost:3000", now: () => new Date(time) };
    return { runner, runs, context, advance: (ms: number) => { time += ms; } };
  }

  it("runs each job at most once per interval", async () => {
    const { runner, runs, context, advance } = setup();
    expect(Object.keys(await runner.runDue(context))).toEqual(["weekly_digest"]);
    advance(59_999);
    expect(await runner.runDue(context)).toEqual({});
    expect(runs).toEqual(["due_reminders", "weekly_digest"]);
    advance(1);
    await runner.runDue(context);
    expect(runs).toEqual(["due_reminders", "weekly_digest", "due_reminders", "weekly_digest"]);
  });

  it("reports a failing job and still runs the others", async () => {
    const failures: string[] = [];
    const { runner, context } = setup((name) => failures.push(name));
    const results = await runner.runDue(context);
    expect(failures).toEqual(["due_reminders"]);
    expect(results).toEqual({ weekly_digest: empty });
  });
});

const jobId = "0b6c2f4e-0000-4000-8000-000000000001";
const otherId = "0b6c2f4e-0000-4000-8000-000000000002";
const claimRow = (id: string, period = "2026-10-31") => ({ id, user_id: "7b1c7c62-2f62-4f8e-9a3c-5d3f1f0a9e11", tenant_id: null, period });

describe("due reminder job", () => {
  const task = (overrides: Record<string, unknown> = {}) => ({
    status: "pending", email: "bob@example.com", recipient_name: "Bob Stone", total: 2, task_workspace: "Acme", task_workspace_slug: "acme",
    task_key: "WEB-42", task_title: "Fix login", task_due: "2026-10-30", task_overdue: true, ...overrides,
  });
  const twoTasks = [task(), task({ task_key: "API-7", task_title: "Ship <API>", task_due: "2026-11-01", task_overdue: false })];

  function setup(options: { claimed?: unknown[]; reminder?: QueryHandler; settle?: QueryHandler; sender?: EmailSender; appBaseUrl?: string; now?: () => Date } = {}) {
    const memory = createMemorySender();
    const { pool, calls } = fakePool([
      ["worker_claim_scheduled_emails", () => options.claimed ?? [claimRow(jobId)]],
      ["worker_due_reminder_email", options.reminder ?? (() => twoTasks)],
      ["worker_settle_scheduled_email", options.settle ?? (() => [{ done: true }])],
    ]);
    const context: JobContext = {
      pool, sender: options.sender ?? memory, appBaseUrl: options.appBaseUrl ?? "http://localhost:3000", now: options.now ?? (() => new Date("2026-10-31T10:00:00Z")),
    };
    return { context, calls, memory };
  }

  it("claims five rows under a 300 s lease in its own statement", async () => {
    const { context, calls } = setup({ claimed: [] });
    expect(await dueRemindersJob.run(context)).toEqual(empty);
    const claim = callsTo(calls, "worker_claim_scheduled_emails")[0]!;
    expect(claim.params[0]).toBe("due_reminders");
    expect(claim.params.slice(2)).toEqual([5, 300]);
    expect(calls).toHaveLength(1);
  });

  it("sends one email per claimed row with every task line and a link per task, then settles sent", async () => {
    const { context, calls, memory } = setup({ claimed: [claimRow(jobId), claimRow(otherId)] });
    expect(await dueRemindersJob.run(context)).toEqual({ claimed: 2, sent: 2, skipped: 0, failed: 0, leaseLost: 0 });
    expect(memory.sent).toHaveLength(2);
    const message = memory.sent[0]!;
    expect(message.to).toBe("bob@example.com");
    expect(message.subject).toBe("You have 2 tasks due soon (1 overdue)");
    expect(message.text).toContain("http://localhost:3000/w/acme/p/WEB?issue=WEB-42");
    expect(message.text).toContain("http://localhost:3000/w/acme/p/API?issue=API-7");
    expect(message.text).toContain("Ship <API>");
    expect(message.html).toContain("Ship &lt;API&gt;");
    expect(message.text).toContain("http://localhost:3000/settings/notifications");
    const token = callsTo(calls, "worker_claim_scheduled_emails")[0]!.params[1];
    expect(callsTo(calls, "worker_due_reminder_email").map((call) => call.params)).toEqual([[jobId, token], [otherId, token]]);
    expect(callsTo(calls, "worker_settle_scheduled_email").map((call) => call.params)).toEqual([
      [jobId, token, "sent", null, null],
      [otherId, token, "sent", null, null],
    ]);
  });

  it("settles a skipped row as suppressed without sending", async () => {
    const skipped = { status: "skipped", email: null, recipient_name: null, total: null, task_workspace: null, task_workspace_slug: null, task_key: null, task_title: null, task_due: null, task_overdue: null };
    const { context, calls, memory } = setup({ reminder: () => [skipped] });
    expect(await dueRemindersJob.run(context)).toEqual({ claimed: 1, sent: 0, skipped: 1, failed: 0, leaseLost: 0 });
    expect(memory.sent).toEqual([]);
    expect(callsTo(calls, "worker_settle_scheduled_email")[0]!.params.slice(2)).toEqual(["suppressed", null, null]);
  });

  it("retries with a 2-minute backoff on an SMTP error and never records the address", async () => {
    const sender: EmailSender = { send: async () => { throw new Error("550 bob@example.com rejected"); } };
    const { context, calls } = setup({ sender });
    expect(await dueRemindersJob.run(context)).toEqual({ claimed: 1, sent: 0, skipped: 0, failed: 1, leaseLost: 0 });
    const settle = callsTo(calls, "worker_settle_scheduled_email")[0]!;
    expect(settle.params.slice(2, 4)).toEqual(["retry", "smtp_error"]);
    expect((settle.params[4] as Date).toISOString()).toBe("2026-10-31T10:02:00.000Z");
    expect(JSON.stringify(settle.params)).not.toContain("bob@example.com");
  });

  it("doubles the backoff when the same row fails again in this process", async () => {
    const sender: EmailSender = { send: async () => { throw new Error("down"); } };
    // A row id no other test uses: the failure counter lives in the job.
    const { context, calls } = setup({ sender, claimed: [claimRow("0b6c2f4e-0000-4000-8000-0000000000f1")] });
    await dueRemindersJob.run(context);
    await dueRemindersJob.run(context);
    const retries = callsTo(calls, "worker_settle_scheduled_email").map((call) => (call.params[4] as Date).toISOString());
    expect(retries).toEqual(["2026-10-31T10:02:00.000Z", "2026-10-31T10:04:00.000Z"]);
  });

  it("retries with template_error when the email cannot be built", async () => {
    const { context, calls, memory } = setup({ appBaseUrl: "javascript:alert(1)" });
    expect(await dueRemindersJob.run(context)).toMatchObject({ failed: 1, sent: 0 });
    expect(memory.sent).toEqual([]);
    expect(callsTo(calls, "worker_settle_scheduled_email")[0]!.params.slice(2, 4)).toEqual(["retry", "template_error"]);
  });

  it("retries with handler_error when the read fails", async () => {
    const { context, calls } = setup({ reminder: () => new Error("connection reset") });
    expect(await dueRemindersJob.run(context)).toMatchObject({ failed: 1 });
    expect(callsTo(calls, "worker_settle_scheduled_email")[0]!.params.slice(2, 4)).toEqual(["retry", "handler_error"]);
  });

  it("counts a lost lease on settle instead of a send", async () => {
    const { context } = setup({ settle: () => [{ done: false }] });
    expect(await dueRemindersJob.run(context)).toEqual({ claimed: 1, sent: 0, skipped: 0, failed: 0, leaseLost: 1 });
  });

  it("stops starting rows when less than 30 s of lease remain", async () => {
    let time = Date.parse("2026-10-31T10:00:00Z");
    const { context, calls, memory } = setup({
      claimed: [claimRow(jobId), claimRow(otherId)],
      now: () => new Date(time),
      sender: { send: async () => { time += 280_000; return { messageId: null }; } },
    });
    expect(await dueRemindersJob.run(context)).toEqual({ claimed: 2, sent: 1, skipped: 0, failed: 0, leaseLost: 0 });
    expect(memory.sent).toEqual([]);
    expect(callsTo(calls, "worker_due_reminder_email")).toHaveLength(1);
    expect(callsTo(calls, "worker_settle_scheduled_email")).toHaveLength(1);
  });
});

describe("weekly digest job", () => {
  const line = (overrides: Record<string, unknown>) => ({
    status: "pending", email: "bob@example.com", recipient_name: "Bob Stone", workspace_name: "Acme", workspace_slug: "acme", section: null,
    project_key: null, project_name: null, methodology: null, label: null, value: null, extra: null, ...overrides,
  });
  const lines = [
    line({ section: "project", project_key: "WEB", project_name: "Website", methodology: "scrum", extra: { done: 5, total: 20, unit: "points", windowStart: "2026-10-26", windowEnd: "2026-11-08", activeSprintName: "Sprint 4" } }),
    line({ section: "project", project_key: "API", project_name: "Backend", methodology: "kanban", extra: { done: 9, total: 10, unit: "count", windowStart: null, windowEnd: null, activeSprintName: null } }),
    line({ section: "member", label: "Zed", value: "2" }),
    line({ section: "member", label: "Ana", value: "2" }),
    line({ section: "member", label: "Bea", value: "5" }),
    line({ section: "at_risk", project_key: "WEB", label: "WEB-1 Ship the thing", extra: { due: "2026-11-01", total: 12 } }),
    line({ section: "overdue", project_key: "API", label: "API-3 Old bug", extra: { due: "2026-10-20", total: 1 } }),
  ];
  const digestId = "0b6c2f4e-0000-4000-8000-0000000000d1";
  const tenant = "9d1c7c62-2f62-4f8e-9a3c-5d3f1f0a9e11";

  function setup(read: QueryHandler = () => lines) {
    const memory = createMemorySender();
    const { pool, calls } = fakePool([
      ["worker_claim_scheduled_emails", () => [{ ...claimRow(digestId, "2026-10-26"), tenant_id: tenant }]],
      ["worker_weekly_digest_email", read],
      ["worker_settle_scheduled_email", () => [{ done: true }]],
    ]);
    const context: JobContext = { pool, sender: memory, appBaseUrl: "http://localhost:3000", now: () => new Date("2026-10-26T09:00:00Z") };
    return { context, calls, memory };
  }

  it("renders plan status with planPercent/planStatus, sorted members and item links, then settles sent", async () => {
    const { context, calls, memory } = setup();
    expect(await weeklyDigestJob.run(context)).toEqual({ claimed: 1, sent: 1, skipped: 0, failed: 0, leaseLost: 0 });
    const message = memory.sent[0]!;
    expect(message.to).toBe("bob@example.com");
    expect(message.subject).toBe("Acme weekly digest — week of Oct 26");
    // Scrum sprint 26 Oct - 8 Nov viewed on 26 Oct: 1/14 elapsed = 7.1%, 25% done: on track, points unit.
    expect(message.text).toContain("WEB Website - 25% done, 7.1% of the plan elapsed (Sprint 4): On track");
    expect(message.text).toContain("API Backend - 90% done, no plan window");
    const text = message.text;
    expect(text.indexOf("Bea - 5")).toBeLessThan(text.indexOf("Ana - 2"));
    expect(text.indexOf("Ana - 2")).toBeLessThan(text.indexOf("Zed - 2"));
    expect(text).toContain("http://localhost:3000/w/acme/p/WEB?issue=WEB-1");
    expect(text).toContain("WEB-1 Ship the thing - due Nov 1");
    expect(text).toContain("and 11 more");
    expect(text).toContain("API-3 Old bug - due Oct 20");
    expect(text).toContain("Open workspace: http://localhost:3000/w/acme");
    const token = callsTo(calls, "worker_claim_scheduled_emails")[0]!.params[1];
    expect(callsTo(calls, "worker_claim_scheduled_emails")[0]!.params.slice(2)).toEqual([5, 300]);
    expect(callsTo(calls, "worker_weekly_digest_email")[0]!.params).toEqual([digestId, token]);
    expect(callsTo(calls, "worker_settle_scheduled_email")[0]!.params).toEqual([digestId, token, "sent", null, null]);
  });

  it("flags a project that is behind its plan", async () => {
    const behind = [lines[0]!, ...[]].map((row) => ({ ...row, extra: { ...(row.extra as object), done: 0, windowStart: "2026-10-12", windowEnd: "2026-10-26" } }));
    const { context, memory } = setup(() => behind);
    await weeklyDigestJob.run(context);
    expect(memory.sent[0]!.text).toContain("0% done, 100% of the plan elapsed (Sprint 4): Behind");
  });

  it("settles a skipped digest as suppressed without sending", async () => {
    const skipped = line({ status: "skipped", email: null, recipient_name: null, workspace_name: null, workspace_slug: null });
    const { context, calls, memory } = setup(() => [skipped]);
    expect(await weeklyDigestJob.run(context)).toEqual({ claimed: 1, sent: 0, skipped: 1, failed: 0, leaseLost: 0 });
    expect(memory.sent).toEqual([]);
    expect(callsTo(calls, "worker_settle_scheduled_email")[0]!.params.slice(2)).toEqual(["suppressed", null, null]);
  });

  it("retries a digest on an SMTP error", async () => {
    const { context, calls } = setup();
    const failing: JobContext = { ...context, sender: { send: async () => { throw new Error("down"); } } };
    expect(await weeklyDigestJob.run(failing)).toMatchObject({ failed: 1, sent: 0 });
    expect(callsTo(calls, "worker_settle_scheduled_email")[0]!.params.slice(2, 4)).toEqual(["retry", "smtp_error"]);
  });
});
