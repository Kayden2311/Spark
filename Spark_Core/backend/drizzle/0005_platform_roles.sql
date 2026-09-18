ALTER TABLE spark.platform_role_assignments DROP CONSTRAINT IF EXISTS platform_role_assignments_role_allowed;--> statement-breakpoint
ALTER TABLE spark.platform_role_assignments ADD CONSTRAINT platform_role_assignments_role_allowed CHECK (role IN ('super_admin', 'platform_admin', 'community_moderator', 'content_moderator', 'campaign_moderator'));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON spark.users TO spark_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON spark.user_emails TO spark_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON spark.password_credentials TO spark_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON spark.workspaces TO spark_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON spark.workspace_memberships TO spark_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON spark.sessions TO spark_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON spark.account_tokens TO spark_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON spark.auth_identities TO spark_app;--> statement-breakpoint
GRANT SELECT, INSERT ON spark.platform_role_assignments TO spark_app;--> statement-breakpoint
CREATE POLICY user_emails_spark_app_select ON spark.user_emails FOR SELECT TO spark_app USING (true);--> statement-breakpoint
CREATE POLICY user_emails_spark_app_insert ON spark.user_emails FOR INSERT TO spark_app WITH CHECK (true);--> statement-breakpoint
CREATE POLICY user_emails_spark_app_update ON spark.user_emails FOR UPDATE TO spark_app USING (true);--> statement-breakpoint
CREATE POLICY password_credentials_spark_app_select ON spark.password_credentials FOR SELECT TO spark_app USING (true);--> statement-breakpoint
CREATE POLICY password_credentials_spark_app_insert ON spark.password_credentials FOR INSERT TO spark_app WITH CHECK (true);--> statement-breakpoint
CREATE POLICY password_credentials_spark_app_update ON spark.password_credentials FOR UPDATE TO spark_app USING (true);--> statement-breakpoint
CREATE POLICY users_spark_app_insert ON spark.users FOR INSERT TO spark_app WITH CHECK (true);--> statement-breakpoint
CREATE POLICY users_spark_app_update ON spark.users FOR UPDATE TO spark_app USING (true);--> statement-breakpoint
CREATE POLICY workspaces_spark_app_insert ON spark.workspaces FOR INSERT TO spark_app WITH CHECK (true);--> statement-breakpoint
CREATE POLICY workspaces_spark_app_update ON spark.workspaces FOR UPDATE TO spark_app USING (true);--> statement-breakpoint
CREATE POLICY workspace_memberships_spark_app_insert ON spark.workspace_memberships FOR INSERT TO spark_app WITH CHECK (true);--> statement-breakpoint
CREATE POLICY workspace_memberships_spark_app_update ON spark.workspace_memberships FOR UPDATE TO spark_app USING (true);--> statement-breakpoint
CREATE POLICY sessions_spark_app_all ON spark.sessions FOR ALL TO spark_app USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY account_tokens_spark_app_all ON spark.account_tokens FOR ALL TO spark_app USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY auth_identities_spark_app_all ON spark.auth_identities FOR ALL TO spark_app USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON spark.content_reports TO spark_app;--> statement-breakpoint
GRANT SELECT, INSERT ON spark.moderation_actions TO spark_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON spark.posts TO spark_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON spark.post_comments TO spark_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON spark.communities TO spark_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON spark.promotion_campaigns TO spark_app;--> statement-breakpoint
GRANT SELECT, INSERT ON spark.promotion_reviews TO spark_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON spark.platform_role_assignments TO spark_app;--> statement-breakpoint
CREATE POLICY content_reports_spark_app_all ON spark.content_reports FOR ALL TO spark_app USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY moderation_actions_spark_app_all ON spark.moderation_actions FOR ALL TO spark_app USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY posts_spark_app_update ON spark.posts FOR UPDATE TO spark_app USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY post_comments_spark_app_update ON spark.post_comments FOR UPDATE TO spark_app USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY communities_spark_app_update ON spark.communities FOR UPDATE TO spark_app USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY promotion_campaigns_spark_app_all ON spark.promotion_campaigns FOR ALL TO spark_app USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY promotion_reviews_spark_app_all ON spark.promotion_reviews FOR ALL TO spark_app USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY platform_role_assignments_spark_app_update ON spark.platform_role_assignments FOR UPDATE TO spark_app USING (true);--> statement-breakpoint
CREATE POLICY platform_role_assignments_spark_app_insert ON spark.platform_role_assignments FOR INSERT TO spark_app WITH CHECK (true);--> statement-breakpoint
CREATE POLICY users_spark_app_select ON spark.users FOR SELECT TO spark_app USING (true);--> statement-breakpoint
CREATE POLICY workspaces_spark_app_select ON spark.workspaces FOR SELECT TO spark_app USING (true);--> statement-breakpoint
CREATE POLICY workspace_memberships_spark_app_select ON spark.workspace_memberships FOR SELECT TO spark_app USING (true);
