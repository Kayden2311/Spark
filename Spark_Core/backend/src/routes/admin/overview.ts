import type { FastifyInstance } from "fastify";

import { ADMINS, ANY_STAFF, type StaffGuard } from "./guard.js";

const count = { type: "integer", minimum: 0 } as const;

const overviewResponse = {
  type: "object",
  required: ["communities", "users", "reports", "campaigns", "workspaces", "auditEvents"],
  properties: {
    communities: {
      type: "object",
      properties: { active: count, featured: count, frozen: count, archived: count, flagged: count },
    },
    users: { type: "object", properties: { active: count, suspended: count } },
    reports: { type: "object", properties: { open: count } },
    campaigns: { type: "object", properties: { pending: count, approved: count } },
    workspaces: { type: "object", properties: { active: count } },
    auditEvents: count,
  },
} as const;

const systemResponse = {
  type: "object",
  required: ["status", "nodeVersion", "uptimeSeconds", "activeSessions", "checkedAt"],
  properties: {
    status: { type: "string", enum: ["operational"] },
    nodeVersion: { type: "string" },
    uptimeSeconds: count,
    activeSessions: count,
    checkedAt: { type: "string", format: "date-time" },
  },
} as const;

export function registerOverviewRoutes(app: FastifyInstance, guard: StaffGuard): void {
  app.get("/api/v1/admin/overview", { schema: { response: { 200: overviewResponse } } }, async (request, reply) => {
    const staff = await guard.authorize(request, reply, ANY_STAFF);
    if (!staff) return reply;
    const row = await guard.run(request, reply, staff, async (client) => (await client.query<Record<string, string>>("SELECT * FROM spark.staff_overview()")).rows[0]);
    if (reply.sent) return reply;
    const n = (key: string) => Number(row?.[key] ?? 0);
    return {
      communities: { active: n("active_communities"), featured: n("featured_communities"), frozen: n("frozen_communities"), archived: n("archived_communities"), flagged: n("flagged_communities") },
      users: { active: n("active_users"), suspended: n("suspended_users") },
      reports: { open: n("open_reports") },
      campaigns: { pending: n("pending_campaigns"), approved: n("approved_campaigns") },
      workspaces: { active: n("active_workspaces") },
      auditEvents: n("audit_events"),
    };
  });

  // Reports only what this process can observe directly; it makes no claims about other services.
  app.get("/api/v1/admin/system", { schema: { response: { 200: systemResponse } } }, async (request, reply) => {
    const staff = await guard.authorize(request, reply, ADMINS);
    if (!staff) return reply;
    const activeSessions = await guard.run(request, reply, staff, async (client) =>
      Number((await client.query<{ total: string }>("SELECT spark.staff_active_session_count() AS total")).rows[0]?.total ?? 0));
    if (reply.sent) return reply;
    return {
      status: "operational",
      nodeVersion: process.version,
      uptimeSeconds: Math.floor(process.uptime()),
      activeSessions: activeSessions ?? 0,
      checkedAt: new Date().toISOString(),
    };
  });
}
