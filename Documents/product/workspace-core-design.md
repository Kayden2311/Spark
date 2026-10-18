# Workspace core design (Phase 1): methodology-driven projects, tasks, insights

## Context

Spark's admin console is built and wired (Epics G2–I), but every member-facing feature beyond sign-in/sign-up is a mockup. The user's view of the product heart: after signing up, a team creates a workspace and a project, **chooses a project-management methodology — Scrum (Agile), Kanban or Waterfall** — and Spark suggests the matching way of working (board columns, planning objects, practices). They then track **task completion toward the plan** and **completion by member**, with methodology-specific stats. Teams evolve from idea to delivery, so **the methodology can be switched later**.

Agreed scope & order (user): Phase 1 = workspace core (this plan). Phase 2 = communities/membership/posts/reports (US-B*, C*, D*, G1). Phase 3 = password reset, email verification, OAuth (US-A2, A5). **Email delivery and the outbox dispatcher moved into Phase 1** (user request, 2026-10-18). **Billing/tiers are out of scope** (later refactor) — `/billing` and `/pricing` stay as they are, no tier enforcement.

User decisions: email is part of Phase 1 — invitations, task-assigned, due-soon/overdue reminders and a weekly progress digest, each with per-type opt-out (invitations always send); provider-agnostic SMTP, Mailpit locally, free-tier provider (e.g. Resend/Brevo) chosen at deploy time; billing/subscription emails plug into the same system when billing is built; member stats visible to all workspace members; Kanban WIP limits block moves (existing DB rule); owners **and admins** can invite; methodology is switchable.

FE must match the landing-page concept (light calm "signal" look: `globals.css` tokens `--ink #17233d`, `--blue #2563eb`, navy `#09265a` sidebar, tight negative-tracked 650-weight headings, uppercase blue kickers with pulsing dot, pastel tags, initials avatars, `.sparkPrimary`/`.sparkSecondary`). BE follows `AGENTS.md`, `Documents/architecture/rest-clean-compliance.md`, `database-schema.md`, `Documents/automation/testing.md`, `independent-review.md`.

## Key findings that shape the design

1. `spark.auth_register_password` (`drizzle/0007_governance_corrections.sql:34`) auto-creates "`<name>`'s Space". → 0014 redefines it (same signature) to create **no** workspace; `src/routes/auth-credentials.ts` makes workspace fields nullable. Existing workspaces are left alone.
2. Tenant RLS (0002, `spark.is_workspace_member`) reads `spark.user_id`/`spark.tenant_id`, which the live path never sets — `withSessionContext` (`src/infrastructure/database/session.ts`) only sets `spark.session_token_hash`. → Add `spark.session_workspace_ids(roles)` (STABLE, SECURITY DEFINER, `search_path=''`, built on `spark.session_actor()`) and recreate workspace read policies as `tenant_id = ANY ((SELECT spark.session_workspace_ids()))`. Delete unused `withDatabaseContext` (`context.ts`).
3. Deferred trigger `check_issue_change_set` (0004) requires an `issue_events` + `outbox_events` row per issue version; `guard_issue` (0002) already enforces WIP (23514) and `completed_at`; `maintain_record` bumps `version`.
4. Schema already has `issues.version/story_points/start_date/due_date/completed_at/sprint_id`, `issue_statuses.wip_limit` + category, `sprints.goal`, `idempotency_requests`, `calendar_events`, `notifications`. Missing: methodology, project dates, phases/milestones/baselines, sprint commitments, `issues.started_at`.
5. Admin charts (`src/app/admin/_components/charts.tsx`, `_lib/palette.ts`) are tied to `adm*` CSS; recharts is already a dependency.

## Cross-cutting decisions

