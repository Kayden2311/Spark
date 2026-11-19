-- Community post and comment writes (Phase 2 C2): create, edit and delete, with idempotent creates and
-- the post_commented notification. The runtime role still has no INSERT or UPDATE path to posts or
-- comments outside these spark.ws_* definer functions. Each derives the actor from the live session
-- (spark.require_session_actor) and returns a closed set of outcomes; input violations raise 22023
-- with a whitelisted message. Text is trimmed with btrim, the same as the posts_body_length and
-- post_comments_body_length checks, so a function and its constraint never disagree.
-- Readability follows the content access rule of 0032 for the session actor: an unreadable community,
-- post or comment answers not_found. Writing needs an active membership (any role) in the community;
-- the community must not be frozen. The author may delete their own content at any time while the
-- community is not archived and its host workspace is active.
-- Lock order: host workspace row FOR SHARE, community row FOR SHARE (the community_open trigger takes it
-- too), post, comment. Membership changes lock the community row FOR UPDATE, so they serialize with
-- these writes while writes in one community do not serialize with each other.
ALTER TABLE spark.notifications DROP CONSTRAINT notifications_kind_allowed;
ALTER TABLE spark.notifications ADD CONSTRAINT notifications_kind_allowed CHECK (kind IN ('invitation_accepted','issue_assigned','sprint_started',
  'event_invited','event_rescheduled','event_cancelled','community_request_received','community_request_approved','community_request_rejected',
  'post_commented'));
--> statement-breakpoint
-- Internal: locks the host workspace row and the community row FOR SHARE and returns the community. All
-- fields are NULL when the community is unknown, archived or hosted by an inactive workspace.
CREATE FUNCTION spark.lock_community_content(p_community uuid) RETURNS spark.communities
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE target_tenant uuid; target spark.communities%ROWTYPE;
BEGIN
  SELECT c.tenant_id INTO target_tenant FROM spark.communities c WHERE c.id = p_community;
  IF target_tenant IS NULL THEN RETURN target; END IF;
  PERFORM 1 FROM spark.workspaces w WHERE w.id = target_tenant AND w.status = 'active' AND w.archived_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RETURN target; END IF;
  SELECT c.* INTO target FROM spark.communities c WHERE c.id = p_community AND c.tenant_id = target_tenant AND c.archived_at IS NULL FOR SHARE;
  RETURN target;
END $$;
--> statement-breakpoint
-- Internal: the actor has an active membership (any role) in the community.
CREATE FUNCTION spark.is_active_community_member(p_tenant uuid, p_community uuid, p_actor uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM spark.community_memberships m
    WHERE m.tenant_id = p_tenant AND m.community_id = p_community AND m.user_id = p_actor AND m.status = 'active');
$$;
--> statement-breakpoint
-- Creates a post. not_found when the community is unreadable to the actor; not_a_member when it is
-- readable but the actor has no active membership (suspended included); community_frozen when frozen.
-- Idempotency as in ws_create_issue (0019): the key is scoped to (host workspace, actor,
-- 'community.post.create'); an unexpired row with the same hash for the actor's post in this community
-- replays the original id (even if the post was deleted since: the API answers 404 then); any other
-- unexpired row is a conflict. The row is inserted before the checks so a concurrent request with the
-- same key waits for this transaction, and it is removed again when the create is refused.
CREATE FUNCTION spark.ws_create_post(p_community uuid, p_title text, p_body text, p_idempotency_key text, p_request_hash bytea)
RETURNS TABLE(outcome text, post_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); clean_title text := btrim(p_title); clean_body text := btrim(p_body);
  target spark.communities%ROWTYPE; idempotency_id uuid; existing spark.idempotency_requests%ROWTYPE; replay uuid; new_post uuid := gen_random_uuid();
