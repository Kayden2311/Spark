# Member App Restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the signed-in member app (shell, workspace, projects, schedule, notifications, settings, onboarding, invitations) on one ClickUp-style token layer and primitive set, palette B.

**Architecture:** A new `src/app/_ui/app.css` holds `--sp-*` tokens on `:root` and the `sp*` primitives, imported by the root layout after `globals.css`. Screens keep their markup and tested hooks; their `ws*` rules move out of `globals.css` into `app.css` sections rewritten on the tokens, screen by screen, and the old blocks are deleted as each screen moves. Small logic (breadcrumbs, `PageHeader`) is added in TSX with unit tests.

**Tech Stack:** Next.js 16.3 App Router, React 19, plain global CSS, `next/font/google` (Plus Jakarta Sans), Vitest + Testing Library.

**Spec:** `Documents/plans/2026-11-05-member-app-restyle-design.md` (read it first; its token tables are the values to use).

## Global Constraints

- No new dependencies; plain global CSS; no Tailwind or CSS modules.
- Font sizes in member-app CSS only from `--sp-t11 … --sp-t24` (11, 12, 13, 14, 16, 20, 24px).
- Radius only `--sp-r1` 4px (chips, tags), `--sp-r2` 6px (buttons, inputs, cards, columns), `--sp-r3` 10px (floating layers); `50%` only on avatars.
- Violet accent only for primary action, selection, focus, current tab, unread count. No coloured glows, no gradients on UI chrome, no eyebrow pills, no `wsGlow` blobs.
- Keep every route, behaviour, accessible name/role, `aria-*`, visible tested text; keep `.sidebarMenuDot`, `.wsBoardScroller`, `.wsBoardPhase`, `.wsTimelineVariance`, `.wsTimelineToday`, `.wsTimelineUnphased`, `data-methodology`, `data-category`, `data-priority`, `data-drop` on the same elements; do not touch `viz*`/`adm*` rules or `admin.css`.
- Do not change global `sparkPrimary`/`sparkSecondary`/`pageTitle`/`eyebrow` rules used by landing; member markup switches to `spBtn*` instead.
- Desktop 1440 and mobile 390 with no horizontal page scroll; `prefers-reduced-motion: reduce` disables transforms and keyframes.
- English only, LF line endings. Commits with no trailer. No push/merge. Restore `frontend/next-env.d.ts` after dev/build; never commit `frontend/CLAUDE.md` or `.superpowers`.
- Gate per task: `pnpm --filter @spark/frontend lint`, `typecheck`, `test` green; final task also `build`.

## Review Focus

1. Dialogs and the task drawer are portalled to `<body>`: they must still get tokens and font (tokens on `:root`, font variable on `<html>`). Check with the invite dialog open.
2. Long names (workspace, project, member, task title, email) at 390px: ellipsis or wrap, never horizontal page scroll. Verified per screen at 390 with the seeded long project names.
3. Keyboard focus is visible on every interactive element on the new light surfaces (`--sp-ring`), including sidebar links and board cards.
4. Pages outside the scope that use the shell (`/billing`, `/communities` links) still render correctly in the new shell.
5. Reduced motion: board card lift, drawer slide, skeleton shimmer and mobile menu all still work without movement.

---

### Task 1: Foundation — tokens, font, primitives, `PageHeader`

**Files:**
- Create: `Spark_Core/frontend/src/app/_ui/app.css`, `Spark_Core/frontend/src/app/_ui/font.ts`, `Spark_Core/frontend/src/app/_ui/page-header.tsx`
- Modify: `Spark_Core/frontend/src/app/layout.tsx` (import `./_ui/app.css` after viz.css; `className={appFont.variable}` on `<html>`), `Spark_Core/frontend/src/app/components.tsx` (`PageTitle` delegates to `PageHeader`)
- Test: `Spark_Core/frontend/tests/page-header.test.tsx`

