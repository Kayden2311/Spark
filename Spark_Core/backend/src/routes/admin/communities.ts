import { and, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import { communities, platformAuditEvents, users } from "../../infrastructure/database/schema.js";
import { pageSize, toPage, withoutCursor } from "../pagination.js";
import { problem } from "../responses.js";
import { COMMUNITY_STAFF, MUTATION_RATE_LIMIT, expectOutcome, idParams, likePattern, pageQueryProperties, readCursor, reasonProperty, type StaffGuard } from "./guard.js";

const COMMUNITY_STATES = ["active", "featured", "frozen", "archived"] as const;
const COMMUNITY_FILTERS = [...COMMUNITY_STATES, "flagged"] as const;
const COMMUNITY_ACTIONS = ["feature", "unfeature", "freeze", "unfreeze", "archive", "restore"] as const;
type CommunityFilter = (typeof COMMUNITY_FILTERS)[number];
type CommunityAction = (typeof COMMUNITY_ACTIONS)[number];

// The state each successful action leaves the community in (see staff_moderate_community).
const RESULTING_STATE: Record<CommunityAction, (typeof COMMUNITY_STATES)[number]> = {
  feature: "featured",
  unfeature: "active",
  freeze: "frozen",
  unfreeze: "active",
  archive: "archived",
  restore: "active",
};

const communitySchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    slug: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    visibility: { type: "string" },
    stage: { type: ["string", "null"] },
    city: { type: ["string", "null"] },
    countryCode: { type: ["string", "null"] },
    state: { type: "string", enum: COMMUNITY_STATES },
    createdAt: { type: "string", format: "date-time" },
    featuredAt: { type: ["string", "null"], format: "date-time" },
    frozenAt: { type: ["string", "null"], format: "date-time" },
    archivedAt: { type: ["string", "null"], format: "date-time" },
    creator: { type: "object", properties: { id: { type: "string" }, displayName: { type: "string" } } },
    memberCount: { type: "integer" },
    openReports: { type: "integer" },
    newMembers30d: { type: "integer" },
    posts30d: { type: "integer" },
    comments30d: { type: "integer" },
    weeklyActivity: { type: "array", items: { type: "integer" } },
  },
} as const;

const historyEntry = {
  type: "object",
  properties: {
    id: { type: "string" },
    action: { type: "string" },
    reason: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
    actor: { type: "object", properties: { id: { type: "string" }, displayName: { type: "string" } } },
  },
} as const;

interface Health {
  members: number;
  newMembers30d: number;
  posts30d: number;
  comments30d: number;
  weeklyActivity: number[];
  openReports: number;
}

const EMPTY_HEALTH: Health = { members: 0, newMembers30d: 0, posts30d: 0, comments30d: 0, weeklyActivity: [], openReports: 0 };

async function healthFor(client: PoolClient, ids: string[]): Promise<Map<string, Health>> {
  if (ids.length === 0) return new Map();
  const result = await client.query<{ community_id: string; members: string; new_members_30d: string; posts_30d: string; comments_30d: string; weekly_activity: string[]; open_reports: string }>(
    "SELECT * FROM spark.staff_community_health($1::uuid[])",
    [ids],
  );
  return new Map(result.rows.map((row) => [row.community_id, {
    members: Number(row.members),
    newMembers30d: Number(row.new_members_30d),
    posts30d: Number(row.posts_30d),
    comments30d: Number(row.comments_30d),
    weeklyActivity: row.weekly_activity.map(Number),
    openReports: Number(row.open_reports),
  }]));
}

async function selectCommunities(client: PoolClient, conditions: Array<SQL | undefined>, limit: number) {
  return drizzle(client)
    .select({
      id: communities.id,
      cursorTs: sql<string>`${communities.createdAt}::text`,
      slug: communities.slug,
      name: communities.name,
      description: communities.description,
      visibility: communities.visibility,
      stage: communities.stage,
      city: communities.city,
      countryCode: communities.countryCode,
      createdAt: communities.createdAt,
      featuredAt: communities.featuredAt,
      frozenAt: communities.frozenAt,
      archivedAt: communities.archivedAt,
      creatorId: communities.createdByUserId,
      creatorName: users.displayName,
    })
    .from(communities)
    .leftJoin(users, eq(users.id, communities.createdByUserId))
    .where(and(...conditions))
    .orderBy(desc(communities.createdAt), desc(communities.id))
    .limit(limit);
}

