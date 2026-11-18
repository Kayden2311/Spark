-- Fix to 0035. ws_update_community approved pending requests on private to public even for a frozen
-- community, bypassing the rule that frozen communities take no new members. It now approves only when the
-- community is not frozen; the visibility change itself still succeeds and the requests stay pending.
CREATE OR REPLACE FUNCTION spark.ws_update_community(p_community uuid, p_expected_version integer, p_patch jsonb)
RETURNS TABLE(outcome text, settings_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); patch_key text; target spark.communities%ROWTYPE; standing record;
  new_name text; new_tagline text; new_description text; new_visibility text; new_country text; new_city text; new_stage text; new_topics text[];
  current_topics text[]; changed text[] := ARRAY[]::text[];
  pending record; membership spark.community_memberships%ROWTYPE; event_id uuid; next_version integer;
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
  -- Opening a private community approves every pending request with the membership rules of
  -- ws_decide_community_request (a suspended membership stays suspended). A frozen community takes no new
  -- members, so its requests stay pending for the managers to decide after it is unfrozen. Lock order: community, request, membership.
  IF 'visibility' = ANY (changed) AND target.visibility = 'private' AND new_visibility = 'public' AND target.frozen_at IS NULL THEN
    FOR pending IN SELECT r.id, r.user_id FROM spark.community_join_requests r
      WHERE r.tenant_id = target.tenant_id AND r.community_id = target.id AND r.status = 'pending' ORDER BY r.created_at, r.id FOR UPDATE LOOP
      SELECT * INTO membership FROM spark.community_memberships m
        WHERE m.tenant_id = target.tenant_id AND m.community_id = target.id AND m.user_id = pending.user_id FOR UPDATE;
      IF membership.id IS NULL THEN
        INSERT INTO spark.community_memberships (tenant_id, community_id, user_id, role, status) VALUES (target.tenant_id, target.id, pending.user_id, 'member', 'active');
      ELSIF membership.status = 'left' THEN
        UPDATE spark.community_memberships m SET role = 'member', status = 'active', left_at = NULL, joined_at = now() WHERE m.id = membership.id;
      END IF;
      UPDATE spark.community_join_requests r SET status = 'approved', reviewed_by_user_id = actor, reviewed_at = now() WHERE r.id = pending.id;
      SELECT coalesce(max(o.aggregate_version), 0) + 1 INTO next_version FROM spark.outbox_events o
        WHERE o.tenant_id = target.tenant_id AND o.aggregate_type = 'community_join_request' AND o.aggregate_id = pending.id;
      INSERT INTO spark.outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, processed_at)
        VALUES (target.tenant_id, 'community_join_request.approved', 'community_join_request', pending.id, next_version,
          jsonb_build_object('requestId', pending.id, 'communityId', target.id), now())
        RETURNING id INTO event_id;
      INSERT INTO spark.notifications (tenant_id, recipient_user_id, outbox_event_id, kind, title, resource_type, resource_id)
        SELECT target.tenant_id, u.id, event_id, 'community_request_approved',
          left('Your request to join ' || coalesce(new_name, target.name) || ' was approved', 500), 'community', target.id
        FROM spark.users u WHERE u.id = pending.user_id AND u.status = 'active' AND u.deleted_at IS NULL;
      PERFORM spark.record_workspace_audit(target.tenant_id, actor, 'community.request_approved', 'community_join_request', pending.id,
        jsonb_build_object('communityId', target.id, 'userId', pending.user_id));
    END LOOP;
  END IF;
  PERFORM spark.record_workspace_audit(target.tenant_id, actor, 'community.updated', 'community', target.id,
    jsonb_build_object('changed', to_jsonb(ARRAY(SELECT key FROM unnest(changed) AS key ORDER BY key COLLATE "C"))));
  RETURN QUERY SELECT 'ok'::text, target.settings_version + 1;
END $$;
