# Proposed product database schema

Status: the local schema foundation, Drizzle migrations (`0000_product_tables.sql` to `0021_task_assigned_email.sql`), baseline constraints, FORCE RLS, read-only runtime grants, authentication APIs (`/api/v1/auth/password/sign-up`, `/api/v1/auth/password/sign-in`, `/api/v1/me`, `/api/v1/auth/sign-out`), the platform governance API (`/api/v1/admin/*`), the workspace, member and invitation API (`/api/v1/workspaces/*`, `/api/v1/invitations/*`), the project create, read and settings API, the outbox email worker for invitation and task-assigned emails, and the issue API (`GET /api/v1/projects/{projectId}/board`, `GET` and `POST /api/v1/projects/{projectId}/issues`, `GET` and `PATCH /api/v1/issues/{issueId}`, `GET /api/v1/issues/{issueId}/events`) with issue creation, updates, moves and ranking in the database (`ws_create_issue`, `ws_update_issue`) are implemented and verified locally. Other product write use cases, payment integration, and Supabase deployment are not implemented.

Based on [product context](../context.md), [REST and Clean Architecture](rest-clean-compliance.md), and [verification policy](../automation/testing.md). The current implementation remains local-only until its reviewed migrations and tests pass. Supabase role provisioning and deployment require a separate target-specific runbook.

## Runtime access model

Migrations `0006_scoped_runtime_access.sql`, `0007_governance_corrections.sql`, and `0008_login_role.sql` replace the permissive runtime policies added in `0005`.

- `spark_app` has no INSERT, UPDATE, or DELETE grant on any table, and no direct read of credentials, sessions, tokens, reports, or platform roles.
- `spark_auth` is a login-only role created by `pnpm db:bootstrap:local`. It has no table privileges and is the only role that can execute `auth_register_password`, `auth_password_login`, and `auth_start_session`. Only the auth process connects with it (see "Process boundary").
- `auth_session_principal` and `auth_revoke_session` are executable by both roles because they require an existing session token hash.
- Registration is one atomic transaction that creates the user, primary email, credential and session only. Since `0014` it no longer creates a default workspace; `auth_register_password` keeps its return columns and returns NULL for `workspace_id`, `workspace_name` and `workspace_slug`. `auth_start_session` creates the session and returns its principal in the same call, so no unclaimed session rows remain.
- Platform governance runs inside a transaction that sets `spark.session_token_hash`. Staff read policies and `staff_*` functions resolve the actor from a live, unexpired session of an active user, never from a user id argument. A missing session raises `28000` (HTTP 401); a missing role raises `42501` (HTTP 403).
- Moderation actions may be recorded by community owners and moderators or by active platform content moderators.
- Suspending a super admin and revoking the `super_admin` role take the same row locks, so concurrent requests cannot leave the platform without an active super admin.
- Process boundary: the backend runs as three processes from one build. The public API (`src/server.ts`, port 4000) connects only as `spark_app` and forwards `POST /api/v1/auth/password/sign-up` and `/sign-in` to the private auth process (`src/auth-server.ts`, port 4100, loopback by default), which alone connects as `spark_auth`. `/api/v1/me` and sign-out stay in the API because they only need an existing token hash. The background worker (`src/worker.ts`, no HTTP port) alone connects as `spark_worker` and sends outbox emails (see "Background worker and email"). Locally all processes read the same `.env` for convenience; in production each process refuses to start with another process's database URL or `MIGRATION_DATABASE_URL`, so secrets must be provisioned per process.
- Startup probes fail closed: the API refuses a role that can execute any of the three credential functions, has role memberships, is a superuser, or bypasses RLS; the auth process refuses a role that is a superuser, bypasses RLS, has role memberships, or can read `spark.users`. In production `AUTH_SERVICE_URL` must use HTTPS unless it is a loopback address.
- What the split guarantees: the API's database role cannot read password hashes or create a session for an existing user, so SQL injection or logic errors in the API cannot mint logins.
- Residual risks (not solved by the split):
  - Code execution in the API process sees every plaintext password and every newly issued session token it relays, and it sets `X-Forwarded-For`, so it can spread password guesses across fake client addresses and evade per-IP limits. The auth process has no per-account attempt limit yet.
  - Compromise of the auth process itself exposes password hashes and session creation; its surface is two routes and their dependencies.
  - Nothing authenticates the API to the auth process beyond network reachability. Keep `AUTH_TRUSTED_PROXIES` limited to the API hosts and restrict the auth port with a network policy; mTLS is the follow-up if that is insufficient. Separate secrets and the network policy are deployment work and are not verified locally. See the [hosting checklist](../deployment/hosting-checklist.md).
  - The API waits up to 15 s for the auth process. A sign-up that commits after that is reported as `503 auth_unavailable`; retrying returns `409 email_already_exists` and the user signs in normally.
- Accepted low-severity edge cases: lock contention beyond `lock_timeout` (2 s) on governance writes surfaces as HTTP 500; a super-admin grant committed between the status check and the update of a concurrent suspension is not covered by the row lock (it requires three simultaneous administrative operations).
- Open product decision: sign-up returns `409 email_already_exists`, which reveals registered emails. A neutral response needs an email-delivery flow first.

## Session-bound workspace RLS (`0014_workspace_session_rls.sql`)

Workspace row access is bound to the live session, not to the transaction-local settings `spark.user_id` and `spark.tenant_id`, which any runtime caller could set.

- `spark.session_workspace_ids(p_roles text[] DEFAULT ARRAY['owner','admin','member']) RETURNS uuid[]` (STABLE SECURITY DEFINER, executable by `spark_app`) returns the active workspaces where `spark.session_actor()` holds an active membership with one of `p_roles`. Without a live session it returns an empty array.
- Policies `workspace_read` on `workspaces`, `workspace_members_read` on `workspace_memberships`, and `workspace_read` on the 16 tenant tables of `0002` (startup profiles, teams, projects, boards, issues and their children, calendar events and attendees) compare the row's workspace id with `session_workspace_ids()`, evaluated once per statement. A missing, revoked or expired session, a suspended or deleted user, a left or suspended membership, and an archived workspace all see no rows.
- `spark.is_workspace_member(target, allowed_roles)` keeps its signature and now delegates to `session_workspace_ids`.
- `users` policy `self_and_coworker_read` (replacing `own_user_read`) shows the session actor and users with an active membership in one of the actor's active workspaces, through `spark.is_coworker(uuid)`. Sharing only a community does not make users coworkers. The platform `staff_read` policy is unchanged.
- `spark.require_session_actor()` returns the actor or raises `Live session required` (`28000`). It is internal to workspace write functions and not executable by `spark_app`.
- `workspaces.version` (integer, default 1) is maintained by `maintain_record`: every update must advance it by exactly one.
- Not yet migrated: community helpers (`is_community_member`, `can_read_community`, `can_read_post`) and `withDatabaseContext` still use `spark.user_id`/`spark.tenant_id`. They move to the session in a later phase.

## Workspace, membership and invitation writes (`0015_workspace_membership_writes.sql`)

The runtime role still has no INSERT, UPDATE or DELETE grant on these tables. Every write is a `spark.ws_*` SECURITY DEFINER function executable by `spark_app` that derives the actor from the live session (`28000` without one), raises `22023` with a fixed message for invalid input, returns a closed set of outcomes and writes one `audit_events` row in the same transaction. Non-members get `not_found`, members without the role get `forbidden`.

- `ws_create_workspace`, `ws_update_workspace` (optimistic `version`), `ws_list_members` (active members, explicit columns, email only for owners and admins).
- `ws_create_invitation`, `ws_resend_invitation`, `ws_revoke_invitation`, `ws_invitation_preview` (no session; masked email hint) and `ws_accept_invitation` (primary email must match; re-activates a `left` membership; outbox event and an `invitation_accepted` notification for the inviter). Owners manage all invitations, admins only `member` invitations. Invitation creation and resend enqueue `invitation.created`/`invitation.resent` outbox events. In `0015` the caller passed a token hash at creation; since `0016` the function generates an unknowable placeholder itself and only the worker issues real tokens.
- `ws_set_member_role` (owners only) and `ws_remove_member` (self-leave, owners remove anyone, admins remove members). The last active owner cannot be demoted or removed (`last_owner`); the check is explicit because the deferred `workspace_owner` trigger only fires at commit.
- Lock order in every function: workspace row, then invitation, then membership.
- `workspace_invitations`: column-level `SELECT` for `spark_app` without `token_hash` and `accepted_by_user_id`, policy `invitation_admin_read` for owners and admins.
- `notifications.kind` is limited to `invitation_accepted` (`0019` adds `issue_assigned`).
- `is_coworker` additionally hides platform-suspended and soft-deleted coworkers.

