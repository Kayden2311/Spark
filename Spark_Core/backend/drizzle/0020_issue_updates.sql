-- Issue updates, moves, ranking and WIP admission (M3). The runtime role still has no INSERT, UPDATE or
-- DELETE grant on issues: they change only through spark.ws_update_issue, which derives the actor from the
-- live session, returns a closed set of outcomes and writes the issue, its issue.updated history row, its
-- outbox row, any issue.reranked change sets of a rebalance and an optional issue_assigned notification in
-- one transaction. Lock order as in 0019: workspace row FOR SHARE, project row FOR UPDATE, board, then
-- issues (the updated issue, then the renumbered issues by id). Every issue writer holds the project row
-- lock, so positions are computed without races.
-- Ranking: issues.position numeric(20,6) orders a status column. afterIssueId X places the issue at the
-- midpoint between X and the next issue (X + 1024 at the end), null places it first (first - 1024, or 1024),
-- and a status change or restore without afterIssueId places it last (max + 1024, or 1024). When the gap
-- to a neighbour falls below 0.001 the column is rebalanced locally: at most 50 issues around the drop point
-- (the mover and its neighbours, in the new order) are spread evenly between the nearest untouched issues
-- below and above, or in 1024 steps at a column end. Only when that span is itself too dense (a gap below
-- 0.001) is the whole column renumbered to 1024 * i. Each other renumbered issue whose position changes gets
-- its own version, issue.reranked event and processed outbox row.
CREATE FUNCTION spark.ws_update_issue(p_issue uuid, p_expected_version integer, p_patch jsonb)
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
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_patch = '{}'::jsonb
    OR (p_patch - ARRAY['title','description','type','priority','statusId','afterIssueId','assigneeUserId','storyPoints','dueDate','phaseId','archived']) <> '{}'::jsonb THEN
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
    CASE WHEN new_archived IS DISTINCT FROM (cur.archived_at IS NOT NULL) THEN 'archived' END]) f WHERE f IS NOT NULL ORDER BY f);
  IF cardinality(changed) = 0 THEN
    RETURN QUERY SELECT 'ok'::text, cur.version; RETURN;
  END IF;

  UPDATE spark.issues i SET title = new_title, description = new_description, type = new_type, priority = new_priority,
    status_id = new_status, assignee_user_id = new_assignee, story_points = new_points, due_date = new_due, phase_id = new_phase,
    position = new_position, archived_at = CASE WHEN new_archived THEN coalesce(i.archived_at, now()) END, version = i.version + 1
    WHERE i.id = cur.id;
  INSERT INTO spark.issue_events (tenant_id, project_id, issue_id, actor_user_id, event_type, from_version, to_version, changes)
    VALUES (project.tenant_id, project.id, cur.id, actor, 'issue.updated', cur.version, cur.version + 1, jsonb_build_object(
      'fields', to_jsonb(changed),
      'after', jsonb_build_object('statusId', new_status, 'category', status_category, 'assigneeUserId', new_assignee,
        'storyPoints', new_points, 'phaseId', new_phase, 'sprintId', cur.sprint_id, 'archived', new_archived)));
  INSERT INTO spark.outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, processed_at)
    VALUES (project.tenant_id, 'issue.updated', 'issue', cur.id, cur.version + 1,
      jsonb_build_object('issueId', cur.id, 'projectId', project.id, 'actorUserId', actor, 'assigneeUserId', new_assignee), now())
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

  IF new_assignee IS DISTINCT FROM cur.assignee_user_id AND new_assignee IS NOT NULL AND new_assignee <> actor THEN
    SELECT btrim(u.display_name) INTO actor_name FROM spark.users u WHERE u.id = actor;
    INSERT INTO spark.notifications (tenant_id, recipient_user_id, outbox_event_id, kind, title, resource_type, resource_id)
      VALUES (project.tenant_id, new_assignee, outbox_id, 'issue_assigned',
        left(actor_name || ' assigned you ' || project.key || '-' || cur.number || ': ' || new_title, 500), 'issue', cur.id);
  END IF;
  RETURN QUERY SELECT 'ok'::text, cur.version + 1;
END $$;
--> statement-breakpoint
-- Unchanged from 0018 except that a patch which changes no value returns ok with the current
-- settings_version and writes neither the project row nor an audit row.
CREATE OR REPLACE FUNCTION spark.ws_update_project(p_project uuid, p_expected_version integer, p_patch jsonb)
RETURNS TABLE(outcome text, settings_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); target_tenant uuid; actor_role text; cur spark.projects%ROWTYPE;
  date_pattern constant text := '^\d{4}-\d{2}-\d{2}$';
  new_name text; new_description text; new_lead uuid; new_start date; new_target date; new_sprint_length integer;
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
  new_sprint_length := CASE WHEN p_patch ? 'sprintLengthDays' THEN (p_patch->>'sprintLengthDays')::numeric::integer ELSE cur.sprint_length_days END;
  -- Phase writers lock the project row first, so the phase plan read here cannot change underneath.
  IF new_target < new_start OR (cur.methodology = 'waterfall' AND (new_start IS NULL OR new_target IS NULL
      OR EXISTS (SELECT 1 FROM spark.project_phases ph WHERE ph.tenant_id = cur.tenant_id AND ph.project_id = cur.id
        AND (ph.planned_start < new_start OR ph.planned_end > new_target)))) THEN
    RAISE EXCEPTION 'Invalid project dates' USING ERRCODE = '22023';
  END IF;
  IF new_name = cur.name AND new_description IS NOT DISTINCT FROM cur.description AND new_lead IS NOT DISTINCT FROM cur.lead_user_id
    AND new_start IS NOT DISTINCT FROM cur.start_date AND new_target IS NOT DISTINCT FROM cur.target_date
    AND new_sprint_length IS NOT DISTINCT FROM cur.sprint_length_days THEN
    RETURN QUERY SELECT 'ok'::text, cur.settings_version; RETURN;
  END IF;
  UPDATE spark.projects p SET name = new_name, description = new_description, lead_user_id = new_lead,
    start_date = new_start, target_date = new_target, sprint_length_days = new_sprint_length,
    settings_version = p.settings_version + 1
    WHERE p.id = cur.id;
  PERFORM spark.record_workspace_audit(cur.tenant_id, actor, 'project.updated', 'project', cur.id,
    jsonb_build_object('changed', to_jsonb(ARRAY(SELECT k FROM jsonb_object_keys(p_patch) k ORDER BY k))));
  RETURN QUERY SELECT 'ok'::text, cur.settings_version + 1;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.ws_update_issue(uuid,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION spark.ws_update_issue(uuid,integer,jsonb) TO spark_app;
