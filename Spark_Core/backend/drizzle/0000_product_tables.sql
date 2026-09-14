CREATE SCHEMA "spark";
--> statement-breakpoint
CREATE TABLE "spark"."account_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"user_email_id" uuid,
	"purpose" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spark"."account_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"actor_kind" text NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"request_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."auth_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"issuer" text NOT NULL,
	"provider_subject" text NOT NULL,
	"provider_email" text,
	"provider_email_verified" boolean DEFAULT false NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spark"."auth_identities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."billing_customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_customer_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."billing_customers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."boards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."boards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid,
	"issue_id" uuid,
	"organizer_user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"location" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."calendar_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."communities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"country_code" text,
	"city" text,
	"stage" text,
	"created_by_user_id" uuid NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spark"."communities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."community_join_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"message" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spark"."community_join_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."community_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spark"."community_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."community_topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."community_topics" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."content_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"reporter_user_id" uuid NOT NULL,
	"post_id" uuid,
	"comment_id" uuid,
	"reason_code" text NOT NULL,
	"details" text,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spark"."content_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."event_attendees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"response" text DEFAULT 'pending' NOT NULL,
	"responded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spark"."event_attendees" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."event_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"event_version" integer NOT NULL,
	"minutes_before" integer NOT NULL,
	"channel" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spark"."event_reminders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."idempotency_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" "bytea" NOT NULL,
	"state" text DEFAULT 'started' NOT NULL,
	"resource_id" uuid,
	"response_status" integer,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."idempotency_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_invoice_id" text NOT NULL,
	"currency" text NOT NULL,
	"subtotal_minor" bigint NOT NULL,
	"discount_minor" bigint DEFAULT 0 NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"total_minor" bigint NOT NULL,
	"status" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone,
	"paid_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spark"."invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."issue_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spark"."issue_comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."issue_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"from_version" integer NOT NULL,
	"to_version" integer NOT NULL,
	"changes" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."issue_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."issue_label_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"label_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."issue_label_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."issue_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."issue_labels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."issue_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source_issue_id" uuid NOT NULL,
	"target_issue_id" uuid NOT NULL,
	"type" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."issue_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."issue_statuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"position" numeric(20, 6) DEFAULT '0' NOT NULL,
	"wip_limit" integer
);
--> statement-breakpoint
ALTER TABLE "spark"."issue_statuses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"number" bigint NOT NULL,
	"type" text DEFAULT 'task' NOT NULL,
	"parent_issue_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"status_id" uuid NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"reporter_user_id" uuid NOT NULL,
	"assignee_user_id" uuid,
	"team_id" uuid,
	"sprint_id" uuid,
	"position" numeric(20, 6) DEFAULT '0' NOT NULL,
	"story_points" numeric(8, 2),
	"start_date" date,
	"due_date" date,
	"completed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spark"."issues" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."moderation_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"report_id" uuid,
	"post_id" uuid,
	"comment_id" uuid,
	"actor_user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."moderation_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"provider_message_id" text,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spark"."notification_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."notification_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"outbox_event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spark"."notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"aggregate_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"lock_token" uuid,
	"processed_at" timestamp with time zone,
	"last_error_code" text
);
--> statement-breakpoint
ALTER TABLE "spark"."outbox_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."password_credentials" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."password_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"tenant_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_occurred_at" timestamp with time zone,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"processed_at" timestamp with time zone,
	"last_error_code" text
);
--> statement-breakpoint
ALTER TABLE "spark"."payment_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."plan_entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"plan_id" uuid NOT NULL,
	"feature_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"limit_value" bigint
);
--> statement-breakpoint
ALTER TABLE "spark"."plan_entitlements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."plan_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"plan_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"billing_interval" text NOT NULL,
	"interval_count" integer DEFAULT 1 NOT NULL,
	"provider" text,
	"provider_price_id" text,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."plan_prices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."platform_role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"granted_by_user_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spark"."platform_role_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."post_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"moderation_status" text DEFAULT 'visible' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spark"."post_comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"visibility" text DEFAULT 'members' NOT NULL,
	"moderation_status" text DEFAULT 'visible' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spark"."posts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"lead_user_id" uuid,
	"next_issue_number" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spark"."projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."promotion_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"name" text NOT NULL,
	"headline" text NOT NULL,
	"description" text NOT NULL,
	"placement_id" uuid NOT NULL,
	"submitted_by_user_id" uuid NOT NULL,
	"review_status" text DEFAULT 'draft' NOT NULL,
	"delivery_status" text DEFAULT 'unscheduled' NOT NULL,
	"requested_start_at" timestamp with time zone NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"approved_version" integer,
	"version" integer DEFAULT 1 NOT NULL,
	"cancellation_requested_at" timestamp with time zone,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spark"."promotion_campaigns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."promotion_metrics_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"metric_date" date NOT NULL,
	"impressions" bigint DEFAULT 0 NOT NULL,
	"clicks" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."promotion_metrics_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."promotion_order_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_invoice_id" text NOT NULL,
	"currency" text NOT NULL,
	"subtotal_minor" bigint NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"total_minor" bigint NOT NULL,
	"status" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spark"."promotion_order_invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."promotion_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"promotion_plan_id" uuid NOT NULL,
	"billing_customer_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_checkout_id" text,
	"provider_payment_id" text,
	"idempotency_key" text NOT NULL,
	"currency" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"duration_days" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"paid_at" timestamp with time zone,
	"terms_snapshot" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."promotion_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."promotion_placements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."promotion_placements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."promotion_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"placement_id" uuid NOT NULL,
	"duration_days" integer NOT NULL,
	"currency" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"provider" text NOT NULL,
	"provider_price_id" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."promotion_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."promotion_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"promotion_id" uuid NOT NULL,
	"price_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."promotion_prices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."promotion_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"promotion_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"redeemed_by_user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"reserved_until" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone,
	"provider_checkout_id" text,
	"terms_snapshot" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."promotion_redemptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."promotion_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"campaign_version" integer NOT NULL,
	"reviewer_user_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"reason" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."promotion_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code_normalized" text NOT NULL,
	"name" text NOT NULL,
	"discount_type" text NOT NULL,
	"percent_bps" integer,
	"amount_minor" bigint,
	"currency" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"max_redemptions" bigint,
	"max_per_tenant" integer DEFAULT 1 NOT NULL,
	"duration_cycles" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."promotions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"authenticated_identity_id" uuid,
	"auth_method" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"rotated_from_id" uuid
);
--> statement-breakpoint
ALTER TABLE "spark"."sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."sprints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"goal" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"status" text DEFAULT 'planned' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."sprints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."startup_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requester_tenant_id" uuid NOT NULL,
	"recipient_tenant_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"message" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"responded_by_user_id" uuid,
	"responded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spark"."startup_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."startup_profiles" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tagline" text,
	"description" text,
	"website_url" text,
	"stage" text DEFAULT 'idea' NOT NULL,
	"country_code" text,
	"city" text,
	"founded_on" date,
	"connection_intent" text,
	"is_discoverable" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."startup_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."subscription_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."subscription_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"billing_customer_id" uuid,
	"plan_id" uuid NOT NULL,
	"price_id" uuid,
	"provider" text,
	"provider_subscription_id" text,
	"status" text DEFAULT 'incomplete' NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"cancelled_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."team_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."team_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spark"."teams" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."topics" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."user_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"normalized_email" text NOT NULL,
	"verified_at" timestamp with time zone,
	"is_primary" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."user_emails" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spark"."users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."workflow_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"from_status_id" uuid NOT NULL,
	"to_status_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spark"."workflow_transitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."workspace_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email_normalized" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"accepted_by_user_id" uuid,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spark"."workspace_invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."workspace_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spark"."workspace_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spark"."workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spark"."workspaces" ENABLE ROW LEVEL SECURITY;