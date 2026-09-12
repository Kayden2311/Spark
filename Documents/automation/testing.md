# Testing policy

Run tests that protect real behavior. Do not add tests that merely mirror an implementation or exercise placeholder architecture.

## Change-based coverage

| Change | Required evidence |
| --- | --- |
| Frontend | Lint, types, affected UI behavior, contract compatibility, and production build. |
| Backend | Lint, types, affected unit or route tests, dependency integration when used, and build. |
| API contract | Schema/OpenAPI checks plus affected frontend and backend consumers. |
| Database or RLS | Migration from empty and previous schema, constraints, runtime-role isolation, rollback behavior, and concurrency where relevant. |
| Auth, cache, or limiter | Authorization/privacy, expiration, invalidation, outage, and multi-instance behavior. |
| Tooling, lockfile, infra, or CI | Full repository baseline and configuration validation. |
| Documentation only | Links, language policy, and secret scan when a trustworthy classifier exists. |

## Test design

Use unit tests for business invariants and pure policies. Use integration tests when behavior depends on PostgreSQL, Redis, Fastify wiring, transactions, permissions, or serialization. Use end-to-end tests only for implemented critical user journeys.

Tests must be deterministic, bounded by timeouts, and isolated by database/schema or cache namespace. Fixtures contain no real user data. Do not hide infrastructure failures as skipped tests. A retry may diagnose flakiness but does not erase the original failure.

For REST endpoints, cover meaningful success, validation, documented errors, authorization, response schema, and relevant idempotency or concurrency. Database tests use the runtime role and at least two tenants once tenancy exists.

Report the exact command, tested commit, pass/fail/skip counts, duration, and limitations. Never report an unrun suite as passing.
