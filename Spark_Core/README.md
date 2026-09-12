# Spark Core

This workspace contains two applications: a Next.js frontend and a Fastify backend. The backend uses local PostgreSQL on port 5432, while Redis runs through Docker Compose. Backend code must not be placed in Next.js API routes.

## Requirements

- Node.js 24 LTS (see `.node-version` / `.nvmrc`)
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
pnpm dev
```

- Frontend: http://127.0.0.1:3000
- Backend health: http://127.0.0.1:4000/health

`pnpm infra:down` stops the Redis container and preserves its named volume. PostgreSQL runs as a Windows service and is unaffected by this command.

`pnpm db:bootstrap:local` requests the PostgreSQL administrator password through a secure prompt and creates the `spark` database idempotently. It normalizes database ownership, role attributes and memberships, and database and schema privileges. Table, sequence, and function privileges belong to their corresponding migrations and require an allowlist or integration test. The bootstrap process does not revoke them indiscriminately. The owner role cannot log in. Sample passwords are for local development only; every other environment must use dedicated secrets.

## Verification

```powershell
pnpm check
```

This command runs the checks implemented by the current MVP: lint, type checking, focused tests, and production builds. Add RLS, migration, REST contract, and end-to-end gates with the features that require them.
