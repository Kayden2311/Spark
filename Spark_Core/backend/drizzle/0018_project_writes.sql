-- Project create and update (M2). The runtime role still has no INSERT, UPDATE or DELETE grant: projects
-- are written only through the two spark.ws_* definer functions below, which derive the actor from the
-- live session, return a closed set of outcomes and record one audit row in the same transaction.
-- Statuses and phases arrive fully formed from the caller (the API computes template defaults); they are
-- validated here. Input violations raise 22023 with a whitelisted message before any row is locked.
-- Lock order: workspace, then project, then board, then statuses, then phases and milestones.
CREATE FUNCTION spark.ws_create_project(p_workspace uuid, p_key text, p_name text, p_description text, p_methodology text,
  p_lead uuid, p_start date, p_target date, p_sprint_length integer, p_statuses jsonb, p_phases jsonb)
RETURNS TABLE(outcome text, project_id uuid, settings_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); clean_name text := btrim(p_name);
  clean_description text := nullif(btrim(p_description), ''); plan jsonb := coalesce(p_phases, '[]'::jsonb);
  sprint_length integer; actor_role text; new_project uuid; new_phase uuid; item jsonb; item_position bigint;
  phase_name text; phase_start date; phase_end date; previous_end date;
BEGIN
  IF p_key IS NULL OR p_key !~ '^[A-Z][A-Z0-9]{1,9}$' THEN
    RAISE EXCEPTION 'Invalid project key' USING ERRCODE = '22023';
  END IF;
  IF clean_name IS NULL OR length(clean_name) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'Invalid project name' USING ERRCODE = '22023';
  END IF;
  IF length(clean_description) > 2000 THEN
    RAISE EXCEPTION 'Invalid project description' USING ERRCODE = '22023';
  END IF;
  IF p_methodology IS NULL OR p_methodology NOT IN ('scrum','kanban','waterfall') THEN
    RAISE EXCEPTION 'Invalid methodology' USING ERRCODE = '22023';
  END IF;
  IF (p_start IS NOT NULL AND NOT isfinite(p_start)) OR (p_target IS NOT NULL AND NOT isfinite(p_target)) OR p_target < p_start
    OR (p_methodology = 'waterfall' AND (p_start IS NULL OR p_target IS NULL)) THEN
    RAISE EXCEPTION 'Invalid project dates' USING ERRCODE = '22023';
  END IF;
  IF p_methodology = 'scrum' THEN
    sprint_length := coalesce(p_sprint_length, 14);
    IF sprint_length NOT BETWEEN 7 AND 28 THEN RAISE EXCEPTION 'Invalid sprint length' USING ERRCODE = '22023'; END IF;
  ELSIF p_sprint_length IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid sprint length' USING ERRCODE = '22023';
  END IF;
  -- Statuses: 2-12 objects {name, category, wipLimit} in board order. Checks are nested so a malformed
  -- element never reaches an operator that would raise a different error.
  IF p_statuses IS NULL OR jsonb_typeof(p_statuses) <> 'array' THEN
    RAISE EXCEPTION 'Invalid project statuses' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_statuses) NOT BETWEEN 2 AND 12 THEN
    RAISE EXCEPTION 'Invalid project statuses' USING ERRCODE = '22023';
  END IF;
  FOR item IN SELECT e.value FROM jsonb_array_elements(p_statuses) e LOOP
    IF jsonb_typeof(item) <> 'object' THEN RAISE EXCEPTION 'Invalid project statuses' USING ERRCODE = '22023'; END IF;
    IF (item - ARRAY['name','category','wipLimit']) <> '{}'::jsonb
      OR jsonb_typeof(item->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'category') IS DISTINCT FROM 'string'
      OR coalesce(jsonb_typeof(item->'wipLimit'), 'null') NOT IN ('null','number') THEN
      RAISE EXCEPTION 'Invalid project statuses' USING ERRCODE = '22023';
    END IF;
    IF length(btrim(item->>'name')) NOT BETWEEN 1 AND 40 OR item->>'category' NOT IN ('backlog','todo','in_progress','done') THEN
      RAISE EXCEPTION 'Invalid project statuses' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(item->'wipLimit') = 'number' AND ((item->>'wipLimit')::numeric NOT BETWEEN 1 AND 99
        OR (item->>'wipLimit')::numeric <> trunc((item->>'wipLimit')::numeric)) THEN
      RAISE EXCEPTION 'Invalid project statuses' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT lower(btrim(e.value->>'name'))) FROM jsonb_array_elements(p_statuses) e) <> jsonb_array_length(p_statuses)
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_statuses) e WHERE e.value->>'category' = 'done')
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_statuses) e WHERE e.value->>'category' <> 'done') THEN
    RAISE EXCEPTION 'Invalid project statuses' USING ERRCODE = '22023';
  END IF;
  -- Phases: none unless Waterfall; Waterfall needs 1-12 objects {name, plannedStart, plannedEnd} in order,
  -- each inside the project dates and starting after the previous phase ends.
  IF jsonb_typeof(plan) <> 'array' THEN
    RAISE EXCEPTION 'Invalid project phases' USING ERRCODE = '22023';
  END IF;
  IF (p_methodology = 'waterfall' AND jsonb_array_length(plan) NOT BETWEEN 1 AND 12)
    OR (p_methodology <> 'waterfall' AND jsonb_array_length(plan) <> 0) THEN
    RAISE EXCEPTION 'Invalid project phases' USING ERRCODE = '22023';
  END IF;
  FOR item IN SELECT e.value FROM jsonb_array_elements(plan) WITH ORDINALITY e ORDER BY e.ordinality LOOP
    IF jsonb_typeof(item) <> 'object' THEN RAISE EXCEPTION 'Invalid project phases' USING ERRCODE = '22023'; END IF;
    IF (item - ARRAY['name','plannedStart','plannedEnd']) <> '{}'::jsonb OR jsonb_typeof(item->'name') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'plannedStart') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'plannedEnd') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Invalid project phases' USING ERRCODE = '22023';
    END IF;
    IF length(btrim(item->>'name')) NOT BETWEEN 1 AND 60
      OR item->>'plannedStart' !~ '^\d{4}-\d{2}-\d{2}$' OR NOT pg_input_is_valid(item->>'plannedStart', 'date')
      OR item->>'plannedEnd' !~ '^\d{4}-\d{2}-\d{2}$' OR NOT pg_input_is_valid(item->>'plannedEnd', 'date') THEN
      RAISE EXCEPTION 'Invalid project phases' USING ERRCODE = '22023';
    END IF;
    phase_start := (item->>'plannedStart')::date; phase_end := (item->>'plannedEnd')::date;
    IF phase_end < phase_start OR phase_start < p_start OR phase_end > p_target OR phase_start <= previous_end THEN
      RAISE EXCEPTION 'Invalid project phases' USING ERRCODE = '22023';
    END IF;
    previous_end := phase_end;
  END LOOP;

  actor_role := spark.lock_workspace_role(p_workspace, actor);
  IF actor_role IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::integer; RETURN; END IF;
  IF actor_role NOT IN ('owner','admin') THEN RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::integer; RETURN; END IF;
  IF p_lead IS NOT NULL AND NOT EXISTS (SELECT 1 FROM spark.workspace_memberships m JOIN spark.users u ON u.id = m.user_id
      WHERE m.tenant_id = p_workspace AND m.user_id = p_lead AND m.status = 'active' AND u.status = 'active' AND u.deleted_at IS NULL) THEN
    RETURN QUERY SELECT 'invalid_lead'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  -- The workspace row lock taken above serializes concurrent creations against the cap.
  IF (SELECT count(*) FROM spark.projects p WHERE p.tenant_id = p_workspace AND p.archived_at IS NULL) >= 50 THEN
    RETURN QUERY SELECT 'too_many_projects'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  INSERT INTO spark.projects (tenant_id, key, name, description, lead_user_id, methodology, start_date, target_date, sprint_length_days, baselined_at)
    VALUES (p_workspace, p_key, clean_name, clean_description, p_lead, p_methodology, p_start, p_target, sprint_length,
      CASE WHEN p_methodology = 'waterfall' THEN now() END)
    ON CONFLICT (tenant_id, key) DO NOTHING RETURNING id INTO new_project;
  IF new_project IS NULL THEN RETURN QUERY SELECT 'key_taken'::text, NULL::uuid, NULL::integer; RETURN; END IF;
  INSERT INTO spark.boards (tenant_id, project_id, name) VALUES (p_workspace, new_project, clean_name);
  INSERT INTO spark.issue_statuses (tenant_id, project_id, name, category, position, wip_limit)
    SELECT p_workspace, new_project, btrim(e.value->>'name'), e.value->>'category', 1024 * e.ordinality, (e.value->>'wipLimit')::numeric::integer
    FROM jsonb_array_elements(p_statuses) WITH ORDINALITY e ORDER BY e.ordinality;
  FOR item, item_position IN SELECT e.value, e.ordinality FROM jsonb_array_elements(plan) WITH ORDINALITY e ORDER BY e.ordinality LOOP
    phase_name := btrim(item->>'name'); phase_start := (item->>'plannedStart')::date; phase_end := (item->>'plannedEnd')::date;
    INSERT INTO spark.project_phases (tenant_id, project_id, name, position, planned_start, planned_end, baseline_start, baseline_end)
      VALUES (p_workspace, new_project, phase_name, item_position, phase_start, phase_end, phase_start, phase_end) RETURNING id INTO new_phase;
    INSERT INTO spark.project_milestones (tenant_id, project_id, phase_id, name, due_date, baseline_due_date)
      VALUES (p_workspace, new_project, new_phase, phase_name || ' sign-off', phase_end, phase_end);
  END LOOP;
  INSERT INTO spark.project_methodology_periods (tenant_id, project_id, methodology, changed_by_user_id, reason)
    VALUES (p_workspace, new_project, p_methodology, actor, 'Project created');
  PERFORM spark.record_workspace_audit(p_workspace, actor, 'project.created', 'project', new_project,
    jsonb_build_object('methodology', p_methodology, 'key', p_key));
  RETURN QUERY SELECT 'ok'::text, new_project, 1;