type CommunityRow = Awaited<ReturnType<typeof selectCommunities>>[number];

function toCommunity(row: CommunityRow, health: Health) {
  return {
    id: row.id,
    cursorTs: row.cursorTs,
    slug: row.slug,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    stage: row.stage,
    city: row.city,
    countryCode: row.countryCode,
    state: stateOf(row),
    createdAt: row.createdAt.toISOString(),
    featuredAt: row.featuredAt?.toISOString() ?? null,
    frozenAt: row.frozenAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    creator: { id: row.creatorId, displayName: row.creatorName ?? "Unknown member" },
    memberCount: health.members,
    openReports: health.openReports,
    newMembers30d: health.newMembers30d,
    posts30d: health.posts30d,
    comments30d: health.comments30d,
    weeklyActivity: health.weeklyActivity,
  };
}

function stateOf(row: { archivedAt: Date | null; frozenAt: Date | null; featuredAt: Date | null }) {
  if (row.archivedAt) return "archived";
  if (row.frozenAt) return "frozen";
  if (row.featuredAt) return "featured";
  return "active";
}

function stateCondition(filter: CommunityFilter | undefined): SQL | undefined {
  switch (filter) {
    case "archived": return isNotNull(communities.archivedAt);
    case "frozen": return isNotNull(communities.frozenAt);
    case "featured": return isNotNull(communities.featuredAt);
    case "active": return and(isNull(communities.archivedAt), isNull(communities.frozenAt), isNull(communities.featuredAt));
    default: return undefined;
  }
}

