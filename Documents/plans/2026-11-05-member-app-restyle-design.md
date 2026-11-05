# Member app restyle — design

Status: approved direction (palette B mockup, 2026-11-05). This document is the brief a builder plans from.

## Why

The signed-in member app (workspace, projects, schedule, notifications, settings, onboarding, invitations) looks
far worse than the admin console. In the user's words it is "extremely ugly compared to admin" and "doesn't even
follow the standards, styling, effects". Concretely, today:

- Page titles jump between 22px (Schedule) and ~56px marketing headings (home, members, project pages).
- A heavy navy sidebar, pill buttons with blue glows, eyebrow pills, blurred glow blobs behind content.
- About 1,300 lines of ad hoc `ws*` rules in `globals.css` with bare `rem` sizes, no type scale, no shared
  primitives; every screen invents its own card, badge, button and empty state.
- The app uses the system font while admin uses Plus Jakarta Sans.

The user picked a ClickUp-inspired direction and **palette B (violet accent, soft grey sidebar)**, and explicitly
rejected "rounded corners without design thinking — AI slop". Every visual choice must follow a stated rule.

## Goals

1. One token layer and one set of primitives for the whole member app, in plain global CSS.
2. A ClickUp-style shell: light sidebar, slim top bar with breadcrumbs, compact page header.
3. Every in-scope screen restyled on those tokens and primitives, consistent at 1440px and 390px.
4. Respect `prefers-reduced-motion` (colour changes only, no movement).
5. Keep every existing behaviour, accessible name, route and test.

## Non-goals

- No new features. In particular **no search box / Ctrl K** (no search exists; a dead input would be worse than
  none), no new filters, no renamed navigation labels.
- No dark mode.
- The admin console is not touched (it keeps its blue palette and `--adm-*` tokens).
- Landing, auth (login/signup/forgot), pricing, communities and billing page bodies are not restyled. Billing and
  communities still sit inside the shell, so they inherit the new shell automatically.
- No new dependencies, no Tailwind, no CSS modules. Plain global CSS, as now.

## Anti-goals (failure even if it "works")

- Uniform big radius on everything, coloured glows, gradient avatars, eyebrow pills, decorative blur blobs.
- Violet used as decoration.
- Boxes inside boxes inside boxes.
- Bare px/rem font sizes outside the type scale.
- A visual regression on any screen not listed (landing, admin, auth).

## The design system (decided with the user)

Reference mockup: `system-v2.html` (brainstorm companion). Values below are the contract.

### Colour roles

Neutrals carry a faint violet tint so greys and accent read as one family.

| Token | Value | Role |
|---|---|---|
| `--sp-ink` | `#1c1d29` | headings, strong text |
| `--sp-text` | `#2e3040` | body |
| `--sp-muted` | `#5f6377` | secondary text (AA on white and on sidebar) |
| `--sp-faint` | `#8b8fa3` | placeholder, icons, non-essential meta only |
| `--sp-line` / `--sp-line-strong` / `--sp-line-soft` | `#e6e6ee` / `#d5d5e0` / `#efeff4` | hairlines |
| `--sp-canvas` | `#fafafb` | page background |
| `--sp-surface` | `#ffffff` | cards, top bar, tables |
| `--sp-sunken` | `#f4f4f7` | board columns, table heads |
| `--sp-hover` | `#f0f0f5` | hover fill |
| `--sp-side` / `--sp-side-active` | `#f6f6f9` / `#eceafd` | sidebar, selected nav item |
| `--sp-accent` / `-hover` / `-soft` / `-ink` | `#5b4ee8` / `#4a3dd6` / `#efedfd` / `#4337c9` | **"you can act here" only**: primary button, selection, focus ring, current tab, unread count |
| `--sp-danger` / `-hover` / `-soft` | `#c8303a` / `#a92630` / `#fdf0f1` | destructive actions, errors |
| `--sp-ring` | `0 0 0 2px #fff, 0 0 0 4px rgba(91,78,232,.5)` | focus ring everywhere |

**Information colours** (status, priority, methodology) are the only other colours. Each passes AA with white
11px bold text:

- Status by column category: `todo #5c6474`, `in_progress #1f6fe5`, `done #0e7c3a`; blocked/overdue `#c8303a`;
  review/at-risk `#b45d00`. (Statuses only carry a category, so all in-progress columns share blue.)
- Priority (flag icon + text colour): urgent/high `#c8303a`, medium `#b45d00`, low `#5c6474`.
- Methodology squares: Scrum `#1f6fe5`, Kanban `#0e7c3a`, Waterfall `#b45d00` — `methodologyAccent()` in
  `w/_lib/projects.ts` is updated to these so sidebar, home and project header agree.

### Shape

