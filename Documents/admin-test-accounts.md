# Admin console test accounts

Every account below is created by `pnpm --filter @spark/backend db:seed`. It is idempotent: running it
again updates passwords and role grants instead of failing, so it is safe to re-run at any time.
Accounts are local-development only — `db:seed` refuses to run against a non-local database.

For the richer dataset behind the charts (communities, posts, reports, subscriptions, six months of
history), also run `pnpm --filter @spark/backend db:seed:demo` after `db:seed`. See
`Spark_Core/README.md` for the full local setup and `pnpm db:reset:local --yes` to start over.

## Why there are eight accounts

`admin@spark.app` holds all five platform roles, which is convenient for most testing but hides what a
*single* role actually sees — its sidebar and its "Roles & access" permissions are the union of
everything. `moderator@spark.app` holds two roles together, for testing a realistic multi-role case.
The five single-role accounts added below hold **exactly one role each**, so you can sign in as one and
confirm the console shows only what that role is meant to see.

## Accounts

| # | Role(s) | Email | Password | Display name |
|---|---|---|---|---|
| 1 | All five (`super_admin`, `platform_admin`, `community_moderator`, `content_moderator`, `campaign_moderator`) | `admin@spark.app` | `AdminPassword123!` | Spark Admin |
| 2 | `content_moderator` + `community_moderator` | `moderator@spark.app` | `ModeratorPassword123!` | Spark Moderator |
| 3 | None (ordinary member) | `user1@spark.app` | `UserPassword123!` | Spark User 1 |
| 4 | `super_admin` only | `superadmin@spark.app` | `SuperAdminPassword123!` | Spark Super Admin |
| 5 | `platform_admin` only | `platformadmin@spark.app` | `PlatformAdminPassword123!` | Spark Platform Admin |
| 6 | `community_moderator` only | `communitymod@spark.app` | `CommunityModPassword123!` | Spark Community Mod |
| 7 | `content_moderator` only | `contentmod@spark.app` | `ContentModPassword123!` | Spark Content Mod |
| 8 | `campaign_moderator` only | `campaignmod@spark.app` | `CampaignModPassword123!` | Spark Campaign Mod |

User 1 (#3) owns the `spark-lab` workspace and the seeded `hyperdrive` and `zero-to-one` communities. It
holds no platform role, so it cannot open `/admin` at all — use it to confirm the console turns away
non-staff members, and to test the ordinary member-facing app (workspace, communities, posts).

## What each role sees in the sidebar

The sidebar is identical to the API's own role checks (`src/routes/admin/*`, enforced again by the
database's `staff_*` functions — the UI is never the only gate). A role not listed for a section gets a
403 if it tries the URL directly, not just a hidden link.

| Section | super_admin | platform_admin | community_moderator | content_moderator | campaign_moderator |
|---|:---:|:---:|:---:|:---:|:---:|
| Overview | ✅ | ✅ | ✅ | ✅ | ✅ |
| Analytics (incl. System health) | ✅ | ✅ | – | – | – |
| Reports | ✅ | ✅ | – | ✅ | – |
| Communities | ✅ | ✅ | ✅ | – | – |
| Campaigns | ✅ | ✅ | – | – | ✅ |
| Users | ✅ | ✅ | – | – | – |
| Billing | ✅ | ✅ | – | – | – |
| Audit log | ✅ | ✅ | – | – | – |

## What each role can *do*

This mirrors the live "Roles & access" tab at `/admin/users?view=roles` (go there as any admin-tier
account to see it rendered, plus a live count of who currently holds each role).

| Capability | super_admin | platform_admin | community_moderator | content_moderator | campaign_moderator |
|---|:---:|:---:|:---:|:---:|:---:|
| Resolve reported content (hide / keep / dismiss) | ✅ | ✅ | – | ✅ | – |
| Moderate communities (feature / freeze / archive / restore) | ✅ | ✅ | ✅ | – | – |
| Review sponsored campaigns (approve / reject) | ✅ | ✅ | – | – | ✅ |
| Suspend or reactivate accounts | ✅ | ✅ | – | – | – |
| Grant or revoke platform roles | ✅ | – | – | – | – |
| Analytics and system health | ✅ | ✅ | – | – | – |
| Billing insights (read-only) | ✅ | ✅ | – | – | – |
| Audit log and CSV export | ✅ | ✅ | – | – | – |

Notes:
- Suspending or reactivating an account that itself holds a platform role needs `super_admin`; a plain
  `platform_admin` can only act on ordinary members. Try this with accounts #4 and #5 against each other.
- The last active `super_admin` cannot be suspended or have the role revoked — the API returns 409
  `last_super_admin`. Do not revoke `super_admin` from account #4 if it is the only one left; grant it to
  a second account first if you need to test removal.
- `super_admin` and `platform_admin` are otherwise equivalent in the sidebar; the only functional gap
  between them is role management, tested above.

## Suggested checks per account

- **`superadmin@spark.app`** — confirm every section is visible, and that granting/revoking a role on
  another account (e.g. toggle `content_moderator` on `user1@spark.app`) works and appears in the audit
  log with a reason.
- **`platformadmin@spark.app`** — confirm the sidebar matches super_admin, but the "Grant" / "Revoke"
  buttons on `/admin/users/{id}` are hidden or refused, and suspending another admin-tier account (e.g.
  `communitymod@spark.app`) is refused.
- **`communitymod@spark.app`** — confirm only Overview and Communities are visible; feature, freeze,
  archive and restore a seeded community; confirm Reports/Users/Billing/Analytics routes 403 if opened
  directly.
- **`contentmod@spark.app`** — confirm only Overview and Reports are visible; triage a report (hide /
  keep / dismiss with a reason) using the queue's keyboard shortcuts (`j`/`k`, `h`, `e`, `d`).
- **`campaignmod@spark.app`** — confirm only Overview and Campaigns are visible; approve or reject a
  seeded pending campaign on the board view.
- **`moderator@spark.app`** — confirm the sidebar is the *union* of content_moderator and
  community_moderator (Overview, Reports, Communities), not more.
- **`user1@spark.app`** — confirm `/admin` redirects or shows "This area is for Spark staff", and the
  ordinary app (workspace, posts, communities) works normally.

## Resetting

```powershell
pnpm --filter @spark/backend db:reset:local --yes   # drops the local schema
pnpm --filter @spark/backend db:migrate
pnpm --filter @spark/backend db:seed                # recreates all eight accounts above
pnpm --filter @spark/backend db:seed:demo           # optional: communities, posts, reports, billing history
```

`db:seed` alone is also safe to re-run at any time without a reset; it only inserts what is missing and
refreshes passwords/role grants on accounts that already exist.
