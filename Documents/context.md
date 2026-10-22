# Spark product and architecture context

## Product goal

Spark helps startup communities discover each other, manage membership, collaborate, and moderate content. The first release must be a small, production-ready MVP: clear boundaries, reliable data, secure defaults, and enough automation to ship safely. Architecture exists to support product behavior; it must not add infrastructure before a real use case needs it.

All repository content must be English. This includes source code, identifiers, UI copy, documentation, comments, tests, fixtures, logs, errors, commit messages, pull-request text, generated artifacts, and new files.

## Current scope

Application code lives in `Spark_Core` as a pnpm workspace:

- `frontend`: Next.js 16, React 19, and TypeScript with UI/UX Pro Max design system (clean light SaaS theme, responsive navigation, production-ready login with OAuth suite, interactive Platform Governance Console at `/admin`, and landing page showcases).
- `backend`: Fastify and TypeScript, organized as a pragmatic Clean Architecture modular monolith. One build runs as three processes: the public API, a private auth process that alone holds the login database role, and a background worker that alone holds the `spark_worker` role and delivers outbox email over SMTP (credential security boundaries, not separate codebases). The worker role has no table privileges; it only executes the `spark.worker_*` functions.
- `infra`: local Redis and Mailpit (SMTP catcher on `127.0.0.1:1025`, inbox at `http://localhost:8025`) through Docker Compose, and local PostgreSQL on port 5432.

### Admin dashboards

Overview, Analytics, Reports and Communities in the staff console are dashboards (design: `Documents/product/2026-10-20-admin-dashboard-redesign-design.md`). Each page has its header, a row of trend cards (value, change chip, sparkline only where real history exists) and a 12-column bento grid of chart tiles above its existing working area. Every figure comes from an API read under `/api/v1/admin`; a tile or card is rendered only when the viewer's role can open the read behind it, and each tile loads, fails and retries on its own. Charts offer "View as table", and all entrance and hover motion is off under `prefers-reduced-motion`.

- **Overview** (`/admin`, 7/30/90/180-day picker): trend cards for average daily users, sign-ups, posts and comments (`/analytics/activity`) and MRR (`/billing/mrr`); tiles for platform activity and content created (`/analytics/activity`), needs attention (open reports, flagged communities and pending campaigns from `/overview`), moderation flow (`/reports/stats`), audience stickiness DAU/MAU (`/analytics/activity`), recent staff activity (`/audit-logs`), API health (`/system`) and revenue snapshot (`/billing/overview`). Moderators without analytics access get queue cards from `/overview` and `/reports/stats` instead.
- **Analytics** (`/admin/analytics`): the System health view reads `/system/health` (requests, error rate and p95 cards from in-memory per-minute buckets that reset on API restart; active sessions without a sparkline; status banner, service checks, API traffic, response time, slowest endpoints, endpoints with errors, database and API process gauges). The Engagement view reads `/analytics/activity`, `/analytics/engagement` (weekday-by-hour heatmap), `/analytics/retention` (weekly cohorts) and `/analytics/top-communities` (ranked by activity or new members).
- **Reports** (`/admin/reports`): `/reports/stats` over 30 days feeds the open-now, opened, closed and median time-to-decision cards, the backlog gauge (target 10, full at twice the target), reports by reason across all open reports, opened against closed per day and the five most reported communities. The triage queue and detail pane below are unchanged.
- **Communities** (`/admin/communities`, 7/30/90-day picker): `/communities/stats` feeds the live communities and new members cards, the health mix donut over all communities (same rules as the table badges) and the flagged share gauge; posts and comments (`/analytics/activity`), open reports (`/reports/stats`), most active communities (`/analytics/top-communities`) and the activity heatmap (`/analytics/engagement`) appear only for roles that can open those reads. The communities table below is unchanged.

