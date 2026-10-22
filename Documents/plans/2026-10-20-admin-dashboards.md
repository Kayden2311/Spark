# Admin dashboards (Overview, Analytics, Reports, Communities) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn four admin pages into landing-styled dashboards — compact trend cards plus a bento grid of real-data chart tiles with entrance and hover effects — above each page's unchanged working area.

**Architecture:** One migration (`0022`) adds two `SECURITY DEFINER` staff reads; the admin routes expose them. The frontend gains shared `TrendCards`, `Bento`/`Tile` and an arc `TargetGauge`, then each page is recomposed from existing and new reads. Tiles fetch in parallel with their own loading states; tiles a role cannot read are not rendered.

**Tech Stack:** PostgreSQL 18 (hand-written SQL migrations), Fastify 5, Vitest; Next.js 16.3 / React 19 client components, recharts (already installed), plain CSS (`admin/admin.css`, `_ui/viz/viz.css`), Vitest + Testing Library.

**Spec:** `Documents/product/2026-10-20-admin-dashboard-redesign-design.md` (approved). Read it in full before any task.

## How to run this plan

- Branch `feat/admin-dashboards` (from `main` at `37f5d80`). Do not push or merge. Commits carry **no** `Co-Authored-By` or other trailer (the user is the sole author).
- Execute with superpowers:subagent-driven-development; ledger in `.superpowers/sdd/<plan>/progress.md`. Task 1 (SQL + staff authorization) gets two independent first-pass reviewers (correctness, security) in parallel; other tasks one reviewer. Final whole-branch review on the most capable model, one fix wave.
- Local environment: PostgreSQL 18 on 127.0.0.1:5432 (all roles; local DB already at migration 0021); Redis + Mailpit via `pnpm infra:up` in `Spark_Core` (Docker Desktop must be running); dev ports frontend 3000, API 4000, auth 4100. Admin test account and seed data: `Documents/admin-test-accounts.md` (`pnpm db:seed`, `pnpm db:seed:demo`).
- Lessons for every dispatch: LF line endings; never `git add` `.superpowers`; after shell work run `git status` and delete stray empty files at the repo root, never commit them; never `git stash`; restore `frontend/next-env.d.ts` if `next dev`/`build` rewrote it; stop only the processes you start (a user-run worker may be running — leave it); for screenshots use `playwright-core` from a scratch directory outside the repo with the installed Chrome (`C:/Program Files/Google/Chrome/Application/chrome.exe`); in Git Bash set `MSYS_NO_PATHCONV=1` when passing URL paths to node; Fastify strips unknown query/body keys unless the schema rejects them.

## Global Constraints

