import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { STAGE_CODES, TOPIC_SLUGS } from "../../modules/communities/domain/catalog.js";
import { formatEtag, parseIfMatch } from "../../modules/work/domain/etag.js";
import { problem } from "../responses.js";
import { MUTATION_RATE_LIMIT } from "../session-guard.js";
import { preconditionFailed, preconditionRequired, type Member, type MemberGuard } from "../workspace/guard.js";
import {
  accessDenied,
  communityNotFound,
  communityParams,
  mapOutcome,
  noQuery,
  runCommunity,
  workspaceNotFound,
  type Mapped,
} from "./access.js";
import { CARD_COLUMNS, NO_NUL, cardResponse, detailResponse, readCommunityDetail, toCard, type CardRow, type CommunityDetail } from "./discovery.js";

const SLUG_PATTERN = "^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$";
// GET /communities/filters shadows a community with this slug, so it can never be created.
const RESERVED_SLUGS: ReadonlySet<string> = new Set(["filters"]);
const VISIBILITIES = ["public", "private", "hidden"] as const;
const ROLES = ["owner", "moderator", "member"] as const;
const REQUEST_STATUSES = ["pending", "approved", "rejected"] as const;
const PATCH_KEYS = ["name", "tagline", "description", "visibility", "countryCode", "city", "stage", "topics"] as const;

const CREATE_RATE_LIMIT = { rateLimit: { max: 10, timeWindow: 60 * 60 * 1000 } } as const;

// ---------- Schemas ----------

const uuid = { type: "string", format: "uuid" } as const;
const nullableString = { type: ["string", "null"] } as const;

const workspaceParams = {
  type: "object",
  required: ["workspaceId"],
  properties: { workspaceId: uuid },
  additionalProperties: false,
} as const;

const memberParams = {
  type: "object",
  required: ["communityId", "userId"],
  properties: { communityId: uuid, userId: uuid },
  additionalProperties: false,
} as const;

// Lengths are upper bounds; trimming and blank checks are the database's (22023 -> invalid_input).
// NO_NUL keeps a NUL byte (which Postgres text cannot hold) a 400 instead of a 500.
const fieldSchemas = {
  name: { type: "string", maxLength: 80, pattern: NO_NUL },
  tagline: { type: "string", maxLength: 90, pattern: NO_NUL },
  description: { type: "string", maxLength: 2000, pattern: NO_NUL },
  visibility: { type: "string", enum: VISIBILITIES },
  countryCode: { type: ["string", "null"], pattern: "^[A-Z]{2}$" },
  city: { type: ["string", "null"], maxLength: 80, pattern: NO_NUL },
  stage: { type: "string", enum: STAGE_CODES },
  topics: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { type: "string", enum: TOPIC_SLUGS } },
} as const;

// Fastify's validator strips unknown keys instead of failing; propertyNames makes them a 400.
const createBody = {
  type: "object",
  required: ["slug", "name", "tagline", "description", "visibility", "stage", "topics"],
  propertyNames: { enum: ["slug", ...PATCH_KEYS] },
  properties: { slug: { type: "string", pattern: SLUG_PATTERN }, ...fieldSchemas },
  additionalProperties: false,
} as const;

const patchBody = {
  type: "object",
  minProperties: 1,
  propertyNames: { enum: PATCH_KEYS },
  properties: fieldSchemas,
  additionalProperties: false,
} as const;

const addMemberBody = {
  type: "object",
  required: ["userId"],
  propertyNames: { enum: ["userId"] },
  properties: { userId: uuid },
  additionalProperties: false,
} as const;

const roleBody = {
  type: "object",
  required: ["role"],
  propertyNames: { enum: ["role"] },
  properties: { role: { type: "string", enum: ROLES } },
  additionalProperties: false,
} as const;

const requestsQuery = {
  type: "object",
  propertyNames: { enum: ["status"] },
  properties: { status: { type: "string", enum: REQUEST_STATUSES } },
  additionalProperties: false,
} as const;

const memberResponse = {
  type: "object",
  properties: { userId: { type: "string" }, displayName: { type: "string" }, avatarUrl: nullableString, role: { type: "string" }, joinedAt: { type: "string" } },
} as const;

const itemsOf = (items: object) => ({ type: "object", properties: { items: { type: "array", items } } }) as const;

const requestItemResponse = {
  type: "object",
  properties: {
    id: { type: "string" },
    requester: { type: "object", properties: { id: { type: "string" }, displayName: { type: "string" } } },
    message: nullableString,
    status: { type: "string" },
    createdAt: { type: "string" },
    reviewedAt: nullableString,
  },
} as const;

