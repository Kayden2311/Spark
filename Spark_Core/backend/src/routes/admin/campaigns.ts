import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import { communities, promotionCampaigns, promotionPlacements, users } from "../../infrastructure/database/schema.js";
import { pageSize, toPage, withoutCursor, type Cursor } from "../pagination.js";
import { problem } from "../responses.js";
import { CAMPAIGN_STAFF, MUTATION_RATE_LIMIT, expectOutcome, idParams, pageQueryProperties, readCursor, reasonProperty, type StaffGuard } from "./guard.js";

const REVIEW_STATUSES = ["draft", "pending", "approved", "rejected"] as const;
type ReviewStatus = (typeof REVIEW_STATUSES)[number];

const campaignSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    headline: { type: "string" },
    description: { type: "string" },
    reviewStatus: { type: "string", enum: REVIEW_STATUSES },
    deliveryStatus: { type: "string" },
    requestedStartAt: { type: "string", format: "date-time" },
    startsAt: { type: ["string", "null"], format: "date-time" },
    endsAt: { type: ["string", "null"], format: "date-time" },
    version: { type: "integer" },
    createdAt: { type: "string", format: "date-time" },
    community: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, slug: { type: "string" } } },
    submitter: { type: "object", properties: { id: { type: "string" }, displayName: { type: "string" } } },
    placement: { type: ["string", "null"] },
  },
} as const;

async function selectCampaigns(client: PoolClient, where: Array<SQL | undefined>, limit: number) {
  const rows = await drizzle(client)
    .select({
      id: promotionCampaigns.id,
      cursorTs: sql<string>`${promotionCampaigns.createdAt}::text`,
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
      communityId: promotionCampaigns.communityId,
      communityName: communities.name,
      communitySlug: communities.slug,
      submitterId: promotionCampaigns.submittedByUserId,
      submitterName: users.displayName,
      placement: promotionPlacements.name,
    })
    .from(promotionCampaigns)
    .leftJoin(users, eq(users.id, promotionCampaigns.submittedByUserId))
    .leftJoin(communities, eq(communities.id, promotionCampaigns.communityId))
    .leftJoin(promotionPlacements, eq(promotionPlacements.id, promotionCampaigns.placementId))
    .where(and(...where))
    .orderBy(desc(promotionCampaigns.createdAt), desc(promotionCampaigns.id))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    cursorTs: row.cursorTs,
    name: row.name,
    headline: row.headline,
    description: row.description,
    reviewStatus: row.reviewStatus,
    deliveryStatus: row.deliveryStatus,
    requestedStartAt: row.requestedStartAt.toISOString(),
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    community: { id: row.communityId, name: row.communityName ?? "Unknown community", slug: row.communitySlug ?? "" },
    submitter: { id: row.submitterId, displayName: row.submitterName ?? "Unknown member" },
    placement: row.placement,
  }));
}

function cursorCondition(cursor: Cursor | null): SQL | undefined {
  return cursor ? sql`(${promotionCampaigns.createdAt}, ${promotionCampaigns.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : undefined;
}

export function registerCampaignRoutes(app: FastifyInstance, guard: StaffGuard): void {
  app.get<{ Querystring: { status?: ReviewStatus; cursor?: string; limit?: number } }>(
    "/api/v1/admin/campaigns",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { status: { type: "string", enum: REVIEW_STATUSES }, ...pageQueryProperties },
          additionalProperties: false,
        },
        response: {
          200: { type: "object", required: ["items", "nextCursor"], properties: { items: { type: "array", items: campaignSchema }, nextCursor: { type: ["string", "null"] } } },
        },
      },
    },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, CAMPAIGN_STAFF);
      if (!staff) return reply;
      const cursor = readCursor(request, reply, request.query.cursor);
      if (cursor === undefined) return reply;
      const limit = pageSize(request.query.limit);
      const status = request.query.status;
      const rows = await guard.run(request, reply, staff, (client) =>
        selectCampaigns(client, [status ? eq(promotionCampaigns.reviewStatus, status) : undefined, cursorCondition(cursor)], limit + 1));
      if (reply.sent || !rows) return reply;
      return toPage(rows, limit);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/admin/campaigns/:id",
    { schema: { params: idParams, response: { 200: campaignSchema } } },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, CAMPAIGN_STAFF);
      if (!staff) return reply;
      const rows = await guard.run(request, reply, staff, (client) => selectCampaigns(client, [eq(promotionCampaigns.id, request.params.id)], 1));
      if (reply.sent) return reply;
      const campaign = rows?.[0];
      if (!campaign) return problem(request, reply, 404, "Not Found", "campaign_not_found", "Campaign does not exist.");
      return withoutCursor(campaign);
    },
  );

  app.post<{ Params: { id: string }; Body: { decision: "approve" | "reject"; reason: string } }>(
    "/api/v1/admin/campaigns/:id/review",
    {
      config: MUTATION_RATE_LIMIT,
      schema: {
        params: idParams,
        body: {
          type: "object",
          required: ["decision", "reason"],
          properties: { decision: { type: "string", enum: ["approve", "reject"] }, reason: reasonProperty },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, CAMPAIGN_STAFF);
      if (!staff) return reply;
      const { decision, reason } = request.body;
      const outcome = await guard.run(request, reply, staff, async (client) =>
        (await client.query<{ outcome: string }>("SELECT spark.staff_review_campaign($1, $2, $3) AS outcome", [request.params.id, decision, reason])).rows[0]?.outcome);
      if (reply.sent) return reply;
      if (outcome === "not_found") return problem(request, reply, 404, "Not Found", "campaign_not_found", "Campaign does not exist.");
      if (outcome === "not_pending") return problem(request, reply, 409, "Conflict", "campaign_not_pending", "Only campaigns awaiting review can be approved or rejected.");
      if (outcome === "community_unavailable") {
        return problem(request, reply, 409, "Conflict", "community_unavailable", "The community is frozen or archived, so this campaign cannot be approved. It can still be rejected.");
      }
      expectOutcome(outcome, "ok");
      return { id: request.params.id, reviewStatus: decision === "approve" ? "approved" : "rejected" };
    },
  );
}
