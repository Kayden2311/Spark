# Workspace core M0 — Shared visualization and HTTP lift Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the admin console's charts, palette and HTTP error type reusable by the upcoming member workspace pages, with zero behavior or visual change in `/admin`.

**Architecture:** Move pure presentational chart code from `src/app/admin/` into a shared `src/app/_ui/viz/` module with its own `viz*` CSS classes and `--viz-*` tokens declared on `:root` (values copied 1:1 from the admin tokens), imported from the root layout. Move the transport-level error type into `src/app/_lib/http.ts`. Admin keeps thin re-export shims so no admin page import changes.

**Tech Stack:** Next.js 16.3.4, React 19.3, recharts 3.10.1, plain global CSS, Vitest 5 + Testing Library (jsdom).

**Spec:** `Documents/product/workspace-core-design.md` (milestone M0).

## Global Constraints

- All repository content in English (AGENTS.md).
- No new dependencies.
- Shared modules under `src/app/_ui/viz/` and `src/app/_lib/` must not import anything from `src/app/admin/` (role separation: admin depends on shared, never the reverse).
- Token values copied verbatim from `src/app/admin/admin.css:8-54` (e.g. ink `#0f172a`, line `#e2e8f0`, line-soft `#edf1f6`, surface `#ffffff`, hover `#f4f6fa`, blue `#2563eb`, blue-dark `#1d4ed8`, radius 10px / 8px, type scale 11/12/13/14/15/16/18/20/22/26px).
- Fonts: shared CSS uses `font-family: inherit` so admin keeps Plus Jakarta Sans and the workspace keeps the landing-page system stack.
- Before editing Next files, skim `node_modules/next/dist/docs/` for global CSS import rules (frontend/AGENTS.md).
- Frontend commands (run in `Spark_Core/frontend`): `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

## Review Focus

1. Admin layout spacing depends on `.admCard` sibling/child selectors (`admin.css:218-219, 632-636`); a ChartCard that loses `admCard` must still get the same margins → extend those selectors with `.vizCard`, and assert ChartCard has class `vizCard` in the viz test.
2. Tooltip and table text in admin must keep Plus Jakarta Sans → no hard-coded font-family in viz.css; checked visually on `/admin/analytics`.
3. `prefers-reduced-motion` handling of the bar-grow animation (`admin.css:~600`) must move with the BarList rules.
4. `adminApi` must still dispatch `spark:session-expired` on 401 and keep its admin-specific 403 copy → existing admin tests plus an http unit test for custom fallbacks.
5. `ErrorBanner` inside ChartCard is admin-only today; the shared card must render its own error with a working Retry button → test.

---

### Task 1: Shared HTTP error module

**Files:**
- Create: `Spark_Core/frontend/src/app/_lib/http.ts`
- Modify: `Spark_Core/frontend/src/app/admin/_lib/api.ts` (remove `ApiError`, `SESSION_EXPIRED_EVENT`, `toError`; import and re-export from shared)
- Test: `Spark_Core/frontend/tests/http.test.ts`
- Also commit: `Documents/product/workspace-core-design.md`, this plan file.

**Interfaces:**
- Produces:
  - `class ApiError extends Error { readonly status: number; readonly code: string }` (constructor `(status, code, message)`, `name = "ApiError"`)
  - `const SESSION_EXPIRED_EVENT = "spark:session-expired"`
  - `const DEFAULT_FALLBACK_MESSAGES: Record<number, string>` — same as admin's today except 403: `"You do not have access to this action."`
  - `async function toApiError(response: Response, fallbacks?: Record<number, string>): Promise<ApiError>` — logic identical to admin `toError` (detail wins unless 5xx other than `database_unavailable`, or empty).
  - `const NETWORK_ERROR_MESSAGE = "Spark could not be reached. Check your connection and try again."`
- Admin `api.ts` keeps exporting `ApiError` and `SESSION_EXPIRED_EVENT` (re-export) and passes `{ ...DEFAULT_FALLBACK_MESSAGES, 403: "Your platform role does not allow this action." }`.

- [ ] **Step 1: Write failing tests** in `tests/http.test.ts`:
  - `uses problem detail when present`: `toApiError(new Response(JSON.stringify({code:"slug_taken",detail:"That address is taken."}),{status:409}))` → `status 409`, `code "slug_taken"`, `message "That address is taken."`.
  - `falls back by status for non-JSON bodies`: status 429 text body → message equals `DEFAULT_FALLBACK_MESSAGES[429]`, code `"request_failed"`.
  - `hides generic 5xx detail but keeps database_unavailable`: 500 with detail "boom" → generic message; 503 with `code:"database_unavailable", detail:"Database is down."` → `"Database is down."`.
  - `accepts custom fallbacks`: 403 empty body with `{403:"Custom"}` → `"Custom"`.
- [ ] **Step 2: Run** `pnpm test tests/http.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `src/app/_lib/http.ts` per Interfaces; update `admin/_lib/api.ts` to import `ApiError`, `SESSION_EXPIRED_EVENT`, `toApiError`, `DEFAULT_FALLBACK_MESSAGES`, `NETWORK_ERROR_MESSAGE` and `export { ApiError, SESSION_EXPIRED_EVENT }`.
- [ ] **Step 4: Run** `pnpm test` → all pass (new 4 + existing admin suites unchanged); `pnpm typecheck` and `pnpm lint` clean.
- [ ] **Step 5: Commit**
```bash
git add Documents/product/workspace-core-design.md Documents/plans/2026-10-18-workspace-core-m0-shared-viz.md Spark_Core/frontend/src/app/_lib/http.ts Spark_Core/frontend/src/app/admin/_lib/api.ts Spark_Core/frontend/tests/http.test.ts
git commit -m "refactor(frontend): share the API error type outside the admin console"
```

