import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { formatEtag, parseIfMatch } from "../../modules/work/domain/etag.js";
import { requestHash } from "../../modules/work/domain/idempotency.js";
import { decodeCursor, toPage } from "../pagination.js";
import { problem } from "../responses.js";
import { MUTATION_RATE_LIMIT } from "../session-guard.js";
import { preconditionFailed, preconditionRequired, type MemberGuard } from "../workspace/guard.js";
import { mapOutcome, noQuery, type Mapped } from "./access.js";
import {
  COMMENT_COLUMNS,
  COMMENT_CREATE_RATE_LIMIT,
  NO_NUL,
  PAGE_LIMIT,
  commentNotFound,
  commentParams,
  commentResponse,
  communityFrozen,
  contentHidden,
  invalidIfMatch,
  keyReused,
  notAMember,
  notAuthor,
  pageOf,
  pageQuery,
  postNotFound,
  postParams,
  readCommentWithPost,
  readContent,
  readKey,
  readPostRow,
  runWrite,
  toComment,
  type CommentRow,
} from "./content.js";
import { cacheControl, resolveViewer } from "./discovery.js";

const COMMENTS_SQL = `SELECT ${COMMENT_COLUMNS}, created_at::text AS cursor_ts
  FROM spark.community_post_comments($1::uuid, $2::timestamptz, $3::uuid, $4::integer)`;

const BODY = { type: "string", minLength: 1, maxLength: 2000, pattern: NO_NUL } as const;

// Lengths are upper bounds; trimming and blank checks are the database's (22023 -> invalid_input).
const commentBody = {
  type: "object",
  required: ["body"],
  propertyNames: { enum: ["body"] },
  properties: { body: BODY },
  additionalProperties: false,
} as const;

const createOutcomes: Record<string, Mapped> = {
  not_found: postNotFound,
  not_a_member: notAMember,
  community_frozen: communityFrozen,
  content_hidden: contentHidden,
  idempotency_conflict: keyReused,
};

const updateOutcomes: Record<string, Mapped> = {
  not_found: commentNotFound,
  not_author: notAuthor,
  not_a_member: notAMember,
  community_frozen: communityFrozen,
  content_hidden: contentHidden,
};

const deleteOutcomes: Record<string, Mapped> = { not_found: commentNotFound, not_author: notAuthor };

export function registerCommentRoutes(app: FastifyInstance, pool: Pool, guard: MemberGuard): void {
  app.get<{ Params: { postId: string }; Querystring: { cursor?: string; limit?: number } }>(
    "/api/v1/posts/:postId/comments",
    { schema: { params: postParams, querystring: pageQuery, response: { 200: pageOf(commentResponse) } } },
    async (request, reply) => {
      const viewer = await resolveViewer(pool, request);
      reply.header("Cache-Control", cacheControl(viewer));
      const cursor = decodeCursor(request.query.cursor);
      if (cursor === "invalid") {
        return problem(request, reply, 400, "Bad Request", "invalid_cursor", "The cursor is not valid for this collection.");
      }
      const limit = request.query.limit ?? PAGE_LIMIT;
      const { postId } = request.params;
      const result = await readContent(pool, request, reply, viewer, async (client) => {
        const rows = (await client.query<CommentRow>(COMMENTS_SQL, [postId, cursor?.createdAt ?? null, cursor?.id ?? null, limit])).rows;
        const post = await readPostRow(client, postId);
        return post ? { rows, post } : null;
      });
      if (reply.sent) return reply;
      if (!result) return problem(request, reply, ...postNotFound);
      const page = toPage(result.rows.map((row) => ({ ...row, cursorTs: row.cursor_ts ?? "" })), limit);
      return { items: page.items.map((row) => toComment(row, result.post, viewer !== null)), nextCursor: page.nextCursor };
    },
  );

  app.post<{ Params: { postId: string }; Body: { body: string } }>(
    "/api/v1/posts/:postId/comments",
    { config: COMMENT_CREATE_RATE_LIMIT, schema: { params: postParams, querystring: noQuery, body: commentBody, response: { 201: commentResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const key = readKey(request, reply);
      if (key === undefined) return reply;
      const { body } = request;
      const hash = requestHash(body);
      const result = await runWrite(guard, request, reply, member, async (client) => {
        const created = await client.query<{ outcome: string; comment_id: string | null }>(
          "SELECT outcome, comment_id FROM spark.ws_create_comment($1::uuid, $2, $3, $4)",
          [request.params.postId, body.body, key, hash],
        );
        const row = created.rows[0];
        const mapped = mapOutcome(createOutcomes, row?.outcome, "created", "replayed");
        if (mapped) return { mapped };
        if (!row?.comment_id) throw new Error("Created comment has no id");
        const found = await readCommentWithPost(client, row.comment_id);
        // A replayed key can point at a comment that was deleted or hidden since; a fresh create must be readable.
        if (!found && row.outcome === "created") throw new Error("Created comment is not readable");
        return { found, replayed: row.outcome === "replayed" };
      });
      if (reply.sent || !result) return reply;
      if (result.mapped) return problem(request, reply, ...result.mapped);
      if (!result.found) return problem(request, reply, ...commentNotFound);
      if (result.replayed) reply.header("Idempotent-Replayed", "true");
      const { row, post } = result.found;
      return reply
        .code(201)
        .header("Location", `/api/v1/comments/${row.id}`)
        .header("ETag", formatEtag(row.version))
        .send(toComment(row, post, true));
    },
  );

  app.patch<{ Params: { commentId: string }; Body: { body: string } }>(
    "/api/v1/comments/:commentId",
    { config: MUTATION_RATE_LIMIT, schema: { params: commentParams, querystring: noQuery, body: commentBody, response: { 200: commentResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const expected = parseIfMatch(request.headers["if-match"]);
      if (expected === null) return preconditionRequired(request, reply);
      if (expected === "invalid") return invalidIfMatch(request, reply);
      const { commentId } = request.params;
      const result = await runWrite(guard, request, reply, member, async (client) => {
        const updated = await client.query<{ outcome: string }>(
          "SELECT outcome FROM spark.ws_update_comment($1::uuid, $2::integer, $3)",
          [commentId, expected, request.body.body],
        );
        const outcome = updated.rows[0]?.outcome;
        const mapped = mapOutcome(updateOutcomes, outcome, "ok", "version_mismatch");
        if (mapped) return { mapped };
        const found = await readCommentWithPost(client, commentId);
        return found ? { found, stale: outcome === "version_mismatch" } : { mapped: commentNotFound };
      });
      if (reply.sent || !result) return reply;
      if (result.mapped) return problem(request, reply, ...result.mapped);
      const { row, post } = result.found;
      const current = toComment(row, post, true);
      if (result.stale) return preconditionFailed(request, reply, current);
      return reply.header("ETag", formatEtag(row.version)).send(current);
    },
  );

  app.delete<{ Params: { commentId: string } }>(
    "/api/v1/comments/:commentId",
    { config: MUTATION_RATE_LIMIT, schema: { params: commentParams, querystring: noQuery } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const outcome = await runWrite(guard, request, reply, member, async (client) =>
        (await client.query<{ outcome: string }>("SELECT spark.ws_delete_comment($1::uuid) AS outcome", [request.params.commentId])).rows[0]?.outcome);
      if (reply.sent) return reply;
      const mapped = mapOutcome(deleteOutcomes, outcome, "ok");
      if (mapped) return problem(request, reply, ...mapped);
      return reply.code(204).send();
    },
  );
}
