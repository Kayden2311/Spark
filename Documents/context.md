# Spark product and architecture context

## Product goal

Spark helps startup communities discover each other, manage membership, collaborate, and moderate content. The first release must be a small, production-ready MVP: clear boundaries, reliable data, secure defaults, and enough automation to ship safely. Architecture exists to support product behavior; it must not add infrastructure before a real use case needs it.

All repository content must be English. This includes source code, identifiers, UI copy, documentation, comments, tests, fixtures, logs, errors, commit messages, pull-request text, generated artifacts, and new files.

## Current scope

Application code lives in `Spark_Core` as a pnpm workspace:

- `frontend`: Next.js and TypeScript.
- `backend`: Fastify and TypeScript, organized as a modular monolith.
- `infra`: local Redis configuration. Local PostgreSQL runs directly on port 5432.

The implemented baseline provides one health endpoint, startup configuration and dependency checks, Redis-backed rate limiting, OpenAPI, and tests. CI is not configured yet. Product features, authentication, authorization, migrations, RLS, search, caching, and deployment are implemented only when their stories are scheduled. Documentation must never describe a proposed capability as already operational.

## Technology choices

| Area | Choice | Reason |
| --- | --- | --- |
| Frontend | Next.js, React, TypeScript | Server rendering, routing, and a mature ecosystem. |
| Backend | Fastify, TypeScript | Small runtime, schema-first HTTP APIs, and good performance. |
| Database | PostgreSQL through `pg` | Transactions, constraints, and indexing. Add Drizzle when the first product schema exists. |
| Cache and limiter | Redis | Shared cache, distributed rate limits, and short-lived coordination. |
| Contracts | Fastify JSON Schema and OpenAPI | Runtime validation and generated API documentation without a premature shared package. |
| Tests | Vitest and focused integration tests | Fast feedback with real dependency coverage where it matters. |
| CI | GitHub Actions (planned) | A reproducible quality gate when configured and verified. |

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

Members create, assign, and move tasks. Concurrent updates use a version or conditional request so one update cannot silently overwrite another. Keyboard and mobile interactions remain usable.

### US-06: Notifications

Committed events create notifications through an outbox. The MVP may poll. Realtime delivery is added only when needed and always rechecks authorization before delivery.

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
