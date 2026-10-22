# Admin dashboard redesign (Overview, Analytics, Reports, Communities)

Status: design, awaiting approval · 2026-10-20

## Intent

The owner reviewed three token-level restyles of the admin console and rejected each: plain cards read as "lame", dark navy hero headers as "slop", and the last pass as "still simple, not professional, not built on consideration". What they want is a dashboard: **data shown as charts and bars, not as text and bare numbers**, in the light, calm look of the landing page (`Spark_Core/frontend/src/app/page.tsx`, `globals.css`).

The owner chose the direction from browser mockups (kept locally in `.superpowers/brainstorm/`, not committed): the **bento grid** (tiles of different sizes, each answering one question with the chart that fits it) combined with **compact trend cards** (a number, a change badge and a small trend chart that draws itself in), plus **motion and hover effects**. Every chart shows **real data from the backend API**; where the API cannot back a chart today, the backend gains the read it needs.

## Goals

1. Four pages become dashboards in this shape: **Overview** (`/admin`), **Analytics** (`/admin/analytics`, both its System health and Engagement views), **Reports** (`/admin/reports`), **Communities** (`/admin/communities`).
2. Each page has, top to bottom: the existing page header (blue kicker from the sidebar group, title, one-line lead, period picker where the page has one); a row of 3–4 **trend cards**; a **bento grid** of chart tiles; then the page's existing working area (queues, tables, detail panes) unchanged in behaviour.
3. Every chart and trend line is fed by an API response; nothing is illustrative.
4. Motion and hover effects make the pages feel alive without slowing work.

## Non-goals

- Campaigns, Users, Billing and Audit log keep their current layout. Shared styles they already use (tokens, `KpiCards`, `ChartCard`) must not regress; the new trend cards are a new component, not a restyle of `KpiCards`.
- No change to permissions, moderation actions, report triage flow, or table behaviour.
- No dark mode, no new chart library, no new npm dependencies (recharts and the shared `_ui/viz` components stay the foundation).
- No member-facing (`/w/...`) pages.

## Anti-goals (a failure even if it works)

