# Spark

Spark is a lightweight platform for startup communities to discover each other, manage membership, collaborate on Kanban projects, and moderate content. The repository follows a production-ready MVP approach: it keeps the architecture small while retaining clear API contracts, secure defaults, transactional data rules, caching guidance, distributed rate limiting, and an automated quality gate.

## Architecture

Application code is split into two deployable parts under [`Spark_Core`](Spark_Core/):

- `frontend`: Next.js 16, React 19, and TypeScript with UI/UX Pro Max design system (dark glassmorphism, responsive navigation, production-ready login with OAuth suite, interactive Platform Governance Console at `/admin`, and landing page showcases).
- `backend`: Fastify and TypeScript as a pragmatic Clean Architecture modular monolith.

PostgreSQL is the source of truth, managed through Drizzle ORM migrations (`0000_init.sql` to `0005_platform_roles.sql`) with row-level security (RLS) enforcement. Authentication uses Argon2id password hashing with SHA-256 bytea opaque session tokens. Redis supports distributed rate limiting and caching.

## Requirements

- Node.js 26 (see `.node-version` / `.nvmrc`)
- pnpm 11.19.0
- PostgreSQL 18 on `127.0.0.1:5432`
- Docker Engine or Docker Desktop for local Redis

## Getting started

```powershell
Set-Location Spark_Core
Copy-Item .env.example .env
Copy-Item frontend/.env.example frontend/.env.local
pnpm install --frozen-lockfile
pnpm db:bootstrap:local
pnpm infra:up
pnpm --filter @spark/backend db:migrate
pnpm dev
```

### Seeded development accounts

To seed initial test accounts for local development:

```powershell
pnpm --filter @spark/backend exec node --env-file=../.env --import tsx scripts/seed-users.ts
```

- **Standard User**: `user1@spark.app` / `UserPassword123!` (Owner of workspace `spark-lab`)
- **Platform Admin**: `admin@spark.app` / `AdminPassword123!` (Platform staff: `super_admin`, `platform_admin`, `community_moderator`, `content_moderator`, `campaign_moderator`)

### Endpoints and pages

- **Frontend Landing**: `http://127.0.0.1:3000`
- **Sign In**: `http://127.0.0.1:3000/login`
- **Platform Admin Console**: `http://127.0.0.1:3000/admin`
- **Backend Health**: `http://127.0.0.1:4000/health`
- **OpenAPI Documentation**: `http://127.0.0.1:4000/documentation`

## Quality checks

```powershell
Set-Location Spark_Core
pnpm check
pnpm --filter @spark/backend test:database
```

The quality gate runs linting, type checking, focused unit tests, database integration tests against real PostgreSQL roles/RLS, and production builds.

## Documentation

- [Product and architecture context](Documents/context.md)
- [REST and Clean Architecture rules](Documents/architecture/rest-clean-compliance.md)
- [Database schema design](Documents/architecture/database-schema.md)
- [Backend delivery backlog](Documents/architecture/backend-delivery-backlog.md)
- [Screen flow and user journeys](Documents/product/screen-flow.md)
- [Development automation](Documents/automation/README.md)
- [Spark Core setup](Spark_Core/README.md)

## License

No license has been selected yet.
