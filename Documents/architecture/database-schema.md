# Proposed product database schema

Status: the local schema foundation, Drizzle migrations (`0000_init.sql` to `0005_platform_roles.sql`), baseline constraints, FORCE RLS, read-only runtime grants, and authentication APIs (`/api/v1/auth/password/sign-in`, `/api/v1/me`, `/api/v1/auth/sign-out`) are implemented and verified. Write use cases for product domains, worker adapters, payment integration, and Supabase deployment are not implemented.

Based on [product context](../context.md), [REST and Clean Architecture](rest-clean-compliance.md), and [verification policy](../automation/testing.md). The current implementation remains local-only until its reviewed migrations and tests pass. Supabase role provisioning and deployment require a separate target-specific runbook.

## Scope and assumptions

Context defines community discovery, membership, posts, workspaces, tasks, notifications, and moderation (US-01 through US-07). The user additionally requests Google/other login providers, startup connections, Jira-like Kanban, schedule control, subscriptions, and promotions. These extensions do not silently change the existing MVP definition.

Proposed tenant boundary: one workspace is one tenant. It can own multiple communities and projects. Community membership grants social access only, not workspace/project access. A team groups workspace members and is not a separate tenant. A user may join many workspaces and communities.

Initial design choices: billing is per workspace; projects are visible to active workspace members; each project has one board; each issue has at most one assignee. Startup connections join workspaces without sharing private resources. The user confirmed both subscription discounts and paid startup advertising; the advertising model is specified in [promotion schema](promotion-schema.md). The remaining choices are explicit proposal assumptions for implementation planning.

## Notation and common constraints

- Fields are NOT NULL unless suffixed with `?`. IDs and references are UUIDs. `id` is the primary key unless another key is specified.
- Every table has `created_at timestamptz default now()`; mutable records also have `updated_at timestamptz`, maintained by the write path. Append-only events omit updated_at.
- Tenant tables include `tenant_id uuid -> workspaces.id` and `UNIQUE (tenant_id, id)` when they have an id. Workspace itself is the tenant root. Global and cross-tenant exceptions are explicit.
- Child FKs include tenant: `(tenant_id, parent_id)`. Project children also reference `(tenant_id, project_id, id)` candidate keys. Community children use the equivalent community-qualified keys. Declare every candidate key required by these FKs in migrations.
- Membership FKs retain historical authorship but do not prove active authorization. All mutations check current status and role.
- Use text with CHECK allowlists for states/roles, appropriate input length checks, timestamptz for instants, date for date-only fields, and IANA timezone names. Entity versions and issue_events.to_version are positive integers; issue_events.from_version is nonnegative to support creation at 0 -> 1. Money uses nonnegative bigint minor units plus currency, never float.
- JSONB is limited to structured event/audit diffs and provider snapshots; core relationships have FKs. Board ordering uses numeric(20,6) position with id as tie breaker.
- Default deletion is RESTRICT. Archive business records; retain inactive memberships. CASCADE only dependent join rows and expendable credentials/tokens. User PII redaction must preserve billing and moderation evidence. Retention periods need a separate operational policy.

## Identity and authentication (global, private)

| Table | Fields | Keys and constraints |
| --- | --- | --- |
| users | id, display_name text, avatar_url text?, locale text, timezone text, status text, last_login_at timestamptz?, deleted_at timestamptz? | Status active/suspended/deleted. Only explicit profile projections are public. |
| user_emails | id, user_id, email text, normalized_email text, verified_at timestamptz?, is_primary boolean | UNIQUE normalized_email; partial UNIQUE user_id WHERE is_primary. No provider-specific dot/plus rewriting. |
| password_credentials | user_id PK/FK, password_hash text, password_changed_at timestamptz | Zero or one per user. Argon2id encoded hash contains salt and work parameters. Benchmark work factors at implementation. |
| auth_identities | id, user_id, provider text, issuer text, provider_subject text, provider_email text?, provider_email_verified boolean, linked_at timestamptz, last_login_at timestamptz? | UNIQUE (provider, issuer, provider_subject); subject is opaque and case-sensitive. Supports Google/GitHub/Apple through provider adapters. |
| sessions | id, user_id, token_hash bytea, authenticated_identity_id?, auth_method text, last_seen_at timestamptz, expires_at timestamptz, revoked_at timestamptz?, rotated_from_id? | UNIQUE token_hash; hash a cryptographically random opaque token. Expiry after creation. Identity and predecessor FKs include user_id. |
| account_tokens | id, user_id, user_email_id?, purpose text, token_hash bytea, expires_at timestamptz, consumed_at timestamptz? | UNIQUE token_hash. Purpose verify_email/reset_password; verification requires email FK belonging to user. Atomic single-use consumption while unexpired. |
| platform_role_assignments | id, user_id, role text, granted_by_user_id?, revoked_at timestamptz? | Global platform staff roles: `super_admin`, `platform_admin`, `community_moderator`, `content_moderator`, `campaign_moderator`. Partial UNIQUE (user_id, role) WHERE revoked_at IS NULL. Separately provisioned from workspace memberships. |

