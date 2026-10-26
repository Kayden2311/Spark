-- Insight reads (M5). Five read-only functions over the issue history and the current issue state. They are
-- SECURITY INVOKER (not definer): they run as the caller, so the workspace RLS policies (session_workspace_ids)
-- still filter every row, and on top of that every statement filters tenant_id and project_id explicitly. All
-- are STABLE with an empty search_path, revoked from PUBLIC and executable by spark_app only.
-- History replay: an issue's state at instant t is the changes->'after' snapshot of its issue_events row with the
-- highest to_version whose created_at < t (strictly before, so a change set stamped exactly t is not yet seen).
-- Events without after.category are ignored; an issue with no event before t did not exist at t. Days are UTC;
-- "the end of day d" is t = d + 1 day at 00:00 UTC.
-- One row per issue event with a snapshot, created before p_until: the snapshot is the state of the issue from
-- valid_from (inclusive) until valid_to (the next such event of the issue, exclusive; NULL for the latest). The
-- state at t < p_until is the row with valid_from < t AND (valid_to IS NULL OR valid_to >= t).
CREATE FUNCTION spark.insight_issue_states(p_tenant uuid, p_project uuid, p_until timestamptz)
RETURNS TABLE(issue_id uuid, valid_from timestamptz, valid_to timestamptz, category text, status_id uuid, sprint_id uuid, phase_id uuid,
  assignee_user_id uuid, story_points numeric, archived boolean)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT e.issue_id, e.created_at, lead(e.created_at) OVER (PARTITION BY e.issue_id ORDER BY e.to_version),
    e.changes->'after'->>'category', (e.changes->'after'->>'statusId')::uuid, (e.changes->'after'->>'sprintId')::uuid,
    (e.changes->'after'->>'phaseId')::uuid, (e.changes->'after'->>'assigneeUserId')::uuid, (e.changes->'after'->>'storyPoints')::numeric,
    coalesce((e.changes->'after'->>'archived')::boolean, false)
  FROM spark.issue_events e
  WHERE e.tenant_id = p_tenant AND e.project_id = p_project AND e.created_at < p_until
    AND e.changes->'after'->>'category' IS NOT NULL;
$$;
--> statement-breakpoint
-- One row per UTC day p_from..p_to (at most 366 days, else 22023 Invalid insight range), only for a project of
-- p_tenant the caller can see (no rows otherwise): the non-archived issues per category at the end of the day,
-- and the done transitions on that day. A done transition is an event whose snapshot is done and not archived
-- while the issue's previous snapshot was not done or absent, so a reopened issue that is completed again counts
-- again; completed_points sums the transition snapshots' storyPoints (NULL as 0).
CREATE FUNCTION spark.insight_flow(p_tenant uuid, p_project uuid, p_from date, p_to date)
RETURNS TABLE(day date, backlog integer, todo integer, in_progress integer, done integer, completed integer, completed_points numeric)
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 365 THEN
    RAISE EXCEPTION 'Invalid insight range' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH days AS (
    SELECT g.d::date AS day, (g.d::date + 1)::timestamp AT TIME ZONE 'UTC' AS instant
    FROM spark.projects p, generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') AS g(d)
    WHERE p.tenant_id = p_tenant AND p.id = p_project
  ), states AS (
    SELECT s.category, s.valid_from, s.valid_to FROM spark.insight_issue_states(p_tenant, p_project, (p_to + 1)::timestamp AT TIME ZONE 'UTC') s
    WHERE NOT s.archived
  ), counts AS (
    SELECT d.day,
      count(*) FILTER (WHERE s.category = 'backlog')::integer AS backlog,
      count(*) FILTER (WHERE s.category = 'todo')::integer AS todo,
      count(*) FILTER (WHERE s.category = 'in_progress')::integer AS in_progress,
      count(*) FILTER (WHERE s.category = 'done')::integer AS done
    FROM days d LEFT JOIN states s ON s.valid_from < d.instant AND (s.valid_to IS NULL OR s.valid_to >= d.instant)
    GROUP BY d.day
  ), snapshots AS (
    SELECT e.created_at, e.changes->'after' AS after,
      lag(e.changes->'after'->>'category') OVER (PARTITION BY e.issue_id ORDER BY e.to_version) AS previous
    FROM spark.issue_events e
    WHERE e.tenant_id = p_tenant AND e.project_id = p_project AND e.created_at < (p_to + 1)::timestamp AT TIME ZONE 'UTC'
      AND e.changes->'after'->>'category' IS NOT NULL
  ), transitions AS (
    SELECT (t.created_at AT TIME ZONE 'UTC')::date AS day, count(*)::integer AS completed,
      sum(coalesce((t.after->>'storyPoints')::numeric, 0)) AS completed_points
    FROM snapshots t
    WHERE t.created_at >= p_from::timestamp AT TIME ZONE 'UTC' AND t.after->>'category' = 'done'
      AND NOT coalesce((t.after->>'archived')::boolean, false) AND t.previous IS DISTINCT FROM 'done'
    GROUP BY 1
  )
  SELECT c.day, c.backlog, c.todo, c.in_progress, c.done, coalesce(t.completed, 0), coalesce(t.completed_points, 0)
  FROM counts c LEFT JOIN transitions t ON t.day = c.day
  ORDER BY c.day;
