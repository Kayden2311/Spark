# REST and Clean Architecture compliance

This document is the backend contract for `Spark_Core/backend`. Apply each rule to implemented features. Do not create placeholder layers, ports, or tests for hypothetical functionality.

## REST API

- Use `/api/v1` and plural, lowercase resource names such as `/communities` and `/join-requests`.
- Model resources in URLs. Use HTTP methods for CRUD behavior and a meaningful subresource for a domain command.
- `GET` is safe; `POST` creates or performs a non-idempotent command; `PUT` replaces; `PATCH` changes part of a resource; `DELETE` is idempotent in its final state.
- Return `201` and `Location` after creation, `202` for accepted asynchronous work, and `204` only with no body.
- Use `400`, `401`, `403`, `404`, `409`, `412`, `415`, `422`, `428`, and `429` consistently. A missing `If-Match` on a versioned update is `428 precondition_required`; a stale one is `412 version_mismatch` whose problem body also carries `current`, the up-to-date resource representation. Map dependency failures to `502`, `503`, or `504` only when their meaning is accurate.
- Errors use `application/problem+json` with stable `type`, `title`, `status`, `code`, and `requestId`. Never expose stacks, SQL, secrets, or private fields.
- Validate path, query, headers, and body before calling a use case. Serialize responses through an explicit schema.
- Large collections use deterministic cursor pagination with an opaque cursor and bounded `limit`.
- Authenticated responses default to `Cache-Control: private, no-store`. Public cacheable responses declare correct `Cache-Control`, validators, and `Vary` headers.
- Retry-sensitive mutations use an actor-scoped `Idempotency-Key`. Reusing the key with a different payload returns `409`. Repeating the same request with the same key replays the first result (same status and resource) and adds the response header `Idempotent-Replayed: true`; `POST /api/v1/projects/{projectId}/issues` keeps keys for 24 hours and answers a reused key with another body with `409 idempotency_key_reused`.
- Concurrent edits use `ETag`/`If-Match` or an explicit version contract. State-changing commands on a versioned resource require `If-Match` like a `PATCH` (`428` without it, `400 invalid_if_match` when malformed, `412 version_mismatch` with `current` when stale): `POST /api/v1/sprints/{sprintId}/start` and `/complete` (the sprint ETag), and `PUT /api/v1/projects/{projectId}/phases`, `POST /api/v1/projects/{projectId}/baseline`, `POST /api/v1/projects/{projectId}/methodology` and `PATCH /api/v1/projects/{projectId}/statuses/{statusId}` (the project ETag, `settings_version`). Planning objects with their own version use their own ETag: `PATCH /api/v1/sprints/{sprintId}` takes the sprint ETag and `PATCH /api/v1/milestones/{milestoneId}` the milestone ETag, not the project's; every project-level command above takes the project ETag. A refused command for a business reason is `409` with a specific `code` (for example `sprint_already_active`, `active_sprint`, `wip_below_occupancy`), and planning writes are limited to 30 per minute.
- Insight reads (`GET /api/v1/projects/{projectId}/insights/{summary|members|flow|cycle-time|aging-wip|velocity|schedule}`, `GET /api/v1/sprints/{sprintId}/burndown`, `GET /api/v1/workspaces/{workspaceId}/insights`) are safe `GET`s with no write or command form, open to every active workspace member with no extra role gate, and answer `Cache-Control: private, no-store` on success and on errors. Their query schemas reject unknown keys (`400`). `days` is an integer from 7 to 180 (default 30) counting UTC calendar days ending today; `6`, `181`, a fraction or text is `400`. `period` (velocity and schedule only) must be the id of one of the project's methodology periods (default the open one); an unknown or foreign id is `404 period_not_found`. A project, sprint or workspace the caller cannot see is a uniform `404` (`project_not_found`, `sprint_not_found`, `workspace_not_found`), resolved through RLS before any insight function runs; a sprint without dates is `409 sprint_missing_dates`. Responses are bounded (overdue 20 per project and 50 per workspace, scatter 500 points with `truncated`, aging 200, velocity 6 sprints) and say their unit (`points` or `count`).
- The workspace calendar read (`GET /api/v1/workspaces/{workspaceId}/calendar?from&to&tz`) is a safe `GET` open to every active workspace member, with `Cache-Control: private, no-store` on success and on errors. Its query schema rejects unknown keys (`400`). `from` and `to` are ISO 8601 instants with an explicit offset (a leap second or a missing offset is `400 invalid_input`), `from` is before `to` and the span is at most 62 days (otherwise `400`); `tz` is an IANA zone known to the database (default `UTC`, an unknown name is `400 invalid_input`). Events are selected by overlap (`starts_at < to` and `ends_at > from`) and deadlines by calendar date in `tz`, so the client asks for the bounds of its own local week. Responses are bounded (500 events, 500 deadlines, each with a `truncated` flag), and a workspace the caller does not belong to is the uniform `404 workspace_not_found`.
- Calendar event commands follow the versioned-resource rules: `POST /api/v1/workspaces/{workspaceId}/calendar-events` answers `201` with `Location` and `ETag`; `PATCH /api/v1/calendar-events/{eventId}` and the command `POST /api/v1/calendar-events/{eventId}/cancel` (no body; an empty object is accepted, anything else is `400`) require `If-Match` (`428`, `400 invalid_if_match`, `412 version_mismatch` with `current`). `PUT /api/v1/calendar-events/{eventId}/attendees/me` replaces the caller's own answer (`accepted`, `declined` or `tentative`) and takes no `If-Match`: it changes the attendee row, not the event version. Refusals are `403 insufficient_role` (not the organizer, owner or admin), `403 not_invited`, `409 event_cancelled` (a cancelled event cannot change or be answered) and `409 event_already_cancelled`; an unknown id and an event of another workspace are the same `404 event_not_found`, decided before any role or validation outcome so ids cannot be probed. Input rules that the database enforces (title, description, location, time span, time zone, project, task, attendees) are `22023` errors mapped to `400` with a whitelisted message.
- OpenAPI describes every implemented status, media type, header, authentication rule, and limit.
- State-changing requests with an `Origin` that is not an allowed frontend origin, or marked `Sec-Fetch-Site: cross-site`, are refused with `403 origin_not_allowed` (`src/routes/origin-guard.ts`).
- Platform governance writes (`/api/v1/admin/*`) require a `reason` of 3 to 500 characters and are recorded in the platform audit log in the same transaction.
- Credential operations (`POST /api/v1/auth/password/sign-up` and `/sign-in`) are served by the private auth process (`src/auth-server.ts`) under the same paths. The public API forwards them unchanged with the client address in `X-Forwarded-For` and relays status, body and `Set-Cookie`. If the auth process is unreachable the API returns `503` with `code: auth_unavailable`. No other route may move into the auth process without a matching security reason.

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

Database rows, domain entities, and API DTOs are separate roles. Map them explicitly when their shapes or trust boundaries differ. Avoid generic repositories and shared `utils` modules that collect unrelated behavior. Cross-module calls use a public application contract. Circular dependencies are not allowed; no automated cycle gate exists yet, so reviewers check them manually.

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
