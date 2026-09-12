# REST and Clean Architecture compliance

This document is the backend contract for `Spark_Core/backend`. Apply each rule to implemented features. Do not create placeholder layers, ports, or tests for hypothetical functionality.

## REST API

- Use `/api/v1` and plural, lowercase resource names such as `/communities` and `/join-requests`.
- Model resources in URLs. Use HTTP methods for CRUD behavior and a meaningful subresource for a domain command.
- `GET` is safe; `POST` creates or performs a non-idempotent command; `PUT` replaces; `PATCH` changes part of a resource; `DELETE` is idempotent in its final state.
- Return `201` and `Location` after creation, `202` for accepted asynchronous work, and `204` only with no body.
- Use `400`, `401`, `403`, `404`, `409`, `412`, `415`, `422`, and `429` consistently. Map dependency failures to `502`, `503`, or `504` only when their meaning is accurate.
- Errors use `application/problem+json` with stable `type`, `title`, `status`, `code`, and `requestId`. Never expose stacks, SQL, secrets, or private fields.
- Validate path, query, headers, and body before calling a use case. Serialize responses through an explicit schema.
- Large collections use deterministic cursor pagination with an opaque cursor and bounded `limit`.
- Authenticated responses default to `Cache-Control: private, no-store`. Public cacheable responses declare correct `Cache-Control`, validators, and `Vary` headers.
- Retry-sensitive mutations use an actor-scoped `Idempotency-Key`. Reusing the key with a different payload returns `409`.
- Concurrent edits use `ETag`/`If-Match` or an explicit version contract.
- OpenAPI describes every implemented status, media type, header, authentication rule, and limit.

## Clean Architecture

Dependencies point inward:

```text
presentation -> application <- infrastructure
                    |
                    v
                  domain
```

- Domain contains entities, value objects, invariants, and domain errors. It imports no Fastify, Drizzle, Redis, environment, logging, filesystem, or network code.
- Application contains use cases and small consumer-owned ports. It coordinates transaction boundaries and imports no concrete adapter.
- Presentation validates transport input, obtains the authenticated actor, calls a use case, and maps results to HTTP.
- Infrastructure implements database, cache, and provider ports. It does not decide business policy or construct HTTP responses.
- The composition root validates configuration, creates adapters, wires use cases, and owns lifecycle.

Database rows, domain entities, and API DTOs are separate roles. Map them explicitly when their shapes or trust boundaries differ. Avoid generic repositories and shared `utils` modules that collect unrelated behavior. Cross-module calls use a public application contract. Circular dependencies fail CI.

A simple technical endpoint may use a direct, small implementation when no domain rule exists. Introduce an interface when there is a real alternate adapter, test boundary, or dependency inversion need.

## Transactions and failures

- A use case owns the transaction for writes that must commit atomically.
- Repositories participating in one operation share the same unit of work.
- Protect invariants with database constraints and appropriate locking.
- Publish external effects after commit; use an outbox when reliable delivery is required.
- Pass deadlines and cancellation to adapters when an operation can block.
- Domain errors describe business meaning. Presentation owns HTTP status mapping.
- Log unexpected infrastructure failures with a request ID and sanitized context.

## Required checks

For each changed endpoint, test the meaningful success path, validation, documented errors, authorization boundary, and relevant concurrency or idempotency behavior. Run import-boundary checks and ensure OpenAPI matches runtime behavior. Database changes also require migration and integration tests using the runtime role.

A change is compliant only when its code and applicable checks exist and pass. A diagram, agent report, or generated graph is supporting evidence, not proof of runtime correctness.