A Google-only user has no password_credentials row. No plaintext, reversible password storage, dummy passwords, or password hashes in DTOs/logs/audit. Password setup/reset requires verified ownership and replaces credentials and revokes affected sessions transactionally. Secure-cookie opaque sessions rotate and can be revoked server-side.

Never auto-link accounts based only on matching provider email. Require reauthenticated explicit linking or verified recovery on collision. Validate issuer/audience/signature/expiry, OAuth state, nonce and PKCE where applicable. Reject unlinking the last usable login/recovery method. OAuth state/PKCE material belongs in expiring server storage. Login-only OAuth does not persist access/refresh tokens; later calendar integration uses a separate encrypted grants table with scopes, key reference, expiry and revocation.

A narrowly scoped authentication adapter accesses credential/session tables; ordinary product queries cannot enumerate them. Login/reset endpoints use existing Redis rate limits and non-enumerating errors. Platform staff roles (`super_admin`, `platform_admin`, `community_moderator`, `content_moderator`, `campaign_moderator`) are strictly for global Spark platform governance, completely decoupled from tenant-level workspace or community memberships.

## Workspaces, startup profiles, teams, connections

| Table | Fields | Keys and constraints |
| --- | --- | --- |
| workspaces | id, slug text, name text, status text, created_by_user_id, archived_at timestamptz? | UNIQUE slug; active/archived. Initial owner created in same transaction. |
| workspace_memberships | id, tenant_id, user_id, role text, status text, joined_at timestamptz, left_at timestamptz? | UNIQUE (tenant_id,user_id); roles owner/admin/member; active/suspended/left. |
| startup_profiles | tenant_id PK/FK, tagline text?, description text?, website_url text?, stage text, country_code text?, city text?, founded_on date?, connection_intent text?, is_discoverable boolean | Stage idea/validation/mvp/growth/established. Public projection requires explicit opt-in. |
| teams | id, tenant_id, name text, description text?, archived_at timestamptz? | UNIQUE (tenant_id,name). |
| team_memberships | tenant_id, team_id, user_id, role text | PK (tenant_id,team_id,user_id); team and workspace-member composite FKs; lead/member. |
| workspace_invitations | id, tenant_id, email_normalized text, role text, token_hash bytea, invited_by_user_id, expires_at timestamptz, status text, accepted_by_user_id?, accepted_at timestamptz?, revoked_at timestamptz? | UNIQUE token_hash; partial UNIQUE (tenant_id,email_normalized) WHERE pending. Pending/accepted/revoked/expired; invitation role admin/member. Acceptance fields iff accepted. |
| startup_connections | id, requester_tenant_id, recipient_tenant_id, requested_by_user_id, message text?, status text, responded_by_user_id?, responded_at timestamptz? | Cross-tenant bridge with no single tenant_id. FK endpoints to workspaces; requester actor to requester membership, responder to recipient membership. Distinct endpoints; UNIQUE canonical least/greatest endpoint pair. Pending/accepted/rejected/withdrawn/disconnected. |

Owner demotion/removal locks workspace and preserves at least one active owner. Invitation acceptance locks invitation, verifies authenticated user's verified recipient email and expiry, upserts membership and consumes token atomically. Expire old pending invitations before replacements; do not use now() in an index predicate. Invitations cannot transfer ownership.

