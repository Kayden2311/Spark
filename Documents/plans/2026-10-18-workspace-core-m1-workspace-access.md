# Workspace core M1 — Workspace access, create, invite, accept Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-up user creates a workspace, invites teammates by email, teammates accept from the emailed link, and everyone sees the workspace through session-bound row-level security (US-E1, US-E2, US-E3). Ships the email delivery foundation (worker process, outbox dispatcher, SMTP with local Mailpit, templates) that later milestones reuse.

**Architecture:** Workspace read access moves from the unused `spark.user_id`/`spark.tenant_id` settings to the live session (`spark.session_token_hash` → `spark.session_actor()`), via a new `spark.session_workspace_ids()` used by every workspace RLS policy. All writes are SECURITY DEFINER `spark.ws_*` functions returning closed outcome sets; routes live in `src/routes/workspace/` and map outcomes to HTTP. Frontend gets a member API client, a guarded `/w/[slug]` area, onboarding, members/invite management and an accept-invitation page in the landing-page visual language.

**Tech Stack:** nodemailer (new backend dependency, SMTP), Mailpit (local Docker inbox), PostgreSQL 18 (hand-written SQL migrations, Drizzle schema mirror), Fastify 5 JSON-schema routes, pg, Vitest; Next.js 16.3 / React 19 client components, plain global CSS, Vitest + Testing Library.

**Spec:** `Documents/product/workspace-core-design.md` (milestone M1; cross-cutting decisions apply).

## Global Constraints

