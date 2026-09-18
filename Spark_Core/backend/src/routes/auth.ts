import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import { verifyPassword } from "../infrastructure/database/password.js";
import {
  passwordCredentials,
  platformRoleAssignments,
  sessions,
  userEmails,
  users,
  workspaceMemberships,
  workspaces,
} from "../infrastructure/database/schema.js";

const SESSION_COOKIE = "spark_session";
const SESSION_TTL_DAYS = 7;

export interface AuthPluginOptions {
  readonly pool: Pool;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const item of cookieHeader.split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key && value.length > 0) {
      cookies[key] = decodeURIComponent(value.join("="));
    }
  }
  return cookies;
}

function setSessionCookie(reply: FastifyReply, token: string, maxAgeSeconds: number): void {
  const isProduction = process.env.NODE_ENV === "production";
  const flags = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isProduction) flags.push("Secure");
  reply.header("Set-Cookie", flags.join("; "));
}

function clearSessionCookie(reply: FastifyReply): void {
  const isProduction = process.env.NODE_ENV === "production";
  const flags = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (isProduction) flags.push("Secure");
  reply.header("Set-Cookie", flags.join("; "));
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthPluginOptions): void {
  const db = drizzle(options.pool);

  // POST /api/v1/auth/password/sign-in
  app.post(
    "/api/v1/auth/password/sign-in",
    {
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
      const plainPassword = request.body.password;

      // 1. Find user by normalized email
      const emailRecord = await db
        .select({
          userId: userEmails.userId,
          isPrimary: userEmails.isPrimary,
        })
        .from(userEmails)
        .where(eq(userEmails.normalizedEmail, normalizedEmail))
        .limit(1);

      if (emailRecord.length === 0) {
        return reply.code(401).type("application/problem+json").send({
          type: "about:blank",
          title: "Unauthorized",
          status: 401,
          code: "invalid_credentials",
          detail: "Invalid email or password.",
          instance: request.url,
          requestId: request.id,
        });
      }

      const userId = emailRecord[0]!.userId;

      // 2. Fetch user status and password credential
      const [userRecord, credRecord] = await Promise.all([
        db
          .select({
            id: users.id,
            displayName: users.displayName,
            avatarUrl: users.avatarUrl,
            status: users.status,
          })
          .from(users)
          .where(and(eq(users.id, userId), isNull(users.deletedAt)))
          .limit(1),
        db
          .select({
            passwordHash: passwordCredentials.passwordHash,
          })
          .from(passwordCredentials)
          .where(eq(passwordCredentials.userId, userId))
          .limit(1),
      ]);

      if (userRecord.length === 0 || credRecord.length === 0) {
        return reply.code(401).type("application/problem+json").send({
          type: "about:blank",
          title: "Unauthorized",
          status: 401,
          code: "invalid_credentials",
          detail: "Invalid email or password.",
          instance: request.url,
          requestId: request.id,
        });
      }

      const user = userRecord[0]!;
      if (user.status !== "active") {
        return reply.code(403).type("application/problem+json").send({
          type: "about:blank",
          title: "Forbidden",
          status: 403,
          code: "account_suspended",
          detail: "This account is currently suspended.",
          instance: request.url,
          requestId: request.id,
        });
      }

      // 3. Verify Argon2id password hash
      const isValid = await verifyPassword(credRecord[0]!.passwordHash, plainPassword);
      if (!isValid) {
        return reply.code(401).type("application/problem+json").send({
          type: "about:blank",
          title: "Unauthorized",
          status: 401,
          code: "invalid_credentials",
          detail: "Invalid email or password.",
          instance: request.url,
          requestId: request.id,
        });
      }

      // 4. Create 32-byte opaque session token and insert SHA-256 hash to database
      const rawToken = randomBytes(32).toString("hex");
      const tokenHashBuffer = createHash("sha256").update(rawToken).digest();
      const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

      await db.insert(sessions).values({
        userId: user.id,
        tokenHash: tokenHashBuffer,
        authMethod: "password",
        expiresAt,
        lastSeenAt: new Date(),
      });

      // Update user's last login timestamp
      await db
        .update(users)
        .set({ lastLoginAt: new Date() })
        .where(eq(users.id, user.id));

      // 5. Fetch workspace memberships and platform role assignments
      const [memberships, platformRoles] = await Promise.all([
        db
          .select({
            workspaceId: workspaces.id,
            workspaceName: workspaces.name,
            workspaceSlug: workspaces.slug,
            role: workspaceMemberships.role,
          })
          .from(workspaceMemberships)
          .innerJoin(workspaces, eq(workspaceMemberships.tenantId, workspaces.id))
          .where(
            and(
              eq(workspaceMemberships.userId, user.id),
              eq(workspaceMemberships.status, "active"),
              eq(workspaces.status, "active"),
            ),
          ),
        db
          .select({ role: platformRoleAssignments.role })
          .from(platformRoleAssignments)
          .where(
            and(
              eq(platformRoleAssignments.userId, user.id),
              isNull(platformRoleAssignments.revokedAt),
            ),
          ),
      ]);

      // Set HTTP-only session cookie
      setSessionCookie(reply, rawToken, SESSION_TTL_DAYS * 24 * 60 * 60);

      return reply.code(200).send({
        user: {
          id: user.id,
          email: normalizedEmail,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
        },
        workspace: memberships[0] ?? null,
        workspaces: memberships,
        platformRoles: platformRoles.map((r) => r.role),
      });
    },
  );

  // GET /api/v1/me
  app.get("/api/v1/me", async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "private, no-store");
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies[SESSION_COOKIE];

    if (!token) {
      return reply.code(401).type("application/problem+json").send({
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        code: "unauthenticated",
        detail: "No active session.",
        instance: request.url,
        requestId: request.id,
      });
    }

    const tokenHashBuffer = createHash("sha256").update(token).digest();

    // Find active session
    const sessionRecords = await db
      .select({
        sessionId: sessions.id,
        userId: sessions.userId,
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
      })
      .from(sessions)
      .where(and(eq(sessions.tokenHash, tokenHashBuffer), isNull(sessions.revokedAt)))
      .limit(1);

    if (sessionRecords.length === 0 || sessionRecords[0]!.expiresAt < new Date()) {
      clearSessionCookie(reply);
      return reply.code(401).type("application/problem+json").send({
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        code: "session_expired",
        detail: "Session has expired or was revoked.",
        instance: request.url,
        requestId: request.id,
      });
    }

    const session = sessionRecords[0]!;

    // Fetch user and roles
    const [userRecord, emailRecord, memberships, platformRoles] = await Promise.all([
      db
        .select({
          id: users.id,
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
          status: users.status,
        })
        .from(users)
        .where(and(eq(users.id, session.userId), isNull(users.deletedAt)))
        .limit(1),
      db
        .select({ email: userEmails.email })
        .from(userEmails)
        .where(and(eq(userEmails.userId, session.userId), eq(userEmails.isPrimary, true)))
        .limit(1),
      db
        .select({
          workspaceId: workspaces.id,
          workspaceName: workspaces.name,
          workspaceSlug: workspaces.slug,
          role: workspaceMemberships.role,
        })
        .from(workspaceMemberships)
        .innerJoin(workspaces, eq(workspaceMemberships.tenantId, workspaces.id))
        .where(
          and(
            eq(workspaceMemberships.userId, session.userId),
            eq(workspaceMemberships.status, "active"),
            eq(workspaces.status, "active"),
          ),
        ),
      db
        .select({ role: platformRoleAssignments.role })
        .from(platformRoleAssignments)
        .where(
          and(
            eq(platformRoleAssignments.userId, session.userId),
            isNull(platformRoleAssignments.revokedAt),
          ),
        ),
    ]);

    if (userRecord.length === 0 || userRecord[0]!.status !== "active") {
      clearSessionCookie(reply);
      return reply.code(401).type("application/problem+json").send({
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        code: "unauthenticated",
        detail: "User account is unavailable.",
        instance: request.url,
        requestId: request.id,
      });
    }

    // Refresh last seen
    await db
      .update(sessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(sessions.id, session.sessionId));

    const user = userRecord[0]!;
    return reply.code(200).send({
      user: {
        id: user.id,
        email: emailRecord[0]?.email ?? "",
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
      },
      workspaces: memberships,
      platformRoles: platformRoles.map((r) => r.role),
    });
  });

  // POST /api/v1/auth/sign-out
  app.post("/api/v1/auth/sign-out", async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "private, no-store");
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies[SESSION_COOKIE];

    if (token) {
      const tokenHashBuffer = createHash("sha256").update(token).digest();
      await db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(eq(sessions.tokenHash, tokenHashBuffer));
    }

    clearSessionCookie(reply);
    return reply.code(204).send();
  });
}
