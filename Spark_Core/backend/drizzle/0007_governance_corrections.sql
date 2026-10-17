-- Corrections from the independent correctness and security reviews of 0006.
-- Known limitation: password verification happens in the application (Argon2id), so any code
-- running as spark_app can still call auth_password_login/auth_start_session. Session binding
-- protects against application logic errors, not against a fully compromised runtime role.
CREATE OR REPLACE FUNCTION spark.require_platform_role(allowed text[]) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.session_actor();
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Live session required' USING ERRCODE = '28000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM spark.platform_role_assignments r
      WHERE r.user_id = actor AND r.revoked_at IS NULL AND r.role = ANY(allowed)) THEN
    RAISE EXCEPTION 'Platform role required' USING ERRCODE = '42501';
  END IF;
  RETURN actor;
END $$;
--> statement-breakpoint
-- Registration no longer claims the email is verified; verification needs its own token flow.
CREATE OR REPLACE FUNCTION spark.auth_register_password(p_display_name text, p_email text, p_password_hash text, p_token_hash bytea, p_expires_at timestamptz)
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
    VALUES (new_user, btrim(p_email), lower(btrim(p_email)), true, NULL);
  INSERT INTO spark.password_credentials (user_id, password_hash) VALUES (new_user, p_password_hash);
  slug := 'ws-' || left(replace(new_user::text, '-', ''), 10);
  ws_name := clean_name || '''s Space';
  INSERT INTO spark.workspaces (slug, name, status, created_by_user_id) VALUES (slug, ws_name, 'active', new_user) RETURNING id INTO new_workspace;
  INSERT INTO spark.workspace_memberships (tenant_id, user_id, role, status) VALUES (new_workspace, new_user, 'owner', 'active');
  INSERT INTO spark.sessions (user_id, token_hash, auth_method, expires_at, last_seen_at) VALUES (new_user, p_token_hash, 'password', p_expires_at, now());
  RETURN QUERY SELECT new_user, new_workspace, ws_name, slug;
END $$;
--> statement-breakpoint
-- Versioned rows must advance by exactly one (maintain_record). Closed reports cannot be re-actioned.
CREATE OR REPLACE FUNCTION spark.staff_resolve_report(p_report uuid, p_action text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_platform_role(ARRAY['super_admin','platform_admin','content_moderator']);
  report spark.content_reports%ROWTYPE;
BEGIN
  IF p_action NOT IN ('hide','restore','dismiss_report') OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'Invalid moderation action' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO report FROM spark.content_reports r WHERE r.id = p_report FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF report.status NOT IN ('open','reviewing') THEN RETURN 'already_closed'; END IF;
  IF p_action IN ('hide','restore') THEN
    UPDATE spark.posts SET moderation_status = CASE p_action WHEN 'hide' THEN 'hidden' ELSE 'visible' END, version = version + 1
      WHERE id = report.post_id AND tenant_id = report.tenant_id;
    UPDATE spark.post_comments SET moderation_status = CASE p_action WHEN 'hide' THEN 'hidden' ELSE 'visible' END, version = version + 1
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
-- Only pending campaigns are reviewed. The review records the new version, which approval pins.
-- Delivery scheduling stays a separate step because it requires a paid order (check_campaign_lifecycle).
CREATE OR REPLACE FUNCTION spark.staff_review_campaign(p_campaign uuid, p_decision text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_platform_role(ARRAY['super_admin','platform_admin','campaign_moderator']);
  campaign spark.promotion_campaigns%ROWTYPE; next_version integer;
BEGIN
  IF p_decision NOT IN ('approve','reject') OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'Invalid campaign review' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO campaign FROM spark.promotion_campaigns c WHERE c.id = p_campaign FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF campaign.review_status <> 'pending' THEN RETURN 'not_pending'; END IF;
  next_version := campaign.version + 1;
  UPDATE spark.promotion_campaigns SET
    review_status = CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END,
    approved_version = CASE p_decision WHEN 'approve' THEN next_version END,
    version = next_version
  WHERE id = campaign.id;
  INSERT INTO spark.promotion_reviews (tenant_id, campaign_id, campaign_version, reviewer_user_id, decision, reason)
    VALUES (campaign.tenant_id, campaign.id, next_version, actor, p_decision, btrim(p_reason));
  RETURN 'ok';
END $$;
--> statement-breakpoint
-- Admin-tier accounts (platform_admin, super_admin) can only be changed by a super_admin.
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
  UPDATE spark.users SET status = p_status WHERE id = p_target AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF p_status = 'suspended' THEN
    UPDATE spark.sessions SET revoked_at = now() WHERE user_id = p_target AND revoked_at IS NULL;
  END IF;
  RETURN 'ok';
END $$;
--> statement-breakpoint
-- The last-super-admin guard counts only assignments held by active users.
CREATE OR REPLACE FUNCTION spark.staff_revoke_role(p_target uuid, p_role text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin']);
  IF p_role = 'super_admin' THEN
    PERFORM 1 FROM spark.platform_role_assignments r WHERE r.role = 'super_admin' AND r.revoked_at IS NULL FOR UPDATE;
    IF EXISTS (SELECT 1 FROM spark.platform_role_assignments r WHERE r.user_id = p_target AND r.role = 'super_admin' AND r.revoked_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM spark.platform_role_assignments r JOIN spark.users u ON u.id = r.user_id
         WHERE r.role = 'super_admin' AND r.revoked_at IS NULL AND r.user_id <> p_target AND u.status = 'active' AND u.deleted_at IS NULL) THEN
      RETURN 'last_super_admin';
    END IF;
  END IF;
  UPDATE spark.platform_role_assignments SET revoked_at = now() WHERE user_id = p_target AND role = p_role AND revoked_at IS NULL;
  RETURN CASE WHEN FOUND THEN 'revoked' ELSE 'not_found' END;
END $$;
--> statement-breakpoint
-- Platform staff moderate across communities they do not belong to. Replace the membership-only
-- foreign key with a check that accepts community owners/moderators or active platform moderators.
ALTER TABLE spark.moderation_actions DROP CONSTRAINT moderation_actions_fk_117;
DROP INDEX spark.moderation_actions_fk_117_idx;
CREATE FUNCTION spark.check_moderation_actor() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM spark.community_memberships m
      WHERE m.tenant_id = NEW.tenant_id AND m.community_id = NEW.community_id AND m.user_id = NEW.actor_user_id
        AND m.status = 'active' AND m.role IN ('owner','moderator'))
     AND NOT EXISTS (SELECT 1 FROM spark.platform_role_assignments r
      WHERE r.user_id = NEW.actor_user_id AND r.revoked_at IS NULL AND r.role IN ('super_admin','platform_admin','content_moderator')) THEN
    RAISE EXCEPTION 'Moderation actor must be a community moderator or platform content moderator' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER moderation_actor BEFORE INSERT ON spark.moderation_actions FOR EACH ROW EXECUTE FUNCTION spark.check_moderation_actor();
REVOKE EXECUTE ON FUNCTION spark.check_moderation_actor() FROM PUBLIC, spark_app;
