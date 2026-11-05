import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import { problem } from "../responses.js";
import { MUTATION_RATE_LIMIT } from "../session-guard.js";
import type { MemberGuard } from "../workspace/guard.js";
import { communityNotFound, communityParams, mapOutcome, noQuery, runCommunity, type Mapped } from "./access.js";

// Join, request and withdraw: 20 per 10 minutes per client.
const MEMBERSHIP_RATE_LIMIT = { rateLimit: { max: 20, timeWindow: 10 * 60 * 1000 } } as const;

const nullableString = { type: ["string", "null"] } as const;

const requestParams = {
  type: "object",
  required: ["requestId"],
  properties: { requestId: { type: "string", format: "uuid" } },
  additionalProperties: false,
} as const;

// Fastify's validator strips unknown keys instead of failing; propertyNames makes them a 400.
const requestBody = {
  type: ["object", "null"],
  propertyNames: { enum: ["message"] },
  properties: { message: { type: ["string", "null"], maxLength: 500 } },
  additionalProperties: false,
} as const;

const decisionBody = {
  type: "object",
  required: ["decision"],
  propertyNames: { enum: ["decision"] },
  properties: { decision: { type: "string", enum: ["approve", "reject"] } },
  additionalProperties: false,
} as const;

const joinResponse = { type: "object", properties: { status: { type: "string" }, alreadyMember: { type: "boolean" } } } as const;

const requestProperties = { id: { type: "string" }, status: { type: "string" }, message: nullableString, createdAt: { type: "string" } } as const;
const requestResponse = { type: "object", properties: { request: { type: "object", properties: requestProperties } } } as const;

const myRequestsResponse = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          community: { type: "object", properties: { slug: { type: "string" }, name: { type: "string" } } },
          status: { type: "string" },
          message: nullableString,
          createdAt: { type: "string" },
          reviewedAt: nullableString,
        },
      },
    },
  },
} as const;

const decisionResponse = { type: "object", properties: { status: { type: "string" } } } as const;

const iso = (value: Date | string) => new Date(value).toISOString();
const isoOrNull = (value: Date | string | null) => (value === null ? null : iso(value));

// ---------- Outcomes ----------

const frozen: Mapped = [409, "Conflict", "community_frozen", "This community is frozen and does not take new members right now."];
const suspended: Mapped = [403, "Forbidden", "membership_suspended", "Your membership in this community is suspended."];
const requestNotFound: Mapped = [404, "Not Found", "request_not_found", "Join request not found."];

const joinOutcomes: Record<string, Mapped> = {
  not_found: communityNotFound,
  request_required: [409, "Conflict", "request_required", "This community is private; request access instead."],
  community_frozen: frozen,
  membership_suspended: suspended,
};

const requestOutcomes: Record<string, Mapped> = {
  not_found: communityNotFound,
  join_instead: [409, "Conflict", "join_instead", "This community is public; join it directly."],
  already_member: [409, "Conflict", "already_member", "You are already a member of this community."],
  community_frozen: frozen,
  membership_suspended: suspended,
};

const withdrawOutcomes: Record<string, Mapped> = {
  not_found: requestNotFound,
  not_pending: [409, "Conflict", "not_pending", "This request is no longer pending."],
};

const decisionOutcomes: Record<string, Mapped> = {
  not_found: requestNotFound,
  forbidden: [403, "Forbidden", "insufficient_role", "Only community managers can decide join requests."],
  already_decided: [409, "Conflict", "already_decided", "This request was already decided."],
  community_frozen: frozen,
};

// ---------- Reads ----------

interface RequestRow { id: string; status: string; message: string | null; created_at: Date | string }

// The caller's own request (join_requests RLS shows a user their own rows). Explicit columns: the
// reviewer id is readable by the requester under RLS but never leaves the API.
async function readOwnRequest(client: PoolClient, requestId: string) {
  const found = await client.query<RequestRow>(
    "SELECT r.id, r.status, r.message, r.created_at FROM spark.community_join_requests r WHERE r.id = $1",
    [requestId],
  );
  const row = found.rows[0];
  if (!row) throw new Error("Join request is not readable");
  return { id: row.id, status: row.status, message: row.message, createdAt: iso(row.created_at) };
}

interface MyRequestRow {
  id: string;
  community_slug: string;
  community_name: string;
  status: string;
  message: string | null;
  created_at: Date | string;
  reviewed_at: Date | string | null;
}

// ---------- Routes ----------

