-- Community content access and the read projections for posts and comments (Phase 2 C2).
-- Content is readable when its community is readable (not archived, host workspace active), the post
-- is not deleted and its legacy visibility is not 'hidden', and the community is public (everyone,
-- signed out too) or the viewer is an active member. Content hidden by moderation is readable only by
-- the community's active owners and moderators. Host workspace owners and admins get no content or
-- moderation rights from that role (the 0004 rule).
-- spark_app cannot read content_reports and users RLS only shows coworkers, so every content read is a
-- SECURITY DEFINER function that works with or without a session (spark.session_actor() is NULL when
-- signed out) and returns author names itself. None returns an email or a reporter.
-- The body length checks are NOT VALID: they bind new and updated rows without rejecting older data.
ALTER TABLE spark.posts ADD COLUMN edited_at timestamptz;
ALTER TABLE spark.post_comments ADD COLUMN edited_at timestamptz;
ALTER TABLE spark.posts ADD CONSTRAINT posts_body_length CHECK (length(btrim(body)) BETWEEN 1 AND 10000) NOT VALID;
ALTER TABLE spark.post_comments ADD CONSTRAINT post_comments_body_length CHECK (length(btrim(body)) BETWEEN 1 AND 2000) NOT VALID;
--> statement-breakpoint
-- The session actor is an active owner or moderator of a non-archived community whose host workspace is
-- active. False without a live session.
CREATE FUNCTION spark.can_moderate_community(p_community uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM spark.community_memberships m
    JOIN spark.communities c ON c.id = m.community_id AND c.tenant_id = m.tenant_id
    JOIN spark.workspaces w ON w.id = c.tenant_id
    WHERE c.id = p_community AND m.user_id = spark.session_actor() AND m.status = 'active' AND m.role IN ('owner','moderator')
      AND c.archived_at IS NULL AND w.status = 'active' AND w.archived_at IS NULL);
$$;
--> statement-breakpoint
-- Same signature as 0002, used by the post_read and comment_read policies: the content access rule above.
CREATE OR REPLACE FUNCTION spark.can_read_post(target_tenant uuid, target_post uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM spark.posts p
    JOIN spark.communities c ON c.id = p.community_id AND c.tenant_id = p.tenant_id
    JOIN spark.workspaces w ON w.id = c.tenant_id
    WHERE p.id = target_post AND p.tenant_id = target_tenant AND p.deleted_at IS NULL AND p.visibility <> 'hidden'
      AND c.archived_at IS NULL AND w.status = 'active' AND w.archived_at IS NULL
      AND (c.visibility = 'public' OR spark.is_community_member(c.tenant_id, c.id))
      AND (p.moderation_status = 'visible' OR spark.can_moderate_community(c.id)));
