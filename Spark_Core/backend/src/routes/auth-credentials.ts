import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import { hashPassword, verifyPassword } from "../infrastructure/database/password.js";
import { SESSION_TTL_SECONDS, newSessionToken, readSessionTokenHash, startSession } from "../infrastructure/database/session.js";
import { problem, setSessionCookie } from "./responses.js";

// Credential operations run only in the auth process, the sole holder of the spark_auth connection.
// The API forwards these public paths unchanged, so problem responses keep the public URL.
export const SIGN_UP_PATH = "/api/v1/auth/password/sign-up";
export const SIGN_IN_PATH = "/api/v1/auth/password/sign-in";
export const CREDENTIAL_RATE_LIMITS = { [SIGN_UP_PATH]: 5, [SIGN_IN_PATH]: 10 } as const;

export interface CredentialRoutesOptions {
  /** Pool connected as the login-only role (spark_auth). */
  readonly pool: Pool;
}

// Verified when no account matches, so unknown emails cost the same time as wrong passwords.
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(24).toString("hex"));
  return dummyHash;
}

function isDuplicateEmail(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505"
    && "constraint" in error && error.constraint === "user_emails_normalized_email_key";
}

export function registerCredentialRoutes(app: FastifyInstance, options: CredentialRoutesOptions): void {
  const { pool } = options;

  // POST /api/v1/auth/password/sign-up
  app.post(
    SIGN_UP_PATH,
    {
      config: {
        rateLimit: {
          max: CREDENTIAL_RATE_LIMITS[SIGN_UP_PATH],
          timeWindow: 60 * 1000,
        },
      },
      schema: {
        body: {
          type: "object",
          required: ["displayName", "email", "password"],
          properties: {
            displayName: { type: "string", minLength: 1, maxLength: 100 },
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 12 },
          },
          additionalProperties: false,
        },
      },
    },
    async (
      request: FastifyRequest<{
        Body: { displayName: string; email: string; password: string };
      }>,
      reply: FastifyReply,
    ) => {
      reply.header("Cache-Control", "private, no-store");
      const displayName = request.body.displayName.trim();
      const email = request.body.email.trim();
      const normalizedEmail = email.toLowerCase();
      if (!displayName) {
        return problem(request, reply, 400, "Bad Request", "invalid_display_name", "Display name is required.");
      }

      const hashedPassword = await hashPassword(request.body.password);
      const session = newSessionToken();

      // User, email, credential and session commit atomically; workspaces are created later, on purpose.
      let created: { user_id: string } | undefined;
      try {
        const result = await pool.query<{ user_id: string }>(
          "SELECT user_id FROM spark.auth_register_password($1,$2,$3,$4,$5)",
          [displayName, email, hashedPassword, session.tokenHash, session.expiresAt],
        );
        created = result.rows[0];
      } catch (error) {
        if (isDuplicateEmail(error)) {
          return problem(request, reply, 409, "Conflict", "email_already_exists", "An account with this email address already exists.");
        }
        throw error;
      }

      if (!created) {
        return problem(request, reply, 500, "Internal Server Error", "user_creation_failed", "Could not create user account.");
      }

      setSessionCookie(reply, session.token, SESSION_TTL_SECONDS);

      return reply.code(201).send({
        user: {
          id: created.user_id,
          email: normalizedEmail,
          displayName,
          avatarUrl: null,
          role: "member",
          platformRoles: [],
        },
        workspace: null,
        workspaces: [],
        platformRoles: [],
      });
    },
  );

  // POST /api/v1/auth/password/sign-in
  app.post(
    SIGN_IN_PATH,
    {
      config: {
        rateLimit: {
          max: CREDENTIAL_RATE_LIMITS[SIGN_IN_PATH],
          timeWindow: 60 * 1000,
        },
      },
      schema: {
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request: FastifyRequest<{ Body: { email: string; password: string } }>, reply: FastifyReply) => {
      reply.header("Cache-Control", "private, no-store");
      const normalizedEmail = request.body.email.trim().toLowerCase();

      const login = await pool.query<{ user_id: string; password_hash: string; status: string }>(
        "SELECT user_id, password_hash, status FROM spark.auth_password_login($1)",
        [normalizedEmail],
      );
      const account = login.rows[0];
      const isValid = await verifyPassword(account?.password_hash ?? (await getDummyHash()), request.body.password);

      if (!account || !isValid) {
        return problem(request, reply, 401, "Unauthorized", "invalid_credentials", "Invalid email or password.");
      }
      // Status is disclosed only after the password is proven.
      if (account.status !== "active") {
        return problem(request, reply, 403, "Forbidden", "account_suspended", "This account is currently suspended.");
      }

      // Rotate: a session presented with this request (e.g. another account on a shared browser) ends here.
      const previous = readSessionTokenHash(request.headers.cookie);
      if (previous) await pool.query("SELECT spark.auth_revoke_session($1)", [previous]);

      // Creates the session and returns its principal atomically, so no session is left unclaimed.
      const session = newSessionToken();
      const principal = await startSession(pool, account.user_id, session.tokenHash, session.expiresAt);
      if (!principal) {
        return problem(request, reply, 401, "Unauthorized", "invalid_credentials", "Invalid email or password.");
      }

      setSessionCookie(reply, session.token, SESSION_TTL_SECONDS);

      const primaryRole = principal.platformRoles[0] ?? principal.workspaces[0]?.role ?? "member";
      return reply.code(200).send({
        user: {
          id: principal.userId,
          email: normalizedEmail,
          displayName: principal.displayName,
          avatarUrl: principal.avatarUrl,
          role: primaryRole,
          platformRoles: principal.platformRoles,
        },
        workspace: principal.workspaces[0] ?? null,
        workspaces: principal.workspaces,
        platformRoles: principal.platformRoles,
      });
    },
  );
}
