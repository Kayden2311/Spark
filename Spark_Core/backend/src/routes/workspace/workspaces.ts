import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import { formatEtag, parseIfMatch } from "../../modules/work/domain/etag.js";
import { problem } from "../responses.js";
import { MUTATION_RATE_LIMIT, expectOutcome } from "../session-guard.js";
import { preconditionFailed, preconditionRequired, type MemberGuard } from "./guard.js";

export const SLUG_PATTERN = "^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$";

const workspaceResponse = {
  type: "object",
  properties: {
    id: { type: "string" },
    slug: { type: "string" },
    name: { type: "string" },
    role: { type: "string", enum: ["owner", "admin", "member"] },
    memberCount: { type: "integer" },
    version: { type: "integer" },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  role: string;
  memberCount: number;
  version: number;
  createdAt: string;
}

interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  version: number;
  created_at: Date;
  role: string;
  member_count: string;
}

// Outcome -> [status, title, code, detail] for problem(); an outcome missing from the table must be "ok" or the route throws.
type OutcomeTable = Record<string, [number, string, string, string]>;

const createOutcomes: OutcomeTable = {
  slug_taken: [409, "Conflict", "slug_taken", "That workspace address is already in use."],
  too_many_workspaces: [409, "Conflict", "too_many_workspaces", "You already own the maximum number of workspaces."],
};

const updateOutcomes: OutcomeTable = {
  not_found: [404, "Not Found", "workspace_not_found", "Workspace does not exist."],
  forbidden: [403, "Forbidden", "insufficient_role", "Only an owner or admin can rename the workspace."],
};

const SELECT_WORKSPACE = `SELECT w.id, w.slug, w.name, w.version, w.created_at, m.role,
  (SELECT count(*) FROM spark.workspace_memberships c WHERE c.tenant_id = w.id AND c.status = 'active') AS member_count
  FROM spark.workspaces w
  JOIN spark.workspace_memberships m ON m.tenant_id = w.id AND m.user_id = $1 AND m.status = 'active'
  WHERE w.status = 'active' AND w.archived_at IS NULL`;

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    role: row.role,
    memberCount: Number(row.member_count),
    version: row.version,
    createdAt: row.created_at.toISOString(),
  };
}

/** The workspace as the actor sees it, or null when they are not an active member. */
export async function readWorkspace(client: PoolClient, userId: string, by: { id: string } | { slug: string }): Promise<Workspace | null> {
  const column = "id" in by ? "w.id" : "w.slug";
  const value = "id" in by ? by.id : by.slug;
  const result = await client.query<WorkspaceRow>(`${SELECT_WORKSPACE} AND ${column} = $2`, [userId, value]);
  const row = result.rows[0];
  return row ? toWorkspace(row) : null;
}

const workspaceIdParams = {
  type: "object",
  required: ["workspaceId"],
  properties: { workspaceId: { type: "string", format: "uuid" } },
  additionalProperties: false,
} as const;

