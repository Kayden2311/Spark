import type { Pool } from "pg";

interface RoleProbe {
  role: string;
  superuser: boolean;
  bypass_rls: boolean;
  memberships: number;
}

const ROLE_PROBE = `SELECT current_user AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypass_rls,
  (SELECT count(*)::integer FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) AS memberships`;

/**
 * Fails auth-process startup unless its pool uses a least-privilege login role: not a superuser,
 * not exempt from RLS, no role memberships, and unable to read application tables.
 */
export async function assertLoginRole(pool: Pool): Promise<void> {
  const result = await pool.query<RoleProbe & { reads_users: boolean | null }>(
    `${ROLE_PROBE}, has_table_privilege(to_regclass('spark.users'), 'SELECT') AS reads_users
     FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`,
  );
  const login = result.rows[0];
  if (!login) throw new Error("Unable to inspect the authentication database role");
  // NULL means spark.users is not visible at all: wrong database or schema, so fail closed.
  if (login.reads_users === null) throw new Error("The authentication pool is not connected to the Spark database");
  if (login.superuser || login.bypass_rls || login.reads_users || login.memberships > 0) {
    throw new Error(`Database role ${login.role} is too privileged for the authentication pool`);
  }
}

/**
 * Fails API startup if its runtime role could read credentials or create sessions itself, directly
 * or through role membership, which would mean the API holds login power only the auth process should have.
 */
export async function assertRuntimeRole(pool: Pool): Promise<void> {
  const result = await pool.query<RoleProbe & { starts_sessions: boolean | null }>(
    `${ROLE_PROBE},
       (SELECT bool_or(has_function_privilege(f.oid, 'EXECUTE')) FROM unnest(ARRAY[
          to_regprocedure('spark.auth_start_session(uuid,bytea,timestamptz)'),
          to_regprocedure('spark.auth_password_login(text)'),
          to_regprocedure('spark.auth_register_password(text,text,text,bytea,timestamptz)')]) AS f(oid)
        HAVING count(f.oid) = 3) AS starts_sessions
     FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`,
  );
  const runtime = result.rows[0];
  if (!runtime) throw new Error("Unable to inspect the runtime database role");
  if (runtime.starts_sessions === null) throw new Error("The runtime pool is not connected to a migrated Spark database");
  // Memberships matter even for a NOINHERIT role: SET ROLE could still reach the login functions.
  if (runtime.superuser || runtime.bypass_rls || runtime.starts_sessions || runtime.memberships > 0) {
    throw new Error(`Database role ${runtime.role} must not be able to create sessions or bypass RLS`);
  }
}

/**
 * Fails worker startup unless its pool uses the least-privilege worker role: not a superuser, not exempt
 * from RLS, no role memberships, unable to read application tables, and able to claim outbox events.
 */
export async function assertWorkerRole(pool: Pool): Promise<void> {
  const result = await pool.query<RoleProbe & { reads_users: boolean | null; claims_outbox: boolean | null }>(
    `${ROLE_PROBE}, has_table_privilege(to_regclass('spark.users'), 'SELECT') AS reads_users,
       COALESCE(has_function_privilege(to_regprocedure('spark.worker_claim_outbox(uuid,integer,integer)'), 'EXECUTE'), false) AS claims_outbox
     FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`,
  );
  const worker = result.rows[0];
  if (!worker) throw new Error("Unable to inspect the worker database role");
  if (worker.reads_users === null) throw new Error("The worker pool is not connected to the Spark database");
  if (worker.superuser || worker.bypass_rls || worker.reads_users || worker.memberships > 0) {
    throw new Error(`Database role ${worker.role} is too privileged for the worker pool`);
  }
  if (!worker.claims_outbox) throw new Error(`Database role ${worker.role} cannot claim outbox events; run the migrations`);
}
