-- Platform governance: one append-only audit log for every staff action, community feature/freeze
-- states enforced by the database, reasons on every governance write, and keyset-paged staff reads.
-- Every write function records its audit row in the same transaction as the change it describes.
CREATE TABLE spark.platform_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  actor_user_id uuid NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  target_label text NOT NULL,
  reason text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  CONSTRAINT platform_audit_events_action_allowed CHECK (action IN (
    'report.hide','report.restore','report.dismiss',
    'community.feature','community.unfeature','community.freeze','community.unfreeze','community.archive','community.restore',
    'user.suspend','user.reactivate','role.grant','role.revoke','campaign.approve','campaign.reject')),
  CONSTRAINT platform_audit_events_target_allowed CHECK (target_type IN ('report','community','user','campaign')),
  -- Role changes target the user who gains or loses the role.
  CONSTRAINT platform_audit_events_action_target CHECK (
    split_part(action, '.', 1) = target_type OR (target_type = 'user' AND split_part(action, '.', 1) = 'role')),
  CONSTRAINT platform_audit_events_reason_length CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  CONSTRAINT platform_audit_events_label_length CHECK (length(target_label) BETWEEN 1 AND 200),
  CONSTRAINT platform_audit_events_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT platform_audit_events_actor_fk FOREIGN KEY (actor_user_id) REFERENCES spark.users (id) ON DELETE RESTRICT
);
--> statement-breakpoint
ALTER TABLE spark.platform_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE spark.platform_audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_maintenance ON spark.platform_audit_events TO spark_owner USING (true) WITH CHECK (true);
CREATE POLICY staff_read ON spark.platform_audit_events FOR SELECT TO spark_app
  USING ((SELECT spark.has_platform_role(ARRAY['super_admin','platform_admin'])));
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON spark.platform_audit_events FOR EACH ROW EXECUTE FUNCTION spark.reject_history_change();
CREATE INDEX platform_audit_events_created_idx ON spark.platform_audit_events (created_at DESC, id DESC);
CREATE INDEX platform_audit_events_target_idx ON spark.platform_audit_events (target_type, target_id, created_at DESC);
CREATE INDEX platform_audit_events_actor_idx ON spark.platform_audit_events (actor_user_id);
-- Read-only for the runtime role; rows are written only by the definer functions below.
GRANT SELECT ON spark.platform_audit_events TO spark_app;
--> statement-breakpoint
-- Community moderation states. Archiving clears both flags, so an archived community is never featured or frozen.
ALTER TABLE spark.communities ADD COLUMN featured_at timestamp with time zone, ADD COLUMN frozen_at timestamp with time zone;
ALTER TABLE spark.communities ADD CONSTRAINT communities_archived_state CHECK (archived_at IS NULL OR (featured_at IS NULL AND frozen_at IS NULL));
ALTER TABLE spark.communities ADD CONSTRAINT communities_frozen_not_featured CHECK (frozen_at IS NULL OR featured_at IS NULL);
CREATE INDEX communities_created_id_idx ON spark.communities (created_at DESC, id DESC);
CREATE INDEX users_created_id_idx ON spark.users (created_at DESC, id DESC);
CREATE INDEX content_reports_status_created_idx ON spark.content_reports (status, created_at DESC, id DESC);
--> statement-breakpoint
-- Frozen communities reject new posts and comments; archived communities are read-only. The share lock
-- serializes inserts with a concurrent freeze or archive. Definer rights make the check independent of
-- the inserting role's row visibility, so a hidden community cannot make the check pass.
CREATE FUNCTION spark.check_community_open() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM spark.communities c
    WHERE c.id = NEW.community_id AND c.tenant_id = NEW.tenant_id AND c.archived_at IS NULL AND c.frozen_at IS NULL
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Community is frozen or archived' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER community_open BEFORE INSERT ON spark.posts FOR EACH ROW EXECUTE FUNCTION spark.check_community_open();
CREATE TRIGGER community_open BEFORE INSERT ON spark.post_comments FOR EACH ROW EXECUTE FUNCTION spark.check_community_open();
REVOKE EXECUTE ON FUNCTION spark.check_community_open() FROM PUBLIC;
--> statement-breakpoint
-- Writes one audit row. Internal helper: callers have already authorized the actor.
CREATE FUNCTION spark.record_platform_audit(p_actor uuid, p_action text, p_target_type text, p_target uuid, p_label text, p_reason text, p_metadata jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO spark.platform_audit_events (actor_user_id, action, target_type, target_id, target_label, reason, metadata)
  VALUES (p_actor, p_action, p_target_type, p_target, left(coalesce(nullif(btrim(p_label), ''), 'Unnamed'), 200), btrim(p_reason), coalesce(p_metadata, '{}'::jsonb));
$$;
REVOKE ALL ON FUNCTION spark.record_platform_audit(uuid,text,text,uuid,text,text,jsonb) FROM PUBLIC;
--> statement-breakpoint
-- Shared reason validation for every governance write.
CREATE FUNCTION spark.require_reason(p_reason text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'A reason of 3 to 500 characters is required' USING ERRCODE = '22023';
  END IF;
END $$;
REVOKE ALL ON FUNCTION spark.require_reason(text) FROM PUBLIC;
--> statement-breakpoint
DROP FUNCTION spark.staff_overview();
DROP FUNCTION spark.staff_list_reports(text, integer);
DROP FUNCTION spark.staff_set_community_archived(uuid, boolean);
DROP FUNCTION spark.staff_set_user_status(uuid, text);
DROP FUNCTION spark.staff_grant_role(uuid, text);
DROP FUNCTION spark.staff_revoke_role(uuid, text);
DROP FUNCTION spark.staff_open_report_counts(uuid[]);
DROP FUNCTION spark.staff_user_roles(uuid[]);
--> statement-breakpoint
CREATE FUNCTION spark.staff_overview()
RETURNS TABLE(active_communities bigint, featured_communities bigint, frozen_communities bigint, archived_communities bigint,
  flagged_communities bigint, active_users bigint, suspended_users bigint, open_reports bigint, pending_campaigns bigint,
  approved_campaigns bigint, active_workspaces bigint, audit_events bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin','community_moderator','content_moderator','campaign_moderator']);
  RETURN QUERY SELECT
    (SELECT count(*) FROM spark.communities c WHERE c.archived_at IS NULL),
    (SELECT count(*) FROM spark.communities c WHERE c.featured_at IS NOT NULL),
    (SELECT count(*) FROM spark.communities c WHERE c.frozen_at IS NOT NULL),
    (SELECT count(*) FROM spark.communities c WHERE c.archived_at IS NOT NULL),
    (SELECT count(DISTINCT r.community_id) FROM spark.content_reports r WHERE r.status IN ('open','reviewing')),
    (SELECT count(*) FROM spark.users u WHERE u.status = 'active' AND u.deleted_at IS NULL),
    (SELECT count(*) FROM spark.users u WHERE u.status = 'suspended' AND u.deleted_at IS NULL),
    (SELECT count(*) FROM spark.content_reports r WHERE r.status IN ('open','reviewing')),
    (SELECT count(*) FROM spark.promotion_campaigns p WHERE p.review_status = 'pending'),
    (SELECT count(*) FROM spark.promotion_campaigns p WHERE p.review_status = 'approved'),
    (SELECT count(*) FROM spark.workspaces w WHERE w.archived_at IS NULL),
    (SELECT count(*) FROM spark.platform_audit_events a);
END $$;
--> statement-breakpoint
-- Keyset-paged report queue, newest first. p_report fetches one report regardless of status.
-- Reporter identity is returned only to staff holding a reports role.
CREATE FUNCTION spark.staff_list_reports(p_status text, p_report uuid, p_before_ts timestamptz, p_before_id uuid, p_limit integer)
RETURNS TABLE(id uuid, tenant_id uuid, community_id uuid, post_id uuid, comment_id uuid, reporter_user_id uuid, reporter_name text,
  reason_code text, details text, status text, created_at timestamptz, resolved_at timestamptz, community_name text, community_slug text,
  post_title text, post_body text, post_moderation_status text, comment_body text, comment_moderation_status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin','content_moderator']);
  IF p_report IS NULL AND p_status NOT IN ('open','reviewing','resolved','dismissed') THEN
    RAISE EXCEPTION 'Invalid report status' USING ERRCODE = '22023';
  END IF;
  IF (p_before_ts IS NULL) <> (p_before_id IS NULL) THEN
    RAISE EXCEPTION 'Invalid cursor' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT r.id, r.tenant_id, r.community_id, r.post_id, r.comment_id, r.reporter_user_id, u.display_name,
    r.reason_code, r.details, r.status, r.created_at, r.resolved_at, c.name, c.slug,
    p.title, p.body, p.moderation_status, pc.body, pc.moderation_status
  FROM spark.content_reports r
  LEFT JOIN spark.users u ON u.id = r.reporter_user_id
  LEFT JOIN spark.communities c ON c.id = r.community_id
  LEFT JOIN spark.posts p ON p.id = r.post_id AND p.tenant_id = r.tenant_id
  LEFT JOIN spark.post_comments pc ON pc.id = r.comment_id AND pc.tenant_id = r.tenant_id
  WHERE (p_report IS NOT NULL AND r.id = p_report)
     OR (p_report IS NULL AND r.status = p_status AND (p_before_ts IS NULL OR (r.created_at, r.id) < (p_before_ts, p_before_id)))
  ORDER BY r.created_at DESC, r.id DESC
  LIMIT least(greatest(coalesce(p_limit, 25), 1), 101);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION spark.staff_resolve_report(p_report uuid, p_action text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_platform_role(ARRAY['super_admin','platform_admin','content_moderator']);
  report spark.content_reports%ROWTYPE; label text;
BEGIN
  IF p_action NOT IN ('hide','restore','dismiss_report') THEN
    RAISE EXCEPTION 'Invalid moderation action' USING ERRCODE = '22023';
  END IF;
  PERFORM spark.require_reason(p_reason);
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
  SELECT c.name INTO label FROM spark.communities c WHERE c.id = report.community_id;
  PERFORM spark.record_platform_audit(actor, CASE p_action WHEN 'dismiss_report' THEN 'report.dismiss' ELSE 'report.' || p_action END,
    'report', report.id, 'Report in ' || coalesce(label, 'unknown community'), p_reason,
    jsonb_build_object('reasonCode', report.reason_code, 'targetKind', CASE WHEN report.comment_id IS NOT NULL THEN 'comment' ELSE 'post' END));
  RETURN 'ok';
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION spark.staff_review_campaign(p_campaign uuid, p_decision text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_platform_role(ARRAY['super_admin','platform_admin','campaign_moderator']);
  campaign spark.promotion_campaigns%ROWTYPE; next_version integer;
BEGIN
  IF p_decision NOT IN ('approve','reject') THEN
    RAISE EXCEPTION 'Invalid campaign review' USING ERRCODE = '22023';
  END IF;
  PERFORM spark.require_reason(p_reason);
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
  PERFORM spark.record_platform_audit(actor, 'campaign.' || p_decision, 'campaign', campaign.id, campaign.name, p_reason,
    jsonb_build_object('version', next_version));
  RETURN 'ok';
END $$;
--> statement-breakpoint
-- Community moderation with explicit transitions:
--   feature    active, not frozen, not featured      unfeature  featured
--   freeze     not archived, not frozen (unfeatures)  unfreeze   frozen
--   archive    not archived (clears both flags)       restore    archived
CREATE FUNCTION spark.staff_moderate_community(p_community uuid, p_action text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_platform_role(ARRAY['super_admin','platform_admin','community_moderator']);
  community spark.communities%ROWTYPE; previous text;
BEGIN
  IF p_action NOT IN ('feature','unfeature','freeze','unfreeze','archive','restore') THEN
    RAISE EXCEPTION 'Invalid community action' USING ERRCODE = '22023';
  END IF;
  PERFORM spark.require_reason(p_reason);
  SELECT * INTO community FROM spark.communities c WHERE c.id = p_community FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  previous := CASE WHEN community.archived_at IS NOT NULL THEN 'archived' WHEN community.frozen_at IS NOT NULL THEN 'frozen'
    WHEN community.featured_at IS NOT NULL THEN 'featured' ELSE 'active' END;
  IF (p_action = 'feature' AND previous <> 'active')
     OR (p_action = 'unfeature' AND previous <> 'featured')
     OR (p_action = 'freeze' AND previous NOT IN ('active','featured'))
     OR (p_action = 'unfreeze' AND previous <> 'frozen')
     OR (p_action = 'archive' AND previous = 'archived')
     OR (p_action = 'restore' AND previous <> 'archived') THEN
    RETURN 'invalid_transition';
  END IF;
  UPDATE spark.communities SET
    featured_at = CASE p_action WHEN 'feature' THEN now() WHEN 'unfeature' THEN NULL WHEN 'freeze' THEN NULL WHEN 'archive' THEN NULL ELSE featured_at END,
    frozen_at = CASE p_action WHEN 'freeze' THEN now() WHEN 'unfreeze' THEN NULL WHEN 'archive' THEN NULL ELSE frozen_at END,
    archived_at = CASE p_action WHEN 'archive' THEN now() WHEN 'restore' THEN NULL ELSE archived_at END
  WHERE id = community.id;
  PERFORM spark.record_platform_audit(actor, 'community.' || p_action, 'community', community.id, community.name, p_reason,
    jsonb_build_object('previousState', previous));
  RETURN 'ok';
END $$;
--> statement-breakpoint
-- NULL returns open-report counts for every community that has any (used by the "flagged" filter).
CREATE FUNCTION spark.staff_open_report_counts(p_communities uuid[])
RETURNS TABLE(community_id uuid, open_reports bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin','community_moderator','content_moderator']);
  RETURN QUERY SELECT r.community_id, count(*) FROM spark.content_reports r
    WHERE (p_communities IS NULL OR r.community_id = ANY(p_communities)) AND r.status IN ('open','reviewing')
    GROUP BY r.community_id;
END $$;
--> statement-breakpoint
-- NULL returns every active assignment (used by the role filter); staff rosters are small.
CREATE FUNCTION spark.staff_user_roles(p_users uuid[])
RETURNS TABLE(user_id uuid, role text, granted_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin']);
  RETURN QUERY SELECT r.user_id, r.role, r.created_at FROM spark.platform_role_assignments r
    WHERE (p_users IS NULL OR r.user_id = ANY(p_users)) AND r.revoked_at IS NULL ORDER BY r.created_at;
END $$;
--> statement-breakpoint
CREATE FUNCTION spark.staff_user_session_count(p_user uuid) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin']);
  RETURN (SELECT count(*) FROM spark.sessions s WHERE s.user_id = p_user AND s.revoked_at IS NULL AND s.expires_at > now());
END $$;
--> statement-breakpoint
-- Admin-tier accounts can only be changed by a super admin; suspending a super admin takes the same
-- row locks as revoking the role (see 0008). A no-op change returns 'unchanged' and records nothing.
CREATE FUNCTION spark.staff_set_user_status(p_target uuid, p_status text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_platform_role(ARRAY['super_admin','platform_admin']);
  target spark.users%ROWTYPE;
BEGIN
  IF p_status NOT IN ('active','suspended') THEN RAISE EXCEPTION 'Invalid user status' USING ERRCODE = '22023'; END IF;
  PERFORM spark.require_reason(p_reason);
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
  SELECT * INTO target FROM spark.users u WHERE u.id = p_target AND u.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF target.status = p_status THEN RETURN 'unchanged'; END IF;
  UPDATE spark.users SET status = p_status WHERE id = p_target;
  IF p_status = 'suspended' THEN
    UPDATE spark.sessions SET revoked_at = now() WHERE user_id = p_target AND revoked_at IS NULL;
  END IF;
  PERFORM spark.record_platform_audit(actor, CASE p_status WHEN 'suspended' THEN 'user.suspend' ELSE 'user.reactivate' END,
    'user', p_target, target.display_name, p_reason, jsonb_build_object('previousStatus', target.status));
  RETURN 'ok';
END $$;
--> statement-breakpoint
CREATE FUNCTION spark.staff_grant_role(p_target uuid, p_role text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_platform_role(ARRAY['super_admin']); label text;
BEGIN
  PERFORM spark.require_reason(p_reason);
  SELECT u.display_name INTO label FROM spark.users u WHERE u.id = p_target AND u.status = 'active' AND u.deleted_at IS NULL;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  BEGIN
    INSERT INTO spark.platform_role_assignments (user_id, role, granted_by_user_id) VALUES (p_target, p_role, actor);
  EXCEPTION WHEN unique_violation THEN RETURN 'exists';
  END;
  PERFORM spark.record_platform_audit(actor, 'role.grant', 'user', p_target, label, p_reason, jsonb_build_object('role', p_role));
  RETURN 'granted';
END $$;
--> statement-breakpoint
-- The last-super-admin guard counts only assignments held by active users (see 0007).
CREATE FUNCTION spark.staff_revoke_role(p_target uuid, p_role text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_platform_role(ARRAY['super_admin']); label text;
BEGIN
  PERFORM spark.require_reason(p_reason);
  IF p_role = 'super_admin' THEN
    PERFORM 1 FROM spark.platform_role_assignments r WHERE r.role = 'super_admin' AND r.revoked_at IS NULL FOR UPDATE;
    IF EXISTS (SELECT 1 FROM spark.platform_role_assignments r WHERE r.user_id = p_target AND r.role = 'super_admin' AND r.revoked_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM spark.platform_role_assignments r JOIN spark.users u ON u.id = r.user_id
         WHERE r.role = 'super_admin' AND r.revoked_at IS NULL AND r.user_id <> p_target AND u.status = 'active' AND u.deleted_at IS NULL) THEN
      RETURN 'last_super_admin';
    END IF;
  END IF;
  UPDATE spark.platform_role_assignments SET revoked_at = now() WHERE user_id = p_target AND role = p_role AND revoked_at IS NULL;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  SELECT u.display_name INTO label FROM spark.users u WHERE u.id = p_target;
  PERFORM spark.record_platform_audit(actor, 'role.revoke', 'user', p_target, label, p_reason, jsonb_build_object('role', p_role));
  RETURN 'revoked';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.staff_overview(), spark.staff_list_reports(text,uuid,timestamptz,uuid,integer),
  spark.staff_resolve_report(uuid,text,text), spark.staff_review_campaign(uuid,text,text), spark.staff_moderate_community(uuid,text,text),
  spark.staff_open_report_counts(uuid[]), spark.staff_user_roles(uuid[]), spark.staff_user_session_count(uuid),
  spark.staff_set_user_status(uuid,text,text), spark.staff_grant_role(uuid,text,text), spark.staff_revoke_role(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION spark.staff_overview(), spark.staff_list_reports(text,uuid,timestamptz,uuid,integer),
  spark.staff_resolve_report(uuid,text,text), spark.staff_review_campaign(uuid,text,text), spark.staff_moderate_community(uuid,text,text),
  spark.staff_open_report_counts(uuid[]), spark.staff_user_roles(uuid[]), spark.staff_user_session_count(uuid),
  spark.staff_set_user_status(uuid,text,text), spark.staff_grant_role(uuid,text,text), spark.staff_revoke_role(uuid,text,text) TO spark_app;
