import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";

import {
  communities,
  communityMemberships,
  moderationActions,
  promotionCampaigns,
  promotionPlacements,
  userEmails,
  users,
  workspaceMemberships,
} from "../infrastructure/database/schema.js";
import { loadSessionPrincipal, readSessionTokenHash, withSessionContext } from "../infrastructure/database/session.js";
import { problem } from "./responses.js";

export interface AdminPluginOptions {
  readonly pool: Pool;
}

const PLATFORM_ROLES = ["super_admin", "platform_admin", "community_moderator", "content_moderator", "campaign_moderator"] as const;
type PlatformRole = (typeof PLATFORM_ROLES)[number];

const ADMINS: PlatformRole[] = ["super_admin", "platform_admin"];
const CONTENT_STAFF: PlatformRole[] = ["super_admin", "platform_admin", "content_moderator"];
const COMMUNITY_STAFF: PlatformRole[] = ["super_admin", "platform_admin", "community_moderator"];
const CAMPAIGN_STAFF: PlatformRole[] = ["super_admin", "platform_admin", "campaign_moderator"];

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
} as const;

interface AuthenticatedModerator {
  userId: string;
  roles: string[];
  tokenHash: Buffer;
}

// Database outcomes are a closed set; anything unexpected must not be reported as success.
function expectOutcome(outcome: string | undefined, ...allowed: string[]): void {
  if (!outcome || !allowed.includes(outcome)) throw new Error(`Unexpected governance outcome: ${outcome ?? "none"}`);
}

function clampLimit(value: unknown): number {
  const limit = Number(value);
  return Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 50;
}

// Errors raised by spark.require_platform_role; other 42501 errors are real privilege bugs and stay 500s.
function governanceError(error: unknown): "no_session" | "no_role" | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  if (error.code === "28000" && "message" in error && error.message === "Live session required") return "no_session";
  if (error.code === "42501" && "message" in error && error.message === "Platform role required") return "no_role";
  return null;
}

