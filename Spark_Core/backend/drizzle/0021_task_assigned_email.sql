-- Task-assigned email (M3). When ws_create_issue or ws_update_issue creates an issue_assigned notification,
-- that version's outbox row is left unprocessed (processed_at NULL) and its payload gains version and
-- notificationId, so the worker picks it up; every other issue outbox row is still written processed. The
-- notification id is generated before the outbox insert so the payload can name it, while the outbox row
-- is still inserted first because the notification references it. Both write functions are otherwise
-- unchanged from 0019 and 0020 (validation, locking, ranking, rebalance, WIP admission, idempotency).
-- The worker (spark_worker, no table privileges) reads what the email needs and records the delivery only
-- through the two spark.worker_* definer functions below. Deliveries are deduplicated by the existing
-- unique (tenant_id, notification_id, channel) key on notification_deliveries.
CREATE OR REPLACE FUNCTION spark.ws_create_issue(p_project uuid, p_title text, p_description text, p_type text, p_priority text, p_status uuid,
  p_assignee uuid, p_story_points numeric, p_due date, p_phase uuid, p_idempotency_key text, p_request_hash bytea)
RETURNS TABLE(outcome text, issue_id uuid, issue_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); clean_title text := btrim(p_title);
  clean_description text := nullif(btrim(p_description), ''); issue_type text := coalesce(p_type, 'task');
  issue_priority text := coalesce(p_priority, 'medium'); target_tenant uuid; project spark.projects%ROWTYPE;
  target_status uuid; status_category text; capacity integer; idempotency_id uuid; existing spark.idempotency_requests%ROWTYPE;
  existing_version integer; new_issue uuid := gen_random_uuid(); new_number bigint; new_position numeric(20,6);
  outbox_id uuid; actor_name text; notification_id uuid;
