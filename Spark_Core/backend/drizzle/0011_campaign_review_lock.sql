-- Follow-up to 0010 from the fix verification: approving a campaign now share-locks its community, so
-- a concurrent freeze or archive (FOR UPDATE on that row) cannot commit between the "community is open"
-- check and the approval.
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
  IF p_decision = 'approve' THEN
    PERFORM 1 FROM spark.communities c
      WHERE c.id = campaign.community_id AND c.archived_at IS NULL AND c.frozen_at IS NULL
      FOR SHARE;
    IF NOT FOUND THEN RETURN 'community_unavailable'; END IF;
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
