-- Notification inbox reads and email preferences (M7). The runtime role has no grants on notifications or
-- notification_preferences: the inbox and the preference document are read and written only through the
-- six spark.ws_* definer functions below. Each derives the actor from the live session
-- (spark.require_session_actor) and filters explicitly, because a definer function bypasses row security.
-- Visibility: a notification is visible to the actor iff recipient_user_id = actor AND tenant_id is one of
-- the actor's active workspaces (spark.session_workspace_ids), so leaving a workspace hides its
-- notifications (they are kept) and rejoining shows them again. Ids that are unknown, belong to another
-- user or sit in a workspace the actor left all answer not_found.
-- Preferences: the three email kinds task_assigned, due_reminders and weekly_digest are enabled when no row
-- exists. The document also carries users.timezone, which reminders and the digest run in.
CREATE INDEX notifications_recipient_created_idx ON spark.notifications (recipient_user_id, created_at DESC, id DESC);
--> statement-breakpoint
-- Newest first by (created_at, id). The keyset cursor is the pair of the last row returned. link is computed
-- from current data and is NULL when the target no longer exists or is archived.
CREATE FUNCTION spark.ws_list_notifications(p_unread_only boolean, p_before_created timestamptz, p_before_id uuid, p_limit integer)
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
    END,
    n.created_at, n.read_at
  FROM spark.notifications n JOIN spark.workspaces w ON w.id = n.tenant_id
  WHERE n.recipient_user_id = actor AND n.tenant_id = ANY(spark.session_workspace_ids())
    AND (NOT coalesce(p_unread_only, false) OR n.read_at IS NULL)
    AND (p_before_created IS NULL OR (n.created_at, n.id) < (p_before_created, p_before_id))
  ORDER BY n.created_at DESC, n.id DESC
  LIMIT p_limit;
END $$;
--> statement-breakpoint
-- The badge count, capped at 100 (the interface shows "99+").
CREATE FUNCTION spark.ws_unread_notification_count() RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_session_actor(); total integer;
BEGIN
  SELECT count(*)::integer INTO total FROM (
    SELECT 1 FROM spark.notifications n
    WHERE n.recipient_user_id = actor AND n.tenant_id = ANY(spark.session_workspace_ids()) AND n.read_at IS NULL
    LIMIT 100) unread;
  RETURN total;
END $$;
--> statement-breakpoint
-- Marks one visible notification read. read_at is set only while it is NULL, so a repeat keeps the first time.
CREATE FUNCTION spark.ws_mark_notification_read(p_notification uuid)
RETURNS TABLE(outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_session_actor();
BEGIN
  IF p_notification IS NULL OR NOT EXISTS (SELECT 1 FROM spark.notifications n WHERE n.id = p_notification
      AND n.recipient_user_id = actor AND n.tenant_id = ANY(spark.session_workspace_ids())) THEN
    RETURN QUERY SELECT 'not_found'::text; RETURN;
  END IF;
  UPDATE spark.notifications n SET read_at = now()
    WHERE n.id = p_notification AND n.recipient_user_id = actor AND n.tenant_id = ANY(spark.session_workspace_ids()) AND n.read_at IS NULL;
  RETURN QUERY SELECT 'ok'::text;
END $$;
--> statement-breakpoint
-- Marks the actor's visible unread notifications created at or before the instant; a row that arrives later stays unread.
CREATE FUNCTION spark.ws_mark_notifications_read(p_before timestamptz)
RETURNS TABLE(updated integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_session_actor(); changed integer;
BEGIN
  IF p_before IS NULL THEN
    RAISE EXCEPTION 'Invalid notification before' USING ERRCODE = '22023';
  END IF;
  UPDATE spark.notifications n SET read_at = now()
    WHERE n.recipient_user_id = actor AND n.tenant_id = ANY(spark.session_workspace_ids()) AND n.read_at IS NULL AND n.created_at <= p_before;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN QUERY SELECT changed;
END $$;
--> statement-breakpoint
CREATE FUNCTION spark.ws_get_notification_preferences()
RETURNS TABLE(task_assigned boolean, due_reminders boolean, weekly_digest boolean, timezone text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor();
BEGIN
  RETURN QUERY
  SELECT coalesce((SELECT np.enabled FROM spark.notification_preferences np WHERE np.user_id = actor AND np.kind = 'task_assigned' AND np.channel = 'email'), true),
    coalesce((SELECT np.enabled FROM spark.notification_preferences np WHERE np.user_id = actor AND np.kind = 'due_reminders' AND np.channel = 'email'), true),
    coalesce((SELECT np.enabled FROM spark.notification_preferences np WHERE np.user_id = actor AND np.kind = 'weekly_digest' AND np.channel = 'email'), true),
    u.timezone
  FROM spark.users u WHERE u.id = actor;
END $$;
--> statement-breakpoint
-- Stores the three email switches and the time zone together. users has no version column; the
-- maintain_record trigger only refreshes updated_at and the valid_timezone trigger agrees with
-- spark.valid_timezone, which is checked first so the caller gets a 22023.
CREATE FUNCTION spark.ws_set_notification_preferences(p_task_assigned boolean, p_due_reminders boolean, p_weekly_digest boolean, p_timezone text)
RETURNS TABLE(outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_session_actor();
BEGIN
  IF p_task_assigned IS NULL OR p_due_reminders IS NULL OR p_weekly_digest IS NULL OR p_timezone IS NULL THEN
    RAISE EXCEPTION 'Invalid notification preferences' USING ERRCODE = '22023';
  END IF;
  IF NOT spark.valid_timezone(p_timezone) THEN
    RAISE EXCEPTION 'Invalid timezone' USING ERRCODE = '22023';
  END IF;
  INSERT INTO spark.notification_preferences (user_id, kind, channel, enabled)
    VALUES (actor, 'task_assigned', 'email', p_task_assigned), (actor, 'due_reminders', 'email', p_due_reminders), (actor, 'weekly_digest', 'email', p_weekly_digest)
    ON CONFLICT (user_id, kind, channel) DO UPDATE SET enabled = EXCLUDED.enabled WHERE spark.notification_preferences.enabled IS DISTINCT FROM EXCLUDED.enabled;
  UPDATE spark.users u SET timezone = p_timezone WHERE u.id = actor AND u.timezone IS DISTINCT FROM p_timezone;
  RETURN QUERY SELECT 'ok'::text;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.ws_list_notifications(boolean,timestamptz,uuid,integer), spark.ws_unread_notification_count(),
  spark.ws_mark_notification_read(uuid), spark.ws_mark_notifications_read(timestamptz), spark.ws_get_notification_preferences(),
  spark.ws_set_notification_preferences(boolean,boolean,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION spark.ws_list_notifications(boolean,timestamptz,uuid,integer), spark.ws_unread_notification_count(),
  spark.ws_mark_notification_read(uuid), spark.ws_mark_notifications_read(timestamptz), spark.ws_get_notification_preferences(),
  spark.ws_set_notification_preferences(boolean,boolean,boolean,text) TO spark_app;