Connection requests/decisions require active endpoint owners/admins. Recipient accepts/rejects; requester withdraws; either endpoint disconnects accepted connections. Reopening uses same canonical pair plus audit history. Connections grant no private access. Actor IDs alone never authorize actions. Recruiting positions/applications are deferred until a recruitment story exists.

## Communities, discovery, posts, moderation

| Table | Fields | Keys and constraints |
| --- | --- | --- |
| communities | id, tenant_id, slug text, name text, description text, visibility text, country_code text?, city text?, stage text?, created_by_user_id, archived_at timestamptz? | UNIQUE slug; public/private/hidden. |
| topics | id, slug text, name text | Global dictionary; UNIQUE slug. |
| community_topics | tenant_id, community_id, topic_id | PK (tenant_id,community_id,topic_id). |
| community_memberships | id, tenant_id, community_id, user_id, role text, status text, joined_at timestamptz, left_at timestamptz? | UNIQUE (tenant_id,community_id,user_id); owner/moderator/member; active/suspended/left. Does not require workspace membership. |
| community_join_requests | id, tenant_id, community_id, user_id, message text?, status text, reviewed_by_user_id?, reviewed_at timestamptz? | Pending/approved/rejected/withdrawn; partial UNIQUE (tenant_id,community_id,user_id) WHERE pending. |
| posts | id, tenant_id, community_id, author_user_id, title text, body text, visibility text, moderation_status text, version integer, deleted_at timestamptz? | Author FK to exact community membership; public/members/hidden visibility; visible/hidden moderation status. |
| post_comments | id, tenant_id, community_id, post_id, author_user_id, body text, moderation_status text, version integer, deleted_at timestamptz? | Community-qualified post and author-membership FKs. Flat comments for MVP. |
| content_reports | id, tenant_id, community_id, reporter_user_id, post_id?, comment_id?, reason_code text, details text?, status text, resolved_at timestamptz? | Exactly one target with community-qualified FK. Open/reviewing/resolved/dismissed; partial unique reporter/target while open/reviewing. |
| moderation_actions | id, tenant_id, community_id, report_id?, post_id?, comment_id?, actor_user_id, action text, reason text | Append-only; exactly one target; hide/restore/dismiss_report. If report provided, constraint trigger enforces same report target. |

Community creator receives community ownership atomically; last-owner removal locks community. Only community owner decides membership requests per US-02. Approval and member insertion/reactivation commit together. Community owners/moderators access their exact queue; workspace membership is not moderation permission.

Public posts require public nonarchived parent and visible nondeleted post. Private metadata discovery must use an explicitly approved projection; hidden communities never appear publicly. Public/private/hidden rules apply identically to lists and detail views. Authenticated users can report content they can access, without requiring membership. Reporter identity is available only to reporter and authorized moderators, never ordinary members. An admin managing workspace lifecycle does not automatically gain private community content access.

## Jira-like project and Kanban data

