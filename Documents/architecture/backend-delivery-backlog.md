# Backend delivery backlog

## Current state

The database entity model is defined in `Spark_Core/backend/src/infrastructure/database/schema.ts` and managed via Drizzle ORM migrations (`0000_product_tables.sql` through `0029_scheduled_emails.sql`). It mirrors the `spark` schema and exposes `DatabaseRow<TTable>` and `DatabaseInsert<TTable>` for infrastructure adapters.

The backend currently exposes process health (`GET /health`), clean REST authentication (`POST /api/v1/auth/password/sign-in`, `GET /api/v1/me`, `POST /api/v1/auth/sign-out`), session lookup with Argon2id password verification, SHA-256 bytea session tokens, and the platform governance API under `/api/v1/admin` (reports, communities, users and roles, campaigns, audit log) for the platform roles `super_admin`, `platform_admin`, `community_moderator`, `content_moderator` and `campaign_moderator`. The Phase 1 workspace core (below) adds workspaces, projects, tasks, planning, insights, the schedule, notifications and email on top of that baseline. Communities, billing and promotions are still in the delivery backlog below.

## Phase 1 workspace core status

| Milestone | Scope | Migrations | Status |
| --- | --- | --- | --- |
| M1 | Workspace access, create, invite, accept; email worker | `0014`-`0016` | Implemented |
| M2 | Projects and methodology catalog | `0017`-`0018` | Implemented |
| M3 | Tasks: create, assign, move; task-assigned email | `0019`-`0021` | Implemented |
| M4 | Sprints, phases, milestones, board columns, methodology switch | `0023`-`0025` | Implemented |
| M5 | Insights (computed on read) | `0026` | Implemented |
| M6 | Schedule: events, attendees, derived deadlines | `0027` | Implemented |
| M7 | Notification inbox, read state, email preferences, daily due reminder, Monday digest | `0028`-`0029` | Implemented |

Phase 1 is complete (US-E1 to US-E15 and US-F1 to US-F5 are Implemented). Platform admin dashboards (`0022`) are separate. Remaining in later phases: communities, membership and posts (Phase 2); password reset, email verification and OAuth (Phase 3); billing and promotions.

Known limits carried out of Phase 1: recipients of task-assigned, reminder and digest email are the unverified primary email addresses until Phase 3; scheduled and outbox delivery is at least once; each scheduled job sends five emails a minute (about 300 an hour) per worker pass; `scheduled_emails` has no retention job yet; notification delivery to the inbox is by polling, not push.

## Delivery rules

- Use `/api/v1`, plural lowercase resources, JSON Schema validation, documented OpenAPI responses, and `application/problem+json` errors.
- Keep domain rules in domain/application code. Drizzle queries, Redis, email, and payment providers stay in infrastructure adapters.
- A write use case owns its transaction. It writes its audit record and required outbox event in that transaction.
- Runtime database access sets the authenticated user and tenant context for every transaction before reading tenant data. RLS remains a defense in depth layer; application authorization is still mandatory.
- Use an actor-scoped `Idempotency-Key` for retry-sensitive POST operations. Use a version field with `If-Match` for concurrent edits.
- Default authenticated responses to `Cache-Control: private, no-store`. Cache only public read projections with a bounded TTL, explicit key scope, and invalidation after commit.
- Add a route-specific Redis rate-limit policy only when its route exists. Do not add a global cache or speculative worker framework.

## 1. Runtime foundation

1. [Implemented] PostgreSQL Drizzle client, connection pool, and migrations (0000–0029).
2. [Implemented] Request authentication context and session resolution with platform role query.
3. [Implemented for admin collections] Reusable keyset cursor codec (`src/routes/pagination.ts`); invalid cursors return `400 invalid_cursor` and page limits are clamped to 1–100. Reuse it for public collections.
4. Add an idempotency store adapter over `idempotency_requests` for mutation flows that can be retried.
5. [Implemented] Outbox dispatcher with leasing, bounded retries, and idempotent delivery handlers in the `spark_worker` process (`src/worker.ts`, invitation and task-assigned email, plus the scheduled reminder and digest jobs over the `scheduled_emails` ledger). It runs only on committed rows.
6. Add structured audit-event writing for privileged and state-changing actions.

Security and operations: rotate opaque session tokens, hash every bearer token before storage, reject suspended/deleted users, redact credentials and cookies, use a trusted-proxy allowlist, and preserve request IDs in errors and audit events. Keep the existing health endpoint process-only; add readiness only if the deployment platform needs it.

## 2. Authentication and accounts

Resources and commands:

- `POST /api/v1/auth/password/sign-in` (Implemented — Argon2id verification, SHA-256 bytea session creation, cookie emission)
- `GET /api/v1/me` (Implemented — session token authentication, user profile, platform roles resolution)
- `POST /api/v1/auth/sign-out` (Implemented — session revocation, cookie clearing)
- `POST /api/v1/auth/password/sign-up` (Implemented)
- `POST /api/v1/auth/oauth/{provider}/start` and callback handling (Backlog)
- `POST /api/v1/auth/sessions/{sessionId}/revoke` (Backlog)
- `POST /api/v1/auth/password-reset-requests` and reset completion (Backlog)
- `PATCH /api/v1/me` (Backlog)

Implement password hashing with Argon2id, verified email ownership, OAuth subject-to-user linking, session rotation and revocation, CSRF protection for cookie-authenticated mutations, strict redirect URI allowlists, and per-IP plus per-account throttling for sign-in/reset attempts. Never expose whether an email exists. Do not cache account responses.

## 3. Workspaces, teams, and startup discovery

Resources and commands:

