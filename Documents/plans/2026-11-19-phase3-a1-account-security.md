# Phase 3 A1 — Email verification, password reset, change password and sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every new account proves its email before it can use Spark; anyone can reset a forgotten password from an emailed link; signed-in users can change their password and see and sign out their sessions.

**Architecture:** One migration adds account-email delivery (account tokens are created with an unusable placeholder hash and the email worker issues the real token at send time, exactly like M1 invitations), makes `spark.session_actor()` return NULL for users whose primary email is unverified (a database-level gate behind the API's 403), grandfathers existing accounts, and adds `spark.auth_*` functions owned by the private auth process. New credential routes live in the auth process and are reached through the existing API proxy. The frontend adds verify-email, reset-password and an Account settings area.

**Tech Stack:** PostgreSQL 18 (hand-written SQL migrations), Fastify 5 (API + private auth process), Argon2id (`src/infrastructure/database/password.ts`), nodemailer worker, Vitest; Next.js 16.3 / React 19, plain CSS, Vitest + Testing Library.

**Spec:** `Documents/product/user-stories.md` US-A5 (password reset) and the A4 note on verification. User decisions (2026-11-19): **email verification is required before using the app**; Phase 3 also includes **change password, session management, and linking/unlinking Google/GitHub** (linking is in A2). Rules: `Documents/context.md`, `rest-clean-compliance.md`, `database-schema.md` (0006–0008 auth model, 0016 worker), `independent-review.md`.

## How to run this plan in a new session

- Read first: `AGENTS.md`, this plan, US-A4/US-A5, `rest-clean-compliance.md`, `database-schema.md`, `independent-review.md`; migrations `0006`/`0007`/`0008` (auth functions and the `spark_auth` login role), `0014` (`auth_register_password` without workspace), `0015`/`0016` (invitation acceptance and token issuing by the worker), `0021`/`0029` (worker email functions); `src/auth-server.ts`, `src/app.ts` (`buildAuthApp`), `src/routes/auth-credentials.ts`, `src/routes/auth-proxy.ts`, `src/routes/auth.ts`, `src/modules/outbox/*`, `src/modules/email/*`.
- **Base branch:** `main` **after Phase 2 C2 is merged** (C2 is on `claude/community-posts-c2` and ends at migration `0037`). If C2 is not on `main` yet, ask the user whether to wait or to base A1 on the C2 branch. A1 takes the next free migration numbers (expected **0038**); keep the journal sequential. Branch name `feat/account-security-a1`. Do not push or merge without the user. **Commits carry no `Co-Authored-By` or other trailer.**
- Execute with superpowers:subagent-driven-development; ledger in `.superpowers/sdd/<plan>/progress.md`. **Tasks 1 and 2 need two independent first-pass reviewers — correctness and security — in parallel** (auth and credentials). Task 3 one reviewer with a security lens; Task 4 one reviewer. Final whole-branch review on the most capable model, one fix wave.
- Local environment: PostgreSQL 18 on 127.0.0.1:5432 with all roles; Docker Desktop (`C:\Users\Admin\AppData\Local\Programs\DockerDesktop\Docker Desktop.exe`) then `pnpm infra:up` in `Spark_Core` (Redis + Mailpit at http://localhost:8025); `pnpm db:migrate`, `pnpm db:seed` in `Spark_Core/backend`; `pnpm dev` runs API, auth, worker and frontend. Ports: frontend 3000, API 4000, auth 4100.
- Lessons for every dispatch: LF line endings; never `git add` `.superpowers`; never `git stash`; after shell work run `git status` and delete stray empty files at the repo root (names like `[{`, `(url.pathname`, `now()`), never commit them; stop only the processes you start and verify ports are free; restore `frontend/next-env.d.ts` if `next dev`/`build` rewrote it; `playwright-core` only in a scratch directory outside the repo (Chrome at `C:/Program Files/Google/Chrome/Application/chrome.exe`, `MSYS_NO_PATHCONV=1` in Git Bash); Fastify strips unknown body keys unless the schema rejects them (copy the `propertyNames` pattern from `src/routes/workspace/projects.ts`); global limiter 120 req/min per IP — pace E2E; known flaky: `tests/schedule-event-dialog.test.tsx` can exceed 5 s under load — re-run alone before calling it a regression.

## Global Constraints

- English only in code, copy, docs, commits.
- Credential operations run **only in the auth process** with the `spark_auth` role; the API never gains execute rights on `auth_*` credential functions (the existing `assertRuntimeRole` / allowlist tests must keep proving it). The API proxies new credential routes exactly as it proxies sign-in/sign-up today.
- Tokens: 32 random bytes, 64 lowercase hex in transit, SHA-256 stored (`hashSessionToken`). **Raw tokens exist only in worker memory and the email link fragment** (`/verify-email#token=…`, `/reset-password#token=…`) — never in the database, outbox, logs, API responses or query strings. Account tokens are created with an unusable placeholder hash; the worker issues the real one when it sends. Verify-email tokens expire after **24 hours**, reset tokens after **1 hour**; both single-use (`consumed_at`); issuing a new token of the same purpose for the same user invalidates (consumes) older unconsumed ones.
- No account enumeration: request-reset and resend-verification always answer `202` with the same body and similar timing whether or not the email exists or is verified.
- Rate limits (Redis, existing limiter): forgot-password 5/hour per IP **and** 3/hour per normalized email (email key hashed in the limiter key); resend verification 3/hour per user; verify and reset submissions 10/10 min per IP; change password 5/10 min per user.
- Passwords: same policy as sign-up (`src/routes/auth-credentials.ts`); Argon2id via `hashPassword`/`verifyPassword`.
- **Verification gate:** `spark.session_actor()` returns NULL unless the user's primary `user_emails.verified_at` is set, so every RLS read and `ws_*` write fails closed for unverified users. `GET /api/v1/me` still works (it uses `auth_session_principal`) and returns `emailVerified`. API guards answer **403 `email_unverified`** (before any other check) instead of the generic 401/404 when the principal is unverified. Platform staff routes follow the same rule.
- **Grandfathering:** the migration marks every existing primary email verified (`verified_at = COALESCE(verified_at, created_at)`), so no current account is locked out; `scripts/seed-users.ts` and `seed-demo.ts` create verified emails.
- **Invitation proof:** accepting an emailed workspace invitation whose address equals the user's primary email marks that email verified (the token proved inbox access), so an invited person does not verify twice.
- Changing or resetting a password revokes every **other** session (reset revokes **all**, then signs nobody in); revoked sessions fail on the next request.
- Problem+json errors; `Cache-Control: private, no-store` on all auth responses; origin guard on non-GET.

## Review Focus

1. Someone types an email that has no account on Forgot password → same "check your inbox" screen and same status/body as a real account; no email is sent → route test in Task 3, DB test in Task 1.
2. A reset link opened twice, or after a newer link was requested → second use / old link shows "This link has expired or was already used" and the password is unchanged → DB test in Task 1, FE test in Task 4.
3. A new user signs up, closes the tab, comes back later signed in → they land on "Verify your email" (with Resend), never on a broken workspace page or a raw 403 → FE test in Task 4.
4. A user resets their password while signed in on another device → that device is signed out on its next request → DB test in Task 1, E2E in Task 4.
5. An invited person signs up from the invitation email and accepts → they reach the workspace without a second verification email → DB test in Task 2, E2E in Task 4.

---

### Task 1: Account tokens, verification gate and credential functions (migration A1-a)

**Files:**
- Create: `Spark_Core/backend/drizzle/00NN_account_security.sql` (NN = next free number, expected 38) + journal entry
- Modify: `src/infrastructure/database/schema.ts`, `scripts/seed-users.ts`, `scripts/seed-demo.ts`, `tests/database/schema.integration.ts`, `Documents/architecture/database-schema.md`

**Interfaces (SQL; `auth_*` granted only to `spark_auth`, `worker_*` only to `spark_worker`):**
- `account_tokens` add `delivery_status text NOT NULL DEFAULT 'pending'` CHECK IN (`pending`,`sent`,`failed`,`skipped`), `delivery_attempts integer NOT NULL DEFAULT 0`, `available_at timestamptz NOT NULL DEFAULT now()`, `locked_until timestamptz`, `lock_token uuid`, `last_error_code text`; index for pending delivery.
- `sessions` add `user_agent text` (≤ 200 chars, NULL allowed).
- Grandfathering UPDATE per Global Constraints.
- `spark.session_actor()` `CREATE OR REPLACE` (same signature): also requires an `is_primary` `user_emails` row with `verified_at IS NOT NULL`.
- `spark.auth_session_principal` returns an added `email_verified boolean` column (DROP + CREATE with the same name; re-grant to `spark_app` and `spark_auth` as today; update `src/infrastructure/database/session.ts` `SessionPrincipal.emailVerified`).
- `spark.auth_register_password(...)` (same signature) additionally inserts a `verify_email` account token (placeholder hash, 24 h) for the new primary email.
- `spark.auth_request_email_verification(p_session_hash bytea) RETURNS text` — `queued | already_verified | no_session`; consumes older unconsumed verify tokens and queues a new one.
- `spark.auth_verify_email(p_token_hash bytea) RETURNS TABLE(outcome text, user_id uuid)` — `verified | already_verified | invalid_token | expired_token`; locks the token `FOR UPDATE`, sets `user_emails.verified_at`, consumes the token.
- `spark.auth_request_password_reset(p_email text) RETURNS void` — silently does nothing for unknown emails or accounts without a password credential (OAuth-only accounts get a reset that **sets** a password — allowed); otherwise consumes older reset tokens and queues a new one.
- `spark.auth_reset_password(p_token_hash bytea, p_password_hash text) RETURNS text` — `reset | invalid_token | expired_token`; upserts `password_credentials`, sets `password_changed_at`, revokes **all** the user's sessions, consumes the token, marks the primary email verified (the reset link proved inbox access).
- `spark.auth_password_for_change(p_session_hash bytea) RETURNS TABLE(user_id uuid, password_hash text)` and `spark.auth_change_password(p_session_hash bytea, p_password_hash text) RETURNS text` — `changed | no_session`; revokes all **other** sessions.
- `spark.auth_list_sessions(p_session_hash bytea) RETURNS TABLE(id uuid, created_at, last_seen_at, expires_at, auth_method, user_agent, current boolean)` (active sessions of the caller only); `spark.auth_revoke_session_by_id(p_session_hash bytea, p_session uuid) RETURNS text` — `revoked | not_found` (own sessions only; revoking the current one is allowed); `spark.auth_revoke_other_sessions(p_session_hash bytea) RETURNS integer`.
- `spark.auth_start_session` gains `p_user_agent text` (DROP + CREATE; keep its rules).
- Worker: `spark.worker_claim_account_emails(p_lock_token uuid, p_limit int, p_lease_seconds int) RETURNS TABLE(id uuid, purpose text, email text, display_name text, expires_at timestamptz, attempts int)` (pending, available, unexpired, `FOR UPDATE SKIP LOCKED`, increments attempts; expired-before-send rows → `skipped`); `spark.worker_issue_account_token(p_id uuid, p_lock_token uuid, p_token_hash bytea) RETURNS boolean` (only while leased, pending and unexpired); `spark.worker_settle_account_email(p_id uuid, p_lock_token uuid, p_status text, p_error_code text, p_retry_at timestamptz) RETURNS boolean` (`sent` | retry with backoff | `failed` after 5 attempts).
- 22023 whitelist additions for the auth guard: `Invalid token`, `Invalid password`.

- [ ] **Step 1: Failing DB tests:** grandfathered accounts can still read their workspaces; a new registration cannot (session_actor NULL) until `auth_verify_email`; verify token single-use and 24 h expiry; second verification request consumes the first token; reset for an unknown email leaves no rows; reset revokes all sessions, changes the hash, verifies the email, and a second use returns `invalid_token`; change password revokes other sessions but not the current one; list/revoke sessions cannot see or revoke another user's sessions; worker claim leases are disjoint across two connections, the issued hash replaces the placeholder, settle retries then fails at 5; `spark_app` cannot execute any new `auth_*` or `worker_*` function; `spark_worker` can execute only `worker_*`; allowlist tests updated.
- [ ] **Step 2: Run** `pnpm test:database` → FAIL. **Step 3: Implement** migration, `schema.ts`, `session.ts`, seeds. **Step 4: Run** `pnpm test:database`, `pnpm test`, `pnpm typecheck`, `pnpm lint`; `pnpm db:migrate` locally → pass.
- [ ] **Step 5: Commit** `feat(db): email verification gate and account credential functions`.
- [ ] **Review gate:** correctness + security reviewers in parallel.

### Task 2: Invitation proof and the worker's account emails

**Files:**
- Create: migration `00NN+1_invitation_email_proof.sql` (+ journal); `src/modules/email/templates/verify-email.ts`, `templates/password-reset.ts`, `src/modules/outbox/account-emails.ts`
- Modify: `src/worker.ts` (poll account emails alongside the outbox and scheduled jobs), `tests/database/schema.integration.ts`
- Test: `tests/account-emails.test.ts`, `tests/email-templates.test.ts`

**Interfaces:**
- `spark.auth_verify_email_by_invitation(p_session_hash bytea, p_invitation_token_hash bytea) RETURNS text` (granted to `spark_auth`) — `verified | already_verified | mismatch | invalid_invitation`: the invitation is `pending`, unexpired, and its `email_normalized` equals the caller's primary normalized email → mark verified. Does **not** accept the invitation (the frontend then calls the existing accept route).
- `verifyEmailEmail({ displayName, verifyUrl, expiresAt })` → subject `"Confirm your email for Spark"`; `passwordResetEmail({ displayName, resetUrl, expiresAt })` → subject `"Reset your Spark password"`, with the line "If you didn't ask for this, you can ignore this email — your password stays the same." Neither has the notification-settings footer link. Links use `APP_BASE_URL` + fragment.
- `runAccountEmailsOnce(deps) → { claimed, sent, failed, leaseLost }` — mirrors the M1 dispatcher's lease budget rules (never issue a token with < 60 s of lease left; read the boolean from issue/settle).
- [ ] **Step 1: Failing tests:** templates escape names and include the fragment link in HTML and text; dispatcher sends one email per claimed row, issues the SHA-256 of the emailed token, retries with `smtp_error`, skips issuing when the lease budget is low; DB: invitation proof verifies only on exact email match and only for pending unexpired invitations.
- [ ] **Step 2–4:** FAIL → implement → backend `pnpm test`, `pnpm test:database`, `pnpm typecheck`, `pnpm lint`, `pnpm build` pass. Manual: worker + Mailpit deliver a verification email for a new sign-up.
- [ ] **Step 5: Commit** `feat(worker): verification and password reset emails`.
- [ ] **Review gate:** correctness + security reviewers in parallel.

### Task 3: Auth routes and the API gate

**Files:**
- Create: `src/routes/account-credentials.ts` (registered in `buildAuthApp`), `src/routes/account.ts` (session-only reads in the API, if any)
- Modify: `src/routes/auth-proxy.ts` (proxy the new auth routes), `src/routes/auth-credentials.ts` (store user agent at sign-in/sign-up), `src/routes/auth.ts` (`/me` returns `user.emailVerified`), `src/routes/workspace/guard.ts`, `src/routes/admin/guard.ts`, community route guards (403 `email_unverified` first)
- Test: `tests/account-credentials.test.ts`, `tests/auth-proxy.test.ts`, guard tests

**Interfaces (base `/api/v1`, all via the auth process except `/me`):**
- `POST /auth/email-verification` (session) → 202 `{ status: "queued" }` (also when already verified → 200 `{ status: "verified" }`).
- `POST /auth/email-verification/confirm` body `{ token }` (64 hex) → 200 `{ status: "verified" }`; 410 `token_expired`; 400 `invalid_token` (one code for unknown/used).
- `POST /auth/email-verification/invitation` body `{ token }` (invitation token, session) → 200 `{ status: "verified" }`; 409 `email_mismatch`; 404 `invalid_invitation`.
- `POST /auth/password/forgot` body `{ email }` → always 202 `{ status: "sent_if_exists" }`.
- `POST /auth/password/reset` body `{ token, password }` → 200 `{ status: "reset" }` (no session is created; the user signs in); 410 / 400 as above; 400 `weak_password`.
- `POST /auth/password/change` (session) body `{ currentPassword?, newPassword }` → 200 `{ status: "changed", otherSessionsRevoked: n }`; `currentPassword` required when a password exists (403 `wrong_password`), omitted when setting a first password for an OAuth-only account.
- `GET /auth/sessions` (session) → `{ items: [{ id, createdAt, lastSeenAt, expiresAt, method: "password"|"oauth", device: string|null, current }] }` (`device` = a short label parsed from the user agent, e.g. "Chrome on Windows").
- `DELETE /auth/sessions/{id}` → 204 (revoking the current session also clears the cookie); `POST /auth/sessions/revoke-others` → 200 `{ revoked: n }`.
- Gate: member, community and staff guards check `principal.emailVerified` right after authentication → 403 `email_unverified` with detail "Confirm your email address to continue."
- [ ] **Step 1: Failing tests:** forgot returns identical 202 bodies for known/unknown emails and calls SQL once either way; confirm/reset map every outcome; change password requires the current password; sessions list/revoke; `/me` exposes `emailVerified`; an unverified principal gets 403 `email_unverified` on a workspace route, a community write and an admin route; the API process cannot call any new `auth_*` function directly (proxy only); rate-limit configs present on each route; cross-origin POST → 403.
- [ ] **Step 2–4:** FAIL → implement → `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` pass. Live smoke: sign up → verify via Mailpit link → workspace route works; forgot/reset round trip; change password signs out a second cookie jar.
- [ ] **Step 5: Commit** `feat(api): email verification, password reset and session management`.

### Task 4: Frontend — verify, reset, account settings, docs and E2E

**Files:**
- Create: `src/app/verify-email/page.tsx` ("Check your inbox" + Resend + "Wrong email? Sign out"; reads `#token=` → confirm → success → continue), `src/app/reset-password/page.tsx` (reads `#token=`, strips it with `history.replaceState`, new password + confirm with the sign-up strength rules), `src/app/settings/account/page.tsx` (Password card: change or set; Sessions card: list with device, last active, "This device" tag, Sign out per row, "Sign out all other devices"; placeholder Connected accounts card filled by A2)
- Modify: `src/app/forgot-password/page.tsx` (real request; always shows "If an account exists for that email, we sent a reset link."), `src/app/auth-context.tsx` (`user.emailVerified`), the app shells/guards (`/w/[slug]` layout, `/workspace`, `/onboarding`, community actions, `/admin` layout) redirect unverified users to `/verify-email`, `src/app/invitations/accept/page.tsx` (when the signed-in user is unverified and the invitation email matches, call the invitation-proof route first), `src/app/signup/page.tsx` (after sign-up go to `/verify-email`), settings navigation (link "Account")
- Modify docs: `user-stories.md` (US-A5 Implemented; new stories US-A6 Verify email, US-A7 Change password, US-A8 Manage sessions with acceptance criteria from this plan), `screen-flow.md`, `context.md`, `database-schema.md`, `deployment/hosting-checklist.md` (worker sends account emails; SMTP must be configured before launch or sign-ups cannot verify)
- Test: `tests/verify-email.test.tsx`, `tests/reset-password.test.tsx`, `tests/forgot-password.test.tsx` (update), `tests/account-settings.test.tsx`, guard tests

**Behavior / visual:** landing-page language for the signed-out pages (same card style as `/login`); member-app styles (the restyled `ws*`/admin-grade components on `main`) for Account settings. Tokens are never shown or logged; error states: expired → "This link has expired. Request a new one." with the right button; used/unknown → "This link was already used or isn't valid."
- [ ] **Step 1: Failing tests:** sign-up navigates to `/verify-email`; unverified user on `/w/x` is redirected to `/verify-email`; confirm with fragment token strips it and shows success; resend shows a cooldown message on 429; forgot shows the same message for any email; reset success sends to `/login` with "Password updated — sign in with your new password."; change password requires the current one and shows how many devices were signed out; sessions list marks the current device and revokes another; invitation accept for an unverified matching user verifies then accepts without visiting `/verify-email`.
- [ ] **Step 2–4:** FAIL → implement → frontend `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` pass; backend `pnpm test` still passes.
- [ ] **Step 5: End-to-end** on the local stack (API, auth, worker, frontend, Mailpit) with headless Chrome: new sign-up → blocked → verify via Mailpit → onboarding; forgot password for a real and a fake email (same screen; only one email in Mailpit) → reset → old password fails, new works, a second browser context is signed out; change password; sessions page revokes another context; invitation sign-up path needs no extra verification. Desktop 1440 and mobile 390 screenshots of verify, forgot, reset, account settings. Stop all processes; ports free; `next-env.d.ts` restored.
- [ ] **Step 6: Commit** `feat(web): email verification, password reset and account settings` (docs in the same commit).