BEGIN
  target := spark.lock_community_content(p_community);
  IF target.id IS NULL OR NOT spark.can_read_community(target.tenant_id, target.id) THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid; RETURN;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    IF p_idempotency_key !~ '^[A-Za-z0-9_.:-]{1,100}$' OR p_request_hash IS NULL OR octet_length(p_request_hash) <> 32 THEN
      RAISE EXCEPTION 'Invalid idempotency key' USING ERRCODE = '22023';
    END IF;
    DELETE FROM spark.idempotency_requests r WHERE r.tenant_id = target.tenant_id AND r.actor_user_id = actor
      AND r.operation = 'community.post.create' AND r.key = p_idempotency_key AND r.expires_at <= now();
    INSERT INTO spark.idempotency_requests (tenant_id, actor_user_id, operation, key, request_hash, expires_at)
      VALUES (target.tenant_id, actor, 'community.post.create', p_idempotency_key, p_request_hash, now() + interval '24 hours')
      ON CONFLICT (tenant_id, actor_user_id, operation, key) DO NOTHING RETURNING id INTO idempotency_id;
    IF idempotency_id IS NULL THEN
      SELECT * INTO existing FROM spark.idempotency_requests r WHERE r.tenant_id = target.tenant_id AND r.actor_user_id = actor
        AND r.operation = 'community.post.create' AND r.key = p_idempotency_key;
      SELECT p.id INTO replay FROM spark.posts p
        WHERE p.tenant_id = target.tenant_id AND p.community_id = target.id AND p.id = existing.resource_id AND p.author_user_id = actor;
      IF existing.state = 'completed' AND existing.request_hash = p_request_hash AND replay IS NOT NULL THEN
        RETURN QUERY SELECT 'replayed'::text, replay; RETURN;
      END IF;
      RETURN QUERY SELECT 'idempotency_conflict'::text, NULL::uuid; RETURN;
    END IF;
  END IF;

  IF clean_title IS NULL OR length(clean_title) NOT BETWEEN 1 AND 150 THEN RAISE EXCEPTION 'Invalid post title' USING ERRCODE = '22023'; END IF;
  IF clean_body IS NULL OR length(clean_body) NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'Invalid post body' USING ERRCODE = '22023'; END IF;
  IF NOT spark.is_active_community_member(target.tenant_id, target.id, actor) THEN
    DELETE FROM spark.idempotency_requests r WHERE r.id = idempotency_id;
    RETURN QUERY SELECT 'not_a_member'::text, NULL::uuid; RETURN;
  END IF;
  IF target.frozen_at IS NOT NULL THEN
    DELETE FROM spark.idempotency_requests r WHERE r.id = idempotency_id;
    RETURN QUERY SELECT 'community_frozen'::text, NULL::uuid; RETURN;
  END IF;

  INSERT INTO spark.posts (id, tenant_id, community_id, author_user_id, title, body)
    VALUES (new_post, target.tenant_id, target.id, actor, clean_title, clean_body);
  IF idempotency_id IS NOT NULL THEN
    UPDATE spark.idempotency_requests r SET state = 'completed', resource_id = new_post, response_status = 201, expires_at = now() + interval '24 hours'
      WHERE r.id = idempotency_id;
  END IF;
  RETURN QUERY SELECT 'created'::text, new_post;
END $$;
--> statement-breakpoint
-- The author edits their post. NULL leaves a field unchanged; both NULL is an invalid patch. Check order:
-- readable (not_found), author (not_author), active member (not_a_member), not frozen
-- (community_frozen), not hidden by moderation (content_hidden), version (version_mismatch with the
-- current version). Sets edited_at.
CREATE FUNCTION spark.ws_update_post(p_post uuid, p_expected_version integer, p_title text, p_body text)
RETURNS TABLE(outcome text, version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); clean_title text := btrim(p_title); clean_body text := btrim(p_body);
  target_community uuid; target spark.communities%ROWTYPE; target_post spark.posts%ROWTYPE;
