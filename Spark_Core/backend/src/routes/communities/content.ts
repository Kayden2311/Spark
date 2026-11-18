import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";

import { parseIdempotencyKey } from "../../modules/work/domain/idempotency.js";
import { problem } from "../responses.js";
import { type Member, type MemberGuard } from "../workspace/guard.js";
import type { Mapped } from "./access.js";
import { NO_NUL, readAs, type Viewer } from "./discovery.js";

// Shared by the post and comment routes: schemas, row shapes, viewer flags and error mapping.

export const PAGE_LIMIT = 20;
export { NO_NUL };

// Create limits are per member and shorter than the 60 s mutation window.
export const POST_CREATE_RATE_LIMIT = { rateLimit: { max: 10, timeWindow: 10 * 60 * 1000 } } as const;
export const COMMENT_CREATE_RATE_LIMIT = { rateLimit: { max: 30, timeWindow: 10 * 60 * 1000 } } as const;

const uuid = { type: "string", format: "uuid" } as const;
const nullableString = { type: ["string", "null"] } as const;

export const postParams = {
  type: "object",
  required: ["postId"],
  properties: { postId: uuid },
  additionalProperties: false,
} as const;

export const commentParams = {
  type: "object",
  required: ["commentId"],
  properties: { commentId: uuid },
  additionalProperties: false,
} as const;

// Fastify strips unknown keys instead of failing; propertyNames makes them a 400.
export const pageQuery = {
  type: "object",
  propertyNames: { enum: ["cursor", "limit"] },
  properties: {
    cursor: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 50, default: PAGE_LIMIT },
  },
  additionalProperties: false,
} as const;

const authorResponse = {
  type: "object",
  properties: { id: { type: "string" }, displayName: { type: "string" }, avatarUrl: nullableString },
} as const;

const viewerResponse = {
  type: "object",
  properties: {
    isAuthor: { type: "boolean" },
    reported: { type: "boolean" },
    canEdit: { type: "boolean" },
    canDelete: { type: "boolean" },
    canReport: { type: "boolean" },
    canModerate: { type: "boolean" },
  },
} as const;

const summaryProperties = {
  id: { type: "string" },
  communityId: { type: "string" },
  title: { type: "string" },
  author: authorResponse,
  createdAt: { type: "string" },
  editedAt: nullableString,
  commentCount: { type: "integer" },
  moderation: { type: "string" },
  version: { type: "integer" },
  viewer: viewerResponse,
} as const;

export const postSummaryResponse = {
  type: "object",
  properties: { ...summaryProperties, excerpt: { type: "string" }, truncated: { type: "boolean" } },
} as const;

export const postDetailResponse = {
  type: "object",
  properties: { ...summaryProperties, body: { type: "string" }, communitySlug: { type: "string" } },
} as const;

export const commentResponse = {
  type: "object",
  properties: {
    id: { type: "string" },
    postId: { type: "string" },
    body: { type: "string" },
    author: authorResponse,
    createdAt: { type: "string" },
    editedAt: nullableString,
    moderation: { type: "string" },
    version: { type: "integer" },
    viewer: viewerResponse,
  },
} as const;

export const pageOf = (item: object) => ({
  type: "object",
  properties: { items: { type: "array", items: item }, nextCursor: nullableString },
}) as const;

// ---------- Rows and mappers ----------

interface AuthorColumns { author_id: string; author_name: string; author_avatar_url: string | null }
interface FlagColumns { moderation_status: string; viewer_is_author: boolean; viewer_reported: boolean }

export interface FeedRow extends AuthorColumns, FlagColumns {
  id: string;
  community_id: string;
  title: string;
  excerpt: string;
  truncated: boolean;
  created_at: Date | string;
  cursor_ts: string;
  edited_at: Date | string | null;
  comment_count: string | number;
  version: number;
}

export interface PostRow extends AuthorColumns, FlagColumns {
  id: string;
  community_id: string;
  community_slug: string;
  title: string;
  body: string;
  created_at: Date | string;
  edited_at: Date | string | null;
  comment_count: string | number;
  version: number;
  viewer_is_member: boolean;
  viewer_can_moderate: boolean;
  community_frozen: boolean;
}