- English only; plain CSS; font sizes only from the admin type scale tokens (`--adm-text-*`) and viz tokens (`--viz-text-*`) — add a token rather than a bare px font size; no new npm dependencies; no dark mode.
- Spec anti-goals are binding: no dark/navy hero panels; no invented or client-guessed history (a metric without reliable history shows its value without a sparkline); every motion disabled under `prefers-reduced-motion` (only the pulsing kicker dot may loop); colour never the only signal; every chart tile has a title, a screen-reader summary and a "View as table" alternative; page header, trend cards and working area usable before charts load (tiles load in parallel, each with its own skeleton/retry/empty state via `ChartCard` states).
- Visual system (spec "Visual system"): trend card ≈96 px tall — uppercase tracked label with colour dot, 30 px/650 tight value, change chip (good = green, bad = red, flat = neutral; "good" per metric), ~92×40 sparkline with area fill on the right, optional whole-card link; 4 per row desktop, 2 tablet (≤1100 px), 1 phone (≤640 px). Bento = 12-column grid; tiles use the existing card look; stack to one column on phones.
- Effects: sparklines and gauges draw in (stroke-dashoffset), bars grow from left (scaleX), donut slices already animate (keep), heatmap cells fade in by row; total entrance ≤ 1.2 s; hover lift 2 px + stronger blue shadow + one sheen sweep on cards/tiles; tooltips also on keyboard focus; numbers never count up.
- Roles (backend `src/routes/admin/guard.ts`): `ANY_STAFF`, `CONTENT_STAFF` (super_admin, platform_admin, content_moderator), `COMMUNITY_STAFF` (super_admin, platform_admin, community_moderator). Frontend tile visibility uses `canAccess(roles, section)` from `admin/_lib/access.ts` with the section that owns the read: analytics reads → `"analytics"`, report stats → `"reports"`, community stats → `"communities"`, billing → `"billing"`.
- Backlog gauge: `REPORT_BACKLOG_TARGET = 10`; arc full at 2× target; red and text `"N× over target"` (rounded to one decimal, `"2× over target"` style) when backlog > target, otherwise `"Within target"` in green.
- Commands — backend (`Spark_Core/backend`): `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:database`, `pnpm build`, `pnpm db:migrate`. Frontend (`Spark_Core/frontend`): `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. Never report an unrun check as passing.

## Review Focus

1. A community moderator (no analytics/reports/billing access) opens Overview or Communities → no 403 tiles, no empty "no access" boxes; the grid closes the gaps → FE tests in Tasks 4 and 7.
2. An empty or brand-new platform (zero reports, zero communities, one day of data) → every tile shows its empty message, sparklines with fewer than 2 points are not drawn, change chips read "No change" or are omitted when there is no previous period → Task 2 unit tests, DB tests in Task 1.
3. Health counts on Communities disagree with the table badges → shared fixtures classified identically by SQL and `healthOf` → Task 1 DB test + Task 7 FE test.
4. Reduced motion → no animation classes animate and charts are fully drawn immediately → Task 2 test (`matchMedia` reduced → static state).
5. Phone width (390 px) → no horizontal page scroll; trend cards one per row; bento tiles stacked → Task 8 screenshots checked by the reviewer.

---

### Task 1: Staff reads for community and report insights (migration 0022)

**Files:**
- Create: `Spark_Core/backend/drizzle/0022_admin_dashboard_insights.sql`; journal idx 22 (`"version": "7"`, `when` 1792360000000, tag `0022_admin_dashboard_insights`, `breakpoints: true`)
- Modify: `Spark_Core/backend/src/routes/admin/communities.ts`, `src/routes/admin/reports.ts`, `tests/database/schema.integration.ts`, admin route tests (follow `tests/admin.test.ts`), `Documents/architecture/database-schema.md` (0022 section)

**Interfaces (SQL; `STABLE SECURITY DEFINER SET search_path = ''`, `spark.require_platform_role(...)` first, `spark.require_range(p_days, 7, 365, 'Invalid range')`, REVOKE FROM PUBLIC, GRANT EXECUTE TO spark_app — same style as 0012):**
- `spark.staff_community_health_counts() RETURNS TABLE(growing bigint, steady bigint, slowing bigint, quiet bigint, needs_review bigint, archived bigint)` — COMMUNITY_STAFF; every community (all states) classified with exactly the rules of `healthOf` (`frontend/src/app/admin/_components/community-actions.ts`): archived → archived; open reports > 0 → needs_review; last 4 weeks of activity = 0 → quiet; previous 4 weeks = 0 or recent ≥ 1.25 × previous → growing; recent ≤ 0.6 × previous → slowing; else steady. "Activity" and "open reports" must be computed the same way `staff_community_health` computes `weekly_activity` and open reports (reuse its logic; read it in 0012).
- `spark.staff_community_daily(p_days integer) RETURNS TABLE(day date, new_members bigint, new_communities bigint, live_communities bigint)` — COMMUNITY_STAFF; one row per UTC day in the range (oldest first, days with zero included). `live_communities` is only returned when creation/archive timestamps make it exact — if the schema cannot rebuild it exactly (verify the communities columns; e.g. no archived_at), return NULL in that column for every row and say so in the migration comment.
- Report insights, three functions:
  - `spark.staff_report_reasons() RETURNS TABLE(reason text, open_count bigint)` — CONTENT_STAFF; all open/reviewing reports grouped by reason, descending.
  - `spark.staff_report_top_communities(p_limit integer) RETURNS TABLE(community_id uuid, name text, slug text, open_count bigint)` — CONTENT_STAFF; `p_limit` 1–20.
  - `spark.staff_report_daily(p_days integer) RETURNS TABLE(day date, opened bigint, closed bigint, backlog bigint, median_hours_to_close numeric)` — CONTENT_STAFF; per UTC day: reports created, reports resolved, open backlog at the end of that day (rebuilt from `created_at`/`resolved_at`; before shipping, verify in the code that every path that reopens or dismisses a report keeps `resolved_at` truthful — if a reopen path clears `resolved_at` without history, document the limitation in the migration comment and in the report), and the median hours to close of reports resolved that day (NULL when none).

**Interfaces (HTTP, base `/api/v1/admin`):**
- `GET /communities/stats?days=7|30|90` (COMMUNITY_STAFF) → `{ days, health: { growing, steady, slowing, quiet, needsReview, archived }, series: Array<{ day: string /* YYYY-MM-DD */, newMembers: number, newCommunities: number, liveCommunities: number | null }>, current: { newMembers: number, newCommunities: number }, previous: { newMembers: number, newCommunities: number } }` — `previous` = the same-length period before (call `staff_community_daily(2 * days)` once and split). Register before `/communities/:id` so `stats` is not parsed as an id.
- `GET /reports/stats?days=` (existing, CONTENT_STAFF) gains `reasons: Array<{ reason: string, count: number }>`, `topCommunities: Array<{ id, name, slug, count }>` (limit 5), `series: Array<{ day, opened, closed, backlog, medianHoursToClose: number | null }>`; existing fields unchanged.
- Schemas reject unknown query keys; `Cache-Control: private, no-store` as other admin reads.

- [ ] **Step 1: Failing DB tests** (`schema.integration.ts`): `classifies community health like the admin badges` (fixtures covering each of the six classes, including a community with reports AND rising activity → needs_review, an archived one with reports → archived); `returns one community row per day including empty days` (7-day range → 7 rows, zero-filled); `rebuilds the report backlog per day` (fixture reports created/resolved on known days → expected opened/closed/backlog/median per day); `groups open reports by reason and community`; `refuses report insights to a community moderator and community stats to a content moderator` (insufficient role → same error the other staff reads raise); `rejects ranges outside 7–365`.
- [ ] **Step 2:** Run `pnpm test:database` → new tests FAIL.
- [ ] **Step 3:** Write the migration and journal entry; wire the routes.
- [ ] **Step 4: Route tests** (fake pool): stats shapes and number coercion; `previous` split from a `2 × days` series; 403 for the wrong role; 400 for `days=10`; `/communities/stats` not captured by `/:id`.
- [ ] **Step 5:** Run `pnpm test:database`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` → pass; `pnpm db:migrate` applies on the local DB. Update `database-schema.md` (0022) and the admin API list in `Documents/context.md`.
- [ ] **Step 6: Commit** `feat(admin-api): community and report insight reads`.

