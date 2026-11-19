-- C2 final review fixes.
-- 1. posts_body_length and post_comments_body_length (0032) were NOT VALID and still fired on UPDATE, so a legacy
--    blank or oversized body blocked author delete, ws_moderate_content and staff_resolve_report (23514).
--    Validating them checks existing rows once; a violating row makes this migration fail (report it, do not force).
-- 2. ws_moderate_content (0034): dismiss on the actor's own content is forbidden; hide and restore stay allowed.
ALTER TABLE spark.posts VALIDATE CONSTRAINT posts_body_length;
--> statement-breakpoint
ALTER TABLE spark.post_comments VALIDATE CONSTRAINT post_comments_body_length;
--> statement-breakpoint
-- A community owner or moderator hides, restores or dismisses reports on a post or comment, leaving a
-- moderation_actions record (the reason is trimmed 3-500). Outcomes: ok; unchanged (nothing to do: hide
-- of hidden content with no open report, restore of visible content, dismiss with no open report; no
-- rows are written); not_found (not readable by the actor: moderators read hidden content); forbidden
-- (readable but the actor does not moderate the community, or dismisses reports on their own content). Works while the community is frozen.
-- hide: status hidden and every open/reviewing report on the target resolved, one 'hide' row per
--   report, or one row without a report when none was open. dismiss: every open report dismissed, one
--   'dismiss_report' row per report; content unchanged. restore: status visible, one row without a
--   report; restore never closes reports. A status change bumps version and never sets edited_at.
CREATE OR REPLACE FUNCTION spark.ws_moderate_content(p_kind text, p_target uuid, p_action text, p_reason text)
RETURNS TABLE(outcome text, moderation_status text, reports_closed integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); clean_reason text := btrim(p_reason);
  target_community uuid; target_post_id uuid; target spark.communities%ROWTYPE; target_post spark.posts%ROWTYPE; target_comment spark.post_comments%ROWTYPE;
  current_status text; open_count integer; closed integer := 0; next_status text; close_status text; close_action text;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('post','comment') THEN RAISE EXCEPTION 'Invalid report target' USING ERRCODE = '22023'; END IF;
  IF p_action IS NULL OR p_action NOT IN ('hide','restore','dismiss') THEN RAISE EXCEPTION 'Invalid moderation action' USING ERRCODE = '22023'; END IF;
  IF clean_reason IS NULL OR length(clean_reason) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'Invalid moderation reason' USING ERRCODE = '22023'; END IF;
  IF p_kind = 'post' THEN
    SELECT p.community_id, p.id INTO target_community, target_post_id FROM spark.posts p WHERE p.id = p_target;
  ELSE
    SELECT pc.community_id, pc.post_id INTO target_community, target_post_id FROM spark.post_comments pc WHERE pc.id = p_target;
  END IF;
  IF target_community IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::integer; RETURN; END IF;
  target := spark.lock_community_content(target_community);
  IF target.id IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::integer; RETURN; END IF;
  IF p_kind = 'post' THEN
    SELECT * INTO target_post FROM spark.posts p WHERE p.id = target_post_id AND p.tenant_id = target.tenant_id FOR UPDATE;
    IF NOT FOUND OR NOT spark.can_read_post(target_post.tenant_id, target_post.id) THEN RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::integer; RETURN; END IF;
    current_status := target_post.moderation_status;
  ELSE
    SELECT * INTO target_post FROM spark.posts p WHERE p.id = target_post_id AND p.tenant_id = target.tenant_id FOR SHARE;
    IF NOT FOUND OR NOT spark.can_read_post(target_post.tenant_id, target_post.id) THEN RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::integer; RETURN; END IF;
    SELECT * INTO target_comment FROM spark.post_comments pc WHERE pc.id = p_target AND pc.tenant_id = target.tenant_id FOR UPDATE;
    IF NOT FOUND OR target_comment.deleted_at IS NOT NULL
        OR (target_comment.moderation_status <> 'visible' AND NOT spark.can_moderate_community(target.id)) THEN
      RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::integer; RETURN;
    END IF;
    current_status := target_comment.moderation_status;
  END IF;
  IF NOT spark.can_moderate_community(target.id) THEN RETURN QUERY SELECT 'forbidden'::text, NULL::text, NULL::integer; RETURN; END IF;
  -- A moderator cannot dismiss reports on their own content (hide and restore of it stay allowed).
  IF p_action = 'dismiss' AND actor IS NOT DISTINCT FROM (SELECT CASE WHEN p_kind = 'post' THEN target_post.author_user_id ELSE target_comment.author_user_id END) THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::text, NULL::integer; RETURN;
  END IF;

  SELECT count(*)::integer INTO open_count FROM (SELECT 1 FROM spark.content_reports r
    WHERE r.tenant_id = target.tenant_id AND r.status IN ('open','reviewing')
      AND ((p_kind = 'post' AND r.post_id = p_target) OR (p_kind = 'comment' AND r.comment_id = p_target)) FOR UPDATE) locked;

  next_status := current_status;
  IF p_action = 'hide' THEN
    IF current_status = 'hidden' AND open_count = 0 THEN RETURN QUERY SELECT 'unchanged'::text, current_status, 0; RETURN; END IF;
    next_status := 'hidden'; close_status := 'resolved'; close_action := 'hide';
  ELSIF p_action = 'dismiss' THEN
    IF open_count = 0 THEN RETURN QUERY SELECT 'unchanged'::text, current_status, 0; RETURN; END IF;
    close_status := 'dismissed'; close_action := 'dismiss_report';
  ELSE
    IF current_status = 'visible' THEN RETURN QUERY SELECT 'unchanged'::text, current_status, 0; RETURN; END IF;
    next_status := 'visible';
  END IF;

  IF next_status <> current_status THEN
    IF p_kind = 'post' THEN
      UPDATE spark.posts p SET moderation_status = next_status, version = p.version + 1 WHERE p.id = target_post.id;
    ELSE
      UPDATE spark.post_comments pc SET moderation_status = next_status, version = pc.version + 1 WHERE pc.id = target_comment.id;
    END IF;
  END IF;
  IF close_status IS NOT NULL AND open_count > 0 THEN
    WITH closing AS (
      UPDATE spark.content_reports r SET status = close_status, resolved_at = now()
        WHERE r.tenant_id = target.tenant_id AND r.status IN ('open','reviewing')
          AND ((p_kind = 'post' AND r.post_id = p_target) OR (p_kind = 'comment' AND r.comment_id = p_target))
        RETURNING r.id)
    INSERT INTO spark.moderation_actions (tenant_id, community_id, report_id, post_id, comment_id, actor_user_id, action, reason)
      SELECT target.tenant_id, target.id, c.id, CASE WHEN p_kind = 'post' THEN p_target END, CASE WHEN p_kind = 'comment' THEN p_target END,
        actor, close_action, clean_reason FROM closing c;
    GET DIAGNOSTICS closed = ROW_COUNT;
  END IF;
  IF closed = 0 THEN
    INSERT INTO spark.moderation_actions (tenant_id, community_id, report_id, post_id, comment_id, actor_user_id, action, reason)
      VALUES (target.tenant_id, target.id, NULL, CASE WHEN p_kind = 'post' THEN p_target END, CASE WHEN p_kind = 'comment' THEN p_target END,
        actor, p_action, clean_reason);
  END IF;
  RETURN QUERY SELECT 'ok'::text, next_status, closed;
END $$;
