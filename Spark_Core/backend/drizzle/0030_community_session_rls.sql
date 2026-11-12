-- Bind community row access to the live session and add the discovery projections.
-- The 0002/0004 community helpers trusted the transaction-local settings spark.user_id and
-- spark.tenant_id, which any runtime caller can set. Every community read now resolves the actor
-- through spark.session_actor() (0006): without a live session it is NULL and only public data is
-- visible. Community managers are the active community owners and moderators and the active owners
-- and admins of the host workspace.
--
-- Normalized community fields for filtering: a required tagline, a fixed stage code, an upper-case
-- country code and a trimmed city. communities gets settings_version for later optimistic writes but
-- no version column: staff_moderate_community (0009) updates communities without bumping one and
-- maintain_record would reject it.
ALTER TABLE spark.communities ADD COLUMN tagline text, ADD COLUMN settings_version integer NOT NULL DEFAULT 1;
-- The deferred community_owner check would otherwise leave trigger events pending, and ALTER TABLE
-- refuses a table with pending events. Checking each backfilled row at once is equivalent.
SET CONSTRAINTS spark.community_owner IMMEDIATE;
UPDATE spark.communities SET
  tagline = coalesce(nullif(btrim(left(btrim(description), 90)), ''), btrim(left(btrim(name), 90))),
  stage = CASE lower(btrim(coalesce(stage, '')))
    WHEN 'idea' THEN 'idea'
    WHEN 'pre-seed' THEN 'pre_seed' WHEN 'pre_seed' THEN 'pre_seed' WHEN 'preseed' THEN 'pre_seed'
    WHEN 'seed' THEN 'seed'
    WHEN 'series a' THEN 'series_a' WHEN 'series_a' THEN 'series_a'
    WHEN 'growth' THEN 'growth'
    ELSE 'any' END,
  country_code = CASE WHEN upper(btrim(country_code)) ~ '^[A-Z]{2}$' THEN upper(btrim(country_code)) END,
  city = nullif(btrim(left(btrim(city), 80)), '');
SET CONSTRAINTS spark.community_owner DEFERRED;
ALTER TABLE spark.communities
  ALTER COLUMN tagline SET NOT NULL,
  ALTER COLUMN stage SET DEFAULT 'any',
  ALTER COLUMN stage SET NOT NULL,
  ADD CONSTRAINT communities_tagline_length CHECK (tagline = btrim(tagline) AND length(tagline) BETWEEN 1 AND 90),
  ADD CONSTRAINT communities_stage_allowed CHECK (stage IN ('idea','pre_seed','seed','series_a','growth','any')),
  ADD CONSTRAINT communities_country_code_format CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT communities_city_length CHECK (city IS NULL OR (city = btrim(city) AND length(city) BETWEEN 1 AND 80)),
  ADD CONSTRAINT communities_settings_version_positive CHECK (settings_version > 0);
-- Discovery order and keyset.
CREATE INDEX communities_discovery_name_idx ON spark.communities (lower(name), id) WHERE archived_at IS NULL;
--> statement-breakpoint
-- The fixed topic set. Older rows (for example demo topics) are kept; they never match a filter.
INSERT INTO spark.topics (slug, name) VALUES
  ('b2b-saas', 'B2B SaaS'), ('climate-tech', 'Climate Tech'), ('ai-data', 'AI & Data'),
  ('product', 'Product'), ('fintech', 'FinTech'), ('founders', 'Founders Circle')
ON CONFLICT (slug) DO NOTHING;
--> statement-breakpoint
-- Same signature as 0002: the session actor holds an active membership with an allowed role in an
-- active, non-archived community whose host workspace is active. False without a live session.
CREATE OR REPLACE FUNCTION spark.is_community_member(target_tenant uuid, target_community uuid, allowed_roles text[] DEFAULT ARRAY['owner','moderator','member']) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM spark.community_memberships m
    JOIN spark.communities c ON c.id = m.community_id AND c.tenant_id = m.tenant_id
    JOIN spark.workspaces w ON w.id = c.tenant_id
    WHERE m.tenant_id = target_tenant AND m.community_id = target_community
      AND m.user_id = spark.session_actor() AND m.status = 'active' AND m.role = ANY(allowed_roles)
      AND c.archived_at IS NULL AND w.status = 'active' AND w.archived_at IS NULL);