### Task 2: Shared dashboard building blocks

**Files:**
- Create: `Spark_Core/frontend/src/app/admin/_components/trend-cards.tsx`, `src/app/admin/_components/bento.tsx`
- Modify: `src/app/_ui/viz/charts.tsx` (add `TargetGauge`; add grow-in animation to `BarList`), `src/app/_ui/viz/viz.css`, `src/app/admin/admin.css`, `src/app/_ui/viz/sparkline.tsx` (draw-in)
- Test: `tests/admin-trend-cards.test.tsx`, `tests/admin-bento.test.tsx`, `tests/viz.test.tsx` (extend)

**Interfaces:**
- `TrendCardItem = { label: string; value: string | undefined /* undefined → skeleton */; dot: string /* colour */; change?: { current: number; previous: number | null; higherIsBetter?: boolean /* default true */ }; series?: number[]; color: string; href?: string; valueTone?: "default" | "bad" }`; `TrendCards({ items, label }: { items: TrendCardItem[]; label: string })` renders a `<ul aria-label={label}>`; change chip text via existing `describeChange` (`admin/_lib/format.ts`); sparkline drawn only when `series` has ≥ 2 points; each sparkline has `aria-hidden` and the card has a visually hidden sentence "`<label>`: `<value>`, `<change text>`".
- `Bento({ children, label }: { children: ReactNode; label: string })` → `<section aria-label>` with a 12-column grid; `Tile({ span = 4, rowSpan = 1, children })` wraps a `ChartCard` or any card and sets `--tile-span`/`--tile-rows` (desktop), collapsing to 6 at ≤1100 px and 12 at ≤640 px. A Tile whose child renders `null` must not leave a gap (use `:empty` / render nothing).
- `TargetGauge({ value, target, label }: { value: number; target: number; label: string })` — half-arc SVG; fill ratio `min(value / (2 * target), 1)`; colours and text per Global Constraints; `role="img"` with `aria-label` "`<label>`: `<value>`, `<status text>`".
- Effects classes (`admDrawIn`, `admGrowIn`, `admFadeIn`, `admLift`) in CSS only, all inside `@media (prefers-reduced-motion: no-preference)`.

