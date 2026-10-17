-- How reported content looks in the feed, for moderators: the post with its author, time and comment count
-- (visible comments, as members see it), and for a reported comment, the parent post plus the comment itself.
-- Content staff only (same as the queue). A soft-deleted parent post is still returned and flagged, because the
-- moderator needs the context; a deleted author account is returned as no author.
CREATE FUNCTION spark.staff_report_preview(p_report uuid)
RETURNS TABLE(
  post_id uuid, post_title text, post_body text, post_status text, post_created_at timestamptz, post_deleted boolean,
  post_author_id uuid, post_author_name text, post_comment_count bigint,
  comment_id uuid, comment_body text, comment_status text, comment_created_at timestamptz, comment_deleted boolean,
  comment_author_id uuid, comment_author_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE report spark.content_reports%ROWTYPE; target_post uuid;
BEGIN
  PERFORM spark.require_platform_role(ARRAY['super_admin','platform_admin','content_moderator']);
  SELECT * INTO report FROM spark.content_reports r WHERE r.id = p_report;
  IF NOT FOUND THEN RETURN; END IF;
  -- A comment report points at its comment; the comment belongs to a post in the same tenant.
  target_post := coalesce(report.post_id,
    (SELECT c.post_id FROM spark.post_comments c WHERE c.id = report.comment_id AND c.tenant_id = report.tenant_id));
  RETURN QUERY
  SELECT p.id, p.title, p.body, p.moderation_status, p.created_at, p.deleted_at IS NOT NULL,
    pa.id, pa.display_name,
    (SELECT count(*) FROM spark.post_comments x WHERE x.post_id = p.id AND x.tenant_id = p.tenant_id AND x.deleted_at IS NULL AND x.moderation_status = 'visible'),
    c.id, c.body, c.moderation_status, c.created_at, c.deleted_at IS NOT NULL,
    ca.id, ca.display_name
  FROM (SELECT 1) AS one
  LEFT JOIN spark.posts p ON p.id = target_post AND p.tenant_id = report.tenant_id
  LEFT JOIN spark.users pa ON pa.id = p.author_user_id AND pa.deleted_at IS NULL
  LEFT JOIN spark.post_comments c ON c.id = report.comment_id AND c.tenant_id = report.tenant_id
  LEFT JOIN spark.users ca ON ca.id = c.author_user_id AND ca.deleted_at IS NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.staff_report_preview(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION spark.staff_report_preview(uuid) TO spark_app;