END $$;
--> statement-breakpoint
-- One row per UTC day of the sprint window, (starts_at AT TIME ZONE 'UTC')::date to (ends_at ...)::date inclusive,
-- for a sprint of p_tenant the caller can see (no rows otherwise, or when the sprint has no dates). The state of
-- day d is read at the end of the day, but never later than the sprint's completed_at, so the carry-over change
-- sets written at completion (stamped completed_at) do not count as burn. Scope = issues whose snapshot is in the
-- sprint and not archived; remaining = those not in a done category; points treat NULL as 0. Days after today
-- (UTC) return NULL in all four values.
CREATE FUNCTION spark.insight_sprint_burndown(p_tenant uuid, p_sprint uuid)
RETURNS TABLE(day date, scope_count integer, scope_points numeric, remaining_count integer, remaining_points numeric)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH sprint AS (
    SELECT s.tenant_id, s.project_id, (s.starts_at AT TIME ZONE 'UTC')::date AS first_day, (s.ends_at AT TIME ZONE 'UTC')::date AS last_day, s.completed_at
    FROM spark.sprints s WHERE s.tenant_id = p_tenant AND s.id = p_sprint AND s.starts_at IS NOT NULL AND s.ends_at IS NOT NULL
  ), days AS (
    SELECT g.d::date AS day, least((g.d::date + 1)::timestamp AT TIME ZONE 'UTC', sp.completed_at) AS instant,
      g.d::date > (now() AT TIME ZONE 'UTC')::date AS future
    FROM sprint sp, generate_series(sp.first_day::timestamp, sp.last_day::timestamp, interval '1 day') AS g(d)
  ), states AS (
    SELECT st.category, st.story_points, st.valid_from, st.valid_to
    FROM sprint sp, spark.insight_issue_states(p_tenant, sp.project_id, least((sp.last_day + 1)::timestamp AT TIME ZONE 'UTC', sp.completed_at)) st
    WHERE st.sprint_id = p_sprint AND NOT st.archived
  )
  SELECT d.day,
    CASE WHEN NOT d.future THEN count(s.valid_from)::integer END,
    CASE WHEN NOT d.future THEN coalesce(sum(coalesce(s.story_points, 0)), 0) END,
    CASE WHEN NOT d.future THEN (count(s.valid_from) FILTER (WHERE s.category <> 'done'))::integer END,
    CASE WHEN NOT d.future THEN coalesce(sum(coalesce(s.story_points, 0)) FILTER (WHERE s.category <> 'done'), 0) END
  FROM days d LEFT JOIN states s ON NOT d.future AND s.valid_from < d.instant AND (s.valid_to IS NULL OR s.valid_to >= d.instant)
  GROUP BY d.day, d.future
  ORDER BY d.day;