- `POST/GET/PATCH /api/v1/workspaces` and `GET /api/v1/workspaces/{workspaceId}`
- `POST /api/v1/workspaces/{workspaceId}/invitations`; accept, revoke, and expire invitation subresources
- `GET/PATCH /api/v1/workspaces/{workspaceId}/members/{userId}`
- `GET/POST/PATCH /api/v1/workspaces/{workspaceId}/teams`
- `GET/PATCH /api/v1/workspaces/{workspaceId}/startup-profile`
- `GET /api/v1/startups` for public, discoverable startup projections
- `POST /api/v1/startup-connections` with accept, reject, withdraw, and disconnect subresources

Workspace creation and initial owner membership must commit together. Invitation acceptance must lock and consume one valid token exactly once, verify the intended email, then create membership in the same transaction. Public startup discovery needs a narrow projection, cursor pagination, and an optional Redis cache keyed by normalized filters and cursor. Invalidate it after profile visibility changes. Rate-limit invitations, connection requests, and discovery search separately.

## 4. Communities, membership, posts, and moderation

Resources and commands:

- `GET /api/v1/communities` and `GET /api/v1/communities/{communityId}`
- `POST/PATCH /api/v1/communities`
- `POST /api/v1/communities/{communityId}/join-requests`; approve, reject, or withdraw subresources
- `GET/POST /api/v1/communities/{communityId}/posts`
- `GET/PATCH/DELETE /api/v1/posts/{postId}` and nested comments
- `POST /api/v1/content-reports` and moderator-only report/action resources

Enforce visibility at list and individual-resource boundaries. Joining must be idempotent and constrained by the pending request unique index. Post changes use `If-Match` against `version`. Reporters are never exposed to ordinary members. Cache only public community and post projections, keyed by visibility and cursor; purge after edits, moderation, or membership-affecting visibility changes. Apply tighter limits to post creation, comments, and reports.

## 5. Projects, Kanban, and schedules

Resources and commands:

- `POST/GET/PATCH /api/v1/workspaces/{workspaceId}/projects`
- boards, statuses, workflow transitions, sprints, issue labels, issue links, and issue comments as nested resources
- `POST/GET/PATCH /api/v1/projects/{projectId}/issues`
- `GET /api/v1/workspaces/{workspaceId}/calendar`, `POST /api/v1/workspaces/{workspaceId}/calendar-events`, `GET`/`PATCH /api/v1/calendar-events/{eventId}`, `POST /api/v1/calendar-events/{eventId}/cancel` and `PUT /api/v1/calendar-events/{eventId}/attendees/me` (Implemented, M6); per-event reminder subresources are not built (the due-task reminder email of section 6 is separate)

An issue create or update transaction must atomically update `issues`, insert `issue_events`, and insert the matching `outbox_events` record. Require `If-Match` for changes to existing issues, boards, and events. Validate workflow transitions, WIP limits, ordering positions, parent issue constraints, and time intervals in the use case before database constraints defend them. Do not cache private boards or calendars. Rate-limit bulk movement and event/reminder creation.

## 6. Notifications

Resources and commands:

- `GET /api/v1/notifications?unread&cursor&limit` (Implemented, M7)
- `GET /api/v1/notifications/unread-count` (Implemented, M7)
- `PATCH /api/v1/notifications/{notificationId}` with `{"read": true}` for read state (Implemented, M7, `204`, idempotent)
- `PATCH /api/v1/notifications` with `{"read": true, "before"}` to mark all read up to an instant (Implemented, M7)
- `GET/PUT /api/v1/me/notification-preferences` (Implemented, M7; the whole document is replaced, so `PUT` rather than `PATCH`)
- Worker jobs `due_reminders` and `weekly_digest` (Implemented, M7, migration `0029`)

Still backlog: an in-app channel preference, a retention job for `scheduled_emails` and delivered notifications, provider idempotency keys for email, and real-time push.

The outbox dispatcher creates notifications and delivery records only after the originating transaction commits. Delivery workers lease rows with a deadline, bound retries, and provider idempotency keys. A polling endpoint is sufficient initially; real-time delivery requires a separate authorization check for every connection and event. Notification lists are private and never cached. Rate-limit notification mutation routes lightly; delivery limits belong in the provider adapter.

## 7. Subscription plans, promotions, and paid promotion

Resources and commands:

- public plan and promotion-code validation projections
- workspace subscription checkout and cancellation commands
- payment-provider webhook endpoint
- promotion campaign create, submit, review, schedule, cancel, and metrics resources

Treat payment provider events as untrusted input: verify the provider signature before parsing or storing, deduplicate by provider event ID, record raw event metadata safely, and process it asynchronously through the transaction/outbox boundary. Use idempotency keys for checkout, promotion redemption, and order creation. Never trust a frontend price, plan, discount, or campaign status; load the server-side plan and enforce current approval, payment, and lifecycle constraints. Public plans may be cached briefly. Checkout, invoices, subscriptions, and campaign management are private and never cached. Apply strict webhook, redemption, checkout, and campaign-submission limits.

## 8. Verification and rollout per resource

For every implemented resource, add tests for the successful path, schema validation, unauthenticated and unauthorized access, cross-tenant access under a reused pooled connection, its documented conflict/idempotency/concurrency behavior, and response/OpenAPI agreement. Run migrations and integration tests with the runtime role. Test cache invalidation and rate-limit responses only for routes that use them.

Before a remote deployment, configure secrets, cookie/domain settings, trusted proxies, HTTPS, database roles/grants/RLS, Redis failure policy, migration execution, worker lifecycle, observability, and a restore plan in the target environment. Local tests do not prove these protections remotely.