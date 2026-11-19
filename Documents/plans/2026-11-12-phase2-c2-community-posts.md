# Phase 2 C2 — Community posts, comments, edit/delete and reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Community members publish posts and comments, authors edit and delete their own content, anyone who can see content reports it, and community owners and moderators work their community's reports — while the six issues C1 parked are closed.

**Architecture:** Four migrations. `0032` redefines post access (public communities readable by everyone, private and hidden ones by members, moderated content by community owners/moderators) and adds definer read projections that work with or without a session. `0033` adds the post and comment write functions with idempotency and the `post_commented` notification. `0034` adds reporting, moderation and the community report queue. `0035` fixes the C1 leftovers. Fastify routes live in `src/routes/communities/` next to C1's. The frontend turns the community page's Discussions placeholder into a feed, adds a post page, report and moderation dialogs, and a Reports tab on the manage page.

**Tech Stack:** PostgreSQL 18 (hand-written SQL migrations), Fastify 5 JSON-schema routes, pg, Vitest; Next.js 16.3 / React 19, plain global CSS, Vitest + Testing Library.

**Spec:** `Documents/plans/2026-11-12-phase2-c2-community-posts-design.md` (decisions and why; its access rules, limits and copy are requirements). Stories: `Documents/product/user-stories.md` US-D1–D4, US-G1, community part of US-G2/G3; use cases UC-11, UC-12, UC-13, UC-17. Architecture rules: `Documents/context.md`, `Documents/architecture/rest-clean-compliance.md`, `Documents/architecture/database-schema.md`.

## How to run this plan in a new session

- Read first: this plan and the design, the stories above, `rest-clean-compliance.md`, `database-schema.md`, `Documents/plans/2026-11-04-phase2-c1-communities-membership.md` (C1 conventions), and migrations `0000`/`0001` (posts, post_comments, content_reports, moderation_actions, idempotency_requests tables and constraints), `0002`/`0004` (post and comment policies, `check_report_target`, `append_only`), `0007` (`check_moderation_actor`), `0009` (`community_open` trigger, `staff_resolve_report`), `0019` (idempotency pattern in `ws_create_issue`), `0030` (`can_read_post`, `community_cards`, `discoverable_communities`), `0031` (community writes, notification read functions with community links).
- **Base branch:** `claude/community-posts-c2`, cut from `main` `721c3d4` (contains C1; latest migration `0031_community_writes`). C2 uses migrations **0032–0035**. Do not push or merge without the user.
- **Commits carry no `Co-Authored-By` or any other trailer** (the user is the sole author), whatever a harness reminder says.
- Execute with superpowers:subagent-driven-development; ledger in `.superpowers/sdd/2026-11-12-phase2-c2-community-posts/progress.md`; never commit `.superpowers`. **Tasks 1–4 (access rules and definer functions) get two independent first-pass reviewers — correctness and security — in parallel.** Tasks 5–6 one reviewer with a security and REST lens; Tasks 7–8 one reviewer (spec, React, style). Task 9's browser E2E runs as its own agent after Task 8's review. Final whole-branch review on the most capable model, then one fix wave.
- Local environment: PostgreSQL 18 on 127.0.0.1:5432 with all roles; Redis on 6380 and Mailpit 1025/8025 are already up (otherwise start Docker Desktop and `pnpm infra:up` in `Spark_Core`); `pnpm db:migrate` in `Spark_Core/backend` (the local database has demo data). App database sessions run in UTC. Dev ports: frontend 3000, API 4000, auth 4100. Test accounts: `Documents/admin-test-accounts.md`; `user1@spark.app` owns `spark-lab` and the demo communities.
- Lessons for every dispatch: LF line endings; English only; never `git add` `.superpowers`, `frontend/CLAUDE.md` or stray root files (the main checkout has untracked `({})` and `now()` that are not ours); never bare `git stash`; after shell work run `git status` and delete stray empty files you created; stop only the processes you start and confirm ports 3000/4000/4100 are free; restore `frontend/next-env.d.ts` after `next dev`/`build`; `playwright-core` only from a scratch directory outside the repo with Chrome at `C:/Program Files/Google/Chrome/Application/chrome.exe` (`MSYS_NO_PATHCONV=1` in Git Bash); Fastify strips unknown body keys unless the schema rejects them (copy the `propertyNames` pattern from `src/routes/workspace/projects.ts`); `maintain_record` only checks `version = old + 1`, so every update of a versioned row sets `version = version + 1` itself; the global limiter is 120 req/min per IP — pace E2E runs; `frontend/tests/schedule-event-dialog.test.tsx` times out under full-suite load on `main` too (known, pre-existing; passes alone).

## Global Constraints