## Background worker and email (`0016_email_worker.sql`)

The worker process (`src/worker.ts`) logs in as `spark_worker`. The role has no table privileges and no role memberships: it has `USAGE` on the `spark` schema and `EXECUTE` on five SECURITY DEFINER functions with a fixed `search_path`, which `spark_app` and `spark_auth` cannot execute. At startup the worker refuses a role that is a superuser, bypasses RLS, has memberships, can read `spark.users`, or cannot claim outbox events.

- `worker_claim_outbox(lock_token uuid, limit integer, lease_seconds integer)` claims up to `limit` (1 to 100) due, unlocked events with `FOR UPDATE SKIP LOCKED`, sets `locked_until = now() + lease` (10 to 600 s), stores the lock token and increments `attempts`.
- `worker_complete_outbox(id, lock_token) RETURNS boolean` marks the event processed; `false` when the lease was lost (expired and re-claimed, or already settled).
- `worker_fail_outbox(id, lock_token, error_code, retry_at) RETURNS boolean` records a short error identifier (`^[a-z][a-z0-9_]{0,63}$`, never message text or addresses) and the retry time; after eight attempts the event is dead-lettered (`processed_at` set, `last_error_code` kept). `false` when the lease was lost.
- `worker_invitation_email(invitation uuid)` returns only what the email needs: status (`unavailable` for an inactive or archived workspace, `expired` for a pending invitation past its expiry), recipient address, workspace name, inviter name, role and expiry.
- `worker_issue_invitation_token(invitation uuid, token_hash bytea) RETURNS boolean` locks the workspace, then the invitation, and stores the SHA-256 hash of a freshly generated token for a pending, unexpired invitation of an active workspace, which invalidates any earlier link. The raw token never reaches the database: it exists only in worker memory and in the email, in the URL fragment.

Worker behaviour (`src/modules/outbox/`):

- Each batch claims at most 5 events under a 300 s lease; the worst case per event is about 45 s of database and SMTP timeouts.
- An event is started only with at least 90 s of lease left, and a token is never issued with less than 60 s left. Unprocessed events stay claimed until the lease expires and are then claimed again.
- A `false` from complete or fail is counted as `leaseLost`, not as sent or failed. Logs carry counts and error codes only.
- Delivery is at least once: an event whose lease expires mid-send may be sent again by another worker. Every send issues a new token, so only the latest link works.
- In production SMTP must be encrypted: `smtps://` (implicit TLS), or `smtp://` with STARTTLS required (nodemailer `requireTLS`). `SMTP_URL` query options are rejected in production because they could switch TLS off.

Changes to the `0015` write functions:

- `ws_create_invitation(uuid, text, text, timestamptz)` replaces the five-argument version: the caller no longer supplies a token hash, and the function stores an unknowable random placeholder until the worker issues the real token. A workspace may hold at most 100 unexpired pending invitations (abuse guard).
- `ws_resend_invitation` revives an expired invitation (by status, or pending past its expiry) for another 7 days unless a newer invitation for the same address is already pending. Accepted and revoked invitations stay `not_pending`.
- `ws_invitation_preview` minimizes settled invitations: a non-pending invitation previews its status only, without workspace or inviter details.
- `ws_accept_invitation` looks the token up, locks the workspace, then re-locks the invitation by id and re-checks the hash under the lock, so a token the worker rotated in between is invalid. The inviter is notified only while still an active workspace member.
- `ws_create_workspace`: archived workspaces no longer count toward the owned-workspace cap.
- The `issue_change_set` constraint trigger on `outbox_events` now fires on insert, delete, and updates of `tenant_id`, `aggregate_type`, `aggregate_id` or `aggregate_version` only, so delivery bookkeeping (lease, attempts, errors) on older issue events is not mistaken for an issue change set.

## Project methodology schema (`0017_project_methodology.sql`)

