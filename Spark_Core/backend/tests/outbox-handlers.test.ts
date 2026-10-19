import { describe, expect, it } from "vitest";

import type { EmailSender } from "../src/modules/email/email-sender.js";
import { createMemorySender } from "../src/modules/email/memory-sender.js";
import { DeliveryError } from "../src/modules/outbox/dispatcher.js";
import type { HandlerContext, OutboxEvent } from "../src/modules/outbox/dispatcher.js";
import { outboxHandlers } from "../src/modules/outbox/handlers.js";
import { fakePool } from "./fake-pool.js";
import type { QueryHandler } from "./fake-pool.js";

const notificationId = "5a1f3c8e-8d5e-4c55-9a8e-0e9b7a1f2c3d";
const issueId = "6b2f3c8e-8d5e-4c55-9a8e-0e9b7a1f2c3d";
const event = (eventType: string, payload: unknown): OutboxEvent => ({
  id: "0b6c2f4e-0000-4000-8000-000000000001",
  tenantId: "9d1c7c62-2f62-4f8e-9a3c-5d3f1f0a9e11",
  eventType,
  aggregateType: "issue",
  aggregateId: issueId,
  payload,
  attempts: 1,
});
const assignedPayload = { issueId, projectId: "7c3f3c8e-8d5e-4c55-9a8e-0e9b7a1f2c3d", version: 1, notificationId };
const pendingEmail = {
  status: "pending", email: "bob@example.com", recipient_name: "Bob Stone", actor_name: "Ana Lima", workspace_name: "Acme",
  workspace_slug: "acme", project_key: "WEB", project_name: "Website", issue_number: "42", issue_title: "Fix login",
};

function setup(overrides: Array<[string, QueryHandler]> = [], sender: EmailSender = createMemorySender()) {
  const { pool, calls } = fakePool([
    ...overrides,
    ["worker_task_assigned_email", () => [pendingEmail]],
    ["worker_record_email_delivery", () => [{ recorded: true }]],
  ]);
  const context: HandlerContext = { pool, sender, appBaseUrl: "http://localhost:3000", leaseRemainingMs: () => 300_000 };
  return { context, calls };
}
const callsTo = (calls: Array<{ sql: string; params: unknown[] }>, fragment: string) => calls.filter((call) => call.sql.includes(fragment));

describe("task-assigned email handler", () => {
  it("handles issue.created and issue.updated", () => {
    expect(outboxHandlers["issue.created"]).toBeDefined();
    expect(outboxHandlers["issue.updated"]).toBe(outboxHandlers["issue.created"]);
    expect(outboxHandlers["issue.reranked"]).toBeUndefined();
  });

  it("sends one email and records it as sent", async () => {
    for (const eventType of ["issue.created", "issue.updated"]) {
      const sender = createMemorySender();
      const { context, calls } = setup([], sender);
      expect(await outboxHandlers[eventType]!(event(eventType, assignedPayload), context)).toBe("sent");
      expect(sender.sent).toHaveLength(1);
      const message = sender.sent[0]!;
      expect(message.to).toBe("bob@example.com");
      expect(message.subject).toBe("Ana Lima assigned you WEB-42: Fix login");
      expect(message.text).toContain("http://localhost:3000/w/acme/p/WEB?issue=WEB-42");
      expect(message.text).toContain("http://localhost:3000/settings/notifications");
      expect(callsTo(calls, "worker_task_assigned_email").map((call) => call.params)).toEqual([[notificationId]]);
      expect(callsTo(calls, "worker_record_email_delivery").map((call) => call.params)).toEqual([[notificationId, "sent"]]);
    }
  });

  it("records a skipped email as suppressed and sends nothing", async () => {
    const sender = createMemorySender();
    const { context, calls } = setup([["worker_task_assigned_email", () => [{ ...pendingEmail, status: "skipped", email: null }]]], sender);
    expect(await outboxHandlers["issue.updated"]!(event("issue.updated", assignedPayload), context)).toBe("skipped");
    expect(sender.sent).toEqual([]);
    expect(callsTo(calls, "worker_record_email_delivery").map((call) => call.params)).toEqual([[notificationId, "suppressed"]]);
  });

  it("skips issue events without a notification and rejects malformed ones", async () => {
    const sender = createMemorySender();
    const { context, calls } = setup([], sender);
    expect(await outboxHandlers["issue.created"]!(event("issue.created", { issueId, projectId: issueId }), context)).toBe("skipped");
    expect(calls).toEqual([]);
    for (const payload of [{ notificationId: "nope" }, { notificationId: 7 }, null]) {
      await expect(outboxHandlers["issue.created"]!(event("issue.created", payload), context)).rejects.toMatchObject({ code: "invalid_payload" });
    }
    expect(sender.sent).toEqual([]);
  });

  it("reports an unknown notification as not_found and an SMTP failure as smtp_error without recording", async () => {
    const missing = setup([["worker_task_assigned_email", () => []]]);
    await expect(outboxHandlers["issue.created"]!(event("issue.created", assignedPayload), missing.context)).rejects.toMatchObject({ code: "not_found" });

    const failing: EmailSender = { send: async () => { throw new Error("connect ECONNREFUSED bob@example.com"); } };
    const { context, calls } = setup([], failing);
    const failure = outboxHandlers["issue.created"]!(event("issue.created", assignedPayload), context);
    await expect(failure).rejects.toBeInstanceOf(DeliveryError);
    await expect(failure).rejects.toMatchObject({ code: "smtp_error" });
    expect(callsTo(calls, "worker_record_email_delivery")).toEqual([]);
  });
});
