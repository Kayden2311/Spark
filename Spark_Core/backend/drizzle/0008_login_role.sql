-- Move credential-handling functions to a dedicated login role (spark_auth), start sessions and
-- load the principal in one call, and serialize super-admin suspension with role revocation.
-- spark_auth is created by infra/postgres/bootstrap-local.sql (pnpm db:bootstrap:local).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'spark_auth') THEN
    RAISE EXCEPTION 'Role spark_auth is missing; run the database bootstrap before migrating' USING ERRCODE = '42704';
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA spark TO spark_auth;
DROP FUNCTION spark.auth_start_session(uuid, bytea, timestamptz);
--> statement-breakpoint
CREATE FUNCTION spark.auth_start_session(p_user_id uuid, p_token_hash bytea, p_expires_at timestamptz)
RETURNS TABLE(user_id uuid, display_name text, avatar_url text, email text, platform_roles text[], workspaces jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_expires_at <= now() OR p_expires_at > now() + interval '30 days' THEN
    RAISE EXCEPTION 'Invalid session expiry' USING ERRCODE = '22023';
  END IF;
  UPDATE spark.users u SET last_login_at = now()
    WHERE u.id = p_user_id AND u.status = 'active' AND u.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM spark.password_credentials c WHERE c.user_id = u.id);
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO spark.sessions (user_id, token_hash, auth_method, expires_at, last_seen_at) VALUES (p_user_id, p_token_hash, 'password', p_expires_at, now());
  -- Same transaction: either the caller gets the principal or no session row exists.
  RETURN QUERY SELECT * FROM spark.auth_session_principal(p_token_hash);
END $$;
--> statement-breakpoint
-- Suspending a super admin takes the same row locks as revoking the role, so the two cannot race
-- past the "at least one active super admin" invariant.
CREATE OR REPLACE FUNCTION spark.staff_set_user_status(p_target uuid, p_status text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_platform_role(ARRAY['super_admin','platform_admin']);
BEGIN
  IF p_status NOT IN ('active','suspended') THEN RAISE EXCEPTION 'Invalid user status' USING ERRCODE = '22023'; END IF;
  IF p_target = actor AND p_status = 'suspended' THEN RETURN 'self'; END IF;
  IF EXISTS (SELECT 1 FROM spark.platform_role_assignments r WHERE r.user_id = p_target AND r.role IN ('super_admin','platform_admin') AND r.revoked_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM spark.platform_role_assignments r WHERE r.user_id = actor AND r.role = 'super_admin' AND r.revoked_at IS NULL) THEN
    RETURN 'forbidden';
  END IF;
  IF p_status = 'suspended' AND EXISTS (SELECT 1 FROM spark.platform_role_assignments r WHERE r.user_id = p_target AND r.role = 'super_admin' AND r.revoked_at IS NULL) THEN
    PERFORM 1 FROM spark.platform_role_assignments r WHERE r.role = 'super_admin' AND r.revoked_at IS NULL FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM spark.platform_role_assignments r JOIN spark.users u ON u.id = r.user_id
        WHERE r.role = 'super_admin' AND r.revoked_at IS NULL AND r.user_id <> p_target AND u.status = 'active' AND u.deleted_at IS NULL) THEN
      RETURN 'last_super_admin';
    END IF;
  END IF;
  UPDATE spark.users SET status = p_status WHERE id = p_target AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF p_status = 'suspended' THEN
    UPDATE spark.sessions SET revoked_at = now() WHERE user_id = p_target AND revoked_at IS NULL;
  END IF;
  RETURN 'ok';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.auth_start_session(uuid,bytea,timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION spark.auth_register_password(text,text,text,bytea,timestamptz), spark.auth_password_login(text) FROM spark_app;
GRANT EXECUTE ON FUNCTION spark.auth_register_password(text,text,text,bytea,timestamptz), spark.auth_password_login(text),
  spark.auth_start_session(uuid,bytea,timestamptz), spark.auth_session_principal(bytea), spark.auth_revoke_session(bytea) TO spark_auth;