END $$;
--> statement-breakpoint
-- Owners, admins and the project's current lead edit settings. Methodology is not editable here. The
-- API rejects unknown keys first; any other key still raises 'Invalid project name' as a fallback.
CREATE FUNCTION spark.ws_update_project(p_project uuid, p_expected_version integer, p_patch jsonb)
RETURNS TABLE(outcome text, settings_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); target_tenant uuid; actor_role text; cur spark.projects%ROWTYPE;
  date_pattern constant text := '^\d{4}-\d{2}-\d{2}$';
  new_name text; new_description text; new_lead uuid; new_start date; new_target date;
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'Invalid project name' USING ERRCODE = '22023';
  END IF;
  IF (p_patch - ARRAY['name','description','leadUserId','startDate','targetDate','sprintLengthDays']) <> '{}'::jsonb
    OR (p_patch ? 'name' AND (jsonb_typeof(p_patch->'name') <> 'string' OR length(btrim(p_patch->>'name')) NOT BETWEEN 1 AND 80)) THEN
    RAISE EXCEPTION 'Invalid project name' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'description' AND (jsonb_typeof(p_patch->'description') NOT IN ('string','null') OR length(btrim(p_patch->>'description')) > 2000) THEN
    RAISE EXCEPTION 'Invalid project description' USING ERRCODE = '22023';
  END IF;
  IF (p_patch ? 'startDate' AND (jsonb_typeof(p_patch->'startDate') NOT IN ('string','null') OR (jsonb_typeof(p_patch->'startDate') = 'string'
        AND NOT (p_patch->>'startDate' ~ date_pattern AND pg_input_is_valid(p_patch->>'startDate', 'date')))))
    OR (p_patch ? 'targetDate' AND (jsonb_typeof(p_patch->'targetDate') NOT IN ('string','null') OR (jsonb_typeof(p_patch->'targetDate') = 'string'
        AND NOT (p_patch->>'targetDate' ~ date_pattern AND pg_input_is_valid(p_patch->>'targetDate', 'date'))))) THEN
    RAISE EXCEPTION 'Invalid project dates' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'sprintLengthDays' AND (jsonb_typeof(p_patch->'sprintLengthDays') <> 'number'
      OR (p_patch->>'sprintLengthDays')::numeric NOT BETWEEN 7 AND 28
      OR (p_patch->>'sprintLengthDays')::numeric <> trunc((p_patch->>'sprintLengthDays')::numeric)) THEN
    RAISE EXCEPTION 'Invalid sprint length' USING ERRCODE = '22023';
  END IF;

  SELECT p.tenant_id INTO target_tenant FROM spark.projects p WHERE p.id = p_project;
  IF target_tenant IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  actor_role := spark.lock_workspace_role(target_tenant, actor);
  IF actor_role IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  SELECT * INTO cur FROM spark.projects p WHERE p.id = p_project FOR UPDATE;
  IF actor_role NOT IN ('owner','admin') AND cur.lead_user_id IS DISTINCT FROM actor THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::integer; RETURN;
  END IF;
  IF p_expected_version IS DISTINCT FROM cur.settings_version THEN
    RETURN QUERY SELECT 'version_mismatch'::text, cur.settings_version; RETURN;
  END IF;
  IF p_patch ? 'leadUserId' AND (jsonb_typeof(p_patch->'leadUserId') NOT IN ('string','null')
      OR (jsonb_typeof(p_patch->'leadUserId') = 'string' AND NOT pg_input_is_valid(p_patch->>'leadUserId', 'uuid'))) THEN
    RETURN QUERY SELECT 'invalid_lead'::text, NULL::integer; RETURN;
  END IF;
  new_lead := CASE WHEN p_patch ? 'leadUserId' THEN (p_patch->>'leadUserId')::uuid ELSE cur.lead_user_id END;
  IF p_patch ? 'leadUserId' AND new_lead IS NOT NULL AND NOT EXISTS (SELECT 1 FROM spark.workspace_memberships m JOIN spark.users u ON u.id = m.user_id
      WHERE m.tenant_id = cur.tenant_id AND m.user_id = new_lead AND m.status = 'active' AND u.status = 'active' AND u.deleted_at IS NULL) THEN
    RETURN QUERY SELECT 'invalid_lead'::text, NULL::integer; RETURN;
  END IF;
  IF p_patch ? 'sprintLengthDays' AND cur.methodology <> 'scrum' THEN
    RAISE EXCEPTION 'Invalid sprint length' USING ERRCODE = '22023';
  END IF;
  new_name := CASE WHEN p_patch ? 'name' THEN btrim(p_patch->>'name') ELSE cur.name END;
  new_description := CASE WHEN p_patch ? 'description' THEN nullif(btrim(p_patch->>'description'), '') ELSE cur.description END;
  new_start := CASE WHEN p_patch ? 'startDate' THEN (p_patch->>'startDate')::date ELSE cur.start_date END;
  new_target := CASE WHEN p_patch ? 'targetDate' THEN (p_patch->>'targetDate')::date ELSE cur.target_date END;
  -- Phase writers lock the project row first, so the phase plan read here cannot change underneath.
  IF new_target < new_start OR (cur.methodology = 'waterfall' AND (new_start IS NULL OR new_target IS NULL
      OR EXISTS (SELECT 1 FROM spark.project_phases ph WHERE ph.tenant_id = cur.tenant_id AND ph.project_id = cur.id
        AND (ph.planned_start < new_start OR ph.planned_end > new_target)))) THEN
    RAISE EXCEPTION 'Invalid project dates' USING ERRCODE = '22023';
  END IF;
  UPDATE spark.projects p SET name = new_name, description = new_description, lead_user_id = new_lead,
    start_date = new_start, target_date = new_target,
    sprint_length_days = CASE WHEN p_patch ? 'sprintLengthDays' THEN (p_patch->>'sprintLengthDays')::numeric::integer ELSE p.sprint_length_days END,
    settings_version = p.settings_version + 1
    WHERE p.id = cur.id;
  PERFORM spark.record_workspace_audit(cur.tenant_id, actor, 'project.updated', 'project', cur.id,
    jsonb_build_object('changed', to_jsonb(ARRAY(SELECT k FROM jsonb_object_keys(p_patch) k ORDER BY k))));
  RETURN QUERY SELECT 'ok'::text, cur.settings_version + 1;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.ws_create_project(uuid,text,text,text,text,uuid,date,date,integer,jsonb,jsonb),
  spark.ws_update_project(uuid,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION spark.ws_create_project(uuid,text,text,text,text,uuid,date,date,integer,jsonb,jsonb),
  spark.ws_update_project(uuid,integer,jsonb) TO spark_app;