BEGIN
  SELECT p.tenant_id INTO target_tenant FROM spark.projects p WHERE p.id = p_project AND p.archived_at IS NULL;
  IF target_tenant IS NULL OR spark.lock_workspace_member(target_tenant, actor) IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  SELECT * INTO project FROM spark.projects p WHERE p.id = p_project FOR UPDATE;
  IF project.archived_at IS NOT NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  PERFORM 1 FROM spark.boards b WHERE b.tenant_id = project.tenant_id AND b.project_id = project.id FOR UPDATE;

  IF p_idempotency_key IS NOT NULL THEN
    IF p_idempotency_key !~ '^[A-Za-z0-9_.:-]{1,100}$' OR p_request_hash IS NULL OR octet_length(p_request_hash) <> 32 THEN
      RAISE EXCEPTION 'Invalid idempotency key' USING ERRCODE = '22023';
    END IF;
    DELETE FROM spark.idempotency_requests r WHERE r.tenant_id = project.tenant_id AND r.actor_user_id = actor
      AND r.operation = 'issue.create' AND r.key = p_idempotency_key AND r.expires_at <= now();
    INSERT INTO spark.idempotency_requests (tenant_id, actor_user_id, operation, key, request_hash, expires_at)
      VALUES (project.tenant_id, actor, 'issue.create', p_idempotency_key, p_request_hash, now() + interval '24 hours')
      ON CONFLICT (tenant_id, actor_user_id, operation, key) DO NOTHING RETURNING id INTO idempotency_id;
    IF idempotency_id IS NULL THEN
      SELECT * INTO existing FROM spark.idempotency_requests r WHERE r.tenant_id = project.tenant_id AND r.actor_user_id = actor
        AND r.operation = 'issue.create' AND r.key = p_idempotency_key;
      SELECT i.version INTO existing_version FROM spark.issues i
        WHERE i.tenant_id = project.tenant_id AND i.project_id = project.id AND i.id = existing.resource_id;
      IF existing.state = 'completed' AND existing.request_hash = p_request_hash AND existing_version IS NOT NULL THEN
        RETURN QUERY SELECT 'replayed'::text, existing.resource_id, existing_version; RETURN;
      END IF;
      RETURN QUERY SELECT 'idempotency_conflict'::text, NULL::uuid, NULL::integer; RETURN;
    END IF;
  END IF;

  IF clean_title IS NULL OR length(clean_title) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid issue title' USING ERRCODE = '22023';
  END IF;
  IF length(clean_description) > 10000 THEN
    RAISE EXCEPTION 'Invalid issue description' USING ERRCODE = '22023';
  END IF;
  IF issue_type NOT IN ('task','bug','story') THEN
    RAISE EXCEPTION 'Invalid issue type' USING ERRCODE = '22023';
  END IF;
  IF issue_priority NOT IN ('lowest','low','medium','high','highest') THEN
    RAISE EXCEPTION 'Invalid issue priority' USING ERRCODE = '22023';
  END IF;
  IF p_story_points IS NOT NULL AND (p_story_points NOT BETWEEN 0 AND 100 OR p_story_points <> round(p_story_points, 2)) THEN
    RAISE EXCEPTION 'Invalid story points' USING ERRCODE = '22023';
  END IF;
  IF p_due IS NOT NULL AND p_due NOT BETWEEN DATE '2000-01-01' AND DATE '2100-12-31' THEN
    RAISE EXCEPTION 'Invalid due date' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NOT NULL AND NOT EXISTS (SELECT 1 FROM spark.issue_statuses s
      WHERE s.tenant_id = project.tenant_id AND s.project_id = project.id AND s.id = p_status) THEN
    RAISE EXCEPTION 'Invalid issue status' USING ERRCODE = '22023';
  END IF;
  IF p_phase IS NOT NULL AND NOT EXISTS (SELECT 1 FROM spark.project_phases ph
      WHERE ph.tenant_id = project.tenant_id AND ph.project_id = project.id AND ph.id = p_phase) THEN
    RAISE EXCEPTION 'Invalid issue phase' USING ERRCODE = '22023';
  END IF;

  -- Default column: the first status by position that is not done.
  SELECT s.id, s.category, s.wip_limit INTO target_status, status_category, capacity FROM spark.issue_statuses s
    WHERE s.tenant_id = project.tenant_id AND s.project_id = project.id AND (s.id = p_status OR (p_status IS NULL AND s.category <> 'done'))
    ORDER BY s.position, s.id LIMIT 1;
  IF target_status IS NULL OR NOT EXISTS (SELECT 1 FROM spark.boards b WHERE b.tenant_id = project.tenant_id AND b.project_id = project.id) THEN
    DELETE FROM spark.idempotency_requests r WHERE r.id = idempotency_id;
    RETURN QUERY SELECT 'no_board'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF p_assignee IS NOT NULL AND NOT EXISTS (SELECT 1 FROM spark.workspace_memberships m JOIN spark.users u ON u.id = m.user_id
      WHERE m.tenant_id = project.tenant_id AND m.user_id = p_assignee AND m.status = 'active' AND u.status = 'active' AND u.deleted_at IS NULL) THEN
    DELETE FROM spark.idempotency_requests r WHERE r.id = idempotency_id;
    RETURN QUERY SELECT 'invalid_assignee'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  -- The project row lock taken above serializes concurrent creations against the cap and WIP limits.
  IF (SELECT count(*) FROM spark.issues i WHERE i.tenant_id = project.tenant_id AND i.project_id = project.id AND i.archived_at IS NULL) >= 10000 THEN
    DELETE FROM spark.idempotency_requests r WHERE r.id = idempotency_id;
    RETURN QUERY SELECT 'too_many_issues'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF capacity IS NOT NULL AND (SELECT count(*) FROM spark.issues i WHERE i.tenant_id = project.tenant_id AND i.project_id = project.id
      AND i.status_id = target_status AND i.archived_at IS NULL) >= capacity THEN
    DELETE FROM spark.idempotency_requests r WHERE r.id = idempotency_id;
    RETURN QUERY SELECT 'wip_limit_reached'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;

  new_number := project.next_issue_number;
  UPDATE spark.projects p SET next_issue_number = p.next_issue_number + 1 WHERE p.id = project.id;
  SELECT coalesce(max(i.position) + 1024, 1024) INTO new_position FROM spark.issues i
    WHERE i.tenant_id = project.tenant_id AND i.project_id = project.id AND i.status_id = target_status AND i.archived_at IS NULL;
  INSERT INTO spark.issues (id, tenant_id, project_id, number, type, title, description, status_id, priority, reporter_user_id,
      assignee_user_id, position, story_points, due_date, phase_id)
    VALUES (new_issue, project.tenant_id, project.id, new_number, issue_type, clean_title, clean_description, target_status, issue_priority, actor,
      p_assignee, new_position, p_story_points, p_due, p_phase);
  INSERT INTO spark.issue_events (tenant_id, project_id, issue_id, actor_user_id, event_type, from_version, to_version, changes)
    VALUES (project.tenant_id, project.id, new_issue, actor, 'issue.created', 0, 1, jsonb_build_object(
      'fields', to_jsonb(ARRAY(SELECT f FROM unnest(ARRAY['title',
        CASE WHEN clean_description IS NOT NULL THEN 'description' END, CASE WHEN p_type IS NOT NULL THEN 'type' END,
        CASE WHEN p_priority IS NOT NULL THEN 'priority' END, CASE WHEN p_status IS NOT NULL THEN 'statusId' END,
        CASE WHEN p_assignee IS NOT NULL THEN 'assigneeUserId' END, CASE WHEN p_story_points IS NOT NULL THEN 'storyPoints' END,
        CASE WHEN p_due IS NOT NULL THEN 'dueDate' END, CASE WHEN p_phase IS NOT NULL THEN 'phaseId' END]) f WHERE f IS NOT NULL ORDER BY f)),
      'after', jsonb_build_object('statusId', target_status, 'category', status_category, 'assigneeUserId', p_assignee,
        'storyPoints', p_story_points, 'phaseId', p_phase, 'sprintId', NULL, 'archived', false)));
  notification_id := CASE WHEN p_assignee IS NOT NULL AND p_assignee <> actor THEN gen_random_uuid() END;
  INSERT INTO spark.outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, processed_at)
    VALUES (project.tenant_id, 'issue.created', 'issue', new_issue, 1,
      jsonb_build_object('issueId', new_issue, 'projectId', project.id, 'actorUserId', actor, 'assigneeUserId', p_assignee)
        || CASE WHEN notification_id IS NOT NULL THEN jsonb_build_object('version', 1, 'notificationId', notification_id) ELSE '{}'::jsonb END,
      CASE WHEN notification_id IS NULL THEN now() END)
    RETURNING id INTO outbox_id;
  IF notification_id IS NOT NULL THEN
    SELECT btrim(u.display_name) INTO actor_name FROM spark.users u WHERE u.id = actor;
    INSERT INTO spark.notifications (id, tenant_id, recipient_user_id, outbox_event_id, kind, title, resource_type, resource_id)
      VALUES (notification_id, project.tenant_id, p_assignee, outbox_id, 'issue_assigned',
        left(actor_name || ' assigned you ' || project.key || '-' || new_number || ': ' || clean_title, 500), 'issue', new_issue);
  END IF;
  IF idempotency_id IS NOT NULL THEN
    UPDATE spark.idempotency_requests r SET state = 'completed', resource_id = new_issue, response_status = 201, expires_at = now() + interval '24 hours'
      WHERE r.id = idempotency_id;
  END IF;
  RETURN QUERY SELECT 'ok'::text, new_issue, 1;