| Table | Fields | Keys and constraints |
| --- | --- | --- |
| projects | id, tenant_id, key text, name text, description text?, lead_user_id?, next_issue_number bigint, archived_at timestamptz? | UNIQUE (tenant_id,key); lead workspace-member FK; allocate positive issue numbers under project row lock. |
| boards | id, tenant_id, project_id, name text, version integer | UNIQUE (tenant_id,project_id): one board per project. |
| issue_statuses | id, tenant_id, project_id, name text, category text, position numeric(20,6), wip_limit integer? | UNIQUE (tenant_id,project_id,name); backlog/todo/in_progress/done; optional positive WIP limit. Status is board column. |
| workflow_transitions | id, tenant_id, project_id, from_status_id, to_status_id | Unique project/endpoints; distinct statuses within same project. |
| issues | id, tenant_id, project_id, number bigint, type text, parent_issue_id?, title text, description text?, status_id, priority text, reporter_user_id, assignee_user_id?, team_id?, sprint_id?, position numeric(20,6), story_points numeric(8,2)?, start_date date?, due_date date?, completed_at timestamptz?, version integer, archived_at timestamptz? | UNIQUE (tenant_id,project_id,number); epic/story/task/bug/subtask; lowest/low/medium/high/highest priority. Nonnegative points, due >= start. Status/parent/sprint same-project FKs; users/teams same-tenant FKs. |
| issue_labels | id, tenant_id, project_id, name text, color text | UNIQUE (tenant_id,project_id,name). |
| issue_label_links | tenant_id, project_id, issue_id, label_id | PK all fields; project-qualified FKs. |
| issue_comments | id, tenant_id, project_id, issue_id, author_user_id, body text, version integer, deleted_at timestamptz? | Issue project FK and author workspace-member FK. |
| issue_links | id, tenant_id, project_id, source_issue_id, target_issue_id, type text | Unique project/endpoints/type; no self-link; blocks/relates_to. Canonical pair for relates_to. |
| sprints | id, tenant_id, project_id, name text, goal text?, starts_at timestamptz?, ends_at timestamptz?, status text | Planned/active/completed/cancelled; end > start; active requires both. Partial UNIQUE project WHERE active. |
| issue_events | id, tenant_id, project_id, issue_id, actor_user_id, event_type text, from_version integer, to_version integer, changes jsonb | Append-only; UNIQUE (tenant_id,issue_id,to_version); to = from + 1, creation 0 -> 1. Allowlisted diffs. |

Hierarchy: epic has no parent; story/task/bug optionally belong to epic; subtask requires story/task/bug parent. Constraint triggers validate parent type, same project, and acyclicity including parent-type updates. No arbitrary-depth subtasks. Blocking links are not claimed to be a DAG or critical-path scheduler.

Issue changes validate current membership, assignee membership, transition and expected version; update issue, append history and insert outbox in one transaction. Stale versions reject rather than overwrite. Serialize WIP admission on board: every create/move/archive/unarchive/limit edit follows this protocol; count nonarchived issues and reject a limit below occupancy. Lock project before board consistently. Rebalance positions transactionally; completed_at follows status category. Sprint completion reassigns unfinished issues and records history atomically.

MVP uses projects, board/statuses, issues and events. Sprints, hierarchy, labels, configurable transitions and dependencies are incremental extensions. Custom fields, worklogs, uploads and rich realtime collaboration remain deferred.

## Schedule control

| Table | Fields | Keys and constraints |
| --- | --- | --- |
| calendar_events | id, tenant_id, project_id?, issue_id?, organizer_user_id, title text, description text?, location text?, starts_at timestamptz, ends_at timestamptz, timezone text, status text, version integer | End > start; scheduled/cancelled/completed. Issue requires project and project-qualified FK. Organizer workspace-member FK. |
| event_attendees | tenant_id, event_id, user_id, response text, responded_at timestamptz? | PK (tenant_id,event_id,user_id); workspace-member FK. Pending/accepted/declined/tentative. |
| event_reminders | id, tenant_id, event_id, user_id, event_version integer, minutes_before integer, channel text, scheduled_for timestamptz, status text, sent_at timestamptz? | FK to attendee triple; UNIQUE event/user/version/offset/channel within tenant. Nonnegative offset; in_app/email; pending/queued/sent/cancelled. |

Initially support timed, nonrecurring workspace-visible events. Organizer or owner/admin edits; attendee edits own response only. Update/cancel increments version and cancels pending old-version reminders transactionally. Due reminders create outbox events atomically; worker checks current event version/status and membership before delivery. External delivery can race later cancellation; no perfect cancellation guarantee.

Recurrence and all-day events are deferred: later model local DTSTART/timezone, RRULE, occurrence keys and exceptions; date-only exclusive-end ranges for all-day events. Never repeat local days by adding 24 hours to UTC. Availability, room booking conflict prevention and Google Calendar sync need separate stories.

## Subscription and discount promotions

Additional user-requested scope. No provider, prices or commercial plan names are specified by context.

