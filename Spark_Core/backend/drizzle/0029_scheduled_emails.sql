-- Scheduled emails (M7): the daily due-task reminder and the Monday weekly digest. The ledger spark.scheduled_emails
-- holds one row per (user, job, workspace, local period) so a period is emailed at most once however many workers
-- poll, however often the time zone changes and whatever the clock does. Tenant-less for the reminder (one email
-- across workspaces), per workspace for the digest. There are no runtime grants on the table: the worker
-- (spark_worker, no table privileges) enumerates, claims, reads and settles only through the spark.worker_*
-- definer functions below, like the outbox in 0016 and the assignment mail in 0021. Time is always passed in
-- (p_now) and compared with each user's own users.timezone, so nothing here reads the wall clock for scheduling.
-- Neither job writes notifications: they only email. Recipients are the account's primary email address, which is
-- unverified until Phase 3 (the same stance as the assignment mail in 0021).
CREATE TABLE spark.scheduled_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  user_id uuid NOT NULL,
  tenant_id uuid,
  job text NOT NULL,
  period date NOT NULL,
  status text DEFAULT 'pending' NOT NULL,
  attempts integer DEFAULT 0 NOT NULL,
  locked_until timestamptz,
  lock_token uuid,
  last_error_code text,
  sent_at timestamptz,
  CONSTRAINT scheduled_emails_job_allowed CHECK (job IN ('due_reminders','weekly_digest')),
  CONSTRAINT scheduled_emails_status_allowed CHECK (status IN ('pending','sent','suppressed','failed')),
  CONSTRAINT scheduled_emails_attempts_nonnegative CHECK (attempts >= 0),
  CONSTRAINT scheduled_emails_tenant_by_job CHECK ((job = 'due_reminders') = (tenant_id IS NULL)),
  CONSTRAINT scheduled_emails_error_code_allowed CHECK (last_error_code IS NULL OR last_error_code IN
    ('smtp_error','template_error','not_found','invalid_payload','handler_error','expired','lease_expired','nothing_due')),
  CONSTRAINT scheduled_emails_user_fk FOREIGN KEY (user_id) REFERENCES spark.users (id) ON DELETE RESTRICT,
  CONSTRAINT scheduled_emails_tenant_fk FOREIGN KEY (tenant_id) REFERENCES spark.workspaces (id) ON DELETE RESTRICT
);
--> statement-breakpoint
-- The period is a local date, so a time-zone change can only repeat a period by landing on the same date, which
-- this index turns into a conflict. NULL tenants (reminders) are coalesced so they collide too.
CREATE UNIQUE INDEX scheduled_emails_period_key ON spark.scheduled_emails (user_id, job, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), period);
CREATE INDEX scheduled_emails_user_fk_idx ON spark.scheduled_emails (user_id);
CREATE INDEX scheduled_emails_tenant_fk_idx ON spark.scheduled_emails (tenant_id);
CREATE INDEX scheduled_emails_pending_idx ON spark.scheduled_emails (job, period, created_at, id) WHERE status = 'pending';
--> statement-breakpoint
ALTER TABLE spark.scheduled_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE spark.scheduled_emails FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_maintenance ON spark.scheduled_emails TO spark_owner USING (true) WITH CHECK (true);
REVOKE ALL ON spark.scheduled_emails FROM PUBLIC;
CREATE TRIGGER maintain_record BEFORE UPDATE ON spark.scheduled_emails FOR EACH ROW EXECUTE FUNCTION spark.maintain_record();
--> statement-breakpoint
-- The open-task rule shared by enumeration and the send-time re-read: an active membership in an active
-- workspace, a non-archived project and issue, assigned to the user, status category not done, due on or before
-- the day after p_local_date (due today or tomorrow, or overdue). An internal helper: SECURITY INVOKER, called
-- from the definer functions below, executable by nobody else.
CREATE FUNCTION spark.scheduled_open_tasks(p_user uuid, p_local_date date)
RETURNS TABLE(tenant_id uuid, workspace_name text, workspace_slug text, project_key text, issue_number bigint, title text, due_date date)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT i.tenant_id, w.name, w.slug, p.key, i.number, i.title, i.due_date
  FROM spark.issues i
  JOIN spark.issue_statuses st ON st.tenant_id = i.tenant_id AND st.project_id = i.project_id AND st.id = i.status_id
  JOIN spark.projects p ON p.tenant_id = i.tenant_id AND p.id = i.project_id
  JOIN spark.workspaces w ON w.id = i.tenant_id
  JOIN spark.workspace_memberships m ON m.tenant_id = i.tenant_id AND m.user_id = p_user
  WHERE i.assignee_user_id = p_user AND i.archived_at IS NULL AND st.category <> 'done'
    AND i.due_date IS NOT NULL AND i.due_date <= p_local_date + 1
    AND p.archived_at IS NULL AND w.status = 'active' AND w.archived_at IS NULL AND m.status = 'active';