export function registerMembershipRoutes(app: FastifyInstance, guard: MemberGuard): void {
  app.post<{ Params: { communityId: string } }>(
    "/api/v1/communities/:communityId/join",
    { config: MEMBERSHIP_RATE_LIMIT, schema: { params: communityParams, querystring: noQuery, response: { 200: joinResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const outcome = await runCommunity(guard, request, reply, member, async (client) =>
        (await client.query<{ outcome: string }>("SELECT outcome FROM spark.ws_join_community($1)", [request.params.communityId])).rows[0]?.outcome);
      if (reply.sent) return reply;
      const mapped = mapOutcome(joinOutcomes, outcome, "joined", "already_member");
      if (mapped) return problem(request, reply, ...mapped);
      // A repeated join (double click) answers the same state instead of an error.
      return { status: "member", alreadyMember: outcome === "already_member" };
    },
  );

  app.post<{ Params: { communityId: string }; Body: { message?: string | null } | null }>(
    "/api/v1/communities/:communityId/requests",
    { config: MEMBERSHIP_RATE_LIMIT, schema: { params: communityParams, querystring: noQuery, body: requestBody, response: { 200: requestResponse, 201: requestResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const message = request.body?.message ?? null;
      const result = await runCommunity(guard, request, reply, member, async (client) => {
        const asked = await client.query<{ outcome: string; request_id: string | null; retry_after: Date | string | null }>(
          "SELECT outcome, request_id, retry_after FROM spark.ws_request_community_membership($1, $2)",
          [request.params.communityId, message],
        );
        const row = asked.rows[0];
        if (row?.outcome === "request_cooldown") return { cooldown: row.retry_after };
        const mapped = mapOutcome(requestOutcomes, row?.outcome, "requested", "already_pending");
        if (mapped) return { mapped };
        if (!row?.request_id) throw new Error("Join request outcome without a request id");
        return { created: row.outcome === "requested", joinRequest: await readOwnRequest(client, row.request_id) };
      });
      if (reply.sent || !result) return reply;
      if ("cooldown" in result) {
        if (!result.cooldown) throw new Error("Cooldown outcome without retry_after");
        return reply.code(409).type("application/problem+json").send({
          type: "about:blank",
          title: "Conflict",
          status: 409,
          code: "request_cooldown",
          detail: "Your last request was declined recently; you can request again later.",
          instance: request.url,
          requestId: request.id,
          retryAfter: iso(result.cooldown),
        });
      }
      if ("mapped" in result) return problem(request, reply, ...result.mapped);
      if (result.created) reply.code(201).header("Location", `/api/v1/community-requests/${result.joinRequest.id}`);
      return reply.send({ request: result.joinRequest });
    },
  );

  app.get(
    "/api/v1/me/community-requests",
    { schema: { querystring: noQuery, response: { 200: myRequestsResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const rows = await runCommunity(guard, request, reply, member, async (client) =>
        (await client.query<MyRequestRow>(
          "SELECT id, community_slug, community_name, status, message, created_at, reviewed_at FROM spark.ws_list_my_community_requests()",
        )).rows);
      if (reply.sent || !rows) return reply;
      return {
        items: rows.map((row) => ({
          id: row.id,
          community: { slug: row.community_slug, name: row.community_name },
          status: row.status,
          message: row.message,
          createdAt: iso(row.created_at),
          reviewedAt: isoOrNull(row.reviewed_at),
        })),
      };
    },
  );

  app.delete<{ Params: { requestId: string } }>(
    "/api/v1/community-requests/:requestId",
    { config: MEMBERSHIP_RATE_LIMIT, schema: { params: requestParams, querystring: noQuery } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const outcome = await runCommunity(guard, request, reply, member, async (client) =>
        (await client.query<{ outcome: string }>("SELECT spark.ws_withdraw_community_request($1) AS outcome", [request.params.requestId])).rows[0]?.outcome);
      if (reply.sent) return reply;
      const mapped = mapOutcome(withdrawOutcomes, outcome, "ok");
      if (mapped) return problem(request, reply, ...mapped);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { requestId: string }; Body: { decision: "approve" | "reject" } }>(
    "/api/v1/community-requests/:requestId/decision",
    { config: MUTATION_RATE_LIMIT, schema: { params: requestParams, querystring: noQuery, body: decisionBody, response: { 200: decisionResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const outcome = await runCommunity(guard, request, reply, member, async (client) =>
        (await client.query<{ outcome: string }>(
          "SELECT outcome FROM spark.ws_decide_community_request($1, $2)",
          [request.params.requestId, request.body.decision],
        )).rows[0]?.outcome);
      if (reply.sent) return reply;
      const mapped = mapOutcome(decisionOutcomes, outcome, "approved", "rejected");
      if (mapped) return problem(request, reply, ...mapped);
      return { status: outcome };
    },
  );
}
