# Phase 2 C1 — Communities: create, discover, join and membership requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Workspace owners and admins host communities; anyone can search and filter public communities and open a community page; signed-in users join public communities instantly or request access to private ones; community owners review requests and manage members — and community data access becomes bound to the live session (closing the known Phase 2 security gap).

**Architecture:** Migration 0030 rebases every community read helper on `spark.session_actor()` (removing all trust in the spoofable `spark.user_id`/`spark.tenant_id` settings), normalizes community fields for filtering, and adds definer discovery projections that work with or without a session. Migration 0031 adds `spark.ws_*` community write functions and lets community notifications reach users outside the host workspace. Fastify routes live in `src/routes/communities/`. The frontend replaces the `/communities` mockups with live pages, adds a manage page for owners, and a "Communities" area inside each workspace.

**Tech Stack:** PostgreSQL 18 (hand-written SQL migrations), Fastify 5 JSON-schema routes, pg, Vitest; Next.js 16.3 / React 19 client components, plain global CSS, Vitest + Testing Library.

**Spec:** `Documents/product/user-stories.md` — US-B1, US-B2, US-B3, US-C1, US-C2, US-C3 (acceptance criteria are requirements). Product decisions from the user (2026-11-04): communities are created by **workspace owners/admins** and hosted by that workspace; **public communities: join instantly; private: request access, owners approve; hidden: invisible to non-members, owners add people directly**; Phase 2 = C1 (this plan) + C2 (posts, comments, edit/delete, reporting). Architecture rules: `Documents/context.md`, `Documents/architecture/rest-clean-compliance.md`, `Documents/architecture/database-schema.md`.

## How to run this plan in a new session

- Read first: `AGENTS.md`, this plan, the six user stories above, `rest-clean-compliance.md`, `database-schema.md`, `Documents/automation/independent-review.md`, and migrations `0001` (community constraints), `0002`/`0004` (current `is_community_member`, `can_read_community`, `can_read_post`, community policies, `serialize_members`, `community_owner` trigger), `0006` (`staff_read` policies), `0009` (`staff_moderate_community`, `featured_at`/`frozen_at`, `community_open` trigger), `0014`/`0015` (session-bound workspace RLS, `lock_workspace_role`, `record_workspace_audit`), `0028` (notification read functions).
- **Base branch:** create `feat/communities-c1` from `main` (tip `7bd3f6c` contains Phase 1 M0–M7 and the admin dashboards; latest migration is `0029_scheduled_emails`). C1 uses migrations **0030** and **0031**. Do not push or merge without the user.
- **Commits carry no `Co-Authored-By` or other trailer** (the user is the sole author).
- Execute with superpowers:subagent-driven-development; ledger in `.superpowers/sdd/<plan>/progress.md`. **Tasks 1 and 2 (RLS rework, definer functions) need two independent first-pass reviewers — correctness and security — in parallel** (general-purpose agents briefed with `independent-review.md`). Tasks 3–4 one reviewer with a security lens; Tasks 5–6 one reviewer. Final whole-branch review on the most capable model, then one fix wave.
- Local environment: PostgreSQL 18 on 127.0.0.1:5432 with all roles (`spark_owner/spark_migrator/spark_app/spark_auth/spark_worker`); start Docker Desktop (`C:\Users\Admin\AppData\Local\Programs\DockerDesktop\Docker Desktop.exe`) then `pnpm infra:up` in `Spark_Core` for Redis + Mailpit; `pnpm db:migrate` and `pnpm db:seed:demo` (demo communities) in `Spark_Core/backend`. Dev ports: frontend 3000, API 4000, auth 4100.
- Lessons for every dispatch: LF line endings; never `git add` `.superpowers`; never `git stash`; after shell work run `git status` and delete stray empty files at the repo root (names like `[{`, `(item.id`, `row.id`), never commit them; stop only the processes you start and verify ports 3000/4000/4100 are free; restore `frontend/next-env.d.ts` if `next dev`/`build` rewrote it; `playwright-core` only in a scratch directory outside the repo with Chrome at `C:/Program Files/Google/Chrome/Application/chrome.exe` and `MSYS_NO_PATHCONV=1` in Git Bash; Fastify strips unknown body keys unless the schema rejects them (copy the `propertyNames` pattern from `src/routes/workspace/projects.ts`); `maintain_record` only **checks** `version = old + 1`; the global limiter is 120 req/min per IP — pace E2E runs.

