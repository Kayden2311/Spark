-- Corrections from the independent correctness and security reviews of 0009.
-- The platform audit log also rejects TRUNCATE (UPDATE and DELETE were already rejected per row).
CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON spark.platform_audit_events FOR EACH STATEMENT EXECUTE FUNCTION spark.reject_history_change();
--> statement-breakpoint
-- A frozen or archived community cannot be promoted; rejecting the campaign stays possible.
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
  IF p_decision = 'approve' AND EXISTS (SELECT 1 FROM spark.communities c
      WHERE c.id = campaign.community_id AND (c.archived_at IS NOT NULL OR c.frozen_at IS NOT NULL)) THEN
    RETURN 'community_unavailable';
  END IF;
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
-- Lock the target user before the admin-tier check. A concurrent role grant key-share locks this row
-- through its foreign key, so it can no longer slip in between the check and the status change.
CREATE OR REPLACE FUNCTION spark.staff_set_user_status(p_target uuid, p_status text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_platform_role(ARRAY['super_admin','platform_admin']);
  target spark.users%ROWTYPE;
BEGIN
  IF p_status NOT IN ('active','suspended') THEN RAISE EXCEPTION 'Invalid user status' USING ERRCODE = '22023'; END IF;
  PERFORM spark.require_reason(p_reason);
  IF p_target = actor AND p_status = 'suspended' THEN RETURN 'self'; END IF;
  SELECT * INTO target FROM spark.users u WHERE u.id = p_target AND u.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
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
  IF target.status = p_status THEN RETURN 'unchanged'; END IF;
  UPDATE spark.users SET status = p_status WHERE id = p_target;
  IF p_status = 'suspended' THEN
    UPDATE spark.sessions SET revoked_at = now() WHERE user_id = p_target AND revoked_at IS NULL;
  END IF;
  PERFORM spark.record_platform_audit(actor, CASE p_status WHEN 'suspended' THEN 'user.suspend' ELSE 'user.reactivate' END,
    'user', p_target, target.display_name, p_reason, jsonb_build_object('previousStatus', target.status));
  RETURN 'ok';
END $$;
