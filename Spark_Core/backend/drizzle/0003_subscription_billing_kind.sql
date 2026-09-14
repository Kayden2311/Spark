ALTER TABLE "spark"."subscription_plans" ADD COLUMN "billing_kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "spark"."subscriptions" ADD COLUMN "billing_kind" text NOT NULL;