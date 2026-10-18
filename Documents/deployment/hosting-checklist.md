# Hosting checklist

Status: **not started.** Nothing here is configured or verified on a hosting platform yet. Tick an item only after checking it on the real deployment.

The backend runs as three processes from one build (see [database schema: runtime access model](../architecture/database-schema.md) and the per-process variable table in [Spark_Core/README.md](../../Spark_Core/README.md#running-the-auth-process-in-production)):

| Process | Start command | Default port | Exposure |
| --- | --- | --- | --- |
| API | `pnpm --filter @spark/backend start` | 4000 | public |
| Auth | `pnpm --filter @spark/backend start:auth` | 4100 | private |
| Worker | `pnpm --filter @spark/backend start:worker` | none | no inbound traffic; outbound SMTP and PostgreSQL only |

## Auth process

- [ ] **Give each process only its own secrets.**
  - API: `DATABASE_URL` (`spark_app`) and `AUTH_SERVICE_URL` only.
  - Auth: `AUTH_DATABASE_URL` (`spark_auth`) only.
  - Worker: `WORKER_DATABASE_URL` (`spark_worker`) and the SMTP credentials only (see "Worker process").
  - No runtime process gets `MIGRATION_DATABASE_URL`; run migrations as a separate release step.
  - Each process refuses to start in production when it sees another process's database secret.
- [ ] **Allow only the API to reach the auth port.** Use a firewall rule, security group or network policy so that nothing else (including the public internet) can connect to port 4100. Nothing else authenticates the API to the auth process.
- [ ] **Put a TLS terminator in front of the auth process if it runs on another host.** The auth process listens on plain HTTP, and the API refuses a non-HTTPS `AUTH_SERVICE_URL` unless it points at loopback. The terminator must preserve the `X-Forwarded-For` header the API sends.
- [ ] **List the API hosts, and the terminator, in `AUTH_TRUSTED_PROXIES`.** The auth process uses this list to read the real client IP for sign-in rate limits. If an API host or the terminator is left out, all of its users share a single sign-in rate limit.

## Worker process

- [ ] **Keep `WORKER_DATABASE_URL` in the worker's secrets only.** The API and auth processes refuse to start in production when it is set, and the worker refuses `DATABASE_URL`, `AUTH_DATABASE_URL` and `MIGRATION_DATABASE_URL`. `spark_worker` can claim and settle outbox events and issue invitation tokens, so treat it like any other database secret.
- [ ] **Provision `SMTP_URL` with the provider's credentials as a worker-only secret, and make sure the connection is encrypted.** Use `smtps://` (implicit TLS, usually port 465) or `smtp://` on a port where the provider supports STARTTLS (usually 587). In production the worker sets nodemailer `requireTLS`, so a server without STARTTLS fails the send instead of falling back to plain text, and it rejects query options in `SMTP_URL`. Set `EMAIL_FROM` to an address on a domain with SPF and DKIM configured for the provider.
- [ ] **Set `APP_BASE_URL` to the public HTTPS web app URL.** Invitation links are built from it; the worker refuses a non-HTTPS value in production.
- [ ] **Run a single worker instance**, or accept occasional duplicate emails. Claims use `SKIP LOCKED` and leases, so several workers never lose events, but delivery is at least once: an event whose lease expires mid-send can be sent again, and each send issues a new invitation link that replaces the previous one.
- [ ] **Do not deploy Mailpit.** It is the local development SMTP catcher only and keeps no messages across restarts.

## Verify after deploying

- [ ] `GET /health` returns 200 on the API, and on the auth process from inside the private network only.
- [ ] Sign-up, sign-in, `/me` and sign-out work through the public API URL.
- [ ] Connecting to the auth port from outside the private network fails.
- [ ] Two clients from different IPs get separate sign-in rate limits.
- [ ] The worker logs `Worker started`, and an invitation sent through the API arrives in a real inbox with an HTTPS accept link.

## Follow-ups to consider

- mTLS between the API and the auth process if network policy alone is not enough.
- A per-account sign-in attempt limit (today the limits are per client IP only).
