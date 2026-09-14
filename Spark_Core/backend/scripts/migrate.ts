import { resolve } from "node:path";
import pg from "pg";
import { applyMigrations, localConnection } from "./database-support.js";

const client = new pg.Client({ connectionString: localConnection("MIGRATION_DATABASE_URL"), connectionTimeoutMillis: 5000 });
try {
  await client.connect();
  await applyMigrations(client, resolve("drizzle"));
  const result = await client.query("SELECT count(*)::integer AS tables FROM pg_tables WHERE schemaname='spark'");
  console.log(`Local migrations applied successfully (${result.rows[0].tables} application tables).`);
} catch (error) {
  // PostgreSQL detail can include credentials or application row contents.
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "migration_failure";
  console.error(`Local migration failed (${code}). Inspect the migration in an isolated test schema.`);
  process.exitCode = 1;
} finally { await client.end(); }