BEGIN
  IF p_title IS NULL AND p_body IS NULL THEN RAISE EXCEPTION 'Invalid post patch' USING ERRCODE = '22023'; END IF;
  IF p_title IS NOT NULL AND length(clean_title) NOT BETWEEN 1 AND 150 THEN RAISE EXCEPTION 'Invalid post title' USING ERRCODE = '22023'; END IF;
  IF p_body IS NOT NULL AND length(clean_body) NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'Invalid post body' USING ERRCODE = '22023'; END IF;
  SELECT p.community_id INTO target_community FROM spark.posts p WHERE p.id = p_post;
  IF target_community IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  target := spark.lock_community_content(target_community);
  IF target.id IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  SELECT * INTO target_post FROM spark.posts p WHERE p.id = p_post AND p.tenant_id = target.tenant_id FOR UPDATE;
  IF NOT FOUND OR NOT spark.can_read_post(target_post.tenant_id, target_post.id) THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  IF target_post.author_user_id <> actor THEN RETURN QUERY SELECT 'not_author'::text, NULL::integer; RETURN; END IF;
  IF NOT spark.is_active_community_member(target.tenant_id, target.id, actor) THEN RETURN QUERY SELECT 'not_a_member'::text, NULL::integer; RETURN; END IF;
  IF target.frozen_at IS NOT NULL THEN RETURN QUERY SELECT 'community_frozen'::text, NULL::integer; RETURN; END IF;
  IF target_post.moderation_status <> 'visible' THEN RETURN QUERY SELECT 'content_hidden'::text, NULL::integer; RETURN; END IF;
  IF p_expected_version IS DISTINCT FROM target_post.version THEN RETURN QUERY SELECT 'version_mismatch'::text, target_post.version; RETURN; END IF;
  UPDATE spark.posts p SET title = coalesce(clean_title, p.title), body = coalesce(clean_body, p.body), edited_at = now(), version = p.version + 1
    WHERE p.id = target_post.id;
  RETURN QUERY SELECT 'ok'::text, target_post.version + 1;
