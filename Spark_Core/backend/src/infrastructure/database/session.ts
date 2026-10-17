import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export const SESSION_COOKIE = "spark_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface WorkspaceSummary {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  role: string;
}

export interface SessionPrincipal {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  email: string;
  platformRoles: string[];
  workspaces: WorkspaceSummary[];
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const item of cookieHeader.split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key && value.length > 0) {
      try {
        cookies[key] = decodeURIComponent(value.join("="));
      } catch {
        // Ignore malformed cookie values instead of failing the request.
      }
    }
  }
  return cookies;
}

export function hashSessionToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function newSessionToken(): { token: string; tokenHash: Buffer; expiresAt: Date } {
  const token = randomBytes(32).toString("hex");
  return { token, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000) };
}

export function readSessionTokenHash(cookieHeader: string | undefined): Buffer | null {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  return token ? hashSessionToken(token) : null;
}

interface PrincipalRow {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  email: string | null;
  platform_roles: string[];
  workspaces: WorkspaceSummary[];
}

const PRINCIPAL_COLUMNS = "user_id, display_name, avatar_url, email, platform_roles, workspaces";

/** Resolves an active session to its user, roles and workspaces; null when the session is invalid. */
export async function loadSessionPrincipal(db: Pool | PoolClient, tokenHash: Buffer): Promise<SessionPrincipal | null> {
  const result = await db.query<PrincipalRow>(`SELECT ${PRINCIPAL_COLUMNS} FROM spark.auth_session_principal($1)`, [tokenHash]);
  return toPrincipal(result.rows[0]);
}

/** Creates a session for a verified password user and returns its principal; null when the user cannot sign in. */
export async function startSession(db: Pool, userId: string, tokenHash: Buffer, expiresAt: Date): Promise<SessionPrincipal | null> {
  const result = await db.query<PrincipalRow>(`SELECT ${PRINCIPAL_COLUMNS} FROM spark.auth_start_session($1,$2,$3)`, [userId, tokenHash, expiresAt]);
  return toPrincipal(result.rows[0]);
}

function toPrincipal(row: PrincipalRow | undefined): SessionPrincipal | null {
  if (!row) return null;
  return {
    userId: row.user_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    email: row.email ?? "",
    platformRoles: row.platform_roles,
    workspaces: row.workspaces,
  };
}

/**
 * Runs `operation` in a transaction bound to an authenticated session. Staff policies and
 * governance functions derive the actor from this token hash rather than from a user id argument.
 */
export async function withSessionContext<T>(pool: Pool, tokenHash: Buffer, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  if (tokenHash.length !== 32) throw new Error("Invalid session context");
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('spark.session_token_hash',$1,true)", [tokenHash.toString("hex")]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { discard = true; }
    throw error;
  } finally {
    client.release(discard);
  }
}
