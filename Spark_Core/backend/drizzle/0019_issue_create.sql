-- Issue creation (M3). The runtime role still has no INSERT, UPDATE or DELETE grant on issues: they are
-- created only through spark.ws_create_issue, which derives the actor from the live session, returns a
-- closed set of outcomes and writes the issue, its issue.created history row, its outbox row, an
-- optional issue_assigned notification and the idempotency record in one transaction.
-- Lock order for issue writes: workspace row FOR SHARE (spark.lock_workspace_member), project row
-- FOR UPDATE, board, statuses, then issues by id. The workspace row is never taken FOR UPDATE here, so
-- issue writes in different projects of one workspace do not serialize, while membership changes
-- (which lock the workspace row FOR UPDATE) still exclude concurrent issue writes.
ALTER TABLE spark.notifications DROP CONSTRAINT notifications_kind_allowed;
ALTER TABLE spark.notifications ADD CONSTRAINT notifications_kind_allowed CHECK (kind IN ('invitation_accepted','issue_assigned'));
-- Analytics reads issue history per project and time window.
CREATE INDEX issue_events_tenant_id_project_id_created_at_issue_id_read ON spark.issue_events (tenant_id, project_id, created_at, issue_id);
--> statement-breakpoint
-- True only for the live session's user. Lets row policies compare a user column with the session
-- actor without granting spark.session_actor() itself to the runtime role.
CREATE FUNCTION spark.is_session_user(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE(p_user = spark.session_actor(), false);
$$;
--> statement-breakpoint
-- Internal: the actor's active role in an active workspace, read again after locking the workspace row
-- FOR SHARE so membership changes (FOR UPDATE) serialize with issue writes while issue writes do not
-- serialize with each other. NULL when the actor is not a member; a non-member never takes the lock.
CREATE FUNCTION spark.lock_workspace_member(p_workspace uuid, p_actor uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor_role text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM spark.workspace_memberships m JOIN spark.workspaces w ON w.id = m.tenant_id
      WHERE m.tenant_id = p_workspace AND m.user_id = p_actor AND m.status = 'active' AND w.status = 'active' AND w.archived_at IS NULL) THEN
    RETURN NULL;
  END IF;
  PERFORM 1 FROM spark.workspaces w WHERE w.id = p_workspace FOR SHARE;
  SELECT m.role INTO actor_role FROM spark.workspace_memberships m JOIN spark.workspaces w ON w.id = m.tenant_id
    WHERE m.tenant_id = p_workspace AND m.user_id = p_actor AND m.status = 'active' AND w.status = 'active' AND w.archived_at IS NULL;
  RETURN actor_role;
END $$;
--> statement-breakpoint
-- Every active member may create issues in a non-archived project of the workspace. Non-members and
-- unknown or archived projects get not_found. Input violations raise 22023 with a fixed message; they
-- are checked after the membership check, so they reveal nothing to non-members.
-- Idempotency (when a key is given): the key is scoped to (workspace, actor, 'issue.create'). An unexpired
-- row with the same request hash for an issue of this project replays the first result; any other
-- unexpired row is a conflict. The row is inserted before the checks so a concurrent request with the
-- same key waits for this transaction, and it is removed again when the create is refused.
CREATE FUNCTION spark.ws_create_issue(p_project uuid, p_title text, p_description text, p_type text, p_priority text, p_status uuid,
  p_assignee uuid, p_story_points numeric, p_due date, p_phase uuid, p_idempotency_key text, p_request_hash bytea)
RETURNS TABLE(outcome text, issue_id uuid, issue_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); clean_title text := btrim(p_title);
  clean_description text := nullif(btrim(p_description), ''); issue_type text := coalesce(p_type, 'task');
  issue_priority text := coalesce(p_priority, 'medium'); target_tenant uuid; project spark.projects%ROWTYPE;
  target_status uuid; status_category text; capacity integer; idempotency_id uuid; existing spark.idempotency_requests%ROWTYPE;
  existing_version integer; new_issue uuid := gen_random_uuid(); new_number bigint; new_position numeric(20,6);
  outbox_id uuid; actor_name text;
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
  INSERT INTO spark.outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, processed_at)
    VALUES (project.tenant_id, 'issue.created', 'issue', new_issue, 1,
      jsonb_build_object('issueId', new_issue, 'projectId', project.id, 'actorUserId', actor, 'assigneeUserId', p_assignee), now())
    RETURNING id INTO outbox_id;
  IF p_assignee IS NOT NULL AND p_assignee <> actor THEN
    SELECT btrim(u.display_name) INTO actor_name FROM spark.users u WHERE u.id = actor;
    INSERT INTO spark.notifications (tenant_id, recipient_user_id, outbox_event_id, kind, title, resource_type, resource_id)
      VALUES (project.tenant_id, p_assignee, outbox_id, 'issue_assigned',
        left(actor_name || ' assigned you ' || project.key || '-' || new_number || ': ' || clean_title, 500), 'issue', new_issue);
  END IF;
  IF idempotency_id IS NOT NULL THEN
    UPDATE spark.idempotency_requests r SET state = 'completed', resource_id = new_issue, response_status = 201, expires_at = now() + interval '24 hours'
      WHERE r.id = idempotency_id;
  END IF;
  RETURN QUERY SELECT 'ok'::text, new_issue, 1;