$$;
--> statement-breakpoint
-- The newest p_limit (1 to 6, else 22023 Invalid limit) completed sprints of the project whose completed_at is in
-- [p_from, p_to), returned oldest first, with the frozen M4 totals and the commitment reliability and scope creep
-- inputs. "At start" is the state at started_at, "just before completion" the state at completed_at (both strictly
-- before, so the carry-over change sets stamped completed_at are excluded). base = committed issues not in a done
-- category at start (or not existing yet); already_done = committed issues done at start; base points, estimated
-- count and done points use the commitment snapshot's story_points (NULL as 0); base_done = base issues done, not
-- archived and still in the sprint just before completion; added = issues in the sprint and not archived just
-- before completion without a commitment row (points from that snapshot, NULL as 0); removed = committed issues
-- outside the sprint or archived just before completion.
CREATE FUNCTION spark.insight_sprint_outcomes(p_tenant uuid, p_project uuid, p_from timestamptz, p_to timestamptz, p_limit integer)
RETURNS TABLE(sprint_id uuid, name text, completed_at timestamptz, committed_points numeric, completed_points numeric, committed_count integer,
  completed_count integer, base_count integer, base_points numeric, base_estimated integer, base_done_count integer, base_done_points numeric,
  already_done_count integer, added_count integer, added_points numeric, removed_count integer)
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 6 THEN RAISE EXCEPTION 'Invalid limit' USING ERRCODE = '22023'; END IF;
  IF p_from IS NULL OR p_to IS NULL THEN RAISE EXCEPTION 'Invalid insight range' USING ERRCODE = '22023'; END IF;
  RETURN QUERY
  WITH picked AS (
    SELECT s.id, s.name, s.started_at, s.completed_at, s.committed_points, s.completed_points, s.committed_count, s.completed_count
    FROM spark.sprints s
    WHERE s.tenant_id = p_tenant AND s.project_id = p_project AND s.status = 'completed' AND s.completed_at >= p_from AND s.completed_at < p_to
    ORDER BY s.completed_at DESC, s.id DESC LIMIT p_limit
  ), states AS (
    SELECT st.* FROM spark.insight_issue_states(p_tenant, p_project, (SELECT max(p.completed_at) FROM picked p)) st
  ), committed AS (
    SELECT p.id AS sprint_id, c.story_points, a.category AS start_category,
      f.category = 'done' AND NOT f.archived AND f.sprint_id IS NOT DISTINCT FROM p.id AS done_at_end,
      f.issue_id IS NULL OR f.archived OR f.sprint_id IS DISTINCT FROM p.id AS removed
    FROM picked p
    JOIN spark.sprint_commitments c ON c.tenant_id = p_tenant AND c.sprint_id = p.id
    LEFT JOIN states a ON a.issue_id = c.issue_id AND a.valid_from < p.started_at AND (a.valid_to IS NULL OR a.valid_to >= p.started_at)
    LEFT JOIN states f ON f.issue_id = c.issue_id AND f.valid_from < p.completed_at AND (f.valid_to IS NULL OR f.valid_to >= p.completed_at)
  ), added AS (
    SELECT p.id AS sprint_id, f.story_points
    FROM picked p
    JOIN states f ON f.sprint_id = p.id AND NOT f.archived AND f.valid_from < p.completed_at AND (f.valid_to IS NULL OR f.valid_to >= p.completed_at)
    WHERE NOT EXISTS (SELECT 1 FROM spark.sprint_commitments c WHERE c.tenant_id = p_tenant AND c.sprint_id = p.id AND c.issue_id = f.issue_id)
  )
  SELECT p.id, p.name, p.completed_at, p.committed_points, p.completed_points, p.committed_count, p.completed_count,
    cm.base_count, cm.base_points, cm.base_estimated, cm.base_done_count, cm.base_done_points, cm.already_done_count,
    ad.added_count, ad.added_points, cm.removed_count
  FROM picked p
  CROSS JOIN LATERAL (
    SELECT count(*) FILTER (WHERE x.start_category IS DISTINCT FROM 'done')::integer AS base_count,
      coalesce(sum(coalesce(x.story_points, 0)) FILTER (WHERE x.start_category IS DISTINCT FROM 'done'), 0) AS base_points,
      count(x.story_points) FILTER (WHERE x.start_category IS DISTINCT FROM 'done')::integer AS base_estimated,
      count(*) FILTER (WHERE x.start_category IS DISTINCT FROM 'done' AND x.done_at_end)::integer AS base_done_count,
      coalesce(sum(coalesce(x.story_points, 0)) FILTER (WHERE x.start_category IS DISTINCT FROM 'done' AND x.done_at_end), 0) AS base_done_points,
      count(*) FILTER (WHERE x.start_category = 'done')::integer AS already_done_count,
      count(*) FILTER (WHERE x.removed)::integer AS removed_count
    FROM committed x WHERE x.sprint_id = p.id
  ) cm
  CROSS JOIN LATERAL (
    SELECT count(*)::integer AS added_count, coalesce(sum(coalesce(y.story_points, 0)), 0) AS added_points FROM added y WHERE y.sprint_id = p.id
  ) ad
  ORDER BY p.completed_at, p.id;
