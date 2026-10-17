-- Replace the permissive runtime access added in 0005 with least-privilege access.
-- Sensitive tables (credentials, sessions, tokens, reports, platform roles) are reachable by
-- spark_app only through SECURITY DEFINER functions. Platform staff access is bound to a live
-- session: the transaction-local setting spark.session_token_hash must hold the SHA-256 hash of an
-- active, unexpired session whose user holds the required platform role.
DROP POLICY user_emails_spark_app_select ON spark.user_emails;
DROP POLICY user_emails_spark_app_insert ON spark.user_emails;
DROP POLICY user_emails_spark_app_update ON spark.user_emails;
DROP POLICY password_credentials_spark_app_select ON spark.password_credentials;
DROP POLICY password_credentials_spark_app_insert ON spark.password_credentials;
DROP POLICY password_credentials_spark_app_update ON spark.password_credentials;
DROP POLICY users_spark_app_select ON spark.users;
DROP POLICY users_spark_app_insert ON spark.users;
DROP POLICY users_spark_app_update ON spark.users;
DROP POLICY workspaces_spark_app_select ON spark.workspaces;
DROP POLICY workspaces_spark_app_insert ON spark.workspaces;
DROP POLICY workspaces_spark_app_update ON spark.workspaces;
DROP POLICY workspace_memberships_spark_app_select ON spark.workspace_memberships;
DROP POLICY workspace_memberships_spark_app_insert ON spark.workspace_memberships;
DROP POLICY workspace_memberships_spark_app_update ON spark.workspace_memberships;
DROP POLICY sessions_spark_app_all ON spark.sessions;
DROP POLICY account_tokens_spark_app_all ON spark.account_tokens;
DROP POLICY auth_identities_spark_app_all ON spark.auth_identities;
DROP POLICY content_reports_spark_app_all ON spark.content_reports;
DROP POLICY moderation_actions_spark_app_all ON spark.moderation_actions;
DROP POLICY posts_spark_app_update ON spark.posts;
DROP POLICY post_comments_spark_app_update ON spark.post_comments;
DROP POLICY communities_spark_app_update ON spark.communities;
DROP POLICY promotion_campaigns_spark_app_all ON spark.promotion_campaigns;
DROP POLICY promotion_reviews_spark_app_all ON spark.promotion_reviews;
DROP POLICY platform_role_assignments_spark_app_update ON spark.platform_role_assignments;
DROP POLICY platform_role_assignments_spark_app_insert ON spark.platform_role_assignments;
--> statement-breakpoint
REVOKE ALL ON spark.users, spark.user_emails, spark.password_credentials, spark.workspaces, spark.workspace_memberships,
  spark.sessions, spark.account_tokens, spark.auth_identities, spark.platform_role_assignments, spark.content_reports,
  spark.moderation_actions, spark.posts, spark.post_comments, spark.communities, spark.promotion_campaigns,
  spark.promotion_reviews FROM spark_app;
-- Restore the 0002 read baseline; RLS policies decide which rows are visible.
GRANT SELECT ON spark.users, spark.workspaces, spark.workspace_memberships, spark.communities, spark.community_memberships,
  spark.posts, spark.post_comments TO spark_app;
-- Staff-only reads, filtered by the staff_read policies below.
GRANT SELECT ON spark.user_emails, spark.moderation_actions, spark.promotion_campaigns, spark.promotion_placements TO spark_app;
--> statement-breakpoint
CREATE FUNCTION spark.session_actor() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT s.user_id FROM spark.sessions s JOIN spark.users u ON u.id = s.user_id
  WHERE s.token_hash = decode(nullif(current_setting('spark.session_token_hash', true), ''), 'hex')
    AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active' AND u.deleted_at IS NULL;
$$;
--> statement-breakpoint
CREATE FUNCTION spark.has_platform_role(allowed text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM spark.platform_role_assignments r
    WHERE r.user_id = spark.session_actor() AND r.revoked_at IS NULL AND r.role = ANY(allowed));
$$;
--> statement-breakpoint
CREATE FUNCTION spark.require_platform_role(allowed text[]) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.session_actor();
BEGIN
  IF actor IS NULL OR NOT EXISTS (SELECT 1 FROM spark.platform_role_assignments r
      WHERE r.user_id = actor AND r.revoked_at IS NULL AND r.role = ANY(allowed)) THEN
    RAISE EXCEPTION 'Platform role required' USING ERRCODE = '42501';
  END IF;
  RETURN actor;