export interface CommentRow extends AuthorColumns, FlagColumns {
  id: string;
  post_id: string;
  body: string;
  created_at: Date | string;
  cursor_ts?: string;
  edited_at: Date | string | null;
  version: number;
}

/** What the viewer's standing in the community adds to the per-row flags. */
export interface Standing {
  signedIn: boolean;
  member: boolean;
  moderator: boolean;
  frozen: boolean;
}

const iso = (value: Date | string) => new Date(value).toISOString();

// Author ids are part of the public shape on purpose, signed-out readers included.
const toAuthor = (row: AuthorColumns) => ({ id: row.author_id, displayName: row.author_name, avatarUrl: row.author_avatar_url });

function viewerFlags(row: FlagColumns, standing: Standing, parentVisible = true) {
  const isAuthor = row.viewer_is_author;
  return {
    isAuthor,
    reported: row.viewer_reported,
    canEdit: isAuthor && standing.member && !standing.frozen && row.moderation_status === "visible" && parentVisible,
    canDelete: isAuthor,
    canReport: standing.signedIn && !isAuthor && !row.viewer_reported,
    canModerate: standing.moderator,
  };
}

const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["owner", "moderator", "member"]);

/** Standing from the C1 community detail's viewerStatus and frozen flag (used by the feed). */
export function standingFromDetail(signedIn: boolean, detail: { viewerStatus: string | null; frozen: boolean }): Standing {
  return {
    signedIn,
    member: detail.viewerStatus !== null && ACTIVE_STATUSES.has(detail.viewerStatus),
    moderator: detail.viewerStatus === "owner" || detail.viewerStatus === "moderator",
    frozen: detail.frozen,
  };
}

/** Standing from a community_post row (post and comment reads). */
export const standingFromPost = (signedIn: boolean, row: PostRow): Standing => ({
  signedIn,
  member: row.viewer_is_member,
  moderator: row.viewer_can_moderate,
  frozen: row.community_frozen,
});

function summaryOf(row: FeedRow | PostRow, standing: Standing) {
  return {
    id: row.id,
    communityId: row.community_id,
    title: row.title,
    author: toAuthor(row),
    createdAt: iso(row.created_at),
    editedAt: row.edited_at === null ? null : iso(row.edited_at),
    commentCount: Number(row.comment_count),
    moderation: row.moderation_status,
    version: row.version,
    viewer: viewerFlags(row, standing),
  };
}

export const toPostSummary = (row: FeedRow, standing: Standing) => ({ ...summaryOf(row, standing), excerpt: row.excerpt, truncated: row.truncated });

export const toPostDetail = (row: PostRow, signedIn: boolean) => ({
  ...summaryOf(row, standingFromPost(signedIn, row)),
  body: row.body,
  communitySlug: row.community_slug,
});

export const toComment = (row: CommentRow, post: PostRow, signedIn: boolean) => ({
  id: row.id,
  postId: row.post_id,
  body: row.body,
  author: toAuthor(row),
  createdAt: iso(row.created_at),
  editedAt: row.edited_at === null ? null : iso(row.edited_at),
  moderation: row.moderation_status,
  version: row.version,
  viewer: viewerFlags(row, standingFromPost(signedIn, post), post.moderation_status === "visible"),
});

export type PostDetail = ReturnType<typeof toPostDetail>;
export type CommentView = ReturnType<typeof toComment>;

// Explicit columns: nothing else can reach a response.
const POST_COLUMNS = `id, community_id, community_slug, author_id, author_name, author_avatar_url, title, body, created_at, edited_at, comment_count,
  moderation_status, version, viewer_is_author, viewer_reported, viewer_is_member, viewer_can_moderate, community_frozen`;
export const COMMENT_COLUMNS = "id, post_id, author_id, author_name, author_avatar_url, body, created_at, edited_at, moderation_status, version, viewer_is_author, viewer_reported";

/** The post as the session sees it (anonymous without one), or null when it is not readable. */
export async function readPostRow(client: PoolClient, postId: string): Promise<PostRow | null> {
  const found = await client.query<PostRow>(`SELECT ${POST_COLUMNS} FROM spark.community_post($1::uuid)`, [postId]);
  return found.rows[0] ?? null;
}

