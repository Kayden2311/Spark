import { sql, type InferInsertModel, type InferSelectModel, type Table } from "drizzle-orm";
import { pgSchema, uuid, text, boolean, integer, bigint, numeric, timestamp, date, jsonb, customType } from "drizzle-orm/pg-core";

// A private schema keeps application data outside Supabase's default Data API.
// Cross-table constraints, indexes, FORCE RLS, and grants live in reviewed SQL.
export const spark = pgSchema("spark");
export type DatabaseRow<TTable extends Table> = InferSelectModel<TTable>;
export type DatabaseInsert<TTable extends Table> = InferInsertModel<TTable>;

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
const instant = (name: string) => timestamp(name, { withTimezone: true });
const ref = (name: string) => uuid(name);
const state = <T extends string>(name: string, values: readonly [T, ...T[]]) => text(name, { enum: values });
const amount = (name: string) => bigint(name, { mode: "bigint" });
const base = () => ({ id: uuid("id").primaryKey().defaultRandom(), createdAt: instant("created_at").notNull().defaultNow() });
const mutable = () => ({ ...base(), updatedAt: instant("updated_at").notNull().defaultNow() });
const tenant = () => ({ ...mutable(), tenantId: ref("tenant_id").notNull() });
const project = () => ({ ...tenant(), projectId: ref("project_id").notNull() });
const community = () => ({ ...tenant(), communityId: ref("community_id").notNull() });
const version = () => integer("version").notNull().default(1);
const position = () => numeric("position", { precision: 20, scale: 6 }).notNull().default("0");

