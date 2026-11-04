-- Calendar event writes (M6). The runtime role has no INSERT, UPDATE or DELETE grant on calendar_events
-- or event_attendees: events are created, edited and cancelled, and invitations answered, only through
-- the four spark.ws_* definer functions below. They derive the actor from the live session and return a
-- closed set of outcomes; every write bumps calendar_events.version, except an attendee's answer, which
-- only touches that attendee's row.
-- Authority: any active member creates an event and is its organizer; the organizer or a workspace
-- owner/admin edits and cancels it; only an invited attendee answers, for themself.
-- Decision order: actor, event and membership (not_found, before any input error), authority (forbidden),
-- input validation (22023 with a fixed message), cancelled, version, then the write. Lock order: workspace
-- row FOR SHARE (spark.lock_workspace_member), the event row (FOR UPDATE for writes, FOR SHARE for an
-- answer, which must not wait behind other answers), then attendee rows by user_id.
-- Notifications are in-app only. Each write inserts one processed outbox row (aggregate_type
-- calendar_event, aggregate_version = the event version after the write) and its notifications in the same
-- transaction; only active members of the workspace are notified, never the actor.
ALTER TABLE spark.notifications DROP CONSTRAINT notifications_kind_allowed;
ALTER TABLE spark.notifications ADD CONSTRAINT notifications_kind_allowed CHECK (kind IN ('invitation_accepted','issue_assigned','sprint_started',
  'event_invited','event_rescheduled','event_cancelled'));
--> statement-breakpoint
-- Internal: true when the name is an IANA zone known to the server (pg_timezone_names). NULL is not valid.
CREATE FUNCTION spark.valid_timezone(p_zone text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT p_zone IS NOT NULL AND EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name = p_zone);
$$;
--> statement-breakpoint
-- maintain_record treats project_id as part of a row's identity, so an event could never be linked to or
-- moved between projects. Events keep the same guard with project_id left out: the identity columns stay
-- immutable, the version advances by exactly one, updated_at is maintained.
CREATE FUNCTION spark.maintain_calendar_event() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Record identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Version must advance by exactly one' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := statement_timestamp(); RETURN NEW;
END $$;
DROP TRIGGER maintain_record ON spark.calendar_events;
CREATE TRIGGER maintain_record BEFORE UPDATE ON spark.calendar_events FOR EACH ROW EXECUTE FUNCTION spark.maintain_calendar_event();
--> statement-breakpoint
-- Internal: the field rules of an event, raising 22023 with a fixed message. Title, description and
-- location are already trimmed (blank description and location arrive as NULL). Times are between
-- 2000-01-01 and 2100-12-31 and 5 minutes to 14 days apart; the checks are nested so an infinite value
-- never reaches the subtraction. p_links checks the project (non-archived, same workspace) and the issue
-- (requires a project, belongs to it, not archived). p_attendees (NULL = not checked) are at most 50
-- distinct active members of the workspace.
CREATE FUNCTION spark.check_event_fields(p_tenant uuid, p_title text, p_description text, p_location text, p_starts timestamptz, p_ends timestamptz,
  p_timezone text, p_project uuid, p_issue uuid, p_attendees uuid[], p_links boolean) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE lowest constant timestamptz := TIMESTAMPTZ '2000-01-01 00:00:00+00'; highest constant timestamptz := TIMESTAMPTZ '2101-01-01 00:00:00+00';
