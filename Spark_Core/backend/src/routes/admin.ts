import { createHash } from "node:crypto";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import {
  communities,
  communityMemberships,
  contentReports,
  moderationActions,
  platformRoleAssignments,
  postComments,
  posts,
  promotionCampaigns,
  sessions,
  userEmails,
  users,
  workspaceMemberships,
} from "../infrastructure/database/schema.js";

const SESSION_COOKIE = "spark_session";

export interface AdminPluginOptions {
  readonly pool: Pool;
}

interface AuthenticatedModerator {
  userId: string;
  roles: string[];
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const item of cookieHeader.split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key && value.length > 0) {
      cookies[key] = decodeURIComponent(value.join("="));
    }
  }
  return cookies;
}

export function registerAdminRoutes(app: FastifyInstance, options: AdminPluginOptions): void {
  const db = drizzle(options.pool);

  async function getAuthenticatedModerator(
    request: FastifyRequest,
    reply: FastifyReply,
    requiredRoles: string[] = [
      "super_admin",
      "platform_admin",
      "community_moderator",
      "content_moderator",
      "campaign_moderator",
    ],
  ): Promise<AuthenticatedModerator | null> {
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies[SESSION_COOKIE];

    if (!token) {
      void reply.code(401).type("application/problem+json").send({
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        code: "unauthenticated",
        detail: "No active session.",
        instance: request.url,
        requestId: request.id,
      });
      return null;
    }

    const tokenHashBuffer = createHash("sha256").update(token).digest();

    const sessionRecords = await db
      .select({
        sessionId: sessions.id,
        userId: sessions.userId,
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
      })
      .from(sessions)
      .where(and(eq(sessions.tokenHash, tokenHashBuffer), isNull(sessions.revokedAt)))
      .limit(1);

    if (sessionRecords.length === 0 || sessionRecords[0]!.expiresAt < new Date()) {
      void reply.code(401).type("application/problem+json").send({
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        code: "session_expired",
        detail: "Session expired or invalid.",
        instance: request.url,
        requestId: request.id,
      });
      return null;
    }

    const userId = sessionRecords[0]!.userId;

    const roleRecords = await db
      .select({ role: platformRoleAssignments.role })
      .from(platformRoleAssignments)
      .where(and(eq(platformRoleAssignments.userId, userId), isNull(platformRoleAssignments.revokedAt)));

    const roles = roleRecords.map((r) => r.role);
    const hasPermission = roles.some((r) => requiredRoles.includes(r));

    if (!hasPermission) {
      void reply.code(403).type("application/problem+json").send({
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        code: "insufficient_permissions",
        detail: "You do not possess the required platform governance permissions.",
        instance: request.url,
        requestId: request.id,
      });
      return null;
    }

    return { userId, roles };
  }

  // GET /api/v1/admin/overview
  app.get("/api/v1/admin/overview", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const mod = await getAuthenticatedModerator(request, reply);
    if (!mod) return;

    const [
      [commCount],
      [userCount],
      [reportCount],
      [campCount],
    ] = await Promise.all([
      db.select({ value: count() }).from(communities).where(isNull(communities.archivedAt)),
      db.select({ value: count() }).from(users).where(eq(users.status, "active")),
      db.select({ value: count() }).from(contentReports).where(eq(contentReports.status, "open")),
      db.select({ value: count() }).from(promotionCampaigns).where(eq(promotionCampaigns.reviewStatus, "approved")),
    ]);

    return reply.code(200).send({
      activeCommunitiesCount: commCount?.value ?? 0,
      registeredUsersCount: userCount?.value ?? 0,
      pendingReportsCount: reportCount?.value ?? 0,
      activeCampaignsCount: campCount?.value ?? 0,
    });
  });

  // GET /api/v1/admin/reports
  app.get<{
    Querystring: { status?: "open" | "reviewing" | "resolved" | "dismissed"; limit?: number };
  }>("/api/v1/admin/reports", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const mod = await getAuthenticatedModerator(request, reply, ["super_admin", "platform_admin", "content_moderator"]);
    if (!mod) return;

    const statusFilter = request.query.status || "open";

    const reportRows = await db
      .select({
        id: contentReports.id,
        tenantId: contentReports.tenantId,
        communityId: contentReports.communityId,
        postId: contentReports.postId,
        commentId: contentReports.commentId,
        reporterUserId: contentReports.reporterUserId,
        reasonCode: contentReports.reasonCode,
        details: contentReports.details,
        status: contentReports.status,
        createdAt: contentReports.createdAt,
        resolvedAt: contentReports.resolvedAt,
        reporterName: users.displayName,
        communityName: communities.name,
        communitySlug: communities.slug,
        postTitle: posts.title,
        postBody: posts.body,
        postModerationStatus: posts.moderationStatus,
        commentBody: postComments.body,
        commentModerationStatus: postComments.moderationStatus,
      })
      .from(contentReports)
      .leftJoin(users, eq(users.id, contentReports.reporterUserId))
      .leftJoin(communities, eq(communities.id, contentReports.communityId))
      .leftJoin(posts, eq(posts.id, contentReports.postId))
      .leftJoin(postComments, eq(postComments.id, contentReports.commentId))
      .where(eq(contentReports.status, statusFilter))
      .orderBy(desc(contentReports.createdAt))
      .limit(request.query.limit ? Number(request.query.limit) : 50);

    return reply.code(200).send({
      reports: reportRows.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        communityId: r.communityId,
        communityName: r.communityName || "Unknown Community",
        communitySlug: r.communitySlug || "",
        reporter: {
          id: r.reporterUserId,
          displayName: r.reporterName || "Anonymous Member",
        },
        targetType: r.commentId ? "comment" : r.postId ? "post" : "community",
        targetTitle: r.postTitle || (r.commentBody ? `Comment: "${r.commentBody.slice(0, 40)}..."` : "Community Guidelines"),
        targetSnippet: r.postBody || r.commentBody || r.details || "",
        moderationStatus: r.postModerationStatus || r.commentModerationStatus || "visible",
        reasonCode: r.reasonCode,
        details: r.details,
        status: r.status,
        createdAt: r.createdAt,
        resolvedAt: r.resolvedAt,
      })),
    });
  });

  // POST /api/v1/admin/reports/:id/actions
  app.post<{
    Params: { id: string };
    Body: { action: "hide" | "restore" | "dismiss_report"; reason: string };
  }>(
    "/api/v1/admin/reports/:id/actions",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: 60 * 1000,
        },
      },
      schema: {
        body: {
          type: "object",
          required: ["action", "reason"],
          properties: {
            action: { type: "string", enum: ["hide", "restore", "dismiss_report"] },
            reason: { type: "string", minLength: 3, maxLength: 500 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const mod = await getAuthenticatedModerator(request, reply, ["super_admin", "platform_admin", "content_moderator"]);
      if (!mod) return;

      const reportId = request.params.id;
      const { action, reason } = request.body;

      const [report] = await db
        .select()
        .from(contentReports)
        .where(eq(contentReports.id, reportId))
        .limit(1);

      if (!report) {
        return reply.code(404).type("application/problem+json").send({
          type: "about:blank",
          title: "Not Found",
          status: 404,
          code: "report_not_found",
          detail: "Report does not exist.",
          instance: request.url,
          requestId: request.id,
        });
      }

      // Perform moderation action in transaction
      await db.transaction(async (tx) => {
        if (action === "hide") {
          if (report.postId) {
            await tx
              .update(posts)
              .set({ moderationStatus: "hidden" })
              .where(eq(posts.id, report.postId));
          }
          if (report.commentId) {
            await tx
              .update(postComments)
              .set({ moderationStatus: "hidden" })
              .where(eq(postComments.id, report.commentId));
          }
          await tx
            .update(contentReports)
            .set({ status: "resolved", resolvedAt: new Date() })
            .where(eq(contentReports.id, reportId));
        } else if (action === "restore") {
          if (report.postId) {
            await tx
              .update(posts)
              .set({ moderationStatus: "visible" })
              .where(eq(posts.id, report.postId));
          }
          if (report.commentId) {
            await tx
              .update(postComments)
              .set({ moderationStatus: "visible" })
              .where(eq(postComments.id, report.commentId));
          }
          await tx
            .update(contentReports)
            .set({ status: "resolved", resolvedAt: new Date() })
            .where(eq(contentReports.id, reportId));
        } else if (action === "dismiss_report") {
          await tx
            .update(contentReports)
            .set({ status: "dismissed", resolvedAt: new Date() })
            .where(eq(contentReports.id, reportId));
        }

        // Record audit trail in moderation_actions
        await tx.insert(moderationActions).values({
          tenantId: report.tenantId,
          communityId: report.communityId,
          reportId: report.id,
          postId: report.postId,
          commentId: report.commentId,
          actorUserId: mod.userId,
          action,
          reason,
        });
      });

      return reply.code(200).send({ success: true, message: "Moderation action executed successfully." });
    },
  );

  // GET /api/v1/admin/communities
  app.get("/api/v1/admin/communities", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const mod = await getAuthenticatedModerator(request, reply, ["super_admin", "platform_admin", "community_moderator"]);
    if (!mod) return;

    const commList = await db
      .select({
        id: communities.id,
        tenantId: communities.tenantId,
        slug: communities.slug,
        name: communities.name,
        description: communities.description,
        visibility: communities.visibility,
        stage: communities.stage,
        countryCode: communities.countryCode,
        city: communities.city,
        createdAt: communities.createdAt,
        archivedAt: communities.archivedAt,
        createdByUserId: communities.createdByUserId,
        creatorName: users.displayName,
      })
      .from(communities)
      .leftJoin(users, eq(users.id, communities.createdByUserId))
      .orderBy(desc(communities.createdAt))
      .limit(50);

    // Compute active membership count for each
    const enriched = await Promise.all(
      commList.map(async (c) => {
        const [[memberCount], [flagCount]] = await Promise.all([
          db
            .select({ value: count() })
            .from(communityMemberships)
            .where(and(eq(communityMemberships.communityId, c.id), eq(communityMemberships.status, "active"))),
          db
            .select({ value: count() })
            .from(contentReports)
            .where(and(eq(contentReports.communityId, c.id), eq(contentReports.status, "open"))),
        ]);

        return {
          ...c,
          memberCount: memberCount?.value ?? 0,
          reportCount: flagCount?.value ?? 0,
          status: c.archivedAt ? "archived" : (flagCount?.value ?? 0) > 0 ? "flagged" : "active",
        };
      }),
    );

    return reply.code(200).send({ communities: enriched });
  });

  // PATCH /api/v1/admin/communities/:id/status
  app.patch<{
    Params: { id: string };
    Body: { action: "archive" | "restore" };
  }>(
    "/api/v1/admin/communities/:id/status",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: 60 * 1000,
        },
      },
      schema: {
        body: {
          type: "object",
          required: ["action"],
          properties: {
            action: { type: "string", enum: ["archive", "restore"] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const mod = await getAuthenticatedModerator(request, reply, ["super_admin", "platform_admin", "community_moderator"]);
      if (!mod) return;

      const communityId = request.params.id;
      const { action } = request.body;

      const [comm] = await db.select().from(communities).where(eq(communities.id, communityId)).limit(1);
      if (!comm) {
        return reply.code(404).type("application/problem+json").send({
          type: "about:blank",
          title: "Not Found",
          status: 404,
          code: "community_not_found",
          detail: "Community does not exist.",
          instance: request.url,
          requestId: request.id,
        });
      }

      await db
        .update(communities)
        .set({ archivedAt: action === "archive" ? new Date() : null })
        .where(eq(communities.id, communityId));

      return reply.code(200).send({ success: true, status: action === "archive" ? "archived" : "active" });
    },
  );

  // GET /api/v1/admin/users
  app.get<{
    Querystring: { search?: string; status?: "active" | "suspended"; limit?: number };
  }>("/api/v1/admin/users", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const mod = await getAuthenticatedModerator(request, reply, ["super_admin", "platform_admin"]);
    if (!mod) return;

    const search = request.query.search?.trim();

    const userRows = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        status: users.status,
        avatarUrl: users.avatarUrl,
        locale: users.locale,
        timezone: users.timezone,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
        primaryEmail: userEmails.email,
      })
      .from(users)
      .leftJoin(userEmails, and(eq(userEmails.userId, users.id), eq(userEmails.isPrimary, true)))
      .where(
        search
          ? sql`${users.displayName} ILIKE ${`%${search}%`} OR ${userEmails.email} ILIKE ${`%${search}%`}`
          : undefined,
      )
      .orderBy(desc(users.createdAt))
      .limit(request.query.limit ? Number(request.query.limit) : 50);

    const enrichedUsers = await Promise.all(
      userRows.map(async (u) => {
        const [roles, wsCount] = await Promise.all([
          db
            .select({ role: platformRoleAssignments.role })
            .from(platformRoleAssignments)
            .where(and(eq(platformRoleAssignments.userId, u.id), isNull(platformRoleAssignments.revokedAt))),
          db
            .select({ value: count() })
            .from(workspaceMemberships)
            .where(and(eq(workspaceMemberships.userId, u.id), eq(workspaceMemberships.status, "active"))),
        ]);

        return {
          ...u,
          platformRoles: roles.map((r) => r.role),
          workspaceCount: wsCount[0]?.value ?? 0,
        };
      }),
    );

    return reply.code(200).send({ users: enrichedUsers });
  });

  // PATCH /api/v1/admin/users/:id/status
  app.patch<{
    Params: { id: string };
    Body: { status: "active" | "suspended" };
  }>(
    "/api/v1/admin/users/:id/status",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: 60 * 1000,
        },
      },
      schema: {
        body: {
          type: "object",
          required: ["status"],
          properties: {
            status: { type: "string", enum: ["active", "suspended"] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const mod = await getAuthenticatedModerator(request, reply, ["super_admin", "platform_admin"]);
      if (!mod) return;

      const targetUserId = request.params.id;
      const { status } = request.body;

      if (targetUserId === mod.userId && status === "suspended") {
        return reply.code(400).type("application/problem+json").send({
          type: "about:blank",
          title: "Bad Request",
          status: 400,
          code: "self_suspension_prohibited",
          detail: "You cannot suspend your own account.",
          instance: request.url,
          requestId: request.id,
        });
      }

      await db.transaction(async (tx) => {
        await tx.update(users).set({ status }).where(eq(users.id, targetUserId));
        if (status === "suspended") {
          await tx
            .update(sessions)
            .set({ revokedAt: new Date() })
            .where(and(eq(sessions.userId, targetUserId), isNull(sessions.revokedAt)));
        }
      });

      return reply.code(200).send({ success: true, status });
    },
  );

  // POST /api/v1/admin/users/:id/roles
  app.post<{
    Params: { id: string };
    Body: { role: "super_admin" | "platform_admin" | "community_moderator" | "content_moderator" | "campaign_moderator" };
  }>(
    "/api/v1/admin/users/:id/roles",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: 60 * 1000,
        },
      },
      schema: {
        body: {
          type: "object",
          required: ["role"],
          properties: {
            role: {
              type: "string",
              enum: [
                "super_admin",
                "platform_admin",
                "community_moderator",
                "content_moderator",
                "campaign_moderator",
              ],
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const mod = await getAuthenticatedModerator(request, reply, ["super_admin"]);
      if (!mod) return;

      const targetUserId = request.params.id;
      const { role } = request.body;

      // Check if active assignment exists
      const existing = await db
        .select()
        .from(platformRoleAssignments)
        .where(
          and(
            eq(platformRoleAssignments.userId, targetUserId),
            eq(platformRoleAssignments.role, role),
            isNull(platformRoleAssignments.revokedAt),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        return reply.code(409).type("application/problem+json").send({
          type: "about:blank",
          title: "Conflict",
          status: 409,
          code: "role_already_assigned",
          detail: "The specified platform role is already active for this user.",
          instance: request.url,
          requestId: request.id,
        });
      }

      await db.insert(platformRoleAssignments).values({
        userId: targetUserId,
        role,
        grantedByUserId: mod.userId,
      });

      return reply.code(201).send({ success: true, role });
    },
  );

  // DELETE /api/v1/admin/users/:id/roles/:role
  app.delete<{
    Params: { id: string; role: string };
  }>(
    "/api/v1/admin/users/:id/roles/:role",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: 60 * 1000,
        },
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const mod = await getAuthenticatedModerator(request, reply, ["super_admin"]);
      if (!mod) return;

      const { id: targetUserId, role } = request.params;

      await db
        .update(platformRoleAssignments)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(platformRoleAssignments.userId, targetUserId),
            eq(
              platformRoleAssignments.role,
              role as "super_admin" | "platform_admin" | "community_moderator" | "content_moderator" | "campaign_moderator",
            ),
            isNull(platformRoleAssignments.revokedAt),
          ),
        );

      return reply.code(204).send();
    },
  );
}