END $$;
--> statement-breakpoint
-- The author deletes their post (soft delete) at any time: after leaving, while frozen or hidden. A
-- second delete is ok and changes nothing. A non-author who can read the post gets not_author; anyone
-- else, and everyone for an archived community or an inactive host, gets not_found. Comments, reports
-- and moderation rows stay; the comments become unreadable with the post.
CREATE FUNCTION spark.ws_delete_post(p_post uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_session_actor(); target_community uuid; target spark.communities%ROWTYPE; target_post spark.posts%ROWTYPE;
BEGIN
  SELECT p.community_id INTO target_community FROM spark.posts p WHERE p.id = p_post;
  IF target_community IS NULL THEN RETURN 'not_found'; END IF;
  target := spark.lock_community_content(target_community);
  IF target.id IS NULL THEN RETURN 'not_found'; END IF;
  SELECT * INTO target_post FROM spark.posts p WHERE p.id = p_post AND p.tenant_id = target.tenant_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF target_post.author_user_id = actor THEN
    IF target_post.deleted_at IS NULL THEN
      UPDATE spark.posts p SET deleted_at = now(), version = p.version + 1 WHERE p.id = target_post.id;
    END IF;
    RETURN 'ok';
  END IF;
  IF spark.can_read_post(target_post.tenant_id, target_post.id) THEN RETURN 'not_author'; END IF;
  RETURN 'not_found';
END $$;
--> statement-breakpoint
-- Comments on a readable post. Check order: readable (not_found), idempotency, input, active member
-- (not_a_member), not frozen (community_frozen), post not hidden by moderation (content_hidden).
-- Idempotency as for posts with the operation 'community.comment.create'. When the post author is not
-- the actor and is neither deleted nor inactive, one outbox row (processed at once: in-app only) and one
-- post_commented notification are written in the same transaction, tenant = host workspace. The title
-- carries no post or comment text.
CREATE FUNCTION spark.ws_create_comment(p_post uuid, p_body text, p_idempotency_key text, p_request_hash bytea)
RETURNS TABLE(outcome text, comment_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); clean_body text := btrim(p_body); target_community uuid; target spark.communities%ROWTYPE;
  target_post spark.posts%ROWTYPE; idempotency_id uuid; existing spark.idempotency_requests%ROWTYPE; replay uuid; new_comment uuid := gen_random_uuid();
  event_id uuid; actor_name text;
BEGIN
  SELECT p.community_id INTO target_community FROM spark.posts p WHERE p.id = p_post;
  IF target_community IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid; RETURN; END IF;
  target := spark.lock_community_content(target_community);
  IF target.id IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid; RETURN; END IF;
  SELECT * INTO target_post FROM spark.posts p WHERE p.id = p_post AND p.tenant_id = target.tenant_id FOR SHARE;
  IF NOT FOUND OR NOT spark.can_read_post(target_post.tenant_id, target_post.id) THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid; RETURN; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    IF p_idempotency_key !~ '^[A-Za-z0-9_.:-]{1,100}$' OR p_request_hash IS NULL OR octet_length(p_request_hash) <> 32 THEN
      RAISE EXCEPTION 'Invalid idempotency key' USING ERRCODE = '22023';
    END IF;
    DELETE FROM spark.idempotency_requests r WHERE r.tenant_id = target.tenant_id AND r.actor_user_id = actor
      AND r.operation = 'community.comment.create' AND r.key = p_idempotency_key AND r.expires_at <= now();
    INSERT INTO spark.idempotency_requests (tenant_id, actor_user_id, operation, key, request_hash, expires_at)
      VALUES (target.tenant_id, actor, 'community.comment.create', p_idempotency_key, p_request_hash, now() + interval '24 hours')
      ON CONFLICT (tenant_id, actor_user_id, operation, key) DO NOTHING RETURNING id INTO idempotency_id;
    IF idempotency_id IS NULL THEN
      SELECT * INTO existing FROM spark.idempotency_requests r WHERE r.tenant_id = target.tenant_id AND r.actor_user_id = actor
        AND r.operation = 'community.comment.create' AND r.key = p_idempotency_key;
      SELECT pc.id INTO replay FROM spark.post_comments pc
        WHERE pc.tenant_id = target.tenant_id AND pc.community_id = target.id AND pc.post_id = target_post.id AND pc.id = existing.resource_id
          AND pc.author_user_id = actor;
      IF existing.state = 'completed' AND existing.request_hash = p_request_hash AND replay IS NOT NULL THEN
        RETURN QUERY SELECT 'replayed'::text, replay; RETURN;
      END IF;
      RETURN QUERY SELECT 'idempotency_conflict'::text, NULL::uuid; RETURN;
    END IF;
  END IF;

  IF clean_body IS NULL OR length(clean_body) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'Invalid comment body' USING ERRCODE = '22023'; END IF;
  IF NOT spark.is_active_community_member(target.tenant_id, target.id, actor) THEN
    DELETE FROM spark.idempotency_requests r WHERE r.id = idempotency_id;
    RETURN QUERY SELECT 'not_a_member'::text, NULL::uuid; RETURN;
  END IF;
  IF target.frozen_at IS NOT NULL THEN
    DELETE FROM spark.idempotency_requests r WHERE r.id = idempotency_id;
    RETURN QUERY SELECT 'community_frozen'::text, NULL::uuid; RETURN;
  END IF;
  IF target_post.moderation_status <> 'visible' THEN
    DELETE FROM spark.idempotency_requests r WHERE r.id = idempotency_id;
    RETURN QUERY SELECT 'content_hidden'::text, NULL::uuid; RETURN;
  END IF;

  INSERT INTO spark.post_comments (id, tenant_id, community_id, post_id, author_user_id, body)
    VALUES (new_comment, target.tenant_id, target.id, target_post.id, actor, clean_body);
  IF target_post.author_user_id <> actor AND EXISTS (SELECT 1 FROM spark.users u
      WHERE u.id = target_post.author_user_id AND u.status = 'active' AND u.deleted_at IS NULL) THEN
    INSERT INTO spark.outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, processed_at)
      VALUES (target.tenant_id, 'post_comment.created', 'post_comment', new_comment, 1,
        jsonb_build_object('commentId', new_comment, 'postId', target_post.id, 'communityId', target.id), now())
      RETURNING id INTO event_id;
    SELECT coalesce(nullif(btrim(u.display_name), ''), 'Someone') INTO actor_name FROM spark.users u WHERE u.id = actor;
    INSERT INTO spark.notifications (tenant_id, recipient_user_id, outbox_event_id, kind, title, resource_type, resource_id)
      VALUES (target.tenant_id, target_post.author_user_id, event_id, 'post_commented',
        left(actor_name || ' commented on your post in ' || target.name, 500), 'post', target_post.id);
  END IF;
  IF idempotency_id IS NOT NULL THEN
    UPDATE spark.idempotency_requests r SET state = 'completed', resource_id = new_comment, response_status = 201, expires_at = now() + interval '24 hours'
      WHERE r.id = idempotency_id;
  END IF;
  RETURN QUERY SELECT 'created'::text, new_comment;