$$;
--> statement-breakpoint
-- A community's feed, newest first by (created_at, id). The keyset cursor is the last row's
-- (created_at, id); returns up to p_limit + 1 rows so the caller can tell whether another page exists.
-- An unknown, archived or inactive community, or a hidden one the viewer neither belongs to nor
-- manages, raises P0002; a private or hidden community the viewer is not an active member of raises
-- 42501. Posts hidden by moderation are listed only for the community's moderators. excerpt is the
-- first 400 characters of the body; comment_count counts visible, non-deleted comments.
CREATE FUNCTION spark.community_feed(p_community uuid, p_before_created timestamptz, p_before_id uuid, p_limit integer)
RETURNS TABLE(id uuid, community_id uuid, author_id uuid, author_name text, author_avatar_url text, title text, excerpt text, truncated boolean,
  created_at timestamptz, edited_at timestamptz, comment_count bigint, moderation_status text, version integer, viewer_is_author boolean, viewer_reported boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.session_actor(); target spark.communities%ROWTYPE; member boolean; moderator boolean;
BEGIN
  IF (p_before_created IS NULL) <> (p_before_id IS NULL) THEN RAISE EXCEPTION 'Invalid post cursor' USING ERRCODE = '22023'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Invalid post limit' USING ERRCODE = '22023'; END IF;
  SELECT c.* INTO target FROM spark.communities c JOIN spark.workspaces w ON w.id = c.tenant_id
    WHERE c.id = p_community AND c.archived_at IS NULL AND w.status = 'active' AND w.archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Community not found' USING ERRCODE = 'P0002'; END IF;
  member := spark.is_community_member(target.tenant_id, target.id);
  IF target.visibility = 'hidden' AND NOT member AND NOT spark.can_manage_community(target.id) THEN
    RAISE EXCEPTION 'Community not found' USING ERRCODE = 'P0002';
  END IF;
  IF target.visibility <> 'public' AND NOT member THEN RAISE EXCEPTION 'Community members only' USING ERRCODE = '42501'; END IF;
  moderator := spark.can_moderate_community(target.id);
  RETURN QUERY
  SELECT p.id, p.community_id, p.author_user_id,
    CASE WHEN u.deleted_at IS NOT NULL THEN 'Former member' ELSE u.display_name END,
    CASE WHEN u.deleted_at IS NULL THEN u.avatar_url END,
    p.title, left(p.body, 400), length(p.body) > 400, p.created_at, p.edited_at,
    (SELECT count(*) FROM spark.post_comments pc WHERE pc.tenant_id = p.tenant_id AND pc.community_id = p.community_id AND pc.post_id = p.id
      AND pc.deleted_at IS NULL AND pc.moderation_status = 'visible'),
    p.moderation_status, p.version, actor IS NOT NULL AND p.author_user_id = actor,
    actor IS NOT NULL AND EXISTS (SELECT 1 FROM spark.content_reports r
      WHERE r.tenant_id = p.tenant_id AND r.reporter_user_id = actor AND r.post_id = p.id AND r.status IN ('open','reviewing'))
  FROM spark.posts p JOIN spark.users u ON u.id = p.author_user_id
  WHERE p.tenant_id = target.tenant_id AND p.community_id = target.id AND p.deleted_at IS NULL AND p.visibility <> 'hidden'
    AND (p.moderation_status = 'visible' OR moderator)
    AND (p_before_id IS NULL OR (p.created_at, p.id) < (p_before_created, p_before_id))
  ORDER BY p.created_at DESC, p.id DESC
  LIMIT p_limit + 1;
END $$;
--> statement-breakpoint
-- One post with its full body and the viewer's standing; no row when the viewer cannot read it
-- (unknown, deleted, hidden from them, or in a community they may not read).
CREATE FUNCTION spark.community_post(p_post uuid)
RETURNS TABLE(id uuid, community_id uuid, community_slug text, author_id uuid, author_name text, author_avatar_url text, title text, body text,
  created_at timestamptz, edited_at timestamptz, comment_count bigint, moderation_status text, version integer, viewer_is_author boolean,
  viewer_reported boolean, viewer_is_member boolean, viewer_can_moderate boolean, community_frozen boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.id, p.community_id, c.slug, p.author_user_id,
    CASE WHEN u.deleted_at IS NOT NULL THEN 'Former member' ELSE u.display_name END,
    CASE WHEN u.deleted_at IS NULL THEN u.avatar_url END,
    p.title, p.body, p.created_at, p.edited_at,
    (SELECT count(*) FROM spark.post_comments pc WHERE pc.tenant_id = p.tenant_id AND pc.community_id = p.community_id AND pc.post_id = p.id
      AND pc.deleted_at IS NULL AND pc.moderation_status = 'visible'),
    p.moderation_status, p.version, actor.id IS NOT NULL AND p.author_user_id = actor.id,
    actor.id IS NOT NULL AND EXISTS (SELECT 1 FROM spark.content_reports r
      WHERE r.tenant_id = p.tenant_id AND r.reporter_user_id = actor.id AND r.post_id = p.id AND r.status IN ('open','reviewing')),
    spark.is_community_member(p.tenant_id, p.community_id), spark.can_moderate_community(p.community_id), c.frozen_at IS NOT NULL
  FROM spark.posts p
  JOIN spark.communities c ON c.id = p.community_id AND c.tenant_id = p.tenant_id
  JOIN spark.users u ON u.id = p.author_user_id
  CROSS JOIN (SELECT spark.session_actor() AS id) actor
  WHERE p.id = p_post AND spark.can_read_post(p.tenant_id, p.id);
$$;
--> statement-breakpoint
-- The comments of a readable post, oldest first by (created_at, id). The keyset cursor is the last
-- row's (created_at, id); returns up to p_limit + 1 rows. An unreadable post raises P0002 'Post not
-- found'. Comments hidden by moderation are listed only for the community's moderators.
CREATE FUNCTION spark.community_post_comments(p_post uuid, p_after_created timestamptz, p_after_id uuid, p_limit integer)
RETURNS TABLE(id uuid, post_id uuid, author_id uuid, author_name text, author_avatar_url text, body text, created_at timestamptz, edited_at timestamptz,
  moderation_status text, version integer, viewer_is_author boolean, viewer_reported boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.session_actor(); target record; moderator boolean;
BEGIN
  IF (p_after_created IS NULL) <> (p_after_id IS NULL) THEN RAISE EXCEPTION 'Invalid comment cursor' USING ERRCODE = '22023'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Invalid comment limit' USING ERRCODE = '22023'; END IF;
  SELECT p.id, p.tenant_id, p.community_id INTO target FROM spark.posts p WHERE p.id = p_post;
  IF NOT FOUND OR NOT spark.can_read_post(target.tenant_id, target.id) THEN RAISE EXCEPTION 'Post not found' USING ERRCODE = 'P0002'; END IF;
  moderator := spark.can_moderate_community(target.community_id);
  RETURN QUERY
  SELECT pc.id, pc.post_id, pc.author_user_id,
    CASE WHEN u.deleted_at IS NOT NULL THEN 'Former member' ELSE u.display_name END,
    CASE WHEN u.deleted_at IS NULL THEN u.avatar_url END,
    pc.body, pc.created_at, pc.edited_at, pc.moderation_status, pc.version, actor IS NOT NULL AND pc.author_user_id = actor,
    actor IS NOT NULL AND EXISTS (SELECT 1 FROM spark.content_reports r
      WHERE r.tenant_id = pc.tenant_id AND r.reporter_user_id = actor AND r.comment_id = pc.id AND r.status IN ('open','reviewing'))
  FROM spark.post_comments pc JOIN spark.users u ON u.id = pc.author_user_id
  WHERE pc.tenant_id = target.tenant_id AND pc.community_id = target.community_id AND pc.post_id = target.id AND pc.deleted_at IS NULL
    AND (pc.moderation_status = 'visible' OR moderator)
    AND (p_after_id IS NULL OR (pc.created_at, pc.id) > (p_after_created, p_after_id))
  ORDER BY pc.created_at, pc.id
  LIMIT p_limit + 1;
END $$;
--> statement-breakpoint
-- One comment (the comment columns plus its community); no row when the viewer cannot read it.
CREATE FUNCTION spark.community_comment(p_comment uuid)
RETURNS TABLE(id uuid, post_id uuid, author_id uuid, author_name text, author_avatar_url text, body text, created_at timestamptz, edited_at timestamptz,
  moderation_status text, version integer, viewer_is_author boolean, viewer_reported boolean, community_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT pc.id, pc.post_id, pc.author_user_id,
    CASE WHEN u.deleted_at IS NOT NULL THEN 'Former member' ELSE u.display_name END,
    CASE WHEN u.deleted_at IS NULL THEN u.avatar_url END,
    pc.body, pc.created_at, pc.edited_at, pc.moderation_status, pc.version, actor.id IS NOT NULL AND pc.author_user_id = actor.id,
    actor.id IS NOT NULL AND EXISTS (SELECT 1 FROM spark.content_reports r
      WHERE r.tenant_id = pc.tenant_id AND r.reporter_user_id = actor.id AND r.comment_id = pc.id AND r.status IN ('open','reviewing')),
    pc.community_id
  FROM spark.post_comments pc
  JOIN spark.users u ON u.id = pc.author_user_id
  CROSS JOIN (SELECT spark.session_actor() AS id) actor
  WHERE pc.id = p_comment AND pc.deleted_at IS NULL AND spark.can_read_post(pc.tenant_id, pc.post_id)
    AND (pc.moderation_status = 'visible' OR spark.can_moderate_community(pc.community_id));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.can_moderate_community(uuid), spark.community_feed(uuid,timestamptz,uuid,integer), spark.community_post(uuid),
  spark.community_post_comments(uuid,timestamptz,uuid,integer), spark.community_comment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION spark.can_moderate_community(uuid), spark.community_feed(uuid,timestamptz,uuid,integer), spark.community_post(uuid),
  spark.community_post_comments(uuid,timestamptz,uuid,integer), spark.community_comment(uuid) TO spark_app;