BEGIN
  IF p_title IS NULL OR length(p_title) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid event title' USING ERRCODE = '22023';
  END IF;
  IF length(p_description) > 2000 THEN
    RAISE EXCEPTION 'Invalid event description' USING ERRCODE = '22023';
  END IF;
  IF length(p_location) > 200 THEN
    RAISE EXCEPTION 'Invalid event location' USING ERRCODE = '22023';
  END IF;
  IF p_starts IS NULL OR p_ends IS NULL OR p_starts < lowest OR p_starts >= highest OR p_ends < lowest OR p_ends >= highest THEN
    RAISE EXCEPTION 'Invalid event time' USING ERRCODE = '22023';
  END IF;
  IF p_ends <= p_starts OR p_ends - p_starts < interval '5 minutes' OR p_ends - p_starts > interval '14 days' THEN
    RAISE EXCEPTION 'Invalid event time' USING ERRCODE = '22023';
  END IF;
  IF NOT spark.valid_timezone(p_timezone) THEN
    RAISE EXCEPTION 'Invalid event timezone' USING ERRCODE = '22023';
  END IF;
  IF p_links THEN
    IF p_project IS NOT NULL AND NOT EXISTS (SELECT 1 FROM spark.projects p
        WHERE p.tenant_id = p_tenant AND p.id = p_project AND p.archived_at IS NULL) THEN
      RAISE EXCEPTION 'Invalid event project' USING ERRCODE = '22023';
    END IF;
    IF p_issue IS NOT NULL AND (p_project IS NULL OR NOT EXISTS (SELECT 1 FROM spark.issues i
        WHERE i.tenant_id = p_tenant AND i.project_id = p_project AND i.id = p_issue AND i.archived_at IS NULL)) THEN
      RAISE EXCEPTION 'Invalid event issue' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_attendees IS NOT NULL THEN
    IF cardinality(p_attendees) > 50 OR EXISTS (SELECT 1 FROM unnest(p_attendees) a WHERE a IS NULL)
      OR (SELECT count(DISTINCT a) FROM unnest(p_attendees) a) <> cardinality(p_attendees)
      OR (SELECT count(*) FROM unnest(p_attendees) a
          JOIN spark.workspace_memberships m ON m.tenant_id = p_tenant AND m.user_id = a AND m.status = 'active'
          JOIN spark.users u ON u.id = m.user_id AND u.status = 'active' AND u.deleted_at IS NULL) <> cardinality(p_attendees) THEN
      RAISE EXCEPTION 'Invalid event attendees' USING ERRCODE = '22023';
    END IF;
  END IF;
END $$;
--> statement-breakpoint
-- Creates a scheduled event at version 1 with the actor as organizer. The organizer is always an attendee
-- with response accepted (whether listed or not); every other listed attendee starts pending and gets an
-- event_invited notification. Non-members and unknown workspaces get not_found before any input error.
CREATE FUNCTION spark.ws_create_event(p_workspace uuid, p_title text, p_description text, p_location text, p_starts timestamptz, p_ends timestamptz,
  p_timezone text, p_project uuid, p_issue uuid, p_attendees uuid[])
RETURNS TABLE(outcome text, event_id uuid, event_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); clean_title text := btrim(p_title);
  clean_description text := nullif(btrim(p_description), ''); clean_location text := nullif(btrim(p_location), '');
  invitees uuid[]; new_event uuid := gen_random_uuid(); outbox_id uuid; actor_name text;
BEGIN
  IF spark.lock_workspace_member(p_workspace, actor) IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  PERFORM spark.check_event_fields(p_workspace, clean_title, clean_description, clean_location, p_starts, p_ends, p_timezone, p_project, p_issue,
    coalesce(p_attendees, ARRAY[]::uuid[]), true);
  SELECT coalesce(array_agg(a ORDER BY a), ARRAY[]::uuid[]) INTO invitees FROM unnest(coalesce(p_attendees, ARRAY[]::uuid[])) a WHERE a <> actor;

  INSERT INTO spark.calendar_events (id, tenant_id, project_id, issue_id, organizer_user_id, title, description, location, starts_at, ends_at, timezone)
    VALUES (new_event, p_workspace, p_project, p_issue, actor, clean_title, clean_description, clean_location, p_starts, p_ends, p_timezone);
  INSERT INTO spark.event_attendees (tenant_id, event_id, user_id, response, responded_at)
    VALUES (p_workspace, new_event, actor, 'accepted', now());
  INSERT INTO spark.event_attendees (tenant_id, event_id, user_id)
    SELECT p_workspace, new_event, a FROM unnest(invitees) a ORDER BY a;
  INSERT INTO spark.outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, processed_at)
    VALUES (p_workspace, 'calendar_event.created', 'calendar_event', new_event, 1,
      jsonb_build_object('eventId', new_event, 'actorUserId', actor), now())
    RETURNING id INTO outbox_id;
  SELECT btrim(u.display_name) INTO actor_name FROM spark.users u WHERE u.id = actor;
  INSERT INTO spark.notifications (tenant_id, recipient_user_id, outbox_event_id, kind, title, resource_type, resource_id)
    SELECT p_workspace, a, outbox_id, 'event_invited', left(actor_name || ' invited you to ' || clean_title, 500), 'calendar_event', new_event
    FROM unnest(invitees) a ORDER BY a;
  RETURN QUERY SELECT 'ok'::text, new_event, 1;