- English only in code, copy, docs, commits (AGENTS.md).
- Follow `Documents/architecture/rest-clean-compliance.md`: problem+json errors (`type,title,status,code,detail,instance,requestId` via `problem()` in `src/routes/responses.ts`), `Cache-Control: private, no-store` on every authenticated response, 201 + `Location` on create, 204 without body, origin guard applies to all non-GET `/api/v1/` routes.
- Runtime role `spark_app` gets **no** INSERT/UPDATE/DELETE grants. Every write is a `spark.ws_*` function: `LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''`, `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO spark_app`. Actor = `spark.session_actor()`; when NULL raise `'Live session required'` with ERRCODE `28000`. Input violations raise ERRCODE `22023` with a message from the whitelist below.
- Non-members of a workspace always get outcome `not_found` (never reveal existence). Members lacking the role get `forbidden`.
- Every membership/invitation/workspace write inserts one `spark.audit_events` row in the same transaction (`actor_kind='user'`, `resource_type` ∈ `workspace|invitation|membership`, `action` ∈ `workspace.created|workspace.renamed|invitation.created|invitation.revoked|invitation.accepted|member.role_changed|member.removed|member.left|invitation.resent`).
- Slug: `^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$` (3–40 chars). Workspace name: trimmed, 1–80 chars. Owned-workspace cap: 20 active (abuse guard, not billing).
- Invitations: token = 32 random bytes, hex in transit, SHA-256 hash stored (reuse `newSessionToken`/`hashSessionToken` pattern from `src/infrastructure/database/session.ts`); expiry exactly 7 days. An invitation is created with an unusable random hash; **only the worker issues the real token** when it sends the email (`spark.worker_issue_invitation_token`), and resending rotates it. The raw token exists only in worker memory and the email link `/invitations/accept#token=…` — never in the database, outbox payload, API responses, query strings or logs. Owners invite `admin` or `member`; admins invite `member` only.
- Roles: `owner` changes roles; `owner|admin` invite, revoke, rename workspace; `owner|admin` remove members (admins only members); anyone may leave. Last active owner cannot be demoted or removed → `last_owner` (409).
- ETag `"v{n}"`; `If-Match` required on PATCH: missing → 428 `precondition_required`, malformed → 400 `invalid_if_match`, stale → 412 `version_mismatch` with body `{ ..., current: <resource> }`.
- Rate limits (route `config.rateLimit`): workspace create 5/hour; invitation create and resend 20/10 min; invitation preview and accept 10/min; other mutations 30/min (`MUTATION_RATE_LIMIT`).
- Frontend visual language = landing page (`src/app/globals.css` tokens `--ink`, `--blue`, `--line`, `--canvas`, navy sidebar `#09265a`; reuse `.sparkPrimary`, `.sparkSecondary`, `.sparkKicker`, pastel `.tag` tones, round initials `.avatar`). No new dependencies. Read `Spark_Core/frontend/node_modules/next/dist/docs/` for client-component routing (`useParams`, `useRouter`, layouts) before writing routes.
- Commands — backend (in `Spark_Core/backend`): `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:database` (local Postgres must be up; if not, report the limitation, never claim a pass), `pnpm build`. Frontend (in `Spark_Core/frontend`): `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- Keep LF line endings. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

`22023` message whitelist (add to the member guard's known-input set): `Invalid workspace name`, `Invalid workspace slug`, `Invalid invitation email`, `Invalid invitation role`, `Invalid invitation expiry`, `Invalid member role`.

## Review Focus

1. A member removed from a workspace who still has a tab open: their next request must 404, and the frontend must leave the workspace area gracefully → FE test in Task 6 (guard shows not-found state on 404 and refreshes the session).
2. An emailed invite link opened by a different signed-in account: 403 `recipient_mismatch` with copy naming the masked invited email; the invitation stays pending → DB test in Task 2 and FE test in Task 7.
3. Invite link opened while signed out: user signs in or signs up and lands back on the accept page with the token intact; the token never appears in a query string → FE test in Task 7.
4. Email case/whitespace: invite `" Bob@Example.COM "` must match an account registered as `bob@example.com` → DB test in Task 2.
5. Double-click / two tabs accepting at once: exactly one membership; the second call returns `already_member` (200), not an error → DB concurrency test in Task 2.

---

### Task 1: Session-bound workspace RLS (migration 0014)

**Files:**
- Create: `Spark_Core/backend/drizzle/0014_workspace_session_rls.sql`
- Modify: `Spark_Core/backend/drizzle/meta/_journal.json` (idx 14, `when` 1792280000000, tag `0014_workspace_session_rls`)
- Modify: `Spark_Core/backend/src/infrastructure/database/schema.ts` (`workspaces.version` integer not null default 1)
- Modify: `Spark_Core/backend/tests/database/schema.integration.ts`
- Modify: `Documents/architecture/database-schema.md` (section on tenant RLS: session-bound, `session_workspace_ids`, sign-up no longer creates a workspace)

**Interfaces:**
- Produces (SQL):
  - `spark.session_workspace_ids(p_roles text[] DEFAULT ARRAY['owner','admin','member']) RETURNS uuid[]` — STABLE SECURITY DEFINER; ids of active workspaces where `spark.session_actor()` holds an active membership with a role in `p_roles`; empty array when no session. Granted to `spark_app`.
  - `spark.is_workspace_member(target uuid, allowed_roles text[])` — redefined (same signature) as `target = ANY(spark.session_workspace_ids(allowed_roles))`.
  - `spark.require_session_actor() RETURNS uuid` — internal (NOT granted to spark_app): returns actor or raises `'Live session required'` 28000.
  - `spark.workspaces.version integer NOT NULL DEFAULT 1` + `maintain_record` trigger on `workspaces` (same trigger function as other versioned tables).
  - Policies (drop and recreate, `FOR SELECT TO spark_app`): `workspace_read` on `workspaces` → `id = ANY ((SELECT spark.session_workspace_ids()))`; `workspace_members_read` on `workspace_memberships` and `workspace_read` on the 16 tables of the 0002 loop → `tenant_id = ANY ((SELECT spark.session_workspace_ids()))`.
  - `users` policy `self_and_coworker_read`: row is the session actor, or shares an active workspace with the actor (via internal definer helper `spark.is_coworker(p_user uuid) RETURNS boolean`, granted to spark_app). Existing `own_user_read` is dropped.
  - `spark.auth_register_password` — `CREATE OR REPLACE`, same signature and return columns; creates user, primary email, credential and session only; returns `(new_user, NULL, NULL, NULL)`.
- Community helpers (`is_community_member`, `can_read_*`) and `withDatabaseContext` stay unchanged (Phase 2).

- [ ] **Step 1: Write failing DB tests** (in `schema.integration.ts`; seed sessions for userA/userB with `newTokenHash()` as owner, as existing session tests do):
  - Replace `isolates tenants and clears pooled context after commit and rollback` body: `asSession(tokenA, SELECT id FROM projects)` → `[projectA, projectOther]` sorted; tokenB → `[projectB]`; plain `runtime.query` → `[]`; an error inside a session transaction then a plain query → `[]`.
  - `ignores spoofed tenant settings`: as spark_app, `set_config('spark.user_id', userA)` + `set_config('spark.tenant_id', tenantA)` without a session → `SELECT FROM workspaces` and `projects` return `[]`.
  - `hides workspaces after leaving or suspension`: set userA's membership in tenantA to `left` (owner role, as owner) → tokenA sees no tenantA rows.
  - `lets members read coworkers but not strangers`: tokenA reads `users` → contains userA and coworkers of tenantA only, not userB.
  - `registers without creating a workspace`: call `auth_register_password` via authRuntime → `workspace_id` null and no new `workspaces` row by that creator.
  - Update `migrates 61 tables…` only if table count changes (it does not), and update `exposes exactly the intended functions to the runtime role` list to add `is_coworker`, `session_workspace_ids`.
- [ ] **Step 2: Run** `pnpm test:database` → new/changed tests FAIL.
- [ ] **Step 3: Write migration 0014** per Interfaces; update journal and `schema.ts`.
- [ ] **Step 4: Run** `pnpm test:database`, `pnpm typecheck`, `pnpm lint` → pass. Note: `src/routes/auth-credentials.ts` still compiles (it reads nullable columns at runtime; its fix is Task 3).
- [ ] **Step 5: Update `database-schema.md`**, commit `feat(db): bind workspace row access to the live session`.
- [ ] **Review gate:** correctness + security reviewers (RLS replacement, auth function change).

### Task 2: Workspace, membership and invitation write functions (migration 0015)

**Files:**
- Create: `Spark_Core/backend/drizzle/0015_workspace_membership_writes.sql`
- Modify: `drizzle/meta/_journal.json` (idx 15, `when` 1792290000000, tag `0015_workspace_membership_writes`)
- Modify: `tests/database/schema.integration.ts`

**Interfaces (all granted to spark_app; outcomes are the closed set listed):**
- `spark.ws_create_workspace(p_name text, p_slug text) RETURNS TABLE(outcome text, workspace_id uuid)` — `ok | slug_taken | too_many_workspaces`. Inserts workspace (`created_by_user_id`=actor) + owner membership; audit `workspace.created`.
- `spark.ws_update_workspace(p_workspace uuid, p_expected_version int, p_name text) RETURNS TABLE(outcome text, version int)` — `ok | not_found | forbidden | version_mismatch`; owner/admin; audit `workspace.renamed` with `{from,to}`.
- `spark.ws_list_members(p_workspace uuid) RETURNS TABLE(user_id uuid, display_name text, avatar_url text, email text, role text, status text, joined_at timestamptz)` — active members only; raises nothing for non-members (returns zero rows); `email` non-null only when the caller is owner/admin.
- `spark.ws_create_invitation(p_workspace uuid, p_email text, p_role text, p_token_hash bytea, p_expires_at timestamptz) RETURNS TABLE(outcome text, invitation_id uuid)` — `ok | not_found | forbidden | already_member | invitation_pending`. Email normalized `lower(btrim())`, must match `^[^@\s]+@[^@\s]+\.[^@\s]+$` and ≤ 254 chars; expiry must be within `(now(), now() + 8 days]`. First marks this tenant+email's stale pending rows `expired`. Audit `invitation.created` (metadata `{role}`, never the token).
- `ws_create_invitation` also inserts `outbox_events(event_type 'invitation.created', aggregate_type 'workspace_invitation', aggregate_id = invitation id, aggregate_version 1, payload {invitationId})` with `processed_at NULL` (the Task 3 worker emails it). The `p_token_hash` argument is a random placeholder from the API; the real token is issued by the worker.
- `spark.ws_resend_invitation(p_invitation uuid) RETURNS text` — `ok | not_found | forbidden | not_pending`; owner/admin; resets `expires_at` to now + 7 days; enqueues `invitation.resent` with `aggregate_version` = previous max + 1; audit `invitation.resent`.
- `spark.ws_revoke_invitation(p_invitation uuid) RETURNS text` — `ok | not_found | forbidden | not_pending`; audit `invitation.revoked`.
- `spark.ws_invitation_preview(p_token_hash bytea) RETURNS TABLE(status text, workspace_name text, inviter_name text, role text, email_hint text, expires_at timestamptz)` — no session needed; zero rows when unknown; `status` is `expired` when pending past expiry; `email_hint` = first char + `***@` + domain.
- `spark.ws_accept_invitation(p_token_hash bytea) RETURNS TABLE(outcome text, workspace_id uuid, workspace_slug text, role text)` — `ok | already_member | invalid_invitation | invitation_expired | invitation_revoked | invitation_used | recipient_mismatch | membership_suspended`. Locks the invitation `FOR UPDATE`; recipient = actor's primary `user_emails.normalized_email`; re-activates a `left` membership instead of inserting; marks invitation `accepted`; audit `invitation.accepted`; inserts `outbox_events(event_type 'invitation.accepted', aggregate_type 'workspace_invitation', aggregate_id invitation, aggregate_version 1, payload {workspaceId, userId}, processed_at now())` and one `notifications` row for the inviter (`kind 'invitation_accepted'`, title `"<name> joined <workspace>"`, `resource_type 'workspace'`). Same accepted user calling again → `already_member` with the workspace.
- `spark.ws_set_member_role(p_workspace uuid, p_user uuid, p_role text) RETURNS text` — owner only; `ok | not_found | forbidden | last_owner`; audit `member.role_changed {from,to}`.
- `spark.ws_remove_member(p_workspace uuid, p_user uuid) RETURNS text` — `ok | not_found | forbidden | last_owner`; self → `member.left`, else owner/admin (admin only removes `member`) → `member.removed`; sets `status='left', left_at=now()`.
- `notifications.kind` CHECK allowlist added: `('invitation_accepted')` (later milestones extend it). Notification read policy is Task M7's; no runtime grant on `notifications` here.
- Column-level read for `workspace_invitations`: `GRANT SELECT (id, created_at, tenant_id, email_normalized, role, invited_by_user_id, expires_at, status, accepted_at, revoked_at)` + policy `invitation_admin_read` `tenant_id = ANY ((SELECT spark.session_workspace_ids(ARRAY['owner','admin'])))`.
- Last-owner checks are explicit inside the functions (the deferred `workspace_owner` trigger fires only at commit and cannot be mapped to an outcome).

- [ ] **Step 1: Write failing DB tests:**
  - `creates a workspace with its owner atomically` (slug_taken on repeat; 21st owned → `too_many_workspaces`; invalid slug `"-ab"` → 22023 `Invalid workspace slug`; no session → 28000).
  - `renames with optimistic version` (stale version → `version_mismatch`; member role → `forbidden`; stranger → `not_found`; version increments; one audit row).
  - `invites, previews, revokes and expires invitations` (admin inviting `admin` → `forbidden`; existing member email → `already_member`; second pending → `invitation_pending`; preview of revoked shows `revoked`; past-expiry shows `expired`; `has_column_privilege('spark_app', workspace_invitations.token_hash, 'SELECT')` is false).
  - `accepts only for the invited account` (case/whitespace email match; wrong account → `recipient_mismatch` and invitation still pending; accepted → membership active, inviter notification row exists, audit row exists; reuse → `invitation_used` for another user, `already_member` for the same user; left member re-activated).
  - `accepts once under concurrency`: two runtime connections with the same token in parallel → exactly one active membership, outcomes `{ok, already_member}`.
  - `protects the last owner` (demote/remove sole owner → `last_owner`; with two owners demotion works; admin cannot remove admin → `forbidden`; self-leave → `member.left` audit).
  - Update the runtime-function allowlist test with every new `ws_*` name.
- [ ] **Step 2: Run** `pnpm test:database` → FAIL.
- [ ] **Step 3: Write migration 0015** per Interfaces.
- [ ] **Step 4: Run** `pnpm test:database`, `pnpm typecheck`, `pnpm lint` → pass.
- [ ] **Step 5: Commit** `feat(db): workspace, membership and invitation write functions`.
- [ ] **Review gate:** correctness + security reviewers.

### Task 3: Email delivery foundation (migration 0016, worker process, SMTP)

**Files:**
- Create: `Spark_Core/backend/drizzle/0016_email_worker.sql`; journal idx 16 (`when` 1792300000000, tag `0016_email_worker`)
- Modify: `Spark_Core/infra/postgres/bootstrap-local.sql` (role `spark_worker`, same shape as `spark_auth`: login, noinherit, no memberships, `statement_timeout '15s'`, connect on database `spark`; schema usage granted by the migration), `Spark_Core/infra/compose.yaml` (service `mailpit`, image `axllent/mailpit` pinned to a released tag at least 2 weeks old, ports `127.0.0.1:1025:1025` and `127.0.0.1:8025:8025`, `no-new-privileges`)
- Modify: `Spark_Core/backend/src/config.ts` (`loadWorkerConfig(env)`: `WORKER_DATABASE_URL`, `SMTP_URL` default `smtp://127.0.0.1:1025`, `EMAIL_FROM` default `Spark <no-reply@spark.local>`, `APP_BASE_URL` default `http://localhost:3000`), `backend/scripts/database-support.ts` (`localConnection("WORKER_DATABASE_URL")` default `postgresql://spark_worker:spark_worker_local_only@127.0.0.1:5432/spark`), `backend/package.json` (`dev:worker`, `start:worker`, `dev` regex `^dev:(api|auth|worker)$`, dependency `nodemailer`, dev dependency `@types/nodemailer`), `src/infrastructure/database/roles.ts` (`assertWorkerRole`: not superuser, no BYPASSRLS, no memberships, cannot SELECT `spark.users`), `.env.example` if present
- Create: `src/worker.ts` (entrypoint), `src/modules/email/{email-sender.ts, smtp-sender.ts, memory-sender.ts, layout.ts, templates/invitation.ts}`, `src/modules/outbox/{dispatcher.ts, handlers.ts}`
- Test: `tests/email-templates.test.ts`, `tests/outbox-dispatcher.test.ts`, DB tests in `tests/database/schema.integration.ts`
- Docs: `Documents/context.md` (third process, Mailpit, `spark_worker`), `Spark_Core/README.md` (run `pnpm infra:up`, re-run `pnpm db:bootstrap:local`, Mailpit at http://localhost:8025)

**Interfaces:**
- SQL (all SECURITY DEFINER, `search_path=''`, granted **only** to `spark_worker`; `spark_app` and `spark_auth` get nothing new):
  - `spark.worker_claim_outbox(p_lock_token uuid, p_limit int, p_lease_seconds int) RETURNS TABLE(id uuid, tenant_id uuid, event_type text, aggregate_type text, aggregate_id uuid, payload jsonb, attempts int)` — rows with `processed_at IS NULL AND available_at <= now() AND (locked_until IS NULL OR locked_until < now())`, ordered by `available_at, id`, `FOR UPDATE SKIP LOCKED`; sets `locked_until`, `lock_token`, `attempts = attempts + 1`. `p_limit` 1–100 and lease 10–600 s, else 22023.
  - `spark.worker_complete_outbox(p_id uuid, p_lock_token uuid) RETURNS boolean` — sets `processed_at = now()`, clears the lease; false if the lease was lost.
  - `spark.worker_fail_outbox(p_id uuid, p_lock_token uuid, p_error_code text, p_retry_at timestamptz) RETURNS boolean` — records `last_error_code` (≤ 64 chars), clears the lease, sets `available_at = p_retry_at`; when `attempts >= 8` sets `processed_at = now()` (dead letter, `last_error_code` kept).
  - `spark.worker_invitation_email(p_invitation uuid) RETURNS TABLE(status text, email text, workspace_name text, inviter_name text, role text, expires_at timestamptz)`.
  - `spark.worker_issue_invitation_token(p_invitation uuid, p_token_hash bytea) RETURNS boolean` — only for `pending` and unexpired invitations; replaces `token_hash`.
  - Grants: `USAGE ON SCHEMA spark TO spark_worker`; no table privileges.
- Invitation outbox rows and `ws_resend_invitation` come from Task 2 (migration 0015).
- TypeScript:
  - `interface EmailMessage { to: string; subject: string; html: string; text: string }`; `interface EmailSender { send(message: EmailMessage): Promise<{ messageId: string | null }> }`; `createSmtpSender(smtpUrl: string, from: string): EmailSender` (nodemailer `createTransport(smtpUrl)`); `createMemorySender(): EmailSender & { sent: EmailMessage[] }`.
  - `layout.ts`: `renderEmail({ preheader, heading, paragraphs: string[], action?: { label, url }, footerNote }): { html, text }` — table layout, inline styles, navy `#09265a` header bar with the "Spark" wordmark, `#2563eb` button, `#17233d` ink, system font stack, every interpolated value HTML-escaped; footer "Manage email settings: {APP_BASE_URL}/settings/notifications".
  - `templates/invitation.ts`: `invitationEmail({ inviterName, workspaceName, role, acceptUrl, expiresAt }): Omit<EmailMessage, "to">` — subject `"<inviter> invited you to <workspace> on Spark"`.
  - `dispatcher.ts`: `createDispatcher({ pool, sender, handlers, appBaseUrl, now?, batchSize = 20, leaseSeconds = 120 }): { runOnce(): Promise<{ claimed: number; sent: number; failed: number }> }`; retry backoff `min(2^attempts minutes, 6 hours)`; error codes are short identifiers (`smtp_error`, `template_error`, `not_found`), never message text or addresses.
  - `handlers.ts`: `Record<string, Handler>`; `invitation.created` and `invitation.resent`: load via `worker_invitation_email`; complete without sending unless `pending`; generate a token (`newSessionToken` pattern), call `worker_issue_invitation_token`, send with `acceptUrl = ${appBaseUrl}/invitations/accept#token=${token}`. **Unknown event types are completed without action** (existing issue and in-app events).
  - `worker.ts`: `assertWorkerRole`; poll loop (call `runOnce` until it claims 0, then wait 2 s); graceful SIGINT/SIGTERM shutdown; logs counts only.

- [ ] **Step 1: Failing tests:** templates (escapes `<script>` in the workspace name; text part contains the accept URL; exact subject); dispatcher with a fake pool and memory sender (completes unknown events; sends one invitation email whose link has `#token=` plus 64 hex chars; calls `worker_issue_invitation_token` with the SHA-256 of that token; on send failure calls `worker_fail_outbox` with `smtp_error` and retry time now + 2^attempts minutes); DB tests (claims across two connections never return the same row; `attempts >= 8` dead-letters; `spark_app` cannot execute any `worker_*` function; `spark_worker` cannot SELECT any table; issuing a token for a revoked invitation returns false; `ws_create_invitation` enqueues exactly one `invitation.created`).
- [ ] **Step 2: Run** `pnpm test` and `pnpm test:database` → FAIL.
- [ ] **Step 3: Implement**; run `pnpm db:bootstrap:local` (creates `spark_worker`; if it needs credentials you do not have, report the limitation), `pnpm infra:up`, `pnpm db:migrate`.
- [ ] **Step 4: Run** `pnpm test`, `pnpm test:database`, `pnpm typecheck`, `pnpm lint`, `pnpm build` → pass. Manual check: with Mailpit up, run the worker once against a seeded `invitation.created` event and confirm the message arrives (`GET http://localhost:8025/api/v1/messages`); stop the worker afterwards.
- [ ] **Step 5: Commit** `feat(worker): outbox dispatcher and SMTP email delivery`.
- [ ] **Review gate:** correctness + security reviewers (new DB role, definer functions, token handling).

### Task 4: Sign-up without workspace, shared session guard, member guard, ETag

**Files:**
- Create: `Spark_Core/backend/src/routes/session-guard.ts` (moved from `src/routes/admin/guard.ts`: `idParams`, `pageQueryProperties`, `readCursor`, `expectOutcome`, `MUTATION_RATE_LIMIT`, plus `databaseDenial(error)` → `"no_session" | "no_role" | null` and `invalidInputDetail(error, known: ReadonlySet<string>)`); `admin/guard.ts` imports them and re-exports the ones admin routes import today.
- Create: `Spark_Core/backend/src/routes/workspace/guard.ts`
- Create: `Spark_Core/backend/src/modules/work/domain/etag.ts`
- Modify: `Spark_Core/backend/src/routes/auth-credentials.ts` (sign-up returns `workspace: null, workspaces: []`, user `role: "member"`)
- Test: `tests/etag.test.ts`, `tests/workspace-guard.test.ts`, update `tests/auth-credentials.test.ts`, `tests/admin.test.ts` must stay green.

**Interfaces:**
- `etag.ts`: `formatEtag(version: number): string` → `"v3"` style with quotes; `parseIfMatch(header: string | undefined): number | null | "invalid"` (undefined → null; `"v12"` → 12; `W/"v1"`, `*`, `"x"` → `"invalid"`).
- `workspace/guard.ts`:
  - `interface Member { userId: string; tokenHash: Buffer }`
  - `createMemberGuard(pool: Pool): { authenticate(request, reply): Promise<Member | null>; run<T>(request, reply, member, work: (client: PoolClient) => Promise<T>): Promise<T | undefined> }` — `authenticate` sets `Cache-Control: private, no-store`, 401 `unauthenticated` / `session_expired` exactly like `createStaffGuard.authorize`; `run` wraps `withSessionContext` with `SET LOCAL statement_timeout = '5s'`, maps 28000 `Live session required` → 401 `session_expired`, 22023 → 400 `invalid_input` using the whitelist in Global Constraints.
  - `preconditionFailed(request, reply, current: unknown)` → 412 problem with `code "version_mismatch"` and extra `current` property; `preconditionRequired(request, reply)` → 428 `precondition_required`.
- [ ] **Step 1: Failing tests** — `etag.test.ts` (cases above); `workspace-guard.test.ts` with `fake-pool.ts`: no cookie → 401 `unauthenticated`; unknown session → 401 `session_expired`; work throwing `{code:"28000",message:"Live session required"}` → 401; `{code:"22023",message:"Invalid workspace slug"}` → 400 detail `"Invalid workspace slug."`; unknown 22023 message → generic detail; `auth-credentials.test.ts` sign-up expects `workspace: null`, `workspaces: []`.
- [ ] **Step 2: Run** `pnpm test` → FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm test`, `pnpm typecheck`, `pnpm lint` → pass (admin tests unchanged).
- [ ] **Step 5: Commit** `refactor(api): share the session guard and add the member guard`.

### Task 5: Workspace and member routes

**Files:**
- Create: `Spark_Core/backend/src/routes/workspace/workspaces.ts`, `src/routes/workspace/members.ts`, `src/routes/workspace/index.ts` (`registerWorkspaceRoutes(app, { pool })`)
- Modify: `Spark_Core/backend/src/app.ts` (call `registerWorkspaceRoutes` in `buildApp` after admin routes)
- Test: `tests/workspace-routes.test.ts`

**Interfaces (JSON shapes; all under `/api/v1`):**
- `Workspace = { id, slug, name, role, memberCount, version, createdAt }`.
- `POST /workspaces` body `{ name: string (1–80), slug: string (pattern above) }` → 201 `Workspace`, `Location: /api/v1/workspaces/{id}`, `ETag`; 409 `slug_taken`; 409 `too_many_workspaces`; rate 5/hour.
- `GET /workspaces` → `{ items: Workspace[] }` (actor's active memberships; RLS + explicit `user_id = member.userId`).
- `GET /workspaces/{workspaceId}` → `Workspace` + `ETag`; 404 `workspace_not_found` for non-members.
- `GET /workspaces/by-slug/{slug}` → same as above (frontend resolves `/w/[slug]`).
- `PATCH /workspaces/{workspaceId}` body `{ name }`, `If-Match` → 200 `Workspace` + new `ETag`; 428 / 400 `invalid_if_match` / 412 (`current` = fresh `Workspace`) / 403 `insufficient_role` / 404.
- `GET /workspaces/{workspaceId}/members` → `{ items: Array<{ userId, displayName, avatarUrl, email: string|null, role, joinedAt }> }`; 404 for non-members (detect via membership check, since `ws_list_members` returns zero rows).
- `PATCH /workspaces/{workspaceId}/members/{userId}` body `{ role: "owner"|"admin"|"member" }` → 200 member; 403 / 404 `member_not_found` / 409 `last_owner`.
- `DELETE /workspaces/{workspaceId}/members/{userId}` → 204; 403 / 404 / 409 `last_owner`.
- Outcome→HTTP map per route as a `Record<outcome, [status, code]>` table (pattern of `statusOutcomes` in `src/routes/admin/users.ts`); unknown outcome throws (via `expectOutcome`).
- [ ] **Step 1: Failing route tests** (fake pool, `app.inject`, `rateLimit:false`): every route → 401 without cookie; create → 201 with `Location`/`ETag`, 409 `slug_taken`, 400 for `slug "A b"` (schema); PATCH without `If-Match` → 428, stale → 412 with `current`, malformed → 400; members 404 for non-member; role change `last_owner` → 409; DELETE → 204 empty body; cross-origin POST with foreign `Origin` → 403 `origin_not_allowed`; responses carry `Cache-Control: private, no-store`.
- [ ] **Step 2–4:** run FAIL → implement → `pnpm test`, `typecheck`, `lint`, `build` pass.
- [ ] **Step 5: Commit** `feat(api): workspace and member endpoints`.

### Task 6: Invitation routes and docs

**Files:**
- Create: `Spark_Core/backend/src/routes/workspace/invitations.ts` (registered from `index.ts`)
- Test: `tests/workspace-invitations.test.ts`
- Modify docs: `Documents/product/user-stories.md` (US-A4 note "sign-up no longer creates a workspace"; US-E1, E2, E3 → Implemented with routes; E2 wording "owner or admin invites"), `Documents/architecture/rest-clean-compliance.md` (add 428 `precondition_required` and the 412 `current` body), `Documents/context.md` (migration range 0000–0015).

**Interfaces:**
- `Invitation = { id, email, role, status, invitedBy: { id, displayName }, expiresAt, createdAt }`.
- `POST /workspaces/{workspaceId}/invitations` body `{ email (≤254), role: "admin"|"member" }` → 201 `{ invitation: Invitation }` (`Location` to the invitation; the email is sent by the worker; **no token in the response**); 403 / 404 / 409 `already_member` / 409 `invitation_pending`; rate 20/10 min.
- `POST /workspaces/{workspaceId}/invitations/{invitationId}/resend` → 202 `{ invitation }` (new link emailed, old link stops working); 403 / 404 / 409 `not_pending`; rate 20/10 min.
- `GET /workspaces/{workspaceId}/invitations?status=pending|accepted|revoked|expired` → `{ items: Invitation[] }` (owner/admin; members get 403 `insufficient_role` — check role before querying; never selects `token_hash`).
- `DELETE /workspaces/{workspaceId}/invitations/{invitationId}` → 204; 404; 409 `not_pending`.
- `POST /invitations/preview` body `{ token: string (64 hex) }` → 200 `{ status, workspaceName, inviterName, role, emailHint, expiresAt }`; 404 `invalid_invitation`; no session required; rate 10/min.
- `POST /invitations/accept` body `{ token }` → 200 `{ workspace: { id, slug }, role, alreadyMember: boolean }`; 401 without session; 403 `recipient_mismatch` (detail names the masked email) / 403 `membership_suspended`; 404 `invalid_invitation`; 409 `invitation_expired | invitation_revoked | invitation_used`; rate 10/min.
- Tokens are hashed with SHA-256 server-side before any SQL; the request body is excluded from logs (Fastify default logs no bodies — assert no `token` in logged objects is out of scope; just never log it).
- [ ] **Step 1: Failing tests:** create response contains no `token` and passes a 32-byte random placeholder hash to SQL; resend → 202; GET list response never contains `token`/`tokenHash`; member listing invitations → 403; preview unknown → 404; accept mapping for every outcome; accept without cookie → 401; body `{ token: "short" }` → 400.
- [ ] **Step 2–4:** FAIL → implement → `pnpm test`, `typecheck`, `lint`, `build` pass.
- [ ] **Step 5: Commit** `feat(api): workspace invitations` (docs in the same commit).

### Task 7: Member API client, workspace guard, onboarding and shell

**Files:**
- Create: `Spark_Core/frontend/src/app/w/_lib/api.ts`, `src/app/w/_lib/use-workspace-data.ts`
- Create: `src/app/onboarding/page.tsx`, `src/app/w/[slug]/layout.tsx`, `src/app/w/[slug]/page.tsx`, `src/app/w/[slug]/workspace-context.tsx`
- Modify: `src/app/workspace/page.tsx` (resolver), `src/app/components.tsx` (`WorkspaceShell` on real data), `src/app/auth-context.tsx` (accept `workspace: null`), `src/app/globals.css` (new `ws*` classes for onboarding/home, using landing tokens)
- Test: `tests/workspace-api.test.ts`, `tests/workspace-onboarding.test.tsx`, `tests/workspace-guard.test.tsx`

**Interfaces:**
- `workspaceApi<T>(path: string, opts?: { method?: "GET"|"POST"|"PATCH"|"PUT"|"DELETE"; body?: unknown; ifMatch?: string; idempotencyKey?: string; signal?: AbortSignal }): Promise<{ data: T; etag: string | null }>` — fetches `/api/v1${path}` with `credentials: "include"`; errors via `toApiError` from `src/app/_lib/http.ts`; 401 dispatches `SESSION_EXPIRED_EVENT`; 204 → `data` undefined. Fallback copy: 403 `"Your workspace role does not allow this action."`, 409 `"This changed since you loaded it. Refresh and try again."`.
- `useWorkspaceData<T>(path: string | null): { data, etag, error, errorStatus, loading, reload }` — same semantics as `admin/_lib/use-admin-data.ts`.
- `WorkspaceProvider` / `useWorkspace(): { workspace: Workspace; reload(): void }` from `workspace-context.tsx`.
- Routes:
  - `/workspace` (client): signed out → `/login?redirect=/workspace`; no workspaces → `/onboarding`; else `/w/{last}` where `last` = `localStorage["spark:last-workspace"]` if still in `useAuth().workspaces`, otherwise the first.
  - `/onboarding`: kicker "Get started", headline "Name your workspace", name input with live slug preview (`spark.app/w/<slug>` text, editable slug field, client derives slug: lowercase, non-alnum → `-`, trimmed to 40); submit → `POST /workspaces` → `refreshSession()` → `/w/{slug}`; 409 `slug_taken` shows inline "That address is taken. Try another." on the slug field. A second card previews "Next: choose how your team works — Scrum, Kanban or Waterfall" (informational, no link).
  - `/w/[slug]/layout.tsx`: signed out → `/login?redirect=/w/{slug}`; loads `GET /workspaces/by-slug/{slug}`; 404 → in-shell not-found state "This workspace isn't available to you" with a link to `/workspace` and a `refreshSession()` call; stores last slug.
  - `/w/[slug]` home: header with workspace name (PageTitle eyebrow = role label), stat tiles (members, pending invites for owner/admin), "Projects" empty state card ("Your first project starts here — choose Scrum, Kanban or Waterfall.") and an "Invite teammates" `.sparkPrimary` link to `/w/{slug}/members` for owner/admin.
- `WorkspaceShell({ children, current, workspace? })`: workspace switcher listing `useAuth().workspaces` (links to `/w/{slug}`) plus "Create workspace" → `/onboarding`; nav (Home `/w/{slug}`, Members `/w/{slug}/members`, Schedule, Notifications, Billing as today); remove hardcoded unread `3`; existing pages using the shell (`/schedule`, `/notifications`, `/billing`) keep working.
- [ ] **Step 1: Failing tests:** api client (ETag returned; `If-Match`/`Idempotency-Key` headers sent; 401 event; 412 → `ApiError` status 412); onboarding (slug derived from "Northstar Labs!" → `northstar-labs`; submit posts `{name, slug}`, then navigates to `/w/northstar-labs`; 409 shows inline message); `/workspace` resolver (no workspaces → `/onboarding`; remembered slug wins when still a member); guard (signed out redirect with `redirect` param; 404 shows not-found copy and calls `refreshSession`).
- [ ] **Step 2–4:** FAIL → implement → `pnpm test`, `typecheck`, `lint`, `build` pass.
- [ ] **Step 5: Commit** `feat(web): onboarding, workspace guard and live workspace shell`.

### Task 8: Members, invitations and accept page

**Files:**
- Create: `src/app/w/[slug]/members/page.tsx`, `src/app/w/[slug]/members/invite-dialog.tsx`, `src/app/invitations/accept/page.tsx`
- Modify: `src/app/globals.css`, `src/app/login/page.tsx` and `src/app/signup/page.tsx` only if needed to honor `redirect=/invitations/accept`
- Modify docs: `Documents/product/screen-flow.md` (Journey 3: `/signup` → `/onboarding` → `/w/[slug]` → `/w/[slug]/members`; invite journey via `/invitations/accept`)
- Test: `tests/workspace-members.test.tsx`, `tests/invitation-accept.test.tsx`

**Interfaces / behavior:**
- Members page: table (initials avatar, name, email when provided, role pill: owner = navy, admin = blue, member = neutral tag; joined date); owner sees a role `<select>` per row (PATCH; 409 `last_owner` → inline "A workspace needs at least one owner."); owner/admin see "Remove" (confirm dialog, DELETE); every member sees "Leave workspace" on their own row (after leaving → `refreshSession()` → `/workspace`). Pending invitations panel (owner/admin): email, role, expires in N days, Revoke.
- Invite dialog (owner/admin): email + role (admins see `member` only); on 201 shows a success state "Invitation sent to <email>. The link works once and expires in 7 days." Errors 409 map to inline messages. Pending invitations panel rows have "Resend" (202 → toast "New link sent; the previous link no longer works.") and "Revoke".
- Accept page: reads token from `location.hash` (`#token=`), immediately `history.replaceState` to strip it, keeps it in `sessionStorage["spark:invite-token"]`; `POST /invitations/preview` → card with workspace name, inviter, role, email hint; signed out → buttons "Sign in to accept" / "Create account" linking to `/login?redirect=/invitations/accept` and `/signup?redirect=/invitations/accept`; signed in → "Join <workspace>" → accept → clear storage → `refreshSession()` → `/w/{slug}`. States: expired/revoked/used/invalid → friendly explanation + link home; `recipient_mismatch` → "This invitation was sent to <hint>. Sign out and use that account." with Sign out button.
- [ ] **Step 1: Failing tests:** members (owner sees role select and invite button; member sees neither but sees Leave on own row; `last_owner` message; invite dialog shows the sent confirmation and never renders a token; resend calls the resend endpoint); accept (hash token moved to sessionStorage and stripped from URL; signed-out shows sign-in link with `redirect=/invitations/accept`; signed-in accept posts token and navigates to `/w/<slug>`; mismatch copy shows hint).
- [ ] **Step 2–4:** FAIL → implement → frontend `pnpm test`, `typecheck`, `lint`, `build` pass.
- [ ] **Step 5: End-to-end check** with the `run` skill on a local stack (backend `db:migrate`, both processes, frontend): start Mailpit + worker; sign up user A → onboarding → workspace home → invite B's email → open the email in Mailpit (http://localhost:8025) and screenshot it → follow its link in a private window → sign up B → accept → B lands in the workspace; A sees B in members and promotes/demotes; A cannot demote self as sole owner. Screenshots of onboarding, home, members, accept. Stop dev servers and leftover node processes afterwards. If the local DB/Redis is unavailable, record the limitation.
- [ ] **Step 6: Commit** `feat(web): members, invitations and accept flow` (docs in the same commit).