END $$;
--> statement-breakpoint
-- Unchanged from 0015 except that the removed member's project leads in this workspace are cleared in
-- the same transaction (each such project's settings_version advances, as for any lead change).
CREATE OR REPLACE FUNCTION spark.ws_remove_member(p_workspace uuid, p_user uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_session_actor(); actor_role text; target spark.workspace_memberships%ROWTYPE;
  is_self boolean := p_user IS NOT DISTINCT FROM actor;
BEGIN
  actor_role := spark.lock_workspace_role(p_workspace, actor);
  IF actor_role IS NULL THEN RETURN 'not_found'; END IF;
  IF NOT is_self AND actor_role = 'member' THEN RETURN 'forbidden'; END IF;
  SELECT * INTO target FROM spark.workspace_memberships m
    WHERE m.tenant_id = p_workspace AND m.user_id = p_user AND m.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF NOT is_self AND actor_role = 'admin' AND target.role <> 'member' THEN RETURN 'forbidden'; END IF;
  IF target.role = 'owner' AND (SELECT count(*) FROM spark.workspace_memberships m
      WHERE m.tenant_id = p_workspace AND m.role = 'owner' AND m.status = 'active') <= 1 THEN
    RETURN 'last_owner';
  END IF;
  UPDATE spark.workspace_memberships m SET status = 'left', left_at = now() WHERE m.id = target.id;
  UPDATE spark.projects p SET lead_user_id = NULL, settings_version = p.settings_version + 1
    WHERE p.tenant_id = p_workspace AND p.lead_user_id = target.user_id;
  PERFORM spark.record_workspace_audit(p_workspace, actor, CASE WHEN is_self THEN 'member.left' ELSE 'member.removed' END,
    'membership', target.id, jsonb_build_object('userId', target.user_id, 'role', target.role));
  RETURN 'ok';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.is_session_user(uuid), spark.lock_workspace_member(uuid,uuid),
  spark.ws_create_issue(uuid,text,text,text,text,uuid,uuid,numeric,date,uuid,text,bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION spark.lock_workspace_member(uuid,uuid) FROM spark_app;
GRANT EXECUTE ON FUNCTION spark.is_session_user(uuid), spark.ws_create_issue(uuid,text,text,text,text,uuid,uuid,numeric,date,uuid,text,bytea) TO spark_app;
--> statement-breakpoint
-- Recipients read their own notifications while they are active members of the notification's workspace.
CREATE POLICY recipient_read ON spark.notifications FOR SELECT TO spark_app
  USING (spark.is_session_user(recipient_user_id) AND tenant_id = ANY ((SELECT spark.session_workspace_ids())::uuid[]));
GRANT SELECT ON spark.notifications TO spark_app;