END $$;
--> statement-breakpoint
-- Patch keys: title, description, location, startsAt, endsAt, timezone, projectId, issueId, attendeeUserIds.
-- Any other key, or a patch that is not an object, raises Invalid event patch; {} is a no-op. Values are
-- checked on the resulting event. A patch that changes nothing returns ok with the current version and
-- writes nothing. attendeeUserIds replaces the invited set: kept attendees keep their answer, new ones start
-- pending and are invited, removed ones (and the left members among them) are deleted; the organizer always
-- stays. Changing startsAt or endsAt sets every non-organizer attendee back to pending and notifies the
-- attendees who were already invited (the newly invited get the invitation instead).
CREATE FUNCTION spark.ws_update_event(p_event uuid, p_expected_version integer, p_patch jsonb)
RETURNS TABLE(outcome text, event_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); target_tenant uuid; actor_role text; cur spark.calendar_events%ROWTYPE;
  time_pattern constant text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$';
  uuid_pattern constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  new_title text; new_description text; new_location text; new_starts timestamptz; new_ends timestamptz; new_timezone text;
  new_project uuid; new_issue uuid; wanted uuid[]; element jsonb; existing uuid[]; added uuid[]; removed uuid[];
  time_changed boolean; attendees_changed boolean; outbox_id uuid; actor_name text; next_version integer;
