import pg from "pg";

import { localConnection } from "./database-support.js";

/**
 * Drops the local application schema and its migration history so `db:migrate`, `db:seed` and
 * `db:seed:demo` can rebuild it from scratch. Local development only; it never runs against another host.
 * Requires `--yes`, because every row (including the append-only audit log) is deleted.
 */

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to reset: NODE_ENV is production.");
  process.exit(1);
}
// Throws unless the URL points at localhost without connection-parameter overrides.
const connectionString = localConnection("MIGRATION_DATABASE_URL");
if (!process.argv.includes("--yes")) {
  console.error("This deletes all local Spark data. Run again with --yes to confirm: pnpm db:reset:local --yes");
  process.exit(1);
}

const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
await client.connect();
try {
  await client.query("SET ROLE spark_owner");
  await client.query("DROP SCHEMA IF EXISTS spark CASCADE");
  await client.query("DROP SCHEMA IF EXISTS spark_migrations CASCADE");
  console.log("Local schema dropped. Next: pnpm db:migrate, pnpm db:seed, then optionally pnpm db:seed:demo.");
} finally {
  await client.end();
}
