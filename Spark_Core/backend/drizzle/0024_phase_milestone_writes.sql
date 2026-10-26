-- Phase plans, milestones and re-baselining (M4). The runtime role still has no INSERT, UPDATE or DELETE
-- grant on project_phases or project_milestones: they are written only through the spark.ws_* definer
-- functions below, which derive the actor from the live session and return a closed set of outcomes.
-- Owners, admins and the project's current lead edit the plan. Phase plans and re-baselining are for
-- Waterfall projects (22023 Invalid methodology otherwise, so the phases of a project that left Waterfall
-- are read-only history); milestones work in every methodology.
-- Decision order: project or milestone and membership (not_found, before any input error), authority
-- (forbidden), methodology, then input validation (22023) and version; ws_save_phases checks the version
-- before the plan because the plan is validated and written in one step. Lock order: workspace row
-- FOR SHARE (lock_workspace_member), project FOR UPDATE, phases by position, milestones by id.
-- Baselines change only in ws_rebaseline_project (and when a project is created or, in 0025, enters
-- Waterfall); ws_save_phases and ws_update_milestone never touch them.

-- Positions are renumbered by one UPDATE when phases are inserted, removed or reordered; a deferrable
-- constraint is checked at the end of that statement instead of row by row.
ALTER TABLE spark.project_phases DROP CONSTRAINT project_phases_tenant_id_project_id_position_key;
ALTER TABLE spark.project_phases ADD CONSTRAINT project_phases_tenant_id_project_id_position_key
  UNIQUE (tenant_id, project_id, position) DEFERRABLE INITIALLY IMMEDIATE;
--> statement-breakpoint
-- Internal: replaces the phase plan of a project. The caller has locked the project row FOR UPDATE and
-- authorized the actor. p_phases is an array of 1 to 12 objects {id?, name, plannedStart, plannedEnd} in
-- order (M2 rules: name trimmed 1 to 60, plannedStart <= plannedEnd, inside p_start..p_target, each phase
-- starting after the previous one ends; 22023 Invalid project phases otherwise). An entry with id keeps
-- that phase of the project (22023 Invalid phase for a malformed, repeated or foreign id); an entry
-- without id creates a phase, with baseline = planned when p_baseline_new, else a NULL baseline. Phases
-- missing from the array are deleted unless an issue or milestone references them (22023 Invalid phase).
-- Positions become 1..n in array order; existing baselines, status and completed_at are never touched,
-- and only phases whose name, position or dates change get version + 1.
CREATE FUNCTION spark.apply_phase_plan(p_tenant uuid, p_project uuid, p_start date, p_target date, p_phases jsonb, p_baseline_new boolean)
RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE item jsonb; phase_start date; phase_end date; previous_end date; item_id uuid; kept uuid[] := ARRAY[]::uuid[];
  date_pattern constant text := '^\d{4}-\d{2}-\d{2}$';