export function registerWorkspaceCrudRoutes(app: FastifyInstance, guard: MemberGuard): void {
  app.post<{ Body: { name: string; slug: string } }>(
    "/api/v1/workspaces",
    {
      config: { rateLimit: { max: 5, timeWindow: 60 * 60 * 1000 } },
      schema: {
        body: {
          type: "object",
          required: ["name", "slug"],
          properties: { name: { type: "string", minLength: 1, maxLength: 80 }, slug: { type: "string", pattern: SLUG_PATTERN } },
          additionalProperties: false,
        },
        response: { 201: workspaceResponse },
      },
    },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const result = await guard.run(request, reply, member, async (client) => {
        const created = await client.query<{ outcome: string; workspace_id: string | null }>(
          "SELECT outcome, workspace_id FROM spark.ws_create_workspace($1, $2)",
          [request.body.name, request.body.slug],
        );
        const row = created.rows[0];
        const mapped = row ? createOutcomes[row.outcome] : undefined;
        if (mapped) return { mapped };
        expectOutcome(row?.outcome, "ok");
        const workspace = row?.workspace_id ? await readWorkspace(client, member.userId, { id: row.workspace_id }) : null;
        if (!workspace) throw new Error("Created workspace is not readable");
        return { workspace };
      });
      if (reply.sent || !result) return reply;
      if (result.mapped) return problem(request, reply, ...result.mapped);
      const { workspace } = result;
      return reply
        .code(201)
        .header("Location", `/api/v1/workspaces/${workspace.id}`)
        .header("ETag", formatEtag(workspace.version))
        .send(workspace);
    },
  );

  app.get(
    "/api/v1/workspaces",
    { schema: { response: { 200: { type: "object", properties: { items: { type: "array", items: workspaceResponse } } } } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const rows = await guard.run(request, reply, member, async (client) =>
        (await client.query<WorkspaceRow>(`${SELECT_WORKSPACE} ORDER BY m.joined_at, w.id`, [member.userId])).rows);
      if (reply.sent || !rows) return reply;
      return { items: rows.map(toWorkspace) };
    },
  );

  app.get<{ Params: { workspaceId: string } }>(
    "/api/v1/workspaces/:workspaceId",
    { schema: { params: workspaceIdParams, response: { 200: workspaceResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const workspace = await guard.run(request, reply, member, (client) => readWorkspace(client, member.userId, { id: request.params.workspaceId }));
      if (reply.sent) return reply;
      if (!workspace) return problem(request, reply, 404, "Not Found", "workspace_not_found", "Workspace does not exist.");
      return reply.header("ETag", formatEtag(workspace.version)).send(workspace);
    },
  );

  app.get<{ Params: { slug: string } }>(
    "/api/v1/workspaces/by-slug/:slug",
    {
      schema: {
        params: { type: "object", required: ["slug"], properties: { slug: { type: "string", pattern: SLUG_PATTERN } }, additionalProperties: false },
        response: { 200: workspaceResponse },
      },
    },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const workspace = await guard.run(request, reply, member, (client) => readWorkspace(client, member.userId, { slug: request.params.slug }));
      if (reply.sent) return reply;
      if (!workspace) return problem(request, reply, 404, "Not Found", "workspace_not_found", "Workspace does not exist.");
      return reply.header("ETag", formatEtag(workspace.version)).send(workspace);
    },
  );

  app.patch<{ Params: { workspaceId: string }; Body: { name: string } }>(
    "/api/v1/workspaces/:workspaceId",
    {
      config: MUTATION_RATE_LIMIT,
      schema: {
        params: workspaceIdParams,
        body: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1, maxLength: 80 } }, additionalProperties: false },
        response: { 200: workspaceResponse },
      },
    },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const expected = parseIfMatch(request.headers["if-match"]);
      if (expected === null) return preconditionRequired(request, reply);
      if (expected === "invalid") return problem(request, reply, 400, "Bad Request", "invalid_if_match", "If-Match must be a single strong entity tag such as \"v1\".");
      const { workspaceId } = request.params;

      const result = await guard.run(request, reply, member, async (client) => {
        const updated = await client.query<{ outcome: string }>(
          "SELECT outcome FROM spark.ws_update_workspace($1, $2, $3)",
          [workspaceId, expected, request.body.name],
        );
        const outcome = updated.rows[0]?.outcome;
        const mapped = outcome ? updateOutcomes[outcome] : undefined;
        if (mapped) return { mapped };
        expectOutcome(outcome, "ok", "version_mismatch");
        const workspace = await readWorkspace(client, member.userId, { id: workspaceId });
        if (!workspace) throw new Error("Updated workspace is not readable");
        return { workspace, stale: outcome === "version_mismatch" };
      });
      if (reply.sent || !result) return reply;
      if (result.mapped) return problem(request, reply, ...result.mapped);
      if (result.stale) return preconditionFailed(request, reply, result.workspace);
      return reply.header("ETag", formatEtag(result.workspace.version)).send(result.workspace);
    },
  );
}
