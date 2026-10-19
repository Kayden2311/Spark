# Workspace core M3 — Tasks: create, assign, move Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any workspace member creates tasks in a project, assigns them to a teammate (who gets an in-app notification and, unless they assigned themselves, an email), and moves them across the board by mouse, keyboard or the mobile "Move to…" menu — with WIP limits enforced and no silent overwrite of a teammate's change.

**Architecture:** Migrations 0019–0021 add SECURITY DEFINER `spark.ws_create_issue` / `spark.ws_update_issue` (ranking, WIP admission, issue events, outbox rows, `issue_assigned` notifications) and two `spark.worker_*` functions for the task-assigned email. Fastify routes in `src/routes/workspace/issues.ts` expose board, list, create (Idempotency-Key), detail, PATCH (If-Match) and history. The frontend turns `/w/[slug]/p/[key]` into the board (the M2 overview moves to `/p/[key]/overview`) with native drag-and-drop, keyboard moves, optimistic updates and a task drawer.

**Tech Stack:** PostgreSQL 18 (hand-written SQL migrations), Fastify 5 JSON-schema routes, pg, nodemailer worker (existing), Vitest; Next.js 16.3 / React 19 client components, plain global CSS, Vitest + Testing Library.

**Spec:** `Documents/product/workspace-core-design.md` (Cross-cutting decisions; Email delivery; milestone M3). User stories US-E4, US-E5 in `Documents/product/user-stories.md`. Migration numbers in the spec are indicative; **M3 uses `0019`–`0021`**.

## How to run this plan in a new session

- Read first: `AGENTS.md`, this plan, the spec sections above, `Documents/architecture/rest-clean-compliance.md`, `Documents/architecture/database-schema.md` (0014–0018), `Documents/automation/independent-review.md`.
- Branch: create `feat/workspace-m3` from `origin/main` (M0–M2 merged at `f564326`). Do not push or merge without the user. Commit messages carry **no** `Co-Authored-By` trailer (the user is the sole author).
- Execute with superpowers:subagent-driven-development; ledger in `.superpowers/sdd/<plan>/progress.md`. **Tasks 1, 2 and 4 (migrations, definer functions, worker grants) need two independent first-pass reviewers — correctness and security — in parallel on the same diff** (general-purpose agents briefed with `independent-review.md`). Tasks 3, 5, 6: one reviewer (security lens for Task 3). Finish with a whole-branch review and one fix wave.
- Local environment: PostgreSQL 18 on 127.0.0.1:5432 with roles `spark_owner/spark_migrator/spark_app/spark_auth/spark_worker`; Redis + Mailpit via `pnpm infra:up` in `Spark_Core` (Mailpit web 8025); `pnpm db:migrate` in `Spark_Core/backend`. Dev ports: frontend 3000, API 4000, auth 4100.
- Lessons to put in every dispatch: LF line endings; never `git add` `.superpowers`; after shell work run `git status` and delete stray empty files at the repo root (e.g. `[{`, `div`); stop every dev server/worker you start and verify ports 3000/4000/4100 are free (no orphaned node processes); restore `frontend/next-env.d.ts` if `next dev` rewrote it; the global limiter is 120 req/min per IP and workspace create 5/hour — in local E2E add pauses and you may delete only the local Redis key for the workspace-create route; `playwright-core` only in a scratch directory; Fastify strips unknown body keys by default, so routes that must reject unknown keys need the explicit `propertyNames` pattern used in `src/routes/workspace/projects.ts`.

## Global Constraints

