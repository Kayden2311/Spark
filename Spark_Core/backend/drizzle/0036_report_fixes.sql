-- Fixes to 0034. CREATE OR REPLACE with unchanged signatures.
-- 1. A NOT VALID check is still enforced on every UPDATE, so a legacy report whose reason_code is free
--    text (the old seed's 'Potential spam / solicitation', 'abuse') could not be resolved or dismissed
--    (23514). Rows outside the closed reason set become 'other', then the constraint is validated.
-- 2. staff_resolve_report (0009) locked the report and then updated the post, while ws_moderate_content
--    (0034) locks the post and then its reports: the two could deadlock. It now reads the report's target
--    without a lock, locks the post (and comment) first, then the report, and re-checks the report's status.
-- 3. ws_report_content answered already_reported with a NULL id when the conflicting report closed between
--    the insert conflict and the re-select; the insert is now retried once, and a second miss is a
--    serialization failure (40001) instead of a NULL answer.
UPDATE spark.content_reports SET reason_code = 'other'
  WHERE reason_code NOT IN ('spam','harassment','off_topic','misinformation','self_promotion','other');
--> statement-breakpoint
ALTER TABLE spark.content_reports VALIDATE CONSTRAINT content_reports_reason_allowed;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION spark.staff_resolve_report(p_report uuid, p_action text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_platform_role(ARRAY['super_admin','platform_admin','content_moderator']);
  report spark.content_reports%ROWTYPE; label text; locked_post uuid;
BEGIN
  IF p_action NOT IN ('hide','restore','dismiss_report') THEN
    RAISE EXCEPTION 'Invalid moderation action' USING ERRCODE = '22023';
  END IF;
  PERFORM spark.require_reason(p_reason);
  -- Lock order shared with ws_moderate_content: post, then comment, then report.
  SELECT * INTO report FROM spark.content_reports r WHERE r.id = p_report;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF report.comment_id IS NOT NULL THEN
    SELECT pc.post_id INTO locked_post FROM spark.post_comments pc WHERE pc.id = report.comment_id AND pc.tenant_id = report.tenant_id;
    PERFORM 1 FROM spark.posts p WHERE p.id = locked_post AND p.tenant_id = report.tenant_id FOR SHARE;
    PERFORM 1 FROM spark.post_comments pc WHERE pc.id = report.comment_id AND pc.tenant_id = report.tenant_id FOR UPDATE;
  ELSE
    PERFORM 1 FROM spark.posts p WHERE p.id = report.post_id AND p.tenant_id = report.tenant_id FOR UPDATE;
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
  SELECT c.name INTO label FROM spark.communities c WHERE c.id = report.community_id;
  PERFORM spark.record_platform_audit(actor, CASE p_action WHEN 'dismiss_report' THEN 'report.dismiss' ELSE 'report.' || p_action END,
    'report', report.id, 'Report in ' || coalesce(label, 'unknown community'), p_reason,
    jsonb_build_object('reasonCode', report.reason_code, 'targetKind', CASE WHEN report.comment_id IS NOT NULL THEN 'comment' ELSE 'post' END));
  RETURN 'ok';
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION spark.ws_report_content(p_kind text, p_target uuid, p_reason text, p_details text)
RETURNS TABLE(outcome text, report_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); clean_details text := nullif(btrim(p_details), '');
  target_community uuid; target_post_id uuid; target spark.communities%ROWTYPE; target_post spark.posts%ROWTYPE; target_comment spark.post_comments%ROWTYPE;
  author uuid; existing uuid; created uuid;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('post','comment') THEN RAISE EXCEPTION 'Invalid report target' USING ERRCODE = '22023'; END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('spam','harassment','off_topic','misinformation','self_promotion','other') THEN
    RAISE EXCEPTION 'Invalid report reason' USING ERRCODE = '22023';
  END IF;
  IF clean_details IS NOT NULL AND length(clean_details) > 1000 THEN RAISE EXCEPTION 'Invalid report details' USING ERRCODE = '22023'; END IF;
  IF p_kind = 'post' THEN
    SELECT p.community_id, p.id INTO target_community, target_post_id FROM spark.posts p WHERE p.id = p_target;
  ELSE
    SELECT pc.community_id, pc.post_id INTO target_community, target_post_id FROM spark.post_comments pc WHERE pc.id = p_target;
  END IF;
  IF target_community IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid; RETURN; END IF;
  target := spark.lock_community_content(target_community);
  IF target.id IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid; RETURN; END IF;
  SELECT * INTO target_post FROM spark.posts p WHERE p.id = target_post_id AND p.tenant_id = target.tenant_id FOR SHARE;
  IF NOT FOUND OR NOT spark.can_read_post(target_post.tenant_id, target_post.id) THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid; RETURN; END IF;
  IF p_kind = 'post' THEN
    author := target_post.author_user_id;
  ELSE
    SELECT * INTO target_comment FROM spark.post_comments pc WHERE pc.id = p_target AND pc.tenant_id = target.tenant_id FOR SHARE;
    IF NOT FOUND OR target_comment.deleted_at IS NOT NULL
        OR (target_comment.moderation_status <> 'visible' AND NOT spark.can_moderate_community(target.id)) THEN
      RETURN QUERY SELECT 'not_found'::text, NULL::uuid; RETURN;
    END IF;
    author := target_comment.author_user_id;
  END IF;
  IF author = actor THEN RETURN QUERY SELECT 'own_content'::text, NULL::uuid; RETURN; END IF;

  -- The loop retries the insert once: the report that made it conflict may close before the re-select.
  FOR attempt IN 1..2 LOOP
    SELECT r.id INTO existing FROM spark.content_reports r
      WHERE r.tenant_id = target.tenant_id AND r.reporter_user_id = actor AND r.status IN ('open','reviewing')
        AND ((p_kind = 'post' AND r.post_id = p_target) OR (p_kind = 'comment' AND r.comment_id = p_target));
    IF existing IS NOT NULL THEN RETURN QUERY SELECT 'already_reported'::text, existing; RETURN; END IF;
    INSERT INTO spark.content_reports (tenant_id, community_id, reporter_user_id, post_id, comment_id, reason_code, details)
      VALUES (target.tenant_id, target.id, actor, CASE WHEN p_kind = 'post' THEN p_target END, CASE WHEN p_kind = 'comment' THEN p_target END,
        p_reason, clean_details)
      ON CONFLICT DO NOTHING RETURNING id INTO created;
    IF created IS NOT NULL THEN RETURN QUERY SELECT 'reported'::text, created; RETURN; END IF;
  END LOOP;
  RAISE EXCEPTION 'Report could not be recorded' USING ERRCODE = '40001';
END $$;