END $$;
--> statement-breakpoint
-- The author edits their comment; same outcomes and order as ws_update_post. A comment is readable when
-- it is not deleted, its post is readable, and it is visible or the actor moderates the community; it
-- counts as hidden (content_hidden) when the comment or its post is hidden by moderation.
CREATE FUNCTION spark.ws_update_comment(p_comment uuid, p_expected_version integer, p_body text)
RETURNS TABLE(outcome text, version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); clean_body text := btrim(p_body); target_community uuid; target_post_id uuid;
  target spark.communities%ROWTYPE; target_post spark.posts%ROWTYPE; target_comment spark.post_comments%ROWTYPE;
BEGIN
  IF clean_body IS NULL OR length(clean_body) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'Invalid comment body' USING ERRCODE = '22023'; END IF;
  SELECT pc.community_id, pc.post_id INTO target_community, target_post_id FROM spark.post_comments pc WHERE pc.id = p_comment;
  IF target_community IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  target := spark.lock_community_content(target_community);
  IF target.id IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  SELECT * INTO target_post FROM spark.posts p WHERE p.id = target_post_id AND p.tenant_id = target.tenant_id FOR SHARE;
  SELECT * INTO target_comment FROM spark.post_comments pc WHERE pc.id = p_comment AND pc.tenant_id = target.tenant_id FOR UPDATE;
  IF target_comment.id IS NULL OR target_comment.deleted_at IS NOT NULL OR NOT spark.can_read_post(target_post.tenant_id, target_post.id)
      OR (target_comment.moderation_status <> 'visible' AND NOT spark.can_moderate_community(target.id)) THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN;
  END IF;
  IF target_comment.author_user_id <> actor THEN RETURN QUERY SELECT 'not_author'::text, NULL::integer; RETURN; END IF;
  IF NOT spark.is_active_community_member(target.tenant_id, target.id, actor) THEN RETURN QUERY SELECT 'not_a_member'::text, NULL::integer; RETURN; END IF;
  IF target.frozen_at IS NOT NULL THEN RETURN QUERY SELECT 'community_frozen'::text, NULL::integer; RETURN; END IF;
  IF target_comment.moderation_status <> 'visible' OR target_post.moderation_status <> 'visible' THEN
    RETURN QUERY SELECT 'content_hidden'::text, NULL::integer; RETURN;
  END IF;
  IF p_expected_version IS DISTINCT FROM target_comment.version THEN RETURN QUERY SELECT 'version_mismatch'::text, target_comment.version; RETURN; END IF;
  UPDATE spark.post_comments pc SET body = clean_body, edited_at = now(), version = pc.version + 1 WHERE pc.id = target_comment.id;
  RETURN QUERY SELECT 'ok'::text, target_comment.version + 1;