- English only in code, copy, docs, commits (AGENTS.md).
- REST rules (`rest-clean-compliance.md`): problem+json via `problem()`; `Cache-Control: private, no-store` on every authenticated response; 201 + `Location` + `ETag` on create; `If-Match` required on PATCH (missing → 428 `precondition_required`, malformed → 400 `invalid_if_match`, stale → 412 `version_mismatch` with `current` via `preconditionFailed`); ETag `"v{version}"` via `formatEtag`/`parseIfMatch` (`src/modules/work/domain/etag.ts`); origin guard on non-GET; JSON schema with `additionalProperties: false` **and** rejected unknown keys.
- Runtime role `spark_app` gets no INSERT/UPDATE/DELETE. Writes are `spark.ws_*`: `LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''`, `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO spark_app`; actor = `spark.require_session_actor()`. Worker functions are granted to `spark_worker` only. Non-members → outcome `not_found` (never leak existence). Input violations raise ERRCODE `22023` with a whitelisted message.
- **Authority:** every active workspace member (owner/admin/member) may create, edit, assign, move and archive issues in non-archived projects of their workspace.
- **Lock order:** workspace row `FOR SHARE` (new helper, see Task 1) → project row `FOR UPDATE` → board → statuses → issues by id. `guard_issue` (0017) already locks project and board `FOR UPDATE`; functions take them first in this order. Never take the workspace row `FOR UPDATE` in issue writes.
- **Versioning:** the write functions set `issues.version = version + 1` themselves; `spark.maintain_record` and `guard_issue` only check that every UPDATE advances it by exactly one. Every issue version needs exactly one `issue_events` row and one `outbox_events` row (`aggregate_type 'issue'`, `aggregate_version` = version) in the same transaction (deferred `check_issue_change_set`). Outbox rows are inserted with `processed_at = now()` unless an email must be sent (Task 4).
- `issue_events.event_type` ∈ `issue.created | issue.updated | issue.reranked`; `changes` = `{"fields": [changed patch keys], "after": {"statusId","category","assigneeUserId","storyPoints","phaseId","sprintId","archived"}}` (allowlisted snapshot; no title/description text).
- **Issue fields:** title trimmed 1–200; description ≤ 10000 (NULL when empty); type ∈ `task|bug|story` (default `task`; epics/subtasks later); priority ∈ `lowest|low|medium|high|highest` (default `medium`); storyPoints NULL or 0–100 with at most 2 decimals; dueDate NULL or 2000-01-01…2100-12-31; phaseId NULL or a phase of the same project; statusId a status of the same project (default on create: first status by position whose category ≠ `done`). `started_at` is never written by functions (`guard_issue` owns it). Sprint assignment is M4.
- **Limits:** max 10 000 non-archived issues per project (`too_many_issues`); board returns ≤ 500 non-archived issues (`truncated: true` beyond); list pages via `src/routes/pagination.ts` (25 default, 100 max); Idempotency-Key `^[A-Za-z0-9_.:-]{1,100}$`, kept 24 h, operation `issue.create`, request hash = SHA-256 (32 bytes) of the canonical JSON body (keys sorted).
- **Ranking (SQL, under the project lock):** `issues.position numeric(20,6)`. New issue → end of its column (`max + 1024`, or `1024`). Move with `afterIssueId = X` → midpoint between X and the next issue in the target column (excluding the mover), or `X + 1024` at the end; `afterIssueId = null` → `first - 1024` (or `1024` in an empty column); absent → end of the target column. When the gap to a neighbour is `< 0.001`, rebalance the whole target column to `1024 * i` (1-based, current order with the mover placed); every other issue whose position changes gets its own version bump, `issue.reranked` event and processed outbox row.
- **WIP:** moving or creating into a status whose `wip_limit` is reached by other non-archived issues → outcome `wip_limit_reached` (no exception); reordering inside the same column is never blocked; a 23514 "Status WIP limit reached" from the trigger (race fallback) maps to the same 409.
- Rate limits: `POST …/issues` 30/min (`MUTATION_RATE_LIMIT`); `PATCH /issues/{id}` 120/min; reads only the global limiter.
- Frontend: visual language of the landing page and M1/M2 workspace screens (`globals.css` tokens, `.sparkPrimary`, `.sparkSecondary`, pastel tags, initials avatars, `ws*` classes, methodology accents Scrum `#2563eb`, Kanban `#1baf7a`, Waterfall `#d97706`). No new dependencies (native HTML drag-and-drop). Read `Spark_Core/frontend/node_modules/next/dist/docs/` before writing routes/layouts.
- Commands — backend (`Spark_Core/backend`): `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:database`, `pnpm build`. Frontend (`Spark_Core/frontend`): `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. Never report an unrun check as passing.

`22023` whitelist additions (`KNOWN_INPUT_ERRORS` in `src/routes/workspace/guard.ts`): `Invalid issue title`, `Invalid issue description`, `Invalid issue type`, `Invalid issue priority`, `Invalid story points`, `Invalid due date`, `Invalid issue status`, `Invalid issue phase`, `Invalid issue position`, `Invalid issue patch`, `Invalid idempotency key`.

## Decisions (departures from the spec text)

- **Ranking lives in SQL, not in `src/modules/work/domain/ranking.ts`:** positions must be computed under the project lock to stay correct under concurrent moves; the frontend only reorders its local copy optimistically. Ranking is covered by DB tests instead of unit tests.
- **No `spark.project_notifications(outbox_id)` helper:** the two write functions insert the `issue_assigned` notification directly in the same transaction; a helper is added when a third producer appears (M4 sprint start).
- **Sprint assignment (`sprintId`) waits for M4,** which creates sprints; M3 validates status and phase only.
- **Issue writes lock the workspace row `FOR SHARE`** (new `lock_workspace_member`) instead of `lock_workspace_role`'s `FOR UPDATE`, so moves in different projects of one workspace do not serialize; membership changes still exclude concurrent issue writes.
- **Board at `/w/[slug]/p/[key]`, overview at `/w/[slug]/p/[key]/overview`,** with shared header tabs (M4 adds Backlog / Timeline / Settings tabs).
- **The email footer links to `/settings/notifications`** as the spec requires, although that page arrives in M7; preferences can already be stored and are honoured by the worker.
- **Two M2 follow-ups are folded in:** removing a member clears their project leads (Task 1) and a no-op project PATCH no longer bumps `settings_version` (Task 2).

## Review Focus

1. A card dropped on a Kanban column at its WIP limit → the card snaps back and the column explains "In progress is at its WIP limit (4). Finish or move a task out first."; reordering inside a full column still works → DB test (Task 2), route test (Task 3), FE test (Task 5).
2. Two teammates move or edit the same card at once → exactly one wins, the other gets 412 and sees the board refresh with "Updated by a teammate" — no lost update → DB concurrency test (Task 2), FE test (Task 5).
3. A double-submitted or network-retried "Add task" → exactly one task (same Idempotency-Key replays the first result; same key with a different body → 409 `idempotency_key_reused`) → DB test (Task 1), route test (Task 3), FE test that quick-add reuses one key across a retry (Task 5).
4. Assigning a task to someone who left the workspace or belongs to another workspace → 422 `invalid_assignee`; assigning yourself → in-app nothing and no email → DB tests (Tasks 1–2), worker test (Task 4).
5. Keyboard-only and phone users can move cards: Space picks up, arrows move, Enter drops, Esc cancels, each step announced; at 390 px every card has "Move to…" → FE tests (Task 5), E2E screenshots (Task 6).

---

### Task 1: Issue creation in the database (migration 0019)

**Files:**
- Create: `Spark_Core/backend/drizzle/0019_issue_create.sql`; journal idx 19 (`"version": "7"`, `when` 1792330000000, tag `0019_issue_create`, `breakpoints: true`)
- Modify: `Spark_Core/backend/src/infrastructure/database/schema.ts` (only if a mirrored constraint/index needs it), `tests/database/schema.integration.ts`

**Interfaces (SQL):**
- Internal helper `spark.lock_workspace_member(p_workspace uuid, p_actor uuid) RETURNS text` — like `lock_workspace_role` but locks the workspace row `FOR SHARE`; returns the active role or NULL. Revoked from PUBLIC and `spark_app`.
- `spark.ws_create_issue(p_project uuid, p_title text, p_description text, p_type text, p_priority text, p_status uuid, p_assignee uuid, p_story_points numeric, p_due date, p_phase uuid, p_idempotency_key text, p_request_hash bytea) RETURNS TABLE(outcome text, issue_id uuid, issue_version int)` — outcomes `ok | replayed | not_found | no_board | invalid_assignee | wip_limit_reached | too_many_issues | idempotency_conflict`. Order: actor → project (non-archived) in a workspace where the actor is active, else `not_found` → lock order → idempotency (when key given: validate key/hash else 22023 `Invalid idempotency key`; delete the actor's expired row for that key; existing row with same hash → `replayed` with its `resource_id` and the issue's current version; different hash → `idempotency_conflict`) → validation (whitelisted 22023) → no statuses → `no_board` → assignee not an active member → `invalid_assignee` → cap → WIP → insert issue (`number` from `projects.next_issue_number`, which is then incremented; position per ranking rule; `reporter_user_id` = actor) → `issue.created` event (from_version 0) + outbox → when assignee ≠ actor: `notifications` row kind `issue_assigned`, title `left('<actor display name> assigned you <KEY>-<n>: <title>', 500)`, resource `('issue', id)`, `outbox_event_id` = the version-1 outbox row → idempotency row `completed` with `resource_id`, `response_status` 201, `expires_at` now()+24h.
- `notifications_kind_allowed` CHECK becomes `kind IN ('invitation_accepted','issue_assigned')`.
- New policy `recipient_read ON spark.notifications FOR SELECT TO spark_app USING (recipient_user_id = spark.session_actor() AND tenant_id = ANY ((SELECT spark.session_workspace_ids())::uuid[]))`; `GRANT SELECT ON spark.notifications TO spark_app` (verify the existing helper names in 0014 before use).
- Index `issue_events (tenant_id, project_id, created_at, issue_id)` (analytics, spec cross-cutting decision).
- `spark.ws_remove_member` `CREATE OR REPLACE`d to also set `lead_user_id = NULL` on that workspace's projects led by the removed user (carry-over from M2's final review; keep every existing behaviour).

- [ ] **Step 1: Failing DB tests** in `schema.integration.ts` (fixture: two workspaces, a Kanban project with the M2 template statuses created through `ws_create_project`):
  - `creates issues with numbers, positions and history`: two creates → numbers 1 and 2, positions 1024 and 2048 in the first non-done status, `version` 1, one `issue.created` event (`from_version 0`, `to_version 1`, `changes.after.statusId` set) and one processed outbox row each; `next_issue_number` = 3; `projects.settings_version` unchanged.
  - `notifies the assignee but not a self-assignment`: assignee = other member → one `issue_assigned` notification whose title starts with the actor's display name and contains `<KEY>-1`; assignee = actor → none.
  - `guards issue creation`: stranger → `not_found`; other workspace's member as assignee → `invalid_assignee`; status of another project → 22023 `Invalid issue status`; title of 201 chars → 22023 `Invalid issue title`; storyPoints 100.001 → 22023 `Invalid story points`; project without statuses → `no_board`; WIP-full status → `wip_limit_reached`; no session → 28000.
  - `replays idempotent creates`: same key + hash twice → second `replayed` with the same `issue_id`, one issue exists; same key, other hash → `idempotency_conflict`; an expired row is replaced and creates a new issue.
  - `admits WIP concurrently`: two connections create into a status with one free slot (both inside open transactions, second blocked on the project lock) → one `ok`, one `wip_limit_reached`.
  - `rolls back notifications with the transaction`: create with an assignee inside a transaction, ROLLBACK → no issue, event, outbox or notification rows.
  - `lets recipients read only their notifications`: as the assignee's session the row is visible; as another member of the same workspace it is not; after the recipient leaves the workspace it is not.
  - `clears the project lead when the lead is removed`.
  - Update the runtime-function allowlist test (`ws_create_issue`) and the policy inventory (`recipient_read`).
- [ ] **Step 2: Run** `pnpm test:database` → new tests FAIL.
- [ ] **Step 3: Write migration 0019** and the journal entry.
- [ ] **Step 4: Run** `pnpm test:database`, `pnpm test`, `pnpm typecheck`, `pnpm lint` → pass; `pnpm db:migrate` applies to the local database.
- [ ] **Step 5: Update `Documents/architecture/database-schema.md` (0019 section), commit** `feat(db): issue creation with numbering, idempotency and assignment notices`.
- [ ] **Review gate:** correctness + security reviewers in parallel.

### Task 2: Issue updates, moves and ranking (migration 0020)

**Files:**
- Create: `Spark_Core/backend/drizzle/0020_issue_updates.sql`; journal idx 20 (`when` 1792340000000, tag `0020_issue_updates`)
- Modify: `tests/database/schema.integration.ts`

**Interfaces (SQL):**
- `spark.ws_update_issue(p_issue uuid, p_expected_version int, p_patch jsonb) RETURNS TABLE(outcome text, issue_version int)` — outcomes `ok | not_found | version_mismatch | invalid_assignee | wip_limit_reached`. Allowed keys: `title, description, type, priority, statusId, afterIssueId, assigneeUserId, storyPoints, dueDate, phaseId, archived` (camelCase); `{}` or any other key → 22023 `Invalid issue patch`. On an archived issue only `{"archived": false}` is accepted, else 22023 `Invalid issue patch`. Order: actor → issue in a non-archived project of a workspace where the actor is active, else `not_found` → lock order (issue row last) → version check → per-key validation → `afterIssueId` must be a non-archived issue of the same project in the target status and not the issue itself, else 22023 `Invalid issue position` → assignee check → WIP (only when the status changes, or on unarchive) → if no value actually changes return `ok` with the current version and write nothing → update (ranking rule, rebalance when needed) → `issue.updated` event + outbox → `issue_assigned` notification when the assignee changes to someone other than the actor.
- `spark.ws_update_project` (0018) `CREATE OR REPLACE`d so a patch that changes no value returns `ok` with the current `settings_version` and writes no audit row (carry-over from M2's final review; keep everything else).

- [ ] **Step 1: Failing DB tests:**
  - `moves and reorders issues`: move to `In progress` → `ok`, version 2, `started_at` set, event `fields` = `["statusId"]`, `after.category` = `in_progress`; `afterIssueId = null` puts it first; `afterIssueId = X` puts it right after X; positions strictly ordered.
  - `rebalances a crowded column`: 25 alternating "insert after the first issue" moves → every move `ok`, final order matches the intended order, at least one `issue.reranked` event exists and every rebalanced issue's version, event and outbox row agree (transaction commits, so `check_issue_change_set` passed).
  - `rejects a stale version once under concurrency`: two connections update the same issue with the same expected version → one `ok`, one `version_mismatch` carrying the new version.
  - `enforces WIP on moves but not on reorders`: into a full column → `wip_limit_reached`; reorder inside the full column → `ok`; two concurrent moves into the last free slot → one `ok`, one `wip_limit_reached`.
  - `guards issue updates`: stranger → `not_found`; `{}` → 22023 `Invalid issue patch`; `{"methodology":"x"}` → 22023 `Invalid issue patch`; phase of another project → 22023 `Invalid issue phase`; former member as assignee → `invalid_assignee`; reassigning to another member creates one `issue_assigned` notification, to self none; no-op patch (same title) → `ok`, version unchanged, no new event.
  - `archives and restores issues`: archive → hidden from WIP counts; unarchive into a full column → `wip_limit_reached`; title change on an archived issue → 22023.
  - `skips no-op project settings updates`: `ws_update_project` with the current name → `ok`, same `settings_version`, no new audit row.
  - Update the runtime-function allowlist test (`ws_update_issue`).
- [ ] **Step 2: Run** `pnpm test:database` → FAIL. **Step 3: Write the migration.** **Step 4: Run** `pnpm test:database`, `pnpm test`, `pnpm typecheck`, `pnpm lint` → pass; `pnpm db:migrate` applies.
- [ ] **Step 5: Update `database-schema.md` (0020), commit** `feat(db): issue updates, ranking and WIP admission`.
- [ ] **Review gate:** correctness + security reviewers in parallel.

### Task 3: Issue routes

**Files:**
- Create: `Spark_Core/backend/src/routes/workspace/issues.ts` (registered from `index.ts`), `src/modules/work/domain/idempotency.ts`
- Modify: `src/routes/workspace/guard.ts` (whitelist; 23514 `Status WIP limit reached` → 409 `wip_limit_reached` inside `run`)
- Test: `tests/idempotency.test.ts`, `tests/workspace-issues.test.ts`

**Interfaces (base `/api/v1`):**
- `idempotency.ts`: `parseIdempotencyKey(header: string | undefined): string | null | "invalid"`; `requestHash(body: unknown): Buffer` (SHA-256 of JSON with object keys sorted recursively).
- `IssueCard = { id, number, key /* "<PROJECT KEY>-<n>" */, title, type, priority, statusId, assignee: { id, displayName, avatarUrl } | null, storyPoints: number | null, dueDate: string | null, phaseId: string | null, version, completedAt: string | null, createdAt }`.
- `IssueDetail = IssueCard & { projectId, description: string | null, reporter: { id, displayName } | null, startedAt: string | null, updatedAt, archivedAt: string | null }`.
- `GET /projects/{projectId}/board` → `{ project: { id, key, name, methodology }, statuses: [{ id, name, category, position, wipLimit, count }], issues: IssueCard[] /* status position, then issue position, max 500 */, truncated: boolean }`; `count` = all non-archived issues in the status.
- `GET /projects/{projectId}/issues?status=&assignee=<uuid|me|none>&q=&archived=false&cursor=&limit=` → `{ items: IssueCard[], nextCursor }` newest first (keyset `pagination.ts`); `q` ≤ 100 chars, case-insensitive title match.
- `POST /projects/{projectId}/issues` body `{ title, description?, type?, priority?, statusId?, assigneeUserId?, storyPoints?, dueDate?, phaseId? }`, optional `Idempotency-Key` → 201 `IssueDetail` + `Location: /api/v1/issues/{id}` + `ETag`; replay → 201 with the same issue and header `Idempotent-Replayed: true`; `idempotency_conflict` → 409 `idempotency_key_reused`; `wip_limit_reached` → 409; `too_many_issues` → 409; `no_board` → 409 `project_has_no_board`; `invalid_assignee` → 422; `not_found` → 404 `project_not_found`; malformed key → 400 `invalid_input` "Invalid idempotency key.".
- `GET /issues/{issueId}` → `IssueDetail` + `ETag`; 404 `issue_not_found` for non-members and unknown ids.
- `PATCH /issues/{issueId}` (If-Match) body subset of `{ title, description, type, priority, statusId, afterIssueId (uuid|null), assigneeUserId (uuid|null), storyPoints, dueDate, phaseId, archived }` → 200 `IssueDetail` + new `ETag`; 428 / 400 / 412 (`current` = fresh `IssueDetail`) / 404 / 409 `wip_limit_reached` (detail: `"<status name> is at its WIP limit (<n>)."`) / 422 `invalid_assignee`.
- `GET /issues/{issueId}/events?cursor=&limit=` → `{ items: [{ id, type, actor: { id, displayName } | null, fromVersion, toVersion, changes, createdAt }], nextCursor }` newest first.
- Reads inside `guard.run` with explicit columns and explicit `tenant_id`/`project_id` filters in addition to RLS; never `users.*`; unknown outcomes → 500 via `expectOutcome`.

- [ ] **Step 1: Failing tests:** `idempotency.test.ts` — key pattern accepts `a`, `retry-1:2026.10`, rejects empty, 101 chars, spaces; `requestHash({b:1,a:{d:2,c:3}})` equals `requestHash({a:{c:3,d:2},b:1})` and is 32 bytes. `workspace-issues.test.ts` (fake pool, `app.inject`, `rateLimit: false`): 401 on every route; create passes 12 SQL params with the computed hash and `null` key when the header is absent; replay → 201 + `Idempotent-Replayed: true`; `idempotency_conflict` → 409 `idempotency_key_reused`; `wip_limit_reached` on PATCH → 409 with the column name in `detail`; trigger 23514 during PATCH → 409 `wip_limit_reached`; PATCH without If-Match → 428, stale → 412 with `current`, unknown key `{"sprintId": …}` → 400; board with 501 rows → 500 issues and `truncated: true`; `assignee=me` filter binds the session user; GET issue for non-member → 404 `issue_not_found`; `Cache-Control: private, no-store` on success and error responses; cross-origin POST → 403 `origin_not_allowed`.
- [ ] **Step 2–4:** FAIL → implement → `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` pass. Live smoke on the local stack (migrate; `pnpm dev:api`, `pnpm dev:auth`): create a workspace + Kanban project, create 3 issues (one with a repeated Idempotency-Key), move one into `In progress`, fill `Review` to its WIP limit and get 409, PATCH with a stale ETag → 412; record statuses in the report; stop servers.
- [ ] **Step 5: Update `Documents/context.md` (API list), commit** `feat(api): issue board, create, update and history endpoints`.
- [ ] **Review gate:** one reviewer, security lens.

### Task 4: Task-assigned email (migration 0021 + worker)

**Files:**
- Create: `Spark_Core/backend/drizzle/0021_task_assigned_email.sql` (journal idx 21, `when` 1792350000000), `src/modules/email/templates/task-assigned.ts`
- Modify: `src/modules/outbox/handlers.ts`, the two write functions' outbox insert (in 0021 via `CREATE OR REPLACE` of `ws_create_issue`/`ws_update_issue`, keeping everything else), `tests/database/schema.integration.ts`
- Test: `tests/email-templates.test.ts` (extend), `tests/outbox-handlers.test.ts` (create or extend the existing handler tests)

**Interfaces:**
- Write functions: when an `issue_assigned` notification is created, that version's outbox row gets `processed_at = NULL` and payload `{ issueId, projectId, version, notificationId }`; all other issue outbox rows stay processed.
- `spark.worker_task_assigned_email(p_notification uuid) RETURNS TABLE(status text, email text, recipient_name text, actor_name text, workspace_name text, workspace_slug text, project_key text, project_name text, issue_number bigint, issue_title text)` — `status` ∈ `pending | skipped`; `skipped` when the recipient is no longer an active member, no longer the issue's assignee, the issue is archived, an `email` delivery row already exists for the notification, or the recipient's `notification_preferences` row for (`task_assigned`, `email`) has `enabled = false` (no row = enabled). Zero rows for an unknown notification.
- `spark.worker_record_email_delivery(p_notification uuid, p_status text /* sent|suppressed */) RETURNS boolean` — inserts the `notification_deliveries` row (channel `email`, `delivered_at` for sent) `ON CONFLICT DO NOTHING`; false when it already existed.
- Both granted to `spark_worker` only (revoked from PUBLIC, `spark_app`).
- `taskAssignedEmail({ actorName, recipientName, issueKey, issueTitle, projectName, workspaceName, issueUrl, preferencesUrl }): { subject, html, text }` — subject `"<actor> assigned you <KEY>-<n>: <title>"` (title truncated to 80 chars with `…`); button "Open task" → `issueUrl` = `${APP_BASE_URL}/w/<slug>/p/<KEY>?issue=<KEY>-<n>`; footer links "Email preferences" → `${APP_BASE_URL}/settings/notifications`; every value HTML-escaped; same table layout as `invitation.ts`.
- Handler: `"issue.created"` and `"issue.updated"` → `deliverTaskAssigned` (payload without `notificationId` → `"skipped"`; `skipped` status → record `suppressed`, return `"skipped"`; else send, record `sent`, return `"sent"`; SMTP failure → `DeliveryError("smtp_error")`).

- [ ] **Step 1: Failing tests:** DB — `queues one assignment email per notification`: create with another member as assignee → that outbox row unprocessed with `notificationId`; self-assignment → processed; `worker_task_assigned_email` as `spark_worker` returns `pending`, after `worker_record_email_delivery(…,'sent')` returns `skipped`; preference disabled → `skipped`; reassigned meanwhile → `skipped`; `spark_app` cannot execute either worker function (42501). Template — subject, escaping of `<script>` in the title, both links present, plain text contains the URL. Handler — sends via the in-memory sender once, records `sent`; `skipped` path records `suppressed` and sends nothing.
- [ ] **Step 2–4:** FAIL → implement → `pnpm test:database`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` pass; `pnpm db:migrate` applies. Live check: worker + Mailpit — assign a task to a second member, see exactly one email in Mailpit; self-assign → none. Stop the worker.
- [ ] **Step 5: Update `database-schema.md` (0021) and the email section of `context.md`, commit** `feat(worker): task-assigned email`.
- [ ] **Review gate:** correctness + security reviewers in parallel.

