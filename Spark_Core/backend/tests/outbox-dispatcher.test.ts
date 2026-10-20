import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createMemorySender } from "../src/modules/email/memory-sender.js";
import type { EmailSender } from "../src/modules/email/email-sender.js";
import { createDispatcher } from "../src/modules/outbox/dispatcher.js";
import { outboxHandlers } from "../src/modules/outbox/handlers.js";
import { fakePool } from "./fake-pool.js";
import type { QueryHandler } from "./fake-pool.js";

const now = new Date("2026-10-18T10:00:00Z");
const invitationId = "4f0f3c8e-8d5e-4c55-9a8e-0e9b7a1f2c3d";
const event = (eventType: string, attempts = 1) => ({
  id: `0b6c2f4e-0000-4000-8000-00000000000${attempts}`,
  tenant_id: "9d1c7c62-2f62-4f8e-9a3c-5d3f1f0a9e11",
  event_type: eventType,
  aggregate_type: "workspace_invitation",
  aggregate_id: invitationId,
  payload: { invitationId },
  attempts,
});
const pendingInvitation = {
  status: "pending", email: "bob@example.com", workspace_name: "Acme", inviter_name: "Ana", role: "member",
  expires_at: new Date("2026-10-25T10:00:00Z"),
};

function setup(claimed: unknown[], overrides: Array<[string, QueryHandler]> = []) {
  let claims = 0;
  return fakePool([
    ...overrides,
    ["worker_claim_outbox", () => (claims++ === 0 ? claimed : [])],
    ["worker_invitation_email", () => [pendingInvitation]],
    ["worker_issue_invitation_token", () => [{ issued: true }]],
    ["worker_complete_outbox", () => [{ done: true }]],
    ["worker_fail_outbox", () => [{ done: true }]],
  ]);
}
const callsTo = (calls: Array<{ sql: string; params: unknown[] }>, fragment: string) => calls.filter((call) => call.sql.includes(fragment));