| Table | Fields | Keys and constraints |
| --- | --- | --- |
| subscription_plans | id, code text, name text, description text?, is_active boolean | Global catalog; UNIQUE code; archive referenced plans. |
| plan_prices | id, plan_id, currency text, amount_minor bigint, billing_interval text, interval_count integer, provider text?, provider_price_id text?, is_active boolean | Global immutable price terms; month/year; positive interval count; paired provider fields; UNIQUE provider/external price when present. |
| plan_entitlements | plan_id, feature_key text, enabled boolean, limit_value bigint? | Global PK (plan_id,feature_key). NULL unlimited, zero zero; nonnegative. Server-owned feature allowlist. |
| billing_customers | id, tenant_id, provider text, provider_customer_id text | UNIQUE (tenant_id,provider); UNIQUE (provider,provider_customer_id). |
| subscriptions | id, tenant_id, billing_customer_id?, plan_id, price_id?, provider text?, provider_subscription_id text?, status text, period_start timestamptz?, period_end timestamptz?, trial_ends_at timestamptz?, cancel_at_period_end boolean, cancelled_at timestamptz?, version integer | Incomplete/trialing/active/past_due/paused/cancelled/expired. Partial UNIQUE tenant for all nonterminal states. Price belongs to plan; customer belongs to tenant. UNIQUE provider/external ID when present. Paired ordered periods. |
| invoices | id, tenant_id, subscription_id, provider text, provider_invoice_id text, currency text, subtotal_minor bigint, discount_minor bigint, tax_minor bigint, total_minor bigint, status text, issued_at timestamptz, due_at timestamptz?, paid_at timestamptz? | UNIQUE provider/external ID. Total = subtotal - discount + tax; discount <= subtotal. Draft/open/paid/void/uncollectible. Preserve finalized totals. |
| payment_events | id, provider text, provider_event_id text, tenant_id?, received_at timestamptz, provider_occurred_at timestamptz?, payload jsonb, status text, attempts integer, processed_at timestamptz?, last_error_code text? | Restricted webhook inbox, not ordinary tenant data. UNIQUE provider/event. Pending/processed/failed. Tenant nullable until server resolves provider references. |
| promotions | id, code_normalized text, name text, discount_type text, percent_bps integer?, amount_minor bigint?, currency text?, starts_at timestamptz, ends_at timestamptz, max_redemptions bigint?, max_per_tenant integer, duration_cycles integer, is_active boolean | Global private catalog; UNIQUE code. Percent requires 1..10000 basis points and no fixed fields; fixed requires positive amount/currency and no percent. End > start; positive caps/duration. |
| promotion_prices | promotion_id, price_id | Global PK both fields; explicit eligibility list; empty eligible nowhere. Fixed discount currency must match price. |
| promotion_redemptions | id, tenant_id, promotion_id, subscription_id, redeemed_by_user_id, idempotency_key text, status text, reserved_until timestamptz, applied_at timestamptz?, provider_checkout_id text?, terms_snapshot jsonb | UNIQUE (tenant_id,idempotency_key); reserved/applied/released; tenant subscription FK; immutable approved terms snapshot. |

Paid subscriptions require customer, price and provider IDs with matching providers, enforced with composite FKs/constraints. Internal free subscriptions omit them and reference the server-managed free plan. Price terms are immutable; changed terms create a new price. Entitlement edits affect existing subscribers; version plans before offering grandfathering. Invoices retain their own currency/totals; do not store card details. Refunds, credit notes and tax computation are separate requirements before offering those operations.

Checkout reserves discounts under promotion and subscription locks in deterministic order. Count applied and unexpired reserved rows against global/per-tenant caps; validate eligibility, currency, period and one live promotion per subscription. Transition expired reservations to released under the same protocol. Snapshot approved terms, then call provider outside transaction with stable idempotency key. Late completion after reservation expiry requires reconciliation; never exceed caps silently. Provider state and usage records must reconcile before retrying a failed checkout.

No paid access from browser redirects or client-supplied plan/status. Verify webhook signatures, resolve tenant using stored provider IDs, deduplicate and update subscription transactionally. Serialize updates and retrieve authoritative provider state for out-of-order events. Restricted billing workers own inbox access. Owner/admin accesses billing; server enforces entitlements. Define grace/past-due/paused/incomplete access policy before implementation.

Quota admission locks workspace and checks committed counts on every relevant create/invite-accept operation. Active workspace members consume seats; community-only members do not. Cached usage is not authoritative. Storage quota waits for uploads. Promotion catalogs and webhook bodies are not public read tables; payload retention and redaction are required.