BEGIN
  IF p_start IS NULL OR p_target IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_target) OR p_target < p_start THEN
    RAISE EXCEPTION 'Invalid project dates' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM spark.project_phases ph WHERE ph.tenant_id = p_tenant AND ph.project_id = p_project ORDER BY ph.position FOR UPDATE;
  IF p_phases IS NULL OR jsonb_typeof(p_phases) <> 'array' THEN
    RAISE EXCEPTION 'Invalid project phases' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_phases) NOT BETWEEN 1 AND 12 THEN
    RAISE EXCEPTION 'Invalid project phases' USING ERRCODE = '22023';
  END IF;
  -- Checks are nested so a malformed element never reaches an operator that would raise a different error.
  FOR item IN SELECT e.value FROM jsonb_array_elements(p_phases) WITH ORDINALITY e ORDER BY e.ordinality LOOP
    IF jsonb_typeof(item) <> 'object' THEN RAISE EXCEPTION 'Invalid project phases' USING ERRCODE = '22023'; END IF;
    IF (item - ARRAY['id','name','plannedStart','plannedEnd']) <> '{}'::jsonb OR jsonb_typeof(item->'name') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'plannedStart') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'plannedEnd') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Invalid project phases' USING ERRCODE = '22023';
    END IF;
    IF length(btrim(item->>'name')) NOT BETWEEN 1 AND 60
      OR item->>'plannedStart' !~ date_pattern OR NOT pg_input_is_valid(item->>'plannedStart', 'date')
      OR item->>'plannedEnd' !~ date_pattern OR NOT pg_input_is_valid(item->>'plannedEnd', 'date') THEN
      RAISE EXCEPTION 'Invalid project phases' USING ERRCODE = '22023';
    END IF;
    phase_start := (item->>'plannedStart')::date; phase_end := (item->>'plannedEnd')::date;
    IF phase_end < phase_start OR phase_start < p_start OR phase_end > p_target OR phase_start <= previous_end THEN
      RAISE EXCEPTION 'Invalid project phases' USING ERRCODE = '22023';
    END IF;
    previous_end := phase_end;
    IF item ? 'id' THEN
      IF jsonb_typeof(item->'id') <> 'string' OR NOT pg_input_is_valid(item->>'id', 'uuid') THEN
        RAISE EXCEPTION 'Invalid phase' USING ERRCODE = '22023';
      END IF;
      item_id := (item->>'id')::uuid;
      IF item_id = ANY (kept) OR NOT EXISTS (SELECT 1 FROM spark.project_phases ph
          WHERE ph.tenant_id = p_tenant AND ph.project_id = p_project AND ph.id = item_id) THEN
        RAISE EXCEPTION 'Invalid phase' USING ERRCODE = '22023';
      END IF;
      kept := kept || item_id;
    END IF;
  END LOOP;
  -- Issue and milestone writers lock the project row first, so these references cannot change underneath.
  IF EXISTS (SELECT 1 FROM spark.project_phases ph WHERE ph.tenant_id = p_tenant AND ph.project_id = p_project AND ph.id <> ALL (kept)
      AND (EXISTS (SELECT 1 FROM spark.issues i WHERE i.tenant_id = ph.tenant_id AND i.project_id = ph.project_id AND i.phase_id = ph.id)
        OR EXISTS (SELECT 1 FROM spark.project_milestones m WHERE m.tenant_id = ph.tenant_id AND m.project_id = ph.project_id AND m.phase_id = ph.id))) THEN
    RAISE EXCEPTION 'Invalid phase' USING ERRCODE = '22023';
  END IF;
  DELETE FROM spark.project_phases ph WHERE ph.tenant_id = p_tenant AND ph.project_id = p_project AND ph.id <> ALL (kept);
  UPDATE spark.project_phases ph SET name = plan.name, position = plan.position, planned_start = plan.planned_start,
    planned_end = plan.planned_end, version = ph.version + 1
    FROM (SELECT (e.value->>'id')::uuid AS id, btrim(e.value->>'name') AS name, e.ordinality::integer AS position,
        (e.value->>'plannedStart')::date AS planned_start, (e.value->>'plannedEnd')::date AS planned_end
      FROM jsonb_array_elements(p_phases) WITH ORDINALITY e WHERE e.value ? 'id') plan
    WHERE ph.tenant_id = p_tenant AND ph.project_id = p_project AND ph.id = plan.id
      AND (ph.name, ph.position, ph.planned_start, ph.planned_end) IS DISTINCT FROM (plan.name, plan.position, plan.planned_start, plan.planned_end);
  INSERT INTO spark.project_phases (tenant_id, project_id, name, position, planned_start, planned_end, baseline_start, baseline_end)
    SELECT p_tenant, p_project, btrim(e.value->>'name'), e.ordinality, (e.value->>'plannedStart')::date, (e.value->>'plannedEnd')::date,
      CASE WHEN p_baseline_new THEN (e.value->>'plannedStart')::date END, CASE WHEN p_baseline_new THEN (e.value->>'plannedEnd')::date END
    FROM jsonb_array_elements(p_phases) WITH ORDINALITY e WHERE NOT e.value ? 'id' ORDER BY e.ordinality;
