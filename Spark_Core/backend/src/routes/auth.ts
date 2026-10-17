import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import { loadSessionPrincipal, readSessionTokenHash } from "../infrastructure/database/session.js";
import { clearSessionCookie, problem } from "./responses.js";

export interface AuthPluginOptions {
  /** Runtime pool (spark_app); it can resolve and revoke sessions but never create them. */
  readonly pool: Pool;
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthPluginOptions): void {
  const { pool } = options;

  // GET /api/v1/me
  app.get("/api/v1/me", async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "private, no-store");
    const tokenHash = readSessionTokenHash(request.headers.cookie);
    if (!tokenHash) {
      return problem(request, reply, 401, "Unauthorized", "unauthenticated", "No active session.");
    }

    const principal = await loadSessionPrincipal(pool, tokenHash);
    if (!principal) {
      clearSessionCookie(reply);
      return problem(request, reply, 401, "Unauthorized", "session_expired", "Session has expired or was revoked.");
    }

    const primaryRole = principal.platformRoles[0] ?? principal.workspaces[0]?.role ?? "member";
    return reply.code(200).send({
      user: {
        id: principal.userId,
        email: principal.email,
        displayName: principal.displayName,
        avatarUrl: principal.avatarUrl,
        role: primaryRole,
        platformRoles: principal.platformRoles,
      },
      workspaces: principal.workspaces,
      platformRoles: principal.platformRoles,
    });
  });

  // POST /api/v1/auth/sign-out
  app.post("/api/v1/auth/sign-out", async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "private, no-store");
    const tokenHash = readSessionTokenHash(request.headers.cookie);
    if (tokenHash) {
      await pool.query("SELECT spark.auth_revoke_session($1)", [tokenHash]);
    }

    clearSessionCookie(reply);
    return reply.code(204).send();
  });
}