/** A comment with its post's row (for the viewer flags), or null when either is not readable. */
export async function readCommentWithPost(client: PoolClient, commentId: string): Promise<{ row: CommentRow; post: PostRow } | null> {
  const found = await client.query<CommentRow & { post_id: string }>(`SELECT ${COMMENT_COLUMNS} FROM spark.community_comment($1::uuid)`, [commentId]);
  const row = found.rows[0];
  if (!row) return null;
  const post = await readPostRow(client, row.post_id);
  return post ? { row, post } : null;
}

// ---------- Errors ----------

export const postNotFound: Mapped = [404, "Not Found", "post_not_found", "Post not found."];
export const commentNotFound: Mapped = [404, "Not Found", "comment_not_found", "Comment not found."];
export const notAuthor: Mapped = [403, "Forbidden", "not_author", "Only the author can do this."];
export const notAMember: Mapped = [403, "Forbidden", "not_a_member", "Only active members of the community can do this."];
export const communityFrozen: Mapped = [409, "Conflict", "community_frozen", "This community is frozen and does not take changes right now."];
export const contentHidden: Mapped = [409, "Conflict", "content_hidden", "Moderators hid this content; it cannot be changed."];
export const keyReused: Mapped = [409, "Conflict", "idempotency_key_reused", "This Idempotency-Key was already used for a different request."];

export function invalidIfMatch(request: FastifyRequest, reply: FastifyReply) {
  return problem(request, reply, 400, "Bad Request", "invalid_if_match", "If-Match must be a single strong entity tag such as \"v1\".");
}

function isRetryable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "40001" || error.code === "40P01");
}

function isNamedError(error: unknown, code: string, message: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code && "message" in error && error.message === message;
}

/**
 * guard.run for the content writes: a serialization failure or deadlock (the content functions take row
 * locks in a fixed order, but a clash with membership changes can still be picked as the victim) is
 * answered 503 retry_later so the client can resend the same request.
 */
export async function runWrite<T>(
  guard: MemberGuard,
  request: FastifyRequest,
  reply: FastifyReply,
  member: Member,
  work: (client: PoolClient) => Promise<T>,
): Promise<T | undefined> {
  try {
    return await guard.run(request, reply, member, work);
  } catch (error) {
    if (!isRetryable(error)) throw error;
    reply.header("Retry-After", "1");
    void problem(request, reply, 503, "Service Unavailable", "retry_later", "The request collided with another change. Try again.");
    return undefined;
  }
}

/**
 * discovery's readAs plus the content read errors: P0002 'Community not found' / 'Post not found' answer
 * 404 and 42501 'Community members only' answers 401 without a session and 403 with one. Returns
 * undefined once a response was sent.
 */
export async function readContent<T>(
  pool: Pool,
  request: FastifyRequest,
  reply: FastifyReply,
  viewer: Viewer,
  work: (client: PoolClient) => Promise<T>,
): Promise<T | undefined> {
  try {
    return await readAs(pool, request, reply, viewer, work);
  } catch (error) {
    if (isNamedError(error, "P0002", "Community not found")) {
      void problem(request, reply, 404, "Not Found", "community_not_found", "Community not found.");
    } else if (isNamedError(error, "P0002", "Post not found")) {
      void problem(request, reply, ...postNotFound);
    } else if (isNamedError(error, "42501", "Community members only")) {
      if (viewer) void problem(request, reply, 403, "Forbidden", "members_only", "This community is for members only.");
      else void problem(request, reply, 401, "Unauthorized", "unauthenticated", "Sign in to read this community.");
    } else {
      throw error;
    }
    return undefined;
  }
}

/** Reads the optional Idempotency-Key; sends 400 and returns undefined when it is malformed. */
export function readKey(request: FastifyRequest, reply: FastifyReply): string | null | undefined {
  const header = request.headers["idempotency-key"];
  const key = parseIdempotencyKey(Array.isArray(header) ? header.join(",") : header);
  if (key === "invalid") {
    void problem(request, reply, 400, "Bad Request", "invalid_input", "Invalid idempotency key.");
    return undefined;
  }
  return key;
}
