-- Read-only insight functions for the admin console: platform activity, engagement, retention,
-- community health, per-user activity, report context and billing. All are SECURITY DEFINER so
-- they can aggregate tables the runtime role cannot read row by row; each checks the caller's
-- platform role first and returns aggregates or staff-safe columns only (never token hashes or
-- payment payloads). Days are bucketed in UTC.
CREATE INDEX posts_created_idx ON spark.posts (created_at);
CREATE INDEX post_comments_created_idx ON spark.post_comments (created_at);
CREATE INDEX sessions_created_idx ON spark.sessions (created_at);
CREATE INDEX sessions_user_created_idx ON spark.sessions (user_id, created_at DESC);
CREATE INDEX community_memberships_joined_idx ON spark.community_memberships (joined_at);
CREATE INDEX invoices_issued_idx ON spark.invoices (issued_at DESC, id DESC);
CREATE INDEX subscriptions_status_idx ON spark.subscriptions (status, created_at DESC, id DESC);
CREATE INDEX payment_events_received_idx ON spark.payment_events (received_at);
--> statement-breakpoint
-- Shared bounds check for every range parameter.
CREATE FUNCTION spark.require_range(p_value integer, p_min integer, p_max integer, p_message text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF p_value IS NULL OR p_value NOT BETWEEN p_min AND p_max THEN
    RAISE EXCEPTION '%', p_message USING ERRCODE = '22023';
  END IF;
END $$;
REVOKE ALL ON FUNCTION spark.require_range(integer,integer,integer,text) FROM PUBLIC;
--> statement-breakpoint
-- One row per UTC day, oldest first. "Active" means the user signed in, posted or commented that day.
CREATE FUNCTION spark.staff_activity_series(p_days integer)
RETURNS TABLE(day date, signups bigint, active_users bigint, sign_ins bigint, posts bigint, comments bigint, reports_opened bigint, reports_closed bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE first_day date; since timestamptz;
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin']);
  PERFORM spark.require_range(p_days, 7, 365, 'Invalid range');
  first_day := (now() AT TIME ZONE 'UTC')::date - (p_days - 1);
  since := first_day::timestamp AT TIME ZONE 'UTC';
  RETURN QUERY
  WITH days AS (SELECT gs::date AS d FROM generate_series(first_day::timestamp, (first_day + (p_days - 1))::timestamp, interval '1 day') gs),
  events AS (
    SELECT s.user_id, (s.created_at AT TIME ZONE 'UTC')::date AS d, 'sign_in'::text AS kind FROM spark.sessions s WHERE s.created_at >= since
    UNION ALL SELECT p.author_user_id, (p.created_at AT TIME ZONE 'UTC')::date, 'post' FROM spark.posts p WHERE p.created_at >= since
    UNION ALL SELECT c.author_user_id, (c.created_at AT TIME ZONE 'UTC')::date, 'comment' FROM spark.post_comments c WHERE c.created_at >= since
  ),
  per_day AS (
    SELECT e.d, count(DISTINCT e.user_id) AS active, count(*) FILTER (WHERE e.kind = 'sign_in') AS sign_ins,
      count(*) FILTER (WHERE e.kind = 'post') AS posts, count(*) FILTER (WHERE e.kind = 'comment') AS comments
    FROM events e GROUP BY e.d
  ),
  joins AS (SELECT (u.created_at AT TIME ZONE 'UTC')::date AS d, count(*) AS n FROM spark.users u WHERE u.created_at >= since AND u.deleted_at IS NULL GROUP BY 1),
  opened AS (SELECT (r.created_at AT TIME ZONE 'UTC')::date AS d, count(*) AS n FROM spark.content_reports r WHERE r.created_at >= since GROUP BY 1),
  closed AS (SELECT (r.resolved_at AT TIME ZONE 'UTC')::date AS d, count(*) AS n FROM spark.content_reports r WHERE r.resolved_at >= since GROUP BY 1)
  SELECT days.d, coalesce(joins.n, 0), coalesce(per_day.active, 0), coalesce(per_day.sign_ins, 0), coalesce(per_day.posts, 0),
    coalesce(per_day.comments, 0), coalesce(opened.n, 0), coalesce(closed.n, 0)
  FROM days
  LEFT JOIN per_day ON per_day.d = days.d
  LEFT JOIN joins ON joins.d = days.d
  LEFT JOIN opened ON opened.d = days.d
  LEFT JOIN closed ON closed.d = days.d
  ORDER BY days.d;
END $$;
--> statement-breakpoint
-- Distinct active users over trailing windows ending today: the basis for DAU/WAU/MAU and stickiness.
CREATE FUNCTION spark.staff_active_user_totals()
RETURNS TABLE(dau bigint, wau bigint, mau bigint, total_users bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE today date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin']);
  RETURN QUERY
  WITH events AS (
    SELECT s.user_id, (s.created_at AT TIME ZONE 'UTC')::date AS d FROM spark.sessions s WHERE s.created_at >= now() - interval '31 days'
    UNION ALL SELECT p.author_user_id, (p.created_at AT TIME ZONE 'UTC')::date FROM spark.posts p WHERE p.created_at >= now() - interval '31 days'
    UNION ALL SELECT c.author_user_id, (c.created_at AT TIME ZONE 'UTC')::date FROM spark.post_comments c WHERE c.created_at >= now() - interval '31 days'
  )
  SELECT
    (SELECT count(DISTINCT e.user_id) FROM events e WHERE e.d = today),
    (SELECT count(DISTINCT e.user_id) FROM events e WHERE e.d > today - 7),
    (SELECT count(DISTINCT e.user_id) FROM events e WHERE e.d > today - 30),
    (SELECT count(*) FROM spark.users u WHERE u.deleted_at IS NULL);
END $$;
--> statement-breakpoint
-- Event counts by ISO day of week (1 = Monday) and UTC hour.
CREATE FUNCTION spark.staff_engagement_heatmap(p_days integer)
RETURNS TABLE(dow integer, hour integer, events bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE since timestamptz;
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin']);
  PERFORM spark.require_range(p_days, 7, 365, 'Invalid range');
  since := now() - make_interval(days => p_days);
  RETURN QUERY
  WITH stamps AS (
    SELECT s.created_at AT TIME ZONE 'UTC' AS t FROM spark.sessions s WHERE s.created_at >= since
    UNION ALL SELECT p.created_at AT TIME ZONE 'UTC' FROM spark.posts p WHERE p.created_at >= since
    UNION ALL SELECT c.created_at AT TIME ZONE 'UTC' FROM spark.post_comments c WHERE c.created_at >= since
  )
  SELECT date_part('isodow', st.t)::integer, date_part('hour', st.t)::integer, count(*)
  FROM stamps st GROUP BY 1, 2 ORDER BY 1, 2;
END $$;
--> statement-breakpoint
-- Weekly sign-up cohorts (weeks start Monday, UTC) and how many of each cohort were active in each
-- following week. Week 0 is the sign-up week.
CREATE FUNCTION spark.staff_retention_cohorts(p_weeks integer)
RETURNS TABLE(cohort_week date, cohort_size bigint, week_offset integer, active_users bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE first_week date;
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin']);
  PERFORM spark.require_range(p_weeks, 4, 26, 'Invalid range');
  first_week := date_trunc('week', now() AT TIME ZONE 'UTC')::date - 7 * (p_weeks - 1);
  RETURN QUERY
  WITH cohorts AS (
    SELECT u.id AS user_id, date_trunc('week', u.created_at AT TIME ZONE 'UTC')::date AS w
    FROM spark.users u WHERE u.deleted_at IS NULL AND u.created_at >= first_week::timestamp AT TIME ZONE 'UTC'
  ),
  sizes AS (SELECT c.w, count(*) AS n FROM cohorts c GROUP BY c.w),
  activity AS (
    SELECT s.user_id, date_trunc('week', s.created_at AT TIME ZONE 'UTC')::date AS w FROM spark.sessions s WHERE s.created_at >= first_week::timestamp AT TIME ZONE 'UTC'
    UNION SELECT p.author_user_id, date_trunc('week', p.created_at AT TIME ZONE 'UTC')::date FROM spark.posts p WHERE p.created_at >= first_week::timestamp AT TIME ZONE 'UTC'
    UNION SELECT c.author_user_id, date_trunc('week', c.created_at AT TIME ZONE 'UTC')::date FROM spark.post_comments c WHERE c.created_at >= first_week::timestamp AT TIME ZONE 'UTC'
  ),
  retained AS (
    SELECT c.w, ((a.w - c.w) / 7)::integer AS k, count(DISTINCT c.user_id) AS n
    FROM cohorts c JOIN activity a ON a.user_id = c.user_id AND a.w >= c.w
    GROUP BY 1, 2
  )
  SELECT s.w, s.n, coalesce(r.k, 0), coalesce(r.n, 0) FROM sizes s LEFT JOIN retained r ON r.w = s.w
  WHERE r.k IS NULL OR r.k < p_weeks
  ORDER BY s.w, coalesce(r.k, 0);
END $$;
--> statement-breakpoint
-- The most active communities over the range: posts, comments, new members and distinct contributors.
CREATE FUNCTION spark.staff_top_communities(p_days integer, p_limit integer)
RETURNS TABLE(community_id uuid, name text, slug text, posts bigint, comments bigint, new_members bigint, contributors bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE since timestamptz;
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin','community_moderator']);
  PERFORM spark.require_range(p_days, 7, 365, 'Invalid range');
  PERFORM spark.require_range(p_limit, 1, 50, 'Invalid limit');
  since := now() - make_interval(days => p_days);
  RETURN QUERY
  WITH content AS (
    SELECT p.community_id, p.author_user_id AS author, 1 AS post, 0 AS comment FROM spark.posts p
      WHERE p.created_at >= since AND p.deleted_at IS NULL AND p.moderation_status = 'visible'
    UNION ALL SELECT c.community_id, c.author_user_id, 0, 1 FROM spark.post_comments c
      WHERE c.created_at >= since AND c.deleted_at IS NULL AND c.moderation_status = 'visible'
  ),
  totals AS (
    SELECT ct.community_id, sum(ct.post)::bigint AS posts, sum(ct.comment)::bigint AS comments, count(DISTINCT ct.author) AS contributors
    FROM content ct GROUP BY ct.community_id
  ),
  joined AS (SELECT m.community_id, count(*) AS n FROM spark.community_memberships m WHERE m.joined_at >= since GROUP BY m.community_id)
  SELECT co.id, co.name, co.slug, coalesce(t.posts, 0), coalesce(t.comments, 0), coalesce(j.n, 0), coalesce(t.contributors, 0)
  FROM spark.communities co
  LEFT JOIN totals t ON t.community_id = co.id
  LEFT JOIN joined j ON j.community_id = co.id
  WHERE co.archived_at IS NULL
  ORDER BY coalesce(t.posts, 0) + coalesce(t.comments, 0) DESC, coalesce(j.n, 0) DESC, co.name
  LIMIT p_limit;
END $$;
--> statement-breakpoint
-- Health figures for a page of communities. weekly_activity holds posts + comments for the last
-- 8 weeks, oldest first, ending with the current (partial) week.
CREATE FUNCTION spark.staff_community_health(p_communities uuid[])
RETURNS TABLE(community_id uuid, members bigint, new_members_30d bigint, posts_30d bigint, comments_30d bigint, weekly_activity bigint[], open_reports bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE this_week date := date_trunc('week', now() AT TIME ZONE 'UTC')::date;
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin','community_moderator']);
  IF p_communities IS NULL OR cardinality(p_communities) > 100 THEN
    RAISE EXCEPTION 'Invalid limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT co.id,
    (SELECT count(*) FROM spark.community_memberships m WHERE m.community_id = co.id AND m.status = 'active'),
    (SELECT count(*) FROM spark.community_memberships m WHERE m.community_id = co.id AND m.joined_at >= now() - interval '30 days'),
    (SELECT count(*) FROM spark.posts p WHERE p.community_id = co.id AND p.created_at >= now() - interval '30 days' AND p.deleted_at IS NULL AND p.moderation_status = 'visible'),
    (SELECT count(*) FROM spark.post_comments c WHERE c.community_id = co.id AND c.created_at >= now() - interval '30 days' AND c.deleted_at IS NULL AND c.moderation_status = 'visible'),
    ARRAY(
      SELECT (SELECT count(*) FROM spark.posts p WHERE p.community_id = co.id AND p.deleted_at IS NULL AND p.moderation_status = 'visible'
                AND p.created_at >= (wk.w::timestamp AT TIME ZONE 'UTC') AND p.created_at < ((wk.w + 7)::timestamp AT TIME ZONE 'UTC'))
           + (SELECT count(*) FROM spark.post_comments c WHERE c.community_id = co.id AND c.deleted_at IS NULL AND c.moderation_status = 'visible'
                AND c.created_at >= (wk.w::timestamp AT TIME ZONE 'UTC') AND c.created_at < ((wk.w + 7)::timestamp AT TIME ZONE 'UTC'))
      FROM (SELECT gs::date AS w FROM generate_series((this_week - 49)::timestamp, this_week::timestamp, interval '7 days') gs) AS wk ORDER BY wk.w
    ),
    (SELECT count(*) FROM spark.content_reports r WHERE r.community_id = co.id AND r.status IN ('open','reviewing'))
  FROM spark.communities co
  WHERE co.id = ANY(p_communities);
END $$;
--> statement-breakpoint
-- Daily series for one community: new members, posts, comments and reports opened.
CREATE FUNCTION spark.staff_community_series(p_community uuid, p_days integer)
RETURNS TABLE(day date, new_members bigint, posts bigint, comments bigint, reports_opened bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE first_day date; since timestamptz;
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin','community_moderator']);
  PERFORM spark.require_range(p_days, 7, 365, 'Invalid range');
  first_day := (now() AT TIME ZONE 'UTC')::date - (p_days - 1);
  since := first_day::timestamp AT TIME ZONE 'UTC';
  RETURN QUERY
  SELECT d.d,
    (SELECT count(*) FROM spark.community_memberships m WHERE m.community_id = p_community AND (m.joined_at AT TIME ZONE 'UTC')::date = d.d),
    (SELECT count(*) FROM spark.posts p WHERE p.community_id = p_community AND p.created_at >= since AND p.deleted_at IS NULL AND p.moderation_status = 'visible' AND (p.created_at AT TIME ZONE 'UTC')::date = d.d),
    (SELECT count(*) FROM spark.post_comments c WHERE c.community_id = p_community AND c.created_at >= since AND c.deleted_at IS NULL AND c.moderation_status = 'visible' AND (c.created_at AT TIME ZONE 'UTC')::date = d.d),
    (SELECT count(*) FROM spark.content_reports r WHERE r.community_id = p_community AND r.created_at >= since AND (r.created_at AT TIME ZONE 'UTC')::date = d.d)
  FROM (SELECT gs::date AS d FROM generate_series(first_day::timestamp, (first_day + (p_days - 1))::timestamp, interval '1 day') gs) AS d
  ORDER BY d.d;
END $$;
--> statement-breakpoint
-- Daily activity for one user: sign-ins, posts and comments.
CREATE FUNCTION spark.staff_user_activity(p_user uuid, p_days integer)
RETURNS TABLE(day date, sign_ins bigint, posts bigint, comments bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE first_day date; since timestamptz;
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin']);
  PERFORM spark.require_range(p_days, 7, 365, 'Invalid range');
  first_day := (now() AT TIME ZONE 'UTC')::date - (p_days - 1);
  since := first_day::timestamp AT TIME ZONE 'UTC';
  RETURN QUERY
  WITH s AS (SELECT (x.created_at AT TIME ZONE 'UTC')::date AS d, count(*) AS n FROM spark.sessions x WHERE x.user_id = p_user AND x.created_at >= since GROUP BY 1),
  p AS (SELECT (x.created_at AT TIME ZONE 'UTC')::date AS d, count(*) AS n FROM spark.posts x WHERE x.author_user_id = p_user AND x.created_at >= since GROUP BY 1),
  c AS (SELECT (x.created_at AT TIME ZONE 'UTC')::date AS d, count(*) AS n FROM spark.post_comments x WHERE x.author_user_id = p_user AND x.created_at >= since GROUP BY 1)
  SELECT d.d, coalesce(s.n, 0), coalesce(p.n, 0), coalesce(c.n, 0)
  FROM (SELECT gs::date AS d FROM generate_series(first_day::timestamp, (first_day + (p_days - 1))::timestamp, interval '1 day') gs) AS d
  LEFT JOIN s ON s.d = d.d LEFT JOIN p ON p.d = d.d LEFT JOIN c ON c.d = d.d
  ORDER BY d.d;
END $$;
--> statement-breakpoint
-- Recent sign-ins for one user. Never returns the session token hash.
CREATE FUNCTION spark.staff_user_sessions(p_user uuid, p_limit integer)
RETURNS TABLE(id uuid, created_at timestamptz, last_seen_at timestamptz, expires_at timestamptz, auth_method text, state text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin']);
  PERFORM spark.require_range(p_limit, 1, 50, 'Invalid limit');
  RETURN QUERY
  SELECT s.id, s.created_at, s.last_seen_at, s.expires_at, s.auth_method,
    CASE WHEN s.revoked_at IS NOT NULL THEN 'revoked' WHEN s.expires_at <= now() THEN 'expired' ELSE 'active' END
  FROM spark.sessions s WHERE s.user_id = p_user
  ORDER BY s.created_at DESC, s.id DESC
  LIMIT p_limit;
END $$;
--> statement-breakpoint
-- Safety signals for a page of users: hidden content they wrote and reports filed against it.
CREATE FUNCTION spark.staff_user_risk(p_users uuid[])
RETURNS TABLE(user_id uuid, hidden_posts bigint, hidden_comments bigint, reports_against bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin']);
  IF p_users IS NULL OR cardinality(p_users) > 100 THEN
    RAISE EXCEPTION 'Invalid limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT u.id,
    (SELECT count(*) FROM spark.posts p WHERE p.author_user_id = u.id AND p.moderation_status = 'hidden'),
    (SELECT count(*) FROM spark.post_comments c WHERE c.author_user_id = u.id AND c.moderation_status = 'hidden'),
    (SELECT count(*) FROM spark.content_reports r
      LEFT JOIN spark.posts p ON p.id = r.post_id AND p.tenant_id = r.tenant_id
      LEFT JOIN spark.post_comments c ON c.id = r.comment_id AND c.tenant_id = r.tenant_id
      WHERE coalesce(c.author_user_id, p.author_user_id) = u.id)
  FROM unnest(p_users) AS u(id);
END $$;
--> statement-breakpoint
-- Context a moderator needs to decide one report: who wrote the content and their history.
CREATE FUNCTION spark.staff_report_context(p_report uuid)
RETURNS TABLE(author_id uuid, author_name text, author_status text, author_joined timestamptz, author_reports bigint, author_hidden bigint,
  community_open_reports bigint, reporter_reports bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE report spark.content_reports%ROWTYPE; author uuid;
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin','content_moderator']);
  SELECT * INTO report FROM spark.content_reports r WHERE r.id = p_report;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT coalesce(
    (SELECT c.author_user_id FROM spark.post_comments c WHERE c.id = report.comment_id AND c.tenant_id = report.tenant_id),
    (SELECT p.author_user_id FROM spark.posts p WHERE p.id = report.post_id AND p.tenant_id = report.tenant_id)) INTO author;
  RETURN QUERY
  SELECT author, u.display_name, u.status, u.created_at,
    (SELECT count(*) FROM spark.content_reports r
      LEFT JOIN spark.posts p ON p.id = r.post_id AND p.tenant_id = r.tenant_id
      LEFT JOIN spark.post_comments c ON c.id = r.comment_id AND c.tenant_id = r.tenant_id
      WHERE coalesce(c.author_user_id, p.author_user_id) = author),
    (SELECT count(*) FROM spark.posts p WHERE p.author_user_id = author AND p.moderation_status = 'hidden')
      + (SELECT count(*) FROM spark.post_comments c WHERE c.author_user_id = author AND c.moderation_status = 'hidden'),
    (SELECT count(*) FROM spark.content_reports r WHERE r.community_id = report.community_id AND r.status IN ('open','reviewing')),
    (SELECT count(*) FROM spark.content_reports r WHERE r.reporter_user_id = report.reporter_user_id)
  FROM (SELECT 1) AS one LEFT JOIN spark.users u ON u.id = author;
END $$;
--> statement-breakpoint
-- Report flow over the range plus queue health.
CREATE FUNCTION spark.staff_report_stats(p_days integer)
RETURNS TABLE(opened bigint, closed bigint, backlog bigint, median_hours_to_close numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE since timestamptz;
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin','content_moderator']);
  PERFORM spark.require_range(p_days, 7, 365, 'Invalid range');
  since := now() - make_interval(days => p_days);
  RETURN QUERY SELECT
    (SELECT count(*) FROM spark.content_reports r WHERE r.created_at >= since),
    (SELECT count(*) FROM spark.content_reports r WHERE r.resolved_at >= since),
    (SELECT count(*) FROM spark.content_reports r WHERE r.status IN ('open','reviewing')),
    (SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.resolved_at - r.created_at)) / 3600)::numeric, 1)
       FROM spark.content_reports r WHERE r.resolved_at >= since);
END $$;
--> statement-breakpoint
-- Monthly-normalized recurring amount of a price, in minor units.
CREATE FUNCTION spark.monthly_minor(p_amount bigint, p_interval text, p_count integer) RETURNS bigint
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE p_interval WHEN 'month' THEN round(p_amount::numeric / p_count) WHEN 'year' THEN round(p_amount::numeric / (12 * p_count)) END::bigint;
$$;
REVOKE ALL ON FUNCTION spark.monthly_minor(bigint,text,integer) FROM PUBLIC;
--> statement-breakpoint
-- Subscription counts that do not depend on currency.
CREATE FUNCTION spark.staff_billing_counts()
RETURNS TABLE(free_workspaces bigint, trialing bigint, paying bigint, past_due bigint, cancelled_30d bigint, new_paid_30d bigint, failed_payments_30d bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin']);
  RETURN QUERY SELECT
    (SELECT count(*) FROM spark.subscriptions s WHERE s.billing_kind = 'free' AND s.status IN ('active','trialing')),
    (SELECT count(*) FROM spark.subscriptions s WHERE s.billing_kind = 'paid' AND s.status = 'trialing'),
    (SELECT count(*) FROM spark.subscriptions s WHERE s.billing_kind = 'paid' AND s.status = 'active'),
    (SELECT count(*) FROM spark.subscriptions s WHERE s.billing_kind = 'paid' AND s.status = 'past_due'),
    (SELECT count(*) FROM spark.subscriptions s WHERE s.billing_kind = 'paid' AND s.cancelled_at >= now() - interval '30 days'
       AND s.cancelled_at > greatest(s.created_at, coalesce(s.trial_ends_at, s.created_at))),
    (SELECT count(*) FROM spark.subscriptions s WHERE s.billing_kind = 'paid' AND s.status IN ('active','past_due')
       AND greatest(s.created_at, coalesce(s.trial_ends_at, s.created_at)) >= now() - interval '30 days'),
    (SELECT count(*) FROM spark.payment_events e WHERE e.status = 'failed' AND e.received_at >= now() - interval '30 days');
END $$;
--> statement-breakpoint
-- Revenue figures per currency. MRR counts active and past-due paid subscriptions at their current price.
CREATE FUNCTION spark.staff_billing_revenue()
RETURNS TABLE(currency text, mrr_minor bigint, collected_30d_minor bigint, open_minor bigint, uncollectible_minor bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin']);
  RETURN QUERY
  WITH mrr AS (
    SELECT pr.currency, sum(spark.monthly_minor(pr.amount_minor, pr.billing_interval, pr.interval_count))::bigint AS n
    FROM spark.subscriptions s JOIN spark.plan_prices pr ON pr.id = s.price_id
    WHERE s.billing_kind = 'paid' AND s.status IN ('active','past_due') GROUP BY pr.currency
  ),
  inv AS (
    SELECT i.currency,
      sum(i.total_minor) FILTER (WHERE i.status = 'paid' AND i.paid_at >= now() - interval '30 days')::bigint AS collected,
      sum(i.total_minor) FILTER (WHERE i.status = 'open')::bigint AS open_total,
      sum(i.total_minor) FILTER (WHERE i.status = 'uncollectible')::bigint AS lost
    FROM spark.invoices i GROUP BY i.currency
  ),
  currencies AS (SELECT mrr.currency FROM mrr UNION SELECT inv.currency FROM inv)
  SELECT c.currency, coalesce(mrr.n, 0), coalesce(inv.collected, 0), coalesce(inv.open_total, 0), coalesce(inv.lost, 0)
  FROM currencies c LEFT JOIN mrr ON mrr.currency = c.currency LEFT JOIN inv ON inv.currency = c.currency
  ORDER BY coalesce(mrr.n, 0) DESC, c.currency;
END $$;
--> statement-breakpoint
-- Month-end MRR, new and churned paid subscriptions per month, oldest first. A subscription counts
-- from the end of its trial (or its creation) until it is cancelled, at its current price; plan
-- changes are not versioned yet, so historical months use today's price.
CREATE FUNCTION spark.staff_billing_mrr_series(p_months integer)
RETURNS TABLE(month date, currency text, mrr_minor bigint, new_paid bigint, churned bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE first_month date;
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin']);
  PERFORM spark.require_range(p_months, 3, 24, 'Invalid range');
  first_month := (date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => p_months - 1))::date;
  RETURN QUERY
  WITH months AS (SELECT gs::date AS m FROM generate_series(first_month::timestamp, date_trunc('month', now() AT TIME ZONE 'UTC'), interval '1 month') gs),
  paid AS (
    SELECT x.currency, x.monthly, x.starts, x.ends FROM (
      SELECT pr.currency, spark.monthly_minor(pr.amount_minor, pr.billing_interval, pr.interval_count) AS monthly,
        greatest(s.created_at, coalesce(s.trial_ends_at, s.created_at)) AS starts,
        CASE WHEN s.status IN ('active','past_due') THEN NULL ELSE coalesce(s.cancelled_at, s.period_end, s.updated_at) END AS ends
      FROM spark.subscriptions s JOIN spark.plan_prices pr ON pr.id = s.price_id
      WHERE s.billing_kind = 'paid' AND s.status IN ('active','past_due','cancelled','expired')
    ) x WHERE x.ends IS NULL OR x.ends > x.starts
  ),
  currencies AS (SELECT DISTINCT paid.currency FROM paid)
  SELECT mo.m, cu.currency,
    coalesce((SELECT sum(p.monthly) FROM paid p WHERE p.currency = cu.currency
      AND p.starts < ((mo.m + interval '1 month')::timestamp AT TIME ZONE 'UTC')
      AND (p.ends IS NULL OR p.ends >= ((mo.m + interval '1 month')::timestamp AT TIME ZONE 'UTC'))), 0)::bigint,
    (SELECT count(*) FROM paid p WHERE p.currency = cu.currency
      AND p.starts >= (mo.m::timestamp AT TIME ZONE 'UTC') AND p.starts < ((mo.m + interval '1 month')::timestamp AT TIME ZONE 'UTC')),
    (SELECT count(*) FROM paid p WHERE p.currency = cu.currency
      AND p.ends >= (mo.m::timestamp AT TIME ZONE 'UTC') AND p.ends < ((mo.m + interval '1 month')::timestamp AT TIME ZONE 'UTC'))
  FROM months mo CROSS JOIN currencies cu
  ORDER BY mo.m, cu.currency;
END $$;
--> statement-breakpoint
-- Live subscriptions (not cancelled or expired) per plan, with their monthly value.
CREATE FUNCTION spark.staff_billing_plan_mix()
RETURNS TABLE(plan_code text, plan_name text, billing_kind text, subscriptions bigint, currency text, mrr_minor bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin']);
  RETURN QUERY
  SELECT pl.code, pl.name, pl.billing_kind, count(s.id), pr.currency,
    coalesce(sum(spark.monthly_minor(pr.amount_minor, pr.billing_interval, pr.interval_count)) FILTER (WHERE s.status IN ('active','past_due')), 0)::bigint
  FROM spark.subscription_plans pl
  LEFT JOIN spark.subscriptions s ON s.plan_id = pl.id AND s.status IN ('trialing','active','past_due','paused')
  LEFT JOIN spark.plan_prices pr ON pr.id = s.price_id
  GROUP BY pl.id, pl.code, pl.name, pl.billing_kind, pr.currency
  ORDER BY count(s.id) DESC, pl.name, pr.currency;
END $$;
--> statement-breakpoint
-- Keyset-paged subscriptions, newest first. p_status / p_kind NULL list every status / plan kind.
-- mrr_minor is the subscription's monthly value only while it is billed (active or past due).
CREATE FUNCTION spark.staff_list_subscriptions(p_status text, p_kind text, p_before_ts timestamptz, p_before_id uuid, p_limit integer)
RETURNS TABLE(id uuid, created_at timestamptz, workspace_id uuid, workspace_name text, workspace_slug text, plan_code text, plan_name text,
  billing_kind text, status text, billing_interval text, amount_minor bigint, currency text, mrr_minor bigint, period_end timestamptz,
  trial_ends_at timestamptz, cancel_at_period_end boolean, cancelled_at timestamptz, provider text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin']);
  PERFORM spark.require_range(p_limit, 1, 101, 'Invalid limit');
  IF p_status IS NOT NULL AND p_status NOT IN ('incomplete','trialing','active','past_due','paused','cancelled','expired') THEN
    RAISE EXCEPTION 'Invalid subscription status' USING ERRCODE = '22023';
  END IF;
  IF p_kind IS NOT NULL AND p_kind NOT IN ('free','paid') THEN RAISE EXCEPTION 'Invalid plan kind' USING ERRCODE = '22023'; END IF;
  IF (p_before_ts IS NULL) <> (p_before_id IS NULL) THEN RAISE EXCEPTION 'Invalid cursor' USING ERRCODE = '22023'; END IF;
  RETURN QUERY
  SELECT s.id, s.created_at, w.id, w.name, w.slug, pl.code, pl.name, s.billing_kind, s.status, pr.billing_interval, pr.amount_minor, pr.currency,
    CASE WHEN pr.id IS NULL OR s.status NOT IN ('active','past_due') THEN 0 ELSE spark.monthly_minor(pr.amount_minor, pr.billing_interval, pr.interval_count) END,
    s.period_end, s.trial_ends_at, s.cancel_at_period_end, s.cancelled_at, s.provider
  FROM spark.subscriptions s
  JOIN spark.workspaces w ON w.id = s.tenant_id
  JOIN spark.subscription_plans pl ON pl.id = s.plan_id
  LEFT JOIN spark.plan_prices pr ON pr.id = s.price_id
  WHERE (p_status IS NULL OR s.status = p_status)
    AND (p_kind IS NULL OR s.billing_kind = p_kind)
    AND (p_before_ts IS NULL OR (s.created_at, s.id) < (p_before_ts, p_before_id))
  ORDER BY s.created_at DESC, s.id DESC
  LIMIT p_limit;
END $$;
--> statement-breakpoint
-- Keyset-paged invoices, newest first by issue date. p_status NULL lists every status.
CREATE FUNCTION spark.staff_list_invoices(p_status text, p_before_ts timestamptz, p_before_id uuid, p_limit integer)
RETURNS TABLE(id uuid, issued_at timestamptz, workspace_id uuid, workspace_name text, plan_name text, status text, currency text,
  subtotal_minor bigint, discount_minor bigint, tax_minor bigint, total_minor bigint, due_at timestamptz, paid_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin']);
  PERFORM spark.require_range(p_limit, 1, 101, 'Invalid limit');
  IF p_status IS NOT NULL AND p_status NOT IN ('draft','open','paid','void','uncollectible') THEN
    RAISE EXCEPTION 'Invalid invoice status' USING ERRCODE = '22023';
  END IF;
  IF (p_before_ts IS NULL) <> (p_before_id IS NULL) THEN RAISE EXCEPTION 'Invalid cursor' USING ERRCODE = '22023'; END IF;
  RETURN QUERY
  SELECT i.id, i.issued_at, w.id, w.name, pl.name, i.status, i.currency, i.subtotal_minor, i.discount_minor, i.tax_minor, i.total_minor, i.due_at, i.paid_at
  FROM spark.invoices i
  JOIN spark.workspaces w ON w.id = i.tenant_id
  JOIN spark.subscriptions s ON s.id = i.subscription_id AND s.tenant_id = i.tenant_id
  JOIN spark.subscription_plans pl ON pl.id = s.plan_id
  WHERE (p_status IS NULL OR i.status = p_status)
    AND (p_before_ts IS NULL OR (i.issued_at, i.id) < (p_before_ts, p_before_id))
  ORDER BY i.issued_at DESC, i.id DESC
  LIMIT p_limit;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.staff_activity_series(integer), spark.staff_active_user_totals(), spark.staff_engagement_heatmap(integer),
  spark.staff_retention_cohorts(integer), spark.staff_top_communities(integer,integer), spark.staff_community_health(uuid[]),
  spark.staff_community_series(uuid,integer), spark.staff_user_activity(uuid,integer), spark.staff_user_sessions(uuid,integer),
  spark.staff_user_risk(uuid[]), spark.staff_report_context(uuid), spark.staff_report_stats(integer), spark.staff_billing_counts(),
  spark.staff_billing_revenue(), spark.staff_billing_mrr_series(integer), spark.staff_billing_plan_mix(),
  spark.staff_list_subscriptions(text,text,timestamptz,uuid,integer), spark.staff_list_invoices(text,timestamptz,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION spark.staff_activity_series(integer), spark.staff_active_user_totals(), spark.staff_engagement_heatmap(integer),
  spark.staff_retention_cohorts(integer), spark.staff_top_communities(integer,integer), spark.staff_community_health(uuid[]),
  spark.staff_community_series(uuid,integer), spark.staff_user_activity(uuid,integer), spark.staff_user_sessions(uuid,integer),
  spark.staff_user_risk(uuid[]), spark.staff_report_context(uuid), spark.staff_report_stats(integer), spark.staff_billing_counts(),
  spark.staff_billing_revenue(), spark.staff_billing_mrr_series(integer), spark.staff_billing_plan_mix(),
  spark.staff_list_subscriptions(text,text,timestamptz,uuid,integer), spark.staff_list_invoices(text,timestamptz,uuid,integer) TO spark_app;