END $$;
REVOKE EXECUTE ON FUNCTION spark.apply_phase_plan(uuid,uuid,date,date,jsonb,boolean) FROM PUBLIC, spark_app;
--> statement-breakpoint
-- Replaces the phase plan of a Waterfall project (apply_phase_plan; phases created here get a NULL baseline
-- until the next re-baseline). Outcomes: ok, not_found, forbidden, version_mismatch (returns the current
-- settings version). Every save advances projects.settings_version by one.
CREATE FUNCTION spark.ws_save_phases(p_project uuid, p_expected_version integer, p_phases jsonb)
RETURNS TABLE(outcome text, settings_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); target_tenant uuid; actor_role text; project spark.projects%ROWTYPE;
BEGIN
  SELECT p.tenant_id INTO target_tenant FROM spark.projects p WHERE p.id = p_project AND p.archived_at IS NULL;
  IF target_tenant IS NOT NULL THEN actor_role := spark.lock_workspace_member(target_tenant, actor); END IF;
  IF actor_role IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  SELECT * INTO project FROM spark.projects p WHERE p.id = p_project FOR UPDATE;
  IF project.archived_at IS NOT NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  IF actor_role NOT IN ('owner','admin') AND project.lead_user_id IS DISTINCT FROM actor THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::integer; RETURN;
  END IF;
  IF project.methodology <> 'waterfall' THEN RAISE EXCEPTION 'Invalid methodology' USING ERRCODE = '22023'; END IF;
  IF p_expected_version IS DISTINCT FROM project.settings_version THEN
    RETURN QUERY SELECT 'version_mismatch'::text, project.settings_version; RETURN;
  END IF;
  PERFORM spark.apply_phase_plan(project.tenant_id, project.id, project.start_date, project.target_date, p_phases, false);
  UPDATE spark.projects p SET settings_version = p.settings_version + 1 WHERE p.id = project.id;
  RETURN QUERY SELECT 'ok'::text, project.settings_version + 1;