export function registerCommunityRoutes(app: FastifyInstance, guard: StaffGuard): void {
  app.get<{ Querystring: { status?: CommunityFilter; search?: string; cursor?: string; limit?: number } }>(
    "/api/v1/admin/communities",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { status: { type: "string", enum: COMMUNITY_FILTERS }, search: { type: "string", maxLength: 100 }, ...pageQueryProperties },
          additionalProperties: false,
        },
        response: {
          200: { type: "object", required: ["items", "nextCursor"], properties: { items: { type: "array", items: communitySchema }, nextCursor: { type: ["string", "null"] } } },
        },
      },
    },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, COMMUNITY_STAFF);
      if (!staff) return reply;
      const cursor = readCursor(request, reply, request.query.cursor);
      if (cursor === undefined) return reply;
      const limit = pageSize(request.query.limit);
      const search = request.query.search?.trim();

      const page = await guard.run(request, reply, staff, async (client) => {
        const conditions: Array<SQL | undefined> = [stateCondition(request.query.status)];
        if (request.query.status === "flagged") {
          const flagged = await client.query<{ community_id: string }>("SELECT community_id FROM spark.staff_open_report_counts(NULL)");
          if (flagged.rows.length === 0) return { rows: [] as CommunityRow[], health: new Map<string, Health>() };
          conditions.push(inArray(communities.id, flagged.rows.map((row) => row.community_id)));
        }
        if (search) conditions.push(or(ilike(communities.name, likePattern(search)), ilike(communities.slug, likePattern(search))));
        if (cursor) conditions.push(sql`(${communities.createdAt}, ${communities.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`);
        const rows = await selectCommunities(client, conditions, limit + 1);
        return { rows, health: await healthFor(client, rows.map((row) => row.id)) };
      });
      if (reply.sent || !page) return reply;

      return toPage(
        page.rows.map((row) => toCommunity(row, page.health.get(row.id) ?? EMPTY_HEALTH)),
        limit,
      );
    },
  );

  // One community with its health, a daily series and the staff decisions taken on it.
  app.get<{ Params: { id: string }; Querystring: { days: number } }>(
    "/api/v1/admin/communities/:id",
    {
      schema: {
        params: idParams,
        querystring: { type: "object", properties: { days: { type: "integer", minimum: 7, maximum: 365, default: 90 } }, additionalProperties: false },
        response: {
          200: {
            type: "object",
            properties: {
              community: communitySchema,
              series: {
                type: "array",
                items: { type: "object", properties: { day: { type: "string", format: "date" }, newMembers: { type: "integer" }, posts: { type: "integer" }, comments: { type: "integer" }, reportsOpened: { type: "integer" } } },
              },
              history: { type: "array", items: historyEntry },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, COMMUNITY_STAFF);
      if (!staff) return reply;
      const detail = await guard.run(request, reply, staff, async (client) => {
        const [row] = await selectCommunities(client, [eq(communities.id, request.params.id)], 1);
        if (!row) return null;
        const health = await healthFor(client, [row.id]);
        const series = await client.query<{ day: string; new_members: string; posts: string; comments: string; reports_opened: string }>(
          "SELECT day::text AS day, new_members, posts, comments, reports_opened FROM spark.staff_community_series($1, $2)",
          [row.id, request.query.days],
        );
        // RLS shows audit rows to platform admins only; community moderators get an empty history.
        const history = await drizzle(client)
            .select({ id: platformAuditEvents.id, action: platformAuditEvents.action, reason: platformAuditEvents.reason, createdAt: platformAuditEvents.createdAt, actorId: platformAuditEvents.actorUserId, actorName: users.displayName })
            .from(platformAuditEvents)
            .leftJoin(users, eq(users.id, platformAuditEvents.actorUserId))
            .where(and(eq(platformAuditEvents.targetType, "community"), eq(platformAuditEvents.targetId, row.id)))
            .orderBy(desc(platformAuditEvents.createdAt), desc(platformAuditEvents.id))
            .limit(20);
        return { row, health: health.get(row.id) ?? EMPTY_HEALTH, series: series.rows, history };
      });
      if (reply.sent) return reply;
      if (!detail) return problem(request, reply, 404, "Not Found", "community_not_found", "Community does not exist.");
      return {
        community: withoutCursor(toCommunity(detail.row, detail.health)),
        series: detail.series.map((point) => ({ day: point.day, newMembers: Number(point.new_members), posts: Number(point.posts), comments: Number(point.comments), reportsOpened: Number(point.reports_opened) })),
        history: detail.history.map((entry) => ({ id: entry.id, action: entry.action, reason: entry.reason, createdAt: entry.createdAt.toISOString(), actor: { id: entry.actorId, displayName: entry.actorName ?? "Unknown member" } })),
      };
    },
  );

  app.post<{ Params: { id: string }; Body: { action: CommunityAction; reason: string } }>(
    "/api/v1/admin/communities/:id/actions",
    {
      config: MUTATION_RATE_LIMIT,
      schema: {
        params: idParams,
        body: {
          type: "object",
          required: ["action", "reason"],
          properties: { action: { type: "string", enum: COMMUNITY_ACTIONS }, reason: reasonProperty },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, COMMUNITY_STAFF);
      if (!staff) return reply;
      const { action, reason } = request.body;
      const outcome = await guard.run(request, reply, staff, async (client) =>
        (await client.query<{ outcome: string }>("SELECT spark.staff_moderate_community($1, $2, $3) AS outcome", [request.params.id, action, reason])).rows[0]?.outcome);
      if (reply.sent) return reply;
      if (outcome === "not_found") return problem(request, reply, 404, "Not Found", "community_not_found", "Community does not exist.");
      if (outcome === "invalid_transition") {
        return problem(request, reply, 409, "Conflict", "invalid_transition", `The community's current state does not allow "${action}".`);
      }
      expectOutcome(outcome, "ok");
      return { id: request.params.id, state: RESULTING_STATE[action] };
    },
  );
}