- **Radius follows elevation**: `--sp-r1: 4px` chips, tags, kbd, checkboxes; `--sp-r2: 6px` buttons, inputs,
  cards, nav items, board columns, tables; `--sp-r3: 10px` only floating layers (menus, popovers, dialogs, drawer
  edge, toasts).
- **Circles are only people** (avatars). Workspaces and projects are squares (`--sp-r1`/`--sp-r2`).

### Depth (3 levels, no coloured glows)

- `--sp-e1` resting card: hairline + `0 1px 2px rgba(28,29,41,.05)`.
- `--sp-e2` hover/drag: lift 1px + `0 2px 4px -2px rgba(28,29,41,.08), 0 12px 24px -12px rgba(28,29,41,.18)`.
- `--sp-e3` floating: `0 4px 8px -4px rgba(28,29,41,.1), 0 24px 48px -16px rgba(28,29,41,.28)`.
- Page sections are flat regions separated by hairlines or a single bordered panel — never a card inside a card
  inside a card.

### Type

Plus Jakarta Sans (same as admin) via `next/font`, weights 400/500/600/700, falling back to the system stack.
The font's CSS variable class goes on `<html>` in the root layout (it only defines `--sp-font`; landing and auth
pages do not reference it, so they do not change) so dialogs portalled to `<body>` get the font too.
Seven steps, the only font sizes allowed in member-app CSS:
`--sp-t11 11px` meta, labels · `--sp-t12 12px` secondary UI · `--sp-t13 13px` **base body and UI** ·
`--sp-t14 14px` section titles, emphasised body · `--sp-t16 16px` dialog titles, large values ·
`--sp-t20 20px` page title (600, -0.015em) · `--sp-t24 24px` stat values and onboarding/state headlines.
Numbers use `font-variant-numeric: tabular-nums`.

### Density and spacing

4px grid. Top bar 48px. Nav items 30px, table rows 38px, toolbar buttons 30px. Page padding 20–24px desktop,
16px mobile.

### Motion

`--sp-fast: 120ms` for colour/background/border; `--sp-move: 180ms cubic-bezier(.2,.8,.2,1)` for lift, panels and
the mobile drawer. Lift (translateY(-1px) + `--sp-e2`) only on things you can pick up or open: board cards, project
rows, notification rows. Under `prefers-reduced-motion: reduce` all transforms and keyframe animations are off;
colour transitions stay.

## Primitives

One set of `sp*` classes, defined once, used by every in-scope screen:

- **Buttons**: `spBtn` + `spBtnPrimary | spBtnSecondary | spBtnGhost | spBtnDanger | spBtnDangerGhost`, size
  `spBtnSm`; `spIconBtn`. 30px (sm 26px), `--sp-r2`, 12–13px semibold, icon 16px gap 6px.
- **Status chip** `spStatus` (solid, uppercase 11px, `--sp-r1`) and **badge** `spBadge` (outlined, dot + text).
- **Tag** `spTag` (task type with a 8px square swatch), **priority** `spPriority` (flag icon + colour).
- **Avatar**: the existing `.avatar` / `.avatar.tiny` markup restyled inside the member app (circle, 24 / 20px, flat `--sp-accent-soft` fill with `--sp-accent-ink` initials — no gradient)
  and **entity square** `spSquare` (workspace/project initial, methodology colour).
- **Form**: `spField`, `spLabel`, `spInput`, `spSelect`, `spTextarea`, `spHint`, `spError`, checkbox/radio styling.
- **Panel** `spPanel` (bordered surface, `--sp-r2`, optional header row with title + actions) and **table/list**
  `spTable` rows (38px, hairline separators, sunken header).
- **Tabs** `spTabs` (underline, accent 2px on current, optional icon).
- **Page header** component (`PageHeader`): optional entity square, title (20px), inline meta (badges), actions on
  the right, optional tabs underneath. Replaces the eyebrow-pill `PageTitle` in member pages.
- **Stats strip** `spStats` (one bordered row of label/value cells, not separate cards).
- **Empty state** `spEmpty` (icon in a 40px square, 14px title, 13px text, one action; no animated rings).
- **Skeleton** `spSkeleton` (shimmer; static under reduced motion).
- **Alert** `spAlert` (info / warning / danger / success, left icon, `--sp-r2`).
- **Dialog and drawer**: restyle the existing `w/_components/modal.tsx` layer (`--sp-r3`, `--sp-e3`, 16px title,
  footer with right-aligned actions; drawer variant full-height from the right, full-screen on phones).
- **Menu/popover**: workspace switcher and move menu share one floating style.

Existing class names asserted by tests stay on the same elements (see Constraints). Where a screen's markup only
needs new styling, the builder may keep its `ws*` classes and restyle them on the tokens instead of renaming.

## The shell (`WorkspaceShell` in `src/app/components.tsx`)

Desktop (≥ 901px):

