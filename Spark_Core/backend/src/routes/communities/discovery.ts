import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";

import { loadSessionPrincipal, readSessionTokenHash, withSessionContext } from "../../infrastructure/database/session.js";
import { STAGE_CODES, TOPIC_SLUGS, stageLabel, topicName } from "../../modules/communities/domain/catalog.js";
import { formatEtag } from "../../modules/work/domain/etag.js";
import { problem } from "../responses.js";
import { databaseDenial, invalidInputDetail, isInvalidParameter } from "../session-guard.js";

// Discovery is public: a valid session only changes what the database lets the caller see (private/hidden
// communities, viewerStatus, canManage). A missing, invalid or expired cookie is treated as anonymous.

const DEFAULT_LIMIT = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const KNOWN_INPUT_ERRORS: ReadonlySet<string> = new Set([
  "Invalid community search",
  "Invalid community cursor",
  "Invalid community limit",
  "Invalid community topics",
  "Invalid community stage",
  "Invalid community location",
]);

const nullableString = { type: ["string", "null"] } as const;

// Postgres text cannot hold NUL; refusing it in the schema keeps it from becoming a 500.
export const NO_NUL = "^[^\u0000]*$";

const cardProperties = {
  id: { type: "string" },
  slug: { type: "string" },
  name: { type: "string" },
  tagline: { type: "string" },
  visibility: { type: "string" },
  location: { type: "object", properties: { countryCode: nullableString, city: nullableString } },
  stage: { type: "object", properties: { code: { type: "string" }, label: { type: "string" } } },
  topics: { type: "array", items: { type: "object", properties: { slug: { type: "string" }, name: { type: "string" } } } },
  memberCount: { type: "integer" },
  weeklyPosts: { type: "integer" },
  featured: { type: "boolean" },
  frozen: { type: "boolean" },
  host: { type: "object", properties: { name: { type: "string" } } },
  viewerStatus: nullableString,
} as const;

export const cardResponse = { type: "object", properties: cardProperties } as const;

const listResponse = {
  type: "object",
  properties: { items: { type: "array", items: cardResponse }, nextCursor: nullableString },
} as const;

const myResponse = { type: "object", properties: { items: { type: "array", items: cardResponse } } } as const;

export const detailResponse = {
  type: "object",
  properties: {
    ...cardProperties,
    description: { type: "string" },
    createdAt: { type: "string" },
    canManage: { type: "boolean" },
    canGovern: { type: "boolean" },
    version: { type: "integer" },
  },
} as const;

const filterOption = {
  type: "array",
  items: { type: "object", properties: { value: { type: "string" }, label: { type: "string" }, count: { type: "integer" } } },
} as const;

const filtersResponse = {
  type: "object",
  properties: { topics: filterOption, stages: filterOption, countries: filterOption },
} as const;

// Fastify's validator strips unknown keys instead of failing; propertyNames makes them a 400.
const listQuery = {
  type: "object",
  propertyNames: { enum: ["q", "topic", "country", "stage", "cursor", "limit"] },
  properties: {
    q: { type: "string", maxLength: 100, pattern: NO_NUL },
    topic: { type: "string", enum: TOPIC_SLUGS },
    country: { type: "string", pattern: "^[A-Z]{2}$" },
    stage: { type: "string", enum: STAGE_CODES },
    // No maxLength: an over-long cursor is answered as invalid_cursor by the decoder.
    cursor: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 50, default: DEFAULT_LIMIT },
  },
  additionalProperties: false,
} as const;

const noQuery = { type: "object", properties: {}, additionalProperties: false, maxProperties: 0 } as const;

const slugParams = {
  type: "object",
  required: ["slug"],
  properties: { slug: { type: "string", minLength: 1, maxLength: 60, pattern: NO_NUL } },
  additionalProperties: false,
} as const;

export interface CardRow {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  visibility: string;
  country_code: string | null;
  city: string | null;
  stage: string;
  topics: string[];
  member_count: string | number;
  weekly_posts: string | number;
  featured: boolean;
  frozen: boolean;
  host_workspace_name: string;
  viewer_status: string | null;
}

interface ListRow extends CardRow {
  cursor_name: string;
}

interface DetailRow extends CardRow {
  description: string;
  created_at: Date | string;
  settings_version: number;
  can_manage: boolean;
  /** The actor is an active owner or admin of the host workspace (false without a session). */
  host_admin: boolean;
}

interface FilterRow {
  kind: string;
  value: string;
  label: string;
  count: string | number;
}

// Explicit columns: nothing else (reviewer ids, emails) can reach a response.
export const CARD_COLUMNS = "id, slug, name, tagline, visibility, country_code, city, stage, topics, member_count, weekly_posts, featured, frozen, host_workspace_name, viewer_status";