**Interfaces:**
- Produces: `appFont` (next/font, `variable: "--sp-font"`); CSS tokens per spec; primitive classes `spBtn spBtnPrimary spBtnSecondary spBtnGhost spBtnDanger spBtnDangerGhost spBtnSm spIconBtn spStatus spBadge spTag spPriority spSquare spPanel spPanelHead spTable spTabs spStats spEmpty spSkeleton spAlert spField spLabel spInput spSelect spTextarea spHint spError spKbd`; `.appShell .avatar` restyle.
- Produces: `PageHeader({ title, lead?, meta?, actions?, square?, children? }: { title: string; lead?: ReactNode; meta?: ReactNode; actions?: ReactNode; square?: { label: string; color: string }; children?: ReactNode }) → <header className="spPageHeader">` with an `h1`; `children` renders below (tabs).
- `PageTitle({ eyebrow, title, children })` keeps its signature (billing uses it) and renders `PageHeader` with `lead={eyebrow}` and `actions={children}`.

- [ ] **Step 1: Write failing test** `tests/page-header.test.tsx`: renders `<PageHeader title="Members" lead="2 people" actions={<button>Invite</button>} />`; asserts `getByRole("heading", { level: 1, name: "Members" })`, text "2 people", button "Invite" inside the same `header`; renders `square={{ label: "SL", color: "#0e7c3a" }}` and asserts an `aria-hidden` element with text "SL".
- [ ] **Step 2: Run** `pnpm --filter @spark/frontend test -- page-header` → FAIL (module not found).
- [ ] **Step 3: Implement** `font.ts`, `page-header.tsx`, `app.css` (tokens section, base `.appShell` font/size/colour, `:focus-visible` ring, primitives, reduced-motion block), wire layout and `PageTitle`.
- [ ] **Step 4: Run** the frontend `test`, `lint`, `typecheck` → all pass (record counts).
- [ ] **Step 5: Commit** `feat(frontend): member app tokens, primitives and page header`.

### Task 2: Shell — sidebar, top bar with breadcrumbs, mobile drawer, in-shell states

**Files:**
- Create: `Spark_Core/frontend/src/app/_ui/crumbs.ts`
- Modify: `Spark_Core/frontend/src/app/components.tsx` (`WorkspaceShell`, `WorkspaceSwitcher`, `ShellProjects`), `src/app/w/[slug]/layout.tsx` and `src/app/w/[slug]/p/[key]/layout.tsx` (state cards → `spEmpty`-style state, `spBtn*`), `src/app/w/_components/splash.tsx`, `src/app/_ui/app.css`, `src/app/globals.css` (delete the shell/state/splash member blocks moved)
- Test: `Spark_Core/frontend/tests/shell-crumbs.test.ts`, existing `workspace-shell.test.tsx`, `notifications-page.test.tsx`

**Interfaces:**
- Produces: `type Crumb = { label: string; href?: string }`; `shellCrumbs(input: { pathname: string; current: string; workspace: ShellWorkspace | null; projects: ShellProject[] | null }): Crumb[]`. Rules: inside `/w/{slug}`: first crumb workspace name (href `/w/{slug}` unless it is the last); then `Members`/`Insights`/`Schedule` from `current`; `/w/{slug}/p/{KEY}…` → `Projects` (href `/w/{slug}#projects`) then project name (by key in `projects`, fallback the key); `/w/{slug}/projects/new` → `Projects`, `New project`. Outside a workspace: one crumb `current` (`Notifications`, `Billing`) or `Settings` for `/settings/*`. The last crumb has no href.
- Top bar renders `<nav aria-label="Breadcrumb"><ol>…</ol></nav>` with `aria-current="page"` on the last crumb. No bell: the sidebar's Notifications link already carries the unread count, and on phones the menu button carries `.sidebarMenuDot`.

