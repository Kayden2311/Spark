# Phase 3 A2 — Sign in with Google and GitHub, link and unlink Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People can sign in or sign up with Google or GitHub, and connect or disconnect those providers from Account settings, without ever letting a provider take over someone else's Spark account.

**Architecture:** The private auth process runs the OAuth authorization-code flow with PKCE and a signed, single-use `state` kept in Redis. A small provider adapter per provider (Google via OpenID Connect discovery + userinfo, GitHub via `/user` and `/user/emails`) returns a normalized profile. SECURITY DEFINER `spark.auth_oauth_*` functions decide sign-in, account creation and linking against `auth_identities`. A local mock provider (dev and tests only) lets the whole flow run without real credentials.

**Tech Stack:** Fastify 5 (auth process), Node `fetch`, Redis (state), PostgreSQL 18, Vitest; Next.js 16.3 / React 19.

**Spec:** `Documents/product/user-stories.md` US-A2 (acceptance criteria are requirements: a verified provider email matching a Spark account signs into that account; with no match the account is created only after the user confirms the profile; a failed flow gives a safe error and leaves the user signed out). User decisions (2026-11-19): **both Google and GitHub**; **link/unlink** in Account settings; **email verification is required before using the app** (A1). Build on A1 (`Documents/plans/2026-11-19-phase3-a1-account-security.md`), which must be merged first.

## How to run this plan in a new session

