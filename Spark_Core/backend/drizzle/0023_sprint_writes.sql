-- Sprint writes (M4). The runtime role still has no INSERT, UPDATE or DELETE grant on sprints or
-- sprint_commitments: sprints are created, edited, started and completed only through the four spark.ws_*
-- definer functions below, which derive the actor from the live session and return a closed set of
-- outcomes. Owners, admins and the project's current lead plan sprints; any active member assigns issues
-- to a sprint through ws_update_issue (sprintId patch key, replaced at the end of this file).
-- Decision order in every sprint function: actor, sprint or project and membership (not_found, before any
-- input error), authority (forbidden), methodology (22023 Invalid methodology unless Scrum), input
-- validation (22023), version, state. Lock order: workspace row FOR SHARE (lock_workspace_member), project
-- FOR UPDATE, board, sprints by id, issues by id. Sprint dates are calendar days stored as midnight UTC in
-- starts_at/ends_at; a sprint lasts ends - starts days, 1 to 28.
ALTER TABLE spark.notifications DROP CONSTRAINT notifications_kind_allowed;
ALTER TABLE spark.notifications ADD CONSTRAINT notifications_kind_allowed CHECK (kind IN ('invitation_accepted','issue_assigned','sprint_started'));
--> statement-breakpoint
-- Internal: the dates of a sprint are both NULL or both set, between 2000-01-01 and 2100-12-31, and 1 to 28
-- days apart. Raises 22023 Invalid sprint dates otherwise. The checks are nested so an infinite date never
-- reaches the subtraction.
CREATE FUNCTION spark.check_sprint_dates(p_starts date, p_ends date) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (p_starts IS NULL) <> (p_ends IS NULL) THEN
    RAISE EXCEPTION 'Invalid sprint dates' USING ERRCODE = '22023';
  END IF;
  IF p_starts IS NULL THEN RETURN; END IF;
  IF p_starts NOT BETWEEN DATE '2000-01-01' AND DATE '2100-12-31' OR p_ends NOT BETWEEN DATE '2000-01-01' AND DATE '2100-12-31' THEN
    RAISE EXCEPTION 'Invalid sprint dates' USING ERRCODE = '22023';
  END IF;
  IF p_ends - p_starts NOT BETWEEN 1 AND 28 THEN
    RAISE EXCEPTION 'Invalid sprint dates' USING ERRCODE = '22023';
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION spark.check_sprint_dates(date,date) FROM PUBLIC, spark_app;
--> statement-breakpoint
CREATE FUNCTION spark.ws_create_sprint(p_project uuid, p_name text, p_goal text, p_starts date, p_ends date)
RETURNS TABLE(outcome text, sprint_id uuid, sprint_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); clean_name text := btrim(p_name);
  clean_goal text := nullif(btrim(p_goal), ''); target_tenant uuid; actor_role text; project spark.projects%ROWTYPE; new_sprint uuid;
BEGIN
  SELECT p.tenant_id INTO target_tenant FROM spark.projects p WHERE p.id = p_project AND p.archived_at IS NULL;
  IF target_tenant IS NOT NULL THEN actor_role := spark.lock_workspace_member(target_tenant, actor); END IF;
  IF actor_role IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::integer; RETURN; END IF;
  SELECT * INTO project FROM spark.projects p WHERE p.id = p_project FOR UPDATE;
  IF project.archived_at IS NOT NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::integer; RETURN; END IF;
  IF actor_role NOT IN ('owner','admin') AND project.lead_user_id IS DISTINCT FROM actor THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF project.methodology <> 'scrum' THEN RAISE EXCEPTION 'Invalid methodology' USING ERRCODE = '22023'; END IF;
  IF clean_name IS NULL OR length(clean_name) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'Invalid sprint name' USING ERRCODE = '22023';
  END IF;
  IF length(clean_goal) > 500 THEN RAISE EXCEPTION 'Invalid sprint goal' USING ERRCODE = '22023'; END IF;
  PERFORM spark.check_sprint_dates(p_starts, p_ends);
  INSERT INTO spark.sprints (tenant_id, project_id, name, goal, starts_at, ends_at)
    VALUES (project.tenant_id, project.id, clean_name, clean_goal, p_starts::timestamp AT TIME ZONE 'UTC', p_ends::timestamp AT TIME ZONE 'UTC')
    RETURNING id INTO new_sprint;
  RETURN QUERY SELECT 'ok'::text, new_sprint, 1;
END $$;
--> statement-breakpoint
-- Patch keys: name, goal (name and goal while planned or active) and startsOn, endsOn ('YYYY-MM-DD' or
-- null; only while planned). A non-object, {} or any other key raises Invalid sprint. A patch that changes
-- no value returns ok with the current version and writes nothing.
CREATE FUNCTION spark.ws_update_sprint(p_sprint uuid, p_expected_version integer, p_patch jsonb)
RETURNS TABLE(outcome text, sprint_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); target_tenant uuid; target_project uuid; actor_role text;
  project spark.projects%ROWTYPE; cur spark.sprints%ROWTYPE; date_pattern constant text := '^\d{4}-\d{2}-\d{2}$';
  new_name text; new_goal text; new_starts date; new_ends date;
