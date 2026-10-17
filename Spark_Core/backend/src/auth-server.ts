import { Redis } from "ioredis";
import { Pool } from "pg";

import { buildAuthApp } from "./app.js";
import { loadAuthConfig } from "./config.js";
import { assertLoginRole } from "./infrastructure/database/roles.js";

// Private auth process. It alone holds the login-only database role (spark_auth) and serves
// sign-up and sign-in for the API process. Bind it to a private interface only.
const config = loadAuthConfig();
const postgres = new Pool({
  connectionString: config.authDatabaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
  max: 5,
});
const redis = new Redis(config.redisUrl, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});
const app = await buildAuthApp({ config, redis, pool: postgres });

postgres.on("error", (error) => app.log.error({ err: error }, "PostgreSQL auth pool error"));
redis.on("error", (error) => app.log.error({ err: error }, "Redis error"));

let stopping = false;
async function stop(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, "Stopping auth server");
  await app.close();
  await Promise.allSettled([postgres.end(), redis.quit()]);
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

try {
  await assertLoginRole(postgres);
  await redis.connect();
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, "Auth server startup failed");
  await Promise.allSettled([app.close(), postgres.end()]);
  redis.disconnect();
  process.exitCode = 1;
}