- [ ] **Step 1: Failing tests** in `shell-crumbs.test.ts`: (a) `/w/acme/members`, current "Members" → `[{label:"Acme",href:"/w/acme"},{label:"Members"}]`; (b) `/w/acme/p/WEB/backlog` with projects `[{key:"WEB",name:"Website"}]` → `["Acme","Projects","Website"]` with hrefs `/w/acme`, `/w/acme#projects`, none; (c) unknown key falls back to the key; (d) `/w/acme` → `[{label:"Acme"}]`; (e) `/w/acme/projects/new` → `["Acme","Projects","New project"]`; (f) `/notifications`, workspace null, current "Notifications" → `[{label:"Notifications"}]`; (g) `/settings/notifications` → `[{label:"Settings"}]`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `shellCrumbs`; restructure shell markup: `.appShell` grid (232px sidebar / main column), sidebar top row = switcher (keep brand link to `/` as the 20px mark before it), nav, projects (square in `methodologyAccent`, short key right-aligned), footer; main column = sticky 48px `.spTopbar` (mobile: menu toggle + crumbs) + `<main id="workspace-main">`. Update `METHODOLOGY_ACCENTS` (in `w/_lib/methodologies.ts`) to Scrum `#1f6fe5`, Kanban `#0e7c3a`, Waterfall `#b45d00`. Mobile ≤900px: sidebar off-canvas with scrim, `--sp-move` transition, existing open/close/Escape/route logic unchanged.
- [ ] **Step 4: Run** test/lint/typecheck → pass. Browser: `/w/spark-lab`, a project, `/notifications`, `/billing` at 1440 and 390 (menu open and closed), reduced motion. Screenshot to `scratchpad/shots/after/`.
- [ ] **Step 5: Commit** `feat(frontend): ClickUp-style shell with breadcrumbs`.

### Task 3: Workspace home as a project list

**Files:** Modify `src/app/w/[slug]/page.tsx`, `src/app/_ui/app.css`, `src/app/globals.css` (delete `.wsHome`, `.wsStat*`, `.wsCard*`, home project grid blocks). Test: existing `workspace-home.test.tsx`.

**Interfaces:** Consumes `PageHeader`, primitives, `methodologyAccent`.

- [ ] **Step 1:** Replace the eyebrow `PageTitle` with `PageHeader` (`square` = workspace initials on `--sp-ink`, `lead` = `spark.app/w/{slug} · {role sentence}`, actions = Invite (secondary, managers) + New project (primary, managers) — keep only one "New project" link inside the Projects region as today's test requires: if the header button is outside the region the region's one stays; confirm with the test).
- [ ] **Step 2:** Stats strip `spStats`: Members, Pending invites, Projects (with "n Scrum · n Kanban · n Waterfall"), Your role. Data already on the page only.
- [ ] **Step 3:** Projects region (`aria-labelledby` unchanged) as `spTable`: header row (Name, Key, Methodology, Lead, Progress); each project row stays the same `Link` with the same inner texts (`KEY`, methodology chip with `data-methodology`, `x/y done` or `No tasks yet`, `progressbar`, lead avatar `title="Lead: …"` or `No lead`). At ≤720px rows collapse to two lines (name + chip / lead + progress). Empty states restyled as `spEmpty` with the existing copy and method links.
- [ ] **Step 4:** test/lint/typecheck pass; browser 1440/390; commit `feat(frontend): workspace home as a project list`.

### Task 4: Members, invitations and workspace insights

**Files:** Modify `src/app/w/[slug]/members/page.tsx`, `members/invite-dialog.tsx`, `src/app/invitations/accept/page.tsx`, `src/app/w/[slug]/insights/page.tsx`, `src/app/w/_components/insights/*.tsx` (container classes only), `src/app/w/_components/modal.tsx` (classes only), `app.css`, `globals.css` (delete moved blocks: members/invitations/accept, `.wsModal*`, workspace insights). Tests: `workspace-members.test.tsx`, `invitation-accept.test.tsx`, `workspace-insights.test.tsx`, `workspace-modal.test.tsx`.

