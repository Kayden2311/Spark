import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { formatEtag, parseIfMatch } from "../../modules/work/domain/etag.js";
import { requestHash } from "../../modules/work/domain/idempotency.js";
import { decodeCursor, toPage } from "../pagination.js";
import { problem } from "../responses.js";
import { MUTATION_RATE_LIMIT } from "../session-guard.js";
import { preconditionFailed, preconditionRequired, type MemberGuard } from "../workspace/guard.js";
import { communityNotFound, communityParams, mapOutcome, noQuery, type Mapped } from "./access.js";
import {
  NO_NUL,
  PAGE_LIMIT,
  POST_CREATE_RATE_LIMIT,
  communityFrozen,
  contentHidden,
  invalidIfMatch,
  keyReused,
  notAMember,
  notAuthor,
  pageOf,
  pageQuery,
  postDetailResponse,
  postNotFound,
  postParams,
  postSummaryResponse,
  readContent,
  readKey,
  readPostRow,
  runWrite,
  standingFromDetail,
  toPostDetail,
  toPostSummary,
  type FeedRow,
} from "./content.js";
import { cacheControl, readCommunityDetail, resolveViewer } from "./discovery.js";

const FEED_SQL = `SELECT id, community_id, author_id, author_name, author_avatar_url, title, excerpt, truncated, created_at, edited_at, comment_count,
  moderation_status, version, viewer_is_author, viewer_reported, created_at::text AS cursor_ts
  FROM spark.community_feed($1::uuid, $2::timestamptz, $3::uuid, $4::integer)`;

const TITLE = { type: "string", minLength: 1, maxLength: 150, pattern: NO_NUL } as const;
const BODY = { type: "string", minLength: 1, maxLength: 10000, pattern: NO_NUL } as const;

// Lengths are upper bounds; trimming and blank checks are the database's (22023 -> invalid_input).
const createBody = {
  type: "object",
  required: ["title", "body"],
  propertyNames: { enum: ["title", "body"] },
  properties: { title: TITLE, body: BODY },
  additionalProperties: false,
} as const;

const patchBody = {
  type: "object",
  minProperties: 1,
  propertyNames: { enum: ["title", "body"] },
  properties: { title: TITLE, body: BODY },
  additionalProperties: false,
} as const;

const createOutcomes: Record<string, Mapped> = {
  not_found: communityNotFound,
  not_a_member: notAMember,
  community_frozen: communityFrozen,
  idempotency_conflict: keyReused,
};

const updateOutcomes: Record<string, Mapped> = {
  not_found: postNotFound,
  not_author: notAuthor,
  not_a_member: notAMember,
  community_frozen: communityFrozen,
  content_hidden: contentHidden,
};

const deleteOutcomes: Record<string, Mapped> = { not_found: postNotFound, not_author: notAuthor };