BEGIN
  SELECT e.tenant_id INTO target_tenant FROM spark.calendar_events e WHERE e.id = p_event;
  IF target_tenant IS NOT NULL THEN actor_role := spark.lock_workspace_member(target_tenant, actor); END IF;
  IF actor_role IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  SELECT * INTO cur FROM spark.calendar_events e WHERE e.tenant_id = target_tenant AND e.id = p_event FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  IF actor_role NOT IN ('owner','admin') AND cur.organizer_user_id <> actor THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::integer; RETURN;
  END IF;

  IF jsonb_typeof(p_patch) IS DISTINCT FROM 'object'
    OR (p_patch - ARRAY['title','description','location','startsAt','endsAt','timezone','projectId','issueId','attendeeUserIds']) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Invalid event patch' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'title' AND jsonb_typeof(p_patch->'title') <> 'string' THEN
    RAISE EXCEPTION 'Invalid event title' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'description' AND jsonb_typeof(p_patch->'description') NOT IN ('string','null') THEN
    RAISE EXCEPTION 'Invalid event description' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'location' AND jsonb_typeof(p_patch->'location') NOT IN ('string','null') THEN
    RAISE EXCEPTION 'Invalid event location' USING ERRCODE = '22023';
  END IF;
  IF (p_patch ? 'startsAt' AND (jsonb_typeof(p_patch->'startsAt') <> 'string'
        OR NOT (p_patch->>'startsAt' ~ time_pattern AND pg_input_is_valid(p_patch->>'startsAt', 'timestamptz'))))
    OR (p_patch ? 'endsAt' AND (jsonb_typeof(p_patch->'endsAt') <> 'string'
        OR NOT (p_patch->>'endsAt' ~ time_pattern AND pg_input_is_valid(p_patch->>'endsAt', 'timestamptz')))) THEN
    RAISE EXCEPTION 'Invalid event time' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'timezone' AND jsonb_typeof(p_patch->'timezone') <> 'string' THEN
    RAISE EXCEPTION 'Invalid event timezone' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'projectId' AND (jsonb_typeof(p_patch->'projectId') NOT IN ('string','null')
      OR (jsonb_typeof(p_patch->'projectId') = 'string' AND NOT (p_patch->>'projectId' ~ uuid_pattern))) THEN
    RAISE EXCEPTION 'Invalid event project' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'issueId' AND (jsonb_typeof(p_patch->'issueId') NOT IN ('string','null')
      OR (jsonb_typeof(p_patch->'issueId') = 'string' AND NOT (p_patch->>'issueId' ~ uuid_pattern))) THEN
    RAISE EXCEPTION 'Invalid event issue' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'attendeeUserIds' THEN
    IF jsonb_typeof(p_patch->'attendeeUserIds') <> 'array' OR jsonb_array_length(p_patch->'attendeeUserIds') > 50 THEN
      RAISE EXCEPTION 'Invalid event attendees' USING ERRCODE = '22023';
    END IF;
    wanted := ARRAY[]::uuid[];
    FOR element IN SELECT value FROM jsonb_array_elements(p_patch->'attendeeUserIds') LOOP
      IF jsonb_typeof(element) <> 'string' OR NOT (element #>> '{}' ~ uuid_pattern) THEN
        RAISE EXCEPTION 'Invalid event attendees' USING ERRCODE = '22023';
      END IF;
      wanted := wanted || (element #>> '{}')::uuid;
    END LOOP;
  END IF;

  new_title := CASE WHEN p_patch ? 'title' THEN btrim(p_patch->>'title') ELSE cur.title END;
  new_description := CASE WHEN p_patch ? 'description' THEN nullif(btrim(p_patch->>'description'), '') ELSE cur.description END;
  new_location := CASE WHEN p_patch ? 'location' THEN nullif(btrim(p_patch->>'location'), '') ELSE cur.location END;
  new_starts := CASE WHEN p_patch ? 'startsAt' THEN (p_patch->>'startsAt')::timestamptz ELSE cur.starts_at END;
  new_ends := CASE WHEN p_patch ? 'endsAt' THEN (p_patch->>'endsAt')::timestamptz ELSE cur.ends_at END;
  new_timezone := CASE WHEN p_patch ? 'timezone' THEN p_patch->>'timezone' ELSE cur.timezone END;
  new_project := CASE WHEN p_patch ? 'projectId' THEN (p_patch->>'projectId')::uuid ELSE cur.project_id END;
  new_issue := CASE WHEN p_patch ? 'issueId' THEN (p_patch->>'issueId')::uuid ELSE cur.issue_id END;
  PERFORM spark.check_event_fields(target_tenant, new_title, new_description, new_location, new_starts, new_ends, new_timezone, new_project, new_issue,
    wanted, p_patch ? 'projectId' OR p_patch ? 'issueId');

  IF cur.status = 'cancelled' THEN RETURN QUERY SELECT 'cancelled'::text, NULL::integer; RETURN; END IF;
  IF p_expected_version IS DISTINCT FROM cur.version THEN
    RETURN QUERY SELECT 'version_mismatch'::text, cur.version; RETURN;
  END IF;

  -- Attendee rows are locked by user_id; the organizer's row is never added to or removed from the set.
  SELECT coalesce(array_agg(a.user_id ORDER BY a.user_id), ARRAY[]::uuid[]) INTO existing FROM (
    SELECT t.user_id FROM spark.event_attendees t WHERE t.tenant_id = cur.tenant_id AND t.event_id = cur.id AND t.user_id <> cur.organizer_user_id
    ORDER BY t.user_id FOR UPDATE) a;
  added := ARRAY[]::uuid[]; removed := ARRAY[]::uuid[];
  IF wanted IS NOT NULL THEN
    SELECT coalesce(array_agg(w ORDER BY w), ARRAY[]::uuid[]) INTO added FROM unnest(wanted) w WHERE w <> cur.organizer_user_id AND w <> ALL (existing);
    SELECT coalesce(array_agg(x ORDER BY x), ARRAY[]::uuid[]) INTO removed FROM unnest(existing) x WHERE x <> ALL (wanted);
  END IF;
  time_changed := new_starts IS DISTINCT FROM cur.starts_at OR new_ends IS DISTINCT FROM cur.ends_at;
  attendees_changed := cardinality(added) > 0 OR cardinality(removed) > 0;
  IF NOT time_changed AND NOT attendees_changed AND new_title IS NOT DISTINCT FROM cur.title AND new_description IS NOT DISTINCT FROM cur.description
    AND new_location IS NOT DISTINCT FROM cur.location AND new_timezone IS NOT DISTINCT FROM cur.timezone
    AND new_project IS NOT DISTINCT FROM cur.project_id AND new_issue IS NOT DISTINCT FROM cur.issue_id THEN
    RETURN QUERY SELECT 'ok'::text, cur.version; RETURN;
  END IF;

  next_version := cur.version + 1;
  UPDATE spark.calendar_events e SET title = new_title, description = new_description, location = new_location, starts_at = new_starts, ends_at = new_ends,
    timezone = new_timezone, project_id = new_project, issue_id = new_issue, version = next_version
    WHERE e.tenant_id = cur.tenant_id AND e.id = cur.id;
  DELETE FROM spark.event_attendees t WHERE t.tenant_id = cur.tenant_id AND t.event_id = cur.id AND t.user_id = ANY (removed);
  INSERT INTO spark.event_attendees (tenant_id, event_id, user_id)
    SELECT cur.tenant_id, cur.id, a FROM unnest(added) a ORDER BY a;
  IF time_changed THEN
    UPDATE spark.event_attendees t SET response = 'pending', responded_at = NULL
      WHERE t.tenant_id = cur.tenant_id AND t.event_id = cur.id AND t.user_id <> cur.organizer_user_id AND (t.response <> 'pending' OR t.responded_at IS NOT NULL);
  END IF;

  INSERT INTO spark.outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, processed_at)
    VALUES (cur.tenant_id, 'calendar_event.updated', 'calendar_event', cur.id, next_version,
      jsonb_build_object('eventId', cur.id, 'actorUserId', actor), now())
    RETURNING id INTO outbox_id;
  SELECT btrim(u.display_name) INTO actor_name FROM spark.users u WHERE u.id = actor;
  INSERT INTO spark.notifications (tenant_id, recipient_user_id, outbox_event_id, kind, title, resource_type, resource_id)
    SELECT cur.tenant_id, a, outbox_id, 'event_invited', left(actor_name || ' invited you to ' || new_title, 500), 'calendar_event', cur.id
    FROM unnest(added) a WHERE a <> actor
      AND EXISTS (SELECT 1 FROM spark.workspace_memberships m JOIN spark.users u ON u.id = m.user_id
        WHERE m.tenant_id = cur.tenant_id AND m.user_id = a AND m.status = 'active' AND u.status = 'active' AND u.deleted_at IS NULL)
    ORDER BY a;
  IF time_changed THEN
    INSERT INTO spark.notifications (tenant_id, recipient_user_id, outbox_event_id, kind, title, resource_type, resource_id)
      SELECT cur.tenant_id, t.user_id, outbox_id, 'event_rescheduled',
        left(new_title || ' moved to ' || to_char(new_starts AT TIME ZONE new_timezone, 'YYYY-MM-DD HH24:MI') || ' (' || new_timezone || ')', 500),
        'calendar_event', cur.id
      FROM spark.event_attendees t
      WHERE t.tenant_id = cur.tenant_id AND t.event_id = cur.id AND t.user_id <> actor AND t.user_id <> ALL (added)
        AND EXISTS (SELECT 1 FROM spark.workspace_memberships m JOIN spark.users u ON u.id = m.user_id
          WHERE m.tenant_id = cur.tenant_id AND m.user_id = t.user_id AND m.status = 'active' AND u.status = 'active' AND u.deleted_at IS NULL)
      ORDER BY t.user_id;
  END IF;
  RETURN QUERY SELECT 'ok'::text, next_version;
END $$;
--> statement-breakpoint
-- scheduled (or completed) -> cancelled, terminal. Every attendee except the actor is notified
-- (event_cancelled). already_cancelled is answered before the version check, as for sprint starts.
CREATE FUNCTION spark.ws_cancel_event(p_event uuid, p_expected_version integer)
RETURNS TABLE(outcome text, event_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); target_tenant uuid; actor_role text; cur spark.calendar_events%ROWTYPE; outbox_id uuid;
BEGIN
  SELECT e.tenant_id INTO target_tenant FROM spark.calendar_events e WHERE e.id = p_event;
  IF target_tenant IS NOT NULL THEN actor_role := spark.lock_workspace_member(target_tenant, actor); END IF;
  IF actor_role IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  SELECT * INTO cur FROM spark.calendar_events e WHERE e.tenant_id = target_tenant AND e.id = p_event FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  IF actor_role NOT IN ('owner','admin') AND cur.organizer_user_id <> actor THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::integer; RETURN;
  END IF;
  IF cur.status = 'cancelled' THEN RETURN QUERY SELECT 'already_cancelled'::text, NULL::integer; RETURN; END IF;
  IF p_expected_version IS DISTINCT FROM cur.version THEN
    RETURN QUERY SELECT 'version_mismatch'::text, cur.version; RETURN;
  END IF;

  UPDATE spark.calendar_events e SET status = 'cancelled', version = cur.version + 1 WHERE e.tenant_id = cur.tenant_id AND e.id = cur.id;
  INSERT INTO spark.outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, processed_at)
    VALUES (cur.tenant_id, 'calendar_event.cancelled', 'calendar_event', cur.id, cur.version + 1,
      jsonb_build_object('eventId', cur.id, 'actorUserId', actor), now())
    RETURNING id INTO outbox_id;
  INSERT INTO spark.notifications (tenant_id, recipient_user_id, outbox_event_id, kind, title, resource_type, resource_id)
    SELECT cur.tenant_id, t.user_id, outbox_id, 'event_cancelled', left(cur.title || ' was cancelled', 500), 'calendar_event', cur.id
    FROM spark.event_attendees t
    WHERE t.tenant_id = cur.tenant_id AND t.event_id = cur.id AND t.user_id <> actor
      AND EXISTS (SELECT 1 FROM spark.workspace_memberships m JOIN spark.users u ON u.id = m.user_id
        WHERE m.tenant_id = cur.tenant_id AND m.user_id = t.user_id AND m.status = 'active' AND u.status = 'active' AND u.deleted_at IS NULL)
    ORDER BY t.user_id;
  RETURN QUERY SELECT 'ok'::text, cur.version + 1;
END $$;
--> statement-breakpoint
-- The actor answers their own invitation (the organizer may answer too). The value is checked after the
-- membership check, so a stranger learns nothing from it. An answer does not change the event version.
-- The event row is locked FOR SHARE so answers do not queue behind each other but do wait for a cancel.
CREATE FUNCTION spark.ws_respond_event(p_event uuid, p_response text)
RETURNS TABLE(outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); target_tenant uuid; actor_role text; cur spark.calendar_events%ROWTYPE; attending boolean;
BEGIN
  SELECT e.tenant_id INTO target_tenant FROM spark.calendar_events e WHERE e.id = p_event;
  IF target_tenant IS NOT NULL THEN actor_role := spark.lock_workspace_member(target_tenant, actor); END IF;
  IF actor_role IS NULL THEN RETURN QUERY SELECT 'not_found'::text; RETURN; END IF;
  IF p_response IS NULL OR p_response NOT IN ('accepted','declined','tentative') THEN
    RAISE EXCEPTION 'Invalid event response' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO cur FROM spark.calendar_events e WHERE e.tenant_id = target_tenant AND e.id = p_event FOR SHARE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text; RETURN; END IF;
  SELECT true INTO attending FROM spark.event_attendees t
    WHERE t.tenant_id = cur.tenant_id AND t.event_id = cur.id AND t.user_id = actor FOR UPDATE;
  IF attending IS NULL THEN RETURN QUERY SELECT 'not_invited'::text; RETURN; END IF;
  IF cur.status = 'cancelled' THEN RETURN QUERY SELECT 'cancelled'::text; RETURN; END IF;
  UPDATE spark.event_attendees t SET response = p_response, responded_at = now()
    WHERE t.tenant_id = cur.tenant_id AND t.event_id = cur.id AND t.user_id = actor;
  RETURN QUERY SELECT 'ok'::text;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.valid_timezone(text), spark.maintain_calendar_event(),
  spark.check_event_fields(uuid,text,text,text,timestamptz,timestamptz,text,uuid,uuid,uuid[],boolean) FROM PUBLIC, spark_app;
REVOKE ALL ON FUNCTION spark.ws_create_event(uuid,text,text,text,timestamptz,timestamptz,text,uuid,uuid,uuid[]), spark.ws_update_event(uuid,integer,jsonb),
  spark.ws_cancel_event(uuid,integer), spark.ws_respond_event(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION spark.ws_create_event(uuid,text,text,text,timestamptz,timestamptz,text,uuid,uuid,uuid[]), spark.ws_update_event(uuid,integer,jsonb),
  spark.ws_cancel_event(uuid,integer), spark.ws_respond_event(uuid,text) TO spark_app;
