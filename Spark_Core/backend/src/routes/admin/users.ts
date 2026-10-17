import { and, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance } from "fastify";

import { communityMemberships, platformAuditEvents, userEmails, users, workspaceMemberships } from "../../infrastructure/database/schema.js";
import { pageSize, toPage } from "../pagination.js";
import { problem } from "../responses.js";
import {
  ADMINS,
  MUTATION_RATE_LIMIT,
  PLATFORM_ROLES,
  SUPER_ADMINS,
  expectOutcome,
  idParams,
  likePattern,
  pageQueryProperties,
  readCursor,
  reasonProperty,
  type PlatformRole,
  type StaffGuard,
} from "./guard.js";

const USER_STATUSES = ["active", "suspended"] as const;
type UserStatus = (typeof USER_STATUSES)[number];

const userSummary = {
  id: { type: "string" },
  displayName: { type: "string" },
  email: { type: ["string", "null"] },
  avatarUrl: { type: ["string", "null"] },
  status: { type: "string", enum: USER_STATUSES },
  createdAt: { type: "string", format: "date-time" },
  lastLoginAt: { type: ["string", "null"], format: "date-time" },
  platformRoles: { type: "array", items: { type: "string", enum: PLATFORM_ROLES } },
  workspaceCount: { type: "integer" },
  risk: { type: "object", properties: { hiddenPosts: { type: "integer" }, hiddenComments: { type: "integer" }, reportsAgainst: { type: "integer" } } },
} as const;

const historyEntry = {
  type: "object",
  properties: {
    id: { type: "string" },
    action: { type: "string" },
    reason: { type: "string" },
    metadata: { type: "object", additionalProperties: { type: ["string", "number", "boolean", "null"] } },
    createdAt: { type: "string", format: "date-time" },
    actor: { type: "object", properties: { id: { type: "string" }, displayName: { type: "string" } } },
  },
} as const;

const userDetail = {
  type: "object",
  properties: {
    ...userSummary,
    locale: { type: "string" },
    timezone: { type: "string" },
    emailVerified: { type: "boolean" },
    roles: { type: "array", items: { type: "object", properties: { role: { type: "string", enum: PLATFORM_ROLES }, grantedAt: { type: "string", format: "date-time" } } } },
    activeSessions: { type: "integer" },
    communityCount: { type: "integer" },
    history: { type: "array", items: historyEntry },
  },
} as const;

const statusOutcomes: Record<string, [number, string, string, string]> = {
  self: [400, "Bad Request", "self_suspension_prohibited", "You cannot suspend your own account."],
  forbidden: [403, "Forbidden", "insufficient_permissions", "Only a super admin can change the status of an admin-tier account."],
  not_found: [404, "Not Found", "user_not_found", "User does not exist."],
  last_super_admin: [409, "Conflict", "last_super_admin", "The last active super admin cannot be suspended."],
  unchanged: [409, "Conflict", "status_unchanged", "The user already has this status."],
};