- Read first: `AGENTS.md`, this plan, the A1 plan, US-A2, `rest-clean-compliance.md`, `database-schema.md` (auth sections, A1's migration), `independent-review.md`; `src/auth-server.ts`, `src/app.ts` (`buildAuthApp`), `src/routes/auth-credentials.ts`, `src/routes/account-credentials.ts` (A1), `src/routes/auth-proxy.ts`, `src/config.ts`, `src/routes/responses.ts` (`setSessionCookie`), `frontend/src/app/login/page.tsx` (existing GitHub/Google buttons), `frontend/src/app/safe-redirect.ts`.
- **Base branch:** `main` after A1 is merged; branch `feat/oauth-a2`; next free migration number. Do not push or merge without the user. **Commits carry no `Co-Authored-By` or other trailer.**
- Execute with superpowers:subagent-driven-development. **Tasks 1, 2 and 3 need two independent first-pass reviewers — correctness and security — in parallel** (account takeover is the main risk). Task 4 one reviewer. Final whole-branch review on the most capable model, one fix wave.
- Real providers need the user's credentials (free): Google Cloud Console → OAuth client (Web), redirect URI `http://localhost:4000/api/v1/auth/oauth/google/callback`; GitHub → Settings → Developer settings → OAuth Apps, callback `http://localhost:4000/api/v1/auth/oauth/github/callback`. Put `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` in `Spark_Core/.env` (never commit). **Without them, use the mock provider** (`OAUTH_MOCK=1`, non-production only) for development and E2E, and list "real-provider sign-in not verified" as a limitation.
- Same environment notes and per-dispatch lessons as the A1 plan (Docker/Mailpit, ports, stray files, `next-env.d.ts`, `playwright-core` outside the repo, `propertyNames` body schemas, flaky schedule-dialog test).

## Global Constraints

- English only. OAuth runs **only in the auth process** (`spark_auth` role); the API proxies `/api/v1/auth/oauth/*` like other auth routes, passing redirects and `Set-Cookie` through unchanged.
- Flow: authorization code + **PKCE (S256)** for both providers; `state` = 32 random bytes hex, stored in Redis for **10 minutes** with `{ provider, codeVerifier, intent: "signin"|"link", returnTo, linkSessionHash? }`, deleted on first use (single-use), and bound to the browser by an `HttpOnly`, `SameSite=Lax`, `Secure` (production) cookie `spark_oauth` holding the state's SHA-256; a callback whose state is missing, reused, expired, or whose cookie does not match fails safely. `returnTo` must pass `safeRedirect` rules (same-origin path), default `/workspace`.
- Scopes: Google `openid email profile`; GitHub `read:user user:email`. Profile normalization: `{ provider: "google"|"github", issuer, subject, email: string|null, emailVerified: boolean, displayName, avatarUrl }`. Google: issuer `https://accounts.google.com`, `email_verified` from userinfo. GitHub: issuer `https://github.com`, subject = numeric user id as text, email = the **primary verified** email from `/user/emails` (verified true), else null/false.
- **Account matching (takeover-safe):**
  1. Existing `auth_identities (provider, issuer, subject)` → sign into its user (if the user is active).
  2. Else if the provider email is verified **and** equals a Spark primary email that is **verified** → link the identity to that user and sign in.
  3. Else if the provider email equals a Spark email that is **not** verified → do **not** link; fail with `link_from_settings` ("An account with this email exists. Sign in with your password, then connect <Provider> in Account settings.").
  4. Else → no account: keep the profile in Redis (10 min, key = new random token in an `HttpOnly` cookie `spark_oauth_signup`) and redirect to `/signup/oauth` to **confirm** the display name; on confirm create the user (primary email = provider email, `verified_at = now()` only if the provider email is verified; otherwise the A1 verification gate applies) + identity + session.
- **Linking** (intent `link`, started from Account settings with a live session): the identity must not belong to another user (`identity_in_use`); a user has at most one identity per provider (`provider_already_linked`). **Unlinking** is refused when it would leave no sign-in method (no password and no other identity) → `last_sign_in_method`.
- Sessions created by OAuth use `auth_method = 'oauth'` and `authenticated_identity_id` (existing CHECK `sessions_identity_method`), with the user agent stored (A1).
- Errors never reveal whether an email has an account beyond rule 3's message on the user's own provider email; all failures redirect to `/login?oauth_error=<code>` with codes `cancelled | state_invalid | provider_error | email_unverified | link_from_settings | account_suspended | identity_in_use`, shown as friendly copy.
- Provider HTTP calls: 5 s timeout each; no provider tokens are stored (access tokens are discarded after fetching the profile).
- Rate limits: OAuth start 20/10 min per IP; callback 30/10 min per IP; signup confirm 10/10 min per IP.

## Review Focus

1. Someone signs up on Spark with victim@example.com but never verifies; the real owner later clicks "Continue with Google" with that verified address → Spark must not link Google to the unverified account (rule 3) → DB test Task 1, route test Task 2.
2. A callback replayed (same `state` twice) or opened in a different browser → safe failure, user stays signed out → route test Task 2.
3. GitHub account whose primary email is private/unverified → user can still sign up, but must verify their email (A1 gate) before using Spark → route test Task 2, E2E Task 4.
4. The user cancels on the provider's consent screen (`error=access_denied`) → back on `/login` with "Sign-in was cancelled", no account created → route test Task 2, FE test Task 4.
5. Unlinking GitHub when it is the only way to sign in → refused with a clear message suggesting setting a password first → DB test Task 1, FE test Task 4.

---

### Task 1: OAuth identity functions (migration A2-a)

**Files:** migration `00NN_oauth_identities.sql` (+ journal), `schema.ts`, `tests/database/schema.integration.ts`, `database-schema.md`

**Interfaces (SQL, granted only to `spark_auth`):**
- `spark.auth_oauth_sign_in(p_provider text, p_issuer text, p_subject text, p_email text, p_email_verified boolean, p_display_name text, p_avatar_url text, p_token_hash bytea, p_expires_at timestamptz, p_user_agent text) RETURNS TABLE(outcome text, <principal columns>)` — implements matching rules 1–3: `signed_in | linked_and_signed_in | needs_signup | link_from_settings | account_suspended`; on success inserts the session (`auth_method 'oauth'`, `authenticated_identity_id`) and updates `auth_identities.last_login_at`, `provider_email`, `provider_email_verified`.
- `spark.auth_oauth_create_account(p_provider, p_issuer, p_subject, p_email, p_email_verified, p_display_name, p_avatar_url, p_token_hash, p_expires_at, p_user_agent) RETURNS TABLE(outcome text, <principal columns>)` — `created | identity_in_use | email_in_use` (re-checks rules 1–3 under lock to avoid races); creates user, primary email (verified per rule 4), identity, session; no password credential.
- `spark.auth_oauth_link(p_session_hash bytea, p_provider, p_issuer, p_subject, p_email, p_email_verified) RETURNS text` — `linked | already_linked | identity_in_use | provider_already_linked | no_session`.
- `spark.auth_oauth_unlink(p_session_hash bytea, p_provider text) RETURNS text` — `unlinked | not_linked | last_sign_in_method | no_session`.
- `spark.auth_list_identities(p_session_hash bytea) RETURNS TABLE(provider text, provider_email text, linked_at timestamptz, last_login_at timestamptz)` and `spark.auth_has_password(p_session_hash bytea) RETURNS boolean`.
- Constraints: UNIQUE `(user_id, provider)` on `auth_identities` (one per provider per user); CHECK `provider IN ('google','github','mock')`.
- [ ] **Step 1: Failing DB tests:** each matching rule including the takeover case (unverified Spark email + verified Google email → `link_from_settings`, no identity row); repeated sign-in by subject; suspended user → `account_suspended`; concurrent `create_account` for the same subject → one user; link/unlink rules incl. `last_sign_in_method`; sessions created with `auth_method 'oauth'`; `spark_app`/`spark_worker` cannot execute any `auth_oauth_*`.
- [ ] **Step 2–4:** FAIL → implement → `pnpm test:database`, `pnpm test`, `pnpm typecheck`, `pnpm lint` pass.
- [ ] **Step 5: Commit** `feat(db): OAuth identities, sign-in and linking`.
- [ ] **Review gate:** correctness + security reviewers in parallel.

### Task 2: OAuth flow in the auth process

**Files:** `src/modules/oauth/{providers.ts, google.ts, github.ts, mock.ts, state.ts, pkce.ts}`, `src/routes/oauth.ts` (registered in `buildAuthApp`), `src/routes/auth-proxy.ts`, `src/config.ts` (`loadAuthConfig`: provider credentials optional, `OAUTH_MOCK` only when `NODE_ENV !== "production"`, `APP_BASE_URL`, `API_BASE_URL` for redirect URIs)
- Tests: `tests/oauth-providers.test.ts` (fetch injected), `tests/oauth-routes.test.ts`

**Interfaces:**
- `interface OAuthProvider { id: "google"|"github"|"mock"; authorizeUrl(params: { state: string; codeChallenge: string; redirectUri: string }): string; fetchProfile(params: { code: string; codeVerifier: string; redirectUri: string }): Promise<NormalizedProfile> }`.
- `GET /api/v1/auth/oauth/providers` → `{ items: [{ id, name, enabled }] }` (enabled when credentials or mock are configured).
- `GET /api/v1/auth/oauth/{provider}/start?intent=signin|link&returnTo=` → 302 to the provider; 404 for a disabled provider; `intent=link` requires a session (else 401).
- `GET /api/v1/auth/oauth/{provider}/callback?code&state` (or `error`) → 302: success → `returnTo` with the session cookie set; `needs_signup` → `/signup/oauth`; link success → `/settings/account?connected=<provider>`; failure → `/login?oauth_error=<code>` (link failures → `/settings/account?oauth_error=<code>`).
- `GET /api/v1/auth/oauth/signup` (signup cookie) → `{ provider, email, emailVerified, displayName, avatarUrl }`; `POST /api/v1/auth/oauth/signup` body `{ displayName }` → 201 principal + session cookie (then the frontend routes verified users to `/workspace`, unverified to `/verify-email`).
- `GET /api/v1/auth/identities` → `{ hasPassword, items: [{ provider, email, linkedAt, lastLoginAt }] }`; `DELETE /api/v1/auth/identities/{provider}` → 204; 409 `last_sign_in_method`.
- Mock provider (non-production only): `GET /api/v1/auth/oauth/mock/authorize` renders a tiny HTML form (subject, email, verified checkbox, name) that redirects back with a code; code exchange is in-memory.
- [ ] **Step 1: Failing tests:** PKCE challenge derivation; state single-use and cookie binding; provider profile normalization for Google (verified flag) and GitHub (primary verified email selection, private email → null); callback outcome → redirect mapping for every outcome and `error=access_denied`; `returnTo` rejects off-site URLs; signup confirm creates the session; link requires a session; unlink `last_sign_in_method` → 409; provider fetch timeouts → `provider_error`; the API proxy passes 302 and `Set-Cookie` through.
- [ ] **Step 2–4:** FAIL → implement → `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` pass.
- [ ] **Step 5: Commit** `feat(auth): Google and GitHub sign-in with PKCE`.
- [ ] **Review gate:** correctness + security reviewers in parallel.

### Task 3: Hardening pass

**Files:** as needed in `src/routes/oauth.ts`, `src/modules/oauth/*`, tests.
- Verify and test: no provider access token or code is logged (inspect logger calls); every error path deletes the state and clears `spark_oauth`; redirect URIs are built from config only; the mock provider is unreachable when `NODE_ENV=production` (route not registered; config refuses `OAUTH_MOCK`); response headers `Cache-Control: no-store` on start/callback; rate limits applied.
- [ ] Tests for each item → FAIL → fix → pass → commit `fix(auth): OAuth hardening`.
- [ ] **Review gate:** correctness + security reviewers in parallel.

### Task 4: Frontend, docs and E2E

**Files:**
- Modify: `src/app/login/page.tsx` and `src/app/signup/page.tsx` (buttons call `/api/v1/auth/oauth/<provider>/start?intent=signin&returnTo=<safe redirect>`; hidden when the provider is disabled; `oauth_error` codes → friendly messages), `src/app/settings/account/page.tsx` (Connected accounts card: Google and GitHub rows with Connect / Disconnect, provider email, last used; `last_sign_in_method` → "Set a password first, then disconnect.")
- Create: `src/app/signup/oauth/page.tsx` (confirm profile: avatar, provider email with verified badge, editable display name, "Create account"; expired signup cookie → back to `/signup` with a message)
- Docs: `user-stories.md` (US-A2 Implemented; new US-A9 Connect and disconnect providers), `screen-flow.md`, `context.md`, `database-schema.md`, `deployment/hosting-checklist.md` (provider apps, redirect URIs per environment, secrets in the auth process only, `OAUTH_MOCK` must be unset)
- Tests: `tests/login-oauth.test.tsx`, `tests/oauth-signup.test.tsx`, `tests/account-connected.test.tsx`
- [ ] **Step 1: Failing tests:** buttons hidden when disabled and link to the start URL with a safe `returnTo`; each `oauth_error` shows its copy; confirm page submits the display name and routes verified → `/workspace`, unverified → `/verify-email`; connected accounts card connects/disconnects and shows the last-method message.
- [ ] **Step 2–4:** FAIL → implement → frontend and backend suites, typecheck, lint, build pass.
- [ ] **Step 5: End-to-end** with the mock provider (and real Google/GitHub only if the user has put credentials in `.env`): new user via mock with verified email → confirm → onboarding; mock with unverified email → confirm → `/verify-email`; existing verified password user signs in via mock with the same email → linked; takeover case → `link_from_settings` message; connect GitHub-mock from settings, disconnect blocked as last method for an OAuth-only account until a password is set; replayed callback URL fails safely. Screenshots of login buttons, confirm page, connected accounts (desktop 1440, mobile 390). Stop all processes; ports free; `next-env.d.ts` restored.
- [ ] **Step 6: Commit** `feat(web): Google and GitHub sign-in and connected accounts` (docs in the same commit).