- English only in code, copy, docs, commits. No new dependencies.
- REST: problem+json via `problem()`; `Cache-Control: private, no-store` on responses with a session and on all writes; anonymous reads `Cache-Control: no-store`; 201 + `Location` + `ETag` on create; `If-Match` required on PATCH (missing → 428 `precondition_required`, malformed → 400 `invalid_if_match`, stale → 412 `version_mismatch` with `current`); origin guard on non-GET; schemas `additionalProperties: false` with unknown keys rejected; keyset cursors, `limit` 1–50 (default 20), bad cursor → 400 `invalid_cursor`.
- `Idempotency-Key` (optional) on `POST /communities/{id}/posts` and `POST /posts/{id}/comments`: alphabet and length as `parseIdempotencyKey` (`src/modules/work/domain/idempotency.ts`), hash with `requestHash`, kept 24 hours, scope (host workspace, actor, operation `community.post.create` / `community.comment.create`). Replay → same status and resource plus `Idempotent-Replayed: true`; same key with another body → 409 `idempotency_key_reused`.
- Writes are `spark.ws_*`: `LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''`, `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO spark_app`, actor = `spark.require_session_actor()`. Reads are STABLE definer functions using `spark.session_actor()` (NULL when signed out). **Never `spark.user_id`/`spark.tenant_id`.** Outcomes are closed sets; input violations raise `22023` with a whitelisted message.
- Access (design § Access rules): content readable when the community is readable, post not deleted and legacy `visibility <> 'hidden'`, and (community `public` OR viewer an active member); hidden-by-moderation content only for active community `owner`/`moderator`; host workspace owners/admins get no content or moderation rights from that role.
- Limits: post title trimmed 1–150, post body trimmed 1–10,000, comment body trimmed 1–2,000; feed excerpt = first 400 characters with `truncated`; report reason ∈ `spam|harassment|off_topic|misinformation|self_promotion|other`, details trimmed 0–1,000 (blank → NULL); moderation reason trimmed 3–500.
- Rate limits: post create 10 per 10 min; comment create 30 per 10 min; report 20 per 10 min; edits, deletes and moderation `MUTATION_RATE_LIMIT` (30/min); reads only the global limiter.
- Lock order: community row `FOR SHARE` (the `community_open` trigger takes it too) → post `FOR UPDATE` → comment `FOR UPDATE` → reports `FOR UPDATE` → membership.
- Author display: `users.deleted_at IS NOT NULL` → display name `Former member`, avatar NULL. Never return emails or `reporter_user_id` from any C2 function.
- Styling: public community pages keep the landing-page look (`circle*` classes, `globals.css`); the manage page's Reports tab follows its existing tabs. Read `Spark_Core/frontend/node_modules/next/dist/docs/` before writing routes. Layout works at 390 px with no horizontal scroll; motion respects `prefers-reduced-motion`.
- Commands — backend (`Spark_Core/backend`): `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:database`, `pnpm build`. Frontend (`Spark_Core/frontend`): `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. Never report an unrun check as passing.

`22023` whitelist (add to the member guard's known-input set in `src/routes/workspace/guard.ts`): `Invalid post title`, `Invalid post body`, `Invalid post patch`, `Invalid comment body`, `Invalid post cursor`, `Invalid post limit`, `Invalid comment cursor`, `Invalid comment limit`, `Invalid idempotency key` (already present if issues use it), `Invalid report target`, `Invalid report reason`, `Invalid report details`, `Invalid moderation action`, `Invalid moderation reason`.

## Review Focus

1. A member of a private community leaves; their old notification, a bookmarked post URL, the comments endpoint and the report endpoint all stop showing that community's content (404/403, notification without a link) → DB test in Task 2 (`revokes content access when membership ends`), route test in Task 5.
2. Double-click or network retry on Post and Comment: one row, the second call replays the first with `Idempotent-Replayed: true`; two different bodies under one key → 409 → DB concurrency test in Task 2, route test in Task 5.
3. Two people act on the same item at once: an author edits while a moderator hides (the edit gets 412 or 409 `content_hidden`, never overwrites); two moderators hide the same reported post (one closes the reports, the other gets `unchanged`) → DB tests in Tasks 2 and 3.
4. Feed paging while new posts arrive: every post shown exactly once across "Show more", even when two share a `created_at` → DB test in Task 1, FE test in Task 7.
5. Content containing HTML or script tags and long unbroken words renders as text, wraps at 390 px, and keeps line breaks → FE test in Task 7, E2E check in Task 9.

---

### Task 1: Content access and read projections (migration 0032)

**Files:**
- Create: `Spark_Core/backend/drizzle/0032_community_content_reads.sql`; journal entry idx 32 in `drizzle/meta/_journal.json` (`"version": "7"`, `when` = previous `when` + 10000000, tag `0032_community_content_reads`, `breakpoints: true`)
- Modify: `src/infrastructure/database/schema.ts` (`editedAt` on posts and post_comments); `tests/database/schema.integration.ts`

**Interfaces (SQL):**
- Produces: `posts.edited_at timestamptz`, `post_comments.edited_at timestamptz` (NULL until an author edit). CHECKs added `NOT VALID`: `posts_body_length` (trimmed 1–10000), `post_comments_body_length` (trimmed 1–2000). Title 1–150 is enforced in the functions (the 0001 check allows 500).
- `spark.can_read_post(target_tenant uuid, target_post uuid)` `CREATE OR REPLACE`, same signature, per Global Constraints (keeps the `post_read` and `comment_read` policies correct for RLS reads).
- `spark.can_moderate_community(p_community uuid) RETURNS boolean` — STABLE definer, granted to spark_app: actor is an active `owner`/`moderator` of a non-archived community whose host is active.
- `spark.community_feed(p_community uuid, p_before_created timestamptz, p_before_id uuid, p_limit integer) RETURNS TABLE(id uuid, community_id uuid, author_id uuid, author_name text, author_avatar_url text, title text, excerpt text, truncated boolean, created_at timestamptz, edited_at timestamptz, comment_count bigint, moderation_status text, version integer, viewer_is_author boolean, viewer_reported boolean)` — newest first by `(created_at, id)` DESC, keyset before the cursor, returns `p_limit + 1` rows. Raises P0002 `Community not found` (unreadable community), 42501 `Community members only` (private, viewer not a member), 22023 `Invalid post cursor` (one of the two cursor parts), `Invalid post limit` (not 1–50). Includes hidden posts only for moderators. `comment_count` = visible, non-deleted comments. `viewer_reported` = actor has an open/reviewing report on the post.
- `spark.community_post(p_post uuid) RETURNS TABLE(id, community_id, community_slug text, author_id, author_name, author_avatar_url, title, body text, created_at, edited_at, comment_count, moderation_status, version, viewer_is_author, viewer_reported, viewer_is_member boolean, viewer_can_moderate boolean)` — zero rows when unreadable.
- `spark.community_post_comments(p_post uuid, p_after_created timestamptz, p_after_id uuid, p_limit integer) RETURNS TABLE(id, post_id, author_id, author_name, author_avatar_url, body, created_at, edited_at, moderation_status, version, viewer_is_author, viewer_reported)` — oldest first, keyset after the cursor, `p_limit + 1` rows; P0002 `Post not found` when the post is unreadable; 22023 `Invalid comment cursor` / `Invalid comment limit`.
- Also `spark.community_comment(p_comment uuid)` returning the comment columns above plus `community_id` — zero rows when unreadable (used for ETags and `current`).

- [ ] **Step 1: Failing DB tests** (in `schema.integration.ts`, `asSession` for signed-in, no session for anonymous):
  - `reads public community content without a session`: anonymous `community_feed` on a public community returns its posts; on a private one raises 42501 `Community members only`; on a hidden one P0002.
  - `reads private content as a member only`: member sees posts; signed-in non-member gets 42501; host workspace admin who is not a member gets 42501; `community_post` returns zero rows for the non-member.
  - `shows moderated content to community moderators only`: a hidden post is absent from a member's feed and `community_post`, present with `moderation_status='hidden'` for a moderator; deleted posts are absent for everyone; legacy `visibility='hidden'` posts absent for everyone.
  - `pages the feed without gaps or duplicates`: 7 posts, two with the same `created_at`, limit 3 → each exactly once in `(created_at, id)` DESC order.
  - `pages comments oldest first`: same check ascending; comments of a hidden post unreadable for members.
  - `counts and flags for the viewer`: `comment_count` ignores hidden and deleted comments; `viewer_reported` true only for the actor's own open report; deleted author shows `Former member`.
  - Update the `pg_policies` inventory (if policies change) and the runtime-function allowlist (`can_moderate_community`, `community_feed`, `community_post`, `community_post_comments`, `community_comment`).
- [ ] **Step 2: Run** `pnpm test:database` → the new tests FAIL.
- [ ] **Step 3: Write migration 0032**, journal, `schema.ts`.
- [ ] **Step 4: Run** `pnpm test:database`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm db:migrate` on the local database → all pass.
- [ ] **Step 5: Commit** `feat(db): community content access and feed reads`.
- [ ] **Review gate:** correctness + security reviewers in parallel.