export function registerAdminRoutes(app: FastifyInstance, options: AdminPluginOptions): void {
  const { pool } = options;

  async function getAuthenticatedModerator(
    request: FastifyRequest,
    reply: FastifyReply,
    requiredRoles: readonly PlatformRole[] = PLATFORM_ROLES,
  ): Promise<AuthenticatedModerator | null> {
    const tokenHash = readSessionTokenHash(request.headers.cookie);
    if (!tokenHash) {
      void problem(request, reply, 401, "Unauthorized", "unauthenticated", "No active session.");
      return null;
    }

    const principal = await loadSessionPrincipal(pool, tokenHash);
    if (!principal) {
      void problem(request, reply, 401, "Unauthorized", "session_expired", "Session expired or invalid.");
      return null;
    }

    if (!principal.platformRoles.some((role) => requiredRoles.includes(role as PlatformRole))) {
      void problem(request, reply, 403, "Forbidden", "insufficient_permissions", "You do not possess the required platform governance permissions.");
      return null;
    }

    return { userId: principal.userId, roles: principal.platformRoles, tokenHash };
  }

  /**
   * Runs staff work in a session-bound transaction. A session or role revoked between the check
   * above and the database call is reported as 401 or 403 respectively.
   */
  async function asStaff<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    mod: AuthenticatedModerator,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await withSessionContext(pool, mod.tokenHash, work);
    } catch (error) {
      const denial = governanceError(error);
      if (denial === "no_session") {
        void problem(request, reply, 401, "Unauthorized", "session_expired", "Session expired or invalid.");
        return undefined;
      }
      if (denial === "no_role") {
        void problem(request, reply, 403, "Forbidden", "insufficient_permissions", "You do not possess the required platform governance permissions.");
        return undefined;
      }
      throw error;
    }
  }

  // GET /api/v1/admin/overview
  app.get("/api/v1/admin/overview", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const mod = await getAuthenticatedModerator(request, reply);
    if (!mod) return;

    const row = await asStaff(request, reply, mod, async (client) => {
      const result = await client.query<Record<string, string>>("SELECT * FROM spark.staff_overview()");
      return result.rows[0];
    });
    if (reply.sent) return;

    return reply.code(200).send({
      activeCommunitiesCount: Number(row?.active_communities ?? 0),
      registeredUsersCount: Number(row?.active_users ?? 0),
      pendingReportsCount: Number(row?.open_reports ?? 0),
      activeCampaignsCount: Number(row?.approved_campaigns ?? 0),
      workspacesCount: Number(row?.active_workspaces ?? 0),
      auditEventsCount: Number(row?.moderation_actions ?? 0),
    });
  });

  // GET /api/v1/admin/reports
  app.get<{
    Querystring: { status?: "open" | "reviewing" | "resolved" | "dismissed"; limit?: number };
  }>(
    "/api/v1/admin/reports",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["open", "reviewing", "resolved", "dismissed"] },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const mod = await getAuthenticatedModerator(request, reply, CONTENT_STAFF);
      if (!mod) return;

      const rows = await asStaff(request, reply, mod, async (client) => {
        const result = await client.query("SELECT * FROM spark.staff_list_reports($1,$2)", [
          request.query.status ?? "open",
          clampLimit(request.query.limit),
        ]);
        return result.rows;
      });
      if (reply.sent || !rows) return;

      return reply.code(200).send({
        reports: rows.map((r) => ({
          id: r.id,
          tenantId: r.tenant_id,
          communityId: r.community_id,
          communityName: r.community_name || "Unknown Community",
          communitySlug: r.community_slug || "",
          reporter: {
            id: r.reporter_user_id,
            displayName: r.reporter_name || "Anonymous Member",
          },
          targetType: r.comment_id ? "comment" : r.post_id ? "post" : "community",
          targetTitle: r.post_title || (r.comment_body ? `Comment: "${String(r.comment_body).slice(0, 40)}..."` : "Community Guidelines"),
          targetSnippet: r.post_body || r.comment_body || r.details || "",
          moderationStatus: r.post_moderation_status || r.comment_moderation_status || "visible",
          reasonCode: r.reason_code,
          details: r.details,
          status: r.status,
          createdAt: r.created_at,
          resolvedAt: r.resolved_at,
        })),
      });
    },
  );

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
        params: idParams,
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
      const mod = await getAuthenticatedModerator(request, reply, CONTENT_STAFF);
      if (!mod) return;

      const outcome = await asStaff(request, reply, mod, async (client) => {
        const result = await client.query<{ outcome: string }>("SELECT spark.staff_resolve_report($1,$2,$3) AS outcome", [
          request.params.id,
          request.body.action,
          request.body.reason,
        ]);
        return result.rows[0]?.outcome;
      });
      if (reply.sent) return;

      if (outcome === "not_found") {
        return problem(request, reply, 404, "Not Found", "report_not_found", "Report does not exist.");
      }
      if (outcome === "already_closed") {
        return problem(request, reply, 409, "Conflict", "report_already_closed", "This report has already been resolved or dismissed.");
      }
      expectOutcome(outcome, "ok");
      return reply.code(200).send({ success: true, message: "Moderation action executed successfully." });
    },
  );

  // GET /api/v1/admin/communities
  app.get("/api/v1/admin/communities", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const mod = await getAuthenticatedModerator(request, reply, COMMUNITY_STAFF);
    if (!mod) return;

    const enriched = await asStaff(request, reply, mod, async (client) => {
      const db = drizzle(client);
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
      if (commList.length === 0) return [];

      const ids = commList.map((c) => c.id);
      const [memberCounts, reportCounts] = await Promise.all([
        db
          .select({ communityId: communityMemberships.communityId, value: count() })
          .from(communityMemberships)
          .where(and(inArray(communityMemberships.communityId, ids), eq(communityMemberships.status, "active")))
          .groupBy(communityMemberships.communityId),
        client.query<{ community_id: string; open_reports: string }>("SELECT * FROM spark.staff_open_report_counts($1::uuid[])", [ids]),
      ]);
      const members = new Map(memberCounts.map((row) => [row.communityId, row.value]));
      const reports = new Map(reportCounts.rows.map((row) => [row.community_id, Number(row.open_reports)]));

      return commList.map((c) => {
        const reportCount = reports.get(c.id) ?? 0;
        return {
          ...c,
          memberCount: members.get(c.id) ?? 0,
          reportCount,
          status: c.archivedAt ? "archived" : reportCount > 0 ? "flagged" : "active",
        };
      });
    });
    if (reply.sent) return;

    return reply.code(200).send({ communities: enriched ?? [] });
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
        params: idParams,
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
      const mod = await getAuthenticatedModerator(request, reply, COMMUNITY_STAFF);
      if (!mod) return;

      const { action } = request.body;
      const updated = await asStaff(request, reply, mod, async (client) => {
        const result = await client.query<{ updated: boolean }>("SELECT spark.staff_set_community_archived($1,$2) AS updated", [
          request.params.id,
          action === "archive",
        ]);
        return result.rows[0]?.updated;
      });
      if (reply.sent) return;

      if (!updated) {
        return problem(request, reply, 404, "Not Found", "community_not_found", "Community does not exist.");
      }
      return reply.code(200).send({ success: true, status: action === "archive" ? "archived" : "active" });
    },
  );

  // GET /api/v1/admin/users
  app.get<{
    Querystring: { search?: string; status?: "active" | "suspended"; limit?: number };
  }>("/api/v1/admin/users", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const mod = await getAuthenticatedModerator(request, reply, ADMINS);
    if (!mod) return;

    const search = request.query.search?.trim().slice(0, 100);

    const enrichedUsers = await asStaff(request, reply, mod, async (client) => {
      const db = drizzle(client);
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
        .limit(clampLimit(request.query.limit));
      if (userRows.length === 0) return [];

      const ids = userRows.map((u) => u.id);
      const [roleRows, workspaceCounts] = await Promise.all([
        client.query<{ user_id: string; role: string }>("SELECT * FROM spark.staff_user_roles($1::uuid[])", [ids]),
        db
          .select({ userId: workspaceMemberships.userId, value: count() })
          .from(workspaceMemberships)
          .where(and(inArray(workspaceMemberships.userId, ids), eq(workspaceMemberships.status, "active")))
          .groupBy(workspaceMemberships.userId),
      ]);
      const roles = new Map<string, string[]>();
      for (const row of roleRows.rows) roles.set(row.user_id, [...(roles.get(row.user_id) ?? []), row.role]);
      const workspaceTotals = new Map(workspaceCounts.map((row) => [row.userId, row.value]));

      return userRows.map((u) => ({
        ...u,
        platformRoles: roles.get(u.id) ?? [],
        workspaceCount: workspaceTotals.get(u.id) ?? 0,
      }));
    });
    if (reply.sent) return;

    return reply.code(200).send({ users: enrichedUsers ?? [] });
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
        params: idParams,
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
      const mod = await getAuthenticatedModerator(request, reply, ADMINS);
      if (!mod) return;

      const { status } = request.body;
      const outcome = await asStaff(request, reply, mod, async (client) => {
        const result = await client.query<{ outcome: string }>("SELECT spark.staff_set_user_status($1,$2) AS outcome", [request.params.id, status]);
        return result.rows[0]?.outcome;
      });
      if (reply.sent) return;

      if (outcome === "self") {
        return problem(request, reply, 400, "Bad Request", "self_suspension_prohibited", "You cannot suspend your own account.");
      }
      if (outcome === "forbidden") {
        return problem(request, reply, 403, "Forbidden", "insufficient_permissions", "Only a super admin can change another super admin's status.");
      }
      if (outcome === "not_found") {
        return problem(request, reply, 404, "Not Found", "user_not_found", "User does not exist.");
      }
      if (outcome === "last_super_admin") {
        return problem(request, reply, 409, "Conflict", "last_super_admin", "The last active super admin cannot be suspended.");
      }
      expectOutcome(outcome, "ok");
      return reply.code(200).send({ success: true, status });
    },
  );

  // POST /api/v1/admin/users/:id/roles
  app.post<{
    Params: { id: string };
    Body: { role: PlatformRole };
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
        params: idParams,
        body: {
          type: "object",
          required: ["role"],
          properties: {
            role: { type: "string", enum: [...PLATFORM_ROLES] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const mod = await getAuthenticatedModerator(request, reply, ["super_admin"]);
      if (!mod) return;

      const { role } = request.body;
      const outcome = await asStaff(request, reply, mod, async (client) => {
        const result = await client.query<{ outcome: string }>("SELECT spark.staff_grant_role($1,$2) AS outcome", [request.params.id, role]);
        return result.rows[0]?.outcome;
      });
      if (reply.sent) return;

      if (outcome === "exists") {
        return problem(request, reply, 409, "Conflict", "role_already_assigned", "The specified platform role is already active for this user.");
      }
      if (outcome === "not_found") {
        return problem(request, reply, 404, "Not Found", "user_not_found", "User does not exist or is not active.");
      }
      expectOutcome(outcome, "granted");
      return reply.code(201).send({ success: true, role });
    },
  );

  // DELETE /api/v1/admin/users/:id/roles/:role
  app.delete<{
    Params: { id: string; role: PlatformRole };
  }>(
    "/api/v1/admin/users/:id/roles/:role",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: 60 * 1000,
        },
      },
      schema: {
        params: {
          type: "object",
          required: ["id", "role"],
          properties: {
            id: { type: "string", format: "uuid" },
            role: { type: "string", enum: [...PLATFORM_ROLES] },
          },
        },
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const mod = await getAuthenticatedModerator(request, reply, ["super_admin"]);
      if (!mod) return;

      const outcome = await asStaff(request, reply, mod, async (client) => {
        const result = await client.query<{ outcome: string }>("SELECT spark.staff_revoke_role($1,$2) AS outcome", [
          request.params.id,
          request.params.role,
        ]);
        return result.rows[0]?.outcome;
      });
      if (reply.sent) return;

      if (outcome === "last_super_admin") {
        return problem(request, reply, 409, "Conflict", "last_super_admin", "The last active super admin cannot be removed.");
      }
      expectOutcome(outcome, "revoked", "not_found");
      return reply.code(204).send();
    },
  );

  // GET /api/v1/admin/campaigns
  app.get<{
    Querystring: { status?: "draft" | "pending" | "approved" | "rejected"; limit?: number };
  }>("/api/v1/admin/campaigns", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const mod = await getAuthenticatedModerator(request, reply, CAMPAIGN_STAFF);
    if (!mod) return;

    const statusFilter = request.query.status;

    const campaignRows = await asStaff(request, reply, mod, (client) =>
      drizzle(client)
        .select({
          id: promotionCampaigns.id,
          tenantId: promotionCampaigns.tenantId,
          communityId: promotionCampaigns.communityId,
          name: promotionCampaigns.name,
          headline: promotionCampaigns.headline,
          description: promotionCampaigns.description,
          reviewStatus: promotionCampaigns.reviewStatus,
          deliveryStatus: promotionCampaigns.deliveryStatus,
          requestedStartAt: promotionCampaigns.requestedStartAt,
          startsAt: promotionCampaigns.startsAt,
          endsAt: promotionCampaigns.endsAt,
          version: promotionCampaigns.version,
          createdAt: promotionCampaigns.createdAt,
          submittedByUserId: promotionCampaigns.submittedByUserId,
          submitterName: users.displayName,
          communityName: communities.name,
          communitySlug: communities.slug,
          placementName: promotionPlacements.name,
        })
        .from(promotionCampaigns)
        .leftJoin(users, eq(users.id, promotionCampaigns.submittedByUserId))
        .leftJoin(communities, eq(communities.id, promotionCampaigns.communityId))
        .leftJoin(promotionPlacements, eq(promotionPlacements.id, promotionCampaigns.placementId))
        .where(statusFilter ? eq(promotionCampaigns.reviewStatus, statusFilter) : undefined)
        .orderBy(desc(promotionCampaigns.createdAt))
        .limit(clampLimit(request.query.limit)),
    );
    if (reply.sent) return;

    return reply.code(200).send({ campaigns: campaignRows ?? [] });
  });

  // POST /api/v1/admin/campaigns/:id/review
  app.post<{
    Params: { id: string };
    Body: { decision: "approve" | "reject"; reason: string };
  }>(
    "/api/v1/admin/campaigns/:id/review",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: 60 * 1000,
        },
      },
      schema: {
        params: idParams,
        body: {
          type: "object",
          required: ["decision", "reason"],
          properties: {
            decision: { type: "string", enum: ["approve", "reject"] },
            reason: { type: "string", minLength: 3, maxLength: 500 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const mod = await getAuthenticatedModerator(request, reply, CAMPAIGN_STAFF);
      if (!mod) return;

      const { decision, reason } = request.body;
      const outcome = await asStaff(request, reply, mod, async (client) => {
        const result = await client.query<{ outcome: string }>("SELECT spark.staff_review_campaign($1,$2,$3) AS outcome", [
          request.params.id,
          decision,
          reason,
        ]);
        return result.rows[0]?.outcome;
      });
      if (reply.sent) return;

      if (outcome === "not_found") {
        return problem(request, reply, 404, "Not Found", "campaign_not_found", "Campaign does not exist.");
      }
      if (outcome === "not_pending") {
        return problem(request, reply, 409, "Conflict", "campaign_not_pending", "Only campaigns awaiting review can be approved or rejected.");
      }
      expectOutcome(outcome, "ok");
      return reply.code(200).send({ success: true, decision });
    },
  );

  // GET /api/v1/admin/audit-logs
  app.get<{
    Querystring: { limit?: number };
  }>("/api/v1/admin/audit-logs", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const mod = await getAuthenticatedModerator(request, reply, ADMINS);
    if (!mod) return;

    const actions = await asStaff(request, reply, mod, (client) =>
      drizzle(client)
        .select({
          id: moderationActions.id,
          tenantId: moderationActions.tenantId,
          communityId: moderationActions.communityId,
          reportId: moderationActions.reportId,
          postId: moderationActions.postId,
          commentId: moderationActions.commentId,
          actorUserId: moderationActions.actorUserId,
          action: moderationActions.action,
          reason: moderationActions.reason,
          createdAt: moderationActions.createdAt,
          actorName: users.displayName,
          communityName: communities.name,
        })
        .from(moderationActions)
        .leftJoin(users, eq(users.id, moderationActions.actorUserId))
        .leftJoin(communities, eq(communities.id, moderationActions.communityId))
        .orderBy(desc(moderationActions.createdAt))
        .limit(clampLimit(request.query.limit)),
    );
    if (reply.sent) return;

    return reply.code(200).send({ auditLogs: actions ?? [] });
  });

  // GET /api/v1/admin/system
  app.get("/api/v1/admin/system", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const mod = await getAuthenticatedModerator(request, reply, ADMINS);
    if (!mod) return;

    const activeSessions = await asStaff(request, reply, mod, async (client) => {
      const result = await client.query<{ total: string }>("SELECT spark.staff_active_session_count() AS total");
      return Number(result.rows[0]?.total ?? 0);
    });
    if (reply.sent) return;

    return reply.code(200).send({
      status: "operational",
      nodeVersion: process.version,
      uptimeSeconds: Math.floor(process.uptime()),
      activeSessionsCount: activeSessions ?? 0,
      timestamp: new Date().toISOString(),
    });
  });
}