- [ ] **Step 1: Failing tests:** trend card shows label, value, "↑ +30%"-style change from `{current: 130, previous: 100}`, red chip when `higherIsBetter: false` and value rose; no sparkline for a 1-point series; whole card is a link when `href` is set; skeleton when `value` undefined. `TargetGauge`: value 4 / target 10 → "Within target"; 20 / 10 → "2× over target" and the over class; 0 → empty arc. Bento: a `Tile` whose child is `null` renders no element. Reduced motion: with `matchMedia('(prefers-reduced-motion: reduce)')` matching, the components render without animation classes active (assert via the class/state your implementation uses).
- [ ] **Step 2–4:** FAIL → implement → frontend `pnpm test`, `pnpm typecheck`, `pnpm lint` pass; existing viz/admin tests unchanged.
- [ ] **Step 5: Commit** `feat(admin): trend cards, bento tiles and a target gauge`.

### Task 3: Frontend API types and hooks for the new reads

**Files:** Modify `Spark_Core/frontend/src/app/admin/_lib/types.ts` (types `CommunityStats`, extended `ReportStats`), add nothing else unless needed. Test: `tests/admin-lib.test.ts` (extend) for any pure helper added (e.g. a `seriesOf(points, key)` helper if you add one).

**Interfaces:** `CommunityStats` and `ReportStats` exactly mirror Task 1's HTTP shapes. Data is loaded with the existing `useAdminData<T>(path | null)`; pass `null` when `canAccess` is false so no request is made.