Schema only: the project write functions (`ws_create_project`, `ws_update_project`) are added by `0018_project_writes.sql` (see [Project writes](#project-writes-0018_project_writessql)). The runtime role reads the new tables through the session-bound `workspace_read` policy (`tenant_id = ANY(session_workspace_ids())`) and has no write grants; each new table has FORCE RLS, `owner_maintenance` for `spark_owner` and composite `(tenant_id, project_id)` foreign keys with `ON DELETE RESTRICT`.

- `projects` adds `methodology` (`scrum`/`kanban`/`waterfall`, default `kanban`), `start_date`, `target_date` (`target_date >= start_date`), `sprint_length_days` (7 to 28, Scrum only, otherwise NULL), `settings_version` (positive, default 1) and `baselined_at`. `projects` has no `version` column on purpose: `maintain_record` would force every update, including issue number allocation, to bump it. `settings_version` is advanced explicitly by the settings write function.
- `issues` adds `started_at` and `phase_id` (FK `(tenant_id, project_id, phase_id)` to `project_phases`, so an issue cannot reference another project's phase). `guard_issue` stamps `started_at` the first time the issue enters an `in_progress` status and keeps it afterwards, also when the issue moves back; all earlier checks are unchanged.
- `sprints` adds `version` (now enforced by `maintain_record`: every sprint update advances it by one), `started_at`, `completed_at` and the non-negative commitment metrics `committed_points`, `committed_count`, `completed_points`, `completed_count`.
- `project_phases`: name stored trimmed (1 to 60), `position >= 1` unique per project, `planned_end >= planned_start`, baseline dates both NULL or both set with end >= start, status `planned`/`active`/`completed`, `version` maintained by `maintain_record`. UNIQUE `(tenant_id, project_id, id)` is the target of the phase foreign keys.
- `project_milestones`: optional `phase_id` (same-project FK), name stored trimmed (1 to 80), `due_date`, `baseline_due_date`, `completed_at`, `version` maintained by `maintain_record`.
- `sprint_commitments` (PK `tenant_id, sprint_id, issue_id`, `story_points`): the snapshot taken when a sprint starts. Append-only through `reject_history_change()` (`23514`).
- `project_methodology_periods`: methodology, `started_at`, `ended_at` (> `started_at`), `changed_by_user_id`, `reason` (1 to 200). At most one open period (`ended_at IS NULL`) per project (partial unique index, `23505`). The `period_close_only` trigger allows only one update that sets `ended_at` from NULL; any other update or a delete raises `23514`.
- Backfill: every project that existed before `0017` gets one open `kanban` period starting at the project's `created_at`, attributed to the workspace's `created_by_user_id` with reason `Backfilled at migration 0017`.

## Project writes (`0018_project_writes.sql`)

The runtime role still has no INSERT, UPDATE or DELETE grant on projects. Both functions are `spark.ws_*` SECURITY DEFINER functions executable by `spark_app` (`REVOKE ALL ... FROM PUBLIC`), derive the actor from the live session (`28000` without one), return a closed set of outcomes and write one `audit_events` row in the same transaction. Invalid input raises `22023` with a fixed message before any row is locked, so those errors reveal nothing about existence. Lock order: workspace, project, board, statuses, then phases and milestones.

- `ws_create_project(workspace, key, name, description, methodology, lead, start, target, sprint_length, statuses jsonb, phases jsonb)` returns `(outcome, project_id, settings_version)`. Owners and admins only. Outcomes: `ok`, `not_found` (not a member), `forbidden`, `key_taken` (`ON CONFLICT (tenant_id, key) DO NOTHING`), `invalid_lead` (lead must be an active member with an active, non-deleted user) and `too_many_projects` (50 non-archived projects per workspace; the workspace row lock serializes concurrent creations against the cap).
- `22023` messages for create: `Invalid project key` (`^[A-Z][A-Z0-9]{1,9}$`), `Invalid project name` (trimmed, 1 to 80), `Invalid project description` (at most 2000), `Invalid methodology`, `Invalid project dates` (finite, target not before start, both required for Waterfall), `Invalid sprint length` (Scrum 7 to 28, default 14; any value for other methodologies), `Invalid project statuses` (2 to 12 objects `{name, category, wipLimit}`, names unique case-insensitively, at least one `done` and one non-`done`, WIP an integer 1 to 99 or null) and `Invalid project phases` (empty unless Waterfall; Waterfall needs 1 to 12 objects `{name, plannedStart, plannedEnd}`, each inside the project dates and starting after the previous phase ends).
- Seeded structure, all in one transaction: the `projects` row (`baselined_at` set for Waterfall), one `boards` row named after the project, the `issue_statuses` rows (position `1024 * n`), for Waterfall the `project_phases` rows (baseline equal to the planned dates) each with one `project_milestones` row named `<phase> sign-off` due on the phase end, and one open `project_methodology_periods` row with reason `Project created`. Audit action `project.created` with `methodology` and `key`. The returned `settings_version` is 1.
- `ws_update_project(project, expected_version, patch jsonb)` returns `(outcome, settings_version)`. The patch accepts only `name`, `description`, `leadUserId`, `startDate`, `targetDate` and `sprintLengthDays`; methodology is not editable. Owners, admins and the project's current lead may call it. Outcomes: `ok`, `not_found` (unknown project or not a member), `forbidden`, `version_mismatch` (returns the current `settings_version`) and `invalid_lead`. Decision order is input validation, `not_found`, `forbidden`, `version_mismatch`, then lead and date checks, so the current version is only revealed to callers allowed to edit.
- `22023` messages for update: `Invalid project name` (also the fallback for a non-object patch or an unknown key), `Invalid project description`, `Invalid project dates` (malformed date, target before start, or for Waterfall missing dates or dates that no longer contain every phase) and `Invalid sprint length` (7 to 28, Scrum projects only).
- Versioning and audit: every successful update that changes a value sets `settings_version = settings_version + 1`; since `0020` a patch that changes no value returns `ok` with the current `settings_version` and writes neither the row nor an audit row. `projects` has no `version` column, so issue number allocation never bumps it. Audit action `project.updated` lists the patch keys only, not the old or new values.

## Issue creation (`0019_issue_create.sql`)

The runtime role still has no INSERT, UPDATE or DELETE grant on issues. `ws_create_issue` is a SECURITY DEFINER function executable by `spark_app` (`REVOKE ALL ... FROM PUBLIC`) that derives the actor from the live session (`28000` without one) and returns a closed set of outcomes. Every active workspace member (owner, admin or member) may create issues in a non-archived project of the workspace.

- Lock order for issue writes: workspace row `FOR SHARE`, project row `FOR UPDATE`, board, statuses, then issues by id. The new internal helper `lock_workspace_member(workspace, actor)` (not executable by `spark_app`) works like `lock_workspace_role` but takes the workspace row `FOR SHARE`, so issue writes in different projects of one workspace do not serialize, while membership changes (`FOR UPDATE`) still exclude them.
- `ws_create_issue(project, title, description, type, priority, status, assignee, story_points numeric, due date, phase, idempotency_key, request_hash bytea)` returns `(outcome, issue_id, issue_version)`. Outcomes: `ok`, `replayed`, `not_found` (unknown or archived project, or not an active member), `no_board` (no board or no non-`done` default status), `invalid_assignee` (not an active member with an active, non-deleted user), `too_many_issues` (10 000 non-archived issues per project), `wip_limit_reached` (the target status's WIP limit is already reached by other non-archived issues) and `idempotency_conflict`.
- Decision order: actor, project and membership (`not_found`), locks, idempotency, input validation, `no_board`, `invalid_assignee`, the cap, then WIP. Input checks run after the membership check, so they reveal nothing to non-members.
- `22023` messages: `Invalid idempotency key` (key `^[A-Za-z0-9_.:-]{1,100}$` and a 32-byte hash, both required when a key is given), `Invalid issue title` (trimmed, 1 to 200), `Invalid issue description` (at most 10 000; empty becomes NULL), `Invalid issue type` (`task`, `bug`, `story`; default `task`), `Invalid issue priority` (default `medium`), `Invalid story points` (0 to 100, at most two decimals), `Invalid due date` (2000-01-01 to 2100-12-31), `Invalid issue status` (must belong to the project) and `Invalid issue phase` (must belong to the project).
- The issue takes `projects.next_issue_number` (then incremented; `settings_version` is untouched), the given status or the first status by position whose category is not `done`, and position `max + 1024` of the non-archived issues in that status (or `1024`). `reporter_user_id` is the actor; `started_at` and `completed_at` are left to `guard_issue`.
- In the same transaction: one `issue_events` row (`issue.created`, `from_version` 0, `to_version` 1, `changes = {fields, after}` where `after` is the allowlisted snapshot `statusId`, `category`, `assigneeUserId`, `storyPoints`, `phaseId`, `sprintId`, `archived`, never title or description text) and one processed `outbox_events` row (`aggregate_type 'issue'`, version 1). When the assignee is not the actor, one `notifications` row of kind `issue_assigned` for the assignee, titled `<actor display name> assigned you <KEY>-<n>: <title>` (cut to 500), resource `('issue', id)`, linked to that outbox row.
- Idempotency: keys are scoped to `(workspace, actor, 'issue.create')` and kept 24 hours. An expired row for the key is deleted first. The row is inserted (`started`) before the checks, so a concurrent request with the same key waits for the first transaction; it becomes `completed` with `resource_id` and `response_status` 201 on success and is deleted again when the create is refused. An existing completed row with the same hash for an issue of the same project returns `replayed` with that issue and its current version; any other existing row returns `idempotency_conflict`.
- `notifications`: `kind` now allows `invitation_accepted` and `issue_assigned`. `spark_app` has `SELECT` with policy `recipient_read`: the row's recipient is the session user (`is_session_user(recipient_user_id)`, a new boolean helper executable by `spark_app`, since `session_actor()` is not) and the row's workspace is one of the session's active workspaces, so a recipient who left the workspace no longer sees its notifications.
- New index `issue_events (tenant_id, project_id, created_at, issue_id)` for per-project history and analytics reads.
- `ws_remove_member` additionally clears `lead_user_id` on the workspace's projects led by the removed or leaving member (advancing their `settings_version`); all other behaviour is unchanged from `0015`.

## Issue updates, moves and ranking (`0020_issue_updates.sql`)

`ws_update_issue(issue, expected_version, patch jsonb)` is a SECURITY DEFINER function executable by `spark_app` (`REVOKE ALL ... FROM PUBLIC`) that derives the actor from the live session (`28000` without one) and returns `(outcome, issue_version)`. Every active workspace member may edit, assign, move, archive and restore issues in non-archived projects of the workspace.

- Outcomes: `ok`, `not_found` (unknown issue, archived project, or the actor is not an active member), `version_mismatch` (returns the current version), `invalid_assignee` (malformed id, or a new assignee who is not an active member with an active, non-deleted user) and `wip_limit_reached`.
- The patch accepts only `title`, `description`, `type`, `priority`, `statusId`, `afterIssueId`, `assigneeUserId`, `storyPoints`, `dueDate`, `phaseId` and `archived`; a non-object, `{}` or any other key raises `22023 Invalid issue patch` before any lookup, so it reveals nothing. On an archived issue only `{"archived": false}` is accepted; anything else raises `Invalid issue patch`.
- Decision order: patch shape, actor and membership (`not_found`), locks (workspace `FOR SHARE`, project `FOR UPDATE`, board, then the issue row), version, the archived-issue rule, per-key validation (`Invalid issue patch` for a non-boolean `archived`, `Invalid issue title`, `Invalid issue description`, `Invalid issue type`, `Invalid issue priority`, `Invalid story points`, `Invalid due date`, `Invalid issue status`, `Invalid issue phase`, `Invalid issue position`), assignee, WIP, the no-op check, then the write. Field rules match `ws_create_issue`; `type` and `priority` cannot be null; `afterIssueId` must be another non-archived issue of the project in the target status.
- WIP admission runs only when the issue enters a column (status change or restore) and does not end up archived: it is refused when other non-archived issues already fill the target status's `wip_limit`. Reordering or editing inside a column is never blocked. The project row lock serializes concurrent admissions and edits, so of two writers with the same expected version exactly one wins.
- Ranking: `afterIssueId = X` places the issue at the midpoint between X and the next issue of the target column (excluding the mover), or `X + 1024` at the end; `afterIssueId = null` places it at `first - 1024` (or `1024` in an empty column); a status change or restore without `afterIssueId` places it at `max + 1024` (or `1024`). Dropping an issue right after its current predecessor keeps its position. Archiving keeps the position.
- Bounded rebalance: when the gap to a neighbour would be below `0.001`, a window of at most 50 issues around the drop point (the mover plus its neighbours on both sides, in the new order) is renumbered. The window is spread evenly across the span between the nearest untouched issues below and above it; at a column end it extends in `1024` steps from the untouched neighbour (a column of at most 50 issues becomes `1024 * i`). Only when that span is itself too dense (a resulting gap below `0.001`) is the whole column renumbered to `1024 * i`. The renumbered issues are locked by id, and each one other than the mover whose position changes gets its own version bump, an `issue.reranked` event (`fields = ["position"]`) and a processed `issue.reranked` outbox row. A reorder that triggers a rebalance is always applied, even when the mover's own numeric position comes out unchanged. This keeps the writes per request bounded (at most 50 change sets) except in the dense-span fallback.
- A patch that changes no value returns `ok` with the current version and writes nothing. Otherwise the issue is updated (the function itself sets `version = version + 1`; the `maintain_record` trigger never bumps a version, it only rejects an update that does not advance it by exactly one and stamps `updated_at`, and `guard_issue` does not touch the version either; `archived_at` set or cleared; `started_at` and `completed_at` stay with `guard_issue`) with one `issue.updated` event (`fields` lists the changed keys, sorted, where `position` stands for a placement through `afterIssueId` that changed the position; `after` is the allowlisted snapshot as in `0019`) and one processed `issue.updated` outbox row. When the assignee changes to someone other than the actor, the new assignee gets one `issue_assigned` notification with the `0019` title format, linked to that outbox row. An issue still assigned to a former member stays editable; only a new assignee is checked.
- `ws_update_project` is replaced with the no-op short-circuit described under `0018`; everything else is unchanged.

## Task-assigned email (`0021_task_assigned_email.sql`)

`ws_create_issue` and `ws_update_issue` are replaced with versions that differ from `0019` and `0020` only in the outbox row of a version that creates an `issue_assigned` notification: that row is written with `processed_at` NULL and its payload gains `version` and `notificationId`, so the worker claims it. Every other issue outbox row (no assignee, self-assignment, other edits, `issue.reranked`) is still written processed. The notification id is generated first so the payload can name it; the outbox row is still inserted before the notification, which references it. Grants are unchanged (`spark_app` only).

Two new SECURITY DEFINER functions are executable by `spark_worker` only (revoked from `PUBLIC` and `spark_app`), so the worker role now has seven functions and still no table privileges:

- `worker_task_assigned_email(notification uuid)` returns `(status, email, recipient_name, actor_name, workspace_name, workspace_slug, project_key, project_name, issue_number, issue_title)` for an `issue_assigned` notification; zero rows for an unknown notification or another kind. `status` is `skipped`, with every other column NULL, when the recipient is no longer an active, non-deleted user and active member of an active workspace, is no longer the issue's assignee, the issue or its project is archived, the recipient has no primary email, an `email` delivery already exists for the notification, or the recipient's `notification_preferences` row for (`task_assigned`, `email`) has `enabled = false` (no row means enabled). It is also `skipped` under three abuse limits that keep repeated assigning from flooding one inbox or exhausting the shared SMTP quota (in-app notifications are unaffected): latest only (a newer `issue_assigned` notification exists for the same recipient and issue, ordered by issue version, so assigning B, then C, then B again before the worker runs emails B once); `same_issue_window` (an email to the same recipient for the same issue was `sent` within the last 10 minutes); `recipient_window` / `recipient_max` (the recipient already has 20 `sent` task-assigned email deliveries within the last hour, across all issues and workspaces; `suppressed` rows do not count). The limits are named in a `limits` CTE in the function. Concurrent workers can each pass a counting limit once before either records its send, so a limit can be exceeded by at most the number of events sent in parallel. Otherwise `pending`. The actor is the `issue_events` actor of the notification's outbox version.
- `worker_record_email_delivery(notification uuid, status text) RETURNS boolean` inserts the `notification_deliveries` row (channel `email`, status `sent` with `delivered_at`, or `suppressed`) `ON CONFLICT (tenant_id, notification_id, channel) DO NOTHING`; `false` when it already existed or the notification is unknown or not `issue_assigned`. Any other status raises `22023 Invalid delivery status`.

Worker behaviour: `issue.created` and `issue.updated` events go to the task-assigned handler. An event without `notificationId` completes without action; a `skipped` status is recorded as `suppressed`; otherwise the email (subject `<actor> assigned you <KEY>-<n>: <title>`, title cut to 80 characters with an ellipsis, button "Open task" to `/w/<slug>/p/<KEY>?issue=<KEY>-<n>`, footer link "Email preferences" to `/settings/notifications`) is sent and recorded as `sent`. An SMTP failure is retried as `smtp_error`. Delivery is at least once: a send whose lease expires before it is recorded may be repeated.

## Platform governance and audit (`0009_platform_governance.sql` to `0011_campaign_review_lock.sql`)

- **Audit log.** `spark.platform_audit_events` records every staff action in `/admin`: actor, action, target (type, id, and a label captured at the time), reason (3 to 500 characters) and non-sensitive metadata such as the role or the previous state.
  - Actions are a closed set: `report.*`, `community.*`, `user.suspend`/`user.reactivate`, `role.grant`/`role.revoke` and `campaign.approve`/`campaign.reject`.
  - The table is append-only (`reject_history_change`) and FORCE RLS.
  - `spark_app` may only SELECT it, and the `staff_read` policy limits rows to `super_admin` and `platform_admin` sessions.
  - Rows are written only by the definer helper `record_platform_audit`, which `spark_app` cannot execute. Each staff function calls it in the same transaction as the change, so a rolled-back change leaves no audit row and a refused or no-op action records nothing.
- **Community states.** `communities.featured_at` and `frozen_at` sit next to `archived_at`. CHECK constraints keep archived communities unflagged, and frozen communities never featured.
  - `staff_moderate_community` applies the transitions: feature, unfeature, freeze, unfreeze, archive and restore.
  - The definer trigger `check_community_open` rejects new posts and comments in frozen or archived communities. It takes a share lock on the community row so an insert cannot race a concurrent freeze.
- **Reasons everywhere.** `staff_resolve_report`, `staff_review_campaign`, `staff_moderate_community`, `staff_set_user_status`, `staff_grant_role` and `staff_revoke_role` all require a reason through `require_reason`.
  - `staff_set_user_status` returns `unchanged`, and records nothing, when the user already has the requested status.
- **Keyset paging.** Staff lists are ordered by `(created_at DESC, id DESC)` and supporting indexes were added.
  - `staff_list_reports` takes the cursor directly. Other lists page through RLS-filtered reads in the API.
  - API cursors carry PostgreSQL's own `created_at::text`, so microsecond timestamps never lose precision.
- **Role filters.** Passing NULL to `staff_user_roles` or `staff_open_report_counts` returns every row, which backs the role and "flagged" filters.
- **Other guards.**
  - A pending campaign cannot be approved while its community is frozen or archived (`community_unavailable`); it can still be rejected. Approval share-locks the community row, so it cannot race a concurrent freeze or archive.
  - `staff_set_user_status` locks the target user row before the admin-tier check, so a concurrent role grant cannot slip in between.
  - The audit table also rejects `TRUNCATE`.
  - The API refuses state-changing `/api/v1/*` requests whose `Origin` is not an allowed frontend origin, or that the browser marks `Sec-Fetch-Site: cross-site` (`src/routes/origin-guard.ts`). This adds to the `SameSite=Lax` session cookie.

Known limits, accepted for the MVP:

- **No outbox events yet.** Governance actions write no outbox event, so UC-18 step 4 and the "state change, moderation record and outbox event in one transaction" rule are not yet met. Add the event to the same functions when notifications (UC-23) are built.
- **Read-only covers new content only.** "Archived communities are read-only" is enforced for new posts and comments. Edits and soft-deletes of existing content are not blocked at the database level; there is no write API for them yet.
- **Audit entries are permanent.** They keep the target's display name at the time and the staff member's free-text reason. There is no redaction path, so staff should keep reasons factual and free of personal data. A retention and erasure policy must be decided before production.
- **Rate limits are not tested end to end.** The 30-per-minute limit on admin mutations is configured per route but only tested against mocks.

## Admin insights (`0012_admin_insights.sql`)

Read-only reporting functions behind `/admin/analytics`, `/admin/billing` and the richer moderation pages. Like the governance functions they are `SECURITY DEFINER` with `search_path = ''`, revoked from PUBLIC, granted to `spark_app`, and start with `require_platform_role`.

- **Who can call what.**
  - Admins (`super_admin`, `platform_admin`): `staff_activity_series`, `staff_active_user_totals`, `staff_engagement_heatmap`, `staff_retention_cohorts`, `staff_user_activity`, `staff_user_sessions`, `staff_user_risk` and every `staff_billing_*`, `staff_list_subscriptions` and `staff_list_invoices` function.
  - Admins and community moderators: `staff_top_communities`, `staff_community_health`, `staff_community_series`.
  - Admins and content moderators: `staff_report_context`, `staff_report_stats`.
- **Bounds.** Ranges are limited (days 7 to 365, weeks 4 to 26, months 3 to 24), array arguments to 100 ids and page sizes to 101 rows; out-of-range input raises `22023`, which the API maps to 400.
- **Definitions.**
  - Days are UTC. An active user signed in, posted or commented that day.
  - Retention: share of a weekly sign-up cohort with any activity in each following week.
  - MRR: active and past-due paid subscriptions at their price per month (a yearly price counts as one twelfth). Trialing subscriptions are not counted. Historical months use today's price, because price changes are not versioned yet.
  - Known limits of the MRR history: it is rebuilt from current rows, so a paid subscription that is now paused drops out of past months, an expired subscription without `cancelled_at` counts as churn in the chart but not in "cancelled, last 30 days", and an active subscription whose trial end date lies after this month is in the headline MRR but not yet in this month's chart point. Versioned subscription history would remove these gaps.
- **Visible content only.** Community rankings, health and the community activity chart ignore hidden and deleted posts and comments. The platform activity series counts all activity as it happened.
- **Privacy.** `staff_user_sessions` returns when and how someone signed in and whether the session is active, expired or revoked; it never returns the token hash. Reporter identity stays limited to report handlers.
- **Indexes** on `created_at` for posts, comments and sessions, `joined_at` for memberships, `issued_at` for invoices, subscription status and payment event time keep the series queries off full scans.

**Report preview (`0013_report_preview.sql`).** `staff_report_preview(report)` returns the reported post with its author (name, avatar), time and comment count, and for a comment report the parent post plus the comment. Content staff only, like the queue.

**System health.** `GET /api/v1/admin/system/health` (admins) reports API traffic, error rates and response times from an in-memory recorder in the API process (per-minute buckets for 24 hours, by route pattern, reset on restart, one instance only), a database round trip and statistics (`pg_database_size`, `pg_stat_activity`, `pg_stat_database`), Redis ping and memory, and process memory and event-loop delay. Overall status is down when the database fails, degraded when Redis is down or slow, server errors exceed 5%, p95 exceeds 1 s or event-loop p99 exceeds 200 ms. The route skips the Redis-backed rate limiter so it can still report a Redis outage; instead it allows 30 checks a minute per client address (in memory, at most 1,000 addresses). Behind a reverse proxy, set the trusted proxies so the real client address is used; otherwise all clients share the proxy's budget. The API's database pool gives up connecting after 5 seconds, so an unreachable database shows up as a 503 rather than a hang.

Local demo data: `pnpm --filter @spark/backend db:seed:demo` (after `db:seed`) creates about 240 members with six months of history, 14 communities, content, reports, campaigns, plans, subscriptions, invoices and staff actions. It refuses to run twice; `db:reset:local --yes` drops the local schema so it can be rebuilt. Paid rows use the provider `demo`.

## Scope and assumptions

Context defines community discovery, membership, posts, workspaces, tasks, notifications, and moderation (US-01 through US-07). The user additionally requests Google/other login providers, startup connections, Jira-like Kanban, schedule control, subscriptions, and promotions. These extensions do not silently change the existing MVP definition.

Proposed tenant boundary: one workspace is one tenant. It can own multiple communities and projects. Community membership grants social access only, not workspace/project access. A team groups workspace members and is not a separate tenant. A user may join many workspaces and communities.

Initial design choices: billing is per workspace; projects are visible to active workspace members; each project has one board; each issue has at most one assignee. Startup connections join workspaces without sharing private resources. The user confirmed both subscription discounts and paid startup advertising; the advertising model is specified in [promotion schema](promotion-schema.md). The remaining choices are explicit proposal assumptions for implementation planning.

## Notation and common constraints

- Fields are NOT NULL unless suffixed with `?`. IDs and references are UUIDs. `id` is the primary key unless another key is specified.
- Every table has `created_at timestamptz default now()`; mutable records also have `updated_at timestamptz`, maintained by the write path. Append-only events omit updated_at.
- Tenant tables include `tenant_id uuid -> workspaces.id` and `UNIQUE (tenant_id, id)` when they have an id. Workspace itself is the tenant root. Global and cross-tenant exceptions are explicit.
- Child FKs include tenant: `(tenant_id, parent_id)`. Project children also reference `(tenant_id, project_id, id)` candidate keys. Community children use the equivalent community-qualified keys. Declare every candidate key required by these FKs in migrations.
- Membership FKs retain historical authorship but do not prove active authorization. All mutations check current status and role.
- Use text with CHECK allowlists for states/roles, appropriate input length checks, timestamptz for instants, date for date-only fields, and IANA timezone names. Entity versions and issue_events.to_version are positive integers; issue_events.from_version is nonnegative to support creation at 0 -> 1. Money uses nonnegative bigint minor units plus currency, never float.
- JSONB is limited to structured event/audit diffs and provider snapshots; core relationships have FKs. Board ordering uses numeric(20,6) position with id as tie breaker.
- Default deletion is RESTRICT. Archive business records; retain inactive memberships. CASCADE only dependent join rows and expendable credentials/tokens. User PII redaction must preserve billing and moderation evidence. Retention periods need a separate operational policy.

## Identity and authentication (global, private)

| Table | Fields | Keys and constraints |
| --- | --- | --- |
| users | id, display_name text, avatar_url text?, locale text, timezone text, status text, last_login_at timestamptz?, deleted_at timestamptz? | Status active/suspended/deleted. Only explicit profile projections are public. |
| user_emails | id, user_id, email text, normalized_email text, verified_at timestamptz?, is_primary boolean | UNIQUE normalized_email; partial UNIQUE user_id WHERE is_primary. No provider-specific dot/plus rewriting. |
| password_credentials | user_id PK/FK, password_hash text, password_changed_at timestamptz | Zero or one per user. Argon2id encoded hash contains salt and work parameters. Benchmark work factors at implementation. |
| auth_identities | id, user_id, provider text, issuer text, provider_subject text, provider_email text?, provider_email_verified boolean, linked_at timestamptz, last_login_at timestamptz? | UNIQUE (provider, issuer, provider_subject); subject is opaque and case-sensitive. Supports Google/GitHub/Apple through provider adapters. |
| sessions | id, user_id, token_hash bytea, authenticated_identity_id?, auth_method text, last_seen_at timestamptz, expires_at timestamptz, revoked_at timestamptz?, rotated_from_id? | UNIQUE token_hash; hash a cryptographically random opaque token. Expiry after creation. Identity and predecessor FKs include user_id. |
| account_tokens | id, user_id, user_email_id?, purpose text, token_hash bytea, expires_at timestamptz, consumed_at timestamptz? | UNIQUE token_hash. Purpose verify_email/reset_password; verification requires email FK belonging to user. Atomic single-use consumption while unexpired. |
| platform_role_assignments | id, user_id, role text, granted_by_user_id?, revoked_at timestamptz? | Global platform staff roles: `super_admin`, `platform_admin`, `community_moderator`, `content_moderator`, `campaign_moderator`. Partial UNIQUE (user_id, role) WHERE revoked_at IS NULL. Separately provisioned from workspace memberships. |

A Google-only user has no password_credentials row. No plaintext, reversible password storage, dummy passwords, or password hashes in DTOs/logs/audit. Password setup/reset requires verified ownership and replaces credentials and revokes affected sessions transactionally. Secure-cookie opaque sessions rotate and can be revoked server-side.

Never auto-link accounts based only on matching provider email. Require reauthenticated explicit linking or verified recovery on collision. Validate issuer/audience/signature/expiry, OAuth state, nonce and PKCE where applicable. Reject unlinking the last usable login/recovery method. OAuth state/PKCE material belongs in expiring server storage. Login-only OAuth does not persist access/refresh tokens; later calendar integration uses a separate encrypted grants table with scopes, key reference, expiry and revocation.

A narrowly scoped authentication adapter accesses credential/session tables; ordinary product queries cannot enumerate them. Login/reset endpoints use existing Redis rate limits and non-enumerating errors. Platform staff roles (`super_admin`, `platform_admin`, `community_moderator`, `content_moderator`, `campaign_moderator`) are strictly for global Spark platform governance, completely decoupled from tenant-level workspace or community memberships.

## Workspaces, startup profiles, teams, connections

| Table | Fields | Keys and constraints |
| --- | --- | --- |
| workspaces | id, slug text, name text, status text, created_by_user_id, archived_at timestamptz? | UNIQUE slug; active/archived. Initial owner created in same transaction. |
| workspace_memberships | id, tenant_id, user_id, role text, status text, joined_at timestamptz, left_at timestamptz? | UNIQUE (tenant_id,user_id); roles owner/admin/member; active/suspended/left. |
| startup_profiles | tenant_id PK/FK, tagline text?, description text?, website_url text?, stage text, country_code text?, city text?, founded_on date?, connection_intent text?, is_discoverable boolean | Stage idea/validation/mvp/growth/established. Public projection requires explicit opt-in. |
| teams | id, tenant_id, name text, description text?, archived_at timestamptz? | UNIQUE (tenant_id,name). |
| team_memberships | tenant_id, team_id, user_id, role text | PK (tenant_id,team_id,user_id); team and workspace-member composite FKs; lead/member. |
| workspace_invitations | id, tenant_id, email_normalized text, role text, token_hash bytea, invited_by_user_id, expires_at timestamptz, status text, accepted_by_user_id?, accepted_at timestamptz?, revoked_at timestamptz? | UNIQUE token_hash; partial UNIQUE (tenant_id,email_normalized) WHERE pending. Pending/accepted/revoked/expired; invitation role admin/member. Acceptance fields iff accepted. |
| startup_connections | id, requester_tenant_id, recipient_tenant_id, requested_by_user_id, message text?, status text, responded_by_user_id?, responded_at timestamptz? | Cross-tenant bridge with no single tenant_id. FK endpoints to workspaces; requester actor to requester membership, responder to recipient membership. Distinct endpoints; UNIQUE canonical least/greatest endpoint pair. Pending/accepted/rejected/withdrawn/disconnected. |

Owner demotion/removal locks workspace and preserves at least one active owner. Invitation acceptance locks invitation, verifies authenticated user's verified recipient email and expiry, upserts membership and consumes token atomically. Expire old pending invitations before replacements; do not use now() in an index predicate. Invitations cannot transfer ownership.

Connection requests/decisions require active endpoint owners/admins. Recipient accepts/rejects; requester withdraws; either endpoint disconnects accepted connections. Reopening uses same canonical pair plus audit history. Connections grant no private access. Actor IDs alone never authorize actions. Recruiting positions/applications are deferred until a recruitment story exists.

## Communities, discovery, posts, moderation

| Table | Fields | Keys and constraints |
| --- | --- | --- |
| communities | id, tenant_id, slug text, name text, description text, visibility text, country_code text?, city text?, stage text?, created_by_user_id, archived_at timestamptz? | UNIQUE slug; public/private/hidden. |
| topics | id, slug text, name text | Global dictionary; UNIQUE slug. |
| community_topics | tenant_id, community_id, topic_id | PK (tenant_id,community_id,topic_id). |
| community_memberships | id, tenant_id, community_id, user_id, role text, status text, joined_at timestamptz, left_at timestamptz? | UNIQUE (tenant_id,community_id,user_id); owner/moderator/member; active/suspended/left. Does not require workspace membership. |
| community_join_requests | id, tenant_id, community_id, user_id, message text?, status text, reviewed_by_user_id?, reviewed_at timestamptz? | Pending/approved/rejected/withdrawn; partial UNIQUE (tenant_id,community_id,user_id) WHERE pending. |
| posts | id, tenant_id, community_id, author_user_id, title text, body text, visibility text, moderation_status text, version integer, deleted_at timestamptz? | Author FK to exact community membership; public/members/hidden visibility; visible/hidden moderation status. |
| post_comments | id, tenant_id, community_id, post_id, author_user_id, body text, moderation_status text, version integer, deleted_at timestamptz? | Community-qualified post and author-membership FKs. Flat comments for MVP. |
| content_reports | id, tenant_id, community_id, reporter_user_id, post_id?, comment_id?, reason_code text, details text?, status text, resolved_at timestamptz? | Exactly one target with community-qualified FK. Open/reviewing/resolved/dismissed; partial unique reporter/target while open/reviewing. |
| moderation_actions | id, tenant_id, community_id, report_id?, post_id?, comment_id?, actor_user_id, action text, reason text | Append-only; exactly one target; hide/restore/dismiss_report. If report provided, constraint trigger enforces same report target. |

Community creator receives community ownership atomically; last-owner removal locks community. Only community owner decides membership requests per US-02. Approval and member insertion/reactivation commit together. Community owners/moderators access their exact queue; workspace membership is not moderation permission.

Public posts require public nonarchived parent and visible nondeleted post. Private metadata discovery must use an explicitly approved projection; hidden communities never appear publicly. Public/private/hidden rules apply identically to lists and detail views. Authenticated users can report content they can access, without requiring membership. Reporter identity is available only to reporter and authorized moderators, never ordinary members. An admin managing workspace lifecycle does not automatically gain private community content access.

## Jira-like project and Kanban data

| Table | Fields | Keys and constraints |
| --- | --- | --- |
| projects | id, tenant_id, key text, name text, description text?, lead_user_id?, next_issue_number bigint, archived_at timestamptz? | UNIQUE (tenant_id,key); lead workspace-member FK; allocate positive issue numbers under project row lock. |
| boards | id, tenant_id, project_id, name text, version integer | UNIQUE (tenant_id,project_id): one board per project. |
| issue_statuses | id, tenant_id, project_id, name text, category text, position numeric(20,6), wip_limit integer? | UNIQUE (tenant_id,project_id,name); backlog/todo/in_progress/done; optional positive WIP limit. Status is board column. |
| workflow_transitions | id, tenant_id, project_id, from_status_id, to_status_id | Unique project/endpoints; distinct statuses within same project. |
| issues | id, tenant_id, project_id, number bigint, type text, parent_issue_id?, title text, description text?, status_id, priority text, reporter_user_id, assignee_user_id?, team_id?, sprint_id?, position numeric(20,6), story_points numeric(8,2)?, start_date date?, due_date date?, completed_at timestamptz?, version integer, archived_at timestamptz? | UNIQUE (tenant_id,project_id,number); epic/story/task/bug/subtask; lowest/low/medium/high/highest priority. Nonnegative points, due >= start. Status/parent/sprint same-project FKs; users/teams same-tenant FKs. |
| issue_labels | id, tenant_id, project_id, name text, color text | UNIQUE (tenant_id,project_id,name). |
| issue_label_links | tenant_id, project_id, issue_id, label_id | PK all fields; project-qualified FKs. |
| issue_comments | id, tenant_id, project_id, issue_id, author_user_id, body text, version integer, deleted_at timestamptz? | Issue project FK and author workspace-member FK. |
| issue_links | id, tenant_id, project_id, source_issue_id, target_issue_id, type text | Unique project/endpoints/type; no self-link; blocks/relates_to. Canonical pair for relates_to. |
| sprints | id, tenant_id, project_id, name text, goal text?, starts_at timestamptz?, ends_at timestamptz?, status text | Planned/active/completed/cancelled; end > start; active requires both. Partial UNIQUE project WHERE active. |
| issue_events | id, tenant_id, project_id, issue_id, actor_user_id, event_type text, from_version integer, to_version integer, changes jsonb | Append-only; UNIQUE (tenant_id,issue_id,to_version); to = from + 1, creation 0 -> 1. Allowlisted diffs. |

Hierarchy: epic has no parent; story/task/bug optionally belong to epic; subtask requires story/task/bug parent. Constraint triggers validate parent type, same project, and acyclicity including parent-type updates. No arbitrary-depth subtasks. Blocking links are not claimed to be a DAG or critical-path scheduler.

Issue changes validate current membership, assignee membership, transition and expected version; update issue, append history and insert outbox in one transaction. Stale versions reject rather than overwrite. Serialize WIP admission on board: every create/move/archive/unarchive/limit edit follows this protocol; count nonarchived issues and reject a limit below occupancy. Lock project before board consistently. Rebalance positions transactionally; completed_at follows status category. Sprint completion reassigns unfinished issues and records history atomically.

MVP uses projects, board/statuses, issues and events. Sprints, hierarchy, labels, configurable transitions and dependencies are incremental extensions. Custom fields, worklogs, uploads and rich realtime collaboration remain deferred.

## Schedule control

| Table | Fields | Keys and constraints |
| --- | --- | --- |
| calendar_events | id, tenant_id, project_id?, issue_id?, organizer_user_id, title text, description text?, location text?, starts_at timestamptz, ends_at timestamptz, timezone text, status text, version integer | End > start; scheduled/cancelled/completed. Issue requires project and project-qualified FK. Organizer workspace-member FK. |
| event_attendees | tenant_id, event_id, user_id, response text, responded_at timestamptz? | PK (tenant_id,event_id,user_id); workspace-member FK. Pending/accepted/declined/tentative. |
| event_reminders | id, tenant_id, event_id, user_id, event_version integer, minutes_before integer, channel text, scheduled_for timestamptz, status text, sent_at timestamptz? | FK to attendee triple; UNIQUE event/user/version/offset/channel within tenant. Nonnegative offset; in_app/email; pending/queued/sent/cancelled. |

Initially support timed, nonrecurring workspace-visible events. Organizer or owner/admin edits; attendee edits own response only. Update/cancel increments version and cancels pending old-version reminders transactionally. Due reminders create outbox events atomically; worker checks current event version/status and membership before delivery. External delivery can race later cancellation; no perfect cancellation guarantee.

Recurrence and all-day events are deferred: later model local DTSTART/timezone, RRULE, occurrence keys and exceptions; date-only exclusive-end ranges for all-day events. Never repeat local days by adding 24 hours to UTC. Availability, room booking conflict prevention and Google Calendar sync need separate stories.

## Subscription and discount promotions

Additional user-requested scope. No provider, prices or commercial plan names are specified by context.

| Table | Fields | Keys and constraints |
| --- | --- | --- |
| subscription_plans | id, code text, name text, description text?, is_active boolean | Global catalog; UNIQUE code; archive referenced plans. |
| plan_prices | id, plan_id, currency text, amount_minor bigint, billing_interval text, interval_count integer, provider text?, provider_price_id text?, is_active boolean | Global immutable price terms; month/year; positive interval count; paired provider fields; UNIQUE provider/external price when present. |
| plan_entitlements | plan_id, feature_key text, enabled boolean, limit_value bigint? | Global PK (plan_id,feature_key). NULL unlimited, zero zero; nonnegative. Server-owned feature allowlist. |
| billing_customers | id, tenant_id, provider text, provider_customer_id text | UNIQUE (tenant_id,provider); UNIQUE (provider,provider_customer_id). |
| subscriptions | id, tenant_id, billing_customer_id?, plan_id, price_id?, provider text?, provider_subscription_id text?, status text, period_start timestamptz?, period_end timestamptz?, trial_ends_at timestamptz?, cancel_at_period_end boolean, cancelled_at timestamptz?, version integer | Incomplete/trialing/active/past_due/paused/cancelled/expired. Partial UNIQUE tenant for all nonterminal states. Price belongs to plan; customer belongs to tenant. UNIQUE provider/external ID when present. Paired ordered periods. |
| invoices | id, tenant_id, subscription_id, provider text, provider_invoice_id text, currency text, subtotal_minor bigint, discount_minor bigint, tax_minor bigint, total_minor bigint, status text, issued_at timestamptz, due_at timestamptz?, paid_at timestamptz? | UNIQUE provider/external ID. Total = subtotal - discount + tax; discount <= subtotal. Draft/open/paid/void/uncollectible. Preserve finalized totals. |
| payment_events | id, provider text, provider_event_id text, tenant_id?, received_at timestamptz, provider_occurred_at timestamptz?, payload jsonb, status text, attempts integer, processed_at timestamptz?, last_error_code text? | Restricted webhook inbox, not ordinary tenant data. UNIQUE provider/event. Pending/processed/failed. Tenant nullable until server resolves provider references. |
| promotions | id, code_normalized text, name text, discount_type text, percent_bps integer?, amount_minor bigint?, currency text?, starts_at timestamptz, ends_at timestamptz, max_redemptions bigint?, max_per_tenant integer, duration_cycles integer, is_active boolean | Global private catalog; UNIQUE code. Percent requires 1..10000 basis points and no fixed fields; fixed requires positive amount/currency and no percent. End > start; positive caps/duration. |
| promotion_prices | promotion_id, price_id | Global PK both fields; explicit eligibility list; empty eligible nowhere. Fixed discount currency must match price. |
| promotion_redemptions | id, tenant_id, promotion_id, subscription_id, redeemed_by_user_id, idempotency_key text, status text, reserved_until timestamptz, applied_at timestamptz?, provider_checkout_id text?, terms_snapshot jsonb | UNIQUE (tenant_id,idempotency_key); reserved/applied/released; tenant subscription FK; immutable approved terms snapshot. |

Paid subscriptions require customer, price and provider IDs with matching providers, enforced with composite FKs/constraints. Internal free subscriptions omit them and reference the server-managed free plan. Price terms are immutable; changed terms create a new price. Entitlement edits affect existing subscribers; version plans before offering grandfathering. Invoices retain their own currency/totals; do not store card details. Refunds, credit notes and tax computation are separate requirements before offering those operations.

Checkout reserves discounts under promotion and subscription locks in deterministic order. Count applied and unexpired reserved rows against global/per-tenant caps; validate eligibility, currency, period and one live promotion per subscription. Transition expired reservations to released under the same protocol. Snapshot approved terms, then call provider outside transaction with stable idempotency key. Late completion after reservation expiry requires reconciliation; never exceed caps silently. Provider state and usage records must reconcile before retrying a failed checkout.

No paid access from browser redirects or client-supplied plan/status. Verify webhook signatures, resolve tenant using stored provider IDs, deduplicate and update subscription transactionally. Serialize updates and retrieve authoritative provider state for out-of-order events. Restricted billing workers own inbox access. Owner/admin accesses billing; server enforces entitlements. Define grace/past-due/paused/incomplete access policy before implementation.

Quota admission locks workspace and checks committed counts on every relevant create/invite-accept operation. Active workspace members consume seats; community-only members do not. Cached usage is not authoritative. Storage quota waits for uploads. Promotion catalogs and webhook bodies are not public read tables; payload retention and redaction are required.

Paid startup discovery is also requested: [promotion schema](promotion-schema.md) specifies plans, placements, campaigns, orders, invoices, reviews and aggregate metrics. Its first version uses fixed-duration, nonexclusive placements; subscription discount tables remain separate.

## Notifications, outbox and audit

| Table | Fields | Keys and constraints |
| --- | --- | --- |
| outbox_events | id, tenant_id, event_type text, aggregate_type text, aggregate_id uuid, aggregate_version integer, payload jsonb, available_at timestamptz, attempts integer, locked_until timestamptz?, lock_token uuid?, processed_at timestamptz?, last_error_code text? | UNIQUE tenant/aggregate type/ID/version/event type. Insert with business transaction. Internal aggregate reference, not an authorization grant. |
| notifications | id, tenant_id, recipient_user_id, outbox_event_id, kind text, title text, body text?, resource_type text, resource_id uuid, read_at timestamptz? | UNIQUE tenant/event/recipient/kind; event tenant FK. Recipient user FK, not workspace membership: community members and invitees may lack it. |
| notification_preferences | user_id, kind text, channel text, enabled boolean | Global user-private PK user/kind/channel; in_app/email; own-user access. Server kind allowlist. |
| notification_deliveries | id, tenant_id, notification_id, channel text, status text, attempts integer, next_attempt_at timestamptz?, provider_message_id text?, delivered_at timestamptz? | UNIQUE tenant/notification/channel; tenant FK. Pending/sent/failed/suppressed; stable delivery ID for provider deduplication. |
| audit_events | id, tenant_id, actor_user_id?, actor_kind text, action text, resource_type text, resource_id uuid, request_id text?, metadata jsonb | Append-only; user/system actor, user requires actor ID. Restricted allowlisted metadata; moderation history separately scoped. |
| idempotency_requests | id, tenant_id, actor_user_id, operation text, key text, request_hash bytea, state text, resource_id uuid?, response_status integer?, expires_at timestamptz | UNIQUE tenant/actor/operation/key. Started/completed. Same key with different hash returns 409. Reauthorize retries; avoid sensitive response snapshots. |

Workers claim bounded batches using SKIP LOCKED with expiring lease and conditional acknowledgement by lock token. Stale workers cannot acknowledge newer claims. Bounded retries expose exhaustion operationally. Notification fan-out and outbox acknowledgement commit together. External email delivery is at-least-once with provider deduplication where supported, not exactly-once.

Each notification read/delivery, including unread counts, checks recipient and current target authorization. Minimal generic text prevents revoked members from reading cached post/report details. Invitation notifications authorize intended recipient against invitation state, not workspace membership. Email jobs containing invitation tokens use restricted encrypted payloads and short retention. Account recovery email belongs to the authentication subsystem, not a fabricated tenant. Mandatory security notices cannot be disabled.

## Authorization and RLS implementation contract

Enable and force RLS when introducing tenant/user-private tables. Ordinary runtime role is not table owner, superuser or BYPASSRLS. Separate migration owner and narrow authentication/billing/worker adapters. Do not grant product runtime broad worker privileges.

Backend derives actor from active opaque session and sets the transaction-local session token hash (`spark.session_token_hash`) on the same connection/transaction as queries; workspace policies resolve the actor and its workspaces from that session (see `0014`). Missing context denies access; never trust actor/tenant headers as authorization. Custom settings assume trusted backend SQL and are not protection against arbitrary runtime SQL execution.

Policies use both USING and WITH CHECK with operation-specific permissions:

- Workspace resources require active workspace membership resolved from the live session (`session_workspace_ids()`). RLS shows rows of every workspace the session may read; narrowing to the selected workspace is an application-level filter, not a security boundary. Administrative/billing writes require owner/admin.
- Community resources require exact-community membership or explicit public visibility path; workspace membership alone is insufficient.
- Public discovery exposes only public nonarchived community fields and opted-in startup projection. An invoker-RLS view or narrowly reviewed projection function must not bypass visibility through owner privileges.
- Membership roles cannot be self-escalated. Workspace bootstrap uses a narrowly scoped transaction that cannot create ownership in an existing tenant.
- Reports require own-reporter or exact-community moderation authorization; general members cannot read identities.
- Notifications require recipient plus current target access; preferences are own-user only.
- Credential/token/session lookup is limited to authentication adapter; account settings use narrow self-service projections.
- Cross-tenant connections authorize endpoint and action explicitly. They never imply content access.
- Public plan/price projection excludes promotion secrets; catalog writes and webhook ingestion use restricted roles.

Avoid recursive membership policies. Any SECURITY DEFINER helper needs private schema, fixed search_path, qualified names, explicit actor validation, minimal privileges and restricted EXECUTE grants. Do not copy Supabase auth.uid() into this Fastify opaque-session application. Test context reset after commit, rollback, error and cancellation with reused pooled connections.

## Indexes, transactions and delivery

Add indexes supporting FK leading columns, excluding duplicates already covered by PK/UNIQUE. Important access indexes:

| Access | Index |
| --- | --- |
| User workspaces/communities | workspace_memberships (user_id,status,tenant_id); community_memberships (user_id,status,tenant_id,community_id) |
| Discovery | communities (created_at,id) WHERE public and not archived; GIN search vector on name/description with explicitly selected language configuration |
| Topic filter | community_topics (topic_id,tenant_id,community_id) |
| Feeds | posts (tenant_id,community_id,created_at,id); post_comments (tenant_id,community_id,post_id,created_at,id) |
| Moderation | content_reports (tenant_id,community_id,status,created_at,id) |
| Board | issues (tenant_id,project_id,status_id,position,id) WHERE not archived |
| Assigned deadlines | issues (tenant_id,assignee_user_id,due_date,id) WHERE not archived |
| Issue history | issue_events (tenant_id,issue_id,created_at,id) |
| Calendar/reminders | calendar_events (tenant_id,starts_at,id); event_reminders (scheduled_for,id) WHERE pending |
| Unread inbox | notifications (recipient_user_id,tenant_id,created_at,id) WHERE unread |
| Outbox | outbox_events (available_at,id) WHERE unprocessed |
| Auth cleanup/revocation | sessions (user_id,revoked_at), sessions (expires_at), account_tokens (expires_at) |
| Connections | startup_connections (recipient_tenant_id,status,created_at,id), matching requester index |
| Promotion caps | promotion_redemptions (promotion_id,status,reserved_until,tenant_id) |

Index predicates above are descriptive, not executable SQL. No time-dependent now() partial predicate. All FK indexes/candidate keys need a complete manifest in the actual migration. Deterministic pagination includes ID even when sorting by relevance. Start with PostgreSQL search; no new search infrastructure.

Atomic units: workspace+owner; invitation+membership+outbox; join decision+membership; issue+version+history+outbox; event+replacement reminders; fan-out+outbox acknowledgement; subscription+webhook completion; promotion reservation+cap validation. Document deterministic cross-module lock order. External calls occur after commit/outside SQL transactions.

Delivery order:

1. Users/credentials/identities/sessions and workspace isolation. Add Drizzle with the first actual schema/migration under Spark_Core/backend; current package has pg but no migration script.
2. Communities, discovery, membership, posts/comments, invitations, moderation and initial task management.
3. Outbox with first reliable external effect; notification storage with US-06.
4. Jira extensions, startup connections, schedule and billing/discounts as separate slices. Paid advertising follows the companion promotion design; recurrence, uploads and advanced collaboration remain deferred.

Required implementation checks: empty and upgrade migrations; cross-tenant/wrong-project FK rejection; runtime-role RLS for two tenants and pooled connection reuse; hidden/private list-detail parity; owner removal/invitation/join/issue/WIP/promotion/quota concurrency; password reset and session revocation; OAuth collision linking; webhook duplicates/reordering; worker lease expiry/retries; notification visibility after membership removal; archive/redaction and transaction rollback. Document migration recovery.

These runtime checks have not run for this design-only change. Independent review supports the proposal but cannot prove implemented isolation, authentication, billing correctness or production readiness.

Authentication implementation also requires CSRF protection for cookie-authenticated mutations (validated origin plus CSRF tokens as applicable), immediate denial for suspended/deleted accounts and server-side session revocation. Login, recovery, and verification rate limiting fail closed during Redis unavailability with a safe service-unavailable response; health remains unaffected. These policies need integration tests before auth is enabled.
