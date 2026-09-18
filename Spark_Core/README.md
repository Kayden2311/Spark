# Spark Core
 
This workspace contains two applications: a Next.js 16 frontend and a Fastify backend. The backend uses local PostgreSQL on port 5432 with Drizzle ORM migrations, while Redis runs through Docker Compose. Backend code must not be placed in Next.js API routes.
 
## Requirements
 
- Node.js 26 (see `.node-version` / `.nvmrc`)
- pnpm 11.19.0
- PostgreSQL 18 running at `127.0.0.1:5432`; the bootstrap script creates the `spark` database and the `spark_owner`, `spark_migrator`, and `spark_app` roles
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
- OpenAPI Swagger docs: `http://127.0.0.1:4000/documentation`
 
`pnpm infra:down` stops the Redis container and preserves its named volume. PostgreSQL runs as a Windows service and is unaffected by this command.
 
`pnpm db:bootstrap:local` requests the PostgreSQL administrator password through a secure prompt and creates the `spark` database idempotently. It normalizes database ownership, role attributes and memberships, and database and schema privileges. Table, sequence, and function privileges belong to their corresponding migrations and require an allowlist or integration test.
 
## Seeded accounts
 
- **Standard User**: `user1@spark.app` / `UserPassword123!` (Workspace `spark-lab` owner)
- **Platform Admin**: `admin@spark.app` / `AdminPassword123!` (`super_admin`, `platform_admin`, `community_moderator`, `content_moderator`, `campaign_moderator`)
 
## Verification
 
```powershell
pnpm check
pnpm --filter @spark/backend test:database
```
 
This command runs the checks implemented by the current MVP: lint, type checking, focused unit tests, PostgreSQL RLS / role database tests, and production builds.