### Task 2: Shared viz module and CSS

**Files:**
- Create: `src/app/_ui/viz/palette.ts` (moved verbatim from `admin/_lib/palette.ts`)
- Create: `src/app/_ui/viz/format.ts` with `formatCount`, `formatPercent`, `shortDate`, `shortMonth` (moved from `admin/_lib/format.ts:125-163`; admin `format.ts` re-exports them)
- Create: `src/app/_ui/viz/charts.tsx` (moved from `admin/_components/charts.tsx`), `src/app/_ui/viz/sparkline.tsx` (moved), `src/app/_ui/viz/index.ts` (barrel)
- Create: `src/app/_ui/viz/viz.css`
- Modify: `src/app/layout.tsx` (add `import "./_ui/viz/viz.css";` after globals.css)
- Modify: `admin/_lib/palette.ts`, `admin/_components/charts.tsx`, `admin/_components/sparkline.tsx` → one-line re-exports (`export * from "../../_ui/viz/…"`)
- Modify: `admin/admin.css` — delete the moved chart rules (Spark, ChartCard/Head/Title/Tools/LegendRow/Body/Skeleton/Empty/Canvas, Legend, Tooltip, ChartTable, Donut*, BarList* incl. `@keyframes adm-bar-grow` and its reduced-motion block, InlineBar*, Gauge*, Heatmap*, Contribution*, Cohort*); add `.vizCard` alongside `.admCard` in the layout selectors at lines 218-219 and 632-636.
- Test: `tests/viz.test.tsx`

