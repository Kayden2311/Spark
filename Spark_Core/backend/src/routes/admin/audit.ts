import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance } from "fastify";

import { platformAuditActions, platformAuditEvents, platformAuditTargets, users } from "../../infrastructure/database/schema.js";
import { pageSize, toPage } from "../pagination.js";
import { problem } from "../responses.js";
import { ADMINS, pageQueryProperties, readCursor, type StaffGuard } from "./guard.js";

type AuditAction = (typeof platformAuditActions)[number];
type AuditTarget = (typeof platformAuditTargets)[number];

interface AuditQuery {
  action?: AuditAction;
  targetType?: AuditTarget;
  targetId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

const auditSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    action: { type: "string", enum: platformAuditActions },
    reason: { type: "string" },
    metadata: { type: "object", additionalProperties: { type: ["string", "number", "boolean", "null"] } },
    createdAt: { type: "string", format: "date-time" },
    actor: { type: "object", properties: { id: { type: "string" }, displayName: { type: "string" } } },
    target: {
      type: "object",
      properties: { type: { type: "string", enum: platformAuditTargets }, id: { type: "string" }, label: { type: "string" } },
    },
  },
} as const;

export function registerAuditRoutes(app: FastifyInstance, guard: StaffGuard): void {
  app.get<{ Querystring: AuditQuery }>(
    "/api/v1/admin/audit-logs",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            action: { type: "string", enum: platformAuditActions },
            targetType: { type: "string", enum: platformAuditTargets },
            targetId: { type: "string", format: "uuid" },
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
            ...pageQueryProperties,
          },
          additionalProperties: false,
        },
        response: {
          200: { type: "object", required: ["items", "nextCursor"], properties: { items: { type: "array", items: auditSchema }, nextCursor: { type: ["string", "null"] } } },
        },
      },
    },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, ADMINS);
      if (!staff) return reply;
      const cursor = readCursor(request, reply, request.query.cursor);
      if (cursor === undefined) return reply;
      const { action, targetType, targetId, from, to } = request.query;
      if (from && to && new Date(from) > new Date(to)) {
        return problem(request, reply, 400, "Bad Request", "invalid_range", "The start of the range must not be after its end.");
      }
      const limit = pageSize(request.query.limit);

      const conditions: Array<SQL | undefined> = [
        action ? eq(platformAuditEvents.action, action) : undefined,
        targetType ? eq(platformAuditEvents.targetType, targetType) : undefined,
        targetId ? eq(platformAuditEvents.targetId, targetId) : undefined,
        from ? gte(platformAuditEvents.createdAt, new Date(from)) : undefined,
        to ? lt(platformAuditEvents.createdAt, new Date(to)) : undefined,
        cursor ? sql`(${platformAuditEvents.createdAt}, ${platformAuditEvents.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : undefined,
      ];
      // RLS (staff_read) limits this table to platform admins; the role check above only answers 403 early.
      const rows = await guard.run(request, reply, staff, (client) =>
        drizzle(client)
          .select({
            id: platformAuditEvents.id,
            cursorTs: sql<string>`${platformAuditEvents.createdAt}::text`,
            action: platformAuditEvents.action,
            reason: platformAuditEvents.reason,
            metadata: platformAuditEvents.metadata,
            createdAt: platformAuditEvents.createdAt,
            actorId: platformAuditEvents.actorUserId,
            actorName: users.displayName,
            targetType: platformAuditEvents.targetType,
            targetId: platformAuditEvents.targetId,
            targetLabel: platformAuditEvents.targetLabel,
          })
          .from(platformAuditEvents)
          .leftJoin(users, eq(users.id, platformAuditEvents.actorUserId))
          .where(and(...conditions))
          .orderBy(desc(platformAuditEvents.createdAt), desc(platformAuditEvents.id))
          .limit(limit + 1));
      if (reply.sent || !rows) return reply;

      return toPage(
        rows.map((row) => ({
          id: row.id,
          cursorTs: row.cursorTs,
          action: row.action,
          reason: row.reason,
          metadata: row.metadata as Record<string, unknown>,
          createdAt: row.createdAt.toISOString(),
          actor: { id: row.actorId, displayName: row.actorName ?? "Unknown member" },
          target: { type: row.targetType, id: row.targetId, label: row.targetLabel },
        })),
        limit,
      );
    },
  );
}