$$;
--> statement-breakpoint
-- Community owner or moderator, or owner or admin of the host workspace, of an active, non-archived
-- community whose host workspace is active. False without a live session.
CREATE FUNCTION spark.can_manage_community(p_community uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM spark.communities c JOIN spark.workspaces w ON w.id = c.tenant_id
    CROSS JOIN (SELECT spark.session_actor() AS id) actor
    WHERE c.id = p_community AND c.archived_at IS NULL AND w.status = 'active' AND w.archived_at IS NULL AND actor.id IS NOT NULL
      AND (EXISTS (SELECT 1 FROM spark.community_memberships m
          WHERE m.tenant_id = c.tenant_id AND m.community_id = c.id AND m.user_id = actor.id
            AND m.status = 'active' AND m.role IN ('owner','moderator'))
        OR EXISTS (SELECT 1 FROM spark.workspace_memberships wm
          WHERE wm.tenant_id = c.tenant_id AND wm.user_id = actor.id AND wm.status = 'active' AND wm.role IN ('owner','admin'))));
$$;
--> statement-breakpoint
-- Community metadata: public and private communities are listed for everyone; hidden ones only for
-- their members and managers. Archived communities and communities of inactive workspaces never.
CREATE OR REPLACE FUNCTION spark.can_read_community(target_tenant uuid, target_community uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM spark.communities c JOIN spark.workspaces w ON w.id = c.tenant_id
    WHERE c.id = target_community AND c.tenant_id = target_tenant AND c.archived_at IS NULL
      AND w.status = 'active' AND w.archived_at IS NULL
      AND (c.visibility IN ('public','private') OR spark.is_community_member(c.tenant_id, c.id) OR spark.can_manage_community(c.id)));