- **Writes**: SECURITY DEFINER `spark.ws_*` functions (`search_path=''`, revoked from PUBLIC, granted to `spark_app`), actor from `spark.session_actor()`, return `(outcome, resource_id, resource_version)` with a closed outcome set; non-members get `not_found`. Routes map outcomes via a table (as `statusOutcomes` in `src/routes/admin/users.ts`). Workspace-level `audit_events` row in the same transaction for membership/role/invite/methodology/baseline changes.
- **Reads**: SQL/Drizzle inside `withSessionContext`, RLS plus explicit tenant/project filters. `private, no-store`.
- **Concurrency**: ETag `"v{n}"`; `If-Match` required on PATCH (missing → **428**, stale → **412** with `current` body). Add 428 to `rest-clean-compliance.md`; US-E5 wording updated.
- **Idempotency**: `Idempotency-Key` on task creation via `idempotency_requests` (same key, different payload → 409); other creates use natural unique keys → 409.
- **Notifications**: projected in the same transaction from the outbox row (`spark.project_notifications(outbox_id)`, internal, marks `processed_at`) — no worker, consistent with context.md ("outbox only when a post-commit side effect exists"). Read-time filter: recipient = actor AND tenant in actor's current workspaces. Frontend polls.
- **Analytics computed on read** from `issue_events` (`changes` carries an allowlisted `after` snapshot: status, category, sprint, phase, assignee, points, archived); ranges bounded 7–180 days; new index `issue_events(tenant_id, project_id, created_at, issue_id)`. Snapshot table only if measured p95 demands it. Days bucketed in UTC (as admin).
- **Layout**: `src/routes/workspace/{guard,workspaces,invitations,projects,issues,planning,insights,schedule,notifications,index}.ts` → `registerWorkspaceRoutes(app,{pool})` in `buildApp` (`src/app.ts`). Pure rules in `src/modules/work/domain/{methodology,ranking,etag,metrics,slug}.ts`. Shared guard helpers (`idParams`, `pageQueryProperties`, `readCursor`, `expectOutcome`, DB error mapping, `KNOWN_INPUT_ERRORS`) move from `src/routes/admin/guard.ts` to `src/routes/session-guard.ts`; admin re-imports. `createMemberGuard(pool)` adds 23514 WIP → 409.
- **Rate limits**: issue PATCH 120/min, other mutations 30/min, invitations 20/10min, workspace create 5/h, unread-count 120/min.

## Email delivery