- [ ] **Step 1:** Modal layer on tokens: `--sp-r3`, `--sp-e3`, 16px title, close `spIconBtn`, footer actions right-aligned `spBtn*`; drawer variant full height right, full screen ≤640px; reduced motion no slide. Form controls inside use `spField`/`spInput`/`spSelect`.
- [ ] **Step 2:** Members: `PageHeader` (lead = "N people in {workspace}…", action Invite people); People and Pending invitations as `spPanel` + `spTable` rows (avatar, name, "You" badge, email, role `spSelect`, joined, row action as `spBtnGhost`/`spBtnDangerGhost`); empty invitations as compact `spEmpty`.
- [ ] **Step 3:** Accept-invitation page: centred `spPanel` (max 440px) with workspace square, title 20px, copy, primary/secondary buttons — all states.
- [ ] **Step 4:** Workspace insights: `PageHeader` + cards as `spPanel`; charts untouched.
- [ ] **Step 5:** tests/lint/typecheck pass; browser incl. invite dialog open at 390; commit `feat(frontend): restyle members, invitations, dialogs and workspace insights`.

### Task 5: Project header and board

**Files:** Modify `src/app/w/[slug]/p/[key]/layout.tsx`, `board.tsx`, `task-drawer.tsx`, `move-menu.tsx`, `app.css`, `globals.css` (delete `.wsProject*` hero/tabs, board, drawer, move menu, toast blocks). Tests: `project-board.test.tsx`, `task-drawer.test.tsx`.

