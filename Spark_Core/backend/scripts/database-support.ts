import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Client } from "pg";

export function localConnection(name: string): string {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required`);
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("This command only operates on local PostgreSQL");
  }
  if (url.search) throw new Error("Local database URL must not contain connection parameter overrides");
  return raw;
}

export async function applyMigrations(client: Client, folder: string, namespace = "spark", journal = "spark_migrations") {
  if (!/^[a-z][a-z0-9_]*$/u.test(namespace) || !/^[a-z][a-z0-9_]*$/u.test(journal)) throw new Error("Invalid schema identifier");
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  await client.query("SET ROLE spark_owner");
  await client.query("SET lock_timeout = '5s'");
  await client.query("SET statement_timeout = '60s'");
  await client.query("SELECT pg_advisory_lock(hashtext($1),0)", [`${namespace}:migrations`]);
  try {
    const existing = await client.query("SELECT to_regclass($1) AS journal", [`${journal}.__drizzle_migrations`]);
    if (existing.rows[0].journal) {
      const applied = await client.query<{ hash: string; created_at: string }>(`SELECT hash,created_at FROM "${journal}".__drizzle_migrations ORDER BY created_at,id`);
      if (applied.rows.length > migrations.length || applied.rows.some((row, i) => row.hash !== migrations[i]?.hash || Number(row.created_at) !== migrations[i]?.folderMillis)) {
        throw new Error("Migration history differs from committed files; restore the reviewed migration files");
      }
    } else {
      const occupied = await client.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [namespace]);
      if (occupied.rowCount) throw new Error("Refusing to adopt an existing unmanaged application schema");
    }
    await migrate(drizzle(client), { migrationsFolder: folder, migrationsSchema: journal });
    await client.query(`REVOKE ALL ON SCHEMA "${journal}" FROM PUBLIC, spark_app`);
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1),0)", [`${namespace}:migrations`]);
    await client.query("RESET ROLE");
  }
}
