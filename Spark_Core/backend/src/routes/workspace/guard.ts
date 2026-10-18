import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";

import { loadSessionPrincipal, readSessionTokenHash, withSessionContext } from "../../infrastructure/database/session.js";
import { problem } from "../responses.js";
import { databaseDenial, invalidInputDetail, isInvalidParameter } from "../session-guard.js";

export interface Member {
  userId: string;
  tokenHash: Buffer;
}

// Messages the spark.ws_* functions raise with 22023; anything else gets a generic message.
const KNOWN_INPUT_ERRORS: ReadonlySet<string> = new Set([
  "Invalid workspace name",
  "Invalid workspace slug",
  "Invalid invitation email",
  "Invalid invitation role",
  "Invalid invitation expiry",
  "Invalid member role",
  "Invalid project key",
  "Invalid project name",
  "Invalid project description",
  "Invalid methodology",
  "Invalid project dates",
  "Invalid sprint length",
  "Invalid project statuses",
  "Invalid project phases",
]);

export interface MemberGuard {
  /** Resolves the session principal; sends 401 and returns null without a live session. */
  authenticate(request: FastifyRequest, reply: FastifyReply): Promise<Member | null>;
  /**
   * Runs work in a session-bound transaction. A session revoked between `authenticate` and the
   * database call is reported as 401 instead of a server error.
   */
  run<T>(request: FastifyRequest, reply: FastifyReply, member: Member, work: (client: PoolClient) => Promise<T>): Promise<T | undefined>;
}

export function createMemberGuard(pool: Pool): MemberGuard {
  return {
    async authenticate(request, reply) {
      reply.header("Cache-Control", "private, no-store");
      const tokenHash = readSessionTokenHash(request.headers.cookie);
      if (!tokenHash) {
        void problem(request, reply, 401, "Unauthorized", "unauthenticated", "No active session.");
        return null;
      }
      const principal = await loadSessionPrincipal(pool, tokenHash);
      if (!principal) {
        void problem(request, reply, 401, "Unauthorized", "session_expired", "Session expired or invalid.");
        return null;
      }
      return { userId: principal.userId, tokenHash };
    },

    async run(request, reply, member, work) {
      try {
        return await withSessionContext(pool, member.tokenHash, async (client) => {
          await client.query("SET LOCAL statement_timeout = '5s'");
          return work(client);
        });
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
    },
  };
}

/** 412 carrying the current representation so the client can reconcile. */
export function preconditionFailed(request: FastifyRequest, reply: FastifyReply, current: unknown) {
  return reply.code(412).type("application/problem+json").send({
    type: "about:blank",
    title: "Precondition Failed",
    status: 412,
    code: "version_mismatch",
    detail: "The resource changed since you loaded it.",
    instance: request.url,
    requestId: request.id,
    current,
  });
}

export function preconditionRequired(request: FastifyRequest, reply: FastifyReply) {
  return problem(request, reply, 428, "Precondition Required", "precondition_required", "This request requires an If-Match header.");
}