export function registerPostRoutes(app: FastifyInstance, pool: Pool, guard: MemberGuard): void {
  app.get<{ Params: { communityId: string }; Querystring: { cursor?: string; limit?: number } }>(
    "/api/v1/communities/:communityId/posts",
    { schema: { params: communityParams, querystring: pageQuery, response: { 200: pageOf(postSummaryResponse) } } },
    async (request, reply) => {
      const viewer = await resolveViewer(pool, request);
      reply.header("Cache-Control", cacheControl(viewer));
      const cursor = decodeCursor(request.query.cursor);
      if (cursor === "invalid") {
        return problem(request, reply, 400, "Bad Request", "invalid_cursor", "The cursor is not valid for this collection.");
      }
      const limit = request.query.limit ?? PAGE_LIMIT;
      const { communityId } = request.params;
      const result = await readContent(pool, request, reply, viewer, async (client) => {
        const rows = (await client.query<FeedRow>(FEED_SQL, [communityId, cursor?.createdAt ?? null, cursor?.id ?? null, limit])).rows;
        // The viewer's standing comes from the C1 detail, the same projection the community page shows.
        const detail = await readCommunityDetail(client, communityId);
        return detail ? { rows, detail } : null;
      });
      if (reply.sent) return reply;
      if (!result) return problem(request, reply, ...communityNotFound);
      const standing = standingFromDetail(viewer !== null, result.detail);
      const page = toPage(result.rows.map((row) => ({ ...row, cursorTs: row.cursor_ts })), limit);
      return { items: page.items.map((row) => toPostSummary(row, standing)), nextCursor: page.nextCursor };
    },
  );

  app.get<{ Params: { postId: string } }>(
    "/api/v1/posts/:postId",
    { schema: { params: postParams, querystring: noQuery, response: { 200: postDetailResponse } } },
    async (request, reply) => {
      const viewer = await resolveViewer(pool, request);
      reply.header("Cache-Control", cacheControl(viewer));
      const row = await readContent(pool, request, reply, viewer, (client) => readPostRow(client, request.params.postId));
      if (reply.sent) return reply;
      if (!row) return problem(request, reply, ...postNotFound);
      return reply.header("ETag", formatEtag(row.version)).send(toPostDetail(row, viewer !== null));
    },
  );

  app.post<{ Params: { communityId: string }; Body: { title: string; body: string } }>(
    "/api/v1/communities/:communityId/posts",
    { config: POST_CREATE_RATE_LIMIT, schema: { params: communityParams, querystring: noQuery, body: createBody, response: { 201: postDetailResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const key = readKey(request, reply);
      if (key === undefined) return reply;
      const { body } = request;
      const hash = requestHash(body);
      const result = await runWrite(guard, request, reply, member, async (client) => {
        const created = await client.query<{ outcome: string; post_id: string | null }>(
          "SELECT outcome, post_id FROM spark.ws_create_post($1::uuid, $2, $3, $4, $5)",
          [request.params.communityId, body.title, body.body, key, hash],
        );
        const row = created.rows[0];
        const mapped = mapOutcome(createOutcomes, row?.outcome, "created", "replayed");
        if (mapped) return { mapped };
        if (!row?.post_id) throw new Error("Created post has no id");
        const found = await readPostRow(client, row.post_id);
        // A replayed key can point at a post that was deleted or hidden since; a fresh create must be readable.
        if (!found && row.outcome === "created") throw new Error("Created post is not readable");
        return { found, replayed: row.outcome === "replayed" };
      });
      if (reply.sent || !result) return reply;
      if (result.mapped) return problem(request, reply, ...result.mapped);
      if (!result.found) return problem(request, reply, ...postNotFound);
      if (result.replayed) reply.header("Idempotent-Replayed", "true");
      return reply
        .code(201)
        .header("Location", `/api/v1/posts/${result.found.id}`)
        .header("ETag", formatEtag(result.found.version))
        .send(toPostDetail(result.found, true));
    },
  );

  app.patch<{ Params: { postId: string }; Body: { title?: string; body?: string } }>(
    "/api/v1/posts/:postId",
    { config: MUTATION_RATE_LIMIT, schema: { params: postParams, querystring: noQuery, body: patchBody, response: { 200: postDetailResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const expected = parseIfMatch(request.headers["if-match"]);
      if (expected === null) return preconditionRequired(request, reply);
      if (expected === "invalid") return invalidIfMatch(request, reply);
      const { postId } = request.params;
      const result = await runWrite(guard, request, reply, member, async (client) => {
        const updated = await client.query<{ outcome: string }>(
          "SELECT outcome FROM spark.ws_update_post($1::uuid, $2::integer, $3, $4)",
          [postId, expected, request.body.title ?? null, request.body.body ?? null],
        );
        const outcome = updated.rows[0]?.outcome;
        const mapped = mapOutcome(updateOutcomes, outcome, "ok", "version_mismatch");
        if (mapped) return { mapped };
        const found = await readPostRow(client, postId);
        return found ? { found, stale: outcome === "version_mismatch" } : { mapped: postNotFound };
      });
      if (reply.sent || !result) return reply;
      if (result.mapped) return problem(request, reply, ...result.mapped);
      const current = toPostDetail(result.found, true);
      if (result.stale) return preconditionFailed(request, reply, current);
      return reply.header("ETag", formatEtag(result.found.version)).send(current);
    },
  );

  app.delete<{ Params: { postId: string } }>(
    "/api/v1/posts/:postId",
    { config: MUTATION_RATE_LIMIT, schema: { params: postParams, querystring: noQuery } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const outcome = await runWrite(guard, request, reply, member, async (client) =>
        (await client.query<{ outcome: string }>("SELECT spark.ws_delete_post($1::uuid) AS outcome", [request.params.postId])).rows[0]?.outcome);
      if (reply.sent) return reply;
      const mapped = mapOutcome(deleteOutcomes, outcome, "ok");
      if (mapped) return problem(request, reply, ...mapped);
      return reply.code(204).send();
    },
  );
}
