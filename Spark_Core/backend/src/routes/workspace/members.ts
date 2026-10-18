import type { FastifyInstance } from "fastify";

import { problem } from "../responses.js";
import { MUTATION_RATE_LIMIT, expectOutcome } from "../session-guard.js";
import type { MemberGuard } from "./guard.js";
import { readWorkspace } from "./workspaces.js";

const ROLES = ["owner", "admin", "member"] as const;
type Role = (typeof ROLES)[number];

const memberResponse = {
  type: "object",
  properties: {
    userId: { type: "string" },
    displayName: { type: "string" },
    avatarUrl: { type: ["string", "null"] },
    email: { type: ["string", "null"] },
    role: { type: "string", enum: ROLES },
    joinedAt: { type: "string", format: "date-time" },
  },
} as const;

const workspaceParams = {
  type: "object",
  required: ["workspaceId"],
  properties: { workspaceId: { type: "string", format: "uuid" } },
  additionalProperties: false,
} as const;

const memberParams = {
  type: "object",
  required: ["workspaceId", "userId"],
  properties: { workspaceId: { type: "string", format: "uuid" }, userId: { type: "string", format: "uuid" } },
  additionalProperties: false,
} as const;

interface MemberRow {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  email: string | null;
  role: string;
  joined_at: Date;
}

function toMember(row: MemberRow) {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    email: row.email,
    role: row.role,
    joinedAt: row.joined_at.toISOString(),
  };
}

const LIST_MEMBERS = "SELECT user_id, display_name, avatar_url, email, role, joined_at FROM spark.ws_list_members($1)";

type Mapped = [number, string, string, string];

// Outcome -> [status, title, code, detail]. "not_found" is resolved separately: workspace vs member.
const memberOutcomes: Record<string, Mapped> = {
  forbidden: [403, "Forbidden", "insufficient_role", "Your role does not allow this change."],
  last_owner: [409, "Conflict", "last_owner", "A workspace must keep at least one active owner."],
};

const workspaceNotFound: Mapped = [404, "Not Found", "workspace_not_found", "Workspace does not exist."];
const memberNotFound: Mapped = [404, "Not Found", "member_not_found", "Member does not exist in this workspace."];

export function registerMemberRoutes(app: FastifyInstance, guard: MemberGuard): void {
  app.get<{ Params: { workspaceId: string } }>(
    "/api/v1/workspaces/:workspaceId/members",
    {
      schema: {
        params: workspaceParams,
        response: { 200: { type: "object", properties: { items: { type: "array", items: memberResponse } } } },
      },
    },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const rows = await guard.run(request, reply, member, async (client) => {
        const list = await client.query<MemberRow>(LIST_MEMBERS, [request.params.workspaceId]);
        // The function returns zero rows for non-members, so membership is checked explicitly.
        if (list.rows.length === 0 && !(await readWorkspace(client, member.userId, { id: request.params.workspaceId }))) return null;
        return list.rows;
      });
      if (reply.sent) return reply;
      if (!rows) return problem(request, reply, ...workspaceNotFound);
      return { items: rows.map(toMember) };
    },
  );

  app.patch<{ Params: { workspaceId: string; userId: string }; Body: { role: Role } }>(
    "/api/v1/workspaces/:workspaceId/members/:userId",
    {
      config: MUTATION_RATE_LIMIT,
      schema: {
        params: memberParams,
        body: { type: "object", required: ["role"], properties: { role: { type: "string", enum: ROLES } }, additionalProperties: false },
        response: { 200: memberResponse },
      },
    },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const { workspaceId, userId } = request.params;
      const result = await guard.run(request, reply, member, async (client) => {
        const changed = await client.query<{ outcome: string }>(
          "SELECT spark.ws_set_member_role($1, $2, $3) AS outcome",
          [workspaceId, userId, request.body.role],
        );
        const outcome = changed.rows[0]?.outcome;
        if (outcome === "not_found") {
          return { mapped: (await readWorkspace(client, member.userId, { id: workspaceId })) ? memberNotFound : workspaceNotFound };
        }
        const mapped = outcome ? memberOutcomes[outcome] : undefined;
        if (mapped) return { mapped };
        expectOutcome(outcome, "ok");
        const list = await client.query<MemberRow>(LIST_MEMBERS, [workspaceId]);
        const row = list.rows.find((candidate) => candidate.user_id === userId);
        return row ? { member: toMember(row) } : { mapped: memberNotFound };
      });
      if (reply.sent || !result) return reply;
      if (result.mapped) return problem(request, reply, ...result.mapped);
      return result.member;
    },
  );

  app.delete<{ Params: { workspaceId: string; userId: string } }>(
    "/api/v1/workspaces/:workspaceId/members/:userId",
    { config: MUTATION_RATE_LIMIT, schema: { params: memberParams } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const { workspaceId, userId } = request.params;
      const mapped = await guard.run(request, reply, member, async (client) => {
        const removed = await client.query<{ outcome: string }>("SELECT spark.ws_remove_member($1, $2) AS outcome", [workspaceId, userId]);
        const outcome = removed.rows[0]?.outcome;
        if (outcome === "not_found") {
          return (await readWorkspace(client, member.userId, { id: workspaceId })) ? memberNotFound : workspaceNotFound;
        }
        const known = outcome ? memberOutcomes[outcome] : undefined;
        if (known) return known;
        expectOutcome(outcome, "ok");
        return null;
      });
      if (reply.sent || mapped === undefined) return reply;
      if (mapped) return problem(request, reply, ...mapped);
      return reply.code(204).send();
    },
  );
}