- Dark/navy hero headers or decorative panels without data.
- Any chart drawn from invented, hard-coded or client-guessed history.
- Motion that ignores `prefers-reduced-motion`, delays interaction, or loops forever (the landing-style pulsing kicker dot is the only allowed infinite animation, and it stops under reduced motion).
- Charts that only make sense by colour, or without a "View as table" / text alternative.
- A slower console: the page header, trend cards and working area must be usable before every chart has loaded. Tiles fetch in parallel and each shows its own skeleton, so one slow read never blocks the page. *(Builder's call, replacing an earlier "one extra request" limit that the tile list cannot meet.)*

## Visual system (decided)

- **Canvas**: the existing admin backdrop (landing signal dots and two soft blue glows) stays.
- **Trend card** (new shared admin component): label in small uppercase tracking with a coloured dot; value at the 30 px display size, weight 650, tight tracking; a change chip (green when the change is good, red when bad, neutral when flat; "good" depends on the metric, e.g. more open reports is bad); a sparkline (~92×40) on the right with area fill. Optional link (whole card clickable). Compact: about 96 px tall on desktop. Four per row on desktop, two on tablet, one on phones.
- **Bento grid**: a CSS grid of tiles on a 12-column track; tiles span columns/rows per page layout below. Tiles use the existing card look (16 px radius, `#dce5f1` border, soft blue-tinted shadow), title 16 px/650, one-line subtitle, optional "View as table".
- **Colours**: the existing viz palette (`_ui/viz/palette.ts`) and health colours already used on Communities (red review, amber slowing, violet quiet, blue steady, green growing, slate archived). Same metric, same colour on every page.
- **Effects** (all CSS/SVG, all disabled under `prefers-reduced-motion`):
  - entrance: sparklines and gauges draw in (stroke-dashoffset), ranked bars grow from the left (scaleX), donut slices sweep in with a short stagger, heatmap cells fade in row by row; total entrance under ~1.2 s, never blocking clicks;
  - hover: cards/tiles lift 2 px with a stronger blue-tinted shadow and a single light sheen sweep; donut slice hover enlarges the slice and dims the others; heatmap/bar hover shows the exact value in a tooltip that is also reachable by keyboard focus;
  - numbers do not count up (avoids misreading values mid-animation).

## Page layouts (decided; exact tile sizes are the builder's call)

### Overview (`/admin`)
- Trend cards: Avg daily active users (series `activeUsers`), New sign-ups (`signups`), Posts and comments (`posts + comments`), Monthly recurring revenue (monthly MRR series) — the data the page already loads.
- Bento: Platform activity (large area chart, existing data) · Needs attention (ranked bars of open reports, flagged communities, pending campaigns, each linking to its page) · Audience stickiness gauge (DAU / MAU from `audience`) · Content created (stacked bars, existing) · Moderation flow (opened vs closed, existing) · Recent staff activity (existing list) · Revenue snapshot and API health (existing, as compact tiles).

### Analytics (`/admin/analytics`)
- System health view: trend cards for Requests (last hour), Server error rate, Response time p95, Active sessions; bento with the status banner as a full-width tile, live checks as three small tiles, API traffic (large), Response time, Slowest endpoints and Endpoints with errors as ranked bars, and gauges for cache hit ratio and heap used (existing data from `/admin/system/health`).
- Engagement view: trend cards for DAU, WAU, MAU and sign-ups; bento with the activity heatmap (existing `/admin/analytics/engagement`), retention cohorts (existing `/admin/analytics/retention`), top communities as ranked bars (existing `/admin/analytics/top-communities`) and the activity trend.

### Reports (`/admin/reports`)
- Trend cards: Open now (backlog over the period), Opened, Closed, Median time to decision.
- Bento: Backlog gauge against a target · Reports by reason (ranked bars across **all** open reports, not just the loaded page) · Opened vs closed per day (bars) · Most reported communities (ranked bars, top 5, linking to the community).
- The triage queue and detail pane below are unchanged.

### Communities (`/admin/communities`)
- Trend cards: Live communities, New members, Posts and comments, Open reports — each with its series over the selected period.
- Bento: Health mix donut across **all** communities (not just the loaded page) with the "needs a decision" call-out · Most active communities (ranked bars, existing top-communities read) · When members are active (heatmap, existing engagement read) · Flagged communities share as a gauge.
- The communities table below is unchanged.
- Communities gains the same period picker (7/30/90 days) as Overview.

## Backend reads (decided in shape; SQL is the builder's)

Staff reads follow the existing admin pattern (`src/routes/admin/*`, role checks through the staff guard and database `staff_*` functions, `Cache-Control: private, no-store`, explicit columns). Each new or extended read is covered by route tests and database integration tests, and independent review per `AGENTS.md` (role checks and SQL count as auth/RLS-sensitive).

1. **`GET /api/v1/admin/communities/stats?days=7|30|90`** (roles that can open Communities): health counts over all communities using the same rules as `healthOf` (`admin/_components/community-actions.ts`) moved server-side so client and server agree; a daily series of live communities and new members over the period, with previous-period totals for the change chips.
2. **Extend `GET /api/v1/admin/reports/stats`**: open reports by reason (all open reports), top 5 communities by open reports, and a per-day backlog series plus a weekly median-hours-to-close series for the period.
3. Overview, Analytics and the remaining Communities/Reports tiles use reads that already exist (`/admin/analytics/activity`, `/engagement`, `/retention`, `/top-communities`, `/admin/billing/mrr`, `/admin/system/health`, `/admin/overview`).

## Data rules (builder's calls, made while reviewing this design)

- **Roles**: a tile or trend card whose source read the viewer's role cannot open is not rendered (no empty "no access" boxes); the grid closes the gap. The page itself stays reachable exactly as today.
- **History**: series are derived from timestamps the database already stores. No snapshot tables, sampling jobs or migrations are added for history. A metric whose past values cannot be rebuilt reliably keeps its card with the current value (and a change chip only if the previous period can be computed) but **no sparkline**. Known cases: Active sessions on System health has no history (no sparkline); Live communities over time is rebuilt only if creation and archive timestamps make it exact, otherwise that card shows the count and new-community change without a sparkline; the report backlog series is rebuilt from report creation and close timestamps, and the builder verifies that reopen/dismiss paths keep those timestamps truthful before shipping it.
- **System health sparklines** use the in-memory per-minute traffic buckets the health read already returns (they reset when the API restarts, as the page already says).
- **Health rules**: the new communities stats read reproduces `healthOf` exactly from the same inputs (open reports and the 8 weekly activity counts). The communities table keeps using the client `healthOf`; a test asserts the server and client classify the same fixtures identically.
- **Backlog gauge**: target is a named constant (10); the arc fills to 100% at twice the target and turns red once the backlog is over target, with the text "N× over target".
- **Delivery**: one branch, built in sequence — shared components first, then backend reads, then Overview, Analytics, Reports, Communities — each step reviewed before the next.

## Constraints

- English only; LF line endings; plain CSS in `admin/admin.css` and `_ui/viz/viz.css` using the admin type scale (no bare px font sizes); Next.js 16 / React 19 conventions (read `node_modules/next/dist/docs/` first, per `frontend/AGENTS.md`).
- Accessibility: every chart tile has a title, a text summary for screen readers and a table view; hover tooltips are also available on keyboard focus; colour is never the only signal; contrast ≥ 4.5:1 for text.
- Responsive: desktop 1440, tablet 768, phone 390 must all work without horizontal page scroll; bento tiles stack to one column on phones.
- Loading/error/empty states per tile (skeleton while loading, retry on error, plain message when empty), using the existing `ChartCard` states.
- Checks: frontend `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`; backend `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:database`, `pnpm build`; desktop and phone screenshots of all four pages reviewed before hand-off.

## Left to the builder

- Exact tile spans per page, chart sizes and spacing within the visual system above.
- Component names and file split (a `TrendCard` and a `Bento`/`Tile` pair in the admin components or `_ui/viz` are expected).
- SQL and response field names for the new reads, the backlog target value for the gauge (a named constant), and how the period picker state is kept in the URL (existing `useQueryState` pattern).
- Animation timings within the limits above.