END $$;
--> statement-breakpoint
-- The author deletes their comment at any time (same rules as ws_delete_post).
CREATE FUNCTION spark.ws_delete_comment(p_comment uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_session_actor(); target_community uuid; target_post_id uuid; target spark.communities%ROWTYPE;
  target_post spark.posts%ROWTYPE; target_comment spark.post_comments%ROWTYPE;
BEGIN
  SELECT pc.community_id, pc.post_id INTO target_community, target_post_id FROM spark.post_comments pc WHERE pc.id = p_comment;
  IF target_community IS NULL THEN RETURN 'not_found'; END IF;
  target := spark.lock_community_content(target_community);
  IF target.id IS NULL THEN RETURN 'not_found'; END IF;
  SELECT * INTO target_post FROM spark.posts p WHERE p.id = target_post_id AND p.tenant_id = target.tenant_id FOR SHARE;
  SELECT * INTO target_comment FROM spark.post_comments pc WHERE pc.id = p_comment AND pc.tenant_id = target.tenant_id FOR UPDATE;
  IF target_comment.id IS NULL THEN RETURN 'not_found'; END IF;
  IF target_comment.author_user_id = actor THEN
    IF target_comment.deleted_at IS NULL THEN
      UPDATE spark.post_comments pc SET deleted_at = now(), version = pc.version + 1 WHERE pc.id = target_comment.id;
    END IF;
    RETURN 'ok';
  END IF;
  IF target_comment.deleted_at IS NULL AND spark.can_read_post(target_post.tenant_id, target_post.id)
      AND (target_comment.moderation_status = 'visible' OR spark.can_moderate_community(target.id)) THEN
    RETURN 'not_author';
  END IF;
  RETURN 'not_found';
END $$;
--> statement-breakpoint
-- Notification reads (0031), redefined: post rows (resource_type 'post') are visible outside the host
-- workspace like community rows, and link to the post only while the recipient can read it.
CREATE OR REPLACE FUNCTION spark.ws_list_notifications(p_unread_only boolean, p_before_created timestamptz, p_before_id uuid, p_limit integer)
RETURNS TABLE(id uuid, tenant_id uuid, workspace_slug text, workspace_name text, kind text, title text, body text, resource_type text,
  resource_id uuid, link text, created_at timestamptz, read_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor();
BEGIN
  IF (p_before_created IS NULL) <> (p_before_id IS NULL) THEN
    RAISE EXCEPTION 'Invalid notification cursor' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid notification limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT n.id, n.tenant_id, w.slug, w.name, n.kind, n.title, n.body, n.resource_type, n.resource_id,
    CASE n.resource_type
      WHEN 'issue' THEN (SELECT '/w/' || w.slug || '/p/' || p.key || '?issue=' || p.key || '-' || i.number
        FROM spark.issues i JOIN spark.projects p ON p.tenant_id = i.tenant_id AND p.id = i.project_id
        WHERE i.tenant_id = n.tenant_id AND i.id = n.resource_id AND i.archived_at IS NULL AND p.archived_at IS NULL)
      WHEN 'sprint' THEN (SELECT '/w/' || w.slug || '/p/' || p.key || '/backlog'
        FROM spark.sprints s JOIN spark.projects p ON p.tenant_id = s.tenant_id AND p.id = s.project_id
        WHERE s.tenant_id = n.tenant_id AND s.id = n.resource_id AND p.archived_at IS NULL)
      WHEN 'calendar_event' THEN (SELECT '/w/' || w.slug || '/schedule?week='
          || to_char(date_trunc('week', e.starts_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')
        FROM spark.calendar_events e WHERE e.tenant_id = n.tenant_id AND e.id = n.resource_id)
      WHEN 'workspace' THEN '/w/' || w.slug || '/members'
      WHEN 'community' THEN (SELECT '/communities/' || c.slug || CASE WHEN n.kind = 'community_request_received' THEN '/manage' ELSE '' END
        FROM spark.communities c WHERE c.tenant_id = n.tenant_id AND c.id = n.resource_id AND c.archived_at IS NULL
          AND w.status = 'active' AND w.archived_at IS NULL)
      WHEN 'post' THEN (SELECT '/communities/' || c.slug || '/posts/' || p.id
        FROM spark.posts p JOIN spark.communities c ON c.tenant_id = p.tenant_id AND c.id = p.community_id
        WHERE p.tenant_id = n.tenant_id AND p.id = n.resource_id AND c.archived_at IS NULL AND spark.can_read_post(n.tenant_id, n.resource_id))
    END,
    n.created_at, n.read_at
  FROM spark.notifications n JOIN spark.workspaces w ON w.id = n.tenant_id
  WHERE n.recipient_user_id = actor AND (n.tenant_id = ANY(spark.session_workspace_ids()) OR n.resource_type IN ('community','post'))
    AND (NOT coalesce(p_unread_only, false) OR n.read_at IS NULL)
    AND (p_before_created IS NULL OR (n.created_at, n.id) < (p_before_created, p_before_id))
  ORDER BY n.created_at DESC, n.id DESC
  LIMIT p_limit;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION spark.ws_unread_notification_count() RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_session_actor(); total integer;
BEGIN
  SELECT count(*)::integer INTO total FROM (
    SELECT 1 FROM spark.notifications n
    WHERE n.recipient_user_id = actor AND (n.tenant_id = ANY(spark.session_workspace_ids()) OR n.resource_type IN ('community','post')) AND n.read_at IS NULL
    LIMIT 100) unread;
  RETURN total;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION spark.ws_mark_notification_read(p_notification uuid)
RETURNS TABLE(outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_session_actor();
BEGIN
  IF p_notification IS NULL OR NOT EXISTS (SELECT 1 FROM spark.notifications n WHERE n.id = p_notification
      AND n.recipient_user_id = actor AND (n.tenant_id = ANY(spark.session_workspace_ids()) OR n.resource_type IN ('community','post'))) THEN
    RETURN QUERY SELECT 'not_found'::text; RETURN;
  END IF;
  UPDATE spark.notifications n SET read_at = now()
    WHERE n.id = p_notification AND n.recipient_user_id = actor AND n.read_at IS NULL
      AND (n.tenant_id = ANY(spark.session_workspace_ids()) OR n.resource_type IN ('community','post'));
  RETURN QUERY SELECT 'ok'::text;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION spark.ws_mark_notifications_read(p_before timestamptz)
RETURNS TABLE(updated integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_session_actor(); changed integer;
BEGIN
  IF p_before IS NULL THEN
    RAISE EXCEPTION 'Invalid notification before' USING ERRCODE = '22023';
  END IF;
  UPDATE spark.notifications n SET read_at = now()
    WHERE n.recipient_user_id = actor AND (n.tenant_id = ANY(spark.session_workspace_ids()) OR n.resource_type IN ('community','post'))
      AND n.read_at IS NULL AND n.created_at <= p_before;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN QUERY SELECT changed;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.lock_community_content(uuid), spark.is_active_community_member(uuid,uuid,uuid),
  spark.ws_create_post(uuid,text,text,text,bytea), spark.ws_update_post(uuid,integer,text,text), spark.ws_delete_post(uuid),
  spark.ws_create_comment(uuid,text,text,bytea), spark.ws_update_comment(uuid,integer,text), spark.ws_delete_comment(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION spark.lock_community_content(uuid), spark.is_active_community_member(uuid,uuid,uuid) FROM spark_app;
GRANT EXECUTE ON FUNCTION spark.ws_create_post(uuid,text,text,text,bytea), spark.ws_update_post(uuid,integer,text,text), spark.ws_delete_post(uuid),
  spark.ws_create_comment(uuid,text,text,bytea), spark.ws_update_comment(uuid,integer,text), spark.ws_delete_comment(uuid) TO spark_app;
