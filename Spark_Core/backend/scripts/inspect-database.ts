import pg from "pg";
import { localConnection } from "./database-support.js";
const client = new pg.Client({ connectionString: localConnection("MIGRATION_DATABASE_URL"), connectionTimeoutMillis: 5000 });
try {
  await client.connect();
  const tables = await client.query("SELECT n.nspname AS schema,c.relname AS table,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls,pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('spark','spark_migrations') AND c.relkind='r' ORDER BY 1,2");
  console.log(JSON.stringify(tables.rows, null, 2));
} finally { await client.end(); }