$$;
--> statement-breakpoint
-- Unchanged rule from 0004, now session-bound: members read public and members posts; moderated
-- posts only for community owners and moderators.
CREATE OR REPLACE FUNCTION spark.can_read_post(target_tenant uuid, target_post uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM spark.posts p
    WHERE p.id = target_post AND p.tenant_id = target_tenant AND p.deleted_at IS NULL
      AND p.visibility IN ('public','members')
      AND spark.is_community_member(p.tenant_id, p.community_id)
      AND (p.moderation_status = 'visible' OR spark.is_community_member(p.tenant_id, p.community_id, ARRAY['owner','moderator'])));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.can_manage_community(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION spark.can_manage_community(uuid) TO spark_app;
--> statement-breakpoint
DROP POLICY community_read ON spark.communities;
CREATE POLICY community_read ON spark.communities FOR SELECT TO spark_app
  USING (spark.can_read_community(tenant_id, id));
DROP POLICY community_members_read ON spark.community_memberships;
CREATE POLICY community_members_read ON spark.community_memberships FOR SELECT TO spark_app
  USING (spark.is_community_member(tenant_id, community_id) OR spark.can_manage_community(community_id));
CREATE POLICY community_topics_read ON spark.community_topics FOR SELECT TO spark_app
  USING (spark.can_read_community(tenant_id, community_id));
CREATE POLICY join_requests_read ON spark.community_join_requests FOR SELECT TO spark_app
  USING (spark.is_session_user(user_id) OR spark.can_manage_community(community_id));
-- Public reference data.
CREATE POLICY topics_read ON spark.topics FOR SELECT TO spark_app USING (true);
GRANT SELECT ON spark.community_topics, spark.community_join_requests, spark.topics TO spark_app;
--> statement-breakpoint
-- Internal: the fixed topic codes in display order.
CREATE FUNCTION spark.community_topic_codes() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY['b2b-saas','climate-tech','ai-data','product','fintech','founders']::text[];
$$;
--> statement-breakpoint
-- Internal: the communities p_actor may discover (NULL = signed out). Public ones for everyone;
-- private ones for any signed-in user; hidden ones for their active members. Never archived ones
-- or those of an inactive host workspace. Callers pass the actor from spark.session_actor().
CREATE FUNCTION spark.discoverable_communities(p_actor uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT c.id FROM spark.communities c JOIN spark.workspaces w ON w.id = c.tenant_id
  WHERE c.archived_at IS NULL AND w.status = 'active' AND w.archived_at IS NULL
    AND (c.visibility = 'public'
      OR (p_actor IS NOT NULL AND (c.visibility = 'private'
        OR EXISTS (SELECT 1 FROM spark.community_memberships m
          WHERE m.tenant_id = c.tenant_id AND m.community_id = c.id AND m.user_id = p_actor AND m.status = 'active'))));
$$;
--> statement-breakpoint
-- Internal: the card columns of the given communities as seen by p_actor (NULL = signed out). It does
-- not filter by visibility: callers pass only ids the actor may see. Shared by discovery and the later
-- member and workspace listings. topics lists the fixed topic codes in display order; member_count
-- counts active memberships; weekly_posts counts visible, non-deleted posts and comments of the last
-- seven days; viewer_status is the actor's active role, 'pending' for an open join request, else
-- 'none' (NULL when signed out).
CREATE FUNCTION spark.community_cards(p_actor uuid, p_communities uuid[])
RETURNS TABLE(id uuid, slug text, name text, tagline text, visibility text, country_code text, city text, stage text, topics text[],
  member_count bigint, weekly_posts bigint, featured boolean, frozen boolean, host_workspace_name text, viewer_status text)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT c.id, c.slug, c.name, c.tagline, c.visibility, c.country_code, c.city, c.stage,
    ARRAY(SELECT t.slug FROM spark.community_topics ct JOIN spark.topics t ON t.id = ct.topic_id
      WHERE ct.tenant_id = c.tenant_id AND ct.community_id = c.id AND t.slug = ANY (spark.community_topic_codes())
      ORDER BY array_position(spark.community_topic_codes(), t.slug)),
    (SELECT count(*) FROM spark.community_memberships m WHERE m.tenant_id = c.tenant_id AND m.community_id = c.id AND m.status = 'active'),
    (SELECT count(*) FROM spark.posts p WHERE p.tenant_id = c.tenant_id AND p.community_id = c.id
        AND p.deleted_at IS NULL AND p.moderation_status = 'visible' AND p.created_at > now() - interval '7 days')
      + (SELECT count(*) FROM spark.post_comments pc WHERE pc.tenant_id = c.tenant_id AND pc.community_id = c.id
        AND pc.deleted_at IS NULL AND pc.moderation_status = 'visible' AND pc.created_at > now() - interval '7 days'),
    c.featured_at IS NOT NULL, c.frozen_at IS NOT NULL, w.name,
    CASE WHEN p_actor IS NOT NULL THEN coalesce(
      (SELECT m.role FROM spark.community_memberships m
        WHERE m.tenant_id = c.tenant_id AND m.community_id = c.id AND m.user_id = p_actor AND m.status = 'active'),
      CASE WHEN EXISTS (SELECT 1 FROM spark.community_join_requests r
        WHERE r.tenant_id = c.tenant_id AND r.community_id = c.id AND r.user_id = p_actor AND r.status = 'pending') THEN 'pending' ELSE 'none' END) END
  FROM spark.communities c JOIN spark.workspaces w ON w.id = c.tenant_id
  WHERE c.id = ANY (p_communities);
$$;
--> statement-breakpoint
-- Search and filter the communities the caller can discover, with or without a session. p_query is
-- trimmed (at most 100 characters) and matched case-insensitively, as a literal substring, against the
-- name, the tagline and the names of the fixed topics. Filters combine with AND. Ordered by
-- (lower(name), id); the keyset cursor is the last row's (name, id). Returns up to p_limit + 1 rows so
-- the caller can tell whether another page exists.
CREATE FUNCTION spark.discover_communities(p_query text, p_topic text, p_country text, p_stage text, p_after_name text, p_after_id uuid, p_limit integer)
RETURNS TABLE(id uuid, slug text, name text, tagline text, visibility text, country_code text, city text, stage text, topics text[],
  member_count bigint, weekly_posts bigint, featured boolean, frozen boolean, host_workspace_name text, viewer_status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.session_actor(); search text := nullif(btrim(p_query), ''); pattern text;
BEGIN
  IF length(search) > 100 THEN RAISE EXCEPTION 'Invalid community search' USING ERRCODE = '22023'; END IF;
  IF p_topic IS NOT NULL AND NOT p_topic = ANY (spark.community_topic_codes()) THEN
    RAISE EXCEPTION 'Invalid community topics' USING ERRCODE = '22023';
  END IF;
  IF p_stage IS NOT NULL AND p_stage NOT IN ('idea','pre_seed','seed','series_a','growth','any') THEN
    RAISE EXCEPTION 'Invalid community stage' USING ERRCODE = '22023';
  END IF;
  IF p_country IS NOT NULL AND p_country !~ '^[A-Z]{2}$' THEN RAISE EXCEPTION 'Invalid community location' USING ERRCODE = '22023'; END IF;
  IF (p_after_name IS NULL) <> (p_after_id IS NULL) THEN RAISE EXCEPTION 'Invalid community cursor' USING ERRCODE = '22023'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Invalid community limit' USING ERRCODE = '22023'; END IF;
  pattern := '%' || replace(replace(replace(search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  RETURN QUERY
  SELECT card.* FROM spark.community_cards(actor, ARRAY(
    SELECT c.id FROM spark.communities c
    WHERE c.id IN (SELECT spark.discoverable_communities(actor))
      AND (p_stage IS NULL OR c.stage = p_stage)
      AND (p_country IS NULL OR c.country_code = p_country)
      AND (p_topic IS NULL OR EXISTS (SELECT 1 FROM spark.community_topics ct JOIN spark.topics t ON t.id = ct.topic_id
        WHERE ct.tenant_id = c.tenant_id AND ct.community_id = c.id AND t.slug = p_topic))
      AND (search IS NULL OR c.name ILIKE pattern ESCAPE '\' OR c.tagline ILIKE pattern ESCAPE '\'
        OR EXISTS (SELECT 1 FROM spark.community_topics ct JOIN spark.topics t ON t.id = ct.topic_id
          WHERE ct.tenant_id = c.tenant_id AND ct.community_id = c.id AND t.slug = ANY (spark.community_topic_codes())
            AND t.name ILIKE pattern ESCAPE '\'))
      AND (p_after_id IS NULL OR (lower(c.name), c.id) > (lower(p_after_name), p_after_id))
    ORDER BY lower(c.name), c.id
    LIMIT p_limit + 1)) card
  ORDER BY lower(card.name), card.id;
END $$;
--> statement-breakpoint
-- One community page by slug, with or without a session: the card columns plus the description,
-- creation time, settings version and whether the caller manages it. Hidden communities return no
-- row unless the caller is a member or manager, exactly like an unknown, archived or inactive one.
CREATE FUNCTION spark.community_by_slug(p_slug text)
RETURNS TABLE(id uuid, slug text, name text, tagline text, visibility text, country_code text, city text, stage text, topics text[],
  member_count bigint, weekly_posts bigint, featured boolean, frozen boolean, host_workspace_name text, viewer_status text,
  description text, created_at timestamptz, settings_version integer, can_manage boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.session_actor(); target spark.communities%ROWTYPE; manager boolean;
BEGIN
  SELECT c.* INTO target FROM spark.communities c JOIN spark.workspaces w ON w.id = c.tenant_id
    WHERE c.slug = p_slug AND c.archived_at IS NULL AND w.status = 'active' AND w.archived_at IS NULL;
  IF NOT FOUND THEN RETURN; END IF;
  manager := spark.can_manage_community(target.id);
  IF target.visibility = 'hidden' AND NOT manager AND NOT spark.is_community_member(target.tenant_id, target.id) THEN RETURN; END IF;
  RETURN QUERY
  SELECT card.*, target.description, target.created_at, target.settings_version, manager
  FROM spark.community_cards(actor, ARRAY[target.id]) card;
END $$;
--> statement-breakpoint
-- Filter options for discovery: the six topics and six stages (always listed) and the countries
-- present, each counted over the communities the caller can discover.
CREATE FUNCTION spark.community_filter_values()
RETURNS TABLE(kind text, value text, label text, count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH visible AS (
    SELECT c.id, c.tenant_id, c.stage, c.country_code FROM spark.communities c
    WHERE c.id IN (SELECT spark.discoverable_communities(spark.session_actor()))
  ), options AS (
    SELECT 1 AS section, codes.ord AS ord, 'topic'::text AS kind, codes.code AS value, coalesce(t.name, codes.code) AS label,
      (SELECT count(*) FROM visible v WHERE EXISTS (SELECT 1 FROM spark.community_topics ct
        WHERE ct.tenant_id = v.tenant_id AND ct.community_id = v.id AND ct.topic_id = t.id)) AS count
    FROM unnest(spark.community_topic_codes()) WITH ORDINALITY AS codes(code, ord)
    LEFT JOIN spark.topics t ON t.slug = codes.code
    UNION ALL
    SELECT 2, stages.ord, 'stage', stages.code, stages.label, (SELECT count(*) FROM visible v WHERE v.stage = stages.code)
    FROM (VALUES (1, 'idea', 'Idea'), (2, 'pre_seed', 'Pre-seed'), (3, 'seed', 'Seed'), (4, 'series_a', 'Series A'),
      (5, 'growth', 'Growth'), (6, 'any', 'Any stage')) AS stages(ord, code, label)
    UNION ALL
    SELECT 3, 0, 'country', v.country_code, v.country_code, count(*)
    FROM visible v WHERE v.country_code IS NOT NULL GROUP BY v.country_code
  )
  SELECT o.kind, o.value, o.label, o.count FROM options o ORDER BY o.section, o.ord, o.value;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.community_topic_codes(), spark.discoverable_communities(uuid), spark.community_cards(uuid,uuid[]),
  spark.discover_communities(text,text,text,text,text,uuid,integer), spark.community_by_slug(text), spark.community_filter_values() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION spark.discover_communities(text,text,text,text,text,uuid,integer), spark.community_by_slug(text),
  spark.community_filter_values() TO spark_app;
