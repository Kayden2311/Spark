-- Community membership writes, community reads for members and managers, and community notifications.
-- The runtime role still has no INSERT, UPDATE or DELETE grant on any community table: every change goes
-- through one of the spark.ws_* definer functions below. Each derives the actor from the live session
-- (spark.require_session_actor), returns a closed set of outcomes and records audit rows in the host
-- workspace (spark.record_workspace_audit) in the same transaction.
-- Visibility: callers who cannot see a community (hidden and neither an active member nor a manager,
-- archived, hosted by an inactive workspace, or unknown) get not_found; visible but lacking authority get
-- forbidden. Community managers are the active community owners and moderators and the active owners and
-- admins of the host workspace; only community owners and host workspace owners/admins change settings
-- and roles.
-- Lock order: host workspace row FOR SHARE, community row FOR UPDATE, join request, membership. The
-- serialize_members trigger re-locks the community row, which is already held; the deferred
-- community_owner trigger only fires at commit, so last-owner checks are explicit here.
ALTER TABLE spark.notifications DROP CONSTRAINT notifications_kind_allowed;
ALTER TABLE spark.notifications ADD CONSTRAINT notifications_kind_allowed CHECK (kind IN ('invitation_accepted','issue_assigned','sprint_started',
  'event_invited','event_rescheduled','event_cancelled','community_request_received','community_request_approved','community_request_rejected'));