Paid startup discovery is also requested: [promotion schema](promotion-schema.md) specifies plans, placements, campaigns, orders, invoices, reviews and aggregate metrics. Its first version uses fixed-duration, nonexclusive placements; subscription discount tables remain separate.

## Notifications, outbox and audit

| Table | Fields | Keys and constraints |
| --- | --- | --- |
| outbox_events | id, tenant_id, event_type text, aggregate_type text, aggregate_id uuid, aggregate_version integer, payload jsonb, available_at timestamptz, attempts integer, locked_until timestamptz?, lock_token uuid?, processed_at timestamptz?, last_error_code text? | UNIQUE tenant/aggregate type/ID/version/event type. Insert with business transaction. Internal aggregate reference, not an authorization grant. |
| notifications | id, tenant_id, recipient_user_id, outbox_event_id, kind text, title text, body text?, resource_type text, resource_id uuid, read_at timestamptz? | UNIQUE tenant/event/recipient/kind; event tenant FK. Recipient user FK, not workspace membership: community members and invitees may lack it. |
| notification_preferences | user_id, kind text, channel text, enabled boolean | Global user-private PK user/kind/channel; in_app/email; own-user access. Server kind allowlist. |
| notification_deliveries | id, tenant_id, notification_id, channel text, status text, attempts integer, next_attempt_at timestamptz?, provider_message_id text?, delivered_at timestamptz? | UNIQUE tenant/notification/channel; tenant FK. Pending/sent/failed/suppressed; stable delivery ID for provider deduplication. |
| audit_events | id, tenant_id, actor_user_id?, actor_kind text, action text, resource_type text, resource_id uuid, request_id text?, metadata jsonb | Append-only; user/system actor, user requires actor ID. Restricted allowlisted metadata; moderation history separately scoped. |
| idempotency_requests | id, tenant_id, actor_user_id, operation text, key text, request_hash bytea, state text, resource_id uuid?, response_status integer?, expires_at timestamptz | UNIQUE tenant/actor/operation/key. Started/completed. Same key with different hash returns 409. Reauthorize retries; avoid sensitive response snapshots. |

Workers claim bounded batches using SKIP LOCKED with expiring lease and conditional acknowledgement by lock token. Stale workers cannot acknowledge newer claims. Bounded retries expose exhaustion operationally. Notification fan-out and outbox acknowledgement commit together. External email delivery is at-least-once with provider deduplication where supported, not exactly-once.

Each notification read/delivery, including unread counts, checks recipient and current target authorization. Minimal generic text prevents revoked members from reading cached post/report details. Invitation notifications authorize intended recipient against invitation state, not workspace membership. Email jobs containing invitation tokens use restricted encrypted payloads and short retention. Account recovery email belongs to the authentication subsystem, not a fabricated tenant. Mandatory security notices cannot be disabled.

## Authorization and RLS implementation contract

Enable and force RLS when introducing tenant/user-private tables. Ordinary runtime role is not table owner, superuser or BYPASSRLS. Separate migration owner and narrow authentication/billing/worker adapters. Do not grant product runtime broad worker privileges.

Backend derives actor from active opaque session and sets transaction-local user/tenant context on the same connection/transaction as queries. Missing context denies access; never trust actor/tenant headers as authorization. Custom settings assume trusted backend SQL and are not protection against arbitrary runtime SQL execution.

Policies use both USING and WITH CHECK with operation-specific permissions:

- Workspace resources require active workspace membership and selected tenant; administrative/billing writes require owner/admin.
- Community resources require exact-community membership or explicit public visibility path; workspace membership alone is insufficient.
- Public discovery exposes only public nonarchived community fields and opted-in startup projection. An invoker-RLS view or narrowly reviewed projection function must not bypass visibility through owner privileges.
- Membership roles cannot be self-escalated. Workspace bootstrap uses a narrowly scoped transaction that cannot create ownership in an existing tenant.
- Reports require own-reporter or exact-community moderation authorization; general members cannot read identities.
- Notifications require recipient plus current target access; preferences are own-user only.
- Credential/token/session lookup is limited to authentication adapter; account settings use narrow self-service projections.
- Cross-tenant connections authorize endpoint and action explicitly. They never imply content access.
- Public plan/price projection excludes promotion secrets; catalog writes and webhook ingestion use restricted roles.