export function registerUserRoutes(app: FastifyInstance, guard: StaffGuard): void {
  app.get<{ Querystring: { search?: string; status?: UserStatus; role?: PlatformRole; cursor?: string; limit?: number } }>(
    "/api/v1/admin/users",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            search: { type: "string", maxLength: 100 },
            status: { type: "string", enum: USER_STATUSES },
            role: { type: "string", enum: PLATFORM_ROLES },
            ...pageQueryProperties,
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            required: ["items", "nextCursor"],
            properties: { items: { type: "array", items: { type: "object", properties: userSummary } }, nextCursor: { type: ["string", "null"] } },
          },
        },
      },
    },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, ADMINS);
      if (!staff) return reply;
      const cursor = readCursor(request, reply, request.query.cursor);
      if (cursor === undefined) return reply;
      const limit = pageSize(request.query.limit);
      const search = request.query.search?.trim();

      const page = await guard.run(request, reply, staff, async (client) => {
        const db = drizzle(client);
        const conditions: Array<SQL | undefined> = [isNull(users.deletedAt)];
        if (request.query.status) conditions.push(eq(users.status, request.query.status));
        if (request.query.role) {
          const holders = await client.query<{ user_id: string }>("SELECT user_id FROM spark.staff_user_roles(NULL) WHERE role = $1", [request.query.role]);
          if (holders.rows.length === 0) return null;
          conditions.push(inArray(users.id, holders.rows.map((row) => row.user_id)));
        }
        if (search) conditions.push(or(ilike(users.displayName, likePattern(search)), ilike(userEmails.email, likePattern(search))));
        if (cursor) conditions.push(sql`(${users.createdAt}, ${users.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`);

        const rows = await db
          .select({
            id: users.id,
            cursorTs: sql<string>`${users.createdAt}::text`,
            displayName: users.displayName,
            email: userEmails.email,
            avatarUrl: users.avatarUrl,
            status: users.status,
            createdAt: users.createdAt,
            lastLoginAt: users.lastLoginAt,
          })
          .from(users)
          .leftJoin(userEmails, and(eq(userEmails.userId, users.id), eq(userEmails.isPrimary, true)))
          .where(and(...conditions))
          .orderBy(desc(users.createdAt), desc(users.id))
          .limit(limit + 1);
        if (rows.length === 0) return null;

        const ids = rows.map((row) => row.id);
        // One transaction client runs one query at a time, so these run in sequence.
        const roleRows = await client.query<{ user_id: string; role: string }>("SELECT user_id, role FROM spark.staff_user_roles($1::uuid[])", [ids]);
        const workspaceCounts = await db.select({ userId: workspaceMemberships.userId, value: count() })
          .from(workspaceMemberships)
          .where(and(inArray(workspaceMemberships.userId, ids), eq(workspaceMemberships.status, "active")))
          .groupBy(workspaceMemberships.userId);
        const riskRows = await client.query<{ user_id: string; hidden_posts: string; hidden_comments: string; reports_against: string }>("SELECT * FROM spark.staff_user_risk($1::uuid[])", [ids]);
        const risk = new Map(riskRows.rows.map((row) => [row.user_id, { hiddenPosts: Number(row.hidden_posts), hiddenComments: Number(row.hidden_comments), reportsAgainst: Number(row.reports_against) }]));
        const roles = new Map<string, string[]>();
        for (const row of roleRows.rows) roles.set(row.user_id, [...(roles.get(row.user_id) ?? []), row.role]);
        const workspaces = new Map(workspaceCounts.map((row) => [row.userId, row.value]));
        return rows.map((row) => ({
          ...row,
          status: row.status as UserStatus,
          createdAt: row.createdAt.toISOString(),
          lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
          platformRoles: roles.get(row.id) ?? [],
          workspaceCount: workspaces.get(row.id) ?? 0,
          risk: risk.get(row.id) ?? { hiddenPosts: 0, hiddenComments: 0, reportsAgainst: 0 },
        }));
      });
      if (reply.sent) return reply;
      return toPage(page ?? [], limit);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/admin/users/:id",
    { schema: { params: idParams, response: { 200: userDetail } } },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, ADMINS);
      if (!staff) return reply;
      const { id } = request.params;

      const detail = await guard.run(request, reply, staff, async (client) => {
        const db = drizzle(client);
        const [user] = await db
          .select({
            id: users.id,
            displayName: users.displayName,
            email: userEmails.email,
            emailVerifiedAt: userEmails.verifiedAt,
            avatarUrl: users.avatarUrl,
            status: users.status,
            locale: users.locale,
            timezone: users.timezone,
            createdAt: users.createdAt,
            lastLoginAt: users.lastLoginAt,
          })
          .from(users)
          .leftJoin(userEmails, and(eq(userEmails.userId, users.id), eq(userEmails.isPrimary, true)))
          .where(and(eq(users.id, id), isNull(users.deletedAt)));
        if (!user) return null;

        // One transaction client runs one query at a time, so these run in sequence.
        const roleRows = await client.query<{ role: string; granted_at: Date }>("SELECT role, granted_at FROM spark.staff_user_roles($1::uuid[])", [[id]]);
        const sessions = await client.query<{ total: string }>("SELECT spark.staff_user_session_count($1) AS total", [id]);
        const [workspaces] = await db.select({ value: count() }).from(workspaceMemberships).where(and(eq(workspaceMemberships.userId, id), eq(workspaceMemberships.status, "active")));
        const [memberships] = await db.select({ value: count() }).from(communityMemberships).where(and(eq(communityMemberships.userId, id), eq(communityMemberships.status, "active")));
        const history = await db
            .select({
              id: platformAuditEvents.id,
              action: platformAuditEvents.action,
              reason: platformAuditEvents.reason,
              metadata: platformAuditEvents.metadata,
              createdAt: platformAuditEvents.createdAt,
              actorId: platformAuditEvents.actorUserId,
              actorName: users.displayName,
            })
            .from(platformAuditEvents)
            .leftJoin(users, eq(users.id, platformAuditEvents.actorUserId))
            .where(and(eq(platformAuditEvents.targetType, "user"), eq(platformAuditEvents.targetId, id)))
            .orderBy(desc(platformAuditEvents.createdAt), desc(platformAuditEvents.id))
            .limit(20);

        return {
          id: user.id,
          displayName: user.displayName,
          email: user.email,
          emailVerified: user.emailVerifiedAt !== null,
          avatarUrl: user.avatarUrl,
          status: user.status,
          locale: user.locale,
          timezone: user.timezone,
          createdAt: user.createdAt.toISOString(),
          lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
          platformRoles: roleRows.rows.map((row) => row.role),
          roles: roleRows.rows.map((row) => ({ role: row.role, grantedAt: row.granted_at.toISOString() })),
          activeSessions: Number(sessions.rows[0]?.total ?? 0),
          workspaceCount: workspaces?.value ?? 0,
          communityCount: memberships?.value ?? 0,
          history: history.map((entry) => ({
            id: entry.id,
            action: entry.action,
            reason: entry.reason,
            metadata: entry.metadata as Record<string, unknown>,
            createdAt: entry.createdAt.toISOString(),
            actor: { id: entry.actorId, displayName: entry.actorName ?? "Unknown member" },
          })),
        };
      });
      if (reply.sent) return reply;
      if (!detail) return problem(request, reply, 404, "Not Found", "user_not_found", "User does not exist.");
      return detail;
    },
  );

  app.get<{ Params: { id: string }; Querystring: { days: number } }>(
    "/api/v1/admin/users/:id/activity",
    {
      schema: {
        params: idParams,
        querystring: { type: "object", properties: { days: { type: "integer", minimum: 7, maximum: 365, default: 90 } }, additionalProperties: false },
        response: {
          200: {
            type: "object",
            properties: {
              days: { type: "integer" },
              series: { type: "array", items: { type: "object", properties: { day: { type: "string", format: "date" }, signIns: { type: "integer" }, posts: { type: "integer" }, comments: { type: "integer" } } } },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, ADMINS);
      if (!staff) return reply;
      const rows = await guard.run(request, reply, staff, async (client) =>
        (await client.query<{ day: string; sign_ins: string; posts: string; comments: string }>(
          "SELECT day::text AS day, sign_ins, posts, comments FROM spark.staff_user_activity($1, $2)",
          [request.params.id, request.query.days],
        )).rows);
      if (reply.sent || !rows) return reply;
      return { days: request.query.days, series: rows.map((row) => ({ day: row.day, signIns: Number(row.sign_ins), posts: Number(row.posts), comments: Number(row.comments) })) };
    },
  );

  // Recent sign-ins: when, how, and whether the session is still usable. Never the token.
  app.get<{ Params: { id: string } }>(
    "/api/v1/admin/users/:id/sessions",
    {
      schema: {
        params: idParams,
        response: {
          200: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    createdAt: { type: "string", format: "date-time" },
                    lastSeenAt: { type: "string", format: "date-time" },
                    expiresAt: { type: "string", format: "date-time" },
                    method: { type: "string" },
                    state: { type: "string", enum: ["active", "expired", "revoked"] },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, ADMINS);
      if (!staff) return reply;
      const rows = await guard.run(request, reply, staff, async (client) =>
        (await client.query<{ id: string; created_at: Date; last_seen_at: Date; expires_at: Date; auth_method: string; state: string }>(
          "SELECT * FROM spark.staff_user_sessions($1, 20)",
          [request.params.id],
        )).rows);
      if (reply.sent || !rows) return reply;
      return {
        items: rows.map((row) => ({
          id: row.id,
          createdAt: row.created_at.toISOString(),
          lastSeenAt: row.last_seen_at.toISOString(),
          expiresAt: row.expires_at.toISOString(),
          method: row.auth_method,
          state: row.state,
        })),
      };
    },
  );

  app.patch<{ Params: { id: string }; Body: { status: UserStatus; reason: string } }>(
    "/api/v1/admin/users/:id/status",
    {
      config: MUTATION_RATE_LIMIT,
      schema: {
        params: idParams,
        body: {
          type: "object",
          required: ["status", "reason"],
          properties: { status: { type: "string", enum: USER_STATUSES }, reason: reasonProperty },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, ADMINS);
      if (!staff) return reply;
      const { status, reason } = request.body;
      const outcome = await guard.run(request, reply, staff, async (client) =>
        (await client.query<{ outcome: string }>("SELECT spark.staff_set_user_status($1, $2, $3) AS outcome", [request.params.id, status, reason])).rows[0]?.outcome);
      if (reply.sent) return reply;
      const mapped = outcome ? statusOutcomes[outcome] : undefined;
      if (mapped) return problem(request, reply, ...mapped);
      expectOutcome(outcome, "ok");
      return { id: request.params.id, status };
    },
  );

  app.post<{ Params: { id: string }; Body: { role: PlatformRole; reason: string } }>(
    "/api/v1/admin/users/:id/roles",
    {
      config: MUTATION_RATE_LIMIT,
      schema: {
        params: idParams,
        body: {
          type: "object",
          required: ["role", "reason"],
          properties: { role: { type: "string", enum: PLATFORM_ROLES }, reason: reasonProperty },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, SUPER_ADMINS);
      if (!staff) return reply;
      const { role, reason } = request.body;
      const outcome = await guard.run(request, reply, staff, async (client) =>
        (await client.query<{ outcome: string }>("SELECT spark.staff_grant_role($1, $2, $3) AS outcome", [request.params.id, role, reason])).rows[0]?.outcome);
      if (reply.sent) return reply;
      if (outcome === "exists") return problem(request, reply, 409, "Conflict", "role_already_assigned", "The user already holds this platform role.");
      if (outcome === "not_found") return problem(request, reply, 404, "Not Found", "user_not_found", "User does not exist or is not active.");
      expectOutcome(outcome, "granted");
      return reply.code(201).send({ userId: request.params.id, role });
    },
  );

  // DELETE is idempotent: revoking a role the user does not hold leaves the same final state (204, no audit row).
  app.delete<{ Params: { id: string; role: PlatformRole }; Body: { reason: string } }>(
    "/api/v1/admin/users/:id/roles/:role",
    {
      config: MUTATION_RATE_LIMIT,
      schema: {
        params: {
          type: "object",
          required: ["id", "role"],
          properties: { id: { type: "string", format: "uuid" }, role: { type: "string", enum: PLATFORM_ROLES } },
          additionalProperties: false,
        },
        body: { type: "object", required: ["reason"], properties: { reason: reasonProperty }, additionalProperties: false },
      },
    },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, SUPER_ADMINS);
      if (!staff) return reply;
      const outcome = await guard.run(request, reply, staff, async (client) =>
        (await client.query<{ outcome: string }>("SELECT spark.staff_revoke_role($1, $2, $3) AS outcome", [request.params.id, request.params.role, request.body.reason])).rows[0]?.outcome);
      if (reply.sent) return reply;
      if (outcome === "last_super_admin") return problem(request, reply, 409, "Conflict", "last_super_admin", "The last active super admin cannot be removed.");
      expectOutcome(outcome, "revoked", "not_found");
      return reply.code(204).send();
    },
  );
}