- **Transport**: SMTP through `nodemailer` (new backend dependency) behind a small `EmailSender` port with an SMTP adapter and an in-memory adapter for tests. Config: `SMTP_URL` (e.g. `smtp://127.0.0.1:1025`), `EMAIL_FROM` (`Spark <no-reply@spark.local>`), `APP_BASE_URL` (`http://localhost:3000`) for links. Local dev: **Mailpit** added to `Spark_Core/infra/compose.yaml` (SMTP 1025, web inbox 8025). Production provider is a deploy-time choice; no code change. In production the connection must be encrypted: `smtps://`, or `smtp://` with STARTTLS required (nodemailer `requireTLS`).
- **Worker process**: new entrypoint `src/worker.ts` (`pnpm dev:worker`, included in `pnpm dev`) — a third process next to the API and auth processes. It (1) drains `outbox_events` by leasing batches (`locked_until`/`lock_token`, `attempts`, exponential backoff, `last_error_code`, give up after 8 attempts; 5 events per 300 s lease, stopping early rather than outrunning the lease) and (2) runs scheduled jobs guarded by Postgres advisory locks so only one worker runs each job. It connects as a new least-privilege login role **`spark_worker`** (added to `infra/postgres/bootstrap-local.sql`) that can only execute `spark.worker_*` SECURITY DEFINER functions — the API role still cannot read outbox rows or email addresses.
- **Delivery records**: every email is a `notification_deliveries` row (channel `email`, status queued/sent/failed, provider message id) so retries are idempotent (one delivery per notification/recipient/channel).
- **Preferences**: `notification_preferences` per user × type: `task_assigned`, `due_reminders`, `weekly_digest` (default on). `invitation` and account/security mail always send. Every email to an account holder links to `/settings/notifications` in its footer; invitation emails omit the link (the recipient may have no account) and keep a neutral footer line. Preference changes require a signed-in session (no unauthenticated unsubscribe tokens in Phase 1).
- **Invitation tokens never sit in the database or outbox in raw form**: an invitation is created with an unusable random hash; when the worker sends the email it issues a fresh token, stores only its SHA-256 hash (`spark.worker_issue_invitation_token`) and puts the raw token only in the email link `/invitations/accept#token=…`. "Resend" rotates the token (old links stop working). The API never returns the token to the inviter.
- **Templates**: TypeScript functions returning `{ subject, html, text }`; table-based HTML with inline styles in the landing-page palette (navy header bar, `#2563eb` buttons, Spark mark), plain-text alternative always included; no user-supplied HTML (all values escaped).
- **Schedules** (in each recipient's `users.timezone`): due-soon/overdue reminder once daily at 08:00 local for open tasks assigned to them that are due within 24 h or overdue (one email listing all, at most one per day); weekly digest Monday 08:00 local per workspace (completion toward plan per project, completed by member, at-risk and overdue items).
- **Future**: billing/subscription emails (trial ending, receipt, plan change) and email verification/password reset reuse this sender, worker and template layout.

## Methodology templates (`src/modules/work/domain/methodology.ts`, served by `GET /api/v1/methodologies`)

| | Scrum (Agile) | Kanban | Waterfall |
|---|---|---|---|
| Statuses (category) | Backlog(backlog), To do, In progress, In review, Done | Backlog, Ready(WIP 8), In progress(WIP 4), Review(WIP 3), Done | Not started, In progress, In review, Done |
| Planning objects | Sprints (7–28 d), story points, sprint goal | WIP limits, pull flow | Phases (Requirements→Design→Build→Test→Deploy) with baselines, milestones |
| Suggested practice copy | refine backlog, commit to goal, stand-up, review/retro | pull don't push, limit WIP, manage flow | sign-off per phase, track variance vs baseline |
| Metrics | burndown (ideal vs remaining, scope line), velocity (6 sprints committed vs done), commitment reliability, scope creep | throughput, cycle/lead time scatter p50/p85, CFD, WIP vs limit, aging WIP | phase/milestone % vs baseline, schedule variance (days), milestones hit/missed/at-risk, Gantt |

**Common to all**: completion toward plan (points if ≥80% estimated else count; plan % = elapsed share of sprint / phase / project window; on track ≥ plan−10pp, at risk within 25pp, else behind; forecast from 14-day throughput), **completion by member** (completed, points, on-time rate, open, overdue, median cycle time, "Unassigned"), overdue list, activity calendar.

### Methodology switching (user requirement)

- `POST /api/v1/projects/{pid}/methodology` `{to, statusMapping, phases?}` with `If-Match`; owner/admin/project lead. Guided wizard in FE.
- `ws_switch_methodology`: one transaction —
  - leaving **Scrum**: the active sprint must be completed first (wizard offers "complete sprint now"); sprints remain as history.
  - leaving **Waterfall**: phases/milestones kept read-only as history; **milestones remain usable in every methodology**.
  - entering **Scrum**: open issues go to backlog (no sprint). Entering **Waterfall**: requires phase plan; unphased issues shown in an "Unphased" bucket. Entering **Kanban**: template WIP limits proposed, editable, and validated against current occupancy.
  - statuses: existing columns are kept and mapped (user can rename/add from the target template); every issue keeps a valid status; each moved issue gets version+1 + event + outbox.
  - append-only `project_methodology_periods(tenant_id, project_id, methodology, started_at, ended_at, changed_by, reason)` + audit row.
- **Metrics across a switch**: common metrics (completion, by member, throughput, cycle time, CFD — all category-based) span full history; methodology-specific charts cover the current period, with a timeline marker "Switched Kanban → Scrum on …" and older periods viewable via a period selector.

## Milestones (each implemented, tested, committed separately)

### M0 — Shared visualization lift (FE only)
- Move `admin/_lib/palette.ts`, chart helpers from `admin/_lib/format.ts`, `admin/_components/charts.tsx`, `sparkline.tsx` → `src/app/_ui/viz/`; chart CSS → `viz.css` (`viz*` classes); `ApiError`/`toError`/`SESSION_EXPIRED_EVENT` from `admin/_lib/api.ts` → `src/app/_lib/http.ts`. Admin keeps re-export shims.
- Check: existing admin tests, lint, typecheck, build unchanged. One reviewer.

### M1 — Workspace access, create, invite, accept (US-E1–E3) + email delivery foundation · migrations `0014`–`0016`
- Email foundation (worker, `spark_worker` role, outbox dispatcher, SMTP/Mailpit, templates, delivery records) ships here because invitations are the first email; invitations are emailed, not copy-pasted.
- DB: `session_workspace_ids`, replaced policies, redefined `is_workspace_member`, `users.coworker_read` policy, `auth_register_password` without workspace, `ws_create_workspace` (slug `^[a-z0-9-]{3,40}$`, `slug_taken`, abuse cap 20 owned), `ws_create_invitation` (owner/admin; only owners may invite as admin; 7-day expiry; token hash stored), `ws_revoke_invitation`, `ws_invitation_preview`, `ws_accept_invitation` (row lock, pending+unexpired, primary email match, idempotent `already_member`, outbox → notify inviter), `ws_set_member_role` (owner), `ws_remove_member` (last owner → 409). `token_hash` not selectable by `spark_app`.
- API: `POST|GET /api/v1/workspaces`, `GET|PATCH /workspaces/{wid}`, `GET /workspaces/{wid}/members`, `PATCH|DELETE /workspaces/{wid}/members/{userId}`, `POST|GET /workspaces/{wid}/invitations`, `DELETE …/invitations/{iid}`, `POST /api/v1/invitations/preview`, `POST /api/v1/invitations/accept` (token in body; accept URL returned once since no email yet).
- FE: `src/app/w/[slug]/layout.tsx` client guard (pattern of `admin/layout.tsx`); `/workspace` resolves to last-used `/w/{slug}` or `/onboarding`; `/onboarding` stepper (name workspace → pick methodology); `/w/[slug]/members` (table, role pills, pending invites, invite dialog with copy-link); `/invitations/accept#token=…` (token in fragment, survives login via sessionStorage); `WorkspaceShell` (`src/app/components.tsx`) on real data with workspace switcher and project list; remove hardcoded badge.
- Tests: route tests (fake pool: 401/403/404/400/outcomes/origin guard/token never listed); DB tests: two tenants via session tokens, pooled-connection reuse, spoofed `spark.user_id` no longer grants access, concurrent accept → one membership, expired/revoked/mismatch, sign-up creates no workspace, updated runtime allowlist; FE tests for onboarding, members, accept, guard.
- Review: correctness + security reviewers.

### M2 — Projects & methodology · `0015_project_methodology.sql`
- DB: `projects.methodology` (CHECK scrum|kanban|waterfall), `start_date`, `target_date`, `version`, `baselined_at`; `issues.started_at` (set by extended `guard_issue`), `issues.phase_id` (same-project composite FK); `sprints.version/started_at/completed_at/committed_*/completed_*`; new tables `project_phases`, `project_milestones`, `sprint_commitments` (append-only), `project_methodology_periods` (append-only) — all FORCE RLS, member read, composite tenant keys. `ws_create_project` seeds board/statuses/phases/milestones/baselines + first period; `ws_update_project`.
- API: `GET /api/v1/methodologies` (public cache 1h), `POST|GET /workspaces/{wid}/projects` (list with progress summary), `GET|PATCH /api/v1/projects/{pid}`.
- FE: methodology picker — three large cards (best for, column preview as pastel tags, planning object, metrics you'll get), conditional fields (sprint length; Waterfall dates + editable phases); `/w/[slug]/projects/new`.
- Tests: template validity, routes, DB (seeding, cross-tenant FK rejected, table count). Review: both.

### M3 — Tasks: create, assign, move (US-E4, E5) · `0016_issue_writes.sql`
- Also: `task_assigned` email via the outbox (respecting preferences; not sent when you assign yourself).
- DB: `ws_create_issue` (member; number under project lock; assignee must be active member; WIP pre-check; event + outbox; `issue.assigned` notification), `ws_update_issue` (expected version, same-project sprint/phase/status, midpoint rank with column rebalance), notification kinds allowlist, `project_notifications` helper, recipient read policy, `issue_events` index.
- API: `GET /projects/{pid}/board` (≤500 open, `truncated`), `GET /projects/{pid}/issues` (filters + keyset via `src/routes/pagination.ts`), `POST /projects/{pid}/issues` (201, Location, ETag, Idempotency-Key), `GET|PATCH /api/v1/issues/{iid}`, `GET /issues/{iid}/events`.
- FE: board `/w/[slug]/p/[key]` — columns with count + WIP chip, pastel tags, avatars, overdue dates; native drag-and-drop; keyboard moves (Space/arrows/Enter/Esc, aria-live); mobile "Move to…"; optimistic with rollback, 412 → "Updated by a teammate" refresh, WIP 409 → inline explanation; task drawer; quick-add. Client `src/app/w/_lib/api.ts` (`workspaceApi` with ifMatch/idempotencyKey → `{data, etag}`) + `useWorkspaceData` (mirrors `admin/_lib/use-admin-data.ts`).
- Tests: ranking/ETag units, 428/412/idempotency routes, DB concurrent move → one 412, concurrent WIP admission, cross-tenant assignee, notification rollback with tx; FE keyboard move, conflict, WIP rollback. Review: both.

### M4 — Planning objects + methodology switch · `0017_planning.sql`
- DB: sprints (`ws_create_sprint`, `ws_update_sprint`, `ws_start_sprint` — one active, commitment snapshot, notify; `ws_complete_sprint` — freeze totals, carry over to next sprint/backlog, lock order project→board→sprint→issues by id); phases/milestones CRUD; `ws_rebaseline_project` (audited); `ws_update_status` (name/WIP, not below occupancy); `ws_switch_methodology` (rules above). Planning managed by owner/admin/project lead.
- API: sprints (`GET|POST /projects/{pid}/sprints`, `PATCH /sprints/{sid}`, `POST …/start`, `POST …/complete`), phases, milestones, `POST /projects/{pid}/baseline`, `PATCH /projects/{pid}/statuses/{sid}`, `POST /projects/{pid}/methodology`.
- FE: `/p/[key]/backlog` (Scrum planning lanes, points vs last velocity, start/complete dialogs); `/p/[key]/timeline` (Waterfall CSS-grid Gantt: baseline ghost bars, progress fill, milestone diamonds, today line, variance badge); `/p/[key]/settings` (statuses, WIP, **switch methodology wizard**: pick target → map columns → resolve sprint/phases → confirm summary).
- Tests: sprint start/complete atomicity, concurrent double start, carry-over versions, baseline immutability, WIP below occupancy, switch in every direction (statuses valid, periods recorded, active-sprint guard). Review: both.

### M5 — Insights (optional `0018_insight_indexes.sql`)
- API: `/projects/{pid}/insights/{summary|members|flow|cycle-time|aging-wip|velocity|schedule}`, `/sprints/{sid}/burndown`, `/workspaces/{wid}/insights` (per-project completion, member completion across projects, activity calendar, overdue). Accept `period` for methodology periods. `statement_timeout` 5s, bounded ranges.
- FE: `/p/[key]/insights` methodology-aware dashboard (KPI strip + plan-vs-done header; Scrum burndown/velocity; Kanban CFD/throughput/cycle scatter/WIP gauges/aging; Waterfall phase vs baseline + milestone table; switch markers); `/w/[slug]/insights` (completion by member with avatars + on-time rate visible to all members, project cards, `ContributionCalendar`). New `GroupedBars`, `ScatterPlot` in `_ui/viz`. All via `ChartCard` with legend + table view.
- Seed: `scripts/seed-workspace-demo.ts` (`db:seed:workspace`, local-only guards like `seed-demo.ts`): "Northstar Labs", 8 sign-in-able members, Scrum project (6 done + 1 active sprint), Kanban (120 days, bottlenecks), Waterfall (Build slipping 6 days), one project that switched Kanban→Scrum; histories satisfy `check_issue_change_set`. Document accounts in `Documents/admin-test-accounts.md` style.
- Tests: `metrics.ts` units, range validation, DB fixture asserting burndown/CFD numbers, tenant isolation of analytics. Review: one + EXPLAIN on seeded data.

### M6 — Schedule (US-E6) · `0019_schedule.sql`
- DB: `ws_create_event` (attendees active members; notify), `ws_update_event` (If-Match; organizer/owner/admin), `ws_cancel_event`, `ws_respond_event`. Reminders deferred (need worker).
- API: `GET /workspaces/{wid}/calendar?from&to` (≤62 days; events + derived deadlines: due dates, sprint ends, milestones), `POST /workspaces/{wid}/calendar-events`, `PATCH /calendar-events/{id}`, `POST …/cancel`, `PUT …/attendees/me`.
- FE: `/w/[slug]/schedule` week/agenda (existing `.weekGrid`/`.eventRow` styles), new-event dialog, deadline chips; `/schedule` redirects. Tests: interval/timezone validation, attendees, conflicts, two tenants. Review: both.

### M7 — Notifications (US-F1, F2), email preferences, reminders, weekly digest + docs closeout
- `/settings/notifications` per-type toggles (`GET|PUT /api/v1/me/notification-preferences`); worker jobs for daily due-soon/overdue reminders and the Monday weekly digest (reusing M5 insight queries).
- API: `GET /api/v1/notifications?unread&cursor`, `GET /notifications/unread-count`, `PATCH /notifications/{id}` `{read:true}` (204, idempotent), `PATCH /notifications` `{read:true, before}` (only actor's rows) via `ws_mark_notifications_read`.
- FE: `/notifications` real data; `useUnreadCount` polls 30s, pauses when hidden, refetch on focus; shell badge.
- Tests: idempotency, foreign ids ignored, visibility after leaving workspace, polling hook with fake timers. Review: security.
- Docs: `user-stories.md` (A4 note, E1–E6/F1–F2 statuses, new stories for methodology choice/switch and insights, 412/428 wording), `context.md`, `database-schema.md`, `backend-delivery-backlog.md`, `screen-flow.md` (Journey 3), `rest-clean-compliance.md` (428).

## Critical files
- `Spark_Core/backend/drizzle/0002_security_and_triggers.sql`, `0006_scoped_runtime_access.sql`, `0007_governance_corrections.sql`, `drizzle/meta/_journal.json`
- `Spark_Core/backend/src/app.ts`, `src/routes/admin/guard.ts`, `src/infrastructure/database/{session,context,schema}.ts`, `src/routes/{pagination,responses,auth-credentials}.ts`
- `Spark_Core/backend/tests/database/schema.integration.ts`, `tests/fake-pool.ts`, `tests/admin.test.ts` (pattern)
- `Spark_Core/frontend/src/app/{components.tsx,auth-context.tsx,globals.css}`, `src/app/admin/_components/charts.tsx`, `admin/_lib/{api,palette,format,use-admin-data}.ts`
- Before FE code: read `Spark_Core/frontend/node_modules/next/dist/docs/` (Next 16 conventions, per `frontend/AGENTS.md`).

## Verification (every milestone; report real counts only)
- Backend: `pnpm --filter @spark/backend lint`, `typecheck`, `test`, `test:database` (needs local Postgres via `pnpm db:bootstrap:local` + Redis `pnpm infra:up`), `build`.
- Frontend: `pnpm --filter <frontend pkg> lint`, `typecheck`, `test`, `build`.
- Migrations: apply from empty and from 0013 (`db:reset:local --yes`, `db:migrate`), then `db:seed`, `db:seed:workspace`.
- End-to-end in browser (run skill): sign up → onboarding → create Kanban project → invite second seeded user → accept → create/move tasks (WIP block, 412 conflict in two tabs) → switch to Scrum → plan & start sprint → insights show burndown + member completion → schedule event → notification badge updates. Stop orphaned node processes afterwards (memory note).
- Independent reviewers per milestone as listed (spark-correctness-reviewer, spark-security-reviewer, fresh context, same snapshot).

## Risks
- Policy replacement on every workspace table — mitigated by two-tenant + pooled-connection DB tests and both reviewers.
- Hard WIP limits block moves → clear UI copy; rebalancing can cause rare spurious 412s → auto-refresh.
- Invitation accept relies on the emailed token + primary-email match; the email itself proves inbox access. Self-registered emails stay unverified until Phase 3 verification.
- Email deliverability in production depends on the chosen provider's domain setup (SPF/DKIM); local Mailpit hides this.
- Migration numbers for M2+ shift because M1 now needs three migrations; numbers in this document are indicative.
- Methodology switch touches many issues in one transaction → bounded by project size; lock ordering defined.
- Chart CSS rename may regress admin visuals → visual check of admin pages in M0.
- Rate limits are per IP; UTC day buckets.
