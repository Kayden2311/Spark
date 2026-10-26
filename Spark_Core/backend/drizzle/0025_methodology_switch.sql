-- Column editing and methodology switching (M4). The runtime role still has no INSERT, UPDATE or DELETE
-- grant on issue_statuses, projects or project_methodology_periods: columns are edited and a project
-- changes methodology only through the two spark.ws_* definer functions below, which derive the actor from
-- the live session and return a closed set of outcomes. Owners, admins and the project's current lead may
-- call them. Decision order: status or project and membership (not_found, before any input error),
-- authority (forbidden), then as documented on each function. Lock order: workspace row FOR SHARE
-- (lock_workspace_member), project FOR UPDATE, board, statuses by id, sprints by id, phases by position
-- (apply_phase_plan), issues by id. Issue writers take the project row first too, so the project lock
-- serializes these writes with every issue edit.

-- Renames a column and/or changes its WIP limit. p_name NULL keeps the name; p_wip_limit NULL keeps the
-- limit unless p_clear_wip, which removes it. Outcomes: ok, not_found, forbidden, version_mismatch (returns
-- the current settings version), name_taken (another status of the project has the name, ignoring case),
-- wip_below_occupancy (more non-archived cards are in the column than the new limit; the guard_status
-- trigger's own definition, checked first so nothing is written). 22023: Invalid status name (trimmed, 1 to
-- 40), Invalid WIP limit (1 to 99, or a limit together with p_clear_wip). Every change advances
-- projects.settings_version by one; a call that changes nothing returns ok with the current version.
CREATE FUNCTION spark.ws_update_status(p_status uuid, p_expected_project_version integer, p_name text, p_wip_limit integer, p_clear_wip boolean)
RETURNS TABLE(outcome text, settings_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); clean_name text := btrim(p_name); clear_wip boolean := coalesce(p_clear_wip, false);
  target_tenant uuid; target_project uuid; actor_role text; project spark.projects%ROWTYPE; cur spark.issue_statuses%ROWTYPE;
  new_name text; new_wip integer;
BEGIN
  SELECT s.tenant_id, s.project_id INTO target_tenant, target_project FROM spark.issue_statuses s
    JOIN spark.projects p ON p.tenant_id = s.tenant_id AND p.id = s.project_id WHERE s.id = p_status AND p.archived_at IS NULL;
  IF target_tenant IS NOT NULL THEN actor_role := spark.lock_workspace_member(target_tenant, actor); END IF;
  IF actor_role IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  SELECT * INTO project FROM spark.projects p WHERE p.tenant_id = target_tenant AND p.id = target_project FOR UPDATE;
  IF project.archived_at IS NOT NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  IF actor_role NOT IN ('owner','admin') AND project.lead_user_id IS DISTINCT FROM actor THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::integer; RETURN;
  END IF;
  IF p_name IS NOT NULL AND length(clean_name) NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'Invalid status name' USING ERRCODE = '22023';
  END IF;
  IF p_wip_limit IS NOT NULL AND (clear_wip OR p_wip_limit NOT BETWEEN 1 AND 99) THEN
    RAISE EXCEPTION 'Invalid WIP limit' USING ERRCODE = '22023';
  END IF;
  IF p_expected_project_version IS DISTINCT FROM project.settings_version THEN
    RETURN QUERY SELECT 'version_mismatch'::text, project.settings_version; RETURN;
  END IF;
  PERFORM 1 FROM spark.boards b WHERE b.tenant_id = project.tenant_id AND b.project_id = project.id FOR UPDATE;
  SELECT * INTO cur FROM spark.issue_statuses s WHERE s.tenant_id = project.tenant_id AND s.project_id = project.id AND s.id = p_status FOR UPDATE;
  -- Removed by a switch that committed while this call waited (the version check normally catches that first).
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  new_name := coalesce(clean_name, cur.name);
  new_wip := CASE WHEN clear_wip THEN NULL ELSE coalesce(p_wip_limit, cur.wip_limit) END;
  IF new_name <> cur.name AND EXISTS (SELECT 1 FROM spark.issue_statuses s WHERE s.tenant_id = project.tenant_id AND s.project_id = project.id
      AND s.id <> cur.id AND lower(s.name) = lower(new_name)) THEN
    RETURN QUERY SELECT 'name_taken'::text, NULL::integer; RETURN;
  END IF;
  IF new_wip IS DISTINCT FROM cur.wip_limit AND new_wip < (SELECT count(*) FROM spark.issues i
      WHERE i.tenant_id = cur.tenant_id AND i.project_id = cur.project_id AND i.status_id = cur.id AND i.archived_at IS NULL) THEN
    RETURN QUERY SELECT 'wip_below_occupancy'::text, NULL::integer; RETURN;
  END IF;
  IF new_name = cur.name AND new_wip IS NOT DISTINCT FROM cur.wip_limit THEN
    RETURN QUERY SELECT 'ok'::text, project.settings_version; RETURN;
  END IF;
  UPDATE spark.issue_statuses s SET name = new_name, wip_limit = new_wip WHERE s.id = cur.id;
  UPDATE spark.projects p SET settings_version = p.settings_version + 1 WHERE p.id = project.id;
  RETURN QUERY SELECT 'ok'::text, project.settings_version + 1;