Avoid recursive membership policies. Any SECURITY DEFINER helper needs private schema, fixed search_path, qualified names, explicit actor validation, minimal privileges and restricted EXECUTE grants. Do not copy Supabase auth.uid() into this Fastify opaque-session application. Test context reset after commit, rollback, error and cancellation with reused pooled connections.

## Indexes, transactions and delivery

Add indexes supporting FK leading columns, excluding duplicates already covered by PK/UNIQUE. Important access indexes:

| Access | Index |
| --- | --- |
| User workspaces/communities | workspace_memberships (user_id,status,tenant_id); community_memberships (user_id,status,tenant_id,community_id) |
| Discovery | communities (created_at,id) WHERE public and not archived; GIN search vector on name/description with explicitly selected language configuration |
| Topic filter | community_topics (topic_id,tenant_id,community_id) |
| Feeds | posts (tenant_id,community_id,created_at,id); post_comments (tenant_id,community_id,post_id,created_at,id) |
| Moderation | content_reports (tenant_id,community_id,status,created_at,id) |
| Board | issues (tenant_id,project_id,status_id,position,id) WHERE not archived |
| Assigned deadlines | issues (tenant_id,assignee_user_id,due_date,id) WHERE not archived |
| Issue history | issue_events (tenant_id,issue_id,created_at,id) |
| Calendar/reminders | calendar_events (tenant_id,starts_at,id); event_reminders (scheduled_for,id) WHERE pending |
| Unread inbox | notifications (recipient_user_id,tenant_id,created_at,id) WHERE unread |
| Outbox | outbox_events (available_at,id) WHERE unprocessed |
| Auth cleanup/revocation | sessions (user_id,revoked_at), sessions (expires_at), account_tokens (expires_at) |
| Connections | startup_connections (recipient_tenant_id,status,created_at,id), matching requester index |
| Promotion caps | promotion_redemptions (promotion_id,status,reserved_until,tenant_id) |

Index predicates above are descriptive, not executable SQL. No time-dependent now() partial predicate. All FK indexes/candidate keys need a complete manifest in the actual migration. Deterministic pagination includes ID even when sorting by relevance. Start with PostgreSQL search; no new search infrastructure.

Atomic units: workspace+owner; invitation+membership+outbox; join decision+membership; issue+version+history+outbox; event+replacement reminders; fan-out+outbox acknowledgement; subscription+webhook completion; promotion reservation+cap validation. Document deterministic cross-module lock order. External calls occur after commit/outside SQL transactions.

Delivery order:

1. Users/credentials/identities/sessions and workspace isolation. Add Drizzle with the first actual schema/migration under Spark_Core/backend; current package has pg but no migration script.
2. Communities, discovery, membership, posts/comments, invitations, moderation and initial task management.
3. Outbox with first reliable external effect; notification storage with US-06.
4. Jira extensions, startup connections, schedule and billing/discounts as separate slices. Paid advertising follows the companion promotion design; recurrence, uploads and advanced collaboration remain deferred.

Required implementation checks: empty and upgrade migrations; cross-tenant/wrong-project FK rejection; runtime-role RLS for two tenants and pooled connection reuse; hidden/private list-detail parity; owner removal/invitation/join/issue/WIP/promotion/quota concurrency; password reset and session revocation; OAuth collision linking; webhook duplicates/reordering; worker lease expiry/retries; notification visibility after membership removal; archive/redaction and transaction rollback. Document migration recovery.

These runtime checks have not run for this design-only change. Independent review supports the proposal but cannot prove implemented isolation, authentication, billing correctness or production readiness.

Authentication implementation also requires CSRF protection for cookie-authenticated mutations (validated origin plus CSRF tokens as applicable), immediate denial for suspended/deleted accounts and server-side session revocation. Login, recovery, and verification rate limiting fail closed during Redis unavailability with a safe service-unavailable response; health remains unaffected. These policies need integration tests before auth is enabled.