- [ ] **Step 1:** Project header = `PageHeader` with `square` (first letter, `methodologyAccent`), `meta` = key `spBadge` + methodology `spBadge` (keeps `wsMethodPill`'s `data-methodology`), children = `<nav aria-label="Project views" className="spTabs">` (same links, labels, `aria-current`, add 16px icons Board/Backlog/Timeline/Overview/Insights/Settings). Section `aria-label="Project"` stays.
- [ ] **Step 2:** Board: columns `--sp-sunken` `--sp-r2`; head = `spStatus` coloured by `data-category` (todo `#5c6474`, in_progress `#1f6fe5`, done `#0e7c3a`), count, WIP "n/limit" (over limit text `--sp-danger`); cards per spec (key 11px faint, title 13px/500, meta row: type tag swatch, priority flag via `data-priority`, due date / overdue in `--sp-danger`, `wsBoardPhase` tag, assignee avatar right); hover lift `--sp-e2`, drag/drop states via `data-drop` ok (accent dashed outline) / blocked (danger outline); quick-add as ghost row "+ Add task" that expands to the existing input. `.wsBoardScroller` keeps horizontal scroll inside itself at 390.
- [ ] **Step 3:** Toast: bottom-right floating `--sp-r3` `--sp-e3`, tone icon colours; task drawer and move menu on the floating style.
- [ ] **Step 4:** tests/lint/typecheck pass; browser Kanban + Scrum board, drawer open, 1440/390, reduced motion; commit `feat(frontend): restyle project header, board, drawer and toasts`.

### Task 6: Backlog, timeline, overview, project insights, settings, new project

**Files:** Modify `p/[key]/backlog/page.tsx`, `sprint-dialogs.tsx`, `timeline/page.tsx`, `phase-timeline.tsx`, `phase-plan-dialog.tsx`, `overview/page.tsx`, `insights/*.tsx` (containers), `settings/page.tsx`, `settings-form.tsx`, `switch-wizard.tsx`, `w/_components/methodology-picker.tsx`, `w/_components/phase-rows-editor.tsx`, `w/[slug]/projects/new/page.tsx`, `app.css`, `globals.css` (delete their blocks). Tests: `project-backlog`, `project-timeline`, `project-overview`, `project-insights`, `project-settings`, `switch-wizard`, `methodology-picker`, `project-new` tests.

- [ ] **Step 1:** Backlog: each sprint and the Backlog as an `spPanel` with head (name 14px/600, state `spBadge`, dates, "n tasks · n pts", actions `spBtnSm`) and `spTable` rows (key, title, type tag, status, points); empty row text muted.
- [ ] **Step 2:** Timeline: Gantt grid on hairlines, bars `--sp-r1`, variance/today/unphased hooks kept; table as `spTable`.
- [ ] **Step 3:** Overview and insights: `spPanel` sections, `spStats` for summary numbers.
- [ ] **Step 4:** Settings, switch wizard, new project + methodology picker: forms on `spField` primitives; picker cards `--sp-r2`, selected = accent border + `--sp-accent-soft`, focus outline ring; wizard steps as a compact stepper.
- [ ] **Step 5:** tests/lint/typecheck pass; browser each tab for Scrum/Kanban/Waterfall project, 1440/390; commit `feat(frontend): restyle planning, timeline, overview, insights and project settings`.

### Task 7: Schedule

**Files:** Modify `w/[slug]/schedule/schedule-view.tsx`, `event-dialog.tsx`, `event-details.tsx`, `app.css`, `globals.css` (delete schedule blocks). Tests: `workspace-schedule.test.tsx`, `schedule-event-dialog.test.tsx`.

- [ ] **Step 1:** `PageHeader` (lead = week range; actions = prev/today/next `spIconBtn`/`spBtnSecondary` group, "Only mine" toggle `aria-pressed` styled as selected chip, New event primary).
- [ ] **Step 2:** Week grid: 7 columns on one bordered surface with hairline separators (not 7 cards); today column `--sp-accent-soft` head, day number in an accent circle-free square; events as left-bordered blocks in type colour; phones keep the agenda list as `spTable` rows.
- [ ] **Step 3:** tests/lint/typecheck pass; browser 1440/390; commit `feat(frontend): restyle schedule`.

### Task 8: Notifications, email settings, onboarding

**Files:** Modify `notifications/page.tsx`, `settings/notifications/page.tsx`, `onboarding/page.tsx`, `app.css`, `globals.css` (delete their blocks). Tests: `notifications-page`, `notification-settings`, `workspace-onboarding`.

- [ ] **Step 1:** Notifications: `PageHeader` (action "Mark all as read" `spBtnGhost`); All/Unread as segmented `spTabs`-style toggle (same roles); list as `spPanel` rows (workspace square, title 13px/600 when unread, meta 12px, unread dot accent), hover background only.
- [ ] **Step 2:** Email settings: `PageHeader`; fieldsets as `spPanel` sections with toggle rows.
- [ ] **Step 3:** Onboarding (outside the shell): centred 480px `spPanel` on canvas, Spark mark top, 24px title, `spField` inputs, URL preview as `spKbd`-style mono line, primary button full width.
- [ ] **Step 4:** tests/lint/typecheck pass; browser 1440/390; commit `feat(frontend): restyle notifications, email settings and onboarding`.

### Task 9: Sweep and final verification

**Files:** Modify `src/app/globals.css` (remove any remaining member-app rule no longer referenced: grep each selector's class in `src/**/*.tsx` before deleting), `app.css`.

- [ ] **Step 1:** For each class in the old "Member workspace" region of `globals.css`, `grep -r` in `src`; delete unreferenced rules. Confirm landing `/`, `/communities`, `/login`, `/admin` unchanged by screenshot diff against `before/`.
- [ ] **Step 2:** Grep `app.css` for `font-size:` values not using `var(--sp-t` and for `border-radius:` values outside the radius tokens/`50%`; fix.
- [ ] **Step 3:** Run frontend `lint`, `typecheck`, `test`, `build`; record counts. Restore `next-env.d.ts`.
- [ ] **Step 4:** Final screenshot set (home, board, backlog, members, schedule, notifications, settings at 1440 + 390, one reduced-motion) to `scratchpad/shots/after/` and send before/after to the user.
- [ ] **Step 5:** Commit `chore(frontend): remove the old member app styles`.