END $$;
--> statement-breakpoint
-- Switches a project to another methodology in one transaction, keeping its history.
--   p_columns: the target board, 2 to 12 objects {id?, name, category, wipLimit} in order (M2 status rules:
--     name trimmed 1 to 40 and unique ignoring case, a backlog/todo/in_progress/done category, wipLimit
--     null or an integer 1 to 99, at least one done and one other column; 22023 Invalid project statuses).
--     An entry with id keeps that status of the project (renamed, recategorised, new limit); 22023 Invalid
--     status mapping for a malformed, repeated or foreign id, or for a category change of a status any issue
--     (archived included) references: add a new column and map to it instead. Entries without id are new.
--     Positions become 1024 * n in list order.
--   p_mapping: {"<status id>": index} with exactly one 0-based index into p_columns for every current status
--     not kept (22023 Invalid status mapping otherwise). Every issue on such a status, archived ones too, is
--     locked by id and moved to its target column as one change set (version + 1, one issue.updated event
--     with fields ["statusId"], one processed outbox row); non-archived cards go to the end of the target
--     column in their old board order. The removed statuses, and any workflow transitions naming them, are
--     then deleted.
--   Entering Scrum: sprint_length_days = p_sprint_length (default 14, 7 to 28); every open issue is then in
--   the backlog, because leaving Scrum emptied the planned sprints.
--   Leaving Scrum needs no active sprint (active_sprint). Completed and cancelled sprints, and their issues,
--   stay as history. Every planned sprint is cancelled (version + 1), and each of its open issues (not
--   archived, on a status that is not in the done category before the switch) returns to the backlog
--   (sprint_id NULL) as one change set with sprintId in the event fields; an issue that is also remapped gets
--   a single change set with both fields. p_sprint_length must be NULL for another target (22023 Invalid
--   sprint length).
--   Entering Waterfall: p_start, p_target and p_phases replace the dates and the phase plan through
--   apply_phase_plan(..., true) (22023 Invalid project dates, Invalid project phases, Invalid phase); kept
--   phases keep their baselines, new ones get baseline = plan, baselined_at is set when still NULL. For
--   another target the three must be NULL (Invalid project dates / Invalid project phases); the project
--   keeps its dates, and the phases and milestones of a project leaving Waterfall stay as they are.
--   p_reason: trimmed 1 to 200 (22023 Invalid switch reason).
-- Outcomes: ok (new settings version, count of issues moved to another column, to the backlog or both),
-- not_found, forbidden, version_mismatch (current settings version), same_methodology, active_sprint, wip_below_occupancy (a column's limit is below the
-- non-archived cards it would hold after the remap; checked before any write). Order after authority:
-- Invalid methodology (p_to), version, same_methodology, active_sprint, input (22023), WIP. On ok the open
-- methodology period is closed and a new one opened at the same instant with the reason, projects.methodology
-- and settings_version + 1 are written, and one audit row project.methodology_switched {from, to} is recorded.
CREATE FUNCTION spark.ws_switch_methodology(p_project uuid, p_expected_version integer, p_to text, p_columns jsonb, p_mapping jsonb,
  p_sprint_length integer, p_start date, p_target date, p_phases jsonb, p_reason text)