$$;
--> statement-breakpoint
-- Enumerates what is due at p_now, then leases up to p_limit pending rows of the job.
--   * Enumeration runs under pg_try_advisory_xact_lock(7301, hashtext(p_job)) (class 7301 = scheduled jobs): one
--     enumerator per job. Whoever does not get the lock skips enumeration only and still claims rows that are
--     already pending. The lock lasts until the calling transaction ends.
--   * Local time is p_now AT TIME ZONE users.timezone. Reminder: at or after 08:00 local, period = the local date,
--     for an active user with a primary email and the preference not turned off, who has an open task (see
--     scheduled_open_tasks). Digest: only when the local day is Monday and at or after 08:00, period = that
--     Monday, one row per active membership in an active workspace with a non-archived project. No preference
--     row means enabled. ON CONFLICT DO NOTHING on the unique period key makes every pass idempotent.
--   * A pending row whose period is before the user's current local date (and whose lease is over) becomes
--     suppressed ('expired'): a run that missed its day never sends late. A pending row with five attempts and
--     an expired lease (a worker that died every time) becomes failed ('lease_expired').
--   * Claimed rows: pending, period = the user's current local date, local time at or after 08:00, no live
--     lease (locked_until null or not after p_now; a retry stores its retry time there), attempts below five.
--     Like the outbox the lease is a token with an expiry, here measured against p_now, and attempts + 1.
-- This function takes the instant as a parameter so tests can pin it, which makes it unsafe for a worker (any
-- p_now would pre-create or burn future periods): nobody but the owner may execute it. The worker calls the
-- wrapper worker_claim_scheduled_emails below, which always passes now().
CREATE FUNCTION spark.scheduled_emails_claim_at(p_job text, p_now timestamptz, p_lock_token uuid, p_limit integer, p_lease_seconds integer)
RETURNS TABLE(id uuid, user_id uuid, tenant_id uuid, period date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_job IS NULL OR p_job NOT IN ('due_reminders','weekly_digest') THEN RAISE EXCEPTION 'Invalid scheduled job' USING ERRCODE = '22023'; END IF;
  IF p_now IS NULL THEN RAISE EXCEPTION 'Invalid claim time' USING ERRCODE = '22023'; END IF;
  IF p_lock_token IS NULL THEN RAISE EXCEPTION 'Invalid lock token' USING ERRCODE = '22023'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Invalid claim limit' USING ERRCODE = '22023'; END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 10 AND 600 THEN
    RAISE EXCEPTION 'Invalid lease duration' USING ERRCODE = '22023';
  END IF;
  UPDATE spark.scheduled_emails s
    SET status = 'suppressed', last_error_code = 'expired', locked_until = NULL, lock_token = NULL
    FROM spark.users u
    WHERE u.id = s.user_id AND s.job = p_job AND s.status = 'pending' AND (s.locked_until IS NULL OR s.locked_until <= p_now)
      AND s.period < (p_now AT TIME ZONE u.timezone)::date;
  UPDATE spark.scheduled_emails s
    SET status = 'failed', last_error_code = coalesce(s.last_error_code, 'lease_expired'), locked_until = NULL, lock_token = NULL
    WHERE s.job = p_job AND s.status = 'pending' AND s.attempts >= 5 AND (s.locked_until IS NULL OR s.locked_until <= p_now);

  IF NOT pg_try_advisory_xact_lock(7301, hashtext(p_job)) THEN
    NULL; -- another enumerator holds the job lock: skip enumeration, still claim what is pending
  ELSIF p_job = 'due_reminders' THEN
    INSERT INTO spark.scheduled_emails (user_id, tenant_id, job, period)
    SELECT u.id, NULL, 'due_reminders', (p_now AT TIME ZONE u.timezone)::date
    FROM spark.users u
    WHERE u.status = 'active' AND u.deleted_at IS NULL AND (p_now AT TIME ZONE u.timezone)::time >= time '08:00'
      AND NOT EXISTS (SELECT 1 FROM spark.scheduled_emails s WHERE s.user_id = u.id AND s.job = 'due_reminders'
        AND s.tenant_id IS NULL AND s.period = (p_now AT TIME ZONE u.timezone)::date)
      AND EXISTS (SELECT 1 FROM spark.user_emails e WHERE e.user_id = u.id AND e.is_primary)
      AND NOT EXISTS (SELECT 1 FROM spark.notification_preferences np
        WHERE np.user_id = u.id AND np.kind = 'due_reminders' AND np.channel = 'email' AND NOT np.enabled)
      AND EXISTS (SELECT 1 FROM spark.scheduled_open_tasks(u.id, (p_now AT TIME ZONE u.timezone)::date))
    ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO spark.scheduled_emails (user_id, tenant_id, job, period)
    SELECT u.id, m.tenant_id, 'weekly_digest', (p_now AT TIME ZONE u.timezone)::date
    FROM spark.users u
    JOIN spark.workspace_memberships m ON m.user_id = u.id AND m.status = 'active'
    JOIN spark.workspaces w ON w.id = m.tenant_id AND w.status = 'active' AND w.archived_at IS NULL
    WHERE u.status = 'active' AND u.deleted_at IS NULL
      AND extract(isodow FROM (p_now AT TIME ZONE u.timezone)) = 1 AND (p_now AT TIME ZONE u.timezone)::time >= time '08:00'
      AND NOT EXISTS (SELECT 1 FROM spark.scheduled_emails s WHERE s.user_id = u.id AND s.job = 'weekly_digest'
        AND s.tenant_id = m.tenant_id AND s.period = (p_now AT TIME ZONE u.timezone)::date)
      AND EXISTS (SELECT 1 FROM spark.user_emails e WHERE e.user_id = u.id AND e.is_primary)
      AND NOT EXISTS (SELECT 1 FROM spark.notification_preferences np
        WHERE np.user_id = u.id AND np.kind = 'weekly_digest' AND np.channel = 'email' AND NOT np.enabled)
      AND EXISTS (SELECT 1 FROM spark.projects p WHERE p.tenant_id = m.tenant_id AND p.archived_at IS NULL)
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN QUERY
  WITH due AS (
    SELECT s.id FROM spark.scheduled_emails s
    JOIN spark.users u ON u.id = s.user_id
    WHERE s.job = p_job AND s.status = 'pending' AND s.attempts < 5 AND (s.locked_until IS NULL OR s.locked_until <= p_now)
      AND s.period = (p_now AT TIME ZONE u.timezone)::date AND (p_now AT TIME ZONE u.timezone)::time >= time '08:00'
    ORDER BY s.period, s.created_at, s.id
    LIMIT p_limit
    FOR UPDATE OF s SKIP LOCKED
  ), claimed AS (
    UPDATE spark.scheduled_emails s
    SET locked_until = p_now + make_interval(secs => p_lease_seconds), lock_token = p_lock_token, attempts = s.attempts + 1
    FROM due WHERE s.id = due.id
    RETURNING s.id, s.user_id, s.tenant_id, s.period, s.created_at
  )
  SELECT c.id, c.user_id, c.tenant_id, c.period FROM claimed c ORDER BY c.period, c.created_at, c.id;
END $$;
--> statement-breakpoint
-- The worker's entry point: the database clock decides what is due.
CREATE FUNCTION spark.worker_claim_scheduled_emails(p_job text, p_lock_token uuid, p_limit integer, p_lease_seconds integer)
RETURNS TABLE(id uuid, user_id uuid, tenant_id uuid, period date)
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT c.id, c.user_id, c.tenant_id, c.period FROM spark.scheduled_emails_claim_at(p_job, now(), p_lock_token, p_limit, p_lease_seconds) c;
$$;
--> statement-breakpoint
-- What one reminder email needs, re-evaluated at send time against the row's period, and only for the worker
-- that holds the lease (p_lock_token = the row's lock_token and the row is pending): status 'pending' with one
-- row per task (at most 20, due date then key; total = how many in all), or a single 'skipped' row with NULL
-- details when the row is not a pending reminder held under that token (wrong, missing or lost lease), the user is gone, suspended or without a primary email, the
-- preference was turned off, or nothing is due any more. task_overdue = due before the period's local date.
CREATE FUNCTION spark.worker_due_reminder_email(p_id uuid, p_lock_token uuid)
RETURNS TABLE(status text, email text, recipient_name text, total integer, task_workspace text, task_workspace_slug text,
  task_key text, task_title text, task_due date, task_overdue boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE target spark.scheduled_emails%ROWTYPE; recipient_email text; recipient text; open_count integer;
BEGIN
  SELECT * INTO target FROM spark.scheduled_emails s WHERE s.id = p_id AND s.job = 'due_reminders' AND s.status = 'pending' AND s.lock_token = p_lock_token;
  IF FOUND THEN
    SELECT e.normalized_email, btrim(u.display_name) INTO recipient_email, recipient
    FROM spark.users u JOIN spark.user_emails e ON e.user_id = u.id AND e.is_primary
    WHERE u.id = target.user_id AND u.status = 'active' AND u.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM spark.notification_preferences np
        WHERE np.user_id = u.id AND np.kind = 'due_reminders' AND np.channel = 'email' AND NOT np.enabled);
    IF recipient_email IS NOT NULL THEN
      SELECT count(*)::integer INTO open_count FROM spark.scheduled_open_tasks(target.user_id, target.period);
      IF open_count > 0 THEN
        RETURN QUERY
        SELECT 'pending'::text, recipient_email, recipient, open_count, t.workspace_name, t.workspace_slug,
          t.project_key || '-' || t.issue_number, t.title, t.due_date, t.due_date < target.period
        FROM spark.scheduled_open_tasks(target.user_id, target.period) t
        ORDER BY t.due_date, t.project_key, t.issue_number, t.tenant_id
        LIMIT 20;
        RETURN;
      END IF;
    END IF;
  END IF;
  RETURN QUERY SELECT 'skipped'::text, NULL::text, NULL::text, NULL::integer, NULL::text, NULL::text, NULL::text, NULL::text, NULL::date, NULL::boolean;
END $$;
--> statement-breakpoint
-- What one workspace digest needs, as one row per line, re-evaluated at send time. Sections:
--   project  one per non-archived project (ordered by key): value NULL, extra = { done, total, unit, windowStart,
--            windowEnd, activeSprintName }. Scope and unit follow the M5 overview rule: Scrum scores the active
--            sprint (the whole project when none is active), Kanban and Waterfall the whole project; the unit is
--            points when at least 80% of the issues in scope are estimated, else count; the window is the active
--            sprint's UTC dates (Scrum) or the project's start_date and target_date (both needed), else NULL. The
--            caller derives planPercent and planStatus from the window and the period.
--   member   done transitions per member over the seven local days before the period's Monday (previous Monday
--            00:00 inclusive to this Monday 00:00 exclusive, in the user's zone), so consecutive digests neither
--            overlap nor leave gaps. A transition is an issue_events snapshot that is done and not archived while
--            the issue's previous snapshot was not done (insight_flow's rule). The member is the snapshot's
--            assigneeUserId (the completing actor is not part of the snapshot); unassigned ones and members who
--            are no longer active in the workspace (or whose account is deleted) are not listed.
--            label = member name, value = count; most first.
--   at_risk  open issues of the workspace (non-archived projects and issues, status not done) due from the period
--            through three days later; overdue: due before the period. At most 10 each, due date then key
--            order; label = 'KEY-n title', extra = { due, total } with total = all such issues.
-- A single 'skipped' row with NULL details when the row is not a pending digest held under p_lock_token, the user is gone or without a
-- primary email, the preference is off, the membership or workspace is no longer active, or no project is left.
CREATE FUNCTION spark.worker_weekly_digest_email(p_id uuid, p_lock_token uuid)
RETURNS TABLE(status text, email text, recipient_name text, workspace_name text, workspace_slug text, section text,
  project_key text, project_name text, methodology text, label text, value numeric, extra jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE target spark.scheduled_emails%ROWTYPE; recipient_email text; recipient text; zone text;
  space_name text; space_slug text; window_start timestamptz; window_end timestamptz;
BEGIN
  SELECT * INTO target FROM spark.scheduled_emails s WHERE s.id = p_id AND s.job = 'weekly_digest' AND s.status = 'pending' AND s.tenant_id IS NOT NULL
    AND s.lock_token = p_lock_token;
  IF FOUND THEN
    SELECT e.normalized_email, btrim(u.display_name), u.timezone, w.name, w.slug INTO recipient_email, recipient, zone, space_name, space_slug
    FROM spark.users u
    JOIN spark.user_emails e ON e.user_id = u.id AND e.is_primary
    JOIN spark.workspace_memberships m ON m.user_id = u.id AND m.tenant_id = target.tenant_id AND m.status = 'active'
    JOIN spark.workspaces w ON w.id = m.tenant_id AND w.status = 'active' AND w.archived_at IS NULL
    WHERE u.id = target.user_id AND u.status = 'active' AND u.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM spark.notification_preferences np
        WHERE np.user_id = u.id AND np.kind = 'weekly_digest' AND np.channel = 'email' AND NOT np.enabled)
      AND EXISTS (SELECT 1 FROM spark.projects p WHERE p.tenant_id = target.tenant_id AND p.archived_at IS NULL);
    IF recipient_email IS NOT NULL THEN
      window_end := target.period::timestamp AT TIME ZONE zone;
      window_start := (target.period - 7)::timestamp AT TIME ZONE zone;
      RETURN QUERY
      WITH projects AS (
        SELECT p.id, p.key, p.name, p.methodology, p.start_date, p.target_date
        FROM spark.projects p WHERE p.tenant_id = target.tenant_id AND p.archived_at IS NULL
      ), sprint AS (
        SELECT pr.id AS project_id, sp.id AS sprint_id, sp.name, (sp.starts_at AT TIME ZONE 'UTC')::date AS starts_on, (sp.ends_at AT TIME ZONE 'UTC')::date AS ends_on
        FROM projects pr
        CROSS JOIN LATERAL (
          SELECT s.id, s.name, s.starts_at, s.ends_at FROM spark.sprints s
          WHERE s.tenant_id = target.tenant_id AND s.project_id = pr.id AND s.status = 'active'
          ORDER BY s.started_at DESC, s.id LIMIT 1
        ) sp
        WHERE pr.methodology = 'scrum'
      ), scope AS (
        SELECT pr.id AS project_id, count(*) AS total_count, count(*) FILTER (WHERE st.category = 'done') AS done_count,
          count(i.story_points) AS estimated_count, coalesce(sum(coalesce(i.story_points, 0)), 0) AS total_points,
          coalesce(sum(coalesce(i.story_points, 0)) FILTER (WHERE st.category = 'done'), 0) AS done_points
        FROM projects pr
        JOIN spark.issues i ON i.tenant_id = target.tenant_id AND i.project_id = pr.id AND i.archived_at IS NULL
        JOIN spark.issue_statuses st ON st.tenant_id = i.tenant_id AND st.project_id = i.project_id AND st.id = i.status_id
        LEFT JOIN sprint sp ON sp.project_id = pr.id
        WHERE sp.sprint_id IS NULL OR i.sprint_id = sp.sprint_id
        GROUP BY pr.id
      ), project_lines AS (
        SELECT 1 AS ord, row_number() OVER (ORDER BY pr.key, pr.id) AS rn, 'project'::text AS section, pr.key AS project_key, pr.name AS project_name,
          pr.methodology, NULL::text AS label, NULL::numeric AS value,
          jsonb_build_object('done', CASE WHEN unit.points THEN coalesce(sc.done_points, 0) ELSE coalesce(sc.done_count, 0) END,
            'total', CASE WHEN unit.points THEN coalesce(sc.total_points, 0) ELSE coalesce(sc.total_count, 0) END,
            'unit', CASE WHEN unit.points THEN 'points' ELSE 'count' END,
            'windowStart', to_char(win.start_on, 'YYYY-MM-DD'), 'windowEnd', to_char(win.end_on, 'YYYY-MM-DD'),
            'activeSprintName', sp.name) AS extra
        FROM projects pr
        LEFT JOIN scope sc ON sc.project_id = pr.id
        LEFT JOIN sprint sp ON sp.project_id = pr.id
        CROSS JOIN LATERAL (SELECT coalesce(sc.total_count, 0) > 0 AND sc.estimated_count >= sc.total_count * 0.8 AS points) unit
        CROSS JOIN LATERAL (
          SELECT CASE WHEN pr.methodology = 'scrum' THEN sp.starts_on ELSE pr.start_date END AS start_on,
            CASE WHEN pr.methodology = 'scrum' THEN sp.ends_on ELSE pr.target_date END AS end_on
        ) raw
        CROSS JOIN LATERAL (
          SELECT CASE WHEN raw.start_on IS NOT NULL AND raw.end_on IS NOT NULL THEN raw.start_on END AS start_on,
            CASE WHEN raw.start_on IS NOT NULL AND raw.end_on IS NOT NULL THEN raw.end_on END AS end_on
        ) win
      ), snapshots AS (
        SELECT e.created_at, e.changes->'after' AS after,
          lag(e.changes->'after'->>'category') OVER (PARTITION BY e.issue_id ORDER BY e.to_version) AS previous
        FROM spark.issue_events e JOIN projects pr ON pr.id = e.project_id
        WHERE e.tenant_id = target.tenant_id AND e.created_at < window_end AND e.changes->'after'->>'category' IS NOT NULL
      ), completed AS (
        SELECT (s.after->>'assigneeUserId')::uuid AS member_id, count(*) AS total
        FROM snapshots s
        WHERE s.created_at >= window_start AND s.after->>'category' = 'done' AND NOT coalesce((s.after->>'archived')::boolean, false)
          AND s.previous IS DISTINCT FROM 'done' AND s.after->>'assigneeUserId' IS NOT NULL
        GROUP BY 1
      ), member_lines AS (
        SELECT 2 AS ord, row_number() OVER (ORDER BY c.total DESC, btrim(mu.display_name), mu.id) AS rn, 'member'::text AS section,
          NULL::text AS project_key, NULL::text AS project_name, NULL::text AS methodology, btrim(mu.display_name) AS label,
          c.total::numeric AS value, NULL::jsonb AS extra
        FROM completed c JOIN spark.users mu ON mu.id = c.member_id AND mu.deleted_at IS NULL
        JOIN spark.workspace_memberships mm ON mm.tenant_id = target.tenant_id AND mm.user_id = mu.id AND mm.status = 'active'
      ), open_items AS (
        SELECT pr.key AS project_key, i.number, i.title, i.due_date
        FROM spark.issues i
        JOIN projects pr ON pr.id = i.project_id
        JOIN spark.issue_statuses st ON st.tenant_id = i.tenant_id AND st.project_id = i.project_id AND st.id = i.status_id
        WHERE i.tenant_id = target.tenant_id AND i.archived_at IS NULL AND st.category <> 'done' AND i.due_date IS NOT NULL
      ), risk AS (
        SELECT 'at_risk'::text AS section, o.*, row_number() OVER (ORDER BY o.due_date, o.project_key, o.number) AS rn, count(*) OVER () AS total
        FROM open_items o WHERE o.due_date >= target.period AND o.due_date <= target.period + 3
      ), late AS (
        SELECT 'overdue'::text AS section, o.*, row_number() OVER (ORDER BY o.due_date, o.project_key, o.number) AS rn, count(*) OVER () AS total
        FROM open_items o WHERE o.due_date < target.period
      ), item_lines AS (
        SELECT CASE WHEN r.section = 'at_risk' THEN 3 ELSE 4 END AS ord, r.rn, r.section, r.project_key, NULL::text AS project_name, NULL::text AS methodology,
          r.project_key || '-' || r.number || ' ' || r.title AS label, NULL::numeric AS value,
          jsonb_build_object('due', to_char(r.due_date, 'YYYY-MM-DD'), 'total', r.total) AS extra
        FROM (SELECT * FROM risk UNION ALL SELECT * FROM late) r WHERE r.rn <= 10
      ), lines AS (
        SELECT * FROM project_lines UNION ALL SELECT * FROM member_lines UNION ALL SELECT * FROM item_lines
      )
      SELECT 'pending'::text, recipient_email, recipient, space_name, space_slug, l.section, l.project_key, l.project_name, l.methodology,
        l.label, l.value, l.extra
      FROM lines l ORDER BY l.ord, l.rn;
      RETURN;
    END IF;
  END IF;
  RETURN QUERY SELECT 'skipped'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
    NULL::text, NULL::numeric, NULL::jsonb;
END $$;
--> statement-breakpoint
-- Settles a claimed row, only while the caller still holds the lease (lock token) and the row is pending; false
-- otherwise. 'sent' stamps sent_at; 'suppressed' closes it without sending (optional reason code); 'retry'
-- needs an error code and a retry time: the row stays pending with the lease cleared, held back until the retry
-- time (clamped to between now() and one day from now), and becomes failed once five attempts were made. Error
-- codes come from a fixed whitelist.
CREATE FUNCTION spark.worker_settle_scheduled_email(p_id uuid, p_lock_token uuid, p_status text, p_error_code text, p_retry_at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('sent','suppressed','retry') THEN RAISE EXCEPTION 'Invalid settle status' USING ERRCODE = '22023'; END IF;
  IF p_error_code IS NOT NULL AND p_error_code NOT IN ('smtp_error','template_error','not_found','invalid_payload','handler_error','expired','lease_expired','nothing_due') THEN RAISE EXCEPTION 'Invalid error code' USING ERRCODE = '22023'; END IF;
  IF p_status = 'retry' AND (p_error_code IS NULL OR p_retry_at IS NULL) THEN RAISE EXCEPTION 'Invalid retry' USING ERRCODE = '22023'; END IF;
  IF p_lock_token IS NULL THEN RETURN false; END IF;
  IF p_status = 'sent' THEN
    UPDATE spark.scheduled_emails s SET status = 'sent', sent_at = now(), locked_until = NULL, lock_token = NULL
      WHERE s.id = p_id AND s.lock_token = p_lock_token AND s.status = 'pending';
  ELSIF p_status = 'suppressed' THEN
    UPDATE spark.scheduled_emails s SET status = 'suppressed', last_error_code = p_error_code, locked_until = NULL, lock_token = NULL
      WHERE s.id = p_id AND s.lock_token = p_lock_token AND s.status = 'pending';
  ELSE
    UPDATE spark.scheduled_emails s
      SET status = CASE WHEN s.attempts >= 5 THEN 'failed' ELSE 'pending' END, last_error_code = p_error_code,
        locked_until = CASE WHEN s.attempts >= 5 THEN NULL ELSE least(greatest(p_retry_at, now()), now() + interval '1 day') END, lock_token = NULL
      WHERE s.id = p_id AND s.lock_token = p_lock_token AND s.status = 'pending';
  END IF;
  RETURN FOUND;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.scheduled_open_tasks(uuid,date), spark.scheduled_emails_claim_at(text,timestamptz,uuid,integer,integer),
  spark.worker_claim_scheduled_emails(text,uuid,integer,integer), spark.worker_due_reminder_email(uuid,uuid),
  spark.worker_weekly_digest_email(uuid,uuid), spark.worker_settle_scheduled_email(uuid,uuid,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION spark.scheduled_open_tasks(uuid,date), spark.scheduled_emails_claim_at(text,timestamptz,uuid,integer,integer),
  spark.worker_claim_scheduled_emails(text,uuid,integer,integer), spark.worker_due_reminder_email(uuid,uuid),
  spark.worker_weekly_digest_email(uuid,uuid), spark.worker_settle_scheduled_email(uuid,uuid,text,text,timestamptz) FROM spark_app;
REVOKE ALL ON FUNCTION spark.scheduled_open_tasks(uuid,date), spark.scheduled_emails_claim_at(text,timestamptz,uuid,integer,integer) FROM spark_worker;
GRANT EXECUTE ON FUNCTION spark.worker_claim_scheduled_emails(text,uuid,integer,integer), spark.worker_due_reminder_email(uuid,uuid),
  spark.worker_weekly_digest_email(uuid,uuid), spark.worker_settle_scheduled_email(uuid,uuid,text,text,timestamptz) TO spark_worker;