export function toCard(row: CardRow) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    visibility: row.visibility,
    location: { countryCode: row.country_code, city: row.city },
    stage: { code: row.stage, label: stageLabel(row.stage) },
    topics: row.topics.map((slug) => ({ slug, name: topicName(slug) })),
    memberCount: Number(row.member_count),
    weeklyPosts: Number(row.weekly_posts),
    featured: row.featured,
    frozen: row.frozen,
    host: { name: row.host_workspace_name },
    viewerStatus: row.viewer_status,
  };
}

export type CommunityDetail = ReturnType<typeof toDetail>;

function toDetail(row: DetailRow) {
  return {
    ...toCard(row),
    description: row.description,
    createdAt: new Date(row.created_at).toISOString(),
    canManage: row.can_manage,
    // Changes roles and settings: an active community owner or a host workspace owner/admin, whatever their
    // community role (the "administrator" standing of 0031). A moderator who is a host admin governs too.
    canGovern: row.can_manage && (row.viewer_status === "owner" || row.host_admin === true),
    version: row.settings_version,
  };
}

const DETAIL_COLUMNS = `${CARD_COLUMNS}, description, created_at, settings_version, can_manage`;

// is_workspace_member is session-bound (0014) and granted to spark_app; without a session it is false. The
// community row is readable here because the detail itself is (same RLS visibility).
const HOST_ADMIN = "coalesce((SELECT spark.is_workspace_member(c.tenant_id, ARRAY['owner','admin']) FROM spark.communities c WHERE c.id = d.id), false) AS host_admin";

/** The detail projection over community_by_slug(<slug expression>). */
function detailQuery(slugExpression: string): string {
  return `SELECT ${DETAIL_COLUMNS}, ${HOST_ADMIN} FROM spark.community_by_slug(${slugExpression}) d`;
}

/** GET /communities/{slug}'s query; exported so the database tests run the same SQL. */
export const DETAIL_BY_SLUG_SQL = detailQuery("$1::text");

/**
 * The community detail by id as the session sees it (same projection as GET /communities/{slug}), or
 * null when it is not visible. Runs inside the caller's session-bound transaction.
 */
export async function readCommunityDetail(client: PoolClient, communityId: string): Promise<CommunityDetail | null> {
  const found = await client.query<DetailRow>(
    detailQuery("(SELECT c.slug FROM spark.communities c WHERE c.id = $1::uuid)"),
    [communityId],
  );
  const row = found.rows[0];
  return row ? toDetail(row) : null;
}

// Discovery cursors carry the last row's (lower(name), id): an opaque keyset for ORDER BY lower(name), id.
function encodeNameCursor(name: string, id: string): string {
  return Buffer.from(JSON.stringify({ t: name, id }), "utf8").toString("base64url");
}

// Names are at most 80 code points; lower() can lengthen a few (e.g. U+0130), so the cursor allows twice that.
// The worst real name (80 control characters JSON-escaped to 6 bytes each) encodes to about 710 base64url chars.
const MAX_CURSOR_NAME_CODE_POINTS = 160;
const MAX_CURSOR_LENGTH = 1024;

function decodeNameCursor(value: string | undefined): { name: string; id: string } | null | "invalid" {
  if (value === undefined || value === "") return null;
  if (value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(value)) return "invalid";
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return "invalid";
    const { t, id } = parsed as Record<string, unknown>;
    if (typeof t !== "string" || t.length === 0 || [...t].length > MAX_CURSOR_NAME_CODE_POINTS || t.includes("\u0000")) return "invalid";
    if (typeof id !== "string" || !UUID.test(id)) return "invalid";
    return { name: t, id };
  } catch {
    return "invalid";
  }
}

async function plainTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { discard = true; }
    throw error;
  } finally {
    client.release(discard);
  }
}

export type Viewer = { tokenHash: Buffer } | null;

/** Resolves the caller: a live session, or null (anonymous) for no cookie or an invalid/expired one. */
export async function resolveViewer(pool: Pool, request: FastifyRequest): Promise<Viewer> {
  const tokenHash = readSessionTokenHash(request.headers.cookie);
  if (!tokenHash) return null;
  const principal = await loadSessionPrincipal(pool, tokenHash);
  return principal ? { tokenHash } : null;
}