- [ ] Steps: types + any helper with a test → `pnpm test`, `pnpm typecheck` → commit `feat(admin): types for community and report insights`. (Small task; may be batched into Task 2's dispatch.)

### Task 4: Overview dashboard

**Files:** Modify `Spark_Core/frontend/src/app/admin/page.tsx` (and split tiles into `src/app/admin/_components/overview-tiles.tsx` if the page grows past ~300 lines), `admin.css`. Test: `tests/admin-overview.test.tsx` (create or extend existing overview tests in `tests/admin-console.test.tsx`).

**Behaviour:** Spec "Overview". Trend cards: Avg daily active users (`activity.series[].activeUsers`), New sign-ups (`signups`), Posts and comments (`posts + comments`), MRR (`/admin/billing/mrr` monthly series; card rendered only for billing access). Bento tiles: Platform activity (span 8, existing chart) · Needs attention (span 4, `BarList` of open reports / flagged communities / pending campaigns, each row a link, values from `/admin/overview`) · Audience stickiness (`TargetGauge` is not right here — use the existing `Gauge` showing DAU/MAU %) · Content created · Moderation flow · Recent staff activity · Revenue snapshot (billing access only) · API health. Keep the existing range picker driving all period-based reads.

- [ ] **Step 1: Failing tests:** renders four trend cards with values from stubbed reads; as a `community_moderator` (stub `useAdmin` roles) no request is made to `/admin/analytics/*` or `/admin/billing/*` and no MRR card or revenue tile renders; Needs attention bars link to `/admin/reports`, `/admin/communities?status=flagged`, `/admin/campaigns`.
- [ ] **Step 2–4:** FAIL → implement → frontend `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` pass.
- [ ] **Step 5: Commit** `feat(admin): overview dashboard`.

### Task 5: Analytics dashboards (System health and Engagement)

**Files:** Modify `src/app/admin/analytics/page.tsx`, `src/app/admin/analytics/system-health.tsx` (split an `engagement.tsx` out of `page.tsx` if needed), `admin.css`. Test: `tests/admin-analytics.test.tsx` (create).

**Behaviour:** Spec "Analytics". System health: trend cards Requests (last hour, sparkline from the per-minute traffic buckets), Server error rate (sparkline of per-minute error share), Response time p95 (per-minute p95), Active sessions (value only, no sparkline); bento: status banner (span 12), three live-check tiles (span 4 each), API traffic (span 8), Response time (span 4), Slowest endpoints and Endpoints with errors (`BarList`, span 6 each), Database and API process tiles with `Gauge`s for cache hit ratio and heap used. Engagement: trend cards DAU, WAU, MAU (from `audience`, value only unless the activity series supports a sparkline — DAU can use `activeUsers`) and Sign-ups; bento: activity heatmap (`Heatmap`, span 8), top communities (`BarList`, span 4), retention cohorts (`CohortGrid`, span 12), activity trend (span 12).

- [ ] **Step 1: Failing tests:** system-health view renders four trend cards with an Active sessions card that has no sparkline; engagement view renders the heatmap and cohort tiles from stubbed reads; switching views keeps the URL `view` query param behaviour that exists today.
- [ ] **Step 2–4:** FAIL → implement → checks pass. **Step 5: Commit** `feat(admin): analytics dashboards`.

### Task 6: Reports dashboard

**Files:** Modify `src/app/admin/reports/page.tsx` (move the stats section into `src/app/admin/reports/report-insights.tsx`), `admin.css`. Test: `tests/admin-reports.test.tsx` (create or extend).

**Behaviour:** Spec "Reports". Trend cards from extended `/admin/reports/stats`: Open now (value `backlog`, series `series[].backlog`, `higherIsBetter: false`), Opened (`opened`, series `opened`, `higherIsBetter: false`), Closed (`closed`, series `closed`), Median time to decision (`medianHoursToClose` in hours, series of daily medians skipping nulls, `higherIsBetter: false`). Bento: Backlog `TargetGauge` (span 4) · Reports by reason (`BarList` over `reasons`, span 4) · Opened vs closed per day (bar chart, span 4 or 8) · Most reported communities (`BarList` over `topCommunities`, links to `/admin/communities/{id}`). The queue + detail pane below stay as they are (move only the old "Queue health" / "By reason" cards, which these tiles replace).

- [ ] **Step 1: Failing tests:** gauge reads "2× over target" for backlog 20; reasons bars come from the API `reasons` (not from the loaded queue page); a top community row links to its detail page; triage keyboard shortcuts still work (existing test stays green).
- [ ] **Step 2–4:** FAIL → implement → checks pass. **Step 5: Commit** `feat(admin): reports dashboard`.

### Task 7: Communities dashboard

**Files:** Modify `src/app/admin/communities/page.tsx` (move tiles into `src/app/admin/communities/community-insights.tsx`), `admin.css`. Test: `tests/admin-communities.test.tsx` (create or extend).

**Behaviour:** Spec "Communities". Add the 7/30/90-day period picker (existing `RangePicker` + `useRange`). Trend cards: Live communities (latest `liveCommunities` value with sparkline when non-null; otherwise `overview.communities.active` with no sparkline; change from `newCommunities` current vs previous), New members (`current.newMembers`, sparkline `series[].newMembers`), Posts and comments (`/admin/analytics/activity` — only with analytics access), Open reports (`/admin/reports/stats` backlog series — only with reports access; `higherIsBetter: false`). Bento: Health mix donut over `health` (all communities) with the existing "needs a decision" call-out (span 6, row span 2) · Most active (`/admin/analytics/top-communities`, analytics access) · When members are active (`/admin/analytics/engagement` heatmap, analytics access) · Flagged share `Gauge` (flagged / active from `/admin/overview`). The table below is unchanged and keeps client `healthOf`.

- [ ] **Step 1: Failing tests:** donut totals come from `stats.health` (16 communities while the table page shows 10); a community moderator sees no posts/heatmap/most-active tiles and no requests to `/admin/analytics/*` or `/admin/reports/*`; `healthOf` classifies the Task 1 fixtures the same way the SQL test expects (copy the fixture table as a shared JSON in `tests/fixtures/community-health.json` used by both tests).
- [ ] **Step 2–4:** FAIL → implement → checks pass. **Step 5: Commit** `feat(admin): communities dashboard`.

### Task 8: Visual pass, docs and end-to-end screenshots

**Files:** `admin.css`/`viz.css` polish only; `Documents/context.md` (admin dashboards), `Documents/product/user-stories.md` (admin stories touched, if any reference these pages).

- [ ] **Step 1:** Run the local stack (`pnpm infra:up`; backend `pnpm db:migrate`, `pnpm dev:api`, `pnpm dev:auth`; frontend `pnpm dev`; demo seed if needed), sign in as `admin@spark.app` and as `communitymod@spark.app` (passwords in `Documents/admin-test-accounts.md`), capture desktop 1440 and phone 390 full-page screenshots of all four pages (both Analytics views) to the session notes folder given in the dispatch, with and without reduced motion for one page.
- [ ] **Step 2:** Look at every screenshot critically against the spec's visual system and anti-goals; fix real defects; re-run affected tests.
- [ ] **Step 3:** Frontend and backend full checks pass; stop the processes you started; ports free; `next-env.d.ts` restored.
- [ ] **Step 4: Commit** `style(admin): dashboard polish and docs`.
