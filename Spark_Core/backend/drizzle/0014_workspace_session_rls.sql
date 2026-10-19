-- Bind workspace row access to the live session. The 0002 policies trusted the transaction-local
-- settings spark.user_id and spark.tenant_id, which any runtime caller could set. Workspace reads now
-- resolve the actor from spark.session_token_hash through spark.session_actor() (0006), so a missing,
-- revoked or expired session, a suspended user, a left or suspended membership, or an archived
-- workspace all see no workspace rows. Community helpers keep the old settings until they migrate.
ALTER TABLE spark.workspaces ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE spark.workspaces ADD CONSTRAINT workspaces_version_positive CHECK (version > 0);
-- maintain_record already guards workspaces (0002 attached it to every table with updated_at); it now
-- also requires each update to advance the version by exactly one. Recreated so the intent is explicit.
DROP TRIGGER IF EXISTS maintain_record ON spark.workspaces;
CREATE TRIGGER maintain_record BEFORE UPDATE ON spark.workspaces FOR EACH ROW EXECUTE FUNCTION spark.maintain_record();
--> statement-breakpoint
CREATE FUNCTION spark.session_workspace_ids(p_roles text[] DEFAULT ARRAY['owner','admin','member']) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE(array_agg(m.tenant_id), ARRAY[]::uuid[])
  FROM spark.workspace_memberships m JOIN spark.workspaces w ON w.id = m.tenant_id
  WHERE m.user_id = spark.session_actor() AND m.status = 'active' AND m.role = ANY(p_roles)
    AND w.status = 'active' AND w.archived_at IS NULL;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION spark.is_workspace_member(target uuid, allowed_roles text[] DEFAULT ARRAY['owner','admin','member']) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE(target = ANY(spark.session_workspace_ids(allowed_roles)), false);
$$;
--> statement-breakpoint
-- Internal guard for workspace write functions; not executable by the runtime role.
CREATE FUNCTION spark.require_session_actor() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.session_actor();
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Live session required' USING ERRCODE = '28000';
  END IF;
  RETURN actor;
END $$;
--> statement-breakpoint
-- True for the session actor and for users holding an active membership in one of the actor's
-- active workspaces. False without a live session.
CREATE FUNCTION spark.is_coworker(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE(p_user = spark.session_actor(), false)
    OR EXISTS (SELECT 1 FROM spark.workspace_memberships m
      WHERE m.user_id = p_user AND m.status = 'active' AND m.tenant_id = ANY(spark.session_workspace_ids()));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.session_workspace_ids(text[]), spark.require_session_actor(), spark.is_coworker(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION spark.require_session_actor() FROM spark_app;
GRANT EXECUTE ON FUNCTION spark.session_workspace_ids(text[]), spark.is_coworker(uuid) TO spark_app;
--> statement-breakpoint
DROP POLICY own_user_read ON spark.users;
CREATE POLICY self_and_coworker_read ON spark.users FOR SELECT TO spark_app
  USING (deleted_at IS NULL AND spark.is_coworker(id));
DROP POLICY workspace_read ON spark.workspaces;
CREATE POLICY workspace_read ON spark.workspaces FOR SELECT TO spark_app
  USING (id = ANY ((SELECT spark.session_workspace_ids())::uuid[]));
DROP POLICY workspace_members_read ON spark.workspace_memberships;
CREATE POLICY workspace_members_read ON spark.workspace_memberships FOR SELECT TO spark_app
  USING (tenant_id = ANY ((SELECT spark.session_workspace_ids())::uuid[]));
--> statement-breakpoint
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['startup_profiles','teams','team_memberships','projects','boards','issue_statuses','workflow_transitions','sprints','issues','issue_labels','issue_label_links','issue_comments','issue_links','issue_events','calendar_events','event_attendees'] LOOP
    EXECUTE format('DROP POLICY workspace_read ON spark.%I',name);
    EXECUTE format('CREATE POLICY workspace_read ON spark.%I FOR SELECT TO spark_app USING (tenant_id = ANY ((SELECT spark.session_workspace_ids())::uuid[]))',name);
  END LOOP;
END $$;
--> statement-breakpoint
-- Sign-up creates the user, primary email, credential and session only. Workspaces are created
-- explicitly by the user afterwards; the return shape is unchanged and the workspace columns are NULL.
CREATE OR REPLACE FUNCTION spark.auth_register_password(p_display_name text, p_email text, p_password_hash text, p_token_hash bytea, p_expires_at timestamptz)
RETURNS TABLE(user_id uuid, workspace_id uuid, workspace_name text, workspace_slug text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE new_user uuid; clean_name text := btrim(p_display_name);
BEGIN
  IF clean_name = '' OR p_expires_at <= now() OR p_expires_at > now() + interval '30 days' THEN
    RAISE EXCEPTION 'Invalid registration input' USING ERRCODE = '22023';
  END IF;
  INSERT INTO spark.users (display_name, locale, timezone, status) VALUES (clean_name, 'en', 'UTC', 'active') RETURNING id INTO new_user;
  INSERT INTO spark.user_emails (user_id, email, normalized_email, is_primary, verified_at)
    VALUES (new_user, btrim(p_email), lower(btrim(p_email)), true, NULL);
  INSERT INTO spark.password_credentials (user_id, password_hash) VALUES (new_user, p_password_hash);
  INSERT INTO spark.sessions (user_id, token_hash, auth_method, expires_at, last_seen_at) VALUES (new_user, p_token_hash, 'password', p_expires_at, now());
  RETURN QUERY SELECT new_user, NULL::uuid, NULL::text, NULL::text;
END $$;
