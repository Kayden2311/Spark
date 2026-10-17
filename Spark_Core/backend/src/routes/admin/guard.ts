import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";

import { loadSessionPrincipal, readSessionTokenHash, withSessionContext } from "../../infrastructure/database/session.js";
import { decodeCursor, type Cursor } from "../pagination.js";
import { problem } from "../responses.js";

export const PLATFORM_ROLES = ["super_admin", "platform_admin", "community_moderator", "content_moderator", "campaign_moderator"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

// Mirrors the role arrays passed to spark.require_platform_role in 0009_platform_governance.sql.
// The database re-checks every call; these lists only let the API answer 403 before opening a transaction.
export const ANY_STAFF: readonly PlatformRole[] = PLATFORM_ROLES;
export const ADMINS: readonly PlatformRole[] = ["super_admin", "platform_admin"];
export const CONTENT_STAFF: readonly PlatformRole[] = ["super_admin", "platform_admin", "content_moderator"];
export const COMMUNITY_STAFF: readonly PlatformRole[] = ["super_admin", "platform_admin", "community_moderator"];
export const CAMPAIGN_STAFF: readonly PlatformRole[] = ["super_admin", "platform_admin", "campaign_moderator"];
export const SUPER_ADMINS: readonly PlatformRole[] = ["super_admin"];

export const MUTATION_RATE_LIMIT = { rateLimit: { max: 30, timeWindow: 60 * 1000 } } as const;

export const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
  additionalProperties: false,
} as const;

/** Every governance write needs a human-readable justification; the database enforces the same bounds. */
export const reasonProperty = { type: "string", minLength: 3, maxLength: 500, pattern: "\\S" } as const;

export const pageQueryProperties = {
  cursor: { type: "string", maxLength: 200 },
  limit: { type: "integer", minimum: 1, maximum: 100 },
} as const;

export interface StaffMember {
  userId: string;
  roles: string[];
  tokenHash: Buffer;
}

// Database outcomes are a closed set; anything unexpected must not be reported as success.
export function expectOutcome(outcome: string | undefined, ...allowed: string[]): void {
  if (!outcome || !allowed.includes(outcome)) throw new Error(`Unexpected governance outcome: ${outcome ?? "none"}`);
}

// Errors raised by spark.require_platform_role; other 42501 errors are real privilege bugs and stay 500s.
function governanceError(error: unknown): "no_session" | "no_role" | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  if (error.code === "28000" && "message" in error && error.message === "Live session required") return "no_session";
  if (error.code === "42501" && "message" in error && error.message === "Platform role required") return "no_role";
  return null;
}

function isInvalidParameter(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "22023";
}

// Messages our own governance functions raise with 22023. Anything else gets a generic message so
// built-in database errors never reach the client.
const KNOWN_INPUT_ERRORS = new Set([
  "A reason of 3 to 500 characters is required",
  "Invalid report status",
  "Invalid cursor",
  "Invalid moderation action",
  "Invalid campaign review",
  "Invalid community action",
  "Invalid user status",
  "Invalid range",
  "Invalid limit",
  "Invalid subscription status",
  "Invalid invoice status", "Invalid plan kind",
]);

function invalidInputDetail(error: unknown): string {
  const message = typeof error === "object" && error !== null && "message" in error ? String(error.message) : "";
  return KNOWN_INPUT_ERRORS.has(message) ? `${message}.` : "The request contains a value the server does not accept.";
}

export function forbidden(request: FastifyRequest, reply: FastifyReply, detail = "You do not have the platform role this action requires.") {
  return problem(request, reply, 403, "Forbidden", "insufficient_permissions", detail);
}

export function readCursor(request: FastifyRequest, reply: FastifyReply, value: string | undefined): Cursor | null | undefined {
  const cursor = decodeCursor(value);
  if (cursor === "invalid") {
    void problem(request, reply, 400, "Bad Request", "invalid_cursor", "The cursor is not valid for this collection.");
    return undefined;
  }
  return cursor;
}

export interface StaffGuard {
  /** Resolves the session principal and checks it holds one of `roles`; sends 401/403 and returns null otherwise. */
  authorize(request: FastifyRequest, reply: FastifyReply, roles: readonly PlatformRole[]): Promise<StaffMember | null>;
  /**
   * Runs staff work in a session-bound transaction. A session or role revoked between `authorize`
   * and the database call is reported as 401 or 403 instead of a server error.
   */
  run<T>(request: FastifyRequest, reply: FastifyReply, staff: StaffMember, work: (client: PoolClient) => Promise<T>): Promise<T | undefined>;
}

export function createStaffGuard(pool: Pool): StaffGuard {
  return {
    async authorize(request, reply, roles) {
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
      if (!principal.platformRoles.some((role) => roles.includes(role as PlatformRole))) {
        void forbidden(request, reply);
        return null;
      }
      return { userId: principal.userId, roles: principal.platformRoles, tokenHash };
    },

    async run(request, reply, staff, work) {
      try {
        return await withSessionContext(pool, staff.tokenHash, async (client) => {
          // Reporting queries scan months of activity; cap each one so a slow query cannot hold a pool connection.
          await client.query("SET LOCAL statement_timeout = '15s'");
          return work(client);
        });
      } catch (error) {
        const denial = governanceError(error);
        if (denial === "no_session") {
          void problem(request, reply, 401, "Unauthorized", "session_expired", "Session expired or invalid.");
          return undefined;
        }
        if (denial === "no_role") {
          void forbidden(request, reply);
          return undefined;
        }
        // 22023 is raised by the governance functions for input the schema cannot express,
        // such as a reason that is too short once surrounding whitespace is trimmed.
        if (isInvalidParameter(error)) {
          void problem(request, reply, 400, "Bad Request", "invalid_input", invalidInputDetail(error));
          return undefined;
        }
        throw error;
      }
    },
  };
}

/** Escapes LIKE wildcards so a search for "50%" matches literally. */
export function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/gu, (match) => `\\${match}`)}%`;
}
