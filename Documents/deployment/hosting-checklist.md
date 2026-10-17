# Hosting checklist

Status: **not started.** Nothing here is configured or verified on a hosting platform yet. Tick an item only after checking it on the real deployment.

The backend runs as two processes from one build (see [database schema: runtime access model](../architecture/database-schema.md) and the per-process variable table in [Spark_Core/README.md](../../Spark_Core/README.md#running-the-auth-process-in-production)):

| Process | Start command | Default port | Exposure |
| --- | --- | --- | --- |
| API | `pnpm --filter @spark/backend start` | 4000 | public |
| Auth | `pnpm --filter @spark/backend start:auth` | 4100 | private |

## Auth process

- [ ] **Give each process only its own secrets.**
  - API: `DATABASE_URL` (`spark_app`) and `AUTH_SERVICE_URL` only.
  - Auth: `AUTH_DATABASE_URL` (`spark_auth`) only.
  - Neither runtime process gets `MIGRATION_DATABASE_URL`; run migrations as a separate release step.
  - Both processes refuse to start in production when they see the other's database secret.
- [ ] **Allow only the API to reach the auth port.** Use a firewall rule, security group or network policy so that nothing else (including the public internet) can connect to port 4100. Nothing else authenticates the API to the auth process.
- [ ] **Put a TLS terminator in front of the auth process if it runs on another host.** The auth process listens on plain HTTP, and the API refuses a non-HTTPS `AUTH_SERVICE_URL` unless it points at loopback. The terminator must preserve the `X-Forwarded-For` header the API sends.
- [ ] **List the API hosts, and the terminator, in `AUTH_TRUSTED_PROXIES`.** The auth process uses this list to read the real client IP for sign-in rate limits. If an API host or the terminator is left out, all of its users share a single sign-in rate limit.

## Verify after deploying

- [ ] `GET /health` returns 200 on the API, and on the auth process from inside the private network only.
- [ ] Sign-up, sign-in, `/me` and sign-out work through the public API URL.
- [ ] Connecting to the auth port from outside the private network fails.
- [ ] Two clients from different IPs get separate sign-in rate limits.

## Follow-ups to consider

- mTLS between the API and the auth process if network policy alone is not enough.
- A per-account sign-in attempt limit (today the limits are per client IP only).