## Global Constraints

- English only in code, copy, docs, commits.
- REST rules: problem+json via `problem()`; `Cache-Control: private, no-store` on authenticated responses and on any response that varies by session; anonymous discovery responses `Cache-Control: no-store` (they vary by cookie); 201 + `Location` + `ETag` on create; `If-Match` required on PATCH (missing → 428, malformed → 400 `invalid_if_match`, stale → 412 `version_mismatch` with `current`); origin guard on non-GET; schemas `additionalProperties: false` and rejected unknown keys; keyset pagination with opaque cursors and `limit` 1–50 (default 20), invalid cursor → 400 `invalid_cursor`.
- Writes are `spark.ws_*`: `LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''`, `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO spark_app`; actor = `spark.require_session_actor()`. Callers who cannot see a community (hidden and not a member, archived, or unknown) get `not_found`; visible but lacking authority → `forbidden`. Input violations raise ERRCODE `22023` with a whitelisted message.
- **No community read path may use `spark.user_id` or `spark.tenant_id` after 0030.** The actor always comes from `spark.session_actor()`.
- **Community managers** = active community `owner` or `moderator`, or an active `owner|admin` of the host workspace. Only community `owner`s or host workspace `owner|admin` change roles, settings and visibility; moderators review requests and add/remove `member`s.
- **Lock order:** host workspace row `FOR SHARE` → community row `FOR UPDATE` → join request → membership. Membership inserts/updates still fire the existing `serialize_members` and deferred `community_owner` triggers; last-owner checks are explicit in functions (outcome `last_owner`).
- Community fields: `slug` `^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$` globally unique; `name` trimmed 1–80; `tagline` trimmed 1–90; `description` trimmed 1–2000; `visibility` ∈ `public|private|hidden`; `country_code` NULL or `^[A-Z]{2}$`; `city` NULL or trimmed 1–80; `stage` ∈ `idea|pre_seed|seed|series_a|growth|any` (labels: Idea, Pre-seed, Seed, Series A, Growth, Any stage); topics 1–4 from the fixed set `b2b-saas` (B2B SaaS), `climate-tech` (Climate Tech), `ai-data` (AI & Data), `product` (Product), `fintech` (FinTech), `founders` (Founders Circle). Max 10 non-archived communities per host workspace.
- Join request `message` trimmed 0–500. Rejection cooldown: **14 days** from `reviewed_at` before the same user may request again (outcome `request_cooldown`, response includes `retryAfter`).
- Frozen communities (admin `frozen_at`) are visible and listable but refuse joins, requests and decisions (outcome `community_frozen`, 409). Archived communities behave as missing.
- Rate limits: community create 10/hour; join, request and withdraw 20/10 min; decisions and member changes `MUTATION_RATE_LIMIT` (30/min); discovery reads are covered by the global limiter only.
- Frontend visual language = landing page and the existing `/communities` mockups (keep their look: hero, filter bar, cards with generated covers, tone classes `.summaryTone-*`); workspace pages follow the M1–M7 `ws*` styles. No new dependencies. Read `Spark_Core/frontend/node_modules/next/dist/docs/` before writing routes.
- Commands — backend (`Spark_Core/backend`): `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:database`, `pnpm build`. Frontend (`Spark_Core/frontend`): `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. Never report an unrun check as passing.

`22023` whitelist (add to the member guard's known-input set): `Invalid community slug`, `Invalid community name`, `Invalid community tagline`, `Invalid community description`, `Invalid community visibility`, `Invalid community location`, `Invalid community stage`, `Invalid community topics`, `Invalid request message`, `Invalid community role`, `Invalid decision`.

## Review Focus

1. A signed-out visitor searches: private and hidden communities never appear, and paging through all results shows each public community exactly once even when two share a name → DB test in Task 1, route test in Task 3.
2. Someone requests to join a private community they are not in the host workspace of; when the owner approves, the requester sees "approved" in their notification inbox (they are not a workspace member) → DB test in Task 2, FE check in Task 6 E2E.
3. Double-click on Join or Request access: one membership / one pending request, the second call returns the existing state (200), not an error → DB concurrency test in Task 2.
4. Two managers decide the same request at once: one succeeds, the other gets 409 `already_decided` and nothing changes → DB concurrency test in Task 2, route test in Task 4.
5. A user who was rejected tries again within 14 days: clear "You can request again on <date>" instead of a generic error → route test in Task 4, FE test in Task 5.

---

### Task 1: Session-bound community access and discovery projections (migration 0030)

**Files:**
- Create: `Spark_Core/backend/drizzle/0030_community_session_rls.sql`; journal idx 30 (`"version": "7"`, `when` = previous entry's `when` + 10000000, tag `0030_community_session_rls`, `breakpoints: true`)
- Modify: `src/infrastructure/database/schema.ts`; delete `src/infrastructure/database/context.ts` (`withDatabaseContext`) and migrate its 6 uses in `tests/database/schema.integration.ts` to the session helper `asSession`
- Modify: `tests/database/schema.integration.ts`; `Documents/architecture/database-schema.md` (0030 section; remove the "community helpers still trust spark.user_id" caveat)

**Interfaces (SQL):**
- `communities` add `tagline text` (backfill = `left(description, 90)` trimmed, then `NOT NULL` + CHECK 1–90), `settings_version integer NOT NULL DEFAULT 1` (CHECK > 0). **No `version` column** — `staff_moderate_community` (0009) updates communities without bumping one, and `maintain_record` would reject it.
- `stage` normalization: map existing values case-insensitively (`idea`→`idea`; `pre-seed`/`pre_seed`/`preseed`→`pre_seed`; `seed`→`seed`; `series a`/`series_a`→`series_a`; `growth`→`growth`; anything else or NULL→`any`), then `NOT NULL DEFAULT 'any'` + CHECK on the six codes. CHECKs on `country_code` and `city` per Global Constraints.
- Insert the six fixed topics (`topics.slug`, `topics.name`) with `ON CONFLICT (slug) DO NOTHING`; demo `community_topics` rows referencing other topics are kept (they simply never match a filter).
- `spark.is_community_member(target_tenant uuid, target_community uuid, allowed_roles text[])` `CREATE OR REPLACE` (same signature): the session actor holds an active membership with an allowed role in an active, non-archived community whose host workspace is active. **No reference to `spark.user_id`/`spark.tenant_id`.**
- `spark.can_manage_community(p_community uuid) RETURNS boolean` (STABLE definer, granted to spark_app): community owner/moderator or host workspace owner/admin, via the session.
- `spark.can_read_community` redefined: non-archived, host workspace active, and (`visibility IN ('public','private')` OR member OR `can_manage_community`). `spark.can_read_post` redefined with the same member/manager rule (no behaviour change for posts beyond session binding).
- Policies (drop and recreate, `FOR SELECT TO spark_app`): `community_read` on `communities` → `spark.can_read_community(tenant_id, id)`; `community_members_read` on `community_memberships` → member of that community or `can_manage_community`; new `community_topics_read` → `spark.can_read_community(tenant_id, community_id)`; new `join_requests_read` on `community_join_requests` → `user_id = spark.session_actor()` OR `can_manage_community(community_id)`; `topics` gets `topics_read` `USING (true)` (public reference data). Keep every `staff_read` policy. GRANT SELECT on `community_topics`, `community_join_requests`, `topics` to spark_app.
- `spark.discover_communities(p_query text, p_topic text, p_country text, p_stage text, p_after_name text, p_after_id uuid, p_limit int) RETURNS TABLE(id, slug, name, tagline, visibility, country_code, city, stage, topics text[], member_count bigint, weekly_posts bigint, featured boolean, frozen boolean, host_workspace_name text, viewer_status text)` — STABLE definer, granted to spark_app, works **with or without** a session: anonymous → `public` only; with a session → `public` and `private` plus any `hidden` the actor is a member of. Not archived, host workspace active. Search: `p_query` (trimmed, ≤ 100) matched case-insensitively against name, tagline and topic names with LIKE wildcards escaped. Filters are AND. Order `(lower(name), id)`; keyset after `(p_after_name, p_after_id)`; returns `p_limit + 1` rows for paging. `member_count` = active memberships; `weekly_posts` = visible, non-deleted posts + comments created in the last 7 days; `viewer_status` ∈ `none|member|pending|owner|moderator` (NULL without a session).
- `spark.community_by_slug(p_slug text) RETURNS TABLE(same columns + description, created_at, settings_version, can_manage boolean)` — hidden communities return zero rows unless the actor is a member or manager (indistinguishable from a missing slug).
- `spark.community_filter_values() RETURNS TABLE(kind text, value text, label text, count bigint)` — topics (all six, with counts), stages (all six), countries present among communities the caller can discover (counted).

- [ ] **Step 1: Failing DB tests:**
  - `binds community reads to the live session`: with only `set_config('spark.user_id', member)` and `set_config('spark.tenant_id', host)` (no session) a private community's posts and memberships are **not** readable (closes the 2026-10-18 P2 finding); with the member's session token they are.
  - `discovers communities by audience`: anonymous call returns public only; a signed-in non-member also sees private; a hidden community appears only for its members; archived never; frozen appears with `frozen = true`.
  - `pages discovery without gaps or duplicates`: 7 public communities, two named "Alpha", paging with limit 3 returns all 7 exactly once in `(lower(name), id)` order.
  - `filters with AND semantics and escapes wildcards`: topic + stage + country narrows correctly; query `50%` matches only a literal "50%".
  - `hides hidden communities by slug`: `community_by_slug` for a hidden community returns zero rows for a non-member and one row for a member.
  - `normalizes stages`: fixture rows with `Seed`, `Pre-Seed`, `Any`, `Series A`, `weird` map to `seed`, `pre_seed`, `any`, `series_a`, `any`.
  - Update the exact `pg_policies` inventory test and the runtime-function allowlist (`can_manage_community`, `discover_communities`, `community_by_slug`, `community_filter_values`).
- [ ] **Step 2: Run** `pnpm test:database` → FAIL.
- [ ] **Step 3: Write migration 0030**, journal, `schema.ts`; delete `context.ts` and port its test uses.
- [ ] **Step 4: Run** `pnpm test:database`, `pnpm test`, `pnpm typecheck`, `pnpm lint`; `pnpm db:migrate` on the local database (has demo data) → all pass. Admin routes' tests (`tests/admin.test.ts`) still pass.
- [ ] **Step 5: Update `database-schema.md`; commit** `feat(db): session-bound community access and discovery`.
- [ ] **Review gate:** correctness + security reviewers in parallel.

### Task 2: Community write functions and community notifications (migration 0031)

**Files:**
- Create: `Spark_Core/backend/drizzle/0031_community_writes.sql`; journal idx 31
- Modify: `tests/database/schema.integration.ts`

**Interfaces (SQL, all granted to spark_app; outcomes are closed sets):**
- `spark.ws_create_community(p_workspace uuid, p_slug text, p_name text, p_tagline text, p_description text, p_visibility text, p_country text, p_city text, p_stage text, p_topics text[]) RETURNS TABLE(outcome text, community_id uuid)` — `ok | not_found | forbidden | slug_taken | too_many_communities`. Host workspace `owner|admin` only (via `lock_workspace_role`). Inserts the community, its topics, and the creator as active community `owner`; audit `community.created`.
- `spark.ws_update_community(p_community uuid, p_expected_version int, p_patch jsonb) RETURNS TABLE(outcome text, settings_version int)` — `ok | not_found | forbidden | version_mismatch`. Community owner or host workspace owner/admin. Patch keys: `name`, `tagline`, `description`, `visibility`, `countryCode`, `city`, `stage`, `topics` (replace set). `settings_version + 1`; audit `community.updated {changed}`.
- `spark.ws_join_community(p_community uuid) RETURNS TABLE(outcome text, status text)` — `joined | already_member | not_found | request_required | community_frozen | membership_suspended`. Public communities only (`private`/`hidden` → `request_required`). Re-activates a `left` membership. Idempotent.
- `spark.ws_request_community_membership(p_community uuid, p_message text) RETURNS TABLE(outcome text, request_id uuid, retry_after timestamptz)` — `requested | already_pending | already_member | not_found | join_instead | request_cooldown | community_frozen`. Private communities only (`public` → `join_instead`; `hidden` and not a member → `not_found`). An existing pending request is returned (`already_pending`, same id). Rejected within 14 days → `request_cooldown` with `retry_after = reviewed_at + 14 days`. Creates one `community_request_received` notification per community owner/moderator (title `"<user> asked to join <community>"`, `resource_type 'community'`).
- `spark.ws_withdraw_community_request(p_request uuid) RETURNS text` — `ok | not_found | not_pending` (own request only).
- `spark.ws_decide_community_request(p_request uuid, p_decision text) RETURNS TABLE(outcome text, membership_status text)` — `approved | rejected | not_found | forbidden | already_decided | community_frozen`. Managers only. Locks the request `FOR UPDATE`; approve inserts or re-activates the membership (role `member`) in the same transaction; sets `reviewed_by_user_id`, `reviewed_at`; notification `community_request_approved` / `community_request_rejected` to the requester (title `"Your request to join <community> was approved"` / `"… was declined"`); audit `community.request_approved|rejected`. `p_decision` ∉ `approve|reject` → 22023 `Invalid decision`.
- `spark.ws_leave_community(p_community uuid) RETURNS text` — `ok | not_found | last_owner` (sets `status='left'`, `left_at`).
- `spark.ws_set_community_role(p_community uuid, p_user uuid, p_role text) RETURNS text` — `ok | not_found | forbidden | last_owner`; community owner or host workspace owner/admin; roles `owner|moderator|member`.
- `spark.ws_remove_community_member(p_community uuid, p_user uuid) RETURNS text` — `ok | not_found | forbidden | last_owner`; moderators may remove `member`s only.
- `spark.ws_add_community_member(p_community uuid, p_user uuid) RETURNS text` — `ok | already_member | not_found | forbidden | not_in_workspace`; managers; the user must be an active member of the **host workspace** (this is how hidden communities gain members).
- Notifications: extend `notifications_kind_allowed` with `community_request_received`, `community_request_approved`, `community_request_rejected`. **Redefine the 0028 read functions** (`ws_list_notifications`, `ws_unread_notification_count`, `ws_mark_notification_read`, `ws_mark_notifications_read`) so a row is visible when `recipient_user_id = actor` AND (`tenant_id = ANY(spark.session_workspace_ids())` OR `resource_type = 'community'`). Each community notification inserts its `outbox_events` row first (`aggregate_type 'community_join_request'`, `processed_at = now()` — in-app only, no email in C1).
- Audit rows go to `audit_events` with `tenant_id` = host workspace (`record_workspace_audit`).

- [ ] **Step 1: Failing DB tests:**
  - `creates communities hosted by a workspace` (owner/admin ok; member → `forbidden`; stranger → `not_found`; duplicate slug → `slug_taken`; 11th → `too_many_communities`; five topics → 22023 `Invalid community topics`; creator is community owner; audit row).
  - `joins public communities once`: two concurrent `ws_join_community` calls → one active membership, outcomes `{joined, already_member}`; private → `request_required`; frozen → `community_frozen`.
  - `requests access to private communities once`: concurrent requests → one pending row, outcomes `{requested, already_pending}` with the same id; public → `join_instead`; hidden non-member → `not_found`; owners receive `community_request_received`.
  - `decides each request exactly once`: two managers deciding concurrently → one `approved`, one `already_decided`; approval creates the membership in the same transaction; rejection creates none; non-manager → `forbidden`; requester gets the decision notification.
  - `enforces the rejection cooldown`: re-request on day 13 → `request_cooldown` with `retry_after` = reviewed_at + 14 days; on day 15 → `requested`.
  - `shows community notifications outside the host workspace`: a requester who is not a member of the host workspace lists, counts and marks read their `community_request_approved` notification; a workspace notification of a workspace they left stays hidden.
  - `protects the last community owner` (leave/demote/remove sole owner → `last_owner`; moderator removing a moderator → `forbidden`).
  - `adds hidden-community members from the host workspace only` (`not_in_workspace` otherwise).
  - Update the runtime-function allowlist with every new `ws_*`.
- [ ] **Step 2: Run** `pnpm test:database` → FAIL. **Step 3: Write migration 0031.** **Step 4: Run** `pnpm test:database`, `pnpm test`, `pnpm typecheck`, `pnpm lint` → pass.
- [ ] **Step 5: Commit** `feat(db): community membership writes and notifications`.
- [ ] **Review gate:** correctness + security reviewers in parallel.

### Task 3: Discovery API

**Files:**
- Create: `Spark_Core/backend/src/routes/communities/discovery.ts`, `src/routes/communities/index.ts` (`registerCommunityRoutes(app, { pool })`, called from `buildApp` in `src/app.ts`), `src/modules/communities/domain/catalog.ts` (topic and stage codes + labels)
- Test: `tests/community-discovery.test.ts`

**Interfaces (base `/api/v1`):**
- Optional session: when a valid `spark_session` cookie is present, run reads in `withSessionContext`; otherwise in a plain transaction with no session setting. An invalid/expired cookie is treated as anonymous (no 401 on discovery).
- `CommunityCard = { id, slug, name, tagline, visibility, location: { countryCode: string|null, city: string|null }, stage: { code, label }, topics: Array<{ slug, name }>, memberCount, weeklyPosts, featured, frozen, host: { name }, viewerStatus: "none"|"member"|"pending"|"owner"|"moderator"|null }`.
- `GET /communities?q&topic&country&stage&cursor&limit` → `{ items: CommunityCard[], nextCursor }`; `topic` ∈ the six slugs, `stage` ∈ the six codes, `country` `^[A-Z]{2}$`, `q` ≤ 100, `limit` 1–50 → otherwise 400 `invalid_input`. Cursor encodes `{ t: lower(name), id }` with `encodeCursor` from `src/routes/pagination.ts`.
- `GET /communities/filters` → `{ topics: [{ value, label, count }], stages: [...], countries: [...] }`.
- `GET /communities/{slug}` → `CommunityDetail = CommunityCard & { description, createdAt, canManage: boolean, version: number }` + `ETag`; private communities return the same detail (summary is public by design: description, topics, counts) but `canManage` false for non-managers; hidden + non-member → 404 `community_not_found`.
- `GET /me/communities` (session required, 401 otherwise) → `{ items: CommunityCard[] }` the actor's active memberships, ordered by name.
- [ ] **Step 1: Failing route tests** (fake pool): anonymous list passes NULL-session to SQL and returns cards; invalid `topic`/`stage`/`limit` → 400; invalid cursor → 400 `invalid_cursor`; `nextCursor` built from the extra row; detail 404 for an empty result; `/me/communities` 401 without a cookie; responses carry `Cache-Control: no-store` (anonymous) or `private, no-store` (with a session).
- [ ] **Step 2–4:** FAIL → implement → `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` pass.
- [ ] **Step 5: Commit** `feat(api): community discovery`.

### Task 4: Community management API

**Files:**
- Create: `Spark_Core/backend/src/routes/communities/membership.ts`, `src/routes/communities/management.ts` (registered from `index.ts`)
- Modify: `src/routes/workspace/guard.ts` (22023 whitelist additions)
- Test: `tests/community-membership.test.ts`, `tests/community-management.test.ts`

**Interfaces (base `/api/v1`; outcome → HTTP via a table, unknown → 500):**
- `POST /workspaces/{workspaceId}/communities` body `{ slug, name, tagline, description, visibility, countryCode?, city?, stage, topics }` → 201 `CommunityDetail`, `Location: /api/v1/communities/{slug}`, `ETag`; 409 `slug_taken` | `too_many_communities`; 403 `insufficient_role`; 404 `workspace_not_found`. Rate 10/hour.
- `GET /workspaces/{workspaceId}/communities` → `{ items: CommunityCard[] }` hosted by that workspace (members of the workspace).
- `PATCH /communities/{communityId}` (subset of the create body minus `slug`), `If-Match` → 200 `CommunityDetail`; 428/400/412/403/404.
- `POST /communities/{communityId}/join` → 200 `{ status: "member", alreadyMember }`; 409 `request_required` | `community_frozen`; 403 `membership_suspended`. Rate 20/10 min.
- `POST /communities/{communityId}/requests` body `{ message? }` → 201 `{ request: { id, status: "pending", message, createdAt } }` or 200 with the existing pending request; 409 `join_instead` | `already_member` | `community_frozen` | `request_cooldown` (problem body adds `retryAfter`). Rate 20/10 min.
- `GET /me/community-requests` → `{ items: [{ id, community: { slug, name }, status, message, createdAt, reviewedAt }] }` (US-C3).
- `DELETE /community-requests/{requestId}` → 204; 409 `not_pending`.
- `GET /communities/{communityId}/requests?status=pending|approved|rejected` → `{ items: [{ id, requester: { id, displayName }, message, status, createdAt, reviewedAt }] }`; managers only, others 403 with the list never queried.
- `POST /community-requests/{requestId}/decision` body `{ decision: "approve"|"reject" }` → 200 `{ status }`; 409 `already_decided` | `community_frozen`; 403; 404.
- `GET /communities/{communityId}/members` → `{ items: [{ userId, displayName, avatarUrl, role, joinedAt }] }` (members and managers; explicit columns, never emails).
- `POST /communities/{communityId}/members` body `{ userId }` → 201; 409 `already_member`; 422 `not_in_workspace`.
- `PATCH /communities/{communityId}/members/{userId}` body `{ role }` → 200; 409 `last_owner`. `DELETE /communities/{communityId}/members/{userId}` → 204 (self = leave); 409 `last_owner`.
- [ ] **Step 1: Failing route tests:** every route → 401 without a session; create → 201 with `Location`/`ETag`; join idempotent 200 shape; request returns 201 then 200 for the same pending request; cooldown → 409 with `retryAfter`; decision `already_decided` → 409; non-manager listing requests → 403 and no list SQL executed; PATCH without `If-Match` → 428, stale → 412 with `current`; cross-origin POST → 403 `origin_not_allowed`; unknown body key → 400.
- [ ] **Step 2–4:** FAIL → implement → `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` pass. Live smoke on the local stack (migrate + demo seed; `pnpm dev:api`, `pnpm dev:auth`): anonymous list/filters/detail; sign up two users; create a workspace and a private community as user A; user B requests, A approves; B joins a public demo community; record statuses in the report; stop servers.
- [ ] **Step 5: Commit** `feat(api): community membership and management`.

### Task 5: Live directory, community page and request flow

**Files:**
- Modify: `Spark_Core/frontend/src/app/communities/page.tsx`, `communities/[slug]/page.tsx`, `communities/[slug]/request/page.tsx`, `request/request-form.tsx`, `request/sent/page.tsx`, `communities/community-card.tsx`, `communities/types.ts` (replace with the API `CommunityCard`/`CommunityDetail` shapes), `communities/filter.ts` (URL ↔ filters only)
- Create: `src/app/communities/_lib/api.ts` (`communitiesApi` on top of `src/app/_lib/http.ts`, `credentials: "include"`), `src/app/communities/_lib/use-communities.ts`
- Delete: `communities/mock-data.ts`, `communities/community-summaries.ts` (and their tests' fixtures move into test files)
- Test: update `tests/communities-page.test.tsx`, `tests/community-card.test.tsx`, `tests/filter.test.ts`, `tests/request-form.test.tsx`; add `tests/community-detail.test.tsx`

**Behavior:**
- Directory: keep the existing hero and filter bar look; filters (search, topic, country, stage) live in the URL (`?q=&topic=&country=&stage=`) and restore on reload/share (US-B2); options come from `GET /communities/filters`; results from `GET /communities` with a "Show more" button using `nextCursor`; empty state "No communities match — clear filters" with a Clear button; signed-in users see a "Your communities" strip from `/me/communities`; featured communities show a "Featured" tag; frozen ones a muted "Paused" tag.
- Community page `/communities/[slug]`: hero (name, tagline, host workspace, visibility badge, stage, location, topic tags), stats (members, posts this week), About; action area by state — signed out: "Sign in to join" / "Sign in to request access" (to `/login?redirect=/communities/<slug>` or `/request`); `none` + public: **Join** (POST join → state becomes member, toast); `none` + private: **Request access** → request page; `pending`: "Request pending" + Withdraw; `member`: "You're a member" + Leave (confirm); manager: "Manage" link to `/communities/[slug]/manage`; frozen: actions disabled with "This community is paused by Spark moderators." Hidden/unknown → existing not-found page. Discussion section shows "Discussions open in the next update" (C2).
- Request page: textarea (0–500, counter), Send → POST requests → `/communities/<slug>/request/sent`; existing pending → show its state instead of the form; cooldown 409 → "You can request again on <date>"; `join_instead` → redirect to the community page with Join; signed-out visitors are sent to sign in and returned (US-C1).
- [ ] **Step 1: Failing tests:** filters round-trip through the URL; "Show more" appends the next page without duplicates; empty state clears filters; each action state renders the right control; Join posts and switches to member; request form posts the message and navigates to `sent`; cooldown message shows the formatted date; signed-out request redirects to `/login?redirect=…`.
- [ ] **Step 2–4:** FAIL → implement → frontend `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` pass.
- [ ] **Step 5: Commit** `feat(web): live community directory, pages and requests`.

### Task 6: Community management, workspace communities, notifications, docs and E2E

**Files:**
- Create: `src/app/communities/[slug]/manage/page.tsx` (tabs: Requests, Members, Settings), `src/app/w/[slug]/communities/page.tsx` (hosted list + "Create community" for owner/admin), `src/app/w/[slug]/communities/new/page.tsx`
- Modify: `src/app/components.tsx` (WorkspaceShell "Communities" nav → `/w/{slug}/communities`; keep a "Browse communities" link to `/communities`), notification rendering for the three new kinds (link to `/communities/<slug>` or its manage page), `src/app/globals.css`
- Modify docs: `Documents/product/user-stories.md` (B1–B3, C1–C3 → Implemented with routes; add the creation rule and join rules), `Documents/product/screen-flow.md`, `Documents/context.md` (migrations through 0031, community endpoints), `Documents/architecture/database-schema.md` (0031)
- Test: `tests/community-manage.test.tsx`, `tests/workspace-communities.test.tsx`, notification rendering test

**Behavior:**
- Manage page (managers only; others get "Only community owners and moderators can manage this community"): Requests tab — pending list (requester initials avatar, name, message, date) with Approve / Decline, optimistic removal, 409 `already_decided` → refresh with "Someone already decided this request"; Members tab — members with role pills; owners get a role select (409 `last_owner` inline), managers can remove members (confirm), and "Add from workspace" picker (host workspace members not yet in the community) — this is how hidden communities gain members; Settings tab — edit fields with `If-Match`, 412 → refresh with "Updated by a teammate"; visibility change explains its effect.
- Workspace communities page: hosted community cards; Create form (slug derived from name like workspace slugs, live preview `spark.app/communities/<slug>`, tagline counter, description, visibility radio with plain-language help, country select + city, stage select, 1–4 topic chips) → POST → `/communities/<slug>`.
- [ ] **Step 1: Failing tests:** non-manager sees the restriction card; approve removes the row and handles `already_decided`; role select shows `last_owner` message; add-from-workspace lists only non-members; settings 412 handling; create form validates topics count and posts the expected body; notification items for the three kinds link correctly.
- [ ] **Step 2–4:** FAIL → implement → frontend and backend suites, typecheck, lint, build pass.
- [ ] **Step 5: End-to-end check** on the local stack (migrate + demo seed; API, auth, worker, frontend) with headless Chrome: anonymous search + filters + URL reload; user A creates a workspace and a private and a hidden community; user B (not in A's workspace) requests access to the private one, A approves on the manage page, B sees the "approved" notification and the member state; B joins a public demo community and leaves it; B is rejected from another private community and sees the cooldown date; A adds a workspace member to the hidden community. Desktop 1440 and mobile 390 screenshots of the directory, a community page in each action state, the request page, the manage tabs, and the create form. Stop all processes; ports free; `next-env.d.ts` restored.
- [ ] **Step 6: Commit** `feat(web): community management and workspace communities` (docs in the same commit).