- **Sidebar 232px**, `--sp-side`, right hairline. Top row 48px: workspace switcher (square + name + role, up/down
  chevron) — the Spark wordmark moves to a small mark in the top-left of that row or is dropped from the sidebar;
  builder's call, but the `/` link must remain reachable (e.g. via the mark). Then nav (same labels, links, order
  and `aria-current` as today; Notifications keeps its unread badge, now an accent count pill), Governance Console
  for staff (same condition), then the "Projects" group (square in methodology colour, name, short key on the
  right, "New project" for managers, "All N projects" overflow link — same behaviour as today). Footer: user
  avatar, name, email, settings link, sign-out button (same accessible names).
- **Top bar 48px**, white, bottom hairline, sticky: breadcrumbs on the left (e.g. `Spark Lab › Projects › Smoke
  test` / `Spark Lab › Members`), nothing else on the right (no bell: the sidebar link already shows the unread count; no search).
  Breadcrumbs are passed by pages (a `crumbs` prop or derived from `current` + workspace + project); every crumb
  except the last is a link.
- **Main** scrolls inside the canvas; no glow blobs.

Mobile (≤ 900px): top bar shows a menu button + current crumb; the sidebar becomes an off-canvas drawer
(`--sp-move`, scrim, focus kept inside, Escape closes, route change closes — same behaviour and same
`.sidebarMenuDot` unread dot on the menu button that the notifications test queries). No horizontal page scroll at
390px.

## Screens and order

Built and reviewed in this order; each step ships complete (desktop, mobile, reduced motion) before the next:

1. **Foundation**: tokens on `:root` (namespaced `--sp-*`, so portalled dialogs get them), font, primitives,
   `PageHeader`. New file `src/app/_ui/app.css` imported from the root layout after `globals.css`.
2. **Shell**: sidebar, top bar, breadcrumbs, mobile drawer, workspace switcher menu, in-shell loading/error/not-found
   states, splash.
3. **Workspace home** (`w/[slug]/page.tsx`): page header with Invite + New project actions, stats strip (members,
   pending invites, projects with per-methodology counts — only data already loaded), projects as a **list/table**
   (one row per project, each row is the existing link with square, name, key, methodology chip, lead, progress bar
   and "x/y done" / "No tasks yet"), empty states. *Builder's call vs. mockup:* a flat list with a methodology
   column instead of groups per methodology, because each row must keep its methodology chip (tested) and grouping
   would repeat it.
4. **Members** (+ invite dialog, accept-invitation page) and **workspace insights**.
5. **Project area**: project header + tabs (`p/[key]/layout.tsx`), **board** (status-coloured column heads, WIP
   meter, dense cards with key, title, type tag, priority flag, due/overdue, assignee avatar, phase tag, drag/drop
   states), task drawer, move menu, **backlog** (sprint panels as list sections), sprint dialogs, **timeline**,
   phase plan dialog, **overview**, **project insights** (restyle the surrounding cards; `_ui/viz` charts stay as
   they are, only their container/typography tokens), **settings** + switch wizard, **new project** + methodology
   picker.
6. **Schedule** (week grid, agenda on phones, event dialog and details).
7. **Notifications** inbox, **settings/notifications**, **onboarding**.

After step 7, a sweep removes the now-dead member-app rules from `globals.css` (only rules no longer referenced
anywhere), so the old and new systems do not both exist.

## Constraints

- Keep every route, behaviour, accessible name/role, `aria-*` attribute and visible text that tests assert.
  Class names currently queried by tests must remain on the same elements: `.sidebarMenuDot`, `.wsBoardScroller`,
  `.wsBoardPhase`, `.wsTimelineVariance`, `.wsTimelineToday`, `.wsTimelineUnphased`, plus `data-methodology`,
  `data-category`, `data-priority`, `data-drop` hooks and all `viz*`/`adm*` classes used by `_ui/viz`.
- `sparkPrimary` / `sparkSecondary` are also used by the landing page and communities: do not change their global
  rules; member pages switch to `spBtn*` (or the override is scoped under `.appShell` / `.wsModalLayer`).
- Frontend `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` pass; report real counts.
- English only, LF line endings, no new dependencies, no `.superpowers` or stray files committed, commits without
  trailers, no push/merge. Restore `frontend/next-env.d.ts` if dev/build rewrites it; do not commit the
  Next-generated `frontend/CLAUDE.md`.
- Verified in a real browser as `user1@spark.app` at 1440 and 390, plus one reduced-motion pass, with before/after
  screenshots per step.

## Left to the builder

- Exact markup changes per screen, as long as behaviour and tested names stay.
- Whether a screen keeps restyled `ws*` classes or moves to `sp*` primitives.
- Icon drawings (16px, 1.75 stroke, round caps — same family as today's shell icons).
- Exact breakpoints inside screens (shell switches at 900px like admin).
- Whether the current user's own avatar gets the solid accent fill to stand out.
