ALTER TABLE spark.platform_role_assignments DROP CONSTRAINT IF EXISTS platform_role_assignments_role_allowed;--> statement-breakpoint
ALTER TABLE spark.platform_role_assignments ADD CONSTRAINT platform_role_assignments_role_allowed CHECK (role IN ('super_admin', 'platform_admin', 'community_moderator', 'content_moderator', 'campaign_moderator'));
