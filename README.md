# Spark

Spark is a lightweight platform for startup communities to discover each other, manage membership, and collaborate. The repository follows a production-ready MVP approach: it keeps the architecture small while retaining clear API contracts, secure defaults, transactional data rules, caching guidance, distributed rate limiting, and an automated quality gate.

## Architecture

Application code is split into two deployable parts under [`Spark_Core`](Spark_Core/):

- `frontend`: Next.js, React, and TypeScript.
- `backend`: Fastify and TypeScript as a modular monolith.

PostgreSQL is the source of truth. Redis supports distributed rate limiting and will support caching for measured read paths. Drizzle will be introduced with the first product schema or migration.

## Requirements

- Node.js 24 LTS
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
pnpm dev
```

The frontend runs at `http://127.0.0.1:3000`. The backend health endpoint is `http://127.0.0.1:4000/health`.

## Quality checks

```powershell
Set-Location Spark_Core
pnpm check
pnpm audit --prod
```

The quality gate runs linting, type checking, focused tests, Redis integration coverage when `TEST_REDIS_URL` is configured, and production builds.

## Documentation

- [Product and architecture context](Documents/context.md)
- [REST and Clean Architecture rules](Documents/architecture/rest-clean-compliance.md)
- [Development automation](Documents/automation/README.md)
- [Spark Core setup](Spark_Core/README.md)

## Project status

The repository currently provides the frontend and backend foundation. Product features such as authentication, community discovery, membership, and content workflows will be added incrementally with their database schemas and authorization rules.

## License

No license has been selected yet.