describe("outbox dispatcher", () => {
  it("completes unknown events without action", async () => {
    const { pool, calls } = setup([event("issue.reranked")]);
    const sender = createMemorySender();
    const result = await createDispatcher({ pool, sender, handlers: outboxHandlers, appBaseUrl: "http://localhost:3000", now: () => now }).runOnce();
    expect(result).toEqual({ claimed: 1, sent: 0, failed: 0, leaseLost: 0 });
    expect(sender.sent).toEqual([]);
    expect(callsTo(calls, "worker_complete_outbox")).toHaveLength(1);
    expect(callsTo(calls, "worker_fail_outbox")).toHaveLength(0);
    const claim = callsTo(calls, "worker_claim_outbox")[0]!;
    expect(claim.params.slice(1)).toEqual([5, 300]);
    expect(callsTo(calls, "worker_complete_outbox")[0]!.params).toEqual([event("issue.reranked").id, claim.params[0]]);
  });

  it("sends one invitation email with a fresh token whose hash it stores", async () => {
    const { pool, calls } = setup([event("invitation.created")]);
    const sender = createMemorySender();
    const result = await createDispatcher({ pool, sender, handlers: outboxHandlers, appBaseUrl: "http://localhost:3000", now: () => now }).runOnce();
    expect(result).toEqual({ claimed: 1, sent: 1, failed: 0, leaseLost: 0 });
    expect(sender.sent).toHaveLength(1);
    const message = sender.sent[0]!;
    expect(message.to).toBe("bob@example.com");
    expect(message.subject).toBe("Ana invited you to Acme on Spark");
    const match = /http:\/\/localhost:3000\/invitations\/accept#token=([0-9a-f]{64})(?![0-9a-f])/u.exec(message.text);
    expect(match).not.toBeNull();
    const token = match![1]!;
    expect(message.html).toContain(`#token=${token}`);
    const issued = callsTo(calls, "worker_issue_invitation_token");
    expect(issued).toHaveLength(1);
    expect(issued[0]!.params[0]).toBe(invitationId);
    expect(issued[0]!.params[1]).toEqual(createHash("sha256").update(token).digest());
    // The raw token never reaches the database.
    expect(JSON.stringify(calls.map((call) => call.params))).not.toContain(token);
    expect(callsTo(calls, "worker_complete_outbox")).toHaveLength(1);
  });

  it("completes without sending when the invitation is no longer pending or the token is refused", async () => {
    for (const overrides of [
      [["worker_invitation_email", () => [{ ...pendingInvitation, status: "revoked" }]]],
      [["worker_issue_invitation_token", () => [{ issued: false }]]],
    ] as Array<Array<[string, QueryHandler]>>) {
      const { pool, calls } = setup([event("invitation.resent")], overrides);
      const sender = createMemorySender();
      expect(await createDispatcher({ pool, sender, handlers: outboxHandlers, appBaseUrl: "http://localhost:3000", now: () => now }).runOnce())
        .toEqual({ claimed: 1, sent: 0, failed: 0, leaseLost: 0 });
      expect(sender.sent).toEqual([]);
      expect(callsTo(calls, "worker_complete_outbox")).toHaveLength(1);
    }
  });

  it("schedules a retry with exponential backoff when sending fails", async () => {
    const { pool, calls } = setup([event("invitation.created", 3)]);
    const failing: EmailSender = { send: async () => { throw new Error("connect ECONNREFUSED bob@example.com"); } };
    const result = await createDispatcher({ pool, sender: failing, handlers: outboxHandlers, appBaseUrl: "http://localhost:3000", now: () => now }).runOnce();
    expect(result).toEqual({ claimed: 1, sent: 0, failed: 1, leaseLost: 0 });
    const failed = callsTo(calls, "worker_fail_outbox");
    expect(failed).toHaveLength(1);
    const lock = callsTo(calls, "worker_claim_outbox")[0]!.params[0];
    expect(failed[0]!.params).toEqual([event("invitation.created", 3).id, lock, "smtp_error", new Date(now.getTime() + 8 * 60_000)]);
    expect(callsTo(calls, "worker_complete_outbox")).toHaveLength(0);
  });

  it("caps the backoff at six hours and reports missing invitations as not_found", async () => {
    const { pool, calls } = setup([event("invitation.created", 9)], [["worker_invitation_email", () => []]]);
    await createDispatcher({ pool, sender: createMemorySender(), handlers: outboxHandlers, appBaseUrl: "http://localhost:3000", now: () => now }).runOnce();
    const failed = callsTo(calls, "worker_fail_outbox")[0]!;
    expect(failed.params.slice(2)).toEqual(["not_found", new Date(now.getTime() + 6 * 60 * 60_000)]);
  });

  it("does not count an event whose lease was lost as sent or failed", async () => {
    const { pool, calls } = setup([event("invitation.created")], [["worker_complete_outbox", () => [{ done: false }]]]);
    const sender = createMemorySender();
    const result = await createDispatcher({ pool, sender, handlers: outboxHandlers, appBaseUrl: "http://localhost:3000", now: () => now }).runOnce();
    expect(result).toEqual({ claimed: 1, sent: 0, failed: 0, leaseLost: 1 });
    expect(callsTo(calls, "worker_complete_outbox")).toHaveLength(1);

    const failing: EmailSender = { send: async () => { throw new Error("down"); } };
    const lost = setup([event("invitation.created")], [["worker_fail_outbox", () => [{ done: false }]]]);
    expect(await createDispatcher({ pool: lost.pool, sender: failing, handlers: outboxHandlers, appBaseUrl: "http://localhost:3000", now: () => now }).runOnce())
      .toEqual({ claimed: 1, sent: 0, failed: 0, leaseLost: 1 });
  });

  it("leaves the rest of the batch claimed when the lease budget is nearly used up", async () => {
    let clock = now.getTime();
    const slow: EmailSender = { send: async () => { clock += 120_000; return { messageId: null }; } };
    const { pool, calls } = setup([event("invitation.created", 1), event("invitation.created", 2), event("invitation.created", 3)]);
    const result = await createDispatcher({ pool, sender: slow, handlers: outboxHandlers, appBaseUrl: "http://localhost:3000", now: () => new Date(clock) }).runOnce();
    // 300 s lease: two sends of 120 s each leave 60 s, which is too little to start a third event.
    expect(result).toEqual({ claimed: 3, sent: 2, failed: 0, leaseLost: 0 });
    expect(callsTo(calls, "worker_issue_invitation_token")).toHaveLength(2);
    expect(callsTo(calls, "worker_complete_outbox")).toHaveLength(2);
    expect(callsTo(calls, "worker_fail_outbox")).toHaveLength(0);
  });

  it("never issues a new invitation token with less than a minute of lease left", async () => {
    let clock = now.getTime();
    const { pool, calls } = setup([event("invitation.created")], [
      ["worker_invitation_email", () => { clock += 250_000; return [pendingInvitation]; }],
    ]);
    const sender = createMemorySender();
    const result = await createDispatcher({ pool, sender, handlers: outboxHandlers, appBaseUrl: "http://localhost:3000", now: () => new Date(clock) }).runOnce();
    expect(result).toEqual({ claimed: 1, sent: 0, failed: 0, leaseLost: 0 });
    expect(sender.sent).toEqual([]);
    expect(callsTo(calls, "worker_issue_invitation_token")).toHaveLength(0);
    expect(callsTo(calls, "worker_complete_outbox")).toHaveLength(0);
    expect(callsTo(calls, "worker_fail_outbox")).toHaveLength(0);
  });
});
