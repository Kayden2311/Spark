-- Read-only insight functions for the admin dashboards: community health counts and daily community
-- growth (Communities page), open reports by reason and community and a daily report backlog (Reports
-- page). Same contract as 0012: SECURITY DEFINER with an empty search_path, the platform role checked
-- first, aggregates only, days bucketed in UTC, revoked from PUBLIC and granted to spark_app.
--
-- History rules (no snapshot tables; series are rebuilt from stored timestamps):
-- * Live communities per day cannot be rebuilt exactly. staff_moderate_community (0009) sets
--   communities.archived_at on archive and clears it on restore, and a later archive overwrites it, so
--   a community that was archived and restored leaves no trace of when it was offline. There is no
--   archive history column or table. staff_community_daily therefore returns NULL for
--   live_communities on every row rather than a guessed count.
-- * The report backlog is rebuilt from content_reports.created_at and resolved_at. The only runtime
--   write path is staff_resolve_report (0009, replacing 0006/0007), which moves a report from open or
--   reviewing to resolved or dismissed and stamps resolved_at = now() in the same UPDATE; a closed
--   report is answered 'already_closed' and never reopened. spark_app has no table privileges on
--   content_reports (0006), reports cannot be deleted (no DELETE grant, RESTRICT foreign keys), and
--   no function sets a report back to open or reviewing or clears resolved_at. No CHECK ties
--   resolved_at to status, so rows written directly by the owner (seed scripts) are read defensively:
--   an open or reviewing report is in the backlog regardless of resolved_at, a closed report leaves
--   the backlog at resolved_at, and a closed report without resolved_at is never counted (it would
--   otherwise stay in the backlog forever). With this rule today's end-of-day backlog equals the
--   live open + reviewing count that staff_report_stats returns.
CREATE FUNCTION spark.staff_community_health_counts()
RETURNS TABLE(growing bigint, steady bigint, slowing bigint, quiet bigint, needs_review bigint, archived bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE this_week date := date_trunc('week', now() AT TIME ZONE 'UTC')::date;
  window_start timestamptz; recent_start timestamptz; window_end timestamptz;
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin','community_moderator']);
  -- The same 8 UTC weeks as staff_community_health.weekly_activity: 4 earlier weeks, then the 4 recent
  -- weeks ending with the current (partial) week. Activity is visible, non-deleted posts and comments.
  window_start := (this_week - 49)::timestamp AT TIME ZONE 'UTC';
  recent_start := (this_week - 21)::timestamp AT TIME ZONE 'UTC';
  window_end := (this_week + 7)::timestamp AT TIME ZONE 'UTC';
  RETURN QUERY
  WITH activity AS (
    SELECT p.community_id, p.created_at FROM spark.posts p
      WHERE p.deleted_at IS NULL AND p.moderation_status = 'visible' AND p.created_at >= window_start AND p.created_at < window_end
    UNION ALL SELECT c.community_id, c.created_at FROM spark.post_comments c
      WHERE c.deleted_at IS NULL AND c.moderation_status = 'visible' AND c.created_at >= window_start AND c.created_at < window_end
  ),
  weeks AS (
    SELECT a.community_id, count(*) FILTER (WHERE a.created_at >= recent_start) AS recent, count(*) FILTER (WHERE a.created_at < recent_start) AS earlier
    FROM activity a GROUP BY a.community_id
  ),
  open_reports AS (
    SELECT r.community_id, count(*) AS n FROM spark.content_reports r WHERE r.status IN ('open','reviewing') GROUP BY r.community_id
  ),
  -- healthOf (frontend admin/_components/community-actions.ts), in its order. The ratio tests use
  -- integer arithmetic: recent >= 1.25 x earlier is 4 x recent >= 5 x earlier, recent <= 0.6 x earlier
  -- is 5 x recent <= 3 x earlier; both give the same answer as the client's floating-point checks.
  classified AS (
    SELECT CASE
      WHEN co.archived_at IS NOT NULL THEN 'archived'
      WHEN coalesce(o.n, 0) > 0 THEN 'needs_review'
      WHEN coalesce(w.recent, 0) = 0 THEN 'quiet'
      WHEN coalesce(w.earlier, 0) = 0 OR 4 * w.recent >= 5 * w.earlier THEN 'growing'
      WHEN 5 * w.recent <= 3 * w.earlier THEN 'slowing'
      ELSE 'steady' END AS health
    FROM spark.communities co
    LEFT JOIN weeks w ON w.community_id = co.id
    LEFT JOIN open_reports o ON o.community_id = co.id
  )
  SELECT count(*) FILTER (WHERE cl.health = 'growing'), count(*) FILTER (WHERE cl.health = 'steady'),
    count(*) FILTER (WHERE cl.health = 'slowing'), count(*) FILTER (WHERE cl.health = 'quiet'),
    count(*) FILTER (WHERE cl.health = 'needs_review'), count(*) FILTER (WHERE cl.health = 'archived')
  FROM classified cl;
END $$;
--> statement-breakpoint
-- One row per UTC day, oldest first: memberships joined and communities created that day (any state).
-- live_communities is always NULL; see the header.
CREATE FUNCTION spark.staff_community_daily(p_days integer)
RETURNS TABLE(day date, new_members bigint, new_communities bigint, live_communities bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE first_day date; since timestamptz;
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin','community_moderator']);
  PERFORM spark.require_range(p_days, 7, 365, 'Invalid range');
  first_day := (now() AT TIME ZONE 'UTC')::date - (p_days - 1);
  since := first_day::timestamp AT TIME ZONE 'UTC';
  RETURN QUERY
  WITH days AS (SELECT gs::date AS d FROM generate_series(first_day::timestamp, (first_day + (p_days - 1))::timestamp, interval '1 day') gs),
  joined AS (SELECT (m.joined_at AT TIME ZONE 'UTC')::date AS d, count(*) AS n FROM spark.community_memberships m WHERE m.joined_at >= since GROUP BY 1),
  created AS (SELECT (c.created_at AT TIME ZONE 'UTC')::date AS d, count(*) AS n FROM spark.communities c WHERE c.created_at >= since GROUP BY 1)
  SELECT days.d, coalesce(joined.n, 0), coalesce(created.n, 0), NULL::bigint
  FROM days
  LEFT JOIN joined ON joined.d = days.d
  LEFT JOIN created ON created.d = days.d
  ORDER BY days.d;
END $$;
--> statement-breakpoint
-- The open queue (open and reviewing reports) by reason, largest first.
CREATE FUNCTION spark.staff_report_reasons()
RETURNS TABLE(reason text, open_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin','content_moderator']);
  RETURN QUERY
  SELECT r.reason_code, count(*) FROM spark.content_reports r
  WHERE r.status IN ('open','reviewing')
  GROUP BY r.reason_code
  ORDER BY count(*) DESC, r.reason_code;
END $$;
--> statement-breakpoint
-- Communities with the most open and reviewing reports.
CREATE FUNCTION spark.staff_report_top_communities(p_limit integer)
RETURNS TABLE(community_id uuid, name text, slug text, open_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin','content_moderator']);
  PERFORM spark.require_range(p_limit, 1, 20, 'Invalid limit');
  RETURN QUERY
  SELECT co.id, co.name, co.slug, o.n
  FROM (SELECT r.community_id, count(*) AS n FROM spark.content_reports r WHERE r.status IN ('open','reviewing') GROUP BY r.community_id) o
  JOIN spark.communities co ON co.id = o.community_id
  ORDER BY o.n DESC, co.name, co.id
  LIMIT p_limit;
END $$;
--> statement-breakpoint
-- One row per UTC day, oldest first: reports created, reports closed (resolved or dismissed), the
-- backlog at the end of the day (for today: now) and the median hours to close of the reports closed
-- that day, rounded to 0.1 h (NULL when none). See the header for how the backlog is rebuilt.
CREATE FUNCTION spark.staff_report_daily(p_days integer)
RETURNS TABLE(day date, opened bigint, closed bigint, backlog bigint, median_hours_to_close numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE first_day date; since timestamptz; carried bigint;
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin','content_moderator']);
  PERFORM spark.require_range(p_days, 7, 365, 'Invalid range');
  first_day := (now() AT TIME ZONE 'UTC')::date - (p_days - 1);
  since := first_day::timestamp AT TIME ZONE 'UTC';
  -- Backlog when the range starts: created before it and not closed before it.
  SELECT count(*) INTO carried FROM spark.content_reports r
  WHERE r.created_at < since
    AND (r.status IN ('open','reviewing') OR (r.resolved_at IS NOT NULL AND r.resolved_at >= since));
  RETURN QUERY
  WITH days AS (SELECT gs::date AS d FROM generate_series(first_day::timestamp, (first_day + (p_days - 1))::timestamp, interval '1 day') gs),
  opened_by_day AS (SELECT (r.created_at AT TIME ZONE 'UTC')::date AS d, count(*) AS n FROM spark.content_reports r WHERE r.created_at >= since GROUP BY 1),
  closed_by_day AS (
    SELECT (r.resolved_at AT TIME ZONE 'UTC')::date AS d, count(*) AS n,
      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.resolved_at - r.created_at)) / 3600)::numeric, 1) AS median
    FROM spark.content_reports r WHERE r.status IN ('resolved','dismissed') AND r.resolved_at >= since GROUP BY 1
  ),
  -- Backlog changes: +1 when a tracked report is created, -1 when it is closed. A closed report is
  -- tracked only when it has resolved_at; it never leaves before it entered.
  changes AS (
    SELECT (r.created_at AT TIME ZONE 'UTC')::date AS d, 1 AS delta FROM spark.content_reports r
      WHERE r.created_at >= since AND (r.status IN ('open','reviewing') OR r.resolved_at IS NOT NULL)
    UNION ALL SELECT (greatest(r.resolved_at, r.created_at) AT TIME ZONE 'UTC')::date, -1 FROM spark.content_reports r
      WHERE r.status IN ('resolved','dismissed') AND r.resolved_at IS NOT NULL AND greatest(r.resolved_at, r.created_at) >= since
  ),
  net AS (SELECT ch.d, sum(ch.delta) AS n FROM changes ch GROUP BY ch.d)
  SELECT days.d, coalesce(o.n, 0), coalesce(c.n, 0),
    (carried + sum(coalesce(net.n, 0)) OVER (ORDER BY days.d))::bigint,
    c.median
  FROM days
  LEFT JOIN opened_by_day o ON o.d = days.d
  LEFT JOIN closed_by_day c ON c.d = days.d
  LEFT JOIN net ON net.d = days.d
  ORDER BY days.d;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.staff_community_health_counts(), spark.staff_community_daily(integer), spark.staff_report_reasons(),
  spark.staff_report_top_communities(integer), spark.staff_report_daily(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION spark.staff_community_health_counts(), spark.staff_community_daily(integer), spark.staff_report_reasons(),
  spark.staff_report_top_communities(integer), spark.staff_report_daily(integer) TO spark_app;
