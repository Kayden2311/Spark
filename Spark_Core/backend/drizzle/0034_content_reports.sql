-- Content reports and community moderation (Phase 2 C2): reporting a post or comment, moderating it with a
-- record, and the per-community report queue. The runtime role still has no INSERT or UPDATE path to
-- content_reports or moderation_actions outside SECURITY DEFINER functions; staff_resolve_report (0009)
-- is unchanged and keeps working on the same rows. Text is trimmed with btrim like 0032 and 0033.
-- The reason set is closed. The check is NOT VALID so rows written before it (the legacy free-text seed
-- code) are not rejected; every new or updated row must comply.
-- Lock order, as in 0033: host workspace and community FOR SHARE (spark.lock_community_content), then the
-- target post, then its comment, then its reports. A report takes the post (and comment) FOR SHARE, so
-- reports do not serialize with each other (the partial unique indexes make one reporter's report idempotent)
-- but do wait for a moderation FOR UPDATE and then re-read readability. A moderation takes them FOR UPDATE.
ALTER TABLE spark.content_reports ADD CONSTRAINT content_reports_reason_allowed
  CHECK (reason_code IN ('spam','harassment','off_topic','misinformation','self_promotion','other')) NOT VALID;
--> statement-breakpoint
-- Reports a readable post or comment as the session actor. Outcomes: reported; already_reported (the actor
-- has an open or reviewing report on the target: its id comes back); not_found (unknown, deleted, hidden
-- from the actor, or in a community the actor cannot read); own_content. The actor needs no membership,
-- only read access; a frozen community can still be reported. Never returns a reporter.
CREATE FUNCTION spark.ws_report_content(p_kind text, p_target uuid, p_reason text, p_details text)
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

  SELECT r.id INTO existing FROM spark.content_reports r
    WHERE r.tenant_id = target.tenant_id AND r.reporter_user_id = actor AND r.status IN ('open','reviewing')
      AND ((p_kind = 'post' AND r.post_id = p_target) OR (p_kind = 'comment' AND r.comment_id = p_target));
  IF existing IS NOT NULL THEN RETURN QUERY SELECT 'already_reported'::text, existing; RETURN; END IF;
  INSERT INTO spark.content_reports (tenant_id, community_id, reporter_user_id, post_id, comment_id, reason_code, details)
    VALUES (target.tenant_id, target.id, actor, CASE WHEN p_kind = 'post' THEN p_target END, CASE WHEN p_kind = 'comment' THEN p_target END,
      p_reason, clean_details)
    ON CONFLICT DO NOTHING RETURNING id INTO created;
  IF created IS NULL THEN
    -- A concurrent report by the same actor won the partial unique index: answer with its id.
    SELECT r.id INTO existing FROM spark.content_reports r
      WHERE r.tenant_id = target.tenant_id AND r.reporter_user_id = actor AND r.status IN ('open','reviewing')
        AND ((p_kind = 'post' AND r.post_id = p_target) OR (p_kind = 'comment' AND r.comment_id = p_target));
    RETURN QUERY SELECT 'already_reported'::text, existing; RETURN;
  END IF;
  RETURN QUERY SELECT 'reported'::text, created;
END $$;
--> statement-breakpoint
-- A community owner or moderator hides, restores or dismisses reports on a post or comment, leaving a
-- moderation_actions record (the reason is trimmed 3-500). Outcomes: ok; unchanged (nothing to do: hide
-- of hidden content with no open report, restore of visible content, dismiss with no open report; no
-- rows are written); not_found (not readable by the actor: moderators read hidden content); forbidden
-- (readable but the actor does not moderate the community). Works while the community is frozen.
-- hide: status hidden and every open/reviewing report on the target resolved, one 'hide' row per
--   report, or one row without a report when none was open. dismiss: every open report dismissed, one
--   'dismiss_report' row per report; content unchanged. restore: status visible, one row without a
--   report; restore never closes reports. A status change bumps version and never sets edited_at.
CREATE FUNCTION spark.ws_moderate_content(p_kind text, p_target uuid, p_action text, p_reason text)
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
--> statement-breakpoint
-- The open and reviewing reports of one community for its owners and moderators: one row per target, newest
-- report first, at most 100. Deleted targets and comments on deleted posts are left out; hidden content stays
-- listed with its status. reasons is [{reason, count}], largest first; latest_details holds up to three
-- non-NULL details, newest first. No reporter is ever returned. A community the actor cannot see raises
-- P0002 'Community not found'; a visible community the actor does not moderate (signed out included)
-- raises 42501 'Community access denied' (the C1 messages).
CREATE FUNCTION spark.community_report_queue(p_community uuid)
RETURNS TABLE(target_kind text, target_id uuid, post_id uuid, post_title text, excerpt text, author_name text, moderation_status text,
  open_reports bigint, reasons jsonb, latest_details text[], first_reported_at timestamptz, last_reported_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE target spark.communities%ROWTYPE;
BEGIN
  SELECT c.* INTO target FROM spark.communities c JOIN spark.workspaces w ON w.id = c.tenant_id
    WHERE c.id = p_community AND c.archived_at IS NULL AND w.status = 'active' AND w.archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Community not found' USING ERRCODE = 'P0002'; END IF;
  IF target.visibility = 'hidden' AND NOT spark.is_community_member(target.tenant_id, target.id) AND NOT spark.can_manage_community(target.id) THEN
    RAISE EXCEPTION 'Community not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT spark.can_moderate_community(target.id) THEN RAISE EXCEPTION 'Community access denied' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  WITH open AS (
    SELECT r.id AS rid, coalesce(r.comment_id, r.post_id) AS tid, r.comment_id IS NOT NULL AS is_comment, r.reason_code, r.details, r.created_at
    FROM spark.content_reports r
    WHERE r.tenant_id = target.tenant_id AND r.community_id = target.id AND r.status IN ('open','reviewing')),
  per_reason AS (SELECT o.tid, o.reason_code, count(*) AS cnt FROM open o GROUP BY o.tid, o.reason_code),
  reason_list AS (SELECT pr.tid, jsonb_agg(jsonb_build_object('reason', pr.reason_code, 'count', pr.cnt) ORDER BY pr.cnt DESC, pr.reason_code) AS reasons
    FROM per_reason pr GROUP BY pr.tid),
  totals AS (SELECT o.tid, bool_or(o.is_comment) AS is_comment, count(*) AS open_reports, min(o.created_at) AS first_at, max(o.created_at) AS last_at
    FROM open o GROUP BY o.tid)
  SELECT CASE WHEN t.is_comment THEN 'comment' ELSE 'post' END, t.tid, p.id, p.title,
    left(CASE WHEN t.is_comment THEN pc.body ELSE p.body END, 400),
    CASE WHEN u.deleted_at IS NOT NULL THEN 'Former member' ELSE u.display_name END,
    CASE WHEN t.is_comment THEN pc.moderation_status ELSE p.moderation_status END,
    t.open_reports, rl.reasons,
    ARRAY(SELECT o.details FROM open o WHERE o.tid = t.tid AND o.details IS NOT NULL ORDER BY o.created_at DESC, o.rid DESC LIMIT 3),
    t.first_at, t.last_at
  FROM totals t
  JOIN reason_list rl ON rl.tid = t.tid
  LEFT JOIN spark.post_comments pc ON t.is_comment AND pc.id = t.tid AND pc.tenant_id = target.tenant_id AND pc.deleted_at IS NULL
  JOIN spark.posts p ON p.tenant_id = target.tenant_id AND p.community_id = target.id AND p.deleted_at IS NULL AND p.visibility <> 'hidden'
    AND p.id = CASE WHEN t.is_comment THEN pc.post_id ELSE t.tid END
  JOIN spark.users u ON u.id = CASE WHEN t.is_comment THEN pc.author_user_id ELSE p.author_user_id END
  ORDER BY t.last_at DESC, t.tid DESC
  LIMIT 100;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.ws_report_content(text,uuid,text,text), spark.ws_moderate_content(text,uuid,text,text), spark.community_report_queue(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION spark.ws_report_content(text,uuid,text,text), spark.ws_moderate_content(text,uuid,text,text), spark.community_report_queue(uuid) TO spark_app;
