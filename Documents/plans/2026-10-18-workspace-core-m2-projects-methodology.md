# Workspace core M2 — Projects and methodology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workspace owner or admin creates a project and chooses **Scrum, Kanban or Waterfall**; Spark seeds the matching board columns, planning structure (sprint length, or phases with baselines and sign-off milestones) and suggested practices, and every member can open the project's overview.

**Architecture:** Migration 0017 extends `projects`/`issues`/`sprints` and adds `project_phases`, `project_milestones`, `sprint_commitments` and `project_methodology_periods`, all tenant-scoped with session-bound RLS. Writes go through SECURITY DEFINER `spark.ws_create_project` / `spark.ws_update_project`. Methodology templates live in one TypeScript module (`src/modules/work/domain/methodology.ts`), served by a public endpoint and used by the server to build default statuses/phases. The frontend renders the picker entirely from that endpoint.

**Tech Stack:** PostgreSQL 18 (hand-written SQL migrations + Drizzle schema mirror), Fastify 5 JSON-schema routes, pg, Vitest; Next.js 16.3 / React 19 client components, plain global CSS, Vitest + Testing Library.

**Spec:** `Documents/product/workspace-core-design.md` (sections "Methodology templates", "Methodology switching", milestone M2). Migration numbers in the spec are indicative; **M2 uses `0017`**.

## How to run this plan in a new session

- Read first: `AGENTS.md`, this plan, the spec sections above, `Documents/architecture/rest-clean-compliance.md`, `Documents/architecture/database-schema.md` (sections for 0014–0016), `Documents/automation/independent-review.md`.
- Branch: continue on `feat/workspace-core` (M0 + M1 are committed there, tip `fc1f2a4`; nothing merged or pushed). Do not push or merge without the user.
- Execute with superpowers:subagent-driven-development: one implementer per task, a task reviewer after each, a ledger in `.superpowers/sdd/<plan>/progress.md`, and a final whole-branch review. **Tasks 1 and 2 (migration, RLS, definer functions) need two independent first-pass reviewers — correctness and security — dispatched in parallel on the same diff** (no `spark-*-reviewer` agent type exists; use general-purpose agents briefed with `Documents/automation/independent-review.md`). Other tasks: one reviewer, with a security lens for routes.
- Local environment (verified at the end of M1): PostgreSQL 18 on 127.0.0.1:5432 with roles `spark_owner/spark_migrator/spark_app/spark_auth/spark_worker` (no admin password needed for M2); Redis and Mailpit run in Docker (`pnpm infra:up` in `Spark_Core`); `pnpm db:migrate` in `Spark_Core/backend` applies migrations. Dev ports: frontend 3000, API 4000, auth 4100.
- Lessons from M1 to put in every dispatch: keep LF line endings (`core.autocrlf=false`); never `git add` `.superpowers`; after shell work run `git status` — stray empty files named like code fragments (e.g. `[{`, `div`) have appeared at the repo root from quoting slips and must be removed, never committed; stop every dev server/worker you start and verify ports 3000/4000/4100 are free; restore `frontend/next-env.d.ts` if `next dev` rewrote it; the workspace-create route is rate limited 5/hour per IP — in local E2E runs you may delete only the local Redis key for that route; for browser checks install `playwright-core` into a scratch directory, never as a project dependency.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Global Constraints

