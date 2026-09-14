ALTER TABLE spark."account_tokens" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."account_tokens" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."account_tokens" ADD CONSTRAINT "account_tokens_purpose_allowed" CHECK ("purpose" IN ('verify_email','reset_password'));
--> statement-breakpoint
ALTER TABLE spark."account_tokens" ADD CONSTRAINT "account_tokens_token_hash_length" CHECK (octet_length("token_hash") = 32);
--> statement-breakpoint
ALTER TABLE spark."account_tokens" ADD CONSTRAINT "account_tokens_expiry_order" CHECK (expires_at > created_at);
--> statement-breakpoint
ALTER TABLE spark."audit_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."audit_events" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."audit_events" ADD CONSTRAINT "audit_events_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."audit_events" ADD CONSTRAINT "audit_events_actor_kind_allowed" CHECK ("actor_kind" IN ('user','system'));
--> statement-breakpoint
ALTER TABLE spark."auth_identities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."auth_identities" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."auth_identities" ADD CONSTRAINT "auth_identities_provider_length" CHECK (length(btrim("provider")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."auth_identities" ADD CONSTRAINT "auth_identities_issuer_length" CHECK (length(btrim("issuer")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."auth_identities" ADD CONSTRAINT "auth_identities_provider_subject_length" CHECK (length(btrim("provider_subject")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."billing_customers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."billing_customers" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."billing_customers" ADD CONSTRAINT "billing_customers_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."billing_customers" ADD CONSTRAINT "billing_customers_provider_length" CHECK (length(btrim("provider")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."boards" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."boards" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."boards" ADD CONSTRAINT "boards_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."boards" ADD CONSTRAINT "boards_tenant_id_project_id_id_key" UNIQUE ("tenant_id", "project_id", "id");
--> statement-breakpoint
ALTER TABLE spark."boards" ADD CONSTRAINT "boards_name_length" CHECK (length(btrim("name")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."boards" ADD CONSTRAINT "boards_version_positive" CHECK ("version" > 0);
--> statement-breakpoint
ALTER TABLE spark."calendar_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."calendar_events" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."calendar_events" ADD CONSTRAINT "calendar_events_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."calendar_events" ADD CONSTRAINT "calendar_events_tenant_id_project_id_id_key" UNIQUE ("tenant_id", "project_id", "id");
--> statement-breakpoint
ALTER TABLE spark."calendar_events" ADD CONSTRAINT "calendar_events_title_length" CHECK (length(btrim("title")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."calendar_events" ADD CONSTRAINT "calendar_events_timezone_not_empty" CHECK (length(timezone) BETWEEN 1 AND 100);
--> statement-breakpoint
ALTER TABLE spark."calendar_events" ADD CONSTRAINT "calendar_events_status_allowed" CHECK ("status" IN ('scheduled','cancelled','completed'));
--> statement-breakpoint
ALTER TABLE spark."calendar_events" ADD CONSTRAINT "calendar_events_version_positive" CHECK ("version" > 0);
--> statement-breakpoint
ALTER TABLE spark."communities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."communities" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."communities" ADD CONSTRAINT "communities_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."communities" ADD CONSTRAINT "communities_slug_length" CHECK (length(btrim("slug")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."communities" ADD CONSTRAINT "communities_name_length" CHECK (length(btrim("name")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."communities" ADD CONSTRAINT "communities_visibility_allowed" CHECK ("visibility" IN ('public','private','hidden'));
--> statement-breakpoint
ALTER TABLE spark."community_join_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."community_join_requests" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."community_join_requests" ADD CONSTRAINT "community_join_requests_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."community_join_requests" ADD CONSTRAINT "community_join_requests_tenant_id_community_id_id_key" UNIQUE ("tenant_id", "community_id", "id");
--> statement-breakpoint
ALTER TABLE spark."community_join_requests" ADD CONSTRAINT "community_join_requests_status_allowed" CHECK ("status" IN ('pending','approved','rejected','withdrawn'));
--> statement-breakpoint
ALTER TABLE spark."community_memberships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."community_memberships" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."community_memberships" ADD CONSTRAINT "community_memberships_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."community_memberships" ADD CONSTRAINT "community_memberships_tenant_id_community_id_id_key" UNIQUE ("tenant_id", "community_id", "id");
--> statement-breakpoint
ALTER TABLE spark."community_memberships" ADD CONSTRAINT "community_memberships_role_allowed" CHECK ("role" IN ('owner','moderator','member'));
--> statement-breakpoint
ALTER TABLE spark."community_memberships" ADD CONSTRAINT "community_memberships_status_allowed" CHECK ("status" IN ('active','suspended','left'));
--> statement-breakpoint
ALTER TABLE spark."community_topics" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."community_topics" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."community_topics" ADD CONSTRAINT "community_topics_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."community_topics" ADD CONSTRAINT "community_topics_tenant_id_community_id_id_key" UNIQUE ("tenant_id", "community_id", "id");
--> statement-breakpoint
ALTER TABLE spark."content_reports" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."content_reports" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."content_reports" ADD CONSTRAINT "content_reports_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."content_reports" ADD CONSTRAINT "content_reports_tenant_id_community_id_id_key" UNIQUE ("tenant_id", "community_id", "id");
--> statement-breakpoint
ALTER TABLE spark."content_reports" ADD CONSTRAINT "content_reports_status_allowed" CHECK ("status" IN ('open','reviewing','resolved','dismissed'));
--> statement-breakpoint
ALTER TABLE spark."event_attendees" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."event_attendees" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."event_attendees" ADD CONSTRAINT "event_attendees_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."event_attendees" ADD CONSTRAINT "event_attendees_response_allowed" CHECK ("response" IN ('pending','accepted','declined','tentative'));
--> statement-breakpoint
ALTER TABLE spark."event_reminders" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."event_reminders" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."event_reminders" ADD CONSTRAINT "event_reminders_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."event_reminders" ADD CONSTRAINT "event_reminders_event_version_positive" CHECK ("event_version" > 0);
--> statement-breakpoint
ALTER TABLE spark."event_reminders" ADD CONSTRAINT "event_reminders_minutes_before_nonnegative" CHECK ("minutes_before" >= 0);
--> statement-breakpoint
ALTER TABLE spark."event_reminders" ADD CONSTRAINT "event_reminders_channel_allowed" CHECK ("channel" IN ('in_app','email'));
--> statement-breakpoint
ALTER TABLE spark."event_reminders" ADD CONSTRAINT "event_reminders_status_allowed" CHECK ("status" IN ('pending','queued','sent','cancelled'));
--> statement-breakpoint
ALTER TABLE spark."idempotency_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."idempotency_requests" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."idempotency_requests" ADD CONSTRAINT "idempotency_requests_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."idempotency_requests" ADD CONSTRAINT "idempotency_requests_key_length" CHECK (length(btrim("key")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."idempotency_requests" ADD CONSTRAINT "idempotency_requests_request_hash_length" CHECK (octet_length("request_hash") = 32);
--> statement-breakpoint
ALTER TABLE spark."idempotency_requests" ADD CONSTRAINT "idempotency_requests_state_allowed" CHECK ("state" IN ('started','completed'));
--> statement-breakpoint
ALTER TABLE spark."idempotency_requests" ADD CONSTRAINT "idempotency_requests_expiry_order" CHECK (expires_at > created_at);
--> statement-breakpoint
ALTER TABLE spark."invoices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."invoices" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."invoices" ADD CONSTRAINT "invoices_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."invoices" ADD CONSTRAINT "invoices_provider_length" CHECK (length(btrim("provider")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."invoices" ADD CONSTRAINT "invoices_currency_format" CHECK (currency ~ '^[A-Z]{3}$');
--> statement-breakpoint
ALTER TABLE spark."invoices" ADD CONSTRAINT "invoices_subtotal_minor_nonnegative" CHECK ("subtotal_minor" >= 0);
--> statement-breakpoint
ALTER TABLE spark."invoices" ADD CONSTRAINT "invoices_discount_minor_nonnegative" CHECK ("discount_minor" >= 0);
--> statement-breakpoint
ALTER TABLE spark."invoices" ADD CONSTRAINT "invoices_tax_minor_nonnegative" CHECK ("tax_minor" >= 0);
--> statement-breakpoint
ALTER TABLE spark."invoices" ADD CONSTRAINT "invoices_total_minor_nonnegative" CHECK ("total_minor" >= 0);
--> statement-breakpoint
ALTER TABLE spark."invoices" ADD CONSTRAINT "invoices_status_allowed" CHECK ("status" IN ('draft','open','paid','void','uncollectible'));
--> statement-breakpoint
ALTER TABLE spark."issue_comments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."issue_comments" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."issue_comments" ADD CONSTRAINT "issue_comments_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."issue_comments" ADD CONSTRAINT "issue_comments_tenant_id_project_id_id_key" UNIQUE ("tenant_id", "project_id", "id");
--> statement-breakpoint
ALTER TABLE spark."issue_comments" ADD CONSTRAINT "issue_comments_version_positive" CHECK ("version" > 0);
--> statement-breakpoint
ALTER TABLE spark."issue_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."issue_events" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."issue_events" ADD CONSTRAINT "issue_events_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."issue_events" ADD CONSTRAINT "issue_events_tenant_id_project_id_id_key" UNIQUE ("tenant_id", "project_id", "id");
--> statement-breakpoint
ALTER TABLE spark."issue_events" ADD CONSTRAINT "issue_events_from_version_nonnegative" CHECK ("from_version" >= 0);
--> statement-breakpoint
ALTER TABLE spark."issue_events" ADD CONSTRAINT "issue_events_to_version_positive" CHECK ("to_version" > 0);
--> statement-breakpoint
ALTER TABLE spark."issue_label_links" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."issue_label_links" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."issue_label_links" ADD CONSTRAINT "issue_label_links_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."issue_label_links" ADD CONSTRAINT "issue_label_links_tenant_id_project_id_id_key" UNIQUE ("tenant_id", "project_id", "id");
--> statement-breakpoint
ALTER TABLE spark."issue_labels" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."issue_labels" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."issue_labels" ADD CONSTRAINT "issue_labels_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."issue_labels" ADD CONSTRAINT "issue_labels_tenant_id_project_id_id_key" UNIQUE ("tenant_id", "project_id", "id");
--> statement-breakpoint
ALTER TABLE spark."issue_labels" ADD CONSTRAINT "issue_labels_name_length" CHECK (length(btrim("name")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."issue_links" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."issue_links" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."issue_links" ADD CONSTRAINT "issue_links_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."issue_links" ADD CONSTRAINT "issue_links_tenant_id_project_id_id_key" UNIQUE ("tenant_id", "project_id", "id");
--> statement-breakpoint
ALTER TABLE spark."issue_links" ADD CONSTRAINT "issue_links_type_allowed" CHECK ("type" IN ('blocks','relates_to'));
--> statement-breakpoint
ALTER TABLE spark."issue_statuses" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."issue_statuses" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."issue_statuses" ADD CONSTRAINT "issue_statuses_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."issue_statuses" ADD CONSTRAINT "issue_statuses_tenant_id_project_id_id_key" UNIQUE ("tenant_id", "project_id", "id");
--> statement-breakpoint
ALTER TABLE spark."issue_statuses" ADD CONSTRAINT "issue_statuses_name_length" CHECK (length(btrim("name")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."issue_statuses" ADD CONSTRAINT "issue_statuses_category_allowed" CHECK ("category" IN ('backlog','todo','in_progress','done'));
--> statement-breakpoint
ALTER TABLE spark."issues" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."issues" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."issues" ADD CONSTRAINT "issues_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."issues" ADD CONSTRAINT "issues_tenant_id_project_id_id_key" UNIQUE ("tenant_id", "project_id", "id");
--> statement-breakpoint
ALTER TABLE spark."issues" ADD CONSTRAINT "issues_number_positive" CHECK ("number" > 0);
--> statement-breakpoint
ALTER TABLE spark."issues" ADD CONSTRAINT "issues_type_allowed" CHECK ("type" IN ('epic','story','task','bug','subtask'));
--> statement-breakpoint
ALTER TABLE spark."issues" ADD CONSTRAINT "issues_title_length" CHECK (length(btrim("title")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."issues" ADD CONSTRAINT "issues_priority_allowed" CHECK ("priority" IN ('lowest','low','medium','high','highest'));
--> statement-breakpoint
ALTER TABLE spark."issues" ADD CONSTRAINT "issues_story_points_nonnegative" CHECK ("story_points" >= 0);
--> statement-breakpoint
ALTER TABLE spark."issues" ADD CONSTRAINT "issues_version_positive" CHECK ("version" > 0);
--> statement-breakpoint
ALTER TABLE spark."moderation_actions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."moderation_actions" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."moderation_actions" ADD CONSTRAINT "moderation_actions_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."moderation_actions" ADD CONSTRAINT "moderation_actions_tenant_id_community_id_id_key" UNIQUE ("tenant_id", "community_id", "id");
--> statement-breakpoint
ALTER TABLE spark."moderation_actions" ADD CONSTRAINT "moderation_actions_action_allowed" CHECK ("action" IN ('hide','restore','dismiss_report'));
--> statement-breakpoint
ALTER TABLE spark."notification_deliveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."notification_deliveries" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."notification_deliveries" ADD CONSTRAINT "notification_deliveries_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."notification_deliveries" ADD CONSTRAINT "notification_deliveries_channel_allowed" CHECK ("channel" IN ('in_app','email'));
--> statement-breakpoint
ALTER TABLE spark."notification_deliveries" ADD CONSTRAINT "notification_deliveries_status_allowed" CHECK ("status" IN ('pending','sent','failed','suppressed'));
--> statement-breakpoint
ALTER TABLE spark."notification_deliveries" ADD CONSTRAINT "notification_deliveries_attempts_nonnegative" CHECK ("attempts" >= 0);
--> statement-breakpoint
ALTER TABLE spark."notification_preferences" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."notification_preferences" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."notification_preferences" ADD CONSTRAINT "notification_preferences_channel_allowed" CHECK ("channel" IN ('in_app','email'));
--> statement-breakpoint
ALTER TABLE spark."notifications" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."notifications" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."notifications" ADD CONSTRAINT "notifications_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."notifications" ADD CONSTRAINT "notifications_title_length" CHECK (length(btrim("title")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."outbox_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."outbox_events" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."outbox_events" ADD CONSTRAINT "outbox_events_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."outbox_events" ADD CONSTRAINT "outbox_events_aggregate_version_positive" CHECK ("aggregate_version" > 0);
--> statement-breakpoint
ALTER TABLE spark."outbox_events" ADD CONSTRAINT "outbox_events_attempts_nonnegative" CHECK ("attempts" >= 0);
--> statement-breakpoint
ALTER TABLE spark."password_credentials" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."password_credentials" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."payment_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."payment_events" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."payment_events" ADD CONSTRAINT "payment_events_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."payment_events" ADD CONSTRAINT "payment_events_provider_length" CHECK (length(btrim("provider")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."payment_events" ADD CONSTRAINT "payment_events_status_allowed" CHECK ("status" IN ('pending','processed','failed'));
--> statement-breakpoint
ALTER TABLE spark."payment_events" ADD CONSTRAINT "payment_events_attempts_nonnegative" CHECK ("attempts" >= 0);
--> statement-breakpoint
ALTER TABLE spark."plan_entitlements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."plan_entitlements" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."plan_entitlements" ADD CONSTRAINT "plan_entitlements_limit_value_nonnegative" CHECK ("limit_value" >= 0);
--> statement-breakpoint
ALTER TABLE spark."plan_prices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."plan_prices" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."plan_prices" ADD CONSTRAINT "plan_prices_currency_format" CHECK (currency ~ '^[A-Z]{3}$');
--> statement-breakpoint
ALTER TABLE spark."plan_prices" ADD CONSTRAINT "plan_prices_amount_minor_nonnegative" CHECK ("amount_minor" >= 0);
--> statement-breakpoint
ALTER TABLE spark."plan_prices" ADD CONSTRAINT "plan_prices_billing_interval_allowed" CHECK ("billing_interval" IN ('month','year'));
--> statement-breakpoint
ALTER TABLE spark."plan_prices" ADD CONSTRAINT "plan_prices_interval_count_positive" CHECK ("interval_count" > 0);
--> statement-breakpoint
ALTER TABLE spark."plan_prices" ADD CONSTRAINT "plan_prices_provider_length" CHECK (length(btrim("provider")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."platform_role_assignments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."platform_role_assignments" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."platform_role_assignments" ADD CONSTRAINT "platform_role_assignments_role_allowed" CHECK ("role" IN ('campaign_moderator'));
--> statement-breakpoint
ALTER TABLE spark."post_comments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."post_comments" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."post_comments" ADD CONSTRAINT "post_comments_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."post_comments" ADD CONSTRAINT "post_comments_tenant_id_community_id_id_key" UNIQUE ("tenant_id", "community_id", "id");
--> statement-breakpoint
ALTER TABLE spark."post_comments" ADD CONSTRAINT "post_comments_moderation_status_allowed" CHECK ("moderation_status" IN ('visible','hidden'));
--> statement-breakpoint
ALTER TABLE spark."post_comments" ADD CONSTRAINT "post_comments_version_positive" CHECK ("version" > 0);
--> statement-breakpoint
ALTER TABLE spark."posts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."posts" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."posts" ADD CONSTRAINT "posts_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."posts" ADD CONSTRAINT "posts_tenant_id_community_id_id_key" UNIQUE ("tenant_id", "community_id", "id");
--> statement-breakpoint
ALTER TABLE spark."posts" ADD CONSTRAINT "posts_title_length" CHECK (length(btrim("title")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."posts" ADD CONSTRAINT "posts_visibility_allowed" CHECK ("visibility" IN ('public','members','hidden'));
--> statement-breakpoint
ALTER TABLE spark."posts" ADD CONSTRAINT "posts_moderation_status_allowed" CHECK ("moderation_status" IN ('visible','hidden'));
--> statement-breakpoint
ALTER TABLE spark."posts" ADD CONSTRAINT "posts_version_positive" CHECK ("version" > 0);
--> statement-breakpoint
ALTER TABLE spark."projects" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."projects" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."projects" ADD CONSTRAINT "projects_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."projects" ADD CONSTRAINT "projects_key_length" CHECK (length(btrim("key")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."projects" ADD CONSTRAINT "projects_name_length" CHECK (length(btrim("name")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."projects" ADD CONSTRAINT "projects_next_issue_number_positive" CHECK ("next_issue_number" > 0);
--> statement-breakpoint
ALTER TABLE spark."promotion_campaigns" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."promotion_campaigns" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_tenant_id_community_id_id_key" UNIQUE ("tenant_id", "community_id", "id");
--> statement-breakpoint
ALTER TABLE spark."promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_name_length" CHECK (length(btrim("name")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_headline_length" CHECK (length(btrim("headline")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_review_status_allowed" CHECK ("review_status" IN ('draft','pending','approved','rejected'));
--> statement-breakpoint
ALTER TABLE spark."promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_delivery_status_allowed" CHECK ("delivery_status" IN ('unscheduled','scheduled','active','paused','completed','cancelled'));
--> statement-breakpoint
ALTER TABLE spark."promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_version_positive" CHECK ("version" > 0);
--> statement-breakpoint
ALTER TABLE spark."promotion_metrics_daily" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."promotion_metrics_daily" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."promotion_metrics_daily" ADD CONSTRAINT "promotion_metrics_daily_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."promotion_metrics_daily" ADD CONSTRAINT "promotion_metrics_daily_impressions_nonnegative" CHECK ("impressions" >= 0);
--> statement-breakpoint
ALTER TABLE spark."promotion_metrics_daily" ADD CONSTRAINT "promotion_metrics_daily_clicks_nonnegative" CHECK ("clicks" >= 0);
--> statement-breakpoint
ALTER TABLE spark."promotion_order_invoices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."promotion_order_invoices" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."promotion_order_invoices" ADD CONSTRAINT "promotion_order_invoices_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."promotion_order_invoices" ADD CONSTRAINT "promotion_order_invoices_provider_length" CHECK (length(btrim("provider")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."promotion_order_invoices" ADD CONSTRAINT "promotion_order_invoices_currency_format" CHECK (currency ~ '^[A-Z]{3}$');
--> statement-breakpoint
ALTER TABLE spark."promotion_order_invoices" ADD CONSTRAINT "promotion_order_invoices_subtotal_minor_nonnegative" CHECK ("subtotal_minor" >= 0);
--> statement-breakpoint
ALTER TABLE spark."promotion_order_invoices" ADD CONSTRAINT "promotion_order_invoices_tax_minor_nonnegative" CHECK ("tax_minor" >= 0);
--> statement-breakpoint
ALTER TABLE spark."promotion_order_invoices" ADD CONSTRAINT "promotion_order_invoices_total_minor_nonnegative" CHECK ("total_minor" >= 0);
--> statement-breakpoint
ALTER TABLE spark."promotion_order_invoices" ADD CONSTRAINT "promotion_order_invoices_status_allowed" CHECK ("status" IN ('draft','open','paid','void','uncollectible'));
--> statement-breakpoint
ALTER TABLE spark."promotion_orders" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."promotion_orders" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."promotion_orders" ADD CONSTRAINT "promotion_orders_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."promotion_orders" ADD CONSTRAINT "promotion_orders_provider_length" CHECK (length(btrim("provider")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."promotion_orders" ADD CONSTRAINT "promotion_orders_currency_format" CHECK (currency ~ '^[A-Z]{3}$');
--> statement-breakpoint
ALTER TABLE spark."promotion_orders" ADD CONSTRAINT "promotion_orders_amount_minor_nonnegative" CHECK ("amount_minor" >= 0);
--> statement-breakpoint
ALTER TABLE spark."promotion_orders" ADD CONSTRAINT "promotion_orders_duration_days_positive" CHECK ("duration_days" > 0);
--> statement-breakpoint
ALTER TABLE spark."promotion_orders" ADD CONSTRAINT "promotion_orders_status_allowed" CHECK ("status" IN ('pending','paid','failed','cancelled','refund_pending','refunded'));
--> statement-breakpoint
ALTER TABLE spark."promotion_placements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."promotion_placements" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."promotion_placements" ADD CONSTRAINT "promotion_placements_code_length" CHECK (length(btrim("code")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."promotion_placements" ADD CONSTRAINT "promotion_placements_name_length" CHECK (length(btrim("name")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."promotion_plans" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."promotion_plans" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."promotion_plans" ADD CONSTRAINT "promotion_plans_code_length" CHECK (length(btrim("code")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."promotion_plans" ADD CONSTRAINT "promotion_plans_version_positive" CHECK ("version" > 0);
--> statement-breakpoint
ALTER TABLE spark."promotion_plans" ADD CONSTRAINT "promotion_plans_name_length" CHECK (length(btrim("name")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."promotion_plans" ADD CONSTRAINT "promotion_plans_duration_days_positive" CHECK ("duration_days" > 0);
--> statement-breakpoint
ALTER TABLE spark."promotion_plans" ADD CONSTRAINT "promotion_plans_currency_format" CHECK (currency ~ '^[A-Z]{3}$');
--> statement-breakpoint
ALTER TABLE spark."promotion_plans" ADD CONSTRAINT "promotion_plans_amount_minor_nonnegative" CHECK ("amount_minor" >= 0);
--> statement-breakpoint
ALTER TABLE spark."promotion_plans" ADD CONSTRAINT "promotion_plans_provider_length" CHECK (length(btrim("provider")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."promotion_prices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."promotion_prices" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."promotion_redemptions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."promotion_redemptions" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_status_allowed" CHECK ("status" IN ('reserved','applied','released'));
--> statement-breakpoint
ALTER TABLE spark."promotion_reviews" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."promotion_reviews" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."promotion_reviews" ADD CONSTRAINT "promotion_reviews_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."promotion_reviews" ADD CONSTRAINT "promotion_reviews_campaign_version_positive" CHECK ("campaign_version" > 0);
--> statement-breakpoint
ALTER TABLE spark."promotion_reviews" ADD CONSTRAINT "promotion_reviews_decision_allowed" CHECK ("decision" IN ('approve','reject'));
--> statement-breakpoint
ALTER TABLE spark."promotions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."promotions" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."promotions" ADD CONSTRAINT "promotions_name_length" CHECK (length(btrim("name")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."promotions" ADD CONSTRAINT "promotions_discount_type_allowed" CHECK ("discount_type" IN ('percent','fixed'));
--> statement-breakpoint
ALTER TABLE spark."promotions" ADD CONSTRAINT "promotions_amount_minor_nonnegative" CHECK ("amount_minor" >= 0);
--> statement-breakpoint
ALTER TABLE spark."promotions" ADD CONSTRAINT "promotions_currency_format" CHECK (currency ~ '^[A-Z]{3}$');
--> statement-breakpoint
ALTER TABLE spark."promotions" ADD CONSTRAINT "promotions_max_per_tenant_positive" CHECK ("max_per_tenant" > 0);
--> statement-breakpoint
ALTER TABLE spark."promotions" ADD CONSTRAINT "promotions_duration_cycles_positive" CHECK ("duration_cycles" > 0);
--> statement-breakpoint
ALTER TABLE spark."sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."sessions" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."sessions" ADD CONSTRAINT "sessions_token_hash_length" CHECK (octet_length("token_hash") = 32);
--> statement-breakpoint
ALTER TABLE spark."sessions" ADD CONSTRAINT "sessions_auth_method_allowed" CHECK ("auth_method" IN ('password','oauth'));
--> statement-breakpoint
ALTER TABLE spark."sessions" ADD CONSTRAINT "sessions_expiry_order" CHECK (expires_at > created_at);
--> statement-breakpoint
ALTER TABLE spark."sprints" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."sprints" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."sprints" ADD CONSTRAINT "sprints_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."sprints" ADD CONSTRAINT "sprints_tenant_id_project_id_id_key" UNIQUE ("tenant_id", "project_id", "id");
--> statement-breakpoint
ALTER TABLE spark."sprints" ADD CONSTRAINT "sprints_name_length" CHECK (length(btrim("name")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."sprints" ADD CONSTRAINT "sprints_status_allowed" CHECK ("status" IN ('planned','active','completed','cancelled'));
--> statement-breakpoint
ALTER TABLE spark."startup_connections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."startup_connections" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."startup_connections" ADD CONSTRAINT "startup_connections_status_allowed" CHECK ("status" IN ('pending','accepted','rejected','withdrawn','disconnected'));
--> statement-breakpoint
ALTER TABLE spark."startup_profiles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."startup_profiles" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."startup_profiles" ADD CONSTRAINT "startup_profiles_stage_allowed" CHECK ("stage" IN ('idea','validation','mvp','growth','established'));
--> statement-breakpoint
ALTER TABLE spark."subscription_plans" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."subscription_plans" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."subscription_plans" ADD CONSTRAINT "subscription_plans_code_length" CHECK (length(btrim("code")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."subscription_plans" ADD CONSTRAINT "subscription_plans_name_length" CHECK (length(btrim("name")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."subscriptions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."subscriptions" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."subscriptions" ADD CONSTRAINT "subscriptions_provider_length" CHECK (length(btrim("provider")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."subscriptions" ADD CONSTRAINT "subscriptions_status_allowed" CHECK ("status" IN ('incomplete','trialing','active','past_due','paused','cancelled','expired'));
--> statement-breakpoint
ALTER TABLE spark."subscriptions" ADD CONSTRAINT "subscriptions_version_positive" CHECK ("version" > 0);
--> statement-breakpoint
ALTER TABLE spark."team_memberships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."team_memberships" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."team_memberships" ADD CONSTRAINT "team_memberships_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."team_memberships" ADD CONSTRAINT "team_memberships_role_allowed" CHECK ("role" IN ('lead','member'));
--> statement-breakpoint
ALTER TABLE spark."teams" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."teams" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."teams" ADD CONSTRAINT "teams_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."teams" ADD CONSTRAINT "teams_name_length" CHECK (length(btrim("name")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."topics" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."topics" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."topics" ADD CONSTRAINT "topics_slug_length" CHECK (length(btrim("slug")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."topics" ADD CONSTRAINT "topics_name_length" CHECK (length(btrim("name")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."user_emails" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."user_emails" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."users" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."users" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."users" ADD CONSTRAINT "users_display_name_length" CHECK (length(btrim("display_name")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."users" ADD CONSTRAINT "users_timezone_not_empty" CHECK (length(timezone) BETWEEN 1 AND 100);
--> statement-breakpoint
ALTER TABLE spark."users" ADD CONSTRAINT "users_status_allowed" CHECK ("status" IN ('active','suspended','deleted'));
--> statement-breakpoint
ALTER TABLE spark."workflow_transitions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."workflow_transitions" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."workflow_transitions" ADD CONSTRAINT "workflow_transitions_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."workflow_transitions" ADD CONSTRAINT "workflow_transitions_tenant_id_project_id_id_key" UNIQUE ("tenant_id", "project_id", "id");
--> statement-breakpoint
ALTER TABLE spark."workspace_invitations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."workspace_invitations" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."workspace_invitations" ADD CONSTRAINT "workspace_invitations_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."workspace_invitations" ADD CONSTRAINT "workspace_invitations_role_allowed" CHECK ("role" IN ('admin','member'));
--> statement-breakpoint
ALTER TABLE spark."workspace_invitations" ADD CONSTRAINT "workspace_invitations_token_hash_length" CHECK (octet_length("token_hash") = 32);
--> statement-breakpoint
ALTER TABLE spark."workspace_invitations" ADD CONSTRAINT "workspace_invitations_expiry_order" CHECK (expires_at > created_at);
--> statement-breakpoint
ALTER TABLE spark."workspace_invitations" ADD CONSTRAINT "workspace_invitations_status_allowed" CHECK ("status" IN ('pending','accepted','revoked','expired'));
--> statement-breakpoint
ALTER TABLE spark."workspace_memberships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."workspace_memberships" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."workspace_memberships" ADD CONSTRAINT "workspace_memberships_tenant_id_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE spark."workspace_memberships" ADD CONSTRAINT "workspace_memberships_role_allowed" CHECK ("role" IN ('owner','admin','member'));
--> statement-breakpoint
ALTER TABLE spark."workspace_memberships" ADD CONSTRAINT "workspace_memberships_status_allowed" CHECK ("status" IN ('active','suspended','left'));
--> statement-breakpoint
ALTER TABLE spark."workspaces" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_maintenance ON spark."workspaces" TO spark_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE spark."workspaces" ADD CONSTRAINT "workspaces_slug_length" CHECK (length(btrim("slug")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."workspaces" ADD CONSTRAINT "workspaces_name_length" CHECK (length(btrim("name")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE spark."workspaces" ADD CONSTRAINT "workspaces_status_allowed" CHECK ("status" IN ('active','archived'));
--> statement-breakpoint
ALTER TABLE spark."user_emails" ADD CONSTRAINT "user_emails_normalized_email_key" UNIQUE ("normalized_email");
--> statement-breakpoint
ALTER TABLE spark."user_emails" ADD CONSTRAINT "user_emails_user_id_id_key" UNIQUE ("user_id", "id");
--> statement-breakpoint
ALTER TABLE spark."auth_identities" ADD CONSTRAINT "auth_identities_provider_issuer_provider_subject_key" UNIQUE ("provider", "issuer", "provider_subject");
--> statement-breakpoint
ALTER TABLE spark."auth_identities" ADD CONSTRAINT "auth_identities_user_id_id_key" UNIQUE ("user_id", "id");
--> statement-breakpoint
ALTER TABLE spark."sessions" ADD CONSTRAINT "sessions_token_hash_key" UNIQUE ("token_hash");
--> statement-breakpoint
ALTER TABLE spark."sessions" ADD CONSTRAINT "sessions_user_id_id_key" UNIQUE ("user_id", "id");
--> statement-breakpoint
ALTER TABLE spark."account_tokens" ADD CONSTRAINT "account_tokens_token_hash_key" UNIQUE ("token_hash");
--> statement-breakpoint
ALTER TABLE spark."workspaces" ADD CONSTRAINT "workspaces_slug_key" UNIQUE ("slug");
--> statement-breakpoint
ALTER TABLE spark."workspace_memberships" ADD CONSTRAINT "workspace_memberships_tenant_id_user_id_key" UNIQUE ("tenant_id", "user_id");
--> statement-breakpoint
ALTER TABLE spark."teams" ADD CONSTRAINT "teams_tenant_id_name_key" UNIQUE ("tenant_id", "name");
--> statement-breakpoint
ALTER TABLE spark."team_memberships" ADD CONSTRAINT "team_memberships_tenant_id_team_id_user_id_key" UNIQUE ("tenant_id", "team_id", "user_id");
--> statement-breakpoint
ALTER TABLE spark."workspace_invitations" ADD CONSTRAINT "workspace_invitations_token_hash_key" UNIQUE ("token_hash");
--> statement-breakpoint
ALTER TABLE spark."communities" ADD CONSTRAINT "communities_slug_key" UNIQUE ("slug");
--> statement-breakpoint
ALTER TABLE spark."topics" ADD CONSTRAINT "topics_slug_key" UNIQUE ("slug");
--> statement-breakpoint
ALTER TABLE spark."community_topics" ADD CONSTRAINT "community_topics_tenant_id_community_id_topic_id_key" UNIQUE ("tenant_id", "community_id", "topic_id");
--> statement-breakpoint
ALTER TABLE spark."community_memberships" ADD CONSTRAINT "community_memberships_tenant_id_community_id_user_id_key" UNIQUE ("tenant_id", "community_id", "user_id");
--> statement-breakpoint
ALTER TABLE spark."projects" ADD CONSTRAINT "projects_tenant_id_key_key" UNIQUE ("tenant_id", "key");
--> statement-breakpoint
ALTER TABLE spark."boards" ADD CONSTRAINT "boards_tenant_id_project_id_key" UNIQUE ("tenant_id", "project_id");
--> statement-breakpoint
ALTER TABLE spark."issue_statuses" ADD CONSTRAINT "issue_statuses_tenant_id_project_id_name_key" UNIQUE ("tenant_id", "project_id", "name");
--> statement-breakpoint
ALTER TABLE spark."workflow_transitions" ADD CONSTRAINT "workflow_transitions_tenant_id_project_id_from_status_id_to_sta" UNIQUE ("tenant_id", "project_id", "from_status_id", "to_status_id");
--> statement-breakpoint
ALTER TABLE spark."issues" ADD CONSTRAINT "issues_tenant_id_project_id_number_key" UNIQUE ("tenant_id", "project_id", "number");
--> statement-breakpoint
ALTER TABLE spark."issue_labels" ADD CONSTRAINT "issue_labels_tenant_id_project_id_name_key" UNIQUE ("tenant_id", "project_id", "name");
--> statement-breakpoint
ALTER TABLE spark."issue_label_links" ADD CONSTRAINT "issue_label_links_tenant_id_project_id_issue_id_label_id_key" UNIQUE ("tenant_id", "project_id", "issue_id", "label_id");
--> statement-breakpoint
ALTER TABLE spark."issue_links" ADD CONSTRAINT "issue_links_tenant_id_project_id_source_issue_id_target_issue_i" UNIQUE ("tenant_id", "project_id", "source_issue_id", "target_issue_id", "type");
--> statement-breakpoint
ALTER TABLE spark."issue_events" ADD CONSTRAINT "issue_events_tenant_id_issue_id_to_version_key" UNIQUE ("tenant_id", "issue_id", "to_version");
--> statement-breakpoint
ALTER TABLE spark."event_attendees" ADD CONSTRAINT "event_attendees_tenant_id_event_id_user_id_key" UNIQUE ("tenant_id", "event_id", "user_id");
--> statement-breakpoint
ALTER TABLE spark."event_reminders" ADD CONSTRAINT "event_reminders_tenant_id_event_id_user_id_event_version_minute" UNIQUE ("tenant_id", "event_id", "user_id", "event_version", "minutes_before", "channel");
--> statement-breakpoint
ALTER TABLE spark."subscription_plans" ADD CONSTRAINT "subscription_plans_code_key" UNIQUE ("code");
--> statement-breakpoint
ALTER TABLE spark."plan_prices" ADD CONSTRAINT "plan_prices_plan_id_id_key" UNIQUE ("plan_id", "id");
--> statement-breakpoint
ALTER TABLE spark."plan_prices" ADD CONSTRAINT "plan_prices_id_provider_key" UNIQUE ("id", "provider");
--> statement-breakpoint
ALTER TABLE spark."plan_prices" ADD CONSTRAINT "plan_prices_provider_provider_price_id_key" UNIQUE ("provider", "provider_price_id");
--> statement-breakpoint
ALTER TABLE spark."plan_entitlements" ADD CONSTRAINT "plan_entitlements_plan_id_feature_key_key" UNIQUE ("plan_id", "feature_key");
--> statement-breakpoint
ALTER TABLE spark."billing_customers" ADD CONSTRAINT "billing_customers_tenant_id_provider_key" UNIQUE ("tenant_id", "provider");
--> statement-breakpoint
ALTER TABLE spark."billing_customers" ADD CONSTRAINT "billing_customers_provider_provider_customer_id_key" UNIQUE ("provider", "provider_customer_id");
--> statement-breakpoint
ALTER TABLE spark."billing_customers" ADD CONSTRAINT "billing_customers_tenant_id_id_provider_key" UNIQUE ("tenant_id", "id", "provider");
--> statement-breakpoint
ALTER TABLE spark."subscriptions" ADD CONSTRAINT "subscriptions_provider_provider_subscription_id_key" UNIQUE ("provider", "provider_subscription_id");
--> statement-breakpoint
ALTER TABLE spark."subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_id_provider_key" UNIQUE ("tenant_id", "id", "provider");
--> statement-breakpoint
ALTER TABLE spark."invoices" ADD CONSTRAINT "invoices_provider_provider_invoice_id_key" UNIQUE ("provider", "provider_invoice_id");
--> statement-breakpoint
ALTER TABLE spark."payment_events" ADD CONSTRAINT "payment_events_provider_provider_event_id_key" UNIQUE ("provider", "provider_event_id");
--> statement-breakpoint
ALTER TABLE spark."promotions" ADD CONSTRAINT "promotions_code_normalized_key" UNIQUE ("code_normalized");
--> statement-breakpoint
ALTER TABLE spark."promotion_prices" ADD CONSTRAINT "promotion_prices_promotion_id_price_id_key" UNIQUE ("promotion_id", "price_id");
--> statement-breakpoint
ALTER TABLE spark."promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_tenant_id_idempotency_key_key" UNIQUE ("tenant_id", "idempotency_key");
--> statement-breakpoint
ALTER TABLE spark."outbox_events" ADD CONSTRAINT "outbox_events_tenant_id_aggregate_type_aggregate_id_aggregate_v" UNIQUE ("tenant_id", "aggregate_type", "aggregate_id", "aggregate_version", "event_type");
--> statement-breakpoint
ALTER TABLE spark."notifications" ADD CONSTRAINT "notifications_tenant_id_outbox_event_id_recipient_user_id_kind_" UNIQUE ("tenant_id", "outbox_event_id", "recipient_user_id", "kind");
--> statement-breakpoint
ALTER TABLE spark."notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_kind_channel_key" UNIQUE ("user_id", "kind", "channel");
--> statement-breakpoint
ALTER TABLE spark."notification_deliveries" ADD CONSTRAINT "notification_deliveries_tenant_id_notification_id_channel_key" UNIQUE ("tenant_id", "notification_id", "channel");
--> statement-breakpoint
ALTER TABLE spark."idempotency_requests" ADD CONSTRAINT "idempotency_requests_tenant_id_actor_user_id_operation_key_key" UNIQUE ("tenant_id", "actor_user_id", "operation", "key");
--> statement-breakpoint
ALTER TABLE spark."promotion_placements" ADD CONSTRAINT "promotion_placements_code_key" UNIQUE ("code");
--> statement-breakpoint
ALTER TABLE spark."promotion_plans" ADD CONSTRAINT "promotion_plans_code_version_key" UNIQUE ("code", "version");
--> statement-breakpoint
ALTER TABLE spark."promotion_plans" ADD CONSTRAINT "promotion_plans_provider_provider_price_id_key" UNIQUE ("provider", "provider_price_id");
--> statement-breakpoint
ALTER TABLE spark."promotion_plans" ADD CONSTRAINT "promotion_plans_id_provider_currency_amount_minor_duration_days" UNIQUE ("id", "provider", "currency", "amount_minor", "duration_days");
--> statement-breakpoint
ALTER TABLE spark."promotion_orders" ADD CONSTRAINT "promotion_orders_tenant_id_idempotency_key_key" UNIQUE ("tenant_id", "idempotency_key");
--> statement-breakpoint
ALTER TABLE spark."promotion_orders" ADD CONSTRAINT "promotion_orders_provider_provider_checkout_id_key" UNIQUE ("provider", "provider_checkout_id");
--> statement-breakpoint
ALTER TABLE spark."promotion_orders" ADD CONSTRAINT "promotion_orders_provider_provider_payment_id_key" UNIQUE ("provider", "provider_payment_id");
--> statement-breakpoint
ALTER TABLE spark."promotion_orders" ADD CONSTRAINT "promotion_orders_tenant_id_id_provider_currency_key" UNIQUE ("tenant_id", "id", "provider", "currency");
--> statement-breakpoint
ALTER TABLE spark."promotion_order_invoices" ADD CONSTRAINT "promotion_order_invoices_provider_provider_invoice_id_key" UNIQUE ("provider", "provider_invoice_id");
--> statement-breakpoint
ALTER TABLE spark."promotion_reviews" ADD CONSTRAINT "promotion_reviews_tenant_id_campaign_id_campaign_version_key" UNIQUE ("tenant_id", "campaign_id", "campaign_version");
--> statement-breakpoint
ALTER TABLE spark."promotion_metrics_daily" ADD CONSTRAINT "promotion_metrics_daily_tenant_id_campaign_id_metric_date_key" UNIQUE ("tenant_id", "campaign_id", "metric_date");
--> statement-breakpoint
CREATE UNIQUE INDEX "user_emails_user_id_partial" ON spark."user_emails" ("user_id") WHERE is_primary;
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_invitations_tenant_id_email_normalized_partial" ON spark."workspace_invitations" ("tenant_id", "email_normalized") WHERE status = 'pending';
--> statement-breakpoint
CREATE UNIQUE INDEX "community_join_requests_tenant_id_community_id_user_id_partial" ON spark."community_join_requests" ("tenant_id", "community_id", "user_id") WHERE status = 'pending';
--> statement-breakpoint
CREATE UNIQUE INDEX "content_reports_tenant_id_reporter_user_id_post_id_partial" ON spark."content_reports" ("tenant_id", "reporter_user_id", "post_id") WHERE status IN ('open','reviewing') AND post_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "content_reports_tenant_id_reporter_user_id_comment_id_partial" ON spark."content_reports" ("tenant_id", "reporter_user_id", "comment_id") WHERE status IN ('open','reviewing') AND comment_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "sprints_tenant_id_project_id_partial" ON spark."sprints" ("tenant_id", "project_id") WHERE status = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_tenant_id_partial" ON spark."subscriptions" ("tenant_id") WHERE status IN ('incomplete','trialing','active','past_due','paused');
--> statement-breakpoint
CREATE UNIQUE INDEX "promotion_redemptions_tenant_id_subscription_id_partial" ON spark."promotion_redemptions" ("tenant_id", "subscription_id") WHERE status IN ('reserved','applied');
--> statement-breakpoint
CREATE UNIQUE INDEX "promotion_orders_tenant_id_campaign_id_partial" ON spark."promotion_orders" ("tenant_id", "campaign_id") WHERE status IN ('pending','paid','refund_pending');
--> statement-breakpoint
CREATE UNIQUE INDEX "platform_role_assignments_user_id_role_partial" ON spark."platform_role_assignments" ("user_id", "role") WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX startup_connections_pair ON spark.startup_connections (least(requester_tenant_id,recipient_tenant_id), greatest(requester_tenant_id,recipient_tenant_id));
--> statement-breakpoint
ALTER TABLE spark."password_credentials" ADD CONSTRAINT "password_credentials_argon2id_format" CHECK (password_hash ~ '^\$argon2id\$v=19\$m=[1-9][0-9]*,t=[1-9][0-9]*,p=[1-9][0-9]*\$[A-Za-z0-9+/]{16,}\$[A-Za-z0-9+/]{32,}$');
--> statement-breakpoint
ALTER TABLE spark."user_emails" ADD CONSTRAINT "user_emails_normalized_format" CHECK (normalized_email = lower(btrim(email)) AND position('@' IN normalized_email) > 1);
--> statement-breakpoint
ALTER TABLE spark."sessions" ADD CONSTRAINT "sessions_identity_method" CHECK ((auth_method = 'oauth') = (authenticated_identity_id IS NOT NULL));
--> statement-breakpoint
ALTER TABLE spark."sessions" ADD CONSTRAINT "sessions_rotation_not_self" CHECK (rotated_from_id IS DISTINCT FROM id);
--> statement-breakpoint
ALTER TABLE spark."account_tokens" ADD CONSTRAINT "account_tokens_email_required" CHECK (purpose <> 'verify_email' OR user_email_id IS NOT NULL);
--> statement-breakpoint
ALTER TABLE spark."workspace_invitations" ADD CONSTRAINT "workspace_invitations_accepted_fields" CHECK ((status = 'accepted' AND accepted_by_user_id IS NOT NULL AND accepted_at IS NOT NULL) OR (status <> 'accepted' AND accepted_by_user_id IS NULL AND accepted_at IS NULL));
--> statement-breakpoint
ALTER TABLE spark."startup_connections" ADD CONSTRAINT "startup_connections_distinct_endpoints" CHECK (requester_tenant_id <> recipient_tenant_id);
--> statement-breakpoint
ALTER TABLE spark."startup_connections" ADD CONSTRAINT "startup_connections_response_fields" CHECK ((responded_by_user_id IS NULL) = (responded_at IS NULL));
--> statement-breakpoint
ALTER TABLE spark."content_reports" ADD CONSTRAINT "content_reports_one_target" CHECK (num_nonnulls(post_id,comment_id) = 1);
--> statement-breakpoint
ALTER TABLE spark."moderation_actions" ADD CONSTRAINT "moderation_actions_one_target" CHECK (num_nonnulls(post_id,comment_id) = 1);
--> statement-breakpoint
ALTER TABLE spark."workflow_transitions" ADD CONSTRAINT "workflow_transitions_distinct_statuses" CHECK (from_status_id <> to_status_id);
--> statement-breakpoint
ALTER TABLE spark."issues" ADD CONSTRAINT "issues_dates_order" CHECK (due_date >= start_date);
--> statement-breakpoint
ALTER TABLE spark."issues" ADD CONSTRAINT "issues_parent_shape" CHECK ((type <> 'epic' OR parent_issue_id IS NULL) AND (type <> 'subtask' OR parent_issue_id IS NOT NULL) AND parent_issue_id IS DISTINCT FROM id);
--> statement-breakpoint
ALTER TABLE spark."issue_statuses" ADD CONSTRAINT "issue_statuses_positive_wip" CHECK (wip_limit > 0);
--> statement-breakpoint
ALTER TABLE spark."issue_links" ADD CONSTRAINT "issue_links_endpoints" CHECK (source_issue_id <> target_issue_id AND (type <> 'relates_to' OR source_issue_id < target_issue_id));
--> statement-breakpoint
ALTER TABLE spark."issue_events" ADD CONSTRAINT "issue_events_version_step" CHECK (to_version = from_version + 1);
--> statement-breakpoint
ALTER TABLE spark."sprints" ADD CONSTRAINT "sprints_interval" CHECK ((starts_at IS NULL AND ends_at IS NULL) OR (starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > starts_at));
--> statement-breakpoint
ALTER TABLE spark."promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_interval" CHECK ((starts_at IS NULL AND ends_at IS NULL) OR (starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > starts_at));
--> statement-breakpoint
ALTER TABLE spark."sprints" ADD CONSTRAINT "sprints_active_dates" CHECK (status <> 'active' OR starts_at IS NOT NULL);
--> statement-breakpoint
ALTER TABLE spark."calendar_events" ADD CONSTRAINT "calendar_events_interval" CHECK (ends_at > starts_at);
--> statement-breakpoint
ALTER TABLE spark."calendar_events" ADD CONSTRAINT "calendar_events_issue_project" CHECK (issue_id IS NULL OR project_id IS NOT NULL);
--> statement-breakpoint
ALTER TABLE spark."plan_prices" ADD CONSTRAINT "plan_prices_provider_pair" CHECK ((provider IS NULL) = (provider_price_id IS NULL));
--> statement-breakpoint
ALTER TABLE spark."subscriptions" ADD CONSTRAINT "subscriptions_provider_fields" CHECK (num_nonnulls(billing_customer_id,price_id,provider,provider_subscription_id) IN (0,4));
--> statement-breakpoint
ALTER TABLE spark."subscriptions" ADD CONSTRAINT "subscriptions_period" CHECK ((period_start IS NULL AND period_end IS NULL) OR (period_start IS NOT NULL AND period_end IS NOT NULL AND period_end > period_start));
--> statement-breakpoint
ALTER TABLE spark."invoices" ADD CONSTRAINT "invoices_total_math" CHECK (discount_minor <= subtotal_minor AND total_minor::numeric = subtotal_minor::numeric - discount_minor::numeric + tax_minor::numeric);
--> statement-breakpoint
ALTER TABLE spark."promotion_order_invoices" ADD CONSTRAINT "promotion_order_invoices_total_math" CHECK (total_minor::numeric = subtotal_minor::numeric + tax_minor::numeric);
--> statement-breakpoint
ALTER TABLE spark."promotions" ADD CONSTRAINT "promotions_discount_shape" CHECK ((discount_type = 'percent' AND percent_bps BETWEEN 1 AND 10000 AND amount_minor IS NULL AND currency IS NULL) OR (discount_type = 'fixed' AND percent_bps IS NULL AND amount_minor > 0 AND currency IS NOT NULL));
--> statement-breakpoint
ALTER TABLE spark."promotions" ADD CONSTRAINT "promotions_required_percent" CHECK (discount_type <> 'percent' OR percent_bps IS NOT NULL);
--> statement-breakpoint
ALTER TABLE spark."promotions" ADD CONSTRAINT "promotions_required_fixed" CHECK (discount_type <> 'fixed' OR amount_minor IS NOT NULL);
--> statement-breakpoint
ALTER TABLE spark."promotions" ADD CONSTRAINT "promotions_interval" CHECK (ends_at > starts_at);
--> statement-breakpoint
ALTER TABLE spark."promotions" ADD CONSTRAINT "promotions_redemption_cap" CHECK (max_redemptions > 0);
--> statement-breakpoint
ALTER TABLE spark."promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_applied_time" CHECK ((status = 'applied') = (applied_at IS NOT NULL));
--> statement-breakpoint
ALTER TABLE spark."promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_reservation_expiry" CHECK (reserved_until > created_at);
--> statement-breakpoint
ALTER TABLE spark."outbox_events" ADD CONSTRAINT "outbox_events_lease_pair" CHECK ((locked_until IS NULL) = (lock_token IS NULL));
--> statement-breakpoint
ALTER TABLE spark."audit_events" ADD CONSTRAINT "audit_events_actor_shape" CHECK ((actor_kind = 'user') = (actor_user_id IS NOT NULL));
--> statement-breakpoint
ALTER TABLE spark."promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_approval_version" CHECK ((review_status = 'approved' AND approved_version IS NOT NULL AND approved_version = version) OR (review_status <> 'approved' AND approved_version IS NULL));
--> statement-breakpoint
ALTER TABLE spark."promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_delivery_interval" CHECK (delivery_status NOT IN ('scheduled','active','completed') OR starts_at IS NOT NULL);
--> statement-breakpoint
CREATE INDEX "workspace_memberships_user_id_status_tenant_id_read" ON spark."workspace_memberships" ("user_id", "status", "tenant_id");
--> statement-breakpoint
CREATE INDEX "community_memberships_user_id_status_tenant_id_community_id_rea" ON spark."community_memberships" ("user_id", "status", "tenant_id", "community_id");
--> statement-breakpoint
CREATE INDEX "community_topics_topic_id_tenant_id_community_id_read" ON spark."community_topics" ("topic_id", "tenant_id", "community_id");
--> statement-breakpoint
CREATE INDEX "communities_created_at_id_read" ON spark."communities" ("created_at", "id") WHERE visibility = 'public' AND archived_at IS NULL;
--> statement-breakpoint
CREATE INDEX "posts_tenant_id_community_id_created_at_id_read" ON spark."posts" ("tenant_id", "community_id", "created_at", "id");
--> statement-breakpoint
CREATE INDEX "post_comments_tenant_id_community_id_post_id_created_at_id_read" ON spark."post_comments" ("tenant_id", "community_id", "post_id", "created_at", "id");
--> statement-breakpoint
CREATE INDEX "content_reports_tenant_id_community_id_status_created_at_id_rea" ON spark."content_reports" ("tenant_id", "community_id", "status", "created_at", "id");
--> statement-breakpoint
CREATE INDEX "issues_tenant_id_project_id_status_id_position_id_read" ON spark."issues" ("tenant_id", "project_id", "status_id", "position", "id") WHERE archived_at IS NULL;
--> statement-breakpoint
CREATE INDEX "issues_tenant_id_assignee_user_id_due_date_id_read" ON spark."issues" ("tenant_id", "assignee_user_id", "due_date", "id") WHERE archived_at IS NULL;
--> statement-breakpoint
CREATE INDEX "issue_events_tenant_id_issue_id_created_at_id_read" ON spark."issue_events" ("tenant_id", "issue_id", "created_at", "id");
--> statement-breakpoint
CREATE INDEX "calendar_events_tenant_id_starts_at_id_read" ON spark."calendar_events" ("tenant_id", "starts_at", "id");
--> statement-breakpoint
CREATE INDEX "event_reminders_scheduled_for_id_read" ON spark."event_reminders" ("scheduled_for", "id") WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX "notifications_recipient_user_id_tenant_id_created_at_id_read" ON spark."notifications" ("recipient_user_id", "tenant_id", "created_at", "id") WHERE read_at IS NULL;
--> statement-breakpoint
CREATE INDEX "outbox_events_available_at_id_read" ON spark."outbox_events" ("available_at", "id") WHERE processed_at IS NULL;
--> statement-breakpoint
CREATE INDEX "sessions_expires_at_read" ON spark."sessions" ("expires_at");
--> statement-breakpoint
CREATE INDEX "account_tokens_expires_at_read" ON spark."account_tokens" ("expires_at");
--> statement-breakpoint
CREATE INDEX "startup_connections_recipient_tenant_id_status_created_at_id_re" ON spark."startup_connections" ("recipient_tenant_id", "status", "created_at", "id");
--> statement-breakpoint
CREATE INDEX "promotion_redemptions_promotion_id_status_reserved_until_tenant" ON spark."promotion_redemptions" ("promotion_id", "status", "reserved_until", "tenant_id");
--> statement-breakpoint
CREATE INDEX "promotion_campaigns_placement_id_starts_at_ends_at_id_read" ON spark."promotion_campaigns" ("placement_id", "starts_at", "ends_at", "id") WHERE review_status = 'approved' AND delivery_status IN ('scheduled','active');
--> statement-breakpoint
CREATE INDEX "promotion_campaigns_review_status_created_at_id_read" ON spark."promotion_campaigns" ("review_status", "created_at", "id");
--> statement-breakpoint
CREATE INDEX communities_search ON spark.communities USING gin (to_tsvector('simple'::regconfig, name || ' ' || description));
--> statement-breakpoint
ALTER TABLE spark."account_tokens" ADD CONSTRAINT "account_tokens_fk_1" FOREIGN KEY ("user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "account_tokens_fk_1_idx" ON spark."account_tokens" ("user_id");
--> statement-breakpoint
ALTER TABLE spark."audit_events" ADD CONSTRAINT "audit_events_fk_2" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "audit_events_fk_2_idx" ON spark."audit_events" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."audit_events" ADD CONSTRAINT "audit_events_fk_3" FOREIGN KEY ("actor_user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "audit_events_fk_3_idx" ON spark."audit_events" ("actor_user_id");
--> statement-breakpoint
ALTER TABLE spark."auth_identities" ADD CONSTRAINT "auth_identities_fk_4" FOREIGN KEY ("user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "auth_identities_fk_4_idx" ON spark."auth_identities" ("user_id");
--> statement-breakpoint
ALTER TABLE spark."billing_customers" ADD CONSTRAINT "billing_customers_fk_5" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "billing_customers_fk_5_idx" ON spark."billing_customers" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."boards" ADD CONSTRAINT "boards_fk_6" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "boards_fk_6_idx" ON spark."boards" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."boards" ADD CONSTRAINT "boards_fk_7" FOREIGN KEY ("tenant_id", "project_id") REFERENCES spark."projects" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "boards_fk_7_idx" ON spark."boards" ("tenant_id", "project_id");
--> statement-breakpoint
ALTER TABLE spark."calendar_events" ADD CONSTRAINT "calendar_events_fk_8" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "calendar_events_fk_8_idx" ON spark."calendar_events" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."calendar_events" ADD CONSTRAINT "calendar_events_fk_9" FOREIGN KEY ("tenant_id", "project_id") REFERENCES spark."projects" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "calendar_events_fk_9_idx" ON spark."calendar_events" ("tenant_id", "project_id");
--> statement-breakpoint
ALTER TABLE spark."calendar_events" ADD CONSTRAINT "calendar_events_fk_10" FOREIGN KEY ("organizer_user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "calendar_events_fk_10_idx" ON spark."calendar_events" ("organizer_user_id");
--> statement-breakpoint
ALTER TABLE spark."communities" ADD CONSTRAINT "communities_fk_11" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "communities_fk_11_idx" ON spark."communities" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."communities" ADD CONSTRAINT "communities_fk_12" FOREIGN KEY ("created_by_user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "communities_fk_12_idx" ON spark."communities" ("created_by_user_id");
--> statement-breakpoint
ALTER TABLE spark."community_join_requests" ADD CONSTRAINT "community_join_requests_fk_13" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "community_join_requests_fk_13_idx" ON spark."community_join_requests" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."community_join_requests" ADD CONSTRAINT "community_join_requests_fk_14" FOREIGN KEY ("tenant_id", "community_id") REFERENCES spark."communities" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "community_join_requests_fk_14_idx" ON spark."community_join_requests" ("tenant_id", "community_id");
--> statement-breakpoint
ALTER TABLE spark."community_join_requests" ADD CONSTRAINT "community_join_requests_fk_15" FOREIGN KEY ("user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "community_join_requests_fk_15_idx" ON spark."community_join_requests" ("user_id");
--> statement-breakpoint
ALTER TABLE spark."community_join_requests" ADD CONSTRAINT "community_join_requests_fk_16" FOREIGN KEY ("reviewed_by_user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "community_join_requests_fk_16_idx" ON spark."community_join_requests" ("reviewed_by_user_id");
--> statement-breakpoint
ALTER TABLE spark."community_memberships" ADD CONSTRAINT "community_memberships_fk_17" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "community_memberships_fk_17_idx" ON spark."community_memberships" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."community_memberships" ADD CONSTRAINT "community_memberships_fk_18" FOREIGN KEY ("tenant_id", "community_id") REFERENCES spark."communities" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "community_memberships_fk_18_idx" ON spark."community_memberships" ("tenant_id", "community_id");
--> statement-breakpoint
ALTER TABLE spark."community_memberships" ADD CONSTRAINT "community_memberships_fk_19" FOREIGN KEY ("user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "community_memberships_fk_19_idx" ON spark."community_memberships" ("user_id");
--> statement-breakpoint
ALTER TABLE spark."community_topics" ADD CONSTRAINT "community_topics_fk_20" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "community_topics_fk_20_idx" ON spark."community_topics" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."community_topics" ADD CONSTRAINT "community_topics_fk_21" FOREIGN KEY ("tenant_id", "community_id") REFERENCES spark."communities" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "community_topics_fk_21_idx" ON spark."community_topics" ("tenant_id", "community_id");
--> statement-breakpoint
ALTER TABLE spark."content_reports" ADD CONSTRAINT "content_reports_fk_22" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "content_reports_fk_22_idx" ON spark."content_reports" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."content_reports" ADD CONSTRAINT "content_reports_fk_23" FOREIGN KEY ("tenant_id", "community_id") REFERENCES spark."communities" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "content_reports_fk_23_idx" ON spark."content_reports" ("tenant_id", "community_id");
--> statement-breakpoint
ALTER TABLE spark."content_reports" ADD CONSTRAINT "content_reports_fk_24" FOREIGN KEY ("reporter_user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "content_reports_fk_24_idx" ON spark."content_reports" ("reporter_user_id");
--> statement-breakpoint
ALTER TABLE spark."event_attendees" ADD CONSTRAINT "event_attendees_fk_25" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "event_attendees_fk_25_idx" ON spark."event_attendees" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."event_attendees" ADD CONSTRAINT "event_attendees_fk_26" FOREIGN KEY ("user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "event_attendees_fk_26_idx" ON spark."event_attendees" ("user_id");
--> statement-breakpoint
ALTER TABLE spark."event_reminders" ADD CONSTRAINT "event_reminders_fk_27" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "event_reminders_fk_27_idx" ON spark."event_reminders" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."event_reminders" ADD CONSTRAINT "event_reminders_fk_28" FOREIGN KEY ("user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "event_reminders_fk_28_idx" ON spark."event_reminders" ("user_id");
--> statement-breakpoint
ALTER TABLE spark."idempotency_requests" ADD CONSTRAINT "idempotency_requests_fk_29" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "idempotency_requests_fk_29_idx" ON spark."idempotency_requests" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."idempotency_requests" ADD CONSTRAINT "idempotency_requests_fk_30" FOREIGN KEY ("actor_user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "idempotency_requests_fk_30_idx" ON spark."idempotency_requests" ("actor_user_id");
--> statement-breakpoint
ALTER TABLE spark."invoices" ADD CONSTRAINT "invoices_fk_31" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "invoices_fk_31_idx" ON spark."invoices" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."issue_comments" ADD CONSTRAINT "issue_comments_fk_32" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issue_comments_fk_32_idx" ON spark."issue_comments" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."issue_comments" ADD CONSTRAINT "issue_comments_fk_33" FOREIGN KEY ("tenant_id", "project_id") REFERENCES spark."projects" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issue_comments_fk_33_idx" ON spark."issue_comments" ("tenant_id", "project_id");
--> statement-breakpoint
ALTER TABLE spark."issue_comments" ADD CONSTRAINT "issue_comments_fk_34" FOREIGN KEY ("author_user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issue_comments_fk_34_idx" ON spark."issue_comments" ("author_user_id");
--> statement-breakpoint
ALTER TABLE spark."issue_events" ADD CONSTRAINT "issue_events_fk_35" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issue_events_fk_35_idx" ON spark."issue_events" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."issue_events" ADD CONSTRAINT "issue_events_fk_36" FOREIGN KEY ("tenant_id", "project_id") REFERENCES spark."projects" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issue_events_fk_36_idx" ON spark."issue_events" ("tenant_id", "project_id");
--> statement-breakpoint
ALTER TABLE spark."issue_events" ADD CONSTRAINT "issue_events_fk_37" FOREIGN KEY ("actor_user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issue_events_fk_37_idx" ON spark."issue_events" ("actor_user_id");
--> statement-breakpoint
ALTER TABLE spark."issue_label_links" ADD CONSTRAINT "issue_label_links_fk_38" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issue_label_links_fk_38_idx" ON spark."issue_label_links" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."issue_label_links" ADD CONSTRAINT "issue_label_links_fk_39" FOREIGN KEY ("tenant_id", "project_id") REFERENCES spark."projects" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issue_label_links_fk_39_idx" ON spark."issue_label_links" ("tenant_id", "project_id");
--> statement-breakpoint
ALTER TABLE spark."issue_labels" ADD CONSTRAINT "issue_labels_fk_40" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issue_labels_fk_40_idx" ON spark."issue_labels" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."issue_labels" ADD CONSTRAINT "issue_labels_fk_41" FOREIGN KEY ("tenant_id", "project_id") REFERENCES spark."projects" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issue_labels_fk_41_idx" ON spark."issue_labels" ("tenant_id", "project_id");
--> statement-breakpoint
ALTER TABLE spark."issue_links" ADD CONSTRAINT "issue_links_fk_42" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issue_links_fk_42_idx" ON spark."issue_links" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."issue_links" ADD CONSTRAINT "issue_links_fk_43" FOREIGN KEY ("tenant_id", "project_id") REFERENCES spark."projects" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issue_links_fk_43_idx" ON spark."issue_links" ("tenant_id", "project_id");
--> statement-breakpoint
ALTER TABLE spark."issue_statuses" ADD CONSTRAINT "issue_statuses_fk_44" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issue_statuses_fk_44_idx" ON spark."issue_statuses" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."issue_statuses" ADD CONSTRAINT "issue_statuses_fk_45" FOREIGN KEY ("tenant_id", "project_id") REFERENCES spark."projects" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issue_statuses_fk_45_idx" ON spark."issue_statuses" ("tenant_id", "project_id");
--> statement-breakpoint
ALTER TABLE spark."issues" ADD CONSTRAINT "issues_fk_46" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issues_fk_46_idx" ON spark."issues" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."issues" ADD CONSTRAINT "issues_fk_47" FOREIGN KEY ("tenant_id", "project_id") REFERENCES spark."projects" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issues_fk_47_idx" ON spark."issues" ("tenant_id", "project_id");
--> statement-breakpoint
ALTER TABLE spark."issues" ADD CONSTRAINT "issues_fk_48" FOREIGN KEY ("reporter_user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issues_fk_48_idx" ON spark."issues" ("reporter_user_id");
--> statement-breakpoint
ALTER TABLE spark."issues" ADD CONSTRAINT "issues_fk_49" FOREIGN KEY ("assignee_user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issues_fk_49_idx" ON spark."issues" ("assignee_user_id");
--> statement-breakpoint
ALTER TABLE spark."moderation_actions" ADD CONSTRAINT "moderation_actions_fk_50" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "moderation_actions_fk_50_idx" ON spark."moderation_actions" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."moderation_actions" ADD CONSTRAINT "moderation_actions_fk_51" FOREIGN KEY ("tenant_id", "community_id") REFERENCES spark."communities" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "moderation_actions_fk_51_idx" ON spark."moderation_actions" ("tenant_id", "community_id");
--> statement-breakpoint
ALTER TABLE spark."moderation_actions" ADD CONSTRAINT "moderation_actions_fk_52" FOREIGN KEY ("actor_user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "moderation_actions_fk_52_idx" ON spark."moderation_actions" ("actor_user_id");
--> statement-breakpoint
ALTER TABLE spark."notification_deliveries" ADD CONSTRAINT "notification_deliveries_fk_53" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "notification_deliveries_fk_53_idx" ON spark."notification_deliveries" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."notification_preferences" ADD CONSTRAINT "notification_preferences_fk_54" FOREIGN KEY ("user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "notification_preferences_fk_54_idx" ON spark."notification_preferences" ("user_id");
--> statement-breakpoint
ALTER TABLE spark."notifications" ADD CONSTRAINT "notifications_fk_55" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "notifications_fk_55_idx" ON spark."notifications" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."notifications" ADD CONSTRAINT "notifications_fk_56" FOREIGN KEY ("recipient_user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "notifications_fk_56_idx" ON spark."notifications" ("recipient_user_id");
--> statement-breakpoint
ALTER TABLE spark."outbox_events" ADD CONSTRAINT "outbox_events_fk_57" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "outbox_events_fk_57_idx" ON spark."outbox_events" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."password_credentials" ADD CONSTRAINT "password_credentials_fk_58" FOREIGN KEY ("user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "password_credentials_fk_58_idx" ON spark."password_credentials" ("user_id");
--> statement-breakpoint
ALTER TABLE spark."payment_events" ADD CONSTRAINT "payment_events_fk_59" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "payment_events_fk_59_idx" ON spark."payment_events" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."platform_role_assignments" ADD CONSTRAINT "platform_role_assignments_fk_60" FOREIGN KEY ("user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "platform_role_assignments_fk_60_idx" ON spark."platform_role_assignments" ("user_id");
--> statement-breakpoint
ALTER TABLE spark."platform_role_assignments" ADD CONSTRAINT "platform_role_assignments_fk_61" FOREIGN KEY ("granted_by_user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "platform_role_assignments_fk_61_idx" ON spark."platform_role_assignments" ("granted_by_user_id");
--> statement-breakpoint
ALTER TABLE spark."post_comments" ADD CONSTRAINT "post_comments_fk_62" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "post_comments_fk_62_idx" ON spark."post_comments" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."post_comments" ADD CONSTRAINT "post_comments_fk_63" FOREIGN KEY ("tenant_id", "community_id") REFERENCES spark."communities" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "post_comments_fk_63_idx" ON spark."post_comments" ("tenant_id", "community_id");
--> statement-breakpoint
ALTER TABLE spark."post_comments" ADD CONSTRAINT "post_comments_fk_64" FOREIGN KEY ("author_user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "post_comments_fk_64_idx" ON spark."post_comments" ("author_user_id");
--> statement-breakpoint
ALTER TABLE spark."posts" ADD CONSTRAINT "posts_fk_65" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "posts_fk_65_idx" ON spark."posts" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."posts" ADD CONSTRAINT "posts_fk_66" FOREIGN KEY ("tenant_id", "community_id") REFERENCES spark."communities" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "posts_fk_66_idx" ON spark."posts" ("tenant_id", "community_id");
--> statement-breakpoint
ALTER TABLE spark."posts" ADD CONSTRAINT "posts_fk_67" FOREIGN KEY ("author_user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "posts_fk_67_idx" ON spark."posts" ("author_user_id");
--> statement-breakpoint
ALTER TABLE spark."projects" ADD CONSTRAINT "projects_fk_68" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "projects_fk_68_idx" ON spark."projects" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."projects" ADD CONSTRAINT "projects_fk_69" FOREIGN KEY ("lead_user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "projects_fk_69_idx" ON spark."projects" ("lead_user_id");
--> statement-breakpoint
ALTER TABLE spark."promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_fk_70" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "promotion_campaigns_fk_70_idx" ON spark."promotion_campaigns" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_fk_71" FOREIGN KEY ("tenant_id", "community_id") REFERENCES spark."communities" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "promotion_campaigns_fk_71_idx" ON spark."promotion_campaigns" ("tenant_id", "community_id");
--> statement-breakpoint
ALTER TABLE spark."promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_fk_72" FOREIGN KEY ("submitted_by_user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "promotion_campaigns_fk_72_idx" ON spark."promotion_campaigns" ("submitted_by_user_id");
--> statement-breakpoint
ALTER TABLE spark."promotion_metrics_daily" ADD CONSTRAINT "promotion_metrics_daily_fk_73" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "promotion_metrics_daily_fk_73_idx" ON spark."promotion_metrics_daily" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."promotion_order_invoices" ADD CONSTRAINT "promotion_order_invoices_fk_74" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "promotion_order_invoices_fk_74_idx" ON spark."promotion_order_invoices" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."promotion_orders" ADD CONSTRAINT "promotion_orders_fk_75" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "promotion_orders_fk_75_idx" ON spark."promotion_orders" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_fk_76" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "promotion_redemptions_fk_76_idx" ON spark."promotion_redemptions" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_fk_77" FOREIGN KEY ("redeemed_by_user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "promotion_redemptions_fk_77_idx" ON spark."promotion_redemptions" ("redeemed_by_user_id");
--> statement-breakpoint
ALTER TABLE spark."promotion_reviews" ADD CONSTRAINT "promotion_reviews_fk_78" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "promotion_reviews_fk_78_idx" ON spark."promotion_reviews" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."promotion_reviews" ADD CONSTRAINT "promotion_reviews_fk_79" FOREIGN KEY ("reviewer_user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "promotion_reviews_fk_79_idx" ON spark."promotion_reviews" ("reviewer_user_id");
--> statement-breakpoint
ALTER TABLE spark."sessions" ADD CONSTRAINT "sessions_fk_80" FOREIGN KEY ("user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "sessions_fk_80_idx" ON spark."sessions" ("user_id");
--> statement-breakpoint
ALTER TABLE spark."sprints" ADD CONSTRAINT "sprints_fk_81" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "sprints_fk_81_idx" ON spark."sprints" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."sprints" ADD CONSTRAINT "sprints_fk_82" FOREIGN KEY ("tenant_id", "project_id") REFERENCES spark."projects" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "sprints_fk_82_idx" ON spark."sprints" ("tenant_id", "project_id");
--> statement-breakpoint
ALTER TABLE spark."startup_connections" ADD CONSTRAINT "startup_connections_fk_83" FOREIGN KEY ("requested_by_user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "startup_connections_fk_83_idx" ON spark."startup_connections" ("requested_by_user_id");
--> statement-breakpoint
ALTER TABLE spark."startup_connections" ADD CONSTRAINT "startup_connections_fk_84" FOREIGN KEY ("responded_by_user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "startup_connections_fk_84_idx" ON spark."startup_connections" ("responded_by_user_id");
--> statement-breakpoint
ALTER TABLE spark."startup_profiles" ADD CONSTRAINT "startup_profiles_fk_85" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "startup_profiles_fk_85_idx" ON spark."startup_profiles" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."subscriptions" ADD CONSTRAINT "subscriptions_fk_86" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "subscriptions_fk_86_idx" ON spark."subscriptions" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."team_memberships" ADD CONSTRAINT "team_memberships_fk_87" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "team_memberships_fk_87_idx" ON spark."team_memberships" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."team_memberships" ADD CONSTRAINT "team_memberships_fk_88" FOREIGN KEY ("user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "team_memberships_fk_88_idx" ON spark."team_memberships" ("user_id");
--> statement-breakpoint
ALTER TABLE spark."teams" ADD CONSTRAINT "teams_fk_89" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "teams_fk_89_idx" ON spark."teams" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."user_emails" ADD CONSTRAINT "user_emails_fk_90" FOREIGN KEY ("user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "user_emails_fk_90_idx" ON spark."user_emails" ("user_id");
--> statement-breakpoint
ALTER TABLE spark."workflow_transitions" ADD CONSTRAINT "workflow_transitions_fk_91" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "workflow_transitions_fk_91_idx" ON spark."workflow_transitions" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."workflow_transitions" ADD CONSTRAINT "workflow_transitions_fk_92" FOREIGN KEY ("tenant_id", "project_id") REFERENCES spark."projects" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "workflow_transitions_fk_92_idx" ON spark."workflow_transitions" ("tenant_id", "project_id");
--> statement-breakpoint
ALTER TABLE spark."workspace_invitations" ADD CONSTRAINT "workspace_invitations_fk_93" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "workspace_invitations_fk_93_idx" ON spark."workspace_invitations" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."workspace_invitations" ADD CONSTRAINT "workspace_invitations_fk_94" FOREIGN KEY ("invited_by_user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "workspace_invitations_fk_94_idx" ON spark."workspace_invitations" ("invited_by_user_id");
--> statement-breakpoint
ALTER TABLE spark."workspace_invitations" ADD CONSTRAINT "workspace_invitations_fk_95" FOREIGN KEY ("accepted_by_user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "workspace_invitations_fk_95_idx" ON spark."workspace_invitations" ("accepted_by_user_id");
--> statement-breakpoint
ALTER TABLE spark."workspace_memberships" ADD CONSTRAINT "workspace_memberships_fk_96" FOREIGN KEY ("tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "workspace_memberships_fk_96_idx" ON spark."workspace_memberships" ("tenant_id");
--> statement-breakpoint
ALTER TABLE spark."workspace_memberships" ADD CONSTRAINT "workspace_memberships_fk_97" FOREIGN KEY ("user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "workspace_memberships_fk_97_idx" ON spark."workspace_memberships" ("user_id");
--> statement-breakpoint
ALTER TABLE spark."workspaces" ADD CONSTRAINT "workspaces_fk_98" FOREIGN KEY ("created_by_user_id") REFERENCES spark."users" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "workspaces_fk_98_idx" ON spark."workspaces" ("created_by_user_id");
--> statement-breakpoint
ALTER TABLE spark."sessions" ADD CONSTRAINT "sessions_fk_99" FOREIGN KEY ("user_id", "authenticated_identity_id") REFERENCES spark."auth_identities" ("user_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "sessions_fk_99_idx" ON spark."sessions" ("user_id", "authenticated_identity_id");
--> statement-breakpoint
ALTER TABLE spark."sessions" ADD CONSTRAINT "sessions_fk_100" FOREIGN KEY ("user_id", "rotated_from_id") REFERENCES spark."sessions" ("user_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "sessions_fk_100_idx" ON spark."sessions" ("user_id", "rotated_from_id");
--> statement-breakpoint
ALTER TABLE spark."account_tokens" ADD CONSTRAINT "account_tokens_fk_101" FOREIGN KEY ("user_id", "user_email_id") REFERENCES spark."user_emails" ("user_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "account_tokens_fk_101_idx" ON spark."account_tokens" ("user_id", "user_email_id");
--> statement-breakpoint
ALTER TABLE spark."team_memberships" ADD CONSTRAINT "team_memberships_fk_102" FOREIGN KEY ("tenant_id", "team_id") REFERENCES spark."teams" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "team_memberships_fk_102_idx" ON spark."team_memberships" ("tenant_id", "team_id");
--> statement-breakpoint
ALTER TABLE spark."team_memberships" ADD CONSTRAINT "team_memberships_fk_103" FOREIGN KEY ("tenant_id", "user_id") REFERENCES spark."workspace_memberships" ("tenant_id", "user_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "team_memberships_fk_103_idx" ON spark."team_memberships" ("tenant_id", "user_id");
--> statement-breakpoint
ALTER TABLE spark."workspace_invitations" ADD CONSTRAINT "workspace_invitations_fk_104" FOREIGN KEY ("tenant_id", "invited_by_user_id") REFERENCES spark."workspace_memberships" ("tenant_id", "user_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "workspace_invitations_fk_104_idx" ON spark."workspace_invitations" ("tenant_id", "invited_by_user_id");
--> statement-breakpoint
ALTER TABLE spark."startup_connections" ADD CONSTRAINT "startup_connections_fk_105" FOREIGN KEY ("requester_tenant_id", "requested_by_user_id") REFERENCES spark."workspace_memberships" ("tenant_id", "user_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "startup_connections_fk_105_idx" ON spark."startup_connections" ("requester_tenant_id", "requested_by_user_id");
--> statement-breakpoint
ALTER TABLE spark."startup_connections" ADD CONSTRAINT "startup_connections_fk_106" FOREIGN KEY ("recipient_tenant_id", "responded_by_user_id") REFERENCES spark."workspace_memberships" ("tenant_id", "user_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "startup_connections_fk_106_idx" ON spark."startup_connections" ("recipient_tenant_id", "responded_by_user_id");
--> statement-breakpoint
ALTER TABLE spark."startup_connections" ADD CONSTRAINT "startup_connections_fk_107" FOREIGN KEY ("recipient_tenant_id") REFERENCES spark."workspaces" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "startup_connections_fk_107_idx" ON spark."startup_connections" ("recipient_tenant_id");
--> statement-breakpoint
ALTER TABLE spark."community_topics" ADD CONSTRAINT "community_topics_fk_108" FOREIGN KEY ("topic_id") REFERENCES spark."topics" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "community_topics_fk_108_idx" ON spark."community_topics" ("topic_id");
--> statement-breakpoint
ALTER TABLE spark."posts" ADD CONSTRAINT "posts_fk_109" FOREIGN KEY ("tenant_id", "community_id", "author_user_id") REFERENCES spark."community_memberships" ("tenant_id", "community_id", "user_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "posts_fk_109_idx" ON spark."posts" ("tenant_id", "community_id", "author_user_id");
--> statement-breakpoint
ALTER TABLE spark."post_comments" ADD CONSTRAINT "post_comments_fk_110" FOREIGN KEY ("tenant_id", "community_id", "author_user_id") REFERENCES spark."community_memberships" ("tenant_id", "community_id", "user_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "post_comments_fk_110_idx" ON spark."post_comments" ("tenant_id", "community_id", "author_user_id");
--> statement-breakpoint
ALTER TABLE spark."post_comments" ADD CONSTRAINT "post_comments_fk_111" FOREIGN KEY ("tenant_id", "community_id", "post_id") REFERENCES spark."posts" ("tenant_id", "community_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "post_comments_fk_111_idx" ON spark."post_comments" ("tenant_id", "community_id", "post_id");
--> statement-breakpoint
ALTER TABLE spark."content_reports" ADD CONSTRAINT "content_reports_fk_112" FOREIGN KEY ("tenant_id", "community_id", "post_id") REFERENCES spark."posts" ("tenant_id", "community_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "content_reports_fk_112_idx" ON spark."content_reports" ("tenant_id", "community_id", "post_id");
--> statement-breakpoint
ALTER TABLE spark."content_reports" ADD CONSTRAINT "content_reports_fk_113" FOREIGN KEY ("tenant_id", "community_id", "comment_id") REFERENCES spark."post_comments" ("tenant_id", "community_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "content_reports_fk_113_idx" ON spark."content_reports" ("tenant_id", "community_id", "comment_id");
--> statement-breakpoint
ALTER TABLE spark."moderation_actions" ADD CONSTRAINT "moderation_actions_fk_114" FOREIGN KEY ("tenant_id", "community_id", "post_id") REFERENCES spark."posts" ("tenant_id", "community_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "moderation_actions_fk_114_idx" ON spark."moderation_actions" ("tenant_id", "community_id", "post_id");
--> statement-breakpoint
ALTER TABLE spark."moderation_actions" ADD CONSTRAINT "moderation_actions_fk_115" FOREIGN KEY ("tenant_id", "community_id", "comment_id") REFERENCES spark."post_comments" ("tenant_id", "community_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "moderation_actions_fk_115_idx" ON spark."moderation_actions" ("tenant_id", "community_id", "comment_id");
--> statement-breakpoint
ALTER TABLE spark."moderation_actions" ADD CONSTRAINT "moderation_actions_fk_116" FOREIGN KEY ("tenant_id", "community_id", "report_id") REFERENCES spark."content_reports" ("tenant_id", "community_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "moderation_actions_fk_116_idx" ON spark."moderation_actions" ("tenant_id", "community_id", "report_id");
--> statement-breakpoint
ALTER TABLE spark."moderation_actions" ADD CONSTRAINT "moderation_actions_fk_117" FOREIGN KEY ("tenant_id", "community_id", "actor_user_id") REFERENCES spark."community_memberships" ("tenant_id", "community_id", "user_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "moderation_actions_fk_117_idx" ON spark."moderation_actions" ("tenant_id", "community_id", "actor_user_id");
--> statement-breakpoint
ALTER TABLE spark."projects" ADD CONSTRAINT "projects_fk_118" FOREIGN KEY ("tenant_id", "lead_user_id") REFERENCES spark."workspace_memberships" ("tenant_id", "user_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "projects_fk_118_idx" ON spark."projects" ("tenant_id", "lead_user_id");
--> statement-breakpoint
ALTER TABLE spark."issues" ADD CONSTRAINT "issues_fk_119" FOREIGN KEY ("tenant_id", "reporter_user_id") REFERENCES spark."workspace_memberships" ("tenant_id", "user_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issues_fk_119_idx" ON spark."issues" ("tenant_id", "reporter_user_id");
--> statement-breakpoint
ALTER TABLE spark."issues" ADD CONSTRAINT "issues_fk_120" FOREIGN KEY ("tenant_id", "assignee_user_id") REFERENCES spark."workspace_memberships" ("tenant_id", "user_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issues_fk_120_idx" ON spark."issues" ("tenant_id", "assignee_user_id");
--> statement-breakpoint
ALTER TABLE spark."issue_comments" ADD CONSTRAINT "issue_comments_fk_121" FOREIGN KEY ("tenant_id", "author_user_id") REFERENCES spark."workspace_memberships" ("tenant_id", "user_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issue_comments_fk_121_idx" ON spark."issue_comments" ("tenant_id", "author_user_id");
--> statement-breakpoint
ALTER TABLE spark."issue_events" ADD CONSTRAINT "issue_events_fk_122" FOREIGN KEY ("tenant_id", "actor_user_id") REFERENCES spark."workspace_memberships" ("tenant_id", "user_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issue_events_fk_122_idx" ON spark."issue_events" ("tenant_id", "actor_user_id");
--> statement-breakpoint
ALTER TABLE spark."calendar_events" ADD CONSTRAINT "calendar_events_fk_123" FOREIGN KEY ("tenant_id", "organizer_user_id") REFERENCES spark."workspace_memberships" ("tenant_id", "user_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "calendar_events_fk_123_idx" ON spark."calendar_events" ("tenant_id", "organizer_user_id");
--> statement-breakpoint
ALTER TABLE spark."event_attendees" ADD CONSTRAINT "event_attendees_fk_124" FOREIGN KEY ("tenant_id", "user_id") REFERENCES spark."workspace_memberships" ("tenant_id", "user_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "event_attendees_fk_124_idx" ON spark."event_attendees" ("tenant_id", "user_id");
--> statement-breakpoint
ALTER TABLE spark."promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_fk_125" FOREIGN KEY ("tenant_id", "redeemed_by_user_id") REFERENCES spark."workspace_memberships" ("tenant_id", "user_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "promotion_redemptions_fk_125_idx" ON spark."promotion_redemptions" ("tenant_id", "redeemed_by_user_id");
--> statement-breakpoint
ALTER TABLE spark."promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_fk_126" FOREIGN KEY ("tenant_id", "submitted_by_user_id") REFERENCES spark."workspace_memberships" ("tenant_id", "user_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "promotion_campaigns_fk_126_idx" ON spark."promotion_campaigns" ("tenant_id", "submitted_by_user_id");
--> statement-breakpoint
ALTER TABLE spark."workflow_transitions" ADD CONSTRAINT "workflow_transitions_fk_127" FOREIGN KEY ("tenant_id", "project_id", "from_status_id") REFERENCES spark."issue_statuses" ("tenant_id", "project_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "workflow_transitions_fk_127_idx" ON spark."workflow_transitions" ("tenant_id", "project_id", "from_status_id");
--> statement-breakpoint
ALTER TABLE spark."workflow_transitions" ADD CONSTRAINT "workflow_transitions_fk_128" FOREIGN KEY ("tenant_id", "project_id", "to_status_id") REFERENCES spark."issue_statuses" ("tenant_id", "project_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "workflow_transitions_fk_128_idx" ON spark."workflow_transitions" ("tenant_id", "project_id", "to_status_id");
--> statement-breakpoint
ALTER TABLE spark."issues" ADD CONSTRAINT "issues_fk_129" FOREIGN KEY ("tenant_id", "project_id", "status_id") REFERENCES spark."issue_statuses" ("tenant_id", "project_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issues_fk_129_idx" ON spark."issues" ("tenant_id", "project_id", "status_id");
--> statement-breakpoint
ALTER TABLE spark."issues" ADD CONSTRAINT "issues_fk_130" FOREIGN KEY ("tenant_id", "project_id", "parent_issue_id") REFERENCES spark."issues" ("tenant_id", "project_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issues_fk_130_idx" ON spark."issues" ("tenant_id", "project_id", "parent_issue_id");
--> statement-breakpoint
ALTER TABLE spark."issues" ADD CONSTRAINT "issues_fk_131" FOREIGN KEY ("tenant_id", "project_id", "sprint_id") REFERENCES spark."sprints" ("tenant_id", "project_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issues_fk_131_idx" ON spark."issues" ("tenant_id", "project_id", "sprint_id");
--> statement-breakpoint
ALTER TABLE spark."issue_label_links" ADD CONSTRAINT "issue_label_links_fk_132" FOREIGN KEY ("tenant_id", "project_id", "issue_id") REFERENCES spark."issues" ("tenant_id", "project_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issue_label_links_fk_132_idx" ON spark."issue_label_links" ("tenant_id", "project_id", "issue_id");
--> statement-breakpoint
ALTER TABLE spark."issue_label_links" ADD CONSTRAINT "issue_label_links_fk_133" FOREIGN KEY ("tenant_id", "project_id", "label_id") REFERENCES spark."issue_labels" ("tenant_id", "project_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issue_label_links_fk_133_idx" ON spark."issue_label_links" ("tenant_id", "project_id", "label_id");
--> statement-breakpoint
ALTER TABLE spark."issue_comments" ADD CONSTRAINT "issue_comments_fk_134" FOREIGN KEY ("tenant_id", "project_id", "issue_id") REFERENCES spark."issues" ("tenant_id", "project_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issue_comments_fk_134_idx" ON spark."issue_comments" ("tenant_id", "project_id", "issue_id");
--> statement-breakpoint
ALTER TABLE spark."issue_events" ADD CONSTRAINT "issue_events_fk_135" FOREIGN KEY ("tenant_id", "project_id", "issue_id") REFERENCES spark."issues" ("tenant_id", "project_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issue_events_fk_135_idx" ON spark."issue_events" ("tenant_id", "project_id", "issue_id");
--> statement-breakpoint
ALTER TABLE spark."issue_links" ADD CONSTRAINT "issue_links_fk_136" FOREIGN KEY ("tenant_id", "project_id", "source_issue_id") REFERENCES spark."issues" ("tenant_id", "project_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issue_links_fk_136_idx" ON spark."issue_links" ("tenant_id", "project_id", "source_issue_id");
--> statement-breakpoint
ALTER TABLE spark."issue_links" ADD CONSTRAINT "issue_links_fk_137" FOREIGN KEY ("tenant_id", "project_id", "target_issue_id") REFERENCES spark."issues" ("tenant_id", "project_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issue_links_fk_137_idx" ON spark."issue_links" ("tenant_id", "project_id", "target_issue_id");
--> statement-breakpoint
ALTER TABLE spark."calendar_events" ADD CONSTRAINT "calendar_events_fk_138" FOREIGN KEY ("tenant_id", "project_id", "issue_id") REFERENCES spark."issues" ("tenant_id", "project_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "calendar_events_fk_138_idx" ON spark."calendar_events" ("tenant_id", "project_id", "issue_id");
--> statement-breakpoint
ALTER TABLE spark."issues" ADD CONSTRAINT "issues_fk_139" FOREIGN KEY ("tenant_id", "team_id") REFERENCES spark."teams" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "issues_fk_139_idx" ON spark."issues" ("tenant_id", "team_id");
--> statement-breakpoint
ALTER TABLE spark."event_attendees" ADD CONSTRAINT "event_attendees_fk_140" FOREIGN KEY ("tenant_id", "event_id") REFERENCES spark."calendar_events" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "event_attendees_fk_140_idx" ON spark."event_attendees" ("tenant_id", "event_id");
--> statement-breakpoint
ALTER TABLE spark."event_reminders" ADD CONSTRAINT "event_reminders_fk_141" FOREIGN KEY ("tenant_id", "event_id", "user_id") REFERENCES spark."event_attendees" ("tenant_id", "event_id", "user_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "event_reminders_fk_141_idx" ON spark."event_reminders" ("tenant_id", "event_id", "user_id");
--> statement-breakpoint
ALTER TABLE spark."plan_prices" ADD CONSTRAINT "plan_prices_fk_142" FOREIGN KEY ("plan_id") REFERENCES spark."subscription_plans" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "plan_prices_fk_142_idx" ON spark."plan_prices" ("plan_id");
--> statement-breakpoint
ALTER TABLE spark."plan_entitlements" ADD CONSTRAINT "plan_entitlements_fk_143" FOREIGN KEY ("plan_id") REFERENCES spark."subscription_plans" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "plan_entitlements_fk_143_idx" ON spark."plan_entitlements" ("plan_id");
--> statement-breakpoint
ALTER TABLE spark."subscriptions" ADD CONSTRAINT "subscriptions_fk_144" FOREIGN KEY ("plan_id") REFERENCES spark."subscription_plans" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "subscriptions_fk_144_idx" ON spark."subscriptions" ("plan_id");
--> statement-breakpoint
ALTER TABLE spark."subscriptions" ADD CONSTRAINT "subscriptions_fk_145" FOREIGN KEY ("plan_id", "price_id") REFERENCES spark."plan_prices" ("plan_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "subscriptions_fk_145_idx" ON spark."subscriptions" ("plan_id", "price_id");
--> statement-breakpoint
ALTER TABLE spark."subscriptions" ADD CONSTRAINT "subscriptions_fk_146" FOREIGN KEY ("price_id", "provider") REFERENCES spark."plan_prices" ("id", "provider") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "subscriptions_fk_146_idx" ON spark."subscriptions" ("price_id", "provider");
--> statement-breakpoint
ALTER TABLE spark."subscriptions" ADD CONSTRAINT "subscriptions_fk_147" FOREIGN KEY ("tenant_id", "billing_customer_id", "provider") REFERENCES spark."billing_customers" ("tenant_id", "id", "provider") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "subscriptions_fk_147_idx" ON spark."subscriptions" ("tenant_id", "billing_customer_id", "provider");
--> statement-breakpoint
ALTER TABLE spark."invoices" ADD CONSTRAINT "invoices_fk_148" FOREIGN KEY ("tenant_id", "subscription_id", "provider") REFERENCES spark."subscriptions" ("tenant_id", "id", "provider") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "invoices_fk_148_idx" ON spark."invoices" ("tenant_id", "subscription_id", "provider");
--> statement-breakpoint
ALTER TABLE spark."promotion_prices" ADD CONSTRAINT "promotion_prices_fk_149" FOREIGN KEY ("promotion_id") REFERENCES spark."promotions" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "promotion_prices_fk_149_idx" ON spark."promotion_prices" ("promotion_id");
--> statement-breakpoint
ALTER TABLE spark."promotion_prices" ADD CONSTRAINT "promotion_prices_fk_150" FOREIGN KEY ("price_id") REFERENCES spark."plan_prices" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "promotion_prices_fk_150_idx" ON spark."promotion_prices" ("price_id");
--> statement-breakpoint
ALTER TABLE spark."promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_fk_151" FOREIGN KEY ("promotion_id") REFERENCES spark."promotions" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "promotion_redemptions_fk_151_idx" ON spark."promotion_redemptions" ("promotion_id");
--> statement-breakpoint
ALTER TABLE spark."promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_fk_152" FOREIGN KEY ("tenant_id", "subscription_id") REFERENCES spark."subscriptions" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "promotion_redemptions_fk_152_idx" ON spark."promotion_redemptions" ("tenant_id", "subscription_id");
--> statement-breakpoint
ALTER TABLE spark."notifications" ADD CONSTRAINT "notifications_fk_153" FOREIGN KEY ("tenant_id", "outbox_event_id") REFERENCES spark."outbox_events" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "notifications_fk_153_idx" ON spark."notifications" ("tenant_id", "outbox_event_id");
--> statement-breakpoint
ALTER TABLE spark."notification_deliveries" ADD CONSTRAINT "notification_deliveries_fk_154" FOREIGN KEY ("tenant_id", "notification_id") REFERENCES spark."notifications" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "notification_deliveries_fk_154_idx" ON spark."notification_deliveries" ("tenant_id", "notification_id");
--> statement-breakpoint
ALTER TABLE spark."promotion_plans" ADD CONSTRAINT "promotion_plans_fk_155" FOREIGN KEY ("placement_id") REFERENCES spark."promotion_placements" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "promotion_plans_fk_155_idx" ON spark."promotion_plans" ("placement_id");
--> statement-breakpoint
ALTER TABLE spark."promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_fk_156" FOREIGN KEY ("placement_id") REFERENCES spark."promotion_placements" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "promotion_campaigns_fk_156_idx" ON spark."promotion_campaigns" ("placement_id");
--> statement-breakpoint
ALTER TABLE spark."promotion_orders" ADD CONSTRAINT "promotion_orders_fk_157" FOREIGN KEY ("tenant_id", "campaign_id") REFERENCES spark."promotion_campaigns" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "promotion_orders_fk_157_idx" ON spark."promotion_orders" ("tenant_id", "campaign_id");
--> statement-breakpoint
ALTER TABLE spark."promotion_orders" ADD CONSTRAINT "promotion_orders_fk_158" FOREIGN KEY ("tenant_id", "billing_customer_id", "provider") REFERENCES spark."billing_customers" ("tenant_id", "id", "provider") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "promotion_orders_fk_158_idx" ON spark."promotion_orders" ("tenant_id", "billing_customer_id", "provider");
--> statement-breakpoint
ALTER TABLE spark."promotion_orders" ADD CONSTRAINT "promotion_orders_fk_159" FOREIGN KEY ("promotion_plan_id", "provider", "currency", "amount_minor", "duration_days") REFERENCES spark."promotion_plans" ("id", "provider", "currency", "amount_minor", "duration_days") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "promotion_orders_fk_159_idx" ON spark."promotion_orders" ("promotion_plan_id", "provider", "currency", "amount_minor", "duration_days");
--> statement-breakpoint
ALTER TABLE spark."promotion_order_invoices" ADD CONSTRAINT "promotion_order_invoices_fk_160" FOREIGN KEY ("tenant_id", "order_id", "provider", "currency") REFERENCES spark."promotion_orders" ("tenant_id", "id", "provider", "currency") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "promotion_order_invoices_fk_160_idx" ON spark."promotion_order_invoices" ("tenant_id", "order_id", "provider", "currency");
--> statement-breakpoint
ALTER TABLE spark."promotion_reviews" ADD CONSTRAINT "promotion_reviews_fk_161" FOREIGN KEY ("tenant_id", "campaign_id") REFERENCES spark."promotion_campaigns" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "promotion_reviews_fk_161_idx" ON spark."promotion_reviews" ("tenant_id", "campaign_id");
--> statement-breakpoint
ALTER TABLE spark."promotion_metrics_daily" ADD CONSTRAINT "promotion_metrics_daily_fk_162" FOREIGN KEY ("tenant_id", "campaign_id") REFERENCES spark."promotion_campaigns" ("tenant_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "promotion_metrics_daily_fk_162_idx" ON spark."promotion_metrics_daily" ("tenant_id", "campaign_id");