END $$;
--> statement-breakpoint
CREATE POLICY staff_read ON spark.users FOR SELECT TO spark_app
  USING ((SELECT spark.has_platform_role(ARRAY['super_admin','platform_admin','community_moderator','content_moderator','campaign_moderator'])));
CREATE POLICY staff_read ON spark.user_emails FOR SELECT TO spark_app
  USING ((SELECT spark.has_platform_role(ARRAY['super_admin','platform_admin'])));
CREATE POLICY staff_read ON spark.workspace_memberships FOR SELECT TO spark_app
  USING ((SELECT spark.has_platform_role(ARRAY['super_admin','platform_admin'])));
CREATE POLICY staff_read ON spark.communities FOR SELECT TO spark_app
  USING ((SELECT spark.has_platform_role(ARRAY['super_admin','platform_admin','community_moderator','content_moderator','campaign_moderator'])));
CREATE POLICY staff_read ON spark.community_memberships FOR SELECT TO spark_app
  USING ((SELECT spark.has_platform_role(ARRAY['super_admin','platform_admin','community_moderator'])));
CREATE POLICY staff_read ON spark.moderation_actions FOR SELECT TO spark_app
  USING ((SELECT spark.has_platform_role(ARRAY['super_admin','platform_admin'])));
CREATE POLICY staff_read ON spark.promotion_campaigns FOR SELECT TO spark_app
  USING ((SELECT spark.has_platform_role(ARRAY['super_admin','platform_admin','campaign_moderator'])));
CREATE POLICY staff_read ON spark.promotion_placements FOR SELECT TO spark_app
  USING ((SELECT spark.has_platform_role(ARRAY['super_admin','platform_admin','campaign_moderator'])));