BEGIN
  SELECT s.tenant_id, s.project_id INTO target_tenant, target_project FROM spark.sprints s
    JOIN spark.projects p ON p.tenant_id = s.tenant_id AND p.id = s.project_id WHERE s.id = p_sprint AND p.archived_at IS NULL;
  IF target_tenant IS NOT NULL THEN actor_role := spark.lock_workspace_member(target_tenant, actor); END IF;
  IF actor_role IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  SELECT * INTO project FROM spark.projects p WHERE p.tenant_id = target_tenant AND p.id = target_project FOR UPDATE;
  IF project.archived_at IS NOT NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  IF actor_role NOT IN ('owner','admin') AND project.lead_user_id IS DISTINCT FROM actor THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::integer; RETURN;
  END IF;
  IF project.methodology <> 'scrum' THEN RAISE EXCEPTION 'Invalid methodology' USING ERRCODE = '22023'; END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_patch = '{}'::jsonb
    OR (p_patch - ARRAY['name','goal','startsOn','endsOn']) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Invalid sprint' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'name' AND (jsonb_typeof(p_patch->'name') <> 'string' OR length(btrim(p_patch->>'name')) NOT BETWEEN 1 AND 80) THEN
    RAISE EXCEPTION 'Invalid sprint name' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'goal' AND (jsonb_typeof(p_patch->'goal') NOT IN ('string','null') OR length(btrim(p_patch->>'goal')) > 500) THEN
    RAISE EXCEPTION 'Invalid sprint goal' USING ERRCODE = '22023';
  END IF;
  IF (p_patch ? 'startsOn' AND (jsonb_typeof(p_patch->'startsOn') NOT IN ('string','null') OR (jsonb_typeof(p_patch->'startsOn') = 'string'
        AND NOT (p_patch->>'startsOn' ~ date_pattern AND pg_input_is_valid(p_patch->>'startsOn', 'date')))))
    OR (p_patch ? 'endsOn' AND (jsonb_typeof(p_patch->'endsOn') NOT IN ('string','null') OR (jsonb_typeof(p_patch->'endsOn') = 'string'
        AND NOT (p_patch->>'endsOn' ~ date_pattern AND pg_input_is_valid(p_patch->>'endsOn', 'date'))))) THEN
    RAISE EXCEPTION 'Invalid sprint dates' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO cur FROM spark.sprints s WHERE s.tenant_id = project.tenant_id AND s.project_id = project.id AND s.id = p_sprint FOR UPDATE;
  IF p_expected_version IS DISTINCT FROM cur.version THEN
    RETURN QUERY SELECT 'version_mismatch'::text, cur.version; RETURN;
  END IF;
  IF cur.status NOT IN ('planned','active') OR (cur.status <> 'planned' AND (p_patch ? 'startsOn' OR p_patch ? 'endsOn')) THEN
    RETURN QUERY SELECT 'not_editable'::text, NULL::integer; RETURN;
  END IF;
  new_name := CASE WHEN p_patch ? 'name' THEN btrim(p_patch->>'name') ELSE cur.name END;
  new_goal := CASE WHEN p_patch ? 'goal' THEN nullif(btrim(p_patch->>'goal'), '') ELSE cur.goal END;
  new_starts := CASE WHEN p_patch ? 'startsOn' THEN (p_patch->>'startsOn')::date ELSE (cur.starts_at AT TIME ZONE 'UTC')::date END;
  new_ends := CASE WHEN p_patch ? 'endsOn' THEN (p_patch->>'endsOn')::date ELSE (cur.ends_at AT TIME ZONE 'UTC')::date END;
  PERFORM spark.check_sprint_dates(new_starts, new_ends);
  IF new_name IS NOT DISTINCT FROM cur.name AND new_goal IS NOT DISTINCT FROM cur.goal
    AND new_starts IS NOT DISTINCT FROM (cur.starts_at AT TIME ZONE 'UTC')::date AND new_ends IS NOT DISTINCT FROM (cur.ends_at AT TIME ZONE 'UTC')::date THEN
    RETURN QUERY SELECT 'ok'::text, cur.version; RETURN;
  END IF;
  UPDATE spark.sprints s SET name = new_name, goal = new_goal, starts_at = new_starts::timestamp AT TIME ZONE 'UTC',
    ends_at = new_ends::timestamp AT TIME ZONE 'UTC', version = s.version + 1
    WHERE s.id = cur.id;
  RETURN QUERY SELECT 'ok'::text, cur.version + 1;
END $$;
--> statement-breakpoint
-- planned -> active. Every non-archived issue in the sprint is snapshotted into sprint_commitments with its
-- story points, and the totals are stored on the sprint. One processed sprint.started outbox row carries the
-- in-app sprint_started notifications: one per distinct assignee of a committed issue who is not the actor
-- and is still an active member with an active, non-deleted user. The project row lock serializes starts,
-- so of two concurrent starts in one project the second sees the first's active sprint (already_active);
-- the partial unique index on active sprints is the backstop. Outcome order: already_active when this
-- sprint is already active, version_mismatch, not_planned, already_active for another active sprint,
-- missing_dates.
CREATE FUNCTION spark.ws_start_sprint(p_sprint uuid, p_expected_version integer)
RETURNS TABLE(outcome text, sprint_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); target_tenant uuid; target_project uuid; actor_role text;
  project spark.projects%ROWTYPE; cur spark.sprints%ROWTYPE; outbox_id uuid;
BEGIN
  SELECT s.tenant_id, s.project_id INTO target_tenant, target_project FROM spark.sprints s
    JOIN spark.projects p ON p.tenant_id = s.tenant_id AND p.id = s.project_id WHERE s.id = p_sprint AND p.archived_at IS NULL;
  IF target_tenant IS NOT NULL THEN actor_role := spark.lock_workspace_member(target_tenant, actor); END IF;
  IF actor_role IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  SELECT * INTO project FROM spark.projects p WHERE p.tenant_id = target_tenant AND p.id = target_project FOR UPDATE;
  IF project.archived_at IS NOT NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  IF actor_role NOT IN ('owner','admin') AND project.lead_user_id IS DISTINCT FROM actor THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::integer; RETURN;
  END IF;
  IF project.methodology <> 'scrum' THEN RAISE EXCEPTION 'Invalid methodology' USING ERRCODE = '22023'; END IF;
  SELECT * INTO cur FROM spark.sprints s WHERE s.tenant_id = project.tenant_id AND s.project_id = project.id AND s.id = p_sprint FOR UPDATE;
  IF cur.status = 'active' THEN RETURN QUERY SELECT 'already_active'::text, NULL::integer; RETURN; END IF;
  IF p_expected_version IS DISTINCT FROM cur.version THEN
    RETURN QUERY SELECT 'version_mismatch'::text, cur.version; RETURN;
  END IF;
  IF cur.status <> 'planned' THEN RETURN QUERY SELECT 'not_planned'::text, NULL::integer; RETURN; END IF;
  IF EXISTS (SELECT 1 FROM spark.sprints s WHERE s.tenant_id = project.tenant_id AND s.project_id = project.id AND s.status = 'active') THEN
    RETURN QUERY SELECT 'already_active'::text, NULL::integer; RETURN;
  END IF;
  IF cur.starts_at IS NULL OR cur.ends_at IS NULL THEN RETURN QUERY SELECT 'missing_dates'::text, NULL::integer; RETURN; END IF;

  -- Issue writers lock the project row first, so the sprint's issues cannot change while they are read.
  INSERT INTO spark.sprint_commitments (tenant_id, sprint_id, issue_id, story_points)
    SELECT i.tenant_id, cur.id, i.id, i.story_points FROM spark.issues i
    WHERE i.tenant_id = project.tenant_id AND i.project_id = project.id AND i.sprint_id = cur.id AND i.archived_at IS NULL
    ORDER BY i.id;
  UPDATE spark.sprints s SET status = 'active', started_at = now(), version = s.version + 1,
    committed_points = (SELECT coalesce(sum(c.story_points), 0) FROM spark.sprint_commitments c WHERE c.tenant_id = cur.tenant_id AND c.sprint_id = cur.id),
    committed_count = (SELECT count(*) FROM spark.sprint_commitments c WHERE c.tenant_id = cur.tenant_id AND c.sprint_id = cur.id)
    WHERE s.id = cur.id;
  INSERT INTO spark.outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, processed_at)
    VALUES (project.tenant_id, 'sprint.started', 'sprint', cur.id, cur.version + 1,
      jsonb_build_object('sprintId', cur.id, 'projectId', project.id, 'actorUserId', actor), now())
    RETURNING id INTO outbox_id;
  INSERT INTO spark.notifications (tenant_id, recipient_user_id, outbox_event_id, kind, title, resource_type, resource_id)
    SELECT project.tenant_id, recipient.user_id, outbox_id, 'sprint_started', left(project.name || ': ' || cur.name || ' started', 500), 'sprint', cur.id
    FROM (SELECT DISTINCT i.assignee_user_id AS user_id FROM spark.sprint_commitments c
        JOIN spark.issues i ON i.tenant_id = c.tenant_id AND i.id = c.issue_id
        WHERE c.tenant_id = cur.tenant_id AND c.sprint_id = cur.id AND i.assignee_user_id IS NOT NULL AND i.assignee_user_id <> actor) recipient
    WHERE EXISTS (SELECT 1 FROM spark.workspace_memberships m JOIN spark.users u ON u.id = m.user_id
      WHERE m.tenant_id = project.tenant_id AND m.user_id = recipient.user_id AND m.status = 'active' AND u.status = 'active' AND u.deleted_at IS NULL)
    ORDER BY recipient.user_id;
  RETURN QUERY SELECT 'ok'::text, cur.version + 1;
END $$;
--> statement-breakpoint
-- active -> completed. completed_points and completed_count are frozen from the sprint's non-archived
-- issues in a done-category status. Every open issue of the sprint (not done, not archived) moves to
-- p_carry_to (a planned sprint of the same project) or, when p_carry_to is NULL, to the backlog
-- (sprint_id NULL), each as one change set: version + 1, one issue.updated event (fields ["sprintId"]) and
-- one processed outbox row. Done and archived issues keep the completed sprint. Both sprint rows are locked
-- by id, then the moved issues by id.
CREATE FUNCTION spark.ws_complete_sprint(p_sprint uuid, p_expected_version integer, p_carry_to uuid)
RETURNS TABLE(outcome text, sprint_version integer, moved_issues integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); target_tenant uuid; target_project uuid; actor_role text;
  project spark.projects%ROWTYPE; cur spark.sprints%ROWTYPE; target_status text; moved integer := 0; item record;