- English only in code, copy, docs, commits (AGENTS.md).
- REST rules from `rest-clean-compliance.md`: problem+json errors through `problem()` (`src/routes/responses.ts`); `Cache-Control: private, no-store` on every authenticated response; 201 + `Location` + `ETag` on create; `If-Match` required on PATCH (missing → 428 `precondition_required`, malformed → 400 `invalid_if_match`, stale → 412 `version_mismatch` with body `current` via `preconditionFailed`); origin guard applies to non-GET routes; validation by Fastify JSON schema with `additionalProperties: false`.
- Runtime role `spark_app` gets no INSERT/UPDATE/DELETE grants. Writes are `spark.ws_*` functions: `LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''`, `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO spark_app`; actor = `spark.require_session_actor()`; authority via the existing internal helper `spark.lock_workspace_role(p_tenant, p_actor)` (locks the workspace row, returns the actor's active role or NULL); audit via `spark.record_workspace_audit(tenant, actor, action, resource_type, resource_id, metadata)`. Non-members → outcome `not_found`; members lacking the role → `forbidden`. Input violations raise ERRCODE `22023` with a whitelisted message (below).
- Lock order everywhere: workspace → project → board → statuses → phases/milestones.
- New tenant tables: `FORCE ROW LEVEL SECURITY`, policy `owner_maintenance` (to `spark_owner`, `USING (true) WITH CHECK (true)`), policy `workspace_read` `FOR SELECT TO spark_app USING (tenant_id = ANY ((SELECT spark.session_workspace_ids())::uuid[]))` (the `::uuid[]` cast is required), `GRANT SELECT … TO spark_app`, `UNIQUE (tenant_id, id)`, composite FKs `(tenant_id, project_id) → projects(tenant_id, id)`, an index for every FK's leading columns, `ON DELETE RESTRICT`.
- Project key: `^[A-Z][A-Z0-9]{1,9}$`, unique per workspace. Name trimmed 1–80. Description ≤ 2000. Methodology ∈ `scrum|kanban|waterfall`. Sprint length 7–28 days (Scrum only, default 14; NULL otherwise). Waterfall requires `startDate` and `targetDate` with `targetDate ≥ startDate`. Max 50 non-archived projects per workspace.
- Statuses: 2–12, names trimmed 1–40 and unique case-insensitively, category ∈ `backlog|todo|in_progress|done`, at least one `done` and one non-`done`, `wipLimit` NULL or 1–99. Phases (Waterfall only, required 1–12): names trimmed 1–60, contiguous order, `plannedStart ≤ plannedEnd`, each within the project dates, non-overlapping in order.
- Roles: create project = workspace `owner|admin`; update project = `owner|admin` or the project lead; read = any active member. Methodology is **not** editable in M2 (switching is M4).
- Rate limits: project create 20/hour; project PATCH 30/min (`MUTATION_RATE_LIMIT`); `GET /methodologies` unlimited by route config beyond the global limiter.
- Frontend visual language = landing page and the M1 workspace screens (`globals.css` tokens; `.sparkPrimary`, `.sparkSecondary`, `.sparkKicker`, pastel tags, initials avatars, `ws*` classes from M1). Methodology accent colors: Scrum `#2563eb`, Kanban `#1baf7a`, Waterfall `#d97706`. No new dependencies. Read `Spark_Core/frontend/node_modules/next/dist/docs/` before writing routes (frontend/AGENTS.md).
- Commands — backend (`Spark_Core/backend`): `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:database`, `pnpm build`. Frontend (`Spark_Core/frontend`): `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. Never report an unrun check as passing.

`22023` whitelist additions (add to `WORKSPACE_INPUT_ERRORS` in `src/routes/workspace/guard.ts`): `Invalid project key`, `Invalid project name`, `Invalid project description`, `Invalid methodology`, `Invalid project dates`, `Invalid sprint length`, `Invalid project statuses`, `Invalid project phases`.

## Review Focus

1. Waterfall dates too short for its phases (e.g. 3 days for 5 phases), or target before start → a clear 400 naming the problem, and the picker prevents submitting → tests in Task 3 (`spreadPhases` rejects) and Task 5 (form shows the inline error).
2. The same project key in two different workspaces is allowed; a duplicate key inside one workspace returns 409 `key_taken` → DB test in Task 2, route test in Task 4.
3. A plain member opens `/w/{slug}/projects/new` → they see "Only owners and admins can create projects" instead of a form that fails on submit → FE test in Task 5.
4. Projects created before M2 (seed data, older rows without a board or methodology) still list and open, shown as Kanban, with a methodology period row → migration test in Task 1, route test in Task 4.
5. Two people edit project settings at once → the second gets 412 and the UI shows "Updated by a teammate" with the fresh values instead of silently overwriting → API test in Task 4, FE test in Task 6.

---

### Task 1: Project methodology schema (migration 0017)

**Files:**
- Create: `Spark_Core/backend/drizzle/0017_project_methodology.sql`
- Modify: `Spark_Core/backend/drizzle/meta/_journal.json` (idx 17, `"version": "7"`, `when` 1792310000000, tag `0017_project_methodology`, `breakpoints: true`)
- Modify: `Spark_Core/backend/src/infrastructure/database/schema.ts` (mirror new columns/tables)
- Modify: `Spark_Core/backend/tests/database/schema.integration.ts`
- Modify: `Documents/architecture/database-schema.md` (0017 section)

**Interfaces (SQL):**
- `projects` add: `methodology text NOT NULL DEFAULT 'kanban'` CHECK `IN ('scrum','kanban','waterfall')`; `start_date date`; `target_date date`; CHECK `target_date >= start_date`; `sprint_length_days integer` CHECK `BETWEEN 7 AND 28` and CHECK `(methodology = 'scrum') OR sprint_length_days IS NULL`; `settings_version integer NOT NULL DEFAULT 1` CHECK `> 0`; `baselined_at timestamptz`. **Do not add a `version` column to `projects`** — `spark.maintain_record` would force every update (including M3's `next_issue_number` allocation) to bump it; `settings_version` is bumped explicitly by `ws_update_project` only.
- `issues` add: `started_at timestamptz`; `phase_id uuid` with FK `(tenant_id, project_id, phase_id) → project_phases(tenant_id, project_id, id)` and index `(tenant_id, project_id, phase_id)`.
- `sprints` add: `version integer NOT NULL DEFAULT 1` CHECK `> 0`; `started_at timestamptz`; `completed_at timestamptz`; `committed_points numeric(10,2)`; `committed_count integer`; `completed_points numeric(10,2)`; `completed_count integer` (all non-negative CHECKs).
- New `project_phases(id uuid pk default gen_random_uuid(), created_at, updated_at timestamptz default now(), tenant_id uuid not null, project_id uuid not null, name text not null [trimmed 1–60], position integer not null [≥ 1], planned_start date not null, planned_end date not null [≥ planned_start], baseline_start date, baseline_end date [both NULL or both set, end ≥ start], status text not null default 'planned' [IN ('planned','active','completed')], completed_at timestamptz, version integer not null default 1)`; UNIQUE `(tenant_id, project_id, id)`, UNIQUE `(tenant_id, project_id, position)`.
- New `project_milestones(id, created_at, updated_at, tenant_id, project_id, phase_id uuid null [FK (tenant_id, project_id, phase_id) → project_phases], name text [1–80], due_date date not null, baseline_due_date date, completed_at timestamptz, version integer not null default 1)`; UNIQUE `(tenant_id, project_id, id)`.
- New `sprint_commitments(tenant_id, sprint_id, issue_id, story_points numeric(8,2), created_at timestamptz default now())`, PK `(tenant_id, sprint_id, issue_id)`, FKs to `sprints(tenant_id, id)` and `issues(tenant_id, id)`; append-only via existing `spark.reject_history_change()` (`append_only` trigger BEFORE UPDATE OR DELETE).
- New `project_methodology_periods(id, tenant_id, project_id, methodology text [same CHECK], started_at timestamptz not null default now(), ended_at timestamptz [> started_at], changed_by_user_id uuid not null [FK users], reason text not null [1–200])`; partial UNIQUE `(tenant_id, project_id) WHERE ended_at IS NULL`; UPDATE allowed only to set `ended_at` from NULL (trigger `period_close_only` raising 23514 otherwise); DELETE rejected.
- `maintain_record` trigger created explicitly on `project_phases` and `project_milestones` (the 0002 loop only covered tables existing then). `guard_issue` (0002) `CREATE OR REPLACE`d to also set `NEW.started_at := COALESCE(OLD.started_at/NEW.started_at, statement_timestamp())` the first time the issue's status category is `in_progress` (keep every existing check unchanged).
- RLS per Global Constraints on the four new tables; grants SELECT to spark_app.
- Backfill in the migration: for every existing project, insert one open `project_methodology_periods` row (`methodology` = 'kanban', `changed_by_user_id` = the workspace's `created_by_user_id`, `reason` = 'Backfilled at migration 0017').

- [ ] **Step 1: Failing DB tests** in `schema.integration.ts`:
  - Update `migrates 61 tables…` to `65`.
  - Update the exact `pg_policies` inventory test with the four new tables (`owner_maintenance`, `workspace_read`).
  - `seeds methodology defaults on existing projects`: after migration, a pre-existing fixture project has `methodology='kanban'`, `settings_version=1`, and exactly one open period row.
  - `isolates the new project tables by session`: as tokenA (tenant A member) `SELECT` on each new table returns only tenant A rows; tokenB sees none of A's; no session sees none.
  - `rejects cross-project phase links`: an issue in project A with `phase_id` of project B's phase → 23503.
  - `keeps commitments and periods append-only`: UPDATE/DELETE on `sprint_commitments` → 23514; updating a period's `methodology` → 23514; setting `ended_at` once succeeds; second open period for the same project → 23505.
  - `stamps started_at on first in-progress move`: moving a fixture issue (with its required event/outbox rows, as existing issue tests do) into an `in_progress` status sets `started_at`; moving it back to `todo` keeps it.
  - `enforces methodology-specific project fields`: `sprint_length_days = 14` on a kanban project → 23514; scrum with 30 → 23514.
- [ ] **Step 2: Run** `pnpm test:database` → new/changed tests FAIL.
- [ ] **Step 3: Write migration 0017**, journal entry, `schema.ts`.
- [ ] **Step 4: Run** `pnpm test:database`, `pnpm test`, `pnpm typecheck`, `pnpm lint` → pass; `pnpm db:migrate` applies cleanly to the local database (which holds pre-M2 data).
- [ ] **Step 5: Update `database-schema.md`, commit** `feat(db): project methodology schema`.
- [ ] **Review gate:** correctness + security reviewers in parallel.

### Task 2: Project write functions

**Files:**
- Create: `Spark_Core/backend/drizzle/0018_project_writes.sql`; journal idx 18 (`"version": "7"`, `when` 1792320000000, tag `0018_project_writes`, `breakpoints: true`)
- Modify: `Spark_Core/backend/tests/database/schema.integration.ts`

**Interfaces (SQL, granted to spark_app):**
- `spark.ws_create_project(p_workspace uuid, p_key text, p_name text, p_description text, p_methodology text, p_lead uuid, p_start date, p_target date, p_sprint_length int, p_statuses jsonb, p_phases jsonb) RETURNS TABLE(outcome text, project_id uuid, settings_version int)` — outcomes `ok | not_found | forbidden | key_taken | invalid_lead | too_many_projects`. Owner/admin only. Validates everything in Global Constraints (22023 messages from the whitelist). `p_statuses` = JSON array of `{name, category, wipLimit}` in board order; `p_phases` = JSON array of `{name, plannedStart, plannedEnd}` (must be `[]` unless waterfall, 1–12 for waterfall). In one transaction inserts: project; board (`name` = project name); statuses with `position = 1024 * i` (1-based); for waterfall the phases (`position` 1..n, baselines = planned, `status` 'planned') and one milestone per phase (`name` = `<phase name> sign-off`, `phase_id`, `due_date` = `baseline_due_date` = phase `planned_end`) and `projects.baselined_at = now()`; one open methodology period (`reason` 'Project created'); audit `project.created` with `{methodology, key}`. Lead must be an active member of the workspace (NULL allowed).
- `spark.ws_update_project(p_project uuid, p_expected_version int, p_patch jsonb) RETURNS TABLE(outcome text, settings_version int)` — outcomes `ok | not_found | forbidden | version_mismatch | invalid_lead`. Allowed patch keys: `name`, `description`, `leadUserId`, `startDate`, `targetDate`, `sprintLengthDays` (the API schema rejects any other key, including `methodology`, before SQL; in SQL any other key raises 22023 `Invalid project name` as a defensive fallback). Each present key is validated with its own whitelisted message. Owner/admin or the project's current lead. On success `settings_version + 1`, audit `project.updated` with `{changed: [keys]}`. Waterfall projects must keep both dates and every phase still inside the new date range, else 22023 `Invalid project dates`. `sprintLengthDays` only for scrum, else 22023 `Invalid sprint length`.

- [ ] **Step 1: Failing DB tests:**
  - `creates projects with their methodology structure`: Scrum → 5 statuses in order (positions 1024…5120), `sprint_length_days` 14, no phases; Kanban → 5 statuses with WIP 8/4/3 on Ready/In progress/Review; Waterfall (2026-11-02 → 2026-12-11) → 4 statuses, 5 phases with baselines equal to planned dates, 5 milestones named `Requirements sign-off` … `Deploy sign-off`, `baselined_at` set; each → one open period and one `project.created` audit row.
  - `guards project creation`: member → `forbidden`; stranger → `not_found`; duplicate key in same workspace → `key_taken`; same key in another workspace → `ok`; lead from another workspace → `invalid_lead`; 51st project → `too_many_projects`; key `ab` → 22023 `Invalid project key`; waterfall without dates → 22023 `Invalid project dates`; statuses without a `done` → 22023 `Invalid project statuses`; phases for kanban → 22023 `Invalid project phases`; no session → 28000.
  - `updates project settings with optimistic version`: lead (non-admin member) can rename; stale version → `version_mismatch` with current version; waterfall target moved before the last phase end → 22023; `settings_version` increments by one; issuing many UPDATEs of `next_issue_number` as owner does **not** change `settings_version`.
  - Update the runtime-function allowlist test with `ws_create_project`, `ws_update_project`.
- [ ] **Step 2: Run** `pnpm test:database` → FAIL. **Step 3: Write the migration.** **Step 4: Run** `pnpm test:database`, `pnpm test`, `pnpm typecheck`, `pnpm lint` → pass.
- [ ] **Step 5: Commit** `feat(db): project create and update functions`.
- [ ] **Review gate:** correctness + security reviewers in parallel.

### Task 3: Methodology templates and the public catalog endpoint

**Files:**
- Create: `Spark_Core/backend/src/modules/work/domain/methodology.ts`, `src/modules/work/domain/phases.ts`, `src/routes/workspace/methodologies.ts` (registered from `src/routes/workspace/index.ts`)
- Test: `tests/methodology.test.ts`, `tests/workspace-methodologies.test.ts`

**Interfaces:**
- `type Methodology = "scrum" | "kanban" | "waterfall"`; `type StatusCategory = "backlog" | "todo" | "in_progress" | "done"`.
- `interface StatusTemplate { name: string; category: StatusCategory; wipLimit: number | null }`.
- `interface MethodologyTemplate { id: Methodology; name: string; tagline: string; bestFor: string; planningObject: string; practices: string[]; metrics: string[]; statuses: StatusTemplate[]; defaults: { sprintLengthDays: number | null; phaseNames: string[] } }`.
- `export const METHODOLOGIES: readonly MethodologyTemplate[]` (order scrum, kanban, waterfall) and `getMethodology(id: Methodology): MethodologyTemplate`.
- `phases.ts`: `spreadPhases(startDate: string, targetDate: string, names: string[]): Array<{ name: string; plannedStart: string; plannedEnd: string }>` — inclusive day count `D`; phase `i` (0-based) spans day offsets `floor(i*D/n)` … `floor((i+1)*D/n) - 1`; throws `RangeError("Invalid project dates")` when `D < n` or target < start. Dates are ISO `YYYY-MM-DD`, computed in UTC.
- `GET /api/v1/methodologies` → `200 { items: MethodologyTemplate[] }`, no session needed, `Cache-Control: public, max-age=3600`.
- Exact template content:

| | Scrum | Kanban | Waterfall |
|---|---|---|---|
| tagline | Ship in short, focused sprints. | Keep work flowing, one card at a time. | Plan the phases, then deliver them in order. |
| bestFor | Product teams iterating on a backlog with regular releases. | Teams with a steady stream of incoming work — support, ops, continuous delivery. | Fixed-scope projects with a deadline — client work, launches, compliance. |
| planningObject | Sprints of 1–4 weeks with a goal and story points. | A continuous board with work-in-progress limits per column. | Sequential phases with baseline dates and a sign-off milestone each. |
| practices | Refine the backlog before each sprint · Commit to one sprint goal · Daily 15-minute stand-up · Review and retro at the end of every sprint | Pull work when you have capacity — don't push · Respect WIP limits to finish before starting · Make blockers visible and swarm them · Review flow metrics weekly | Agree the scope and dates up front · Sign off each phase before the next starts · Track variance against the baseline · Re-baseline only when scope changes |
| metrics | Sprint burndown · Velocity over the last 6 sprints · Commitment reliability · Scope creep | Weekly throughput · Cycle and lead time (p50 / p85) · Cumulative flow · WIP vs limit and aging work | Phase progress vs baseline · Schedule variance in days · Milestones hit, missed or at risk · Gantt timeline |
| statuses | Backlog (backlog) · To do (todo) · In progress (in_progress) · In review (in_progress) · Done (done) | Backlog (backlog) · Ready (todo, WIP 8) · In progress (in_progress, WIP 4) · Review (in_progress, WIP 3) · Done (done) | Not started (todo) · In progress (in_progress) · In review (in_progress) · Done (done) |
| defaults | sprintLengthDays 14, phaseNames [] | null, [] | null, [Requirements, Design, Build, Test, Deploy] |

- [ ] **Step 1: Failing tests:** every template satisfies the status rules (2–12, unique names, ≥1 done and ≥1 non-done, WIP 1–99 or null); exact Kanban WIP values; `spreadPhases("2026-11-02","2026-12-11", five names)` → Requirements 11-02…11-09, Design 11-10…11-17, Build 11-18…11-25, Test 11-26…12-03, Deploy 12-04…12-11; `spreadPhases("2026-11-02","2026-11-04", five names)` throws `Invalid project dates`; route returns 200 without a cookie, three items in order, `Cache-Control: public, max-age=3600`.
- [ ] **Step 2–4:** FAIL → implement → `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` pass.
- [ ] **Step 5: Commit** `feat(api): methodology catalog`.

### Task 4: Project routes

**Files:**
- Create: `Spark_Core/backend/src/routes/workspace/projects.ts` (registered from `index.ts`)
- Modify: `src/routes/workspace/guard.ts` (22023 whitelist additions)
- Test: `tests/workspace-projects.test.ts`

**Interfaces (base `/api/v1`):**
- `Project = { id, key, name, description: string|null, methodology, lead: { id, displayName } | null, startDate: string|null, targetDate: string|null, sprintLengthDays: number|null, baselinedAt: string|null, version: number /* = settings_version */, createdAt, progress: { total: number, done: number, open: number } }` — progress counts non-archived issues, `done` = status category done.
- `ProjectDetail = Project & { statuses: Array<{ id, name, category, position: number, wipLimit: number|null }>, phases: Array<{ id, name, position, plannedStart, plannedEnd, baselineStart: string|null, baselineEnd: string|null, status }>, milestones: Array<{ id, name, phaseId: string|null, dueDate, baselineDueDate: string|null, completedAt: string|null }> }` — statuses by position; phases by position; milestones by due date.
- `POST /workspaces/{workspaceId}/projects` body `{ key, name, description?, methodology, leadUserId?, startDate?, targetDate?, sprintLengthDays?, statuses?, phases? }` → 201 `ProjectDetail`, `Location: /api/v1/projects/{id}`, `ETag`. When `statuses` is omitted the server uses the template's statuses; when `phases` is omitted for waterfall it uses `spreadPhases(startDate, targetDate, defaults.phaseNames)` (a `RangeError` → 400 `invalid_input` "Invalid project dates."); when `sprintLengthDays` is omitted for scrum it uses 14. Outcomes: `key_taken`/`too_many_projects` → 409; `invalid_lead` → 422; `forbidden` → 403 `insufficient_role`; `not_found` → 404 `workspace_not_found`. Rate limit 20/hour.
- `GET /workspaces/{workspaceId}/projects` → `{ items: Project[] }` (non-archived, ordered by name); 404 for non-members.
- `GET /workspaces/{workspaceId}/projects/by-key/{key}` → `ProjectDetail` + `ETag`; 404 `project_not_found`.
- `GET /projects/{projectId}` → `ProjectDetail` + `ETag`; 404 `project_not_found` for non-members and unknown ids alike.
- `PATCH /projects/{projectId}` body subset of `{ name, description, leadUserId, startDate, targetDate, sprintLengthDays }` (schema rejects `methodology` and unknown keys with 400), `If-Match` → 200 `ProjectDetail` + new `ETag`; 428 / 400 / 412 (`current` = fresh `ProjectDetail`) / 403 / 404 / 422 `invalid_lead`.
- Reads run inside `guard.run` (RLS) with explicit columns only (never `users.*`); unknown outcomes → 500 via `expectOutcome`.

- [ ] **Step 1: Failing route tests** (fake pool, `app.inject`, `rateLimit: false`): 401 on every authenticated route; create with template defaults sends the expected 11 SQL params (statuses JSON equals the Kanban template for a kanban body); waterfall create without phases computes the spread; waterfall with 3-day range → 400 "Invalid project dates."; `key_taken` → 409; member → 403; body with `methodology` on PATCH → 400; PATCH without `If-Match` → 428, stale → 412 with `current`; GET by key 404 for non-member; list for a backfilled pre-M2 project (no statuses) returns it with `methodology: "kanban"` and `progress {0,0,0}`; `Cache-Control: private, no-store` on responses; cross-origin POST → 403 `origin_not_allowed`.
- [ ] **Step 2–4:** FAIL → implement → `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` pass. Then a live smoke against the local stack (migrate; `pnpm dev:api` + `pnpm dev:auth`): sign up, create a workspace, create one project of each methodology, GET by key, PATCH with stale ETag → 412; record statuses in the report; stop servers.
- [ ] **Step 5: Commit** `feat(api): project endpoints`.

### Task 5: Methodology picker and project creation

**Files:**
- Create: `Spark_Core/frontend/src/app/w/[slug]/projects/new/page.tsx`, `src/app/w/_components/methodology-picker.tsx`, `src/app/w/_lib/project-key.ts`, `src/app/w/_lib/phases.ts`, `src/app/w/_lib/methodologies.ts` (fetch + types)
- Modify: `src/app/onboarding/page.tsx` (after creating a workspace, navigate to `/w/{slug}/projects/new?first=1` instead of `/w/{slug}`), `src/app/globals.css` (`wsPicker*`, `wsProjectForm*` classes)
- Test: `tests/project-key.test.ts`, `tests/methodology-picker.test.tsx`, `tests/project-new.test.tsx`

**Interfaces / behavior:**
- `deriveProjectKey(name: string): string` — uppercase; letters/digits only per word; if ≥2 words, first letter of up to the first 4 words; if 1 word, its first 3 characters; must match `^[A-Z][A-Z0-9]{1,9}$`, else `"PRJ"`. Examples: "Product Launch" → "PL"; "Website redesign 2027 Q1" → "WR2Q"; "Atlas" → "ATL"; "42" → "PRJ".
- `spreadPhases` (frontend copy in `w/_lib/phases.ts`) — same algorithm and same test vectors as Task 3 (keep both copies tested with identical vectors).
- `useMethodologies()` loads `GET /api/v1/methodologies` (no credentials needed).
- Page `/w/[slug]/projects/new` (inside the M1 workspace layout): for members who are not owner/admin show a card "Only owners and admins can create projects" with a link back home. For owner/admin: kicker "New project" (or "Your first project" when `?first=1`), headline "How does your team work?", then **three large methodology cards** (radio group semantics, keyboard arrows move selection): accent bar in the methodology color, name, tagline, "Best for …", column preview as pastel tags built from `statuses` (with "WIP n" chips for Kanban), "Planning: …", and a "You'll see" list of the metrics. Selecting a card reveals the form below it: name (key auto-derived live, editable, validated against the pattern), description, lead (members list from `GET /workspaces/{id}/members`, default the current user), plus methodology fields — Scrum: sprint length select (1, 2, 3, 4 weeks → 7/14/21/28); Waterfall: start and target date inputs and an editable phase list (name + dates, prefilled from `spreadPhases` with the template phase names, add/remove rows, max 12; inline error "Give each phase at least one day — move the target date or remove a phase." when the range is too short). A collapsible "Practices we'll suggest" list shows the template practices. Submit posts to `POST /workspaces/{id}/projects` (statuses omitted → server template; phases sent only for waterfall) and navigates to `/w/{slug}/p/{key}`. 409 `key_taken` → inline on the key field "That key is already used in this workspace."; 422 `invalid_lead` → inline on lead.
- [ ] **Step 1: Failing tests:** key derivation examples; phase vectors; picker renders three cards from a stubbed catalog with the Kanban WIP chips and arrow-key selection; member sees the restriction card and no form; waterfall too-short range shows the inline error and disables submit; submit posts the expected body for each methodology and navigates to `/w/<slug>/p/<KEY>`; `key_taken` shows the inline message; onboarding now navigates to `/w/<slug>/projects/new?first=1`.
- [ ] **Step 2–4:** FAIL → implement → frontend `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` pass.
- [ ] **Step 5: Commit** `feat(web): methodology picker and project creation`.

### Task 6: Project overview, project lists and docs

**Files:**
- Create: `Spark_Core/frontend/src/app/w/[slug]/p/[key]/page.tsx`, `src/app/w/[slug]/p/[key]/settings-dialog.tsx`
- Modify: `src/app/w/[slug]/page.tsx` (replace the "Coming next" projects empty state with the real list), `src/app/components.tsx` (WorkspaceShell "Projects" section listing up to 8 projects with a methodology-colored dot and a "New project" link for owner/admin), `src/app/globals.css`
- Modify docs: `Documents/product/user-stories.md` (new story **US-E7 Choose a methodology for a project** — Implemented, with acceptance criteria matching this plan; E4 note that projects now exist), `Documents/product/screen-flow.md` (onboarding → `/w/[slug]/projects/new?first=1` → `/w/[slug]/p/[key]`), `Documents/context.md` (migration range through 0018, project endpoints)
- Test: `tests/project-overview.test.tsx`, `tests/workspace-home.test.tsx` (extend), `tests/workspace-shell.test.tsx` (extend or create)

**Behavior:**
- Home: project cards (name, key tag, methodology pill in its color, lead avatar, progress bar `done/total` with "No tasks yet" when 0), "New project" `.sparkPrimary` for owner/admin; empty state keeps the three methodology tiles but links to `/w/{slug}/projects/new`.
- Overview `/w/[slug]/p/[key]` (loads `GET /workspaces/{id}/projects/by-key/{key}`; 404 → not-found card with link home): header with key, name, methodology pill, lead, dates; **Board columns** preview from `statuses` (pastel column chips with WIP chips) and a note "The board arrives in the next update" (M3); methodology section — Scrum: sprint length and "Sprints start once tasks exist"; Kanban: WIP limits summary; Waterfall: a compact horizontal phase timeline (CSS grid by date, baseline ghost bar identical to planned at creation, milestone diamonds at phase ends, today marker when within range) plus a milestone list; "Practices for <Methodology>" card from the catalog; "Settings" button for owner/admin/lead opens a dialog (name, description, lead, dates, sprint length for scrum) that PATCHes with `If-Match` from the ETag; 412 → close nothing, replace form values with `current`, show "Updated by a teammate — review the latest values and save again."; success → toast via the persistent live region pattern from M1 members page.
- [ ] **Step 1: Failing tests:** home lists projects with methodology pills and progress text; shell shows project links with dots and hides "New project" for members; overview renders each methodology's section from stubbed details (waterfall: 5 phases, 5 milestone markers); settings dialog sends `If-Match` and handles 412 by showing the teammate message with the fresh name; non-lead member sees no Settings button; unknown key → not-found card.
- [ ] **Step 2–4:** FAIL → implement → frontend `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` pass; backend `pnpm test` still passes.
- [ ] **Step 5: End-to-end check** on the real local stack (backend migrate; `pnpm dev:api`, `pnpm dev:auth`, `pnpm dev:worker`; frontend `pnpm dev`), headless Chrome via `playwright-core` from a scratch directory: sign up → onboarding → picker (`?first=1`) → create a Kanban project → overview; create a Scrum and a Waterfall project (dates 2026-11-02 → 2026-12-11); home and shell list all three; a second browser context as a plain member (invite via Mailpit, accept) sees overviews but no Settings and the restriction card on `/projects/new`; two contexts edit settings → second gets the 412 message. Desktop 1440 and mobile 390 screenshots of the picker (each card selected), the waterfall form with phases, each overview, home with projects. Look at them critically and polish. Stop all processes; ports free; `next-env.d.ts` restored.
- [ ] **Step 6: Commit** `feat(web): project overview and project lists` (docs in the same commit).