**Interfaces:**
- Consumes: nothing from admin.
- Produces (all from `src/app/_ui/viz`): `ChartCard`, `ChartLegend`, `DataTable`, `TrendChart`, `DonutChart`, `BarList`, `InlineBar`, `Gauge`, `Heatmap`, `ContributionCalendar`, `CohortGrid`, `Sparkline`, types `ChartSeries`, `TableSpec`; `VIZ`, `SERIES`, `CATEGORICAL`, `SEQUENTIAL`, `sequential`, `CHART_INK`; `formatCount`, `formatPercent`, `shortDate`, `shortMonth`. Signatures unchanged from today.
- Class mapping: every `adm<Name>` used by these components becomes `viz<Name>` (e.g. `admChartCard`→`vizChartCard`, `admContributionCell-out`→`vizContributionCell-out`), and the generic helpers they used become viz-owned: `admCard`→`vizCard`, `admBtn admBtnGhost admBtnSm`→`vizBtn vizBtnGhost vizBtnSm`, `admBtnSecondary`→`vizBtnSecondary`, `admSkeleton`→`vizSkeleton`, `admNum`→`vizNum`, `admSrOnly`→`vizSrOnly`, `admError`→`vizError`.
- `viz.css` declares on `:root` the `--viz-*` tokens (same values as `--adm-*`, names: ink, text, muted, subtle, faint, line, line-soft, line-strong, surface, surface-alt, hover, blue, blue-dark, blue-soft, radius, radius-sm, shadow-xs, shadow-md, shadow-lg, text-3xs…text-4xl) and the moved rules rewritten to `viz*` / `var(--viz-*)`. Animation name `viz-bar-grow`; custom properties `--viz-bar-w`, `--viz-bar-delay` (charts.tsx sets these inline instead of `--adm-bar-*`).
- ChartCard error state: internal `ChartError({message, onRetry})` rendering `<div className="vizError" role="alert">` with a `vizBtn vizBtnSecondary vizBtnSm` "Retry" button (no admin icon import; text-only).

- [ ] **Step 1: Write failing tests** in `tests/viz.test.tsx` (import from `../src/app/_ui/viz`):
  - `ChartCard toggles to an accessible table` — same assertions as `admin-console.test.tsx:356-365`, plus `expect(container.querySelector("section")).toHaveClass("vizCard")`.
  - `ChartCard shows error with retry` — `error="Could not load"`, `onRetry` spy → `getByRole("alert")` has text, clicking `Retry` calls spy once, chart children not rendered.
  - `ChartCard empty state` — `empty` → shows `"No activity in this period yet."`.
  - `BarList renders labels and percent share` — items `[{key:"a",label:"Alpha",value:3},{key:"b",label:"Beta",value:1}]`, `color="#2563eb"` → both labels visible, `"75%"` and `"25%"` shown; `items=[]` → `"Nothing to rank yet."`.
  - `shared modules never import admin` — read files under `src/app/_ui` and `src/app/_lib` with `fs` + `import.meta.glob`-free `readdirSync`, assert none contains `"/admin/"` in an import line.
- [ ] **Step 2: Run** `pnpm test tests/viz.test.tsx` → FAIL (module not found).
- [ ] **Step 3: Move code and CSS** per Interfaces; create shims; update `layout.tsx`; update `admin.css`.
- [ ] **Step 4: Run** `pnpm test` (all suites incl. `admin-console.test.tsx` unchanged → pass), `pnpm typecheck`, `pnpm lint`, `pnpm build` → all clean. `grep -rn "admChart\|admBarList\|admDonut\|admContribution\|admHeatmap\|admGauge\|admCohort\|admTooltip\|admLegend\|admInlineBar\|admSpark" src` → no matches.
- [ ] **Step 5: Visual check** with the `run` skill: start backend + frontend, sign in as a seeded staff account (`Documents/admin-test-accounts.md`), screenshot `/admin`, `/admin/analytics`, `/admin/billing`, `/admin/users` before (on `main` stash) and after; cards, legends, tooltips, donut, contribution calendar and bar lists must match. Stop leftover node processes afterwards.
- [ ] **Step 6: Commit**
```bash
git add Spark_Core/frontend/src Spark_Core/frontend/tests/viz.test.tsx
git commit -m "refactor(frontend): lift admin charts into a shared viz module"
```
- [ ] **Step 7: Independent review** — one fresh-context reviewer (no `spark-*-reviewer` agent type is installed, so a general-purpose agent following `Documents/automation/independent-review.md` as the correctness reviewer) on the M0 diff with a neutral brief: "M0 moves admin charts/palette/error type into shared modules with no behavior change; check for behavior or visual regressions and for shared→admin imports."