--> statement-breakpoint
-- Internal: one validated community field. Returns the stored form (trimmed; a blank city is NULL) or
-- raises 22023 with the field's whitelisted message.
CREATE FUNCTION spark.check_community_field(p_field text, p_value text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE clean text := btrim(p_value);
BEGIN
  CASE p_field
    WHEN 'slug' THEN
      IF p_value IS NULL OR p_value !~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$' THEN RAISE EXCEPTION 'Invalid community slug' USING ERRCODE = '22023'; END IF;
      RETURN p_value;
    WHEN 'name' THEN
      IF clean IS NULL OR length(clean) NOT BETWEEN 1 AND 80 THEN RAISE EXCEPTION 'Invalid community name' USING ERRCODE = '22023'; END IF;
      RETURN clean;
    WHEN 'tagline' THEN
      IF clean IS NULL OR length(clean) NOT BETWEEN 1 AND 90 THEN RAISE EXCEPTION 'Invalid community tagline' USING ERRCODE = '22023'; END IF;
      RETURN clean;
    WHEN 'description' THEN
      IF clean IS NULL OR length(clean) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'Invalid community description' USING ERRCODE = '22023'; END IF;
      RETURN clean;
    WHEN 'visibility' THEN
      IF p_value IS NULL OR p_value NOT IN ('public','private','hidden') THEN RAISE EXCEPTION 'Invalid community visibility' USING ERRCODE = '22023'; END IF;
      RETURN p_value;
    WHEN 'countryCode' THEN
      IF p_value IS NOT NULL AND p_value !~ '^[A-Z]{2}$' THEN RAISE EXCEPTION 'Invalid community location' USING ERRCODE = '22023'; END IF;
      RETURN p_value;
    WHEN 'city' THEN
      clean := nullif(clean, '');
      IF length(clean) > 80 THEN RAISE EXCEPTION 'Invalid community location' USING ERRCODE = '22023'; END IF;
      RETURN clean;
    WHEN 'stage' THEN
      IF p_value IS NULL OR p_value NOT IN ('idea','pre_seed','seed','series_a','growth','any') THEN RAISE EXCEPTION 'Invalid community stage' USING ERRCODE = '22023'; END IF;
      RETURN p_value;
  END CASE;
END $$;
--> statement-breakpoint
-- Internal: 1 to 4 distinct codes from the fixed topic set, else 22023.
CREATE FUNCTION spark.check_community_topics(p_topics text[]) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF p_topics IS NULL OR cardinality(p_topics) NOT BETWEEN 1 AND 4 OR array_position(p_topics, NULL) IS NOT NULL
      OR NOT p_topics <@ spark.community_topic_codes()
      OR (SELECT count(DISTINCT code) FROM unnest(p_topics) AS code) <> cardinality(p_topics) THEN
    RAISE EXCEPTION 'Invalid community topics' USING ERRCODE = '22023';
  END IF;
  RETURN p_topics;
END $$;
--> statement-breakpoint
-- Internal: locks the host workspace row FOR SHARE and the community row FOR UPDATE and returns the
-- community. All fields are NULL when the community is unknown, archived or hosted by an inactive
-- workspace (no lock is kept on the community then).
CREATE FUNCTION spark.lock_community(p_community uuid) RETURNS spark.communities
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE target_tenant uuid; target spark.communities%ROWTYPE;
BEGIN
  SELECT c.tenant_id INTO target_tenant FROM spark.communities c WHERE c.id = p_community;
  IF target_tenant IS NULL THEN RETURN target; END IF;
  PERFORM 1 FROM spark.workspaces w WHERE w.id = target_tenant AND w.status = 'active' AND w.archived_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RETURN target; END IF;
  SELECT c.* INTO target FROM spark.communities c WHERE c.id = p_community AND c.tenant_id = target_tenant AND c.archived_at IS NULL FOR UPDATE;
  RETURN target;
END $$;
--> statement-breakpoint
-- Internal: the actor's standing in a community of an active host workspace. membership_status and
-- community_role describe the actor's membership row in any status (NULL without one); member is an
-- active membership; manager is an active community owner/moderator or an active host workspace
-- owner/admin; administrator is an active community owner or an active host workspace owner/admin;
-- visible is false only for a hidden community the actor neither belongs to nor manages.
CREATE FUNCTION spark.community_actor_access(p_tenant uuid, p_community uuid, p_visibility text, p_actor uuid,
  OUT membership_status text, OUT community_role text, OUT member boolean, OUT manager boolean, OUT administrator boolean, OUT visible boolean)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT m.status, m.role, flags.member, flags.manager, flags.administrator, p_visibility <> 'hidden' OR flags.member OR flags.manager
  FROM (SELECT 1) one
  LEFT JOIN spark.community_memberships m ON m.tenant_id = p_tenant AND m.community_id = p_community AND m.user_id = p_actor
  LEFT JOIN spark.workspace_memberships h ON h.tenant_id = p_tenant AND h.user_id = p_actor AND h.status = 'active'
  CROSS JOIN LATERAL (SELECT coalesce(m.status = 'active', false) AS member,
      coalesce(m.status = 'active' AND m.role IN ('owner','moderator'), false) OR coalesce(h.role IN ('owner','admin'), false) AS manager,
      coalesce(m.status = 'active' AND m.role = 'owner', false) OR coalesce(h.role IN ('owner','admin'), false) AS administrator) flags;
$$;
--> statement-breakpoint
-- Host workspace owners and admins create communities; at most 10 non-archived ones per workspace. The
-- creator becomes the active community owner. Slugs are globally unique.
CREATE FUNCTION spark.ws_create_community(p_workspace uuid, p_slug text, p_name text, p_tagline text, p_description text, p_visibility text,
  p_country text, p_city text, p_stage text, p_topics text[]) RETURNS TABLE(outcome text, community_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor();
  clean_slug text := spark.check_community_field('slug', p_slug);
  clean_name text := spark.check_community_field('name', p_name);
  clean_tagline text := spark.check_community_field('tagline', p_tagline);
  clean_description text := spark.check_community_field('description', p_description);
  clean_visibility text := spark.check_community_field('visibility', p_visibility);
  clean_country text := spark.check_community_field('countryCode', p_country);
  clean_city text := spark.check_community_field('city', p_city);
  clean_stage text := spark.check_community_field('stage', p_stage);
  clean_topics text[] := spark.check_community_topics(p_topics);
  actor_role text; new_community uuid;
BEGIN
  actor_role := spark.lock_workspace_role(p_workspace, actor);
  IF actor_role IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid; RETURN; END IF;
  IF actor_role NOT IN ('owner','admin') THEN RETURN QUERY SELECT 'forbidden'::text, NULL::uuid; RETURN; END IF;
  IF (SELECT count(*) FROM spark.communities c WHERE c.tenant_id = p_workspace AND c.archived_at IS NULL) >= 10 THEN
    RETURN QUERY SELECT 'too_many_communities'::text, NULL::uuid; RETURN;
  END IF;
  INSERT INTO spark.communities (tenant_id, slug, name, tagline, description, visibility, country_code, city, stage, created_by_user_id)
    VALUES (p_workspace, clean_slug, clean_name, clean_tagline, clean_description, clean_visibility, clean_country, clean_city, clean_stage, actor)
    ON CONFLICT (slug) DO NOTHING RETURNING id INTO new_community;
  IF new_community IS NULL THEN RETURN QUERY SELECT 'slug_taken'::text, NULL::uuid; RETURN; END IF;
  INSERT INTO spark.community_memberships (tenant_id, community_id, user_id, role, status) VALUES (p_workspace, new_community, actor, 'owner', 'active');
  INSERT INTO spark.community_topics (tenant_id, community_id, topic_id)
    SELECT p_workspace, new_community, t.id FROM spark.topics t WHERE t.slug = ANY (clean_topics);
  PERFORM spark.record_workspace_audit(p_workspace, actor, 'community.created', 'community', new_community,
    jsonb_build_object('slug', clean_slug, 'name', clean_name, 'visibility', clean_visibility));
  RETURN QUERY SELECT 'ok'::text, new_community;
END $$;
--> statement-breakpoint
-- Community owners and host workspace owners/admins change settings. Patch keys: name, tagline,
-- description, visibility, countryCode, city (both nullable), stage and topics (replaces the set). Only
-- the keys present are validated. A patch that changes nothing returns ok without a version bump.
CREATE FUNCTION spark.ws_update_community(p_community uuid, p_expected_version integer, p_patch jsonb)
RETURNS TABLE(outcome text, settings_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); patch_key text; target spark.communities%ROWTYPE; standing record;
  new_name text; new_tagline text; new_description text; new_visibility text; new_country text; new_city text; new_stage text; new_topics text[];
  current_topics text[]; changed text[] := ARRAY[]::text[];
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN RAISE EXCEPTION 'Invalid community patch' USING ERRCODE = '22023'; END IF;
  FOR patch_key IN SELECT jsonb_object_keys(p_patch) LOOP
    IF patch_key NOT IN ('name','tagline','description','visibility','countryCode','city','stage','topics') THEN
      RAISE EXCEPTION 'Invalid community patch' USING ERRCODE = '22023';
    END IF;
    IF patch_key = 'topics' THEN
      IF jsonb_typeof(p_patch->'topics') <> 'array' THEN RAISE EXCEPTION 'Invalid community topics' USING ERRCODE = '22023'; END IF;
    ELSIF jsonb_typeof(p_patch->patch_key) NOT IN ('string','null') THEN
      RAISE EXCEPTION '%', CASE patch_key WHEN 'name' THEN 'Invalid community name' WHEN 'tagline' THEN 'Invalid community tagline'
        WHEN 'description' THEN 'Invalid community description' WHEN 'visibility' THEN 'Invalid community visibility'
        WHEN 'stage' THEN 'Invalid community stage' ELSE 'Invalid community location' END USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF p_patch ? 'name' THEN new_name := spark.check_community_field('name', p_patch->>'name'); END IF;
  IF p_patch ? 'tagline' THEN new_tagline := spark.check_community_field('tagline', p_patch->>'tagline'); END IF;
  IF p_patch ? 'description' THEN new_description := spark.check_community_field('description', p_patch->>'description'); END IF;
  IF p_patch ? 'visibility' THEN new_visibility := spark.check_community_field('visibility', p_patch->>'visibility'); END IF;
  IF p_patch ? 'countryCode' THEN new_country := spark.check_community_field('countryCode', p_patch->>'countryCode'); END IF;
  IF p_patch ? 'city' THEN new_city := spark.check_community_field('city', p_patch->>'city'); END IF;
  IF p_patch ? 'stage' THEN new_stage := spark.check_community_field('stage', p_patch->>'stage'); END IF;
  IF p_patch ? 'topics' THEN new_topics := spark.check_community_topics(ARRAY(SELECT jsonb_array_elements_text(p_patch->'topics'))); END IF;
  target := spark.lock_community(p_community);
  IF target.id IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  SELECT * INTO standing FROM spark.community_actor_access(target.tenant_id, target.id, target.visibility, actor);
  IF NOT standing.visible THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  IF NOT standing.administrator THEN RETURN QUERY SELECT 'forbidden'::text, NULL::integer; RETURN; END IF;
  IF p_expected_version IS DISTINCT FROM target.settings_version THEN
    RETURN QUERY SELECT 'version_mismatch'::text, target.settings_version; RETURN;
  END IF;
  IF p_patch ? 'name' AND new_name IS DISTINCT FROM target.name THEN changed := changed || 'name'::text; END IF;
  IF p_patch ? 'tagline' AND new_tagline IS DISTINCT FROM target.tagline THEN changed := changed || 'tagline'::text; END IF;
  IF p_patch ? 'description' AND new_description IS DISTINCT FROM target.description THEN changed := changed || 'description'::text; END IF;
  IF p_patch ? 'visibility' AND new_visibility IS DISTINCT FROM target.visibility THEN changed := changed || 'visibility'::text; END IF;
  IF p_patch ? 'countryCode' AND new_country IS DISTINCT FROM target.country_code THEN changed := changed || 'countryCode'::text; END IF;
  IF p_patch ? 'city' AND new_city IS DISTINCT FROM target.city THEN changed := changed || 'city'::text; END IF;
  IF p_patch ? 'stage' AND new_stage IS DISTINCT FROM target.stage THEN changed := changed || 'stage'::text; END IF;
  IF p_patch ? 'topics' THEN
    current_topics := ARRAY(SELECT t.slug FROM spark.community_topics ct JOIN spark.topics t ON t.id = ct.topic_id
      WHERE ct.tenant_id = target.tenant_id AND ct.community_id = target.id ORDER BY t.slug COLLATE "C");
    IF ARRAY(SELECT code FROM unnest(new_topics) AS code ORDER BY code COLLATE "C") IS DISTINCT FROM current_topics THEN changed := changed || 'topics'::text; END IF;
  END IF;
  IF cardinality(changed) = 0 THEN RETURN QUERY SELECT 'ok'::text, target.settings_version; RETURN; END IF;
  UPDATE spark.communities c SET
    name = CASE WHEN p_patch ? 'name' THEN new_name ELSE c.name END,
    tagline = CASE WHEN p_patch ? 'tagline' THEN new_tagline ELSE c.tagline END,
    description = CASE WHEN p_patch ? 'description' THEN new_description ELSE c.description END,
    visibility = CASE WHEN p_patch ? 'visibility' THEN new_visibility ELSE c.visibility END,
    country_code = CASE WHEN p_patch ? 'countryCode' THEN new_country ELSE c.country_code END,
    city = CASE WHEN p_patch ? 'city' THEN new_city ELSE c.city END,
    stage = CASE WHEN p_patch ? 'stage' THEN new_stage ELSE c.stage END,
    settings_version = c.settings_version + 1
  WHERE c.id = target.id;
  IF 'topics' = ANY (changed) THEN
    DELETE FROM spark.community_topics ct USING spark.topics t
      WHERE t.id = ct.topic_id AND ct.tenant_id = target.tenant_id AND ct.community_id = target.id AND NOT t.slug = ANY (new_topics);
    INSERT INTO spark.community_topics (tenant_id, community_id, topic_id)
      SELECT target.tenant_id, target.id, t.id FROM spark.topics t WHERE t.slug = ANY (new_topics)
      ON CONFLICT (tenant_id, community_id, topic_id) DO NOTHING;
  END IF;
  PERFORM spark.record_workspace_audit(target.tenant_id, actor, 'community.updated', 'community', target.id,
    jsonb_build_object('changed', to_jsonb(ARRAY(SELECT key FROM unnest(changed) AS key ORDER BY key COLLATE "C"))));
  RETURN QUERY SELECT 'ok'::text, target.settings_version + 1;
END $$;
--> statement-breakpoint
-- Joins a public community at once. A left membership is re-activated as a member; an open request of
-- the actor (from when the community was private) is withdrawn. Two parallel calls serialize on the
-- community row: the second returns already_member.
CREATE FUNCTION spark.ws_join_community(p_community uuid) RETURNS TABLE(outcome text, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); target spark.communities%ROWTYPE; standing record; membership spark.community_memberships%ROWTYPE;
BEGIN
  target := spark.lock_community(p_community);
  IF target.id IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::text; RETURN; END IF;
  SELECT * INTO standing FROM spark.community_actor_access(target.tenant_id, target.id, target.visibility, actor);
  IF NOT standing.visible THEN RETURN QUERY SELECT 'not_found'::text, NULL::text; RETURN; END IF;
  SELECT * INTO membership FROM spark.community_memberships m
    WHERE m.tenant_id = target.tenant_id AND m.community_id = target.id AND m.user_id = actor FOR UPDATE;
  IF membership.status = 'active' THEN RETURN QUERY SELECT 'already_member'::text, 'active'::text; RETURN; END IF;
  IF membership.status = 'suspended' THEN RETURN QUERY SELECT 'membership_suspended'::text, 'suspended'::text; RETURN; END IF;
  IF target.frozen_at IS NOT NULL THEN RETURN QUERY SELECT 'community_frozen'::text, NULL::text; RETURN; END IF;
  IF target.visibility <> 'public' THEN RETURN QUERY SELECT 'request_required'::text, NULL::text; RETURN; END IF;
  IF membership.id IS NOT NULL THEN
    UPDATE spark.community_memberships m SET role = 'member', status = 'active', left_at = NULL, joined_at = now() WHERE m.id = membership.id;
  ELSE
    INSERT INTO spark.community_memberships (tenant_id, community_id, user_id, role, status) VALUES (target.tenant_id, target.id, actor, 'member', 'active');
  END IF;
  UPDATE spark.community_join_requests r SET status = 'withdrawn'
    WHERE r.tenant_id = target.tenant_id AND r.community_id = target.id AND r.user_id = actor AND r.status = 'pending';
  RETURN QUERY SELECT 'joined'::text, 'active'::text;
END $$;
--> statement-breakpoint
-- Asks to join a private community. An open request is returned as already_pending (same id). After a
-- rejection the user waits 14 days from reviewed_at. Every active community owner and moderator gets a
-- community_request_received notification; the outbox row is processed at once (in-app only, no email).
CREATE FUNCTION spark.ws_request_community_membership(p_community uuid, p_message text)
RETURNS TABLE(outcome text, request_id uuid, retry_after timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); clean_message text := nullif(btrim(p_message), '');
  target spark.communities%ROWTYPE; standing record; existing uuid; last_rejected timestamptz; new_request uuid; event_id uuid; requester_name text;
BEGIN
  IF length(clean_message) > 500 THEN RAISE EXCEPTION 'Invalid request message' USING ERRCODE = '22023'; END IF;
  target := spark.lock_community(p_community);
  IF target.id IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::timestamptz; RETURN; END IF;
  SELECT * INTO standing FROM spark.community_actor_access(target.tenant_id, target.id, target.visibility, actor);
  IF NOT standing.visible THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::timestamptz; RETURN; END IF;
  IF standing.member THEN RETURN QUERY SELECT 'already_member'::text, NULL::uuid, NULL::timestamptz; RETURN; END IF;
  IF standing.membership_status = 'suspended' THEN RETURN QUERY SELECT 'membership_suspended'::text, NULL::uuid, NULL::timestamptz; RETURN; END IF;
  IF target.visibility = 'public' THEN RETURN QUERY SELECT 'join_instead'::text, NULL::uuid, NULL::timestamptz; RETURN; END IF;
  -- Hidden communities take no requests; their managers add members directly.
  IF target.visibility = 'hidden' THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::timestamptz; RETURN; END IF;
  SELECT r.id INTO existing FROM spark.community_join_requests r
    WHERE r.tenant_id = target.tenant_id AND r.community_id = target.id AND r.user_id = actor AND r.status = 'pending' FOR UPDATE;
  IF existing IS NOT NULL THEN RETURN QUERY SELECT 'already_pending'::text, existing, NULL::timestamptz; RETURN; END IF;
  IF target.frozen_at IS NOT NULL THEN RETURN QUERY SELECT 'community_frozen'::text, NULL::uuid, NULL::timestamptz; RETURN; END IF;
  SELECT max(r.reviewed_at) INTO last_rejected FROM spark.community_join_requests r
    WHERE r.tenant_id = target.tenant_id AND r.community_id = target.id AND r.user_id = actor AND r.status = 'rejected';
  IF last_rejected > now() - interval '14 days' THEN
    RETURN QUERY SELECT 'request_cooldown'::text, NULL::uuid, last_rejected + interval '14 days'; RETURN;
  END IF;
  INSERT INTO spark.community_join_requests (tenant_id, community_id, user_id, message) VALUES (target.tenant_id, target.id, actor, clean_message)
    RETURNING id INTO new_request;
  INSERT INTO spark.outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, processed_at)
    VALUES (target.tenant_id, 'community_join_request.created', 'community_join_request', new_request, 1,
      jsonb_build_object('requestId', new_request, 'communityId', target.id), now())
    RETURNING id INTO event_id;
  SELECT coalesce(nullif(btrim(u.display_name), ''), 'Someone') INTO requester_name FROM spark.users u WHERE u.id = actor;
  INSERT INTO spark.notifications (tenant_id, recipient_user_id, outbox_event_id, kind, title, resource_type, resource_id)
    SELECT target.tenant_id, m.user_id, event_id, 'community_request_received', left(requester_name || ' asked to join ' || target.name, 500), 'community', target.id
    FROM spark.community_memberships m JOIN spark.users u ON u.id = m.user_id
    WHERE m.tenant_id = target.tenant_id AND m.community_id = target.id AND m.status = 'active' AND m.role IN ('owner','moderator')
      AND m.user_id <> actor AND u.status = 'active' AND u.deleted_at IS NULL
    ORDER BY m.user_id;
  RETURN QUERY SELECT 'requested'::text, new_request, NULL::timestamptz;
END $$;
--> statement-breakpoint
-- The requester withdraws their own open request.
CREATE FUNCTION spark.ws_withdraw_community_request(p_request uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_session_actor(); target_community uuid; target spark.communities%ROWTYPE; req spark.community_join_requests%ROWTYPE;
BEGIN
  SELECT r.community_id INTO target_community FROM spark.community_join_requests r WHERE r.id = p_request AND r.user_id = actor;
  IF target_community IS NULL THEN RETURN 'not_found'; END IF;
  target := spark.lock_community(target_community);
  IF target.id IS NULL THEN RETURN 'not_found'; END IF;
  SELECT * INTO req FROM spark.community_join_requests r WHERE r.id = p_request AND r.user_id = actor FOR UPDATE;
  IF req.status <> 'pending' THEN RETURN 'not_pending'; END IF;
  UPDATE spark.community_join_requests r SET status = 'withdrawn' WHERE r.id = req.id;
  RETURN 'ok';
END $$;
--> statement-breakpoint
-- Managers approve or reject an open request exactly once: the request row is locked and re-checked, so a
-- second decision returns already_decided and changes nothing. Approval creates or re-activates the
-- membership (role member) in the same transaction; a suspended membership stays suspended. The requester
-- gets a community_request_approved or community_request_rejected notification.
CREATE FUNCTION spark.ws_decide_community_request(p_request uuid, p_decision text) RETURNS TABLE(outcome text, membership_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); target_community uuid; target spark.communities%ROWTYPE; standing record;
  req spark.community_join_requests%ROWTYPE; membership spark.community_memberships%ROWTYPE; final_status text; next_version integer; event_id uuid;
  approve boolean := p_decision = 'approve';
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('approve','reject') THEN RAISE EXCEPTION 'Invalid decision' USING ERRCODE = '22023'; END IF;
  SELECT r.community_id INTO target_community FROM spark.community_join_requests r WHERE r.id = p_request;
  IF target_community IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::text; RETURN; END IF;
  target := spark.lock_community(target_community);
  IF target.id IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::text; RETURN; END IF;
  SELECT * INTO standing FROM spark.community_actor_access(target.tenant_id, target.id, target.visibility, actor);
  IF NOT standing.visible THEN RETURN QUERY SELECT 'not_found'::text, NULL::text; RETURN; END IF;
  IF NOT standing.manager THEN RETURN QUERY SELECT 'forbidden'::text, NULL::text; RETURN; END IF;
  SELECT * INTO req FROM spark.community_join_requests r WHERE r.id = p_request FOR UPDATE;
  IF req.status <> 'pending' THEN RETURN QUERY SELECT 'already_decided'::text, NULL::text; RETURN; END IF;
  IF target.frozen_at IS NOT NULL THEN RETURN QUERY SELECT 'community_frozen'::text, NULL::text; RETURN; END IF;
  IF approve THEN
    SELECT * INTO membership FROM spark.community_memberships m
      WHERE m.tenant_id = target.tenant_id AND m.community_id = target.id AND m.user_id = req.user_id FOR UPDATE;
    IF membership.id IS NULL THEN
      INSERT INTO spark.community_memberships (tenant_id, community_id, user_id, role, status) VALUES (target.tenant_id, target.id, req.user_id, 'member', 'active');
      final_status := 'active';
    ELSIF membership.status = 'left' THEN
      UPDATE spark.community_memberships m SET role = 'member', status = 'active', left_at = NULL, joined_at = now() WHERE m.id = membership.id;
      final_status := 'active';
    ELSE
      final_status := membership.status;
    END IF;
  END IF;
  UPDATE spark.community_join_requests r SET status = CASE WHEN approve THEN 'approved' ELSE 'rejected' END, reviewed_by_user_id = actor, reviewed_at = now()
    WHERE r.id = req.id;
  SELECT coalesce(max(o.aggregate_version), 0) + 1 INTO next_version FROM spark.outbox_events o
    WHERE o.tenant_id = target.tenant_id AND o.aggregate_type = 'community_join_request' AND o.aggregate_id = req.id;
  INSERT INTO spark.outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, processed_at)
    VALUES (target.tenant_id, CASE WHEN approve THEN 'community_join_request.approved' ELSE 'community_join_request.rejected' END,
      'community_join_request', req.id, next_version, jsonb_build_object('requestId', req.id, 'communityId', target.id), now())
    RETURNING id INTO event_id;
  INSERT INTO spark.notifications (tenant_id, recipient_user_id, outbox_event_id, kind, title, resource_type, resource_id)
    SELECT target.tenant_id, u.id, event_id, CASE WHEN approve THEN 'community_request_approved' ELSE 'community_request_rejected' END,
      left('Your request to join ' || target.name || CASE WHEN approve THEN ' was approved' ELSE ' was declined' END, 500), 'community', target.id
    FROM spark.users u WHERE u.id = req.user_id AND u.status = 'active' AND u.deleted_at IS NULL;
  PERFORM spark.record_workspace_audit(target.tenant_id, actor, CASE WHEN approve THEN 'community.request_approved' ELSE 'community.request_rejected' END,
    'community_join_request', req.id, jsonb_build_object('communityId', target.id, 'userId', req.user_id));
  RETURN QUERY SELECT CASE WHEN approve THEN 'approved' ELSE 'rejected' END, final_status;
END $$;
--> statement-breakpoint
-- Leaves a community. The last active owner cannot leave.
CREATE FUNCTION spark.ws_leave_community(p_community uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_session_actor(); target spark.communities%ROWTYPE; membership spark.community_memberships%ROWTYPE;
BEGIN
  target := spark.lock_community(p_community);
  IF target.id IS NULL THEN RETURN 'not_found'; END IF;
  SELECT * INTO membership FROM spark.community_memberships m
    WHERE m.tenant_id = target.tenant_id AND m.community_id = target.id AND m.user_id = actor AND m.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF membership.role = 'owner' AND (SELECT count(*) FROM spark.community_memberships m
      WHERE m.tenant_id = target.tenant_id AND m.community_id = target.id AND m.role = 'owner' AND m.status = 'active') <= 1 THEN
    RETURN 'last_owner';
  END IF;
  UPDATE spark.community_memberships m SET status = 'left', left_at = now() WHERE m.id = membership.id;
  RETURN 'ok';
END $$;
--> statement-breakpoint
-- Community owners and host workspace owners/admins change an active member's role. The last active
-- owner cannot be demoted.
CREATE FUNCTION spark.ws_set_community_role(p_community uuid, p_user uuid, p_role text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_session_actor(); target spark.communities%ROWTYPE; standing record; membership spark.community_memberships%ROWTYPE;
BEGIN
  IF p_role IS NULL OR p_role NOT IN ('owner','moderator','member') THEN RAISE EXCEPTION 'Invalid community role' USING ERRCODE = '22023'; END IF;
  target := spark.lock_community(p_community);
  IF target.id IS NULL THEN RETURN 'not_found'; END IF;
  SELECT * INTO standing FROM spark.community_actor_access(target.tenant_id, target.id, target.visibility, actor);
  IF NOT standing.visible THEN RETURN 'not_found'; END IF;
  IF NOT standing.administrator THEN RETURN 'forbidden'; END IF;
  SELECT * INTO membership FROM spark.community_memberships m
    WHERE m.tenant_id = target.tenant_id AND m.community_id = target.id AND m.user_id = p_user AND m.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF membership.role = p_role THEN RETURN 'ok'; END IF;
  IF membership.role = 'owner' AND (SELECT count(*) FROM spark.community_memberships m
      WHERE m.tenant_id = target.tenant_id AND m.community_id = target.id AND m.role = 'owner' AND m.status = 'active') <= 1 THEN
    RETURN 'last_owner';
  END IF;
  UPDATE spark.community_memberships m SET role = p_role WHERE m.id = membership.id;
  PERFORM spark.record_workspace_audit(target.tenant_id, actor, 'community.role_changed', 'community_membership', membership.id,
    jsonb_build_object('communityId', target.id, 'userId', membership.user_id, 'from', membership.role, 'to', p_role));
  RETURN 'ok';
END $$;
--> statement-breakpoint
-- Managers remove active members; moderators remove members only. The last active owner cannot be removed.
CREATE FUNCTION spark.ws_remove_community_member(p_community uuid, p_user uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_session_actor(); target spark.communities%ROWTYPE; standing record; membership spark.community_memberships%ROWTYPE;
BEGIN
  target := spark.lock_community(p_community);
  IF target.id IS NULL THEN RETURN 'not_found'; END IF;
  SELECT * INTO standing FROM spark.community_actor_access(target.tenant_id, target.id, target.visibility, actor);
  IF NOT standing.visible THEN RETURN 'not_found'; END IF;
  IF NOT standing.manager THEN RETURN 'forbidden'; END IF;
  SELECT * INTO membership FROM spark.community_memberships m
    WHERE m.tenant_id = target.tenant_id AND m.community_id = target.id AND m.user_id = p_user AND m.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF NOT standing.administrator AND membership.role <> 'member' THEN RETURN 'forbidden'; END IF;
  IF membership.role = 'owner' AND (SELECT count(*) FROM spark.community_memberships m
      WHERE m.tenant_id = target.tenant_id AND m.community_id = target.id AND m.role = 'owner' AND m.status = 'active') <= 1 THEN
    RETURN 'last_owner';
  END IF;
  UPDATE spark.community_memberships m SET status = 'left', left_at = now() WHERE m.id = membership.id;
  PERFORM spark.record_workspace_audit(target.tenant_id, actor, 'community.member_removed', 'community_membership', membership.id,
    jsonb_build_object('communityId', target.id, 'userId', membership.user_id, 'role', membership.role));
  RETURN 'ok';
END $$;
--> statement-breakpoint
-- Managers add an active member of the host workspace directly (the way hidden communities gain members).
-- A left membership is re-activated as a member; an open request of that user is marked approved. A
-- suspended membership is left as it is (already_member). Frozen communities refuse additions
-- (community_frozen) after the idempotent already_member answer and before any write.
CREATE FUNCTION spark.ws_add_community_member(p_community uuid, p_user uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_session_actor(); target spark.communities%ROWTYPE; standing record;
  membership spark.community_memberships%ROWTYPE; membership_id uuid;
BEGIN
  target := spark.lock_community(p_community);
  IF target.id IS NULL THEN RETURN 'not_found'; END IF;
  SELECT * INTO standing FROM spark.community_actor_access(target.tenant_id, target.id, target.visibility, actor);
  IF NOT standing.visible THEN RETURN 'not_found'; END IF;
  IF NOT standing.manager THEN RETURN 'forbidden'; END IF;
  -- The host workspace row is share-locked, so this membership cannot change before commit.
  IF NOT EXISTS (SELECT 1 FROM spark.workspace_memberships wm JOIN spark.users u ON u.id = wm.user_id
      WHERE wm.tenant_id = target.tenant_id AND wm.user_id = p_user AND wm.status = 'active' AND u.status = 'active' AND u.deleted_at IS NULL) THEN
    RETURN 'not_in_workspace';
  END IF;
  SELECT * INTO membership FROM spark.community_memberships m
    WHERE m.tenant_id = target.tenant_id AND m.community_id = target.id AND m.user_id = p_user FOR UPDATE;
  IF membership.status IN ('active','suspended') THEN RETURN 'already_member'; END IF;
  -- Frozen communities take no new members, like joins, requests and decisions.
  IF target.frozen_at IS NOT NULL THEN RETURN 'community_frozen'; END IF;
  IF membership.id IS NOT NULL THEN
    UPDATE spark.community_memberships m SET role = 'member', status = 'active', left_at = NULL, joined_at = now() WHERE m.id = membership.id;
    membership_id := membership.id;
  ELSE
    INSERT INTO spark.community_memberships (tenant_id, community_id, user_id, role, status) VALUES (target.tenant_id, target.id, p_user, 'member', 'active')
      RETURNING id INTO membership_id;
  END IF;
  UPDATE spark.community_join_requests r SET status = 'approved', reviewed_by_user_id = actor, reviewed_at = now()
    WHERE r.tenant_id = target.tenant_id AND r.community_id = target.id AND r.user_id = p_user AND r.status = 'pending';
  PERFORM spark.record_workspace_audit(target.tenant_id, actor, 'community.member_added', 'community_membership', membership_id,
    jsonb_build_object('communityId', target.id, 'userId', p_user));
  RETURN 'ok';
END $$;
--> statement-breakpoint
-- Reads for members and managers. users RLS only shows the actor and coworkers, so requesters and
-- members outside the host workspace are readable only through these projections. They never return an
-- email or the reviewer of a request. A community the actor cannot see raises P0002 'Community not
-- found'; a visible community without the needed standing raises 42501 'Community access denied'.
CREATE FUNCTION spark.ws_list_community_members(p_community uuid)
RETURNS TABLE(user_id uuid, display_name text, avatar_url text, role text, joined_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); target spark.communities%ROWTYPE; standing record;
BEGIN
  SELECT c.* INTO target FROM spark.communities c JOIN spark.workspaces w ON w.id = c.tenant_id
    WHERE c.id = p_community AND c.archived_at IS NULL AND w.status = 'active' AND w.archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Community not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO standing FROM spark.community_actor_access(target.tenant_id, target.id, target.visibility, actor);
  IF NOT standing.visible THEN RAISE EXCEPTION 'Community not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT (standing.member OR standing.manager) THEN RAISE EXCEPTION 'Community access denied' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT u.id, u.display_name, u.avatar_url, m.role, m.joined_at
    FROM spark.community_memberships m JOIN spark.users u ON u.id = m.user_id
    WHERE m.tenant_id = target.tenant_id AND m.community_id = target.id AND m.status = 'active' AND u.status = 'active' AND u.deleted_at IS NULL
    ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END, m.joined_at, u.id;
END $$;
--> statement-breakpoint
-- Join requests of a community for its managers, oldest first; p_status NULL lists every status.
CREATE FUNCTION spark.ws_list_community_requests(p_community uuid, p_status text)
RETURNS TABLE(id uuid, user_id uuid, display_name text, avatar_url text, message text, status text, created_at timestamptz, reviewed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); target spark.communities%ROWTYPE; standing record;
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN ('pending','approved','rejected','withdrawn') THEN
    RAISE EXCEPTION 'Invalid request status' USING ERRCODE = '22023';
  END IF;
  SELECT c.* INTO target FROM spark.communities c JOIN spark.workspaces w ON w.id = c.tenant_id
    WHERE c.id = p_community AND c.archived_at IS NULL AND w.status = 'active' AND w.archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Community not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO standing FROM spark.community_actor_access(target.tenant_id, target.id, target.visibility, actor);
  IF NOT standing.visible THEN RAISE EXCEPTION 'Community not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT standing.manager THEN RAISE EXCEPTION 'Community access denied' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT r.id, r.user_id, u.display_name, u.avatar_url, r.message, r.status, r.created_at, r.reviewed_at
    FROM spark.community_join_requests r JOIN spark.users u ON u.id = r.user_id
    WHERE r.tenant_id = target.tenant_id AND r.community_id = target.id AND (p_status IS NULL OR r.status = p_status)
    ORDER BY r.created_at, r.id;
END $$;
--> statement-breakpoint
-- Active host workspace members without an active or suspended membership, for the add-member picker.
CREATE FUNCTION spark.ws_list_community_member_candidates(p_community uuid)
RETURNS TABLE(user_id uuid, display_name text, avatar_url text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); target spark.communities%ROWTYPE; standing record;
BEGIN
  SELECT c.* INTO target FROM spark.communities c JOIN spark.workspaces w ON w.id = c.tenant_id
    WHERE c.id = p_community AND c.archived_at IS NULL AND w.status = 'active' AND w.archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Community not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO standing FROM spark.community_actor_access(target.tenant_id, target.id, target.visibility, actor);
  IF NOT standing.visible THEN RAISE EXCEPTION 'Community not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT standing.manager THEN RAISE EXCEPTION 'Community access denied' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT u.id, u.display_name, u.avatar_url
    FROM spark.workspace_memberships wm JOIN spark.users u ON u.id = wm.user_id
    WHERE wm.tenant_id = target.tenant_id AND wm.status = 'active' AND u.status = 'active' AND u.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM spark.community_memberships m
        WHERE m.tenant_id = target.tenant_id AND m.community_id = target.id AND m.user_id = u.id AND m.status IN ('active','suspended'))
    ORDER BY lower(u.display_name), u.id;
END $$;
--> statement-breakpoint
-- The actor's own join requests, newest first, for communities they can still see.
CREATE FUNCTION spark.ws_list_my_community_requests()
RETURNS TABLE(id uuid, community_id uuid, community_slug text, community_name text, status text, message text, created_at timestamptz, reviewed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor();
BEGIN
  RETURN QUERY SELECT r.id, c.id, c.slug, c.name, r.status, r.message, r.created_at, r.reviewed_at
    FROM spark.community_join_requests r
    JOIN spark.communities c ON c.id = r.community_id AND c.tenant_id = r.tenant_id
    JOIN spark.workspaces w ON w.id = c.tenant_id
    CROSS JOIN LATERAL spark.community_actor_access(c.tenant_id, c.id, c.visibility, actor) standing
    WHERE r.user_id = actor AND c.archived_at IS NULL AND w.status = 'active' AND w.archived_at IS NULL AND standing.visible
    ORDER BY r.created_at DESC, r.id DESC;
END $$;
--> statement-breakpoint
-- The communities a workspace hosts, as discovery cards, for its active members: hidden ones only for
-- their members and managers, archived ones never. A non-member raises P0002 'Workspace not found'.
CREATE FUNCTION spark.ws_list_workspace_communities(p_workspace uuid)
RETURNS TABLE(id uuid, slug text, name text, tagline text, visibility text, country_code text, city text, stage text, topics text[],
  member_count bigint, weekly_posts bigint, featured boolean, frozen boolean, host_workspace_name text, viewer_status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM spark.workspace_memberships m JOIN spark.workspaces w ON w.id = m.tenant_id
      WHERE m.tenant_id = p_workspace AND m.user_id = actor AND m.status = 'active' AND w.status = 'active' AND w.archived_at IS NULL) THEN
    RAISE EXCEPTION 'Workspace not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY SELECT card.* FROM spark.community_cards(actor, ARRAY(
    SELECT c.id FROM spark.communities c
    CROSS JOIN LATERAL spark.community_actor_access(c.tenant_id, c.id, c.visibility, actor) standing
    WHERE c.tenant_id = p_workspace AND c.archived_at IS NULL AND standing.visible)) card
  ORDER BY lower(card.name), card.id;
END $$;
--> statement-breakpoint
-- The communities the actor actively belongs to, as discovery cards, by name. Archived communities and
-- those of an inactive host workspace are left out.
CREATE FUNCTION spark.my_communities()
RETURNS TABLE(id uuid, slug text, name text, tagline text, visibility text, country_code text, city text, stage text, topics text[],
  member_count bigint, weekly_posts bigint, featured boolean, frozen boolean, host_workspace_name text, viewer_status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor();
BEGIN
  RETURN QUERY SELECT card.* FROM spark.community_cards(actor, ARRAY(
    SELECT c.id FROM spark.community_memberships m
    JOIN spark.communities c ON c.id = m.community_id AND c.tenant_id = m.tenant_id
    JOIN spark.workspaces w ON w.id = c.tenant_id
    WHERE m.user_id = actor AND m.status = 'active' AND c.archived_at IS NULL AND w.status = 'active' AND w.archived_at IS NULL)) card
  ORDER BY lower(card.name), card.id;
END $$;
--> statement-breakpoint
-- Notification reads (0028), redefined: a row is visible when the actor is the recipient and the row's
-- workspace is one of the actor's active workspaces, or the row is about a community (resource_type
-- 'community'), so requesters outside the host workspace see decisions on their requests. For community
-- rows tenant_id, workspace_slug and workspace_name are the host workspace's.
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
    END,
    n.created_at, n.read_at
  FROM spark.notifications n JOIN spark.workspaces w ON w.id = n.tenant_id
  WHERE n.recipient_user_id = actor AND (n.tenant_id = ANY(spark.session_workspace_ids()) OR n.resource_type = 'community')
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
    WHERE n.recipient_user_id = actor AND (n.tenant_id = ANY(spark.session_workspace_ids()) OR n.resource_type = 'community') AND n.read_at IS NULL
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
      AND n.recipient_user_id = actor AND (n.tenant_id = ANY(spark.session_workspace_ids()) OR n.resource_type = 'community')) THEN
    RETURN QUERY SELECT 'not_found'::text; RETURN;
  END IF;
  UPDATE spark.notifications n SET read_at = now()
    WHERE n.id = p_notification AND n.recipient_user_id = actor AND n.read_at IS NULL
      AND (n.tenant_id = ANY(spark.session_workspace_ids()) OR n.resource_type = 'community');
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
    WHERE n.recipient_user_id = actor AND (n.tenant_id = ANY(spark.session_workspace_ids()) OR n.resource_type = 'community')
      AND n.read_at IS NULL AND n.created_at <= p_before;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN QUERY SELECT changed;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.check_community_field(text,text), spark.check_community_topics(text[]), spark.lock_community(uuid),
  spark.community_actor_access(uuid,uuid,text,uuid),
  spark.ws_create_community(uuid,text,text,text,text,text,text,text,text,text[]), spark.ws_update_community(uuid,integer,jsonb),
  spark.ws_join_community(uuid), spark.ws_request_community_membership(uuid,text), spark.ws_withdraw_community_request(uuid),
  spark.ws_decide_community_request(uuid,text), spark.ws_leave_community(uuid), spark.ws_set_community_role(uuid,uuid,text),
  spark.ws_remove_community_member(uuid,uuid), spark.ws_add_community_member(uuid,uuid), spark.ws_list_community_members(uuid),
  spark.ws_list_community_requests(uuid,text), spark.ws_list_community_member_candidates(uuid), spark.ws_list_my_community_requests(),
  spark.ws_list_workspace_communities(uuid), spark.my_communities() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION spark.ws_create_community(uuid,text,text,text,text,text,text,text,text,text[]), spark.ws_update_community(uuid,integer,jsonb),
  spark.ws_join_community(uuid), spark.ws_request_community_membership(uuid,text), spark.ws_withdraw_community_request(uuid),
  spark.ws_decide_community_request(uuid,text), spark.ws_leave_community(uuid), spark.ws_set_community_role(uuid,uuid,text),
  spark.ws_remove_community_member(uuid,uuid), spark.ws_add_community_member(uuid,uuid), spark.ws_list_community_members(uuid),
  spark.ws_list_community_requests(uuid,text), spark.ws_list_community_member_candidates(uuid), spark.ws_list_my_community_requests(),
  spark.ws_list_workspace_communities(uuid), spark.my_communities() TO spark_app;