// Runs the read as the viewer when there is one, anonymously otherwise. Returns undefined after answering an error.
export async function readAs<T>(
  pool: Pool,
  request: FastifyRequest,
  reply: FastifyReply,
  viewer: Viewer,
  work: (client: PoolClient) => Promise<T>,
): Promise<T | undefined> {
  const timed = async (client: PoolClient) => {
    await client.query("SET LOCAL statement_timeout = '5s'");
    return work(client);
  };
  try {
    return viewer ? await withSessionContext(pool, viewer.tokenHash, timed) : await plainTransaction(pool, timed);
  } catch (error) {
    if (databaseDenial(error) === "no_session") {
      void problem(request, reply, 401, "Unauthorized", "session_expired", "Session expired or invalid.");
      return undefined;
    }
    if (isInvalidParameter(error)) {
      void problem(request, reply, 400, "Bad Request", "invalid_input", invalidInputDetail(error, KNOWN_INPUT_ERRORS));
      return undefined;
    }
    throw error;
  }
}

// Responses vary by cookie, so they are never cached.
export const cacheControl = (viewer: Viewer) => (viewer ? "private, no-store" : "no-store");

const LIST_SQL = `SELECT ${CARD_COLUMNS}, lower(name) AS cursor_name
  FROM spark.discover_communities($1::text, $2::text, $3::text, $4::text, $5::text, $6::uuid, $7::integer)`;

export function registerDiscoveryRoutes(app: FastifyInstance, pool: Pool): void {
  app.get<{ Querystring: { q?: string; topic?: string; country?: string; stage?: string; cursor?: string; limit?: number } }>(
    "/api/v1/communities",
    { schema: { querystring: listQuery, response: { 200: listResponse } } },
    async (request, reply) => {
      const viewer = await resolveViewer(pool, request);
      reply.header("Cache-Control", cacheControl(viewer));
      const cursor = decodeNameCursor(request.query.cursor);
      if (cursor === "invalid") {
        return problem(request, reply, 400, "Bad Request", "invalid_cursor", "The cursor is not valid for this collection.");
      }
      const limit = request.query.limit ?? DEFAULT_LIMIT;
      const { q, topic, country, stage } = request.query;
      const rows = await readAs(pool, request, reply, viewer, async (client) =>
        (await client.query<ListRow>(LIST_SQL, [q ?? null, topic ?? null, country ?? null, stage ?? null, cursor?.name ?? null, cursor?.id ?? null, limit])).rows);
      if (!rows) return reply;
      // The database returns up to limit + 1 rows; the extra one only signals another page.
      const visible = rows.slice(0, limit);
      const last = visible[visible.length - 1];
      return {
        items: visible.map(toCard),
        nextCursor: rows.length > limit && last ? encodeNameCursor(last.cursor_name, last.id) : null,
      };
    },
  );

  app.get(
    "/api/v1/communities/filters",
    { schema: { querystring: noQuery, response: { 200: filtersResponse } } },
    async (request, reply) => {
      const viewer = await resolveViewer(pool, request);
      reply.header("Cache-Control", cacheControl(viewer));
      const rows = await readAs(pool, request, reply, viewer, async (client) =>
        (await client.query<FilterRow>("SELECT kind, value, label, count FROM spark.community_filter_values()")).rows);
      if (!rows) return reply;
      const options = (kind: string) =>
        rows.filter((row) => row.kind === kind).map((row) => ({ value: row.value, label: row.label, count: Number(row.count) }));
      return { topics: options("topic"), stages: options("stage"), countries: options("country") };
    },
  );

  app.get<{ Params: { slug: string } }>(
    "/api/v1/communities/:slug",
    { schema: { params: slugParams, querystring: noQuery, response: { 200: detailResponse } } },
    async (request, reply) => {
      const viewer = await resolveViewer(pool, request);
      reply.header("Cache-Control", cacheControl(viewer));
      const rows = await readAs(pool, request, reply, viewer, async (client) =>
        (await client.query<DetailRow>(
          DETAIL_BY_SLUG_SQL,
          [request.params.slug],
        )).rows);
      if (!rows) return reply;
      const row = rows[0];
      if (!row) return problem(request, reply, 404, "Not Found", "community_not_found", "Community not found.");
      const detail = toDetail(row);
      return reply.header("ETag", formatEtag(detail.version)).send(detail);
    },
  );

  app.get(
    "/api/v1/me/communities",
    { schema: { querystring: noQuery, response: { 200: myResponse } } },
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const tokenHash = readSessionTokenHash(request.headers.cookie);
      if (!tokenHash) return problem(request, reply, 401, "Unauthorized", "unauthenticated", "No active session.");
      const principal = await loadSessionPrincipal(pool, tokenHash);
      if (!principal) return problem(request, reply, 401, "Unauthorized", "session_expired", "Session expired or invalid.");
      const rows = await readAs(pool, request, reply, { tokenHash }, async (client) =>
        (await client.query<CardRow>(`SELECT ${CARD_COLUMNS} FROM spark.my_communities()`)).rows);
      if (!rows) return reply;
      return { items: rows.map(toCard) };
    },
  );
}