END $$;
--> statement-breakpoint
-- Internal: 22023 Invalid milestone unless the due date is finite and inside the project dates that are set.
CREATE FUNCTION spark.check_milestone_due(p_due date, p_start date, p_target date) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF p_due IS NULL OR NOT isfinite(p_due) OR p_due < p_start OR p_due > p_target THEN
    RAISE EXCEPTION 'Invalid milestone' USING ERRCODE = '22023';
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION spark.check_milestone_due(date,date,date) FROM PUBLIC, spark_app;
--> statement-breakpoint
-- Creates a milestone in a project of any methodology. Outcomes: ok (version 1), not_found, forbidden.
-- 22023: Invalid milestone (name trimmed 1 to 80, due date inside the project dates), Invalid phase (the
-- phase is not one of the project's phases). The baseline due date stays NULL until the next re-baseline.
CREATE FUNCTION spark.ws_create_milestone(p_project uuid, p_name text, p_due date, p_phase uuid)
RETURNS TABLE(outcome text, milestone_id uuid, milestone_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); clean_name text := btrim(p_name); target_tenant uuid; actor_role text;
  project spark.projects%ROWTYPE; new_milestone uuid;
BEGIN
  SELECT p.tenant_id INTO target_tenant FROM spark.projects p WHERE p.id = p_project AND p.archived_at IS NULL;
  IF target_tenant IS NOT NULL THEN actor_role := spark.lock_workspace_member(target_tenant, actor); END IF;
  IF actor_role IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::integer; RETURN; END IF;
  SELECT * INTO project FROM spark.projects p WHERE p.id = p_project FOR UPDATE;
  IF project.archived_at IS NOT NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::integer; RETURN; END IF;
  IF actor_role NOT IN ('owner','admin') AND project.lead_user_id IS DISTINCT FROM actor THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF clean_name IS NULL OR length(clean_name) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'Invalid milestone' USING ERRCODE = '22023';
  END IF;
  PERFORM spark.check_milestone_due(p_due, project.start_date, project.target_date);
  -- Phase writers lock the project row first, so the phase read here cannot change underneath.
  IF p_phase IS NOT NULL AND NOT EXISTS (SELECT 1 FROM spark.project_phases ph
      WHERE ph.tenant_id = project.tenant_id AND ph.project_id = project.id AND ph.id = p_phase) THEN
    RAISE EXCEPTION 'Invalid phase' USING ERRCODE = '22023';
  END IF;
  INSERT INTO spark.project_milestones (tenant_id, project_id, phase_id, name, due_date)
    VALUES (project.tenant_id, project.id, p_phase, clean_name, p_due) RETURNING id INTO new_milestone;
  RETURN QUERY SELECT 'ok'::text, new_milestone, 1;
END $$;
--> statement-breakpoint
-- Patch keys: name, dueDate ('YYYY-MM-DD'), phaseId (a phase of the project or null) and completed
-- (boolean: true sets completed_at once, false clears it). A non-object, {} or any other key raises
-- Invalid milestone. Outcomes: ok, not_found, forbidden, version_mismatch (returns the current version).
-- A patch that changes no value returns ok with the current version and writes nothing.
CREATE FUNCTION spark.ws_update_milestone(p_milestone uuid, p_expected_version integer, p_patch jsonb)
RETURNS TABLE(outcome text, milestone_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); target_tenant uuid; target_project uuid; actor_role text;
  project spark.projects%ROWTYPE; cur spark.project_milestones%ROWTYPE; date_pattern constant text := '^\d{4}-\d{2}-\d{2}$';
  new_name text; new_due date; new_phase uuid; new_completed timestamptz;
BEGIN
  SELECT m.tenant_id, m.project_id INTO target_tenant, target_project FROM spark.project_milestones m
    JOIN spark.projects p ON p.tenant_id = m.tenant_id AND p.id = m.project_id WHERE m.id = p_milestone AND p.archived_at IS NULL;
  IF target_tenant IS NOT NULL THEN actor_role := spark.lock_workspace_member(target_tenant, actor); END IF;
  IF actor_role IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  SELECT * INTO project FROM spark.projects p WHERE p.tenant_id = target_tenant AND p.id = target_project FOR UPDATE;
  IF project.archived_at IS NOT NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  IF actor_role NOT IN ('owner','admin') AND project.lead_user_id IS DISTINCT FROM actor THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::integer; RETURN;
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_patch = '{}'::jsonb
    OR (p_patch - ARRAY['name','dueDate','phaseId','completed']) <> '{}'::jsonb
    OR (p_patch ? 'name' AND (jsonb_typeof(p_patch->'name') <> 'string' OR length(btrim(p_patch->>'name')) NOT BETWEEN 1 AND 80))
    OR (p_patch ? 'dueDate' AND (jsonb_typeof(p_patch->'dueDate') <> 'string'
      OR NOT (p_patch->>'dueDate' ~ date_pattern AND pg_input_is_valid(p_patch->>'dueDate', 'date'))))
    OR (p_patch ? 'completed' AND jsonb_typeof(p_patch->'completed') <> 'boolean') THEN
    RAISE EXCEPTION 'Invalid milestone' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'phaseId' AND (jsonb_typeof(p_patch->'phaseId') NOT IN ('string','null')
      OR (jsonb_typeof(p_patch->'phaseId') = 'string' AND NOT pg_input_is_valid(p_patch->>'phaseId', 'uuid'))) THEN
    RAISE EXCEPTION 'Invalid phase' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO cur FROM spark.project_milestones m WHERE m.tenant_id = project.tenant_id AND m.project_id = project.id AND m.id = p_milestone FOR UPDATE;
  new_name := CASE WHEN p_patch ? 'name' THEN btrim(p_patch->>'name') ELSE cur.name END;
  new_due := CASE WHEN p_patch ? 'dueDate' THEN (p_patch->>'dueDate')::date ELSE cur.due_date END;
  IF p_patch ? 'dueDate' THEN PERFORM spark.check_milestone_due(new_due, project.start_date, project.target_date); END IF;
  new_phase := CASE WHEN p_patch ? 'phaseId' THEN (p_patch->>'phaseId')::uuid ELSE cur.phase_id END;
  IF p_patch ? 'phaseId' AND new_phase IS NOT NULL AND NOT EXISTS (SELECT 1 FROM spark.project_phases ph
      WHERE ph.tenant_id = project.tenant_id AND ph.project_id = project.id AND ph.id = new_phase) THEN
    RAISE EXCEPTION 'Invalid phase' USING ERRCODE = '22023';
  END IF;
  new_completed := CASE WHEN NOT p_patch ? 'completed' THEN cur.completed_at
    WHEN (p_patch->>'completed')::boolean THEN coalesce(cur.completed_at, now()) END;
  IF p_expected_version IS DISTINCT FROM cur.version THEN
    RETURN QUERY SELECT 'version_mismatch'::text, cur.version; RETURN;
  END IF;
  IF new_name IS NOT DISTINCT FROM cur.name AND new_due IS NOT DISTINCT FROM cur.due_date AND new_phase IS NOT DISTINCT FROM cur.phase_id
    AND new_completed IS NOT DISTINCT FROM cur.completed_at THEN
    RETURN QUERY SELECT 'ok'::text, cur.version; RETURN;
  END IF;
  UPDATE spark.project_milestones m SET name = new_name, due_date = new_due, phase_id = new_phase, completed_at = new_completed,
    version = m.version + 1
    WHERE m.id = cur.id;
  RETURN QUERY SELECT 'ok'::text, cur.version + 1;
END $$;
--> statement-breakpoint
-- Copies planned -> baseline for every phase (baseline_start/end) and milestone (baseline_due_date) of a
-- Waterfall project, sets projects.baselined_at, advances settings_version and records audit
-- project.rebaselined {reason}. Only rows whose baseline changes get version + 1. Outcomes: ok, not_found,
-- forbidden, version_mismatch (returns the current settings version). 22023: Invalid methodology,
-- Invalid baseline reason (trimmed 1 to 200).
CREATE FUNCTION spark.ws_rebaseline_project(p_project uuid, p_expected_version integer, p_reason text)
RETURNS TABLE(outcome text, settings_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); clean_reason text := btrim(p_reason); target_tenant uuid; actor_role text;
  project spark.projects%ROWTYPE;
BEGIN
  SELECT p.tenant_id INTO target_tenant FROM spark.projects p WHERE p.id = p_project AND p.archived_at IS NULL;
  IF target_tenant IS NOT NULL THEN actor_role := spark.lock_workspace_member(target_tenant, actor); END IF;
  IF actor_role IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  SELECT * INTO project FROM spark.projects p WHERE p.id = p_project FOR UPDATE;
  IF project.archived_at IS NOT NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  IF actor_role NOT IN ('owner','admin') AND project.lead_user_id IS DISTINCT FROM actor THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::integer; RETURN;
  END IF;
  IF project.methodology <> 'waterfall' THEN RAISE EXCEPTION 'Invalid methodology' USING ERRCODE = '22023'; END IF;
  IF clean_reason IS NULL OR length(clean_reason) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid baseline reason' USING ERRCODE = '22023';
  END IF;
  IF p_expected_version IS DISTINCT FROM project.settings_version THEN
    RETURN QUERY SELECT 'version_mismatch'::text, project.settings_version; RETURN;
  END IF;
  PERFORM 1 FROM spark.project_phases ph WHERE ph.tenant_id = project.tenant_id AND ph.project_id = project.id ORDER BY ph.position FOR UPDATE;
  PERFORM 1 FROM spark.project_milestones m WHERE m.tenant_id = project.tenant_id AND m.project_id = project.id ORDER BY m.id FOR UPDATE;
  UPDATE spark.project_phases ph SET baseline_start = ph.planned_start, baseline_end = ph.planned_end, version = ph.version + 1
    WHERE ph.tenant_id = project.tenant_id AND ph.project_id = project.id
      AND (ph.baseline_start, ph.baseline_end) IS DISTINCT FROM (ph.planned_start, ph.planned_end);
  UPDATE spark.project_milestones m SET baseline_due_date = m.due_date, version = m.version + 1
    WHERE m.tenant_id = project.tenant_id AND m.project_id = project.id AND m.baseline_due_date IS DISTINCT FROM m.due_date;
  UPDATE spark.projects p SET baselined_at = now(), settings_version = p.settings_version + 1 WHERE p.id = project.id;
  PERFORM spark.record_workspace_audit(project.tenant_id, actor, 'project.rebaselined', 'project', project.id,
    jsonb_build_object('reason', clean_reason));
  RETURN QUERY SELECT 'ok'::text, project.settings_version + 1;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.ws_save_phases(uuid,integer,jsonb), spark.ws_create_milestone(uuid,text,date,uuid),
  spark.ws_update_milestone(uuid,integer,jsonb), spark.ws_rebaseline_project(uuid,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION spark.ws_save_phases(uuid,integer,jsonb), spark.ws_create_milestone(uuid,text,date,uuid),
  spark.ws_update_milestone(uuid,integer,jsonb), spark.ws_rebaseline_project(uuid,integer,text) TO spark_app;