The implemented backend baseline provides process health (`GET /health`), clean REST authentication (`POST /api/v1/auth/password/sign-up`, `POST /api/v1/auth/password/sign-in`, `GET /api/v1/me`, `POST /api/v1/auth/sign-out`), workspaces (`POST`/`GET /api/v1/workspaces`, `GET`/`PATCH /api/v1/workspaces/{workspaceId}`, `GET /api/v1/workspaces/by-slug/{slug}`), members (`GET /api/v1/workspaces/{workspaceId}/members`, `PATCH`/`DELETE /api/v1/workspaces/{workspaceId}/members/{userId}`), invitations (`POST`/`GET /api/v1/workspaces/{workspaceId}/invitations`, `POST .../invitations/{invitationId}/resend`, `DELETE .../invitations/{invitationId}`, `POST /api/v1/invitations/preview`, `POST /api/v1/invitations/accept`), a public methodology catalog (`GET /api/v1/methodologies`: Scrum, Kanban, Waterfall), projects (`POST`/`GET /api/v1/workspaces/{workspaceId}/projects`, `GET /api/v1/workspaces/{workspaceId}/projects/by-key/{key}`, `GET`/`PATCH /api/v1/projects/{projectId}` with `If-Match`), issues (`GET /api/v1/projects/{projectId}/board` with at most 500 cards and `truncated`, `GET /api/v1/projects/{projectId}/issues` with status, assignee, title search and archived filters and cursor pages, `POST /api/v1/projects/{projectId}/issues` with an optional `Idempotency-Key`, `GET`/`PATCH /api/v1/issues/{issueId}` with `If-Match` for edits, moves, ranking, assignment and archiving under status WIP limits, `GET /api/v1/issues/{issueId}/events` for history), a background worker (`src/worker.ts`, database role `spark_worker`) that delivers outbox invitation emails and task-assigned emails (one per `issue_assigned` notification, never for a self-assignment, honouring the recipient's `task_assigned` email preference) over SMTP (Mailpit locally), Argon2id password hashing, SHA-256 bytea session tokens, Drizzle ORM migrations (`0000_product_tables` to `0022_admin_dashboard_insights`), multi-role platform governance (`super_admin`, `platform_admin`, `community_moderator`, `content_moderator`, `campaign_moderator`) with the staff API under `/api/v1/admin/*` (overview, system health, users, communities, reports, campaigns, audit logs, analytics and billing reads, plus the dashboard reads `GET /api/v1/admin/communities/stats` for community health counts and daily growth and `GET /api/v1/admin/reports/stats` with open reports by reason and community and a daily backlog series), startup configuration checks, Redis-backed rate limiting, OpenAPI docs, and integration tests. A GitHub Actions quality gate (`.github/workflows/ci.yml`) runs audit, lint, type checks, tests, and build; remote branch protection is not verified. Product domain features (workspaces, communities, Kanban, notifications, billing) are implemented iteratively as scheduled. Documentation must never describe an unverified capability as operational.

## Technology choices

| Area | Choice | Reason |
| --- | --- | --- |
| Frontend | Next.js, React, TypeScript | Server rendering, routing, and accessible light-theme design tokens. |
| Backend | Fastify, TypeScript | Small runtime, schema-first HTTP APIs, Clean Architecture, and good performance. |
| Database | PostgreSQL through `pg` & Drizzle ORM | ACID transactions, strict schema constraints, Drizzle migrations (`0000`–`0021`), and RLS. |
| Security & Auth | Argon2id, SHA-256 bytea sessions | Robust password hashing, opaque session token management, and platform role RBAC. |
| Cache and limiter | Redis | Shared cache, distributed rate limits, and short-lived coordination. |
| Contracts | Fastify JSON Schema and OpenAPI | Runtime validation and generated API documentation without a premature shared package. |
| Tests | Vitest and focused integration tests | Fast feedback with real dependency coverage where it matters. |
| CI | GitHub Actions | `.github/workflows/ci.yml` runs the quality gate; remote protections are unverified. |

Use Node.js 26 and the pnpm version pinned by the repository. Prefer a modular monolith until measured scale or team ownership justifies another deployable service. Do not add Kafka, Kubernetes, Elasticsearch, a service mesh, or a graph database for the MVP.

## Architectural rules

The backend follows pragmatic Clean Architecture:

1. Domain code contains business rules and imports no framework or adapter.
2. Application use cases coordinate domain behavior through small ports.
3. Infrastructure implements database, cache, and external-service ports.
4. Presentation validates HTTP input and maps use-case results to HTTP responses.
5. The composition root wires concrete dependencies.

Use these layers when a feature has business behavior or an external dependency. A trivial endpoint does not need empty interfaces, factories, or directories solely to demonstrate a pattern. Full REST and dependency rules are defined in [REST and Clean Architecture compliance](architecture/rest-clean-compliance.md).

## Data and consistency

PostgreSQL is the source of truth. Every schema change uses a reviewed migration. Enforce invariants with constraints and transactions as well as application checks. Keep transactions short and use deterministic lock ordering. Multi-step writes that must commit together share one transaction. External side effects after commit use an outbox only when such a side effect exists.

Tenant-scoped tables include `tenant_id`; ownership relationships use composite constraints where appropriate. Runtime roles have least privilege. RLS is required when tenant data is introduced, with tests covering two tenants and reused pooled connections. Never claim ACID or tenant isolation from unit tests alone.

## Cache and rate limiting

Cache only measured read paths. Every cache entry needs an owner, scope, TTL, invalidation event, and fallback behavior. Cache keys include tenant and visibility scope. Invalidate after the database commit. Sensitive user responses default to `private, no-store`.

Redis backs rate limits for normal API traffic. Policies are route-specific and return `429` with `Retry-After`. Health endpoints are not rate limited. The service must remain correct during Redis failure; the documented route policy decides whether to fail open or closed.

## Security baseline

- Opaque sessions, secure cookies, session rotation, and server-side revocation when authentication is implemented.
- Per-resource authorization in application use cases and tenant filtering in database access.
- Strict request and response schemas, body-size limits, safe error responses, and no secrets or private payloads in logs.
- Explicit trusted proxies and HTTPS-only production origins.
- Parameterized queries, least-privilege database roles, dependency auditing, and pinned CI dependencies when CI is configured.
- Load balancers terminate TLS and forward only trusted proxy headers. Application nodes remain stateless.

## MVP user stories

### US-01: Discover startup communities

A visitor searches public communities by keyword and optional topic, location, or stage. Results use deterministic cursor pagination and show an empty state when no match exists. The API validates filters, limits page size, and may cache only public results. Search begins with indexed PostgreSQL queries; a separate search engine requires evidence that PostgreSQL is insufficient.

### US-02: Request membership

An authenticated user requests access to a private community. Duplicate retries do not create duplicate requests. A community owner can approve or reject a pending request. Authorization, uniqueness, and state transitions are enforced transactionally.

### US-03: Publish and discuss posts

A member creates a post and comments within an authorized community. Public, private, and hidden visibility rules apply consistently to lists and individual resources. Mutations use idempotency where network retries can duplicate work.

### US-04: Create a workspace and invite members

An owner creates a workspace and sends expiring, single-use invitations. Acceptance verifies the intended recipient and tenant. Workspace creation and initial ownership commit atomically.

### US-05: Manage tasks

Members create, assign, and move tasks. Concurrent updates use a version or conditional request so one update cannot silently overwrite another. Keyboard and mobile interactions remain usable. Implemented (M3): the project board at `/w/[slug]/p/[key]` (quick-add with an `Idempotency-Key`, drag and drop, keyboard moves, a "Move to…" menu, WIP limits refused with `409 wip_limit_reached`), a task drawer for editing, assigning and archiving with `If-Match` (a stale save gets `412` with the current task), the task history, and `?issue=<KEY>-<n>` deep links used by the assignment email. Issue versions are advanced by the write functions themselves (`version + 1`); the `maintain_record` trigger only checks that every update advances the version by exactly one.

### US-06: Notifications

Committed events create notifications through an outbox. The MVP may poll. Realtime delivery is added only when needed and always rechecks authorization before delivery. Implemented so far: an assignee gets an `issue_assigned` notification and one email; the worker rechecks membership, assignment, archive state and the email preference before sending.

### US-07: Report content

Users report content without revealing reporter identity to ordinary members. Moderators see only their authorized queue. Every moderation action records actor, target, reason, and timestamp.

Mentor matching, file uploads, rich realtime collaboration, and AI summaries are post-MVP work.

## Operational targets

- Keep the frontend initial route small and lazy-load noncritical features.
- Define latency and error targets per implemented endpoint; do not invent global scale claims.
- Use horizontal application replicas behind a load balancer only when deployment needs them.
- `GET /health` reports process health. Startup fails when required dependencies cannot connect. Add a separate readiness endpoint only when a deployment platform requires it.
- Backups, restore tests, failover, observability, and alerts are deployment work and must be verified in the target environment.

## Delivery pipeline

The repository pipeline is intentionally small:

1. Install dependencies from the frozen lockfile.
2. Run lint, type checks, focused tests, and production builds. Add contract, architecture, or live dependency gates when implemented behavior needs them.
3. Run dependency auditing.
4. Obtain independent review for risky changes such as authentication, RLS, migrations, CI policy, or complex transactions.
5. Merge only the tested commit after required review and checks pass.
6. Deploy the same built artifact, run migrations as a separate controlled step, and smoke-test the release.

Details live in [automation](automation/README.md). Remote branch rules, CODEOWNERS, environments, and deployments are not active until configured and verified on the hosting platform.

## Definition of done

A story is done when its acceptance criteria work, API contracts match behavior, authorization and data invariants are tested at the right boundary, migrations are reversible or have a documented recovery path, logs expose no sensitive data, and applicable repository checks pass. Report the exact commands run and any operational limitations.

## Implementation order

1. Keep the local foundation simple and reproducible.
2. Implement authentication and tenant boundaries.
3. Deliver community discovery and membership.
4. Add posts, workspaces, tasks, and moderation.
5. Measure before adding cache layers, realtime infrastructure, or new services.

Before coding a feature, define its contract, authorization rule, transaction boundary, cache behavior, failure behavior, and tests. Choose the smallest design that satisfies those requirements.