### Task 5: Board, moves and quick-add

**Files:**
- Create: `Spark_Core/frontend/src/app/w/[slug]/p/[key]/layout.tsx` (project header + tabs "Board" / "Overview"), `src/app/w/[slug]/p/[key]/overview/page.tsx` (the M2 overview content, moved), `src/app/w/[slug]/p/[key]/board.tsx`, `src/app/w/_lib/issues.ts` (types + calls), `src/app/w/_lib/board-moves.ts` (pure helpers)
- Modify: `src/app/w/[slug]/p/[key]/page.tsx` (now the board), `src/app/globals.css` (`wsBoard*` classes)
- Test: `tests/board-moves.test.ts`, `tests/project-board.test.tsx`; move/adapt `tests/project-overview.test.tsx` to the new route

**Interfaces / behavior:**
- `board-moves.ts`: `moveCard(board: BoardState, issueId: string, toStatusId: string, afterIssueId: string | null): BoardState` (pure, used for optimistic updates); `wipBlocked(board, issueId, toStatusId): boolean` (target ≠ current status and `count ≥ wipLimit`); `keyboardTarget(board, issueId, key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"): { statusId, afterIssueId } | null`.
- Board: columns in status order with header (name, count, `WIP n` chip turning amber at the limit and red-outlined when exceeded by legacy data), cards (key tag, title, type/priority pastel tags, assignee initials avatar, due date red when overdue and not done, story points chip for Scrum, phase tag for Waterfall). Truncated → banner "Showing the first 500 tasks."
- Mouse: native drag-and-drop; drop position from the pointer within the column. Keyboard: card focusable; Space/Enter picks up ("Picked up PL-3. Use arrow keys to move, Enter to drop, Escape to cancel."), arrows move between columns/positions (announced: "PL-3 in In progress, position 2 of 3"), Enter/Space drops, Esc cancels and restores; announcements go to one persistent `aria-live="polite"` region. Mobile (< 768 px) and as a fallback: each card has a "Move to…" button opening a menu of statuses (current one marked, WIP-full ones disabled with "(full)").
- Optimistic move → `PATCH /issues/{id}` with `If-Match`, body `{ statusId?, afterIssueId }`; on 200 replace the card; on 409 `wip_limit_reached` roll back and show the column's inline message `"<Status> is at its WIP limit (<n>). Finish or move a task out first."`; on 412 roll back, refetch the board and show the toast "Updated by a teammate — the board was refreshed."; other errors roll back with the API message.
- Quick-add at the bottom of each non-done column: title input + Enter → `POST /projects/{id}/issues` with `statusId` and an Idempotency-Key generated once per draft (`crypto.randomUUID()`), reused on retry after a network error, reset after success; new card appended; WIP-full column shows the input disabled with the WIP message.
- `/w/[slug]/p/[key]/overview` keeps everything M2's overview showed; the "The board arrives in the next update" note is removed; the Settings button lives in the shared layout header.
- [ ] **Step 1: Failing tests:** `board-moves.test.ts` — `moveCard` across columns updates counts and order; `afterIssueId: null` puts first; `wipBlocked` false for same-column reorder; `keyboardTarget` ArrowRight from the last column → null. `project-board.test.tsx` (stubbed fetch) — renders columns with counts and the Kanban `WIP 4` chip; keyboard pick-up/ArrowRight/Enter sends `PATCH` with `If-Match: "v1"` and `{ statusId: <In progress>, afterIssueId: null }` and announces the drop; Esc restores without a request; WIP 409 rolls the card back and shows the column message; 412 refetches the board and shows the teammate toast; "Move to…" menu disables a full column; quick-add sends one Idempotency-Key and reuses it after a simulated network failure; overview route still renders the M2 sections.
- [ ] **Step 2–4:** FAIL → implement → frontend `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` pass.
- [ ] **Step 5: Commit** `feat(web): project board with drag, keyboard and mobile moves`.
- [ ] **Review gate:** one reviewer.