END $$;
--> statement-breakpoint
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
  notification_id uuid;
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
-- What the task-assigned email needs, nothing more. status is 'skipped' when the email must not go out:
-- the recipient is no longer an active user and active member of an active workspace, no longer the
-- issue's assignee, the issue or its project is archived, the recipient has no primary email, an email
-- delivery is already recorded for the notification, or the recipient turned off (task_assigned, email)
-- in notification_preferences (no row means enabled). A skipped row carries no details. Zero rows for an
-- unknown notification or one of another kind.
CREATE FUNCTION spark.worker_task_assigned_email(p_notification uuid)
RETURNS TABLE(status text, email text, recipient_name text, actor_name text, workspace_name text, workspace_slug text,
  project_key text, project_name text, issue_number bigint, issue_title text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN d.deliverable THEN 'pending' ELSE 'skipped' END,
    CASE WHEN d.deliverable THEN d.email END, CASE WHEN d.deliverable THEN d.recipient_name END,
    CASE WHEN d.deliverable THEN d.actor_name END, CASE WHEN d.deliverable THEN d.workspace_name END,
    CASE WHEN d.deliverable THEN d.workspace_slug END, CASE WHEN d.deliverable THEN d.project_key END,
    CASE WHEN d.deliverable THEN d.project_name END, CASE WHEN d.deliverable THEN d.issue_number END,
    CASE WHEN d.deliverable THEN d.issue_title END
  FROM (
    SELECT e.normalized_email IS NOT NULL
        AND r.status = 'active' AND r.deleted_at IS NULL
        AND w.status = 'active' AND w.archived_at IS NULL
        AND p.archived_at IS NULL AND i.archived_at IS NULL
        AND i.assignee_user_id IS NOT DISTINCT FROM n.recipient_user_id
        AND EXISTS (SELECT 1 FROM spark.workspace_memberships m
          WHERE m.tenant_id = n.tenant_id AND m.user_id = n.recipient_user_id AND m.status = 'active')
        AND NOT EXISTS (SELECT 1 FROM spark.notification_deliveries nd
          WHERE nd.tenant_id = n.tenant_id AND nd.notification_id = n.id AND nd.channel = 'email')
        AND NOT EXISTS (SELECT 1 FROM spark.notification_preferences np
          WHERE np.user_id = n.recipient_user_id AND np.kind = 'task_assigned' AND np.channel = 'email' AND NOT np.enabled) AS deliverable,
      e.normalized_email AS email, btrim(r.display_name) AS recipient_name, btrim(a.display_name) AS actor_name,
      w.name AS workspace_name, w.slug AS workspace_slug, p.key AS project_key, p.name AS project_name,
      i.number AS issue_number, i.title AS issue_title
    FROM spark.notifications n
    JOIN spark.outbox_events o ON o.tenant_id = n.tenant_id AND o.id = n.outbox_event_id
    JOIN spark.issue_events ev ON ev.tenant_id = o.tenant_id AND ev.issue_id = o.aggregate_id AND ev.to_version = o.aggregate_version
    JOIN spark.users a ON a.id = ev.actor_user_id
    JOIN spark.issues i ON i.tenant_id = n.tenant_id AND i.id = n.resource_id
    JOIN spark.projects p ON p.tenant_id = i.tenant_id AND p.id = i.project_id
    JOIN spark.workspaces w ON w.id = n.tenant_id
    JOIN spark.users r ON r.id = n.recipient_user_id
    LEFT JOIN spark.user_emails e ON e.user_id = r.id AND e.is_primary
    WHERE n.id = p_notification AND n.kind = 'issue_assigned' AND n.resource_type = 'issue' AND o.aggregate_type = 'issue'
  ) d;
$$;
--> statement-breakpoint
-- Records the outcome of a task-assigned email: 'sent' (with delivered_at) or 'suppressed'. Inserts at most
-- one email delivery per notification; false when one already existed or the notification is unknown or
-- not an issue_assigned notification.
CREATE FUNCTION spark.worker_record_email_delivery(p_notification uuid, p_status text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target_tenant uuid; recorded uuid;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('sent','suppressed') THEN
    RAISE EXCEPTION 'Invalid delivery status' USING ERRCODE = '22023';
  END IF;
  SELECT n.tenant_id INTO target_tenant FROM spark.notifications n WHERE n.id = p_notification AND n.kind = 'issue_assigned';
  IF target_tenant IS NULL THEN RETURN false; END IF;
  INSERT INTO spark.notification_deliveries (tenant_id, notification_id, channel, status, delivered_at)
    VALUES (target_tenant, p_notification, 'email', p_status, CASE WHEN p_status = 'sent' THEN now() END)
    ON CONFLICT (tenant_id, notification_id, channel) DO NOTHING RETURNING id INTO recorded;
  RETURN recorded IS NOT NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.ws_create_issue(uuid,text,text,text,text,uuid,uuid,numeric,date,uuid,text,bytea),
  spark.ws_update_issue(uuid,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION spark.ws_create_issue(uuid,text,text,text,text,uuid,uuid,numeric,date,uuid,text,bytea),
  spark.ws_update_issue(uuid,integer,jsonb) TO spark_app;
REVOKE ALL ON FUNCTION spark.worker_task_assigned_email(uuid), spark.worker_record_email_delivery(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION spark.worker_task_assigned_email(uuid), spark.worker_record_email_delivery(uuid,text) FROM spark_app;
GRANT EXECUTE ON FUNCTION spark.worker_task_assigned_email(uuid), spark.worker_record_email_delivery(uuid,text) TO spark_worker;