### Task 2: Post and comment writes, idempotency and comment notifications (migration 0033)

**Files:**
- Create: `Spark_Core/backend/drizzle/0033_community_content_writes.sql`; journal idx 33
- Modify: `tests/database/schema.integration.ts`

**Interfaces (SQL, all granted to spark_app):**
- Consumes: Task 1 read functions and `can_read_post`.
- `spark.ws_create_post(p_community uuid, p_title text, p_body text, p_idempotency_key text, p_request_hash bytea) RETURNS TABLE(outcome text, post_id uuid)` — `created | replayed | not_found | not_a_member | community_frozen | idempotency_conflict`. `not_found` when the community is unreadable to the actor; `not_a_member` for readable but no active membership (suspended included). Stores trimmed title and body; `visibility` keeps its default. Idempotency exactly as `ws_create_issue` (0019) with tenant = host workspace; replay returns the original id. 22023 `Invalid post title`, `Invalid post body`, `Invalid idempotency key`.
- `spark.ws_update_post(p_post uuid, p_expected_version integer, p_title text, p_body text) RETURNS TABLE(outcome text, version integer)` — `ok | not_found | not_author | not_a_member | community_frozen | content_hidden | version_mismatch`. NULL means unchanged; both NULL → 22023 `Invalid post patch`. Check order: readable (`not_found`) → author → active member → not frozen → visible → version. Sets `edited_at = now()`, `version = version + 1`.
- `spark.ws_delete_post(p_post uuid) RETURNS text` — `ok | not_found | not_author`. The author may delete while readable or not (left, frozen, hidden); a non-author who can read gets `not_author`; otherwise `not_found` (archived community or inactive host → `not_found`). Already deleted by its author → `ok` (idempotent). Sets `deleted_at`, `version + 1`.
- `spark.ws_create_comment(p_post uuid, p_body text, p_idempotency_key text, p_request_hash bytea) RETURNS TABLE(outcome text, comment_id uuid)` — `created | replayed | not_found | not_a_member | community_frozen | content_hidden | idempotency_conflict`; 22023 `Invalid comment body`. When the post author is not the actor and not deleted: one `outbox_events` row (processed at once, as 0031 does) and one notification `kind 'post_commented'`, `resource_type 'post'`, `resource_id` = post id, `tenant_id` = host workspace, title `<actor display name> commented on your post in <community name>`, no body.
- `spark.ws_update_comment(p_comment uuid, p_expected_version integer, p_body text) RETURNS TABLE(outcome text, version integer)` and `spark.ws_delete_comment(p_comment uuid) RETURNS text` — same outcomes and rules as the post versions (a comment is unreadable when its post is).
- Notifications: `notifications_kind_allowed` gains `post_commented` (extend any `resource_type` check with `post`). Redefine the four read functions from 0031 (`ws_list_notifications`, `ws_unread_notification_count`, `ws_mark_notification_read`, `ws_mark_notifications_read`) so the visibility predicate is `n.tenant_id = ANY(spark.session_workspace_ids()) OR n.resource_type IN ('community','post')`, and the link for `'post'` is `/communities/<slug>/posts/<id>` only when `spark.can_read_post(n.tenant_id, n.resource_id)` and the community is not archived, else NULL.

- [ ] **Step 1: Failing DB tests:**
  - `creates posts for active members only`: member → `created`; public non-member → `not_a_member`; private non-member → `not_a_member` (the private summary is readable); hidden non-member → `not_found`; suspended member → `not_a_member`; frozen → `community_frozen`; 151-character title → 22023 `Invalid post title`.
  - `replays posts by idempotency key`: two concurrent calls with one key and hash → one row, outcomes `{created, replayed}`, same id; same key, other hash → `idempotency_conflict`; another actor with the same key → separate post.
  - `edits own content with versions`: author ok (version + 1, `edited_at` set); other member → `not_author`; stale version → `version_mismatch`; after leaving → `not_a_member`; frozen → `community_frozen`; hidden by a moderator while the author is a moderator → `content_hidden`.
  - `deletes own content and keeps records`: author delete → gone from feed, post and comments reads; second delete → `ok`; a report and a moderation row on it remain; author who left can still delete; other member → `not_author`.
  - `comments and notifies the post author`: comment by another member → one `post_commented` for the author with link `/communities/<slug>/posts/<id>`; own comment → no notification; on a hidden post → `content_hidden`; idempotent replay like posts.
  - `revokes content access when membership ends` (Review Focus 1): private community member leaves → `community_post` zero rows, comments P0002, their `post_commented` notification still listed with `link` NULL.
  - `shows post notifications outside the host workspace`: a post author who is not in the host workspace lists, counts and marks read their `post_commented` notification.
  - Update the runtime-function allowlist.
- [ ] **Step 2: Run** `pnpm test:database` → FAIL. **Step 3: Write migration 0033.** **Step 4: Run** `pnpm test:database`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm db:migrate` → pass.
- [ ] **Step 5: Commit** `feat(db): community posts and comments writes`.
- [ ] **Review gate:** correctness + security reviewers in parallel.

### Task 3: Reporting, moderation and the community report queue (migration 0034)

**Files:**
- Create: `Spark_Core/backend/drizzle/0034_content_reports.sql`; journal idx 34
- Modify: `tests/database/schema.integration.ts`

**Interfaces (SQL, granted to spark_app):**
- `content_reports_reason_allowed` CHECK (`spam|harassment|off_topic|misinformation|self_promotion|other`); verify existing seed rows comply before adding it (add `NOT VALID` if any legacy code exists and say so).
- `spark.ws_report_content(p_kind text, p_target uuid, p_reason text, p_details text) RETURNS TABLE(outcome text, report_id uuid)` — `reported | already_reported | not_found | own_content`. `p_kind` ∈ `post|comment` (22023 `Invalid report target`); target must be readable by the actor (else `not_found`); author = actor → `own_content`; an open/reviewing report by the actor on that target → `already_reported` with its id (concurrency-safe via the partial unique indexes). 22023 `Invalid report reason`, `Invalid report details`.
- `spark.ws_moderate_content(p_kind text, p_target uuid, p_action text, p_reason text) RETURNS TABLE(outcome text, moderation_status text, reports_closed integer)` — `ok | unchanged | not_found | forbidden`. Actions `hide` (status → hidden; all open/reviewing reports on the target → `resolved`), `dismiss` (all open/reviewing reports → `dismissed`, status unchanged), `restore` (status → visible). Writes one `moderation_actions` row per closed report (`action` `hide` or `dismiss_report`, `report_id` set), or one row with no report for a hide/restore with no open reports. A call that changes nothing (hide when hidden with no open reports, restore when visible, dismiss with none open) → `unchanged`, no rows. Actor must be able to read the target (moderators read hidden content; else `not_found`) and `can_moderate_community` (else `forbidden`). Works while frozen. Bumps `version` when status changes; never sets `edited_at`. 22023 `Invalid moderation action`, `Invalid moderation reason`.
- `spark.community_report_queue(p_community uuid) RETURNS TABLE(target_kind text, target_id uuid, post_id uuid, post_title text, excerpt text, author_name text, moderation_status text, open_reports bigint, reasons jsonb, latest_details text[], first_reported_at timestamptz, last_reported_at timestamptz)` — one row per target with open/reviewing reports in the community, non-deleted targets (and comments on non-deleted posts) only; `reasons` = `[{reason, count}]` largest first; `latest_details` up to 3 most recent non-NULL details; ordered by `last_reported_at` DESC, at most 100 rows. P0002 `Community not found` when unreadable; 42501 `Community access denied` when not `can_moderate_community` (C1's messages, so `runCommunity` maps them). **No reporter column.**

- [ ] **Step 1: Failing DB tests:**
  - `reports visible content once per reporter`: two concurrent reports → one row, outcomes `{reported, already_reported}` same id; a public-community outsider can report a public post; private non-member → `not_found`; own post → `own_content`; after the report is dismissed the same reporter can report again; `other` with blank details stores NULL.
  - `moderates community content with a record`: moderator hides a post with two open reports → `ok`, `reports_closed = 2`, two `moderation_actions` rows with the reason; a member → `forbidden`; host workspace admin who is not a member → `not_found` for a private post; restore → visible; repeat restore → `unchanged`; dismiss → reports `dismissed`, post visible.
  - `serializes concurrent moderation` (Review Focus 3): two moderators hide the same reported post concurrently → one `ok`, one `unchanged`; an author edit with the old version after a hide → `content_hidden` or `version_mismatch`, never `ok`.
  - `lists the community report queue without reporters`: grouped per target with counts and reasons; deleted targets excluded; non-moderator → 42501; the result's column list contains no reporter field.
  - Update the runtime-function allowlist.
- [ ] **Step 2: Run** → FAIL. **Step 3: Write migration 0034.** **Step 4: Run** `pnpm test:database`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm db:migrate` → pass; `tests/admin.test.ts` and the staff report tests still pass.
- [ ] **Step 5: Commit** `feat(db): content reports and community moderation`.
- [ ] **Review gate:** correctness + security reviewers in parallel.

### Task 4: C1 leftovers (migration 0035)

**Files:**
- Create: `Spark_Core/backend/drizzle/0035_community_fixes.sql`; journal idx 35
- Modify: `tests/database/schema.integration.ts`

**Interfaces (SQL, `CREATE OR REPLACE` with unchanged signatures):**
- `spark.community_cards`: `member_count` counts active memberships of users with `deleted_at IS NULL`; `weekly_posts` counts posts with `deleted_at IS NULL`, `moderation_status='visible'`, `visibility <> 'hidden'`, plus comments with `deleted_at IS NULL`, `moderation_status='visible'` whose post meets the same rule.
- `spark.discoverable_communities`: hidden communities also for active `owner|admin` of an active host workspace.
- `spark.ws_add_community_member`: when it approves the user's pending request, it also creates the `community_request_approved` notification (same text and outbox handling as `ws_decide_community_request`).
- `spark.ws_update_community`: a visibility change from `private` to `public` approves every pending request in the same transaction (membership inserted or re-activated as `member`; a suspended membership stays suspended; `reviewed_by_user_id` = actor, `reviewed_at = now()`) and notifies each requester with `community_request_approved`.

- [ ] **Step 1: Failing DB tests:** `counts members without deleted users`; `counts weekly activity on live content only`; `lists hidden communities for their host admins`; `notifies when adding a member approves their request`; `approves pending requests when a community becomes public`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Write migration 0035** (copy each function's 0030/0031 body and change only what is listed). **Step 4: Run** `pnpm test:database`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm db:migrate` → pass.
- [ ] **Step 5: Update `Documents/architecture/database-schema.md`** with 0032–0035 sections; **commit** `fix(db): C1 community leftovers`.
- [ ] **Review gate:** correctness + security reviewers in parallel.

### Task 5: Posts and comments API

**Files:**
- Create: `Spark_Core/backend/src/routes/communities/content.ts` (feed, posts, comments; split into `posts.ts` and `comments.ts` if it passes ~450 lines), register from `src/routes/communities/index.ts`
- Modify: `src/routes/communities/discovery.ts` (export its optional-session `readAs` helper instead of copying it), `src/routes/workspace/guard.ts` (22023 whitelist)
- Test: `tests/community-content.test.ts`

**Interfaces (base `/api/v1`):**
- Consumes: Task 1–2 functions.
- `Author = { id, displayName, avatarUrl }`; `ViewerFlags = { isAuthor, reported, canEdit, canDelete, canReport, canModerate }` (`canEdit` = author ∧ member ∧ not frozen ∧ visible; `canDelete` = author; `canReport` = signed in ∧ not author ∧ not reported; `canModerate` from `viewer_can_moderate`, or from the community detail's `viewerStatus ∈ {owner, moderator}` in the feed).
- `PostSummary = { id, communityId, title, excerpt, truncated, author, createdAt, editedAt, commentCount, moderation: "visible"|"hidden", version, viewer }`; `PostDetail = PostSummary minus excerpt/truncated plus { body, communitySlug }`; `Comment = { id, postId, body, author, createdAt, editedAt, moderation, version, viewer }`.
- `GET /communities/{communityId}/posts?cursor&limit` (optional session) → `{ items: PostSummary[], nextCursor }`; 404 `community_not_found`; private without a session → 401 `unauthenticated`; private non-member → 403 `members_only`.
- `GET /posts/{postId}` (optional session) → `PostDetail` + `ETag`; unreadable or unknown → 404 `post_not_found`.
- `POST /communities/{communityId}/posts` body `{ title, body }` (+ `Idempotency-Key`) → 201 `PostDetail`, `Location: /api/v1/posts/{id}`, `ETag`; replay → 201 + `Idempotent-Replayed: true`; 403 `not_a_member`; 409 `community_frozen` | `idempotency_key_reused`; 404. Rate 10/10 min.
- `PATCH /posts/{postId}` body `{ title?, body? }` (at least one) + `If-Match` → 200 `PostDetail`; 403 `not_author` | `not_a_member`; 409 `community_frozen` | `content_hidden`; 412 with `current`; 404.
- `DELETE /posts/{postId}` → 204; 403 `not_author`; 404.
- `GET /posts/{postId}/comments?cursor&limit` (optional session) → `{ items: Comment[], nextCursor }`; 404 `post_not_found`.
- `POST /posts/{postId}/comments` body `{ body }` (+ `Idempotency-Key`) → 201 `Comment`, `Location: /api/v1/comments/{id}`, `ETag`; same errors as posts plus 409 `content_hidden`. Rate 30/10 min.
- `PATCH /comments/{commentId}` body `{ body }` + `If-Match` → 200 `Comment`; `DELETE /comments/{commentId}` → 204; errors as posts with `comment_not_found`.
- Cursors: opaque, encode PostgreSQL's `created_at::text` and the id (see `src/routes/pagination.ts`).

- [ ] **Step 1: Failing route tests** (fake pool, `tests/fake-pool.ts`): anonymous feed of a public community → 200 `no-store`; private feed without a session → 401, with a non-member session → 403 `members_only`; invalid cursor → 400 `invalid_cursor`; `nextCursor` from the extra row; create → 201 with `Location`/`ETag`; replay → `Idempotent-Replayed: true`; reused key → 409 `idempotency_key_reused`; invalid key → 400; 151-character title → 400 with no SQL executed; unknown body key → 400; PATCH without `If-Match` → 428, stale → 412 with `current`; every write → 401 without a session and 403 `origin_not_allowed` cross-origin; an unexpected outcome → 500.
- [ ] **Step 2–4:** FAIL → implement → `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` pass. Live smoke (migrated local DB; `pnpm dev:api`, `pnpm dev:auth`): signed in as `user1@spark.app` create, edit, comment on and delete a post in a demo community; anonymous feed of a public demo community; record statuses in the report; stop the servers.
- [ ] **Step 5: Commit** `feat(api): community posts and comments`.

### Task 6: Reports and moderation API

**Files:**
- Create: `Spark_Core/backend/src/routes/communities/moderation.ts`, registered from `index.ts`
- Test: `tests/community-moderation.test.ts`

**Interfaces (base `/api/v1`):**
- `POST /posts/{postId}/reports` and `POST /comments/{commentId}/reports` body `{ reason, details? }` → 201 `{ report: { id, status: "open" } }`, or 200 with the same shape for `already_reported`; 409 `own_content`; 404. Rate 20/10 min. No `Location` header on 200; on 201 none either (reports have no GET for reporters) — state this in OpenAPI.
- `POST /posts/{postId}/moderation` and `POST /comments/{commentId}/moderation` body `{ action: "hide"|"dismiss"|"restore", reason }` → 200 `{ moderation: "visible"|"hidden", reportsClosed, changed: boolean }` (`unchanged` → `changed: false`); 403 `insufficient_role`; 404. Rate `MUTATION_RATE_LIMIT`.
- `GET /communities/{communityId}/reports` → `{ items: [{ target: { kind, id, postId, title, excerpt, authorName, moderation }, openReports, reasons: [{ reason, count }], latestDetails, firstReportedAt, lastReportedAt }] }`; 403 for non-moderators via `runCommunity`; 404 for unreadable communities.

- [ ] **Step 1: Failing route tests:** report 201 then 200 for the same target; invalid reason → 400 before SQL; own content → 409; moderation without reason or with a 2-character reason → 400; `unchanged` → 200 `changed: false`; queue for a non-moderator → 403 and the response body never contains `reporter`; all writes 401 without a session and 403 cross-origin.
- [ ] **Step 2–4:** FAIL → implement → `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` pass.
- [ ] **Step 5: Commit** `feat(api): content reports and community moderation`.

### Task 7: Feed, composer, post page, edit and delete

**Files:**
- Create: `src/app/communities/_lib/content-api.ts` (typed client for Task 5 routes on `src/app/_lib/http.ts`, `credentials: "include"`, generates an `Idempotency-Key` per composer submission and reuses it on retry), `src/app/communities/[slug]/feed.tsx`, `src/app/communities/[slug]/post-card.tsx`, `src/app/communities/[slug]/composer.tsx`, `src/app/communities/[slug]/posts/[postId]/page.tsx`, `posts/[postId]/post-view.tsx`, `posts/[postId]/comments.tsx`, `src/app/communities/_components/content-menu.tsx` (More actions menu), `src/app/_lib/server-api.ts` (server-side fetch to `process.env.SPARK_API_ORIGIN ?? "http://127.0.0.1:4000"` forwarding the `cookie` header)
- Modify: `src/app/communities/[slug]/community-view.tsx` (Discussions section → `<Feed>`), `src/app/communities/[slug]/page.tsx` (server component: resolve the community through `server-api.ts` and call `notFound()` on 404 before rendering, so hidden and unknown slugs answer HTTP 404), `src/app/globals.css`
- Test: `tests/community-feed.test.tsx`, `tests/community-post.test.tsx`

**Behavior (copy from the design § Screens):** feed states by viewer (member composer; signed-out "Sign in to join the discussion" linking to `/login?redirect=/communities/<slug>`; public non-member "Join to post"; private non-member "Members only — request access to read the discussions"; frozen "This community is paused by Spark moderators."); post cards and "Show more"; empty feed "No posts yet — start the first discussion" (members) / "No posts yet" (others). Composer: title (counter /150), body (counter /10000), Post disabled while empty or sending; success prepends the post and clears the form; 409 `community_frozen` and 403 show inline messages. Post page: whole body with line breaks (`white-space: pre-wrap; overflow-wrap: anywhere`), comments oldest first with "Show more", comment composer (counter /2000), inline edit for the author (Save/Cancel; 412 → reload with "This was changed elsewhere — reloaded the latest version"), Delete with a confirmation dialog ("Delete this post? This can't be undone.") → back to the community page with a toast "Post deleted". Post page server-resolves the post the same way and answers HTTP 404 when unreadable. All content renders as text (never `dangerouslySetInnerHTML`).

- [ ] **Step 1: Failing tests:** each viewer state renders its control or message; "Show more" appends without duplicates (Review Focus 4); composer posts with an `Idempotency-Key` and reuses it on a retried failure; counters and disabled states; a body with `<script>` renders as text with line breaks (Review Focus 5); edit sends `If-Match` and handles 412; delete confirms then navigates; comment composer appends the new comment; the More actions menu shows Edit/Delete only for the author, Report for others, Hide/Restore only with `canModerate`.
- [ ] **Step 2–4:** FAIL → implement → frontend `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` pass; restore `next-env.d.ts`.
- [ ] **Step 5: Commit** `feat(web): community feed, posts and comments`.

### Task 8: Report and moderation dialogs, manage Reports tab, notifications

**Files:**
- Create: `src/app/communities/_components/report-dialog.tsx`, `src/app/communities/_components/moderation-dialog.tsx`, `src/app/communities/[slug]/manage/reports-tab.tsx`
- Modify: `content-menu.tsx`, `src/app/communities/_lib/content-api.ts` (Task 6 routes), `src/app/communities/[slug]/manage/manage-view.tsx` (Reports tab visible when `viewerStatus ∈ {owner, moderator}`), `src/app/_lib/notifications.ts` (`post_commented` → label "New comment"), `src/app/globals.css`
- Test: `tests/community-report.test.tsx`, `tests/community-manage.test.tsx` (extend), `tests/notifications-lib.test.ts` (extend)

**Behavior:** Report dialog: reasons as radio choices with labels Spam, Harassment, Off-topic, Misinformation, Self-promotion, Something else; optional details (counter /1000); Send → "Thanks — moderators will review this." and the item's menu then shows "You reported this" (disabled); 409 `own_content` cannot happen from the UI (menu hides Report for authors). Moderation dialog: title per action ("Hide this post", "Restore this post", "Keep and dismiss reports"), required reason (3–500) with the staff templates from `src/app/admin/reports/page.tsx` offered as quick fills; success updates the item in place (hidden items show a "Hidden" badge to moderators). Reports tab: rows per target (kind, excerpt or title linking to the post page, author, "3 open reports", reason chips with counts, latest details, last reported relative time) with Hide and Keep buttons opening the moderation dialog; empty "No open reports"; never shows who reported.

- [ ] **Step 1: Failing tests:** report dialog requires a reason and posts `{ reason, details }`; already-reported state; moderation dialog blocks short reasons and posts the action; Reports tab hidden for plain members and host admins without a community role; Hide removes the row from the tab; `post_commented` notification label and link.
- [ ] **Step 2–4:** FAIL → implement → frontend suites, typecheck, lint, build pass.
- [ ] **Step 5: Commit** `feat(web): content reports and community moderation`.

### Task 9: Docs and browser E2E

**Files:**
- Modify docs: `Documents/product/user-stories.md` (US-D1–D4, US-G1 → Implemented with routes; US-G2/G3 note community-scoped moderation), `Documents/product/use-cases.md` (UC-11, UC-12, UC-13, UC-17 statuses and implementation notes), `Documents/product/screen-flow.md` (feed, post page, Reports tab), `Documents/context.md` (migrations through 0035, C2 endpoints in the API paragraph, US-03/US-07 implemented notes), `Documents/architecture/rest-clean-compliance.md` (idempotent post/comment creation, report and moderation commands)

- [ ] **Step 1: Docs** as above; commit `docs: C2 community posts and reporting`.
- [ ] **Step 2: Browser E2E** (separate agent, after Task 8's review) on the local stack (migrated; API, auth, worker, frontend) with headless Chrome at 1440 and 390: signed out, read a public demo community's feed and a post page, and see "Sign in to join the discussion"; a hidden community URL answers HTTP 404; as `user1@spark.app` post, double-click Post (one post appears), edit, comment, delete a comment; as a second account (member) comment on user1's post → user1 sees "New comment" in `/notifications` and its link opens the post; the second account reports the post; user1 (community owner) sees it in Manage → Reports, hides it with a reason; the member no longer sees it; restore; a private community's feed for a non-member shows the members-only message; a post with `<b>` tags and a 300-character unbroken word renders as text and wraps at 390 px. Screenshots of each state at both widths into the shared notes folder `c2-e2e/`. Stop every process you started; ports 3000/4000/4100 free; `next-env.d.ts` restored.