### Task 6: Task drawer, docs and end-to-end check

**Files:**
- Create: `Spark_Core/frontend/src/app/w/[slug]/p/[key]/task-drawer.tsx`
- Modify: `board.tsx` (open drawer on card click/Enter when not in move mode, `?issue=<KEY>-<n>` deep link), `globals.css`
- Modify docs: `Documents/product/user-stories.md` (US-E4 and US-E5 → Implemented with endpoints/screens and acceptance criteria matching this plan, incl. WIP and idempotency), `Documents/product/screen-flow.md` (board → drawer; overview tab), `Documents/context.md` (migrations through 0021, issue endpoints), `Documents/architecture/rest-clean-compliance.md` (428 and Idempotency-Key replay header, if not already documented)
- Test: `tests/task-drawer.test.tsx`

**Behavior:**
- Drawer (dialog with the M1 modal focus trap, slides from the right on desktop, full screen on mobile): editable title, description, status select (WIP-full disabled), assignee select (members list, "Unassigned", default none), type, priority, story points (Scrum), due date, phase (Waterfall); "Save" PATCHes only changed fields with `If-Match`; 412 → replace form with `current` and show "Updated by a teammate — review the latest values and save again."; 409/422 inline on the field; success → toast via the live region and the card updates. "Archive task" (with confirmation) PATCHes `{ archived: true }` and removes the card. History list from `GET /issues/{id}/events` ("Avery moved it to In progress · 2 h ago", "created", "assigned to Sam") with "Load more".
- Deep link: opening `/w/<slug>/p/<KEY>?issue=<KEY>-<n>` opens the drawer for that card; closing removes the query parameter; unknown number → toast "That task no longer exists." (this is the URL the assignment email uses).
- [ ] **Step 1: Failing tests:** drawer sends only changed fields with `If-Match`; 412 shows the teammate message with the fresh title; assignee options come from members and include "Unassigned"; archive asks for confirmation then removes the card; deep link opens the right task; unknown number shows the toast.
- [ ] **Step 2–4:** FAIL → implement → frontend `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` pass; backend `pnpm test` still passes.
- [ ] **Step 5: End-to-end check** on the real local stack (migrate; `pnpm dev:api`, `pnpm dev:auth`, `pnpm dev:worker`; frontend `pnpm dev`), headless Chrome via `playwright-core` from a scratch directory, with pauses for the 120/min limiter: owner signs up, creates a workspace and a Kanban project; invites a member (Mailpit) who accepts; owner quick-adds 5 tasks, drags one to In progress, fills Review to its WIP limit and sees the block message; keyboard-moves a card; at 390 px uses "Move to…"; assigns a task to the member → exactly one Mailpit email whose link opens the drawer for that task; two contexts move the same card → the second sees the teammate toast; Scrum and Waterfall projects show points and phase tags. Desktop 1440 and mobile 390 screenshots (board per methodology, WIP block, keyboard move in progress, Move-to menu, drawer, history, overview tab) saved to the session notes folder. Look at them critically and polish. Stop all processes; ports free; `next-env.d.ts` restored.
- [ ] **Step 6: Commit** `feat(web): task drawer, deep links and M3 docs` (docs in the same commit).
- [ ] **Review gate:** one reviewer.