export const users = spark.table("users", {
  ...mutable(), displayName: text("display_name").notNull(), avatarUrl: text("avatar_url"),
  locale: text("locale").notNull().default("en"), timezone: text("timezone").notNull().default("UTC"),
  status: state("status", ["active", "suspended", "deleted"]).notNull().default("active"),
  lastLoginAt: instant("last_login_at"), deletedAt: instant("deleted_at"),
}).enableRLS();
export const userEmails = spark.table("user_emails", {
  ...mutable(), userId: ref("user_id").notNull(), email: text("email").notNull(), normalizedEmail: text("normalized_email").notNull(),
  verifiedAt: instant("verified_at"), isPrimary: boolean("is_primary").notNull().default(false),
}).enableRLS();
export const passwordCredentials = spark.table("password_credentials", {
  userId: ref("user_id").primaryKey(), passwordHash: text("password_hash").notNull(),
  passwordChangedAt: instant("password_changed_at").notNull().defaultNow(), createdAt: instant("created_at").notNull().defaultNow(),
  updatedAt: instant("updated_at").notNull().defaultNow(),
}).enableRLS();
export const authIdentities = spark.table("auth_identities", {
  ...mutable(), userId: ref("user_id").notNull(), provider: text("provider").notNull(), issuer: text("issuer").notNull(),
  providerSubject: text("provider_subject").notNull(), providerEmail: text("provider_email"),
  providerEmailVerified: boolean("provider_email_verified").notNull().default(false),
  linkedAt: instant("linked_at").notNull().defaultNow(), lastLoginAt: instant("last_login_at"),
}).enableRLS();
export const sessions = spark.table("sessions", {
  ...mutable(), userId: ref("user_id").notNull(), tokenHash: bytea("token_hash").notNull(), authenticatedIdentityId: ref("authenticated_identity_id"),
  authMethod: state("auth_method", ["password", "oauth"]).notNull(), lastSeenAt: instant("last_seen_at").notNull().defaultNow(),
  expiresAt: instant("expires_at").notNull(), revokedAt: instant("revoked_at"), rotatedFromId: ref("rotated_from_id"),
}).enableRLS();
export const accountTokens = spark.table("account_tokens", {
  ...mutable(), userId: ref("user_id").notNull(), userEmailId: ref("user_email_id"), purpose: state("purpose", ["verify_email", "reset_password"]).notNull(),
  tokenHash: bytea("token_hash").notNull(), expiresAt: instant("expires_at").notNull(), consumedAt: instant("consumed_at"),
}).enableRLS();
export const workspaces = spark.table("workspaces", {
  ...mutable(), slug: text("slug").notNull(), name: text("name").notNull(), status: state("status", ["active", "archived"]).notNull().default("active"),
  createdByUserId: ref("created_by_user_id").notNull(), archivedAt: instant("archived_at"),
}).enableRLS();
export const workspaceMemberships = spark.table("workspace_memberships", {
  ...tenant(), userId: ref("user_id").notNull(), role: state("role", ["owner", "admin", "member"]).notNull().default("member"),
  status: state("status", ["active", "suspended", "left"]).notNull().default("active"), joinedAt: instant("joined_at").notNull().defaultNow(), leftAt: instant("left_at"),
}).enableRLS();
export const startupProfiles = spark.table("startup_profiles", {
  tenantId: ref("tenant_id").primaryKey(), createdAt: instant("created_at").notNull().defaultNow(), updatedAt: instant("updated_at").notNull().defaultNow(),
  tagline: text("tagline"), description: text("description"), websiteUrl: text("website_url"), stage: state("stage", ["idea", "validation", "mvp", "growth", "established"]).notNull().default("idea"),
  countryCode: text("country_code"), city: text("city"), foundedOn: date("founded_on"), connectionIntent: text("connection_intent"), isDiscoverable: boolean("is_discoverable").notNull().default(false),
}).enableRLS();
export const teams = spark.table("teams", { ...tenant(), name: text("name").notNull(), description: text("description"), archivedAt: instant("archived_at") }).enableRLS();
export const teamMemberships = spark.table("team_memberships", { ...tenant(), teamId: ref("team_id").notNull(), userId: ref("user_id").notNull(), role: state("role", ["lead", "member"]).notNull().default("member") }).enableRLS();
export const workspaceInvitations = spark.table("workspace_invitations", {
  ...tenant(), emailNormalized: text("email_normalized").notNull(), role: state("role", ["admin", "member"]).notNull().default("member"),
  tokenHash: bytea("token_hash").notNull(), invitedByUserId: ref("invited_by_user_id").notNull(), expiresAt: instant("expires_at").notNull(),
  status: state("status", ["pending", "accepted", "revoked", "expired"]).notNull().default("pending"), acceptedByUserId: ref("accepted_by_user_id"), acceptedAt: instant("accepted_at"), revokedAt: instant("revoked_at"),
}).enableRLS();
export const startupConnections = spark.table("startup_connections", {
  ...mutable(), requesterTenantId: ref("requester_tenant_id").notNull(), recipientTenantId: ref("recipient_tenant_id").notNull(), requestedByUserId: ref("requested_by_user_id").notNull(),
  message: text("message"), status: state("status", ["pending", "accepted", "rejected", "withdrawn", "disconnected"]).notNull().default("pending"), respondedByUserId: ref("responded_by_user_id"), respondedAt: instant("responded_at"),
}).enableRLS();
export const communities = spark.table("communities", {
  ...tenant(), slug: text("slug").notNull(), name: text("name").notNull(), description: text("description").notNull(),
  visibility: state("visibility", ["public", "private", "hidden"]).notNull().default("private"), countryCode: text("country_code"), city: text("city"), stage: text("stage"),
  createdByUserId: ref("created_by_user_id").notNull(), archivedAt: instant("archived_at"),
}).enableRLS();
export const topics = spark.table("topics", { ...mutable(), slug: text("slug").notNull(), name: text("name").notNull() }).enableRLS();
export const communityTopics = spark.table("community_topics", { ...community(), topicId: ref("topic_id").notNull() }).enableRLS();
export const communityMemberships = spark.table("community_memberships", {
  ...community(), userId: ref("user_id").notNull(), role: state("role", ["owner", "moderator", "member"]).notNull().default("member"),
  status: state("status", ["active", "suspended", "left"]).notNull().default("active"), joinedAt: instant("joined_at").notNull().defaultNow(), leftAt: instant("left_at"),
}).enableRLS();
export const communityJoinRequests = spark.table("community_join_requests", {
  ...community(), userId: ref("user_id").notNull(), message: text("message"), status: state("status", ["pending", "approved", "rejected", "withdrawn"]).notNull().default("pending"), reviewedByUserId: ref("reviewed_by_user_id"), reviewedAt: instant("reviewed_at"),
}).enableRLS();
export const posts = spark.table("posts", {
  ...community(), authorUserId: ref("author_user_id").notNull(), title: text("title").notNull(), body: text("body").notNull(),
  visibility: state("visibility", ["public", "members", "hidden"]).notNull().default("members"), moderationStatus: state("moderation_status", ["visible", "hidden"]).notNull().default("visible"), version: version(), deletedAt: instant("deleted_at"),
}).enableRLS();
export const postComments = spark.table("post_comments", {
  ...community(), postId: ref("post_id").notNull(), authorUserId: ref("author_user_id").notNull(), body: text("body").notNull(), moderationStatus: state("moderation_status", ["visible", "hidden"]).notNull().default("visible"), version: version(), deletedAt: instant("deleted_at"),
}).enableRLS();
export const contentReports = spark.table("content_reports", {
  ...community(), reporterUserId: ref("reporter_user_id").notNull(), postId: ref("post_id"), commentId: ref("comment_id"), reasonCode: text("reason_code").notNull(), details: text("details"),
  status: state("status", ["open", "reviewing", "resolved", "dismissed"]).notNull().default("open"), resolvedAt: instant("resolved_at"),
}).enableRLS();
export const moderationActions = spark.table("moderation_actions", {
  ...base(), tenantId: ref("tenant_id").notNull(), communityId: ref("community_id").notNull(), reportId: ref("report_id"), postId: ref("post_id"), commentId: ref("comment_id"), actorUserId: ref("actor_user_id").notNull(), action: state("action", ["hide", "restore", "dismiss_report"]).notNull(), reason: text("reason").notNull(),
}).enableRLS();
export const projects = spark.table("projects", {
  ...tenant(), key: text("key").notNull(), name: text("name").notNull(), description: text("description"), leadUserId: ref("lead_user_id"), nextIssueNumber: amount("next_issue_number").notNull().default(sql`1`), archivedAt: instant("archived_at"),
}).enableRLS();
export const boards = spark.table("boards", { ...project(), name: text("name").notNull(), version: version() }).enableRLS();
export const issueStatuses = spark.table("issue_statuses", {
  ...project(), name: text("name").notNull(), category: state("category", ["backlog", "todo", "in_progress", "done"]).notNull(), position: position(), wipLimit: integer("wip_limit"),
}).enableRLS();
export const workflowTransitions = spark.table("workflow_transitions", { ...project(), fromStatusId: ref("from_status_id").notNull(), toStatusId: ref("to_status_id").notNull() }).enableRLS();
export const sprints = spark.table("sprints", {
  ...project(), name: text("name").notNull(), goal: text("goal"), startsAt: instant("starts_at"), endsAt: instant("ends_at"), status: state("status", ["planned", "active", "completed", "cancelled"]).notNull().default("planned"),
}).enableRLS();
export const issues = spark.table("issues", {
  ...project(), number: amount("number").notNull(), type: state("type", ["epic", "story", "task", "bug", "subtask"]).notNull().default("task"), parentIssueId: ref("parent_issue_id"), title: text("title").notNull(), description: text("description"),
  statusId: ref("status_id").notNull(), priority: state("priority", ["lowest", "low", "medium", "high", "highest"]).notNull().default("medium"), reporterUserId: ref("reporter_user_id").notNull(), assigneeUserId: ref("assignee_user_id"), teamId: ref("team_id"), sprintId: ref("sprint_id"),
  position: position(), storyPoints: numeric("story_points", { precision: 8, scale: 2 }), startDate: date("start_date"), dueDate: date("due_date"), completedAt: instant("completed_at"), version: version(), archivedAt: instant("archived_at"),
}).enableRLS();
export const issueLabels = spark.table("issue_labels", { ...project(), name: text("name").notNull(), color: text("color").notNull() }).enableRLS();
export const issueLabelLinks = spark.table("issue_label_links", { ...project(), issueId: ref("issue_id").notNull(), labelId: ref("label_id").notNull() }).enableRLS();
export const issueComments = spark.table("issue_comments", { ...project(), issueId: ref("issue_id").notNull(), authorUserId: ref("author_user_id").notNull(), body: text("body").notNull(), version: version(), deletedAt: instant("deleted_at") }).enableRLS();
export const issueLinks = spark.table("issue_links", { ...project(), sourceIssueId: ref("source_issue_id").notNull(), targetIssueId: ref("target_issue_id").notNull(), type: state("type", ["blocks", "relates_to"]).notNull() }).enableRLS();
export const issueEvents = spark.table("issue_events", {
  ...base(), tenantId: ref("tenant_id").notNull(), projectId: ref("project_id").notNull(), issueId: ref("issue_id").notNull(), actorUserId: ref("actor_user_id").notNull(), eventType: text("event_type").notNull(), fromVersion: integer("from_version").notNull(), toVersion: integer("to_version").notNull(), changes: jsonb("changes").notNull(),
}).enableRLS();
export const calendarEvents = spark.table("calendar_events", {
  ...tenant(), projectId: ref("project_id"), issueId: ref("issue_id"), organizerUserId: ref("organizer_user_id").notNull(), title: text("title").notNull(), description: text("description"), location: text("location"),
  startsAt: instant("starts_at").notNull(), endsAt: instant("ends_at").notNull(), timezone: text("timezone").notNull().default("UTC"), status: state("status", ["scheduled", "cancelled", "completed"]).notNull().default("scheduled"), version: version(),
}).enableRLS();
export const eventAttendees = spark.table("event_attendees", { ...tenant(), eventId: ref("event_id").notNull(), userId: ref("user_id").notNull(), response: state("response", ["pending", "accepted", "declined", "tentative"]).notNull().default("pending"), respondedAt: instant("responded_at") }).enableRLS();
export const eventReminders = spark.table("event_reminders", {
  ...tenant(), eventId: ref("event_id").notNull(), userId: ref("user_id").notNull(), eventVersion: integer("event_version").notNull(), minutesBefore: integer("minutes_before").notNull(), channel: state("channel", ["in_app", "email"]).notNull(), scheduledFor: instant("scheduled_for").notNull(), status: state("status", ["pending", "queued", "sent", "cancelled"]).notNull().default("pending"), sentAt: instant("sent_at"),
}).enableRLS();
export const subscriptionPlans = spark.table("subscription_plans", { ...mutable(), code: text("code").notNull(), name: text("name").notNull(), description: text("description"), billingKind: state("billing_kind", ["free", "paid"]).notNull(), isActive: boolean("is_active").notNull().default(true) }).enableRLS();
export const planPrices = spark.table("plan_prices", {
  ...mutable(), planId: ref("plan_id").notNull(), currency: text("currency").notNull(), amountMinor: amount("amount_minor").notNull(), billingInterval: state("billing_interval", ["month", "year"]).notNull(), intervalCount: integer("interval_count").notNull().default(1), provider: text("provider"), providerPriceId: text("provider_price_id"), isActive: boolean("is_active").notNull().default(true),
}).enableRLS();
export const planEntitlements = spark.table("plan_entitlements", { ...mutable(), planId: ref("plan_id").notNull(), featureKey: text("feature_key").notNull(), enabled: boolean("enabled").notNull().default(true), limitValue: amount("limit_value") }).enableRLS();
export const billingCustomers = spark.table("billing_customers", { ...tenant(), provider: text("provider").notNull(), providerCustomerId: text("provider_customer_id").notNull() }).enableRLS();
export const subscriptions = spark.table("subscriptions", {
  ...tenant(), billingCustomerId: ref("billing_customer_id"), planId: ref("plan_id").notNull(), billingKind: state("billing_kind", ["free", "paid"]).notNull(), priceId: ref("price_id"), provider: text("provider"), providerSubscriptionId: text("provider_subscription_id"),
  status: state("status", ["incomplete", "trialing", "active", "past_due", "paused", "cancelled", "expired"]).notNull().default("incomplete"), periodStart: instant("period_start"), periodEnd: instant("period_end"), trialEndsAt: instant("trial_ends_at"), cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false), cancelledAt: instant("cancelled_at"), version: version(),
}).enableRLS();
export const invoices = spark.table("invoices", {
  ...tenant(), subscriptionId: ref("subscription_id").notNull(), provider: text("provider").notNull(), providerInvoiceId: text("provider_invoice_id").notNull(), currency: text("currency").notNull(), subtotalMinor: amount("subtotal_minor").notNull(), discountMinor: amount("discount_minor").notNull().default(sql`0`), taxMinor: amount("tax_minor").notNull().default(sql`0`), totalMinor: amount("total_minor").notNull(),
  status: state("status", ["draft", "open", "paid", "void", "uncollectible"]).notNull(), issuedAt: instant("issued_at").notNull(), dueAt: instant("due_at"), paidAt: instant("paid_at"),
}).enableRLS();
export const paymentEvents = spark.table("payment_events", {
  ...mutable(), provider: text("provider").notNull(), providerEventId: text("provider_event_id").notNull(), tenantId: ref("tenant_id"), receivedAt: instant("received_at").notNull().defaultNow(), providerOccurredAt: instant("provider_occurred_at"), payload: jsonb("payload").notNull(), status: state("status", ["pending", "processed", "failed"]).notNull().default("pending"), attempts: integer("attempts").notNull().default(0), processedAt: instant("processed_at"), lastErrorCode: text("last_error_code"),
}).enableRLS();
export const promotions = spark.table("promotions", {
  ...mutable(), codeNormalized: text("code_normalized").notNull(), name: text("name").notNull(), discountType: state("discount_type", ["percent", "fixed"]).notNull(), percentBps: integer("percent_bps"), amountMinor: amount("amount_minor"), currency: text("currency"), startsAt: instant("starts_at").notNull(), endsAt: instant("ends_at").notNull(), maxRedemptions: amount("max_redemptions"), maxPerTenant: integer("max_per_tenant").notNull().default(1), durationCycles: integer("duration_cycles").notNull().default(1), isActive: boolean("is_active").notNull().default(true),
}).enableRLS();
export const promotionPrices = spark.table("promotion_prices", { ...mutable(), promotionId: ref("promotion_id").notNull(), priceId: ref("price_id").notNull() }).enableRLS();
export const promotionRedemptions = spark.table("promotion_redemptions", {
  ...tenant(), promotionId: ref("promotion_id").notNull(), subscriptionId: ref("subscription_id").notNull(), redeemedByUserId: ref("redeemed_by_user_id").notNull(), idempotencyKey: text("idempotency_key").notNull(), status: state("status", ["reserved", "applied", "released"]).notNull().default("reserved"), reservedUntil: instant("reserved_until").notNull(), appliedAt: instant("applied_at"), providerCheckoutId: text("provider_checkout_id"), termsSnapshot: jsonb("terms_snapshot").notNull(),
}).enableRLS();
export const outboxEvents = spark.table("outbox_events", {
  ...base(), tenantId: ref("tenant_id").notNull(), eventType: text("event_type").notNull(), aggregateType: text("aggregate_type").notNull(), aggregateId: ref("aggregate_id").notNull(), aggregateVersion: integer("aggregate_version").notNull(), payload: jsonb("payload").notNull(), availableAt: instant("available_at").notNull().defaultNow(), attempts: integer("attempts").notNull().default(0), lockedUntil: instant("locked_until"), lockToken: ref("lock_token"), processedAt: instant("processed_at"), lastErrorCode: text("last_error_code"),
}).enableRLS();
export const notifications = spark.table("notifications", {
  ...tenant(), recipientUserId: ref("recipient_user_id").notNull(), outboxEventId: ref("outbox_event_id").notNull(), kind: text("kind").notNull(), title: text("title").notNull(), body: text("body"), resourceType: text("resource_type").notNull(), resourceId: ref("resource_id").notNull(), readAt: instant("read_at"),
}).enableRLS();
export const notificationPreferences = spark.table("notification_preferences", { ...mutable(), userId: ref("user_id").notNull(), kind: text("kind").notNull(), channel: state("channel", ["in_app", "email"]).notNull(), enabled: boolean("enabled").notNull().default(true) }).enableRLS();
export const notificationDeliveries = spark.table("notification_deliveries", { ...tenant(), notificationId: ref("notification_id").notNull(), channel: state("channel", ["in_app", "email"]).notNull(), status: state("status", ["pending", "sent", "failed", "suppressed"]).notNull().default("pending"), attempts: integer("attempts").notNull().default(0), nextAttemptAt: instant("next_attempt_at"), providerMessageId: text("provider_message_id"), deliveredAt: instant("delivered_at") }).enableRLS();
export const auditEvents = spark.table("audit_events", { ...base(), tenantId: ref("tenant_id").notNull(), actorUserId: ref("actor_user_id"), actorKind: state("actor_kind", ["user", "system"]).notNull(), action: text("action").notNull(), resourceType: text("resource_type").notNull(), resourceId: ref("resource_id").notNull(), requestId: text("request_id"), metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`) }).enableRLS();
export const idempotencyRequests = spark.table("idempotency_requests", { ...tenant(), actorUserId: ref("actor_user_id").notNull(), operation: text("operation").notNull(), key: text("key").notNull(), requestHash: bytea("request_hash").notNull(), state: state("state", ["started", "completed"]).notNull().default("started"), resourceId: ref("resource_id"), responseStatus: integer("response_status"), expiresAt: instant("expires_at").notNull() }).enableRLS();
export const promotionPlacements = spark.table("promotion_placements", { ...mutable(), code: text("code").notNull(), name: text("name").notNull(), description: text("description").notNull(), isActive: boolean("is_active").notNull().default(true) }).enableRLS();
export const promotionPlans = spark.table("promotion_plans", { ...mutable(), code: text("code").notNull(), version: version(), name: text("name").notNull(), placementId: ref("placement_id").notNull(), durationDays: integer("duration_days").notNull(), currency: text("currency").notNull(), amountMinor: amount("amount_minor").notNull(), provider: text("provider").notNull(), providerPriceId: text("provider_price_id").notNull(), isActive: boolean("is_active").notNull().default(true) }).enableRLS();
export const promotionCampaigns = spark.table("promotion_campaigns", { ...tenant(), communityId: ref("community_id").notNull(), name: text("name").notNull(), headline: text("headline").notNull(), description: text("description").notNull(), placementId: ref("placement_id").notNull(), submittedByUserId: ref("submitted_by_user_id").notNull(), reviewStatus: state("review_status", ["draft", "pending", "approved", "rejected"]).notNull().default("draft"), deliveryStatus: state("delivery_status", ["unscheduled", "scheduled", "active", "paused", "completed", "cancelled"]).notNull().default("unscheduled"), requestedStartAt: instant("requested_start_at").notNull(), startsAt: instant("starts_at"), endsAt: instant("ends_at"), approvedVersion: integer("approved_version"), version: version(), cancellationRequestedAt: instant("cancellation_requested_at"), archivedAt: instant("archived_at") }).enableRLS();
export const promotionOrders = spark.table("promotion_orders", { ...tenant(), campaignId: ref("campaign_id").notNull(), promotionPlanId: ref("promotion_plan_id").notNull(), billingCustomerId: ref("billing_customer_id").notNull(), provider: text("provider").notNull(), providerCheckoutId: text("provider_checkout_id"), providerPaymentId: text("provider_payment_id"), idempotencyKey: text("idempotency_key").notNull(), currency: text("currency").notNull(), amountMinor: amount("amount_minor").notNull(), durationDays: integer("duration_days").notNull(), status: state("status", ["pending", "paid", "failed", "cancelled", "refund_pending", "refunded"]).notNull().default("pending"), paidAt: instant("paid_at"), termsSnapshot: jsonb("terms_snapshot").notNull() }).enableRLS();
export const promotionOrderInvoices = spark.table("promotion_order_invoices", { ...tenant(), orderId: ref("order_id").notNull(), provider: text("provider").notNull(), providerInvoiceId: text("provider_invoice_id").notNull(), currency: text("currency").notNull(), subtotalMinor: amount("subtotal_minor").notNull(), taxMinor: amount("tax_minor").notNull().default(sql`0`), totalMinor: amount("total_minor").notNull(), status: state("status", ["draft", "open", "paid", "void", "uncollectible"]).notNull(), issuedAt: instant("issued_at").notNull(), paidAt: instant("paid_at") }).enableRLS();
export const promotionReviews = spark.table("promotion_reviews", { ...base(), tenantId: ref("tenant_id").notNull(), campaignId: ref("campaign_id").notNull(), campaignVersion: integer("campaign_version").notNull(), reviewerUserId: ref("reviewer_user_id").notNull(), decision: state("decision", ["approve", "reject"]).notNull(), reason: text("reason").notNull() }).enableRLS();
export const promotionMetricsDaily = spark.table("promotion_metrics_daily", { ...tenant(), campaignId: ref("campaign_id").notNull(), metricDate: date("metric_date").notNull(), impressions: amount("impressions").notNull().default(sql`0`), clicks: amount("clicks").notNull().default(sql`0`) }).enableRLS();
export const platformRoleAssignments = spark.table("platform_role_assignments", { ...mutable(), userId: ref("user_id").notNull(), role: state("role", ["super_admin", "platform_admin", "community_moderator", "content_moderator", "campaign_moderator"]).notNull(), grantedByUserId: ref("granted_by_user_id").notNull(), revokedAt: instant("revoked_at") }).enableRLS();