BEGIN
  SELECT s.tenant_id, s.project_id INTO target_tenant, target_project FROM spark.sprints s
    JOIN spark.projects p ON p.tenant_id = s.tenant_id AND p.id = s.project_id WHERE s.id = p_sprint AND p.archived_at IS NULL;
  IF target_tenant IS NOT NULL THEN actor_role := spark.lock_workspace_member(target_tenant, actor); END IF;
  IF actor_role IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer, NULL::integer; RETURN; END IF;
  SELECT * INTO project FROM spark.projects p WHERE p.tenant_id = target_tenant AND p.id = target_project FOR UPDATE;
  IF project.archived_at IS NOT NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer, NULL::integer; RETURN; END IF;
  IF actor_role NOT IN ('owner','admin') AND project.lead_user_id IS DISTINCT FROM actor THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::integer, NULL::integer; RETURN;
  END IF;
  IF project.methodology <> 'scrum' THEN RAISE EXCEPTION 'Invalid methodology' USING ERRCODE = '22023'; END IF;
  PERFORM 1 FROM spark.boards b WHERE b.tenant_id = project.tenant_id AND b.project_id = project.id FOR UPDATE;
  PERFORM 1 FROM spark.sprints s WHERE s.tenant_id = project.tenant_id AND s.project_id = project.id AND s.id IN (p_sprint, p_carry_to)
    ORDER BY s.id FOR UPDATE;
  SELECT * INTO cur FROM spark.sprints s WHERE s.tenant_id = project.tenant_id AND s.project_id = project.id AND s.id = p_sprint;
  IF p_expected_version IS DISTINCT FROM cur.version THEN
    RETURN QUERY SELECT 'version_mismatch'::text, cur.version, NULL::integer; RETURN;
  END IF;
  IF cur.status <> 'active' THEN RETURN QUERY SELECT 'not_active'::text, NULL::integer, NULL::integer; RETURN; END IF;
  IF p_carry_to IS NOT NULL THEN
    SELECT s.status INTO target_status FROM spark.sprints s WHERE s.tenant_id = project.tenant_id AND s.project_id = project.id AND s.id = p_carry_to;
    IF target_status IS DISTINCT FROM 'planned' THEN
      RETURN QUERY SELECT 'invalid_carry_target'::text, NULL::integer, NULL::integer; RETURN;
    END IF;
  END IF;

  UPDATE spark.sprints s SET status = 'completed', completed_at = now(), version = s.version + 1,
    completed_points = (SELECT coalesce(sum(i.story_points), 0) FROM spark.issues i
      JOIN spark.issue_statuses st ON st.tenant_id = i.tenant_id AND st.id = i.status_id
      WHERE i.tenant_id = cur.tenant_id AND i.project_id = cur.project_id AND i.sprint_id = cur.id AND i.archived_at IS NULL AND st.category = 'done'),
    completed_count = (SELECT count(*) FROM spark.issues i
      JOIN spark.issue_statuses st ON st.tenant_id = i.tenant_id AND st.id = i.status_id
      WHERE i.tenant_id = cur.tenant_id AND i.project_id = cur.project_id AND i.sprint_id = cur.id AND i.archived_at IS NULL AND st.category = 'done')
    WHERE s.id = cur.id;
  PERFORM 1 FROM spark.issues i JOIN spark.issue_statuses st ON st.tenant_id = i.tenant_id AND st.id = i.status_id
    WHERE i.tenant_id = project.tenant_id AND i.project_id = project.id AND i.sprint_id = cur.id AND i.archived_at IS NULL AND st.category <> 'done'
    ORDER BY i.id FOR UPDATE OF i;
  FOR item IN SELECT i.id, i.version, i.status_id, st.category, i.assignee_user_id, i.story_points, i.phase_id FROM spark.issues i
      JOIN spark.issue_statuses st ON st.tenant_id = i.tenant_id AND st.id = i.status_id
      WHERE i.tenant_id = project.tenant_id AND i.project_id = project.id AND i.sprint_id = cur.id AND i.archived_at IS NULL AND st.category <> 'done'
      ORDER BY i.id LOOP
    UPDATE spark.issues i SET sprint_id = p_carry_to, version = i.version + 1 WHERE i.id = item.id;
    INSERT INTO spark.issue_events (tenant_id, project_id, issue_id, actor_user_id, event_type, from_version, to_version, changes)
      VALUES (project.tenant_id, project.id, item.id, actor, 'issue.updated', item.version, item.version + 1, jsonb_build_object(
        'fields', jsonb_build_array('sprintId'),
        'after', jsonb_build_object('statusId', item.status_id, 'category', item.category, 'assigneeUserId', item.assignee_user_id,
          'storyPoints', item.story_points, 'phaseId', item.phase_id, 'sprintId', p_carry_to, 'archived', false)));
    INSERT INTO spark.outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, processed_at)
      VALUES (project.tenant_id, 'issue.updated', 'issue', item.id, item.version + 1,
        jsonb_build_object('issueId', item.id, 'projectId', project.id, 'actorUserId', actor, 'assigneeUserId', item.assignee_user_id), now());
    moved := moved + 1;
  END LOOP;
  RETURN QUERY SELECT 'ok'::text, cur.version + 1, moved;