END $$;
--> statement-breakpoint
-- Current-state member statistics over the non-archived issues of p_projects in p_tenant (the caller passes the
-- projects it resolved; they are re-filtered by tenant here and by RLS), grouped by the current assignee (the
-- NULL group is "Unassigned"). completed = issues now in a done category whose completed_at UTC day is in
-- p_from..p_to (else 22023 Invalid insight range); completed_points sums their story_points (NULL as 0);
-- with_due / on_time = completed with a due date / and completed on or before it (UTC day); open = issues not in
-- a done category; overdue = open with due_date < p_today; median_cycle_days = median of completed_at - started_at
-- in days over completed issues with started_at (percentile_cont, rounded to 0.1; NULL when none). Groups with
-- nothing completed in range and nothing open are left out.
CREATE FUNCTION spark.insight_members(p_tenant uuid, p_projects uuid[], p_from date, p_to date, p_today date)
RETURNS TABLE(user_id uuid, completed integer, completed_points numeric, with_due integer, on_time integer, open integer, overdue integer,
  median_cycle_days numeric)
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_today IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'Invalid insight range' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH live AS (
    SELECT i.assignee_user_id, i.story_points, i.due_date, i.started_at, i.completed_at, st.category = 'done' AS is_done,
      st.category = 'done' AND (i.completed_at AT TIME ZONE 'UTC')::date BETWEEN p_from AND p_to AS in_range
    FROM spark.issues i
    JOIN spark.issue_statuses st ON st.tenant_id = i.tenant_id AND st.project_id = i.project_id AND st.id = i.status_id
    WHERE i.tenant_id = p_tenant AND i.project_id = ANY (p_projects) AND st.tenant_id = p_tenant AND st.project_id = ANY (p_projects)
      AND i.archived_at IS NULL
  )
  SELECT c.assignee_user_id,
    (count(*) FILTER (WHERE c.in_range))::integer,
    coalesce(sum(coalesce(c.story_points, 0)) FILTER (WHERE c.in_range), 0),
    (count(*) FILTER (WHERE c.in_range AND c.due_date IS NOT NULL))::integer,
    (count(*) FILTER (WHERE c.in_range AND (c.completed_at AT TIME ZONE 'UTC')::date <= c.due_date))::integer,
    (count(*) FILTER (WHERE NOT c.is_done))::integer,
    (count(*) FILTER (WHERE NOT c.is_done AND c.due_date < p_today))::integer,
    round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM c.completed_at - c.started_at)::double precision / 86400)
      FILTER (WHERE c.in_range AND c.started_at IS NOT NULL))::numeric, 1)
  FROM live c
  GROUP BY c.assignee_user_id
  HAVING count(*) FILTER (WHERE c.in_range OR NOT c.is_done) > 0
  ORDER BY c.assignee_user_id NULLS LAST;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.insight_issue_states(uuid, uuid, timestamptz), spark.insight_flow(uuid, uuid, date, date),
  spark.insight_sprint_burndown(uuid, uuid), spark.insight_sprint_outcomes(uuid, uuid, timestamptz, timestamptz, integer),
  spark.insight_members(uuid, uuid[], date, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION spark.insight_issue_states(uuid, uuid, timestamptz), spark.insight_flow(uuid, uuid, date, date),
  spark.insight_sprint_burndown(uuid, uuid), spark.insight_sprint_outcomes(uuid, uuid, timestamptz, timestamptz, integer),
  spark.insight_members(uuid, uuid[], date, date, date) TO spark_app;