const candidateResponse = {
  type: "object",
  properties: { userId: { type: "string" }, displayName: { type: "string" }, avatarUrl: nullableString },
} as const;

interface CreateBody {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  visibility: string;
  countryCode?: string | null;
  city?: string | null;
  stage: string;
  topics: string[];
}

type PatchBody = Partial<Omit<CreateBody, "slug">>;

// ---------- Rows ----------

interface MemberRow { user_id: string; display_name: string; avatar_url: string | null; role: string; joined_at: Date | string }
interface RequestRow {
  id: string;
  user_id: string;
  display_name: string;
  message: string | null;
  status: string;
  created_at: Date | string;
  reviewed_at: Date | string | null;
}
interface CandidateRow { user_id: string; display_name: string; avatar_url: string | null }

const iso = (value: Date | string) => new Date(value).toISOString();

const toMember = (row: MemberRow) => ({
  userId: row.user_id,
  displayName: row.display_name,
  avatarUrl: row.avatar_url,
  role: row.role,
  joinedAt: iso(row.joined_at),
});

// Explicit columns everywhere: emails and reviewer ids never reach a response.
const LIST_MEMBERS = "SELECT user_id, display_name, avatar_url, role, joined_at FROM spark.ws_list_community_members($1)";

async function readMember(client: PoolClient, communityId: string, userId: string) {
  const list = await client.query<MemberRow>(LIST_MEMBERS, [communityId]);
  const row = list.rows.find((candidate) => candidate.user_id === userId);
  return row ? toMember(row) : null;
}

/**
 * Manager-only reads check the caller's standing first, so a non-manager's request never runs the list
 * query: a community the caller cannot see is 404, one they cannot manage 403.
 */
async function managerStanding(client: PoolClient, communityId: string): Promise<Mapped | null> {
  const found = await client.query<{ visible: boolean; can_manage: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM spark.communities c WHERE c.id = $1::uuid) AS visible, spark.can_manage_community($1::uuid) AS can_manage",
    [communityId],
  );
  const row = found.rows[0];
  if (!row?.visible) return communityNotFound;
  return row.can_manage ? null : accessDenied;
}

// ---------- Outcomes ----------

const insufficientRole = (detail: string): Mapped => [403, "Forbidden", "insufficient_role", detail];
const memberNotFound: Mapped = [404, "Not Found", "member_not_found", "Member not found in this community."];
const lastOwner: Mapped = [409, "Conflict", "last_owner", "A community must keep at least one active owner."];
const slugTaken: Mapped = [409, "Conflict", "slug_taken", "That community address is already taken."];

const createOutcomes: Record<string, Mapped> = {
  not_found: workspaceNotFound,
  forbidden: insufficientRole("Only a workspace owner or admin can create communities."),
  slug_taken: slugTaken,
  too_many_communities: [409, "Conflict", "too_many_communities", "This workspace already hosts the maximum number of communities."],
};

const updateOutcomes: Record<string, Mapped> = {
  not_found: communityNotFound,
  forbidden: insufficientRole("Only a community owner or a workspace owner or admin can change community settings."),
};

const addOutcomes: Record<string, Mapped> = {
  not_found: communityNotFound,
  forbidden: insufficientRole("Only community managers can add members."),
  already_member: [409, "Conflict", "already_member", "This person is already a member of the community."],
  not_in_workspace: [422, "Unprocessable Content", "not_in_workspace", "Only active members of the host workspace can be added."],
  community_frozen: [409, "Conflict", "community_frozen", "This community is frozen and does not take new members right now."],
};

const roleOutcomes: Record<string, Mapped> = {
  not_found: memberNotFound,
  forbidden: insufficientRole("Only a community owner or a workspace owner or admin can change roles."),
  last_owner: lastOwner,
};

const removeOutcomes: Record<string, Mapped> = {
  not_found: memberNotFound,
  forbidden: insufficientRole("Your role does not allow removing this member."),
  last_owner: lastOwner,
};

// ---------- Helpers ----------

async function detailOrThrow(client: PoolClient, communityId: string): Promise<CommunityDetail> {
  const detail = await readCommunityDetail(client, communityId);
  if (!detail) throw new Error("Community is not readable after a write");
  return detail;
}

function invalidIfMatch(request: FastifyRequest, reply: FastifyReply) {
  return problem(request, reply, 400, "Bad Request", "invalid_if_match", "If-Match must be a single strong entity tag such as \"v1\".");
}