END $$;
--> statement-breakpoint
-- Unchanged from 0021 except the sprintId patch key: a sprint id (planned or active, same project) or null,
-- accepted only in Scrum projects; anything else raises 22023 Invalid sprint. Sprint writers lock the project
-- row first, so the sprint state read here cannot change underneath. The change appears as sprintId in the
-- event fields and in the after snapshot.
CREATE OR REPLACE FUNCTION spark.ws_update_issue(p_issue uuid, p_expected_version integer, p_patch jsonb)
RETURNS TABLE(outcome text, issue_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); target_tenant uuid; target_project uuid;
  project spark.projects%ROWTYPE; cur spark.issues%ROWTYPE; date_pattern constant text := '^\d{4}-\d{2}-\d{2}$';
  new_title text; new_description text; new_type text; new_priority text; new_status uuid; new_assignee uuid;
  new_points numeric; new_due date; new_phase uuid; new_archived boolean; new_position numeric(20,6);
  status_category text; capacity integer; positioned boolean := p_patch ? 'afterIssueId'; anchor uuid;
  anchor_position numeric(20,6); next_position numeric(20,6); rebalance boolean := false; column_ids uuid[];
  column_positions numeric[]; slot integer; total integer; span_start integer; span_end integer; span_size integer;
  lower_bound numeric; upper_bound numeric; rerank_ids uuid[]; rerank_positions numeric[]; changed text[]; outbox_id uuid; actor_name text; item record; reranked spark.issues%ROWTYPE;
  notification_id uuid; new_sprint uuid;
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_patch = '{}'::jsonb
    OR (p_patch - ARRAY['title','description','type','priority','statusId','afterIssueId','assigneeUserId','storyPoints','dueDate','phaseId','sprintId','archived']) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Invalid issue patch' USING ERRCODE = '22023';
  END IF;

  SELECT i.tenant_id, i.project_id INTO target_tenant, target_project FROM spark.issues i
    JOIN spark.projects p ON p.tenant_id = i.tenant_id AND p.id = i.project_id
    WHERE i.id = p_issue AND p.archived_at IS NULL;
  IF target_tenant IS NULL OR spark.lock_workspace_member(target_tenant, actor) IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN;
  END IF;
  SELECT * INTO project FROM spark.projects p WHERE p.tenant_id = target_tenant AND p.id = target_project FOR UPDATE;
  IF project.archived_at IS NOT NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN;
  END IF;
  PERFORM 1 FROM spark.boards b WHERE b.tenant_id = project.tenant_id AND b.project_id = project.id FOR UPDATE;
  SELECT * INTO cur FROM spark.issues i WHERE i.tenant_id = project.tenant_id AND i.project_id = project.id AND i.id = p_issue FOR UPDATE;
  IF p_expected_version IS DISTINCT FROM cur.version THEN
    RETURN QUERY SELECT 'version_mismatch'::text, cur.version; RETURN;
  END IF;
  -- An archived issue can only be restored.
  IF cur.archived_at IS NOT NULL AND p_patch <> '{"archived": false}'::jsonb THEN
    RAISE EXCEPTION 'Invalid issue patch' USING ERRCODE = '22023';
  END IF;

  -- Per-key validation. Checks are split so a malformed value never reaches a cast that would raise a
  -- different error.
  IF p_patch ? 'archived' AND jsonb_typeof(p_patch->'archived') <> 'boolean' THEN
    RAISE EXCEPTION 'Invalid issue patch' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'title' AND (jsonb_typeof(p_patch->'title') <> 'string' OR length(btrim(p_patch->>'title')) NOT BETWEEN 1 AND 200) THEN
    RAISE EXCEPTION 'Invalid issue title' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'description' AND (jsonb_typeof(p_patch->'description') NOT IN ('string','null') OR length(btrim(p_patch->>'description')) > 10000) THEN
    RAISE EXCEPTION 'Invalid issue description' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'type' AND (jsonb_typeof(p_patch->'type') <> 'string' OR p_patch->>'type' NOT IN ('task','bug','story')) THEN
    RAISE EXCEPTION 'Invalid issue type' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'priority' AND (jsonb_typeof(p_patch->'priority') <> 'string' OR p_patch->>'priority' NOT IN ('lowest','low','medium','high','highest')) THEN
    RAISE EXCEPTION 'Invalid issue priority' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'storyPoints' AND jsonb_typeof(p_patch->'storyPoints') NOT IN ('number','null') THEN
    RAISE EXCEPTION 'Invalid story points' USING ERRCODE = '22023';
  END IF;
  new_points := CASE WHEN p_patch ? 'storyPoints' THEN (p_patch->>'storyPoints')::numeric ELSE cur.story_points END;
  IF p_patch ? 'storyPoints' AND new_points IS NOT NULL AND (new_points NOT BETWEEN 0 AND 100 OR new_points <> round(new_points, 2)) THEN
    RAISE EXCEPTION 'Invalid story points' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'dueDate' AND (jsonb_typeof(p_patch->'dueDate') NOT IN ('string','null') OR (jsonb_typeof(p_patch->'dueDate') = 'string'
      AND NOT (p_patch->>'dueDate' ~ date_pattern AND pg_input_is_valid(p_patch->>'dueDate', 'date')))) THEN
    RAISE EXCEPTION 'Invalid due date' USING ERRCODE = '22023';
  END IF;
  new_due := CASE WHEN p_patch ? 'dueDate' THEN (p_patch->>'dueDate')::date ELSE cur.due_date END;
  IF p_patch ? 'dueDate' AND new_due NOT BETWEEN DATE '2000-01-01' AND DATE '2100-12-31' THEN
    RAISE EXCEPTION 'Invalid due date' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'statusId' AND (jsonb_typeof(p_patch->'statusId') <> 'string' OR NOT pg_input_is_valid(p_patch->>'statusId', 'uuid')) THEN
    RAISE EXCEPTION 'Invalid issue status' USING ERRCODE = '22023';
  END IF;
  new_status := CASE WHEN p_patch ? 'statusId' THEN (p_patch->>'statusId')::uuid ELSE cur.status_id END;
  SELECT s.category, s.wip_limit INTO status_category, capacity FROM spark.issue_statuses s
    WHERE s.tenant_id = project.tenant_id AND s.project_id = project.id AND s.id = new_status;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid issue status' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'phaseId' AND (jsonb_typeof(p_patch->'phaseId') NOT IN ('string','null') OR (jsonb_typeof(p_patch->'phaseId') = 'string'
      AND NOT pg_input_is_valid(p_patch->>'phaseId', 'uuid'))) THEN
    RAISE EXCEPTION 'Invalid issue phase' USING ERRCODE = '22023';
  END IF;
  new_phase := CASE WHEN p_patch ? 'phaseId' THEN (p_patch->>'phaseId')::uuid ELSE cur.phase_id END;
  IF p_patch ? 'phaseId' AND new_phase IS NOT NULL AND NOT EXISTS (SELECT 1 FROM spark.project_phases ph
      WHERE ph.tenant_id = project.tenant_id AND ph.project_id = project.id AND ph.id = new_phase) THEN
    RAISE EXCEPTION 'Invalid issue phase' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'sprintId' AND (project.methodology <> 'scrum' OR jsonb_typeof(p_patch->'sprintId') NOT IN ('string','null')
      OR (jsonb_typeof(p_patch->'sprintId') = 'string' AND NOT pg_input_is_valid(p_patch->>'sprintId', 'uuid'))) THEN
    RAISE EXCEPTION 'Invalid sprint' USING ERRCODE = '22023';
  END IF;
  new_sprint := CASE WHEN p_patch ? 'sprintId' THEN (p_patch->>'sprintId')::uuid ELSE cur.sprint_id END;
  IF p_patch ? 'sprintId' AND new_sprint IS NOT NULL AND NOT EXISTS (SELECT 1 FROM spark.sprints s
      WHERE s.tenant_id = project.tenant_id AND s.project_id = project.id AND s.id = new_sprint AND s.status IN ('planned','active')) THEN
    RAISE EXCEPTION 'Invalid sprint' USING ERRCODE = '22023';
  END IF;
  -- The anchor must be another non-archived issue of this project in the target status.
  IF positioned AND (jsonb_typeof(p_patch->'afterIssueId') NOT IN ('string','null') OR (jsonb_typeof(p_patch->'afterIssueId') = 'string'
      AND NOT pg_input_is_valid(p_patch->>'afterIssueId', 'uuid'))) THEN
    RAISE EXCEPTION 'Invalid issue position' USING ERRCODE = '22023';
  END IF;
  anchor := CASE WHEN positioned THEN (p_patch->>'afterIssueId')::uuid END;
  IF anchor IS NOT NULL THEN
    SELECT i.position INTO anchor_position FROM spark.issues i WHERE i.tenant_id = project.tenant_id AND i.project_id = project.id
      AND i.id = anchor AND i.id <> cur.id AND i.status_id = new_status AND i.archived_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid issue position' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_patch ? 'assigneeUserId' AND (jsonb_typeof(p_patch->'assigneeUserId') NOT IN ('string','null')
      OR (jsonb_typeof(p_patch->'assigneeUserId') = 'string' AND NOT pg_input_is_valid(p_patch->>'assigneeUserId', 'uuid'))) THEN
    RETURN QUERY SELECT 'invalid_assignee'::text, NULL::integer; RETURN;
  END IF;
  new_assignee := CASE WHEN p_patch ? 'assigneeUserId' THEN (p_patch->>'assigneeUserId')::uuid ELSE cur.assignee_user_id END;
  -- Only a new assignee is checked, so an issue still assigned to a former member stays editable.
  IF new_assignee IS DISTINCT FROM cur.assignee_user_id AND new_assignee IS NOT NULL AND NOT EXISTS (SELECT 1
      FROM spark.workspace_memberships m JOIN spark.users u ON u.id = m.user_id
      WHERE m.tenant_id = project.tenant_id AND m.user_id = new_assignee AND m.status = 'active' AND u.status = 'active' AND u.deleted_at IS NULL) THEN
    RETURN QUERY SELECT 'invalid_assignee'::text, NULL::integer; RETURN;
  END IF;

  new_archived := CASE WHEN p_patch ? 'archived' THEN (p_patch->>'archived')::boolean ELSE cur.archived_at IS NOT NULL END;
  -- WIP admission only when the issue enters a column (status change or restore); reordering or editing
  -- inside a column is never blocked. The project row lock serializes concurrent admissions.
  IF NOT new_archived AND (new_status <> cur.status_id OR cur.archived_at IS NOT NULL) AND capacity IS NOT NULL
    AND (SELECT count(*) FROM spark.issues i WHERE i.tenant_id = project.tenant_id AND i.project_id = project.id
      AND i.status_id = new_status AND i.archived_at IS NULL AND i.id <> cur.id) >= capacity THEN
    RETURN QUERY SELECT 'wip_limit_reached'::text, NULL::integer; RETURN;
  END IF;

  new_title := CASE WHEN p_patch ? 'title' THEN btrim(p_patch->>'title') ELSE cur.title END;
  new_description := CASE WHEN p_patch ? 'description' THEN nullif(btrim(p_patch->>'description'), '') ELSE cur.description END;
  new_type := coalesce(p_patch->>'type', cur.type);
  new_priority := coalesce(p_patch->>'priority', cur.priority);
  new_position := cur.position;
  -- Placement (skipped for an issue that ends up archived). Dropping an issue right after its current
  -- predecessor in its own column keeps its position.
  IF NOT new_archived AND (positioned OR new_status <> cur.status_id OR cur.archived_at IS NOT NULL) THEN
    IF positioned AND new_status = cur.status_id AND cur.archived_at IS NULL AND anchor IS NOT DISTINCT FROM (SELECT i.id FROM spark.issues i
        WHERE i.tenant_id = project.tenant_id AND i.project_id = project.id AND i.status_id = new_status AND i.archived_at IS NULL
          AND i.id <> cur.id AND (i.position, i.id) < (cur.position, cur.id) ORDER BY i.position DESC, i.id DESC LIMIT 1) THEN
      new_position := cur.position;
    ELSIF anchor IS NOT NULL THEN
      SELECT i.position INTO next_position FROM spark.issues i
        WHERE i.tenant_id = project.tenant_id AND i.project_id = project.id AND i.status_id = new_status AND i.archived_at IS NULL
          AND i.id <> cur.id AND (i.position, i.id) > (anchor_position, anchor) ORDER BY i.position, i.id LIMIT 1;
      IF next_position IS NULL THEN
        new_position := anchor_position + 1024;
      ELSE
        new_position := round((anchor_position + next_position) / 2, 6);
        rebalance := new_position - anchor_position < 0.001 OR next_position - new_position < 0.001;
      END IF;
    ELSIF positioned THEN
      SELECT coalesce(min(i.position) - 1024, 1024) INTO new_position FROM spark.issues i
        WHERE i.tenant_id = project.tenant_id AND i.project_id = project.id AND i.status_id = new_status AND i.archived_at IS NULL AND i.id <> cur.id;
    ELSE
      SELECT coalesce(max(i.position) + 1024, 1024) INTO new_position FROM spark.issues i
        WHERE i.tenant_id = project.tenant_id AND i.project_id = project.id AND i.status_id = new_status AND i.archived_at IS NULL AND i.id <> cur.id;
    END IF;
  END IF;
  IF rebalance THEN
    -- The target column in its new order, with the issue placed after the anchor (index slot + 1).
    SELECT array_agg(i.id ORDER BY i.position, i.id), array_agg(i.position ORDER BY i.position, i.id) INTO column_ids, column_positions
      FROM spark.issues i WHERE i.tenant_id = project.tenant_id AND i.project_id = project.id
        AND i.status_id = new_status AND i.archived_at IS NULL AND i.id <> cur.id;
    slot := array_position(column_ids, anchor);
    column_ids := column_ids[1:slot] || cur.id || column_ids[slot + 1:];
    column_positions := column_positions[1:slot] || NULL::numeric || column_positions[slot + 1:];
    total := cardinality(column_ids);
    -- A window of at most 50 issues around the mover, bounded by the nearest untouched issues.
    span_start := greatest(1, slot + 1 - 24);
    span_end := least(total, span_start + 49);
    span_start := greatest(1, span_end - 49);
    lower_bound := CASE WHEN span_start > 1 THEN column_positions[span_start - 1] END;
    upper_bound := CASE WHEN span_end < total THEN column_positions[span_end + 1] END;
    span_size := span_end - span_start + 1;
    IF lower_bound IS NOT NULL AND upper_bound IS NOT NULL AND (upper_bound - lower_bound) / (span_size + 1) < 0.001 THEN
      span_start := 1; span_end := total; span_size := total; lower_bound := NULL; upper_bound := NULL;
    END IF;
    rerank_ids := column_ids[span_start:span_end];
    rerank_positions := ARRAY(SELECT CASE
        WHEN lower_bound IS NOT NULL AND upper_bound IS NOT NULL THEN round(lower_bound + (upper_bound - lower_bound) * g.n / (span_size + 1), 6)
        WHEN upper_bound IS NOT NULL THEN upper_bound - 1024 * (span_size - g.n + 1)
        WHEN lower_bound IS NOT NULL THEN lower_bound + 1024 * g.n
        ELSE 1024 * g.n END
      FROM generate_series(1, span_size) g(n) ORDER BY g.n);
    PERFORM 1 FROM spark.issues i WHERE i.tenant_id = project.tenant_id AND i.project_id = project.id AND i.id = ANY (rerank_ids)
      ORDER BY i.id FOR UPDATE;
    new_position := rerank_positions[array_position(rerank_ids, cur.id)];
  END IF;

  -- History lists changed fields only; position appears when the caller placed the issue. A rebalance
  -- always means the order changes (an issue already in place never rebalances), so it is always applied.
  changed := ARRAY(SELECT f FROM unnest(ARRAY[
    CASE WHEN new_title IS DISTINCT FROM cur.title THEN 'title' END,
    CASE WHEN new_description IS DISTINCT FROM cur.description THEN 'description' END,
    CASE WHEN new_type IS DISTINCT FROM cur.type THEN 'type' END,
    CASE WHEN new_priority IS DISTINCT FROM cur.priority THEN 'priority' END,
    CASE WHEN new_status IS DISTINCT FROM cur.status_id THEN 'statusId' END,
    CASE WHEN positioned AND (rebalance OR new_position IS DISTINCT FROM cur.position) THEN 'position' END,
    CASE WHEN new_assignee IS DISTINCT FROM cur.assignee_user_id THEN 'assigneeUserId' END,
    CASE WHEN new_points IS DISTINCT FROM cur.story_points THEN 'storyPoints' END,
    CASE WHEN new_due IS DISTINCT FROM cur.due_date THEN 'dueDate' END,
    CASE WHEN new_phase IS DISTINCT FROM cur.phase_id THEN 'phaseId' END,
    CASE WHEN new_sprint IS DISTINCT FROM cur.sprint_id THEN 'sprintId' END,
    CASE WHEN new_archived IS DISTINCT FROM (cur.archived_at IS NOT NULL) THEN 'archived' END]) f WHERE f IS NOT NULL ORDER BY f);
  IF cardinality(changed) = 0 THEN
    RETURN QUERY SELECT 'ok'::text, cur.version; RETURN;
  END IF;

  UPDATE spark.issues i SET title = new_title, description = new_description, type = new_type, priority = new_priority,
    status_id = new_status, assignee_user_id = new_assignee, story_points = new_points, due_date = new_due, phase_id = new_phase, sprint_id = new_sprint,
    position = new_position, archived_at = CASE WHEN new_archived THEN coalesce(i.archived_at, now()) END, version = i.version + 1
    WHERE i.id = cur.id;
  INSERT INTO spark.issue_events (tenant_id, project_id, issue_id, actor_user_id, event_type, from_version, to_version, changes)
    VALUES (project.tenant_id, project.id, cur.id, actor, 'issue.updated', cur.version, cur.version + 1, jsonb_build_object(
      'fields', to_jsonb(changed),
      'after', jsonb_build_object('statusId', new_status, 'category', status_category, 'assigneeUserId', new_assignee,
        'storyPoints', new_points, 'phaseId', new_phase, 'sprintId', new_sprint, 'archived', new_archived)));
  notification_id := CASE WHEN new_assignee IS DISTINCT FROM cur.assignee_user_id AND new_assignee IS NOT NULL AND new_assignee <> actor
    THEN gen_random_uuid() END;
  INSERT INTO spark.outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, processed_at)
    VALUES (project.tenant_id, 'issue.updated', 'issue', cur.id, cur.version + 1,
      jsonb_build_object('issueId', cur.id, 'projectId', project.id, 'actorUserId', actor, 'assigneeUserId', new_assignee)
        || CASE WHEN notification_id IS NOT NULL THEN jsonb_build_object('version', cur.version + 1, 'notificationId', notification_id) ELSE '{}'::jsonb END,
      CASE WHEN notification_id IS NULL THEN now() END)
    RETURNING id INTO outbox_id;

  IF rebalance THEN
    FOR item IN SELECT u.id, u.target FROM unnest(rerank_ids, rerank_positions) u(id, target) WHERE u.id <> cur.id LOOP
      UPDATE spark.issues i SET position = item.target, version = i.version + 1
        WHERE i.id = item.id AND i.position <> item.target RETURNING i.* INTO reranked;
      IF FOUND THEN
        INSERT INTO spark.issue_events (tenant_id, project_id, issue_id, actor_user_id, event_type, from_version, to_version, changes)
          VALUES (project.tenant_id, project.id, reranked.id, actor, 'issue.reranked', reranked.version - 1, reranked.version, jsonb_build_object(
            'fields', jsonb_build_array('position'),
            'after', jsonb_build_object('statusId', reranked.status_id, 'category', status_category, 'assigneeUserId', reranked.assignee_user_id,
              'storyPoints', reranked.story_points, 'phaseId', reranked.phase_id, 'sprintId', reranked.sprint_id, 'archived', false)));
        INSERT INTO spark.outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, processed_at)
          VALUES (project.tenant_id, 'issue.reranked', 'issue', reranked.id, reranked.version,
            jsonb_build_object('issueId', reranked.id, 'projectId', project.id, 'actorUserId', actor), now());
      END IF;
    END LOOP;
  END IF;

  IF notification_id IS NOT NULL THEN
    SELECT btrim(u.display_name) INTO actor_name FROM spark.users u WHERE u.id = actor;
    INSERT INTO spark.notifications (id, tenant_id, recipient_user_id, outbox_event_id, kind, title, resource_type, resource_id)
      VALUES (notification_id, project.tenant_id, new_assignee, outbox_id, 'issue_assigned',
        left(actor_name || ' assigned you ' || project.key || '-' || cur.number || ': ' || new_title, 500), 'issue', cur.id);
  END IF;
  RETURN QUERY SELECT 'ok'::text, cur.version + 1;
END $$;

--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.ws_create_sprint(uuid,text,text,date,date), spark.ws_update_sprint(uuid,integer,jsonb),
  spark.ws_start_sprint(uuid,integer), spark.ws_complete_sprint(uuid,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION spark.ws_create_sprint(uuid,text,text,date,date), spark.ws_update_sprint(uuid,integer,jsonb),
  spark.ws_start_sprint(uuid,integer), spark.ws_complete_sprint(uuid,integer,uuid) TO spark_app;
