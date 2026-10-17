import { and, count, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance } from "fastify";

import { communities, communityMemberships, users } from "../../infrastructure/database/schema.js";
import { pageSize, toPage } from "../pagination.js";
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
  },
} as const;

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
        const db = drizzle(client);
        const conditions: Array<SQL | undefined> = [stateCondition(request.query.status)];
        if (request.query.status === "flagged") {
          const flagged = await client.query<{ community_id: string }>("SELECT community_id FROM spark.staff_open_report_counts(NULL)");
          if (flagged.rows.length === 0) return { rows: [], members: new Map<string, number>(), reports: new Map<string, number>() };
          conditions.push(inArray(communities.id, flagged.rows.map((row) => row.community_id)));
        }
        if (search) conditions.push(or(ilike(communities.name, likePattern(search)), ilike(communities.slug, likePattern(search))));
        if (cursor) conditions.push(sql`(${communities.createdAt}, ${communities.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`);

        const rows = await db
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
          .limit(limit + 1);
        if (rows.length === 0) return { rows, members: new Map<string, number>(), reports: new Map<string, number>() };

        const ids = rows.map((row) => row.id);
        const [memberCounts, reportCounts] = await Promise.all([
          db.select({ communityId: communityMemberships.communityId, value: count() })
            .from(communityMemberships)
            .where(and(inArray(communityMemberships.communityId, ids), eq(communityMemberships.status, "active")))
            .groupBy(communityMemberships.communityId),
          client.query<{ community_id: string; open_reports: string }>("SELECT * FROM spark.staff_open_report_counts($1::uuid[])", [ids]),
        ]);
        return {
          rows,
          members: new Map(memberCounts.map((row) => [row.communityId, row.value])),
          reports: new Map(reportCounts.rows.map((row) => [row.community_id, Number(row.open_reports)])),
        };
      });
      if (reply.sent || !page) return reply;

      return toPage(
        page.rows.map((row) => ({
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
          memberCount: page.members.get(row.id) ?? 0,
          openReports: page.reports.get(row.id) ?? 0,
        })),
        limit,
      );
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