// ---------- Routes ----------

export function registerManagementRoutes(app: FastifyInstance, guard: MemberGuard): void {
  const run = <T>(request: FastifyRequest, reply: FastifyReply, member: Member, work: (client: PoolClient) => Promise<T>) =>
    runCommunity(guard, request, reply, member, work);

  app.post<{ Params: { workspaceId: string }; Body: CreateBody }>(
    "/api/v1/workspaces/:workspaceId/communities",
    { config: CREATE_RATE_LIMIT, schema: { params: workspaceParams, querystring: noQuery, body: createBody, response: { 201: detailResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const { body } = request;
      if (RESERVED_SLUGS.has(body.slug)) return problem(request, reply, ...slugTaken);
      const result = await run(request, reply, member, async (client) => {
        const created = await client.query<{ outcome: string; community_id: string | null }>(
          "SELECT outcome, community_id FROM spark.ws_create_community($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
          [request.params.workspaceId, body.slug, body.name, body.tagline, body.description, body.visibility,
            body.countryCode ?? null, body.city ?? null, body.stage, body.topics],
        );
        const row = created.rows[0];
        const mapped = mapOutcome(createOutcomes, row?.outcome, "ok");
        if (mapped) return { mapped };
        if (!row?.community_id) throw new Error("Created community has no id");
        return { detail: await detailOrThrow(client, row.community_id) };
      });
      if (reply.sent || !result) return reply;
      if (result.mapped) return problem(request, reply, ...result.mapped);
      const { detail } = result;
      return reply
        .code(201)
        .header("Location", `/api/v1/communities/${encodeURIComponent(detail.slug)}`)
        .header("ETag", formatEtag(detail.version))
        .send(detail);
    },
  );

  app.get<{ Params: { workspaceId: string } }>(
    "/api/v1/workspaces/:workspaceId/communities",
    { schema: { params: workspaceParams, querystring: noQuery, response: { 200: itemsOf(cardResponse) } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const rows = await run(request, reply, member, async (client) =>
        (await client.query<CardRow>(`SELECT ${CARD_COLUMNS} FROM spark.ws_list_workspace_communities($1)`, [request.params.workspaceId])).rows);
      if (reply.sent || !rows) return reply;
      return { items: rows.map(toCard) };
    },
  );

  app.patch<{ Params: { communityId: string }; Body: PatchBody }>(
    "/api/v1/communities/:communityId",
    { config: MUTATION_RATE_LIMIT, schema: { params: communityParams, querystring: noQuery, body: patchBody, response: { 200: detailResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const expected = parseIfMatch(request.headers["if-match"]);
      if (expected === null) return preconditionRequired(request, reply);
      if (expected === "invalid") return invalidIfMatch(request, reply);
      const { communityId } = request.params;
      const result = await run(request, reply, member, async (client) => {
        const updated = await client.query<{ outcome: string; settings_version: number | null }>(
          "SELECT outcome, settings_version FROM spark.ws_update_community($1, $2, $3)",
          [communityId, expected, JSON.stringify(request.body)],
        );
        const outcome = updated.rows[0]?.outcome;
        const mapped = mapOutcome(updateOutcomes, outcome, "ok", "version_mismatch");
        if (mapped) return { mapped };
        return { detail: await detailOrThrow(client, communityId), stale: outcome === "version_mismatch" };
      });
      if (reply.sent || !result) return reply;
      if (result.mapped) return problem(request, reply, ...result.mapped);
      if (result.stale) return preconditionFailed(request, reply, result.detail);
      return reply.header("ETag", formatEtag(result.detail.version)).send(result.detail);
    },
  );

  app.get<{ Params: { communityId: string }; Querystring: { status?: string } }>(
    "/api/v1/communities/:communityId/requests",
    { schema: { params: communityParams, querystring: requestsQuery, response: { 200: itemsOf(requestItemResponse) } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const { communityId } = request.params;
      const result = await run(request, reply, member, async (client) => {
        const denied = await managerStanding(client, communityId);
        if (denied) return { mapped: denied };
        const list = await client.query<RequestRow>(
          "SELECT id, user_id, display_name, message, status, created_at, reviewed_at FROM spark.ws_list_community_requests($1, $2)",
          [communityId, request.query.status ?? null],
        );
        return { rows: list.rows };
      });
      if (reply.sent || !result) return reply;
      if (result.mapped) return problem(request, reply, ...result.mapped);
      return {
        items: result.rows.map((row) => ({
          id: row.id,
          requester: { id: row.user_id, displayName: row.display_name },
          message: row.message,
          status: row.status,
          createdAt: iso(row.created_at),
          reviewedAt: row.reviewed_at === null ? null : iso(row.reviewed_at),
        })),
      };
    },
  );

  app.get<{ Params: { communityId: string } }>(
    "/api/v1/communities/:communityId/member-candidates",
    { schema: { params: communityParams, querystring: noQuery, response: { 200: itemsOf(candidateResponse) } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const { communityId } = request.params;
      const result = await run(request, reply, member, async (client) => {
        const denied = await managerStanding(client, communityId);
        if (denied) return { mapped: denied };
        const list = await client.query<CandidateRow>(
          "SELECT user_id, display_name, avatar_url FROM spark.ws_list_community_member_candidates($1)",
          [communityId],
        );
        return { rows: list.rows };
      });
      if (reply.sent || !result) return reply;
      if (result.mapped) return problem(request, reply, ...result.mapped);
      return { items: result.rows.map((row) => ({ userId: row.user_id, displayName: row.display_name, avatarUrl: row.avatar_url })) };
    },
  );

  app.get<{ Params: { communityId: string } }>(
    "/api/v1/communities/:communityId/members",
    { schema: { params: communityParams, querystring: noQuery, response: { 200: itemsOf(memberResponse) } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const rows = await run(request, reply, member, async (client) =>
        (await client.query<MemberRow>(LIST_MEMBERS, [request.params.communityId])).rows);
      if (reply.sent || !rows) return reply;
      return { items: rows.map(toMember) };
    },
  );

  app.post<{ Params: { communityId: string }; Body: { userId: string } }>(
    "/api/v1/communities/:communityId/members",
    { config: MUTATION_RATE_LIMIT, schema: { params: communityParams, querystring: noQuery, body: addMemberBody, response: { 201: memberResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const { communityId } = request.params;
      const { userId } = request.body;
      const result = await run(request, reply, member, async (client) => {
        const added = await client.query<{ outcome: string }>("SELECT spark.ws_add_community_member($1, $2) AS outcome", [communityId, userId]);
        const mapped = mapOutcome(addOutcomes, added.rows[0]?.outcome, "ok");
        if (mapped) return { mapped };
        const added_member = await readMember(client, communityId, userId);
        if (!added_member) throw new Error("Added member is not readable");
        return { member: added_member };
      });
      if (reply.sent || !result) return reply;
      if (result.mapped) return problem(request, reply, ...result.mapped);
      return reply.code(201).header("Location", `/api/v1/communities/${communityId}/members/${userId}`).send(result.member);
    },
  );

  app.patch<{ Params: { communityId: string; userId: string }; Body: { role: string } }>(
    "/api/v1/communities/:communityId/members/:userId",
    { config: MUTATION_RATE_LIMIT, schema: { params: memberParams, querystring: noQuery, body: roleBody, response: { 200: memberResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const { communityId, userId } = request.params;
      const result = await run(request, reply, member, async (client) => {
        const changed = await client.query<{ outcome: string }>(
          "SELECT spark.ws_set_community_role($1, $2, $3) AS outcome",
          [communityId, userId, request.body.role],
        );
        const mapped = mapOutcome(roleOutcomes, changed.rows[0]?.outcome, "ok");
        if (mapped) return { mapped };
        const updated = await readMember(client, communityId, userId);
        return updated ? { member: updated } : { mapped: memberNotFound };
      });
      if (reply.sent || !result) return reply;
      if (result.mapped) return problem(request, reply, ...result.mapped);
      return result.member;
    },
  );

  app.delete<{ Params: { communityId: string; userId: string } }>(
    "/api/v1/communities/:communityId/members/:userId",
    { config: MUTATION_RATE_LIMIT, schema: { params: memberParams, querystring: noQuery } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const { communityId, userId } = request.params;
      // Removing yourself is leaving: members may always leave, managers remove others.
      const self = userId.toLowerCase() === member.userId.toLowerCase();
      const outcome = await run(request, reply, member, async (client) => {
        const removed = self
          ? await client.query<{ outcome: string }>("SELECT spark.ws_leave_community($1) AS outcome", [communityId])
          : await client.query<{ outcome: string }>("SELECT spark.ws_remove_community_member($1, $2) AS outcome", [communityId, userId]);
        return removed.rows[0]?.outcome;
      });
      if (reply.sent) return reply;
      const mapped = mapOutcome(removeOutcomes, outcome, "ok");
      if (mapped) return problem(request, reply, ...mapped);
      return reply.code(204).send();
    },
  );
}
