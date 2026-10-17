# Spark Core
 
This workspace contains two applications: a Next.js 16 frontend and a Fastify backend. The backend uses local PostgreSQL on port 5432 with Drizzle ORM migrations, while Redis runs through Docker Compose. Backend code must not be placed in Next.js API routes.
 
## Requirements
 
- Node.js 26 (see `.node-version` / `.nvmrc`)
- pnpm 11.19.0
- PostgreSQL 18 running at `127.0.0.1:5432`; the bootstrap script creates the `spark` database and the `spark_owner`, `spark_migrator`, `spark_app`, and login-only `spark_auth` roles
- Docker Engine or Docker Desktop for Redis
 
## Local development
 
```powershell
Copy-Item .env.example .env
Copy-Item frontend/.env.example frontend/.env.local
pnpm install --frozen-lockfile
pnpm db:bootstrap:local
pnpm infra:up
pnpm --filter @spark/backend db:migrate
pnpm --filter @spark/backend exec node --env-file=../.env --import tsx scripts/seed-users.ts
pnpm dev
```
 
- Frontend: `http://127.0.0.1:3000`
- Sign In: `http://127.0.0.1:3000/login`
- Platform Admin Console: `http://127.0.0.1:3000/admin`
- Backend health: `http://127.0.0.1:4000/health`
- Auth process health (private, loopback only): `http://127.0.0.1:4100/health`. `pnpm dev` starts both backend processes; the API forwards sign-up and sign-in to it.
- OpenAPI: generated in-process by `@fastify/swagger` (`app.swagger()`); no documentation page is served yet.

### Running the auth process in production

The backend build has two entrypoints: `pnpm --filter @spark/backend start` (public API) and `pnpm --filter @spark/backend start:auth` (private auth process). Give each process only its own secrets:

| Variable | API process | Auth process |
| --- | --- | --- |
| `DATABASE_URL` (`spark_app`) | required | must not be set |
| `AUTH_DATABASE_URL` (`spark_auth`) | must not be set | required |
| `MIGRATION_DATABASE_URL` | must not be set | must not be set |
| `AUTH_SERVICE_URL` | required; HTTPS unless loopback | not used |
| `AUTH_HOST` / `AUTH_PORT` | not used | private interface and port (default `127.0.0.1:4100`) |
| `AUTH_TRUSTED_PROXIES` | not used | required: exactly the API hosts' addresses, so rate limits key on the real client IP |

Every API instance must be listed in `AUTH_TRUSTED_PROXIES`; an unlisted instance makes all its users share one rate-limit bucket. Allow only the API to reach the auth port.

The auth process listens on plain HTTP. When it runs on another host, put a TLS terminator in front of it (required: `AUTH_SERVICE_URL` must be HTTPS off-loopback). The terminator then becomes the connecting peer, so list the terminator's address in `AUTH_TRUSTED_PROXIES` as well and make sure it preserves the API's `X-Forwarded-For` header.

The step-by-step deployment checklist lives in [Documents/deployment/hosting-checklist.md](../Documents/deployment/hosting-checklist.md).
 
`pnpm infra:down` stops the Redis container and preserves its named volume. PostgreSQL runs as a Windows service and is unaffected by this command.
 
`pnpm db:bootstrap:local` requests the PostgreSQL administrator password through a secure prompt and creates the `spark` database idempotently. It normalizes database ownership, role attributes and memberships, and database and schema privileges. Table, sequence, and function privileges belong to their corresponding migrations and require an allowlist or integration test.
 
## Seeded accounts
 
- **Standard User**: `user1@spark.app` / `UserPassword123!` (Workspace `spark-lab` owner)
- **Platform Admin**: `admin@spark.app` / `AdminPassword123!` (`super_admin`, `platform_admin`, `community_moderator`, `content_moderator`, `campaign_moderator`)
- **Moderator**: `moderator@spark.app` / `ModeratorPassword123!` (`content_moderator`, `community_moderator`; useful for checking role-gated sections)
- Five more accounts, one per platform role held in isolation (`super_admin` only, `platform_admin` only, and one per moderator role) — see `Documents/admin-test-accounts.md` for the full roster, passwords and what to test with each.

`pnpm --filter @spark/backend db:seed` also creates two pending sponsored campaigns when none exist.

### Demo data for the admin console

```powershell
pnpm --filter @spark/backend db:seed:demo
```

Adds about 240 members with six months of sign-ins, posts and comments, 14 communities, reports in every state, campaigns, Free/Starter/Pro/Business plans with subscriptions and invoices, and staff history, so the charts in `/admin` have something to show. Run it after `db:seed`. It only works against a local database and runs once; paid subscriptions use the provider `demo`, and no real payments are involved.

To start over (this deletes all local Spark data):

```powershell
pnpm --filter @spark/backend db:reset:local --yes
pnpm --filter @spark/backend db:migrate
pnpm --filter @spark/backend db:seed
pnpm --filter @spark/backend db:seed:demo
```
 
## Verification
 
```powershell
pnpm check
pnpm --filter @spark/backend test:database
```
 
This command runs the checks implemented by the current MVP: lint, type checking, focused unit tests, PostgreSQL RLS / role database tests, and production builds.