--> statement-breakpoint
-- Authentication. Password verification stays in the application (Argon2id); the database
-- exposes one credential per exact email and creates sessions only for active password users.
CREATE FUNCTION spark.auth_register_password(p_display_name text, p_email text, p_password_hash text, p_token_hash bytea, p_expires_at timestamptz)
RETURNS TABLE(user_id uuid, workspace_id uuid, workspace_name text, workspace_slug text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE new_user uuid; new_workspace uuid; clean_name text := btrim(p_display_name); slug text; ws_name text;
BEGIN
  IF clean_name = '' OR p_expires_at <= now() OR p_expires_at > now() + interval '30 days' THEN
    RAISE EXCEPTION 'Invalid registration input' USING ERRCODE = '22023';
  END IF;
  INSERT INTO spark.users (display_name, locale, timezone, status) VALUES (clean_name, 'en', 'UTC', 'active') RETURNING id INTO new_user;
  INSERT INTO spark.user_emails (user_id, email, normalized_email, is_primary, verified_at)
    VALUES (new_user, btrim(p_email), lower(btrim(p_email)), true, now());
  INSERT INTO spark.password_credentials (user_id, password_hash) VALUES (new_user, p_password_hash);
  slug := 'ws-' || left(replace(new_user::text, '-', ''), 10);
  ws_name := clean_name || '''s Space';
  INSERT INTO spark.workspaces (slug, name, status, created_by_user_id) VALUES (slug, ws_name, 'active', new_user) RETURNING id INTO new_workspace;
  INSERT INTO spark.workspace_memberships (tenant_id, user_id, role, status) VALUES (new_workspace, new_user, 'owner', 'active');
  INSERT INTO spark.sessions (user_id, token_hash, auth_method, expires_at, last_seen_at) VALUES (new_user, p_token_hash, 'password', p_expires_at, now());
  RETURN QUERY SELECT new_user, new_workspace, ws_name, slug;
END $$;
--> statement-breakpoint
CREATE FUNCTION spark.auth_password_login(p_email text)
RETURNS TABLE(user_id uuid, password_hash text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT u.id, c.password_hash, u.status FROM spark.user_emails e
  JOIN spark.users u ON u.id = e.user_id AND u.deleted_at IS NULL
  JOIN spark.password_credentials c ON c.user_id = u.id
  WHERE e.normalized_email = lower(btrim(p_email))
  LIMIT 1;
$$;
--> statement-breakpoint
CREATE FUNCTION spark.auth_start_session(p_user_id uuid, p_token_hash bytea, p_expires_at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_expires_at <= now() OR p_expires_at > now() + interval '30 days' THEN
    RAISE EXCEPTION 'Invalid session expiry' USING ERRCODE = '22023';
  END IF;
  UPDATE spark.users u SET last_login_at = now()
    WHERE u.id = p_user_id AND u.status = 'active' AND u.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM spark.password_credentials c WHERE c.user_id = u.id);
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO spark.sessions (user_id, token_hash, auth_method, expires_at, last_seen_at) VALUES (p_user_id, p_token_hash, 'password', p_expires_at, now());
  RETURN true;
END $$;
--> statement-breakpoint
CREATE FUNCTION spark.auth_session_principal(p_token_hash bytea)
RETURNS TABLE(user_id uuid, display_name text, avatar_url text, email text, platform_roles text[], workspaces jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE session_id uuid; actor uuid;
BEGIN
  SELECT s.id, s.user_id INTO session_id, actor FROM spark.sessions s JOIN spark.users u ON u.id = s.user_id
  WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active' AND u.deleted_at IS NULL;
  IF actor IS NULL THEN RETURN; END IF;
  UPDATE spark.sessions SET last_seen_at = now() WHERE id = session_id;
  RETURN QUERY SELECT u.id, u.display_name, u.avatar_url,
    (SELECT e.email FROM spark.user_emails e WHERE e.user_id = u.id AND e.is_primary),
    COALESCE((SELECT array_agg(r.role ORDER BY r.created_at) FROM spark.platform_role_assignments r
      WHERE r.user_id = u.id AND r.revoked_at IS NULL), ARRAY[]::text[]),
    COALESCE((SELECT jsonb_agg(jsonb_build_object('workspaceId', w.id, 'workspaceName', w.name, 'workspaceSlug', w.slug, 'role', m.role) ORDER BY m.joined_at)
      FROM spark.workspace_memberships m JOIN spark.workspaces w ON w.id = m.tenant_id
      WHERE m.user_id = u.id AND m.status = 'active' AND w.status = 'active'), '[]'::jsonb)
  FROM spark.users u WHERE u.id = actor;
END $$;
--> statement-breakpoint
CREATE FUNCTION spark.auth_revoke_session(p_token_hash bytea) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE spark.sessions SET revoked_at = now() WHERE token_hash = p_token_hash AND revoked_at IS NULL;
$$;
--> statement-breakpoint
-- Platform governance. Every function derives the actor from the session, never from a parameter.
CREATE FUNCTION spark.staff_overview()
RETURNS TABLE(active_communities bigint, active_users bigint, open_reports bigint, approved_campaigns bigint, active_workspaces bigint, moderation_actions bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin','community_moderator','content_moderator','campaign_moderator']);
  RETURN QUERY SELECT
    (SELECT count(*) FROM spark.communities c WHERE c.archived_at IS NULL),
    (SELECT count(*) FROM spark.users u WHERE u.status = 'active'),
    (SELECT count(*) FROM spark.content_reports r WHERE r.status = 'open'),
    (SELECT count(*) FROM spark.promotion_campaigns p WHERE p.review_status = 'approved'),
    (SELECT count(*) FROM spark.workspaces w WHERE w.archived_at IS NULL),
    (SELECT count(*) FROM spark.moderation_actions a);
END $$;
--> statement-breakpoint
CREATE FUNCTION spark.staff_list_reports(p_status text, p_limit integer)
RETURNS TABLE(id uuid, tenant_id uuid, community_id uuid, post_id uuid, comment_id uuid, reporter_user_id uuid, reporter_name text,
  reason_code text, details text, status text, created_at timestamptz, resolved_at timestamptz, community_name text, community_slug text,
  post_title text, post_body text, post_moderation_status text, comment_body text, comment_moderation_status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin','content_moderator']);
  RETURN QUERY SELECT r.id, r.tenant_id, r.community_id, r.post_id, r.comment_id, r.reporter_user_id, u.display_name,
    r.reason_code, r.details, r.status, r.created_at, r.resolved_at, c.name, c.slug,
    p.title, p.body, p.moderation_status, pc.body, pc.moderation_status
  FROM spark.content_reports r
  LEFT JOIN spark.users u ON u.id = r.reporter_user_id
  LEFT JOIN spark.communities c ON c.id = r.community_id
  LEFT JOIN spark.posts p ON p.id = r.post_id
  LEFT JOIN spark.post_comments pc ON pc.id = r.comment_id
  WHERE r.status = p_status
  ORDER BY r.created_at DESC
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 100);
END $$;
--> statement-breakpoint
CREATE FUNCTION spark.staff_resolve_report(p_report uuid, p_action text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_platform_role(ARRAY['super_admin','platform_admin','content_moderator']);
  report spark.content_reports%ROWTYPE;
BEGIN
  IF p_action NOT IN ('hide','restore','dismiss_report') OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'Invalid moderation action' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO report FROM spark.content_reports r WHERE r.id = p_report FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF p_action IN ('hide','restore') THEN
    UPDATE spark.posts SET moderation_status = CASE p_action WHEN 'hide' THEN 'hidden' ELSE 'visible' END
      WHERE id = report.post_id AND tenant_id = report.tenant_id;
    UPDATE spark.post_comments SET moderation_status = CASE p_action WHEN 'hide' THEN 'hidden' ELSE 'visible' END
      WHERE id = report.comment_id AND tenant_id = report.tenant_id;
    UPDATE spark.content_reports SET status = 'resolved', resolved_at = now() WHERE id = report.id;
  ELSE
    UPDATE spark.content_reports SET status = 'dismissed', resolved_at = now() WHERE id = report.id;
  END IF;
  INSERT INTO spark.moderation_actions (tenant_id, community_id, report_id, post_id, comment_id, actor_user_id, action, reason)
    VALUES (report.tenant_id, report.community_id, report.id, report.post_id, report.comment_id, actor, p_action, btrim(p_reason));
  RETURN 'ok';
END $$;
--> statement-breakpoint
CREATE FUNCTION spark.staff_open_report_counts(p_communities uuid[])
RETURNS TABLE(community_id uuid, open_reports bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin','community_moderator','content_moderator']);
  RETURN QUERY SELECT r.community_id, count(*) FROM spark.content_reports r
    WHERE r.community_id = ANY(p_communities) AND r.status = 'open' GROUP BY r.community_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION spark.staff_set_community_archived(p_community uuid, p_archived boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin','community_moderator']);
  UPDATE spark.communities SET archived_at = CASE WHEN p_archived THEN coalesce(archived_at, now()) END WHERE id = p_community;
  RETURN FOUND;
END $$;
--> statement-breakpoint
CREATE FUNCTION spark.staff_user_roles(p_users uuid[])
RETURNS TABLE(user_id uuid, role text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin']);
  RETURN QUERY SELECT r.user_id, r.role FROM spark.platform_role_assignments r
    WHERE r.user_id = ANY(p_users) AND r.revoked_at IS NULL ORDER BY r.created_at;
END $$;
--> statement-breakpoint
CREATE FUNCTION spark.staff_set_user_status(p_target uuid, p_status text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_platform_role(ARRAY['super_admin','platform_admin']);
BEGIN
  IF p_status NOT IN ('active','suspended') THEN RAISE EXCEPTION 'Invalid user status' USING ERRCODE = '22023'; END IF;
  IF p_target = actor AND p_status = 'suspended' THEN RETURN 'self'; END IF;
  IF EXISTS (SELECT 1 FROM spark.platform_role_assignments r WHERE r.user_id = p_target AND r.role = 'super_admin' AND r.revoked_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM spark.platform_role_assignments r WHERE r.user_id = actor AND r.role = 'super_admin' AND r.revoked_at IS NULL) THEN
    RETURN 'forbidden';
  END IF;
  UPDATE spark.users SET status = p_status WHERE id = p_target AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF p_status = 'suspended' THEN
    UPDATE spark.sessions SET revoked_at = now() WHERE user_id = p_target AND revoked_at IS NULL;
  END IF;
  RETURN 'ok';
END $$;
--> statement-breakpoint
CREATE FUNCTION spark.staff_grant_role(p_target uuid, p_role text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_platform_role(ARRAY['super_admin']);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM spark.users u WHERE u.id = p_target AND u.status = 'active' AND u.deleted_at IS NULL) THEN RETURN 'not_found'; END IF;
  INSERT INTO spark.platform_role_assignments (user_id, role, granted_by_user_id) VALUES (p_target, p_role, actor);
  RETURN 'granted';
EXCEPTION WHEN unique_violation THEN RETURN 'exists';
END $$;
--> statement-breakpoint
CREATE FUNCTION spark.staff_revoke_role(p_target uuid, p_role text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin']);
  IF p_role = 'super_admin' THEN
    -- Lock every active super_admin row so concurrent revocations cannot remove the last one.
    PERFORM 1 FROM spark.platform_role_assignments r WHERE r.role = 'super_admin' AND r.revoked_at IS NULL FOR UPDATE;
    IF (SELECT count(*) FROM spark.platform_role_assignments r WHERE r.role = 'super_admin' AND r.revoked_at IS NULL) <= 1
       AND EXISTS (SELECT 1 FROM spark.platform_role_assignments r WHERE r.user_id = p_target AND r.role = 'super_admin' AND r.revoked_at IS NULL) THEN
      RETURN 'last_super_admin';
    END IF;
  END IF;
  UPDATE spark.platform_role_assignments SET revoked_at = now() WHERE user_id = p_target AND role = p_role AND revoked_at IS NULL;
  RETURN CASE WHEN FOUND THEN 'revoked' ELSE 'not_found' END;
END $$;
--> statement-breakpoint
CREATE FUNCTION spark.staff_review_campaign(p_campaign uuid, p_decision text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_platform_role(ARRAY['super_admin','platform_admin','campaign_moderator']);
  campaign spark.promotion_campaigns%ROWTYPE;
BEGIN
  IF p_decision NOT IN ('approve','reject') OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'Invalid campaign review' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO campaign FROM spark.promotion_campaigns c WHERE c.id = p_campaign FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  UPDATE spark.promotion_campaigns SET
    review_status = CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END,
    delivery_status = CASE p_decision WHEN 'approve' THEN 'scheduled' ELSE 'unscheduled' END,
    approved_version = CASE p_decision WHEN 'approve' THEN campaign.version END,
    starts_at = CASE p_decision WHEN 'approve' THEN campaign.requested_start_at END
  WHERE id = campaign.id;
  INSERT INTO spark.promotion_reviews (tenant_id, campaign_id, campaign_version, reviewer_user_id, decision, reason)
    VALUES (campaign.tenant_id, campaign.id, campaign.version, actor, p_decision, btrim(p_reason));
  RETURN 'ok';
END $$;
--> statement-breakpoint
CREATE FUNCTION spark.staff_active_session_count() RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin']);
  RETURN (SELECT count(*) FROM spark.sessions s WHERE s.revoked_at IS NULL AND s.expires_at > now());
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.session_actor(), spark.has_platform_role(text[]), spark.require_platform_role(text[]),
  spark.auth_register_password(text,text,text,bytea,timestamptz), spark.auth_password_login(text), spark.auth_start_session(uuid,bytea,timestamptz),
  spark.auth_session_principal(bytea), spark.auth_revoke_session(bytea), spark.staff_overview(), spark.staff_list_reports(text,integer),
  spark.staff_resolve_report(uuid,text,text), spark.staff_open_report_counts(uuid[]), spark.staff_set_community_archived(uuid,boolean),
  spark.staff_user_roles(uuid[]), spark.staff_set_user_status(uuid,text), spark.staff_grant_role(uuid,text), spark.staff_revoke_role(uuid,text),
  spark.staff_review_campaign(uuid,text,text), spark.staff_active_session_count() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION spark.has_platform_role(text[]),
  spark.auth_register_password(text,text,text,bytea,timestamptz), spark.auth_password_login(text), spark.auth_start_session(uuid,bytea,timestamptz),
  spark.auth_session_principal(bytea), spark.auth_revoke_session(bytea), spark.staff_overview(), spark.staff_list_reports(text,integer),
  spark.staff_resolve_report(uuid,text,text), spark.staff_open_report_counts(uuid[]), spark.staff_set_community_archived(uuid,boolean),
  spark.staff_user_roles(uuid[]), spark.staff_set_user_status(uuid,text), spark.staff_grant_role(uuid,text), spark.staff_revoke_role(uuid,text),
  spark.staff_review_campaign(uuid,text,text), spark.staff_active_session_count() TO spark_app;
