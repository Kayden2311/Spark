import { Redis } from "ioredis";
import { Pool } from "pg";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { assertRuntimeRole } from "./infrastructure/database/roles.js";

// Public API process. It holds only the runtime database role; sign-up and sign-in are
// forwarded to the auth process (src/auth-server.ts), which alone holds the login role.
const config = loadConfig();
const postgres = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
  // Fail fast when PostgreSQL is unreachable, so requests (and the health check) report it instead of hanging.
  connectionTimeoutMillis: 5000,
});
const redis = new Redis(config.redisUrl, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});
const app = await buildApp({ config, redis, pool: postgres });

postgres.on("error", (error) => app.log.error({ err: error }, "PostgreSQL error"));
redis.on("error", (error) => app.log.error({ err: error }, "Redis error"));

let stopping = false;
async function stop(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, "Stopping server");
  await app.close();
  await Promise.allSettled([postgres.end(), redis.quit()]);
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

try {
  await assertRuntimeRole(postgres);
  await redis.connect();
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, "Server startup failed");
  await Promise.allSettled([app.close(), postgres.end()]);
  redis.disconnect();
  process.exitCode = 1;
}