RETURNS TABLE(outcome text, settings_version integer, moved_issues integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); clean_reason text := btrim(p_reason); target_tenant uuid; actor_role text;
  project spark.projects%ROWTYPE; switched_at timestamptz; sprint_length integer; column_count integer; item jsonb; item_id uuid;
  column_ids uuid[] := ARRAY[]::uuid[]; column_names text[] := ARRAY[]::text[]; column_categories text[] := ARRAY[]::text[];
  column_limits integer[] := ARRAY[]::integer[]; kept uuid[] := ARRAY[]::uuid[]; removed uuid[]; removed_targets integer[];
  mapping_key text; mapping_value jsonb; slot integer; moving record; new_position numeric(20,6); moved integer := 0;
  cancelled uuid[] := ARRAY[]::uuid[];
BEGIN
  SELECT p.tenant_id INTO target_tenant FROM spark.projects p WHERE p.id = p_project AND p.archived_at IS NULL;
  IF target_tenant IS NOT NULL THEN actor_role := spark.lock_workspace_member(target_tenant, actor); END IF;
  IF actor_role IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer, NULL::integer; RETURN; END IF;
  SELECT * INTO project FROM spark.projects p WHERE p.id = p_project FOR UPDATE;
  IF project.archived_at IS NOT NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer, NULL::integer; RETURN; END IF;
  IF actor_role NOT IN ('owner','admin') AND project.lead_user_id IS DISTINCT FROM actor THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::integer, NULL::integer; RETURN;
  END IF;
  -- Taken after the project lock, so it is later than the start of the period a previous switch opened.
  switched_at := clock_timestamp();
  IF p_to IS NULL OR p_to NOT IN ('scrum','kanban','waterfall') THEN RAISE EXCEPTION 'Invalid methodology' USING ERRCODE = '22023'; END IF;
  IF p_expected_version IS DISTINCT FROM project.settings_version THEN
    RETURN QUERY SELECT 'version_mismatch'::text, project.settings_version, NULL::integer; RETURN;
  END IF;
  IF p_to = project.methodology THEN RETURN QUERY SELECT 'same_methodology'::text, NULL::integer, NULL::integer; RETURN; END IF;
  PERFORM 1 FROM spark.boards b WHERE b.tenant_id = project.tenant_id AND b.project_id = project.id FOR UPDATE;
  PERFORM 1 FROM spark.issue_statuses s WHERE s.tenant_id = project.tenant_id AND s.project_id = project.id ORDER BY s.id FOR UPDATE;
  PERFORM 1 FROM spark.sprints s WHERE s.tenant_id = project.tenant_id AND s.project_id = project.id ORDER BY s.id FOR UPDATE;
  IF project.methodology = 'scrum' AND EXISTS (SELECT 1 FROM spark.sprints s
      WHERE s.tenant_id = project.tenant_id AND s.project_id = project.id AND s.status = 'active') THEN
    RETURN QUERY SELECT 'active_sprint'::text, NULL::integer, NULL::integer; RETURN;
  END IF;

  IF clean_reason IS NULL OR length(clean_reason) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid switch reason' USING ERRCODE = '22023';
  END IF;
  IF p_to = 'scrum' THEN
    sprint_length := coalesce(p_sprint_length, 14);
    IF sprint_length NOT BETWEEN 7 AND 28 THEN RAISE EXCEPTION 'Invalid sprint length' USING ERRCODE = '22023'; END IF;
  ELSIF p_sprint_length IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid sprint length' USING ERRCODE = '22023';
  END IF;
  IF p_to <> 'waterfall' AND (p_start IS NOT NULL OR p_target IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid project dates' USING ERRCODE = '22023';
  END IF;
  IF p_to <> 'waterfall' AND p_phases IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid project phases' USING ERRCODE = '22023';
  END IF;

  -- Columns. Checks are nested so a malformed element never reaches a cast that would raise a different error.
  IF p_columns IS NULL OR jsonb_typeof(p_columns) <> 'array' THEN
    RAISE EXCEPTION 'Invalid project statuses' USING ERRCODE = '22023';
  END IF;
  column_count := jsonb_array_length(p_columns);
  IF column_count NOT BETWEEN 2 AND 12 THEN RAISE EXCEPTION 'Invalid project statuses' USING ERRCODE = '22023'; END IF;
  FOR item IN SELECT e.value FROM jsonb_array_elements(p_columns) WITH ORDINALITY e ORDER BY e.ordinality LOOP
    IF jsonb_typeof(item) <> 'object' THEN RAISE EXCEPTION 'Invalid project statuses' USING ERRCODE = '22023'; END IF;
    IF (item - ARRAY['id','name','category','wipLimit']) <> '{}'::jsonb
      OR jsonb_typeof(item->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'category') IS DISTINCT FROM 'string'
      OR coalesce(jsonb_typeof(item->'wipLimit'), 'null') NOT IN ('null','number') THEN
      RAISE EXCEPTION 'Invalid project statuses' USING ERRCODE = '22023';
    END IF;
    IF length(btrim(item->>'name')) NOT BETWEEN 1 AND 40 OR item->>'category' NOT IN ('backlog','todo','in_progress','done') THEN
      RAISE EXCEPTION 'Invalid project statuses' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(item->'wipLimit') = 'number' THEN
      IF (item->>'wipLimit')::numeric NOT BETWEEN 1 AND 99 OR (item->>'wipLimit')::numeric <> trunc((item->>'wipLimit')::numeric) THEN
        RAISE EXCEPTION 'Invalid project statuses' USING ERRCODE = '22023';
      END IF;
    END IF;
    item_id := NULL;
    IF item ? 'id' THEN
      IF jsonb_typeof(item->'id') <> 'string' OR NOT pg_input_is_valid(item->>'id', 'uuid') THEN
        RAISE EXCEPTION 'Invalid status mapping' USING ERRCODE = '22023';
      END IF;
      item_id := (item->>'id')::uuid;
      IF item_id = ANY (kept) OR NOT EXISTS (SELECT 1 FROM spark.issue_statuses s
          WHERE s.tenant_id = project.tenant_id AND s.project_id = project.id AND s.id = item_id) THEN
        RAISE EXCEPTION 'Invalid status mapping' USING ERRCODE = '22023';
      END IF;
      kept := array_append(kept, item_id);
    END IF;
    column_ids := array_append(column_ids, item_id);
    column_names := array_append(column_names, btrim(item->>'name'));
    column_categories := array_append(column_categories, item->>'category');
    column_limits := array_append(column_limits, (item->>'wipLimit')::numeric::integer);
  END LOOP;
  IF (SELECT count(DISTINCT lower(n)) FROM unnest(column_names) n) <> column_count OR NOT ('done' = ANY (column_categories))
    OR NOT EXISTS (SELECT 1 FROM unnest(column_categories) c WHERE c <> 'done') THEN
    RAISE EXCEPTION 'Invalid project statuses' USING ERRCODE = '22023';
  END IF;
  -- guard_status refuses the category change of a referenced status; refuse it here with the mapping error.
  IF EXISTS (SELECT 1 FROM unnest(column_ids, column_categories) c(id, category)
      JOIN spark.issue_statuses s ON s.tenant_id = project.tenant_id AND s.project_id = project.id AND s.id = c.id
      WHERE s.category <> c.category AND EXISTS (SELECT 1 FROM spark.issues i WHERE i.tenant_id = s.tenant_id AND i.status_id = s.id)) THEN
    RAISE EXCEPTION 'Invalid status mapping' USING ERRCODE = '22023';
  END IF;

  -- Mapping: removed_targets[k] is the 1-based column of removed[k].
  removed := ARRAY(SELECT s.id FROM spark.issue_statuses s WHERE s.tenant_id = project.tenant_id AND s.project_id = project.id
    AND s.id <> ALL (kept) ORDER BY s.id);
  removed_targets := array_fill(NULL::integer, ARRAY[cardinality(removed)]);
  IF p_mapping IS NULL OR jsonb_typeof(p_mapping) <> 'object' THEN
    RAISE EXCEPTION 'Invalid status mapping' USING ERRCODE = '22023';
  END IF;
  FOR mapping_key, mapping_value IN SELECT m.key, m.value FROM jsonb_each(p_mapping) m LOOP
    IF NOT pg_input_is_valid(mapping_key, 'uuid') OR jsonb_typeof(mapping_value) <> 'number' THEN
      RAISE EXCEPTION 'Invalid status mapping' USING ERRCODE = '22023';
    END IF;
    slot := array_position(removed, mapping_key::uuid);
    IF slot IS NULL OR removed_targets[slot] IS NOT NULL OR mapping_value::numeric <> trunc(mapping_value::numeric)
      OR mapping_value::numeric < 0 OR mapping_value::numeric >= column_count THEN
      RAISE EXCEPTION 'Invalid status mapping' USING ERRCODE = '22023';
    END IF;
    removed_targets[slot] := mapping_value::numeric::integer + 1;
  END LOOP;
  IF EXISTS (SELECT 1 FROM unnest(removed_targets) t WHERE t IS NULL) THEN
    RAISE EXCEPTION 'Invalid status mapping' USING ERRCODE = '22023';
  END IF;
  -- WIP after the remap: the non-archived cards a column keeps plus those that would arrive (guard_status's
  -- occupancy). Kept columns only gain cards, so every intermediate state of the writes below stays in limits.
  IF EXISTS (SELECT 1 FROM generate_series(1, column_count) g(n) WHERE column_limits[g.n] IS NOT NULL AND column_limits[g.n] < (
      SELECT count(*) FROM spark.issues i WHERE i.tenant_id = project.tenant_id AND i.project_id = project.id AND i.archived_at IS NULL
        AND (i.status_id = column_ids[g.n] OR i.status_id IN (SELECT r.id FROM unnest(removed, removed_targets) r(id, target) WHERE r.target = g.n)))) THEN
    RETURN QUERY SELECT 'wip_below_occupancy'::text, NULL::integer, NULL::integer; RETURN;
  END IF;

  IF p_to = 'waterfall' THEN
    PERFORM spark.apply_phase_plan(project.tenant_id, project.id, p_start, p_target, p_phases, true);
  END IF;
  -- Leaving Scrum: planned sprints are cancelled (already locked above); their open issues move below.
  IF project.methodology = 'scrum' THEN
    cancelled := ARRAY(SELECT s.id FROM spark.sprints s WHERE s.tenant_id = project.tenant_id AND s.project_id = project.id
      AND s.status = 'planned' ORDER BY s.id);
    UPDATE spark.sprints s SET status = 'cancelled', version = s.version + 1
      WHERE s.tenant_id = project.tenant_id AND s.project_id = project.id AND s.id = ANY (cancelled);
  END IF;
  -- Statuses that are removed or renamed first take a placeholder name longer than any column name, so a
  -- column may take a name another one gives up in this switch without tripping the unique name constraint.
  UPDATE spark.issue_statuses s SET name = 'switch:' || s.id::text
    WHERE s.tenant_id = project.tenant_id AND s.project_id = project.id
      AND (s.id = ANY (removed) OR s.name <> (SELECT c.name FROM unnest(column_ids, column_names) c(id, name) WHERE c.id = s.id));
  UPDATE spark.issue_statuses s SET name = c.name, category = c.category, wip_limit = c.wip_limit, position = 1024 * c.n
    FROM unnest(column_ids, column_names, column_categories, column_limits) WITH ORDINALITY c(id, name, category, wip_limit, n)
    WHERE s.tenant_id = project.tenant_id AND s.project_id = project.id AND s.id = c.id
      AND (s.name, s.category, s.wip_limit, s.position) IS DISTINCT FROM (c.name, c.category, c.wip_limit, 1024 * c.n);
  FOR n IN 1..column_count LOOP
    IF column_ids[n] IS NULL THEN
      INSERT INTO spark.issue_statuses (tenant_id, project_id, name, category, position, wip_limit)
        VALUES (project.tenant_id, project.id, column_names[n], column_categories[n], 1024 * n, column_limits[n])
        RETURNING id INTO item_id;
      column_ids[n] := item_id;
    END IF;
  END LOOP;

  -- Issues on a removed status, and open issues of a cancelled sprint. Kept statuses that any issue references
  -- keep their category, and removed ones still exist here, so s.category is the category before the switch.
  PERFORM 1 FROM spark.issues i JOIN spark.issue_statuses s ON s.tenant_id = i.tenant_id AND s.id = i.status_id
    WHERE i.tenant_id = project.tenant_id AND i.project_id = project.id
      AND (i.status_id = ANY (removed) OR (i.sprint_id = ANY (cancelled) AND i.archived_at IS NULL AND s.category <> 'done'))
    ORDER BY i.id FOR UPDATE OF i;
  FOR moving IN SELECT i.id, i.version, i.archived_at IS NOT NULL AS archived, i.assignee_user_id, i.story_points, i.phase_id,
        r.target IS NOT NULL AS remapped, coalesce(i.sprint_id = ANY (cancelled) AND i.archived_at IS NULL AND s.category <> 'done', false) AS unplanned,
        i.sprint_id, coalesce(column_ids[r.target], i.status_id) AS target_status, coalesce(column_categories[r.target], s.category) AS target_category
      FROM spark.issues i LEFT JOIN unnest(removed, removed_targets) r(id, target) ON r.id = i.status_id
      JOIN spark.issue_statuses s ON s.tenant_id = i.tenant_id AND s.id = i.status_id
      WHERE i.tenant_id = project.tenant_id AND i.project_id = project.id
        AND (r.id IS NOT NULL OR (i.sprint_id = ANY (cancelled) AND i.archived_at IS NULL AND s.category <> 'done'))
      ORDER BY r.target NULLS LAST, s.position, i.position, i.id LOOP
    new_position := NULL;
    IF moving.remapped AND NOT moving.archived THEN
      SELECT coalesce(max(i.position) + 1024, 1024) INTO new_position FROM spark.issues i
        WHERE i.tenant_id = project.tenant_id AND i.project_id = project.id AND i.status_id = moving.target_status AND i.archived_at IS NULL;
    END IF;
    UPDATE spark.issues i SET status_id = moving.target_status, position = coalesce(new_position, i.position),
        sprint_id = CASE WHEN moving.unplanned THEN NULL ELSE i.sprint_id END, version = i.version + 1
      WHERE i.id = moving.id;
    INSERT INTO spark.issue_events (tenant_id, project_id, issue_id, actor_user_id, event_type, from_version, to_version, changes)
      VALUES (project.tenant_id, project.id, moving.id, actor, 'issue.updated', moving.version, moving.version + 1, jsonb_build_object(
        'fields', CASE WHEN moving.remapped AND moving.unplanned THEN jsonb_build_array('statusId', 'sprintId')
          WHEN moving.remapped THEN jsonb_build_array('statusId') ELSE jsonb_build_array('sprintId') END,
        'after', jsonb_build_object('statusId', moving.target_status, 'category', moving.target_category, 'assigneeUserId', moving.assignee_user_id,
          'storyPoints', moving.story_points, 'phaseId', moving.phase_id, 'sprintId', CASE WHEN moving.unplanned THEN NULL ELSE moving.sprint_id END,
          'archived', moving.archived)));
    INSERT INTO spark.outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, processed_at)
      VALUES (project.tenant_id, 'issue.updated', 'issue', moving.id, moving.version + 1,
        jsonb_build_object('issueId', moving.id, 'projectId', project.id, 'actorUserId', actor, 'assigneeUserId', moving.assignee_user_id), now());
    moved := moved + 1;
  END LOOP;
  DELETE FROM spark.workflow_transitions t WHERE t.tenant_id = project.tenant_id AND t.project_id = project.id
    AND (t.from_status_id = ANY (removed) OR t.to_status_id = ANY (removed));
  DELETE FROM spark.issue_statuses s WHERE s.tenant_id = project.tenant_id AND s.project_id = project.id AND s.id = ANY (removed);

  UPDATE spark.projects p SET methodology = p_to, sprint_length_days = sprint_length,
    start_date = CASE WHEN p_to = 'waterfall' THEN p_start ELSE p.start_date END,
    target_date = CASE WHEN p_to = 'waterfall' THEN p_target ELSE p.target_date END,
    baselined_at = CASE WHEN p_to = 'waterfall' THEN coalesce(p.baselined_at, switched_at) ELSE p.baselined_at END,
    settings_version = p.settings_version + 1
    WHERE p.id = project.id;
  UPDATE spark.project_methodology_periods m SET ended_at = switched_at
    WHERE m.tenant_id = project.tenant_id AND m.project_id = project.id AND m.ended_at IS NULL;
  INSERT INTO spark.project_methodology_periods (tenant_id, project_id, methodology, started_at, changed_by_user_id, reason)
    VALUES (project.tenant_id, project.id, p_to, switched_at, actor, clean_reason);
  PERFORM spark.record_workspace_audit(project.tenant_id, actor, 'project.methodology_switched', 'project', project.id,
    jsonb_build_object('from', project.methodology, 'to', p_to));
  RETURN QUERY SELECT 'ok'::text, project.settings_version + 1, moved;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.ws_update_status(uuid,integer,text,integer,boolean),
  spark.ws_switch_methodology(uuid,integer,text,jsonb,jsonb,integer,date,date,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION spark.ws_update_status(uuid,integer,text,integer,boolean),
  spark.ws_switch_methodology(uuid,integer,text,jsonb,jsonb,integer,date,date,jsonb,text) TO spark_app;
