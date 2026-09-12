import { Redis } from "ioredis";
import { Pool } from "pg";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const postgres = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
});
const redis = new Redis(config.redisUrl, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});
const app = await buildApp({ config, redis });

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
  await postgres.query("select 1");
  await redis.connect();
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, "Server startup failed");
  await Promise.allSettled([app.close(), postgres.end()]);
  redis.disconnect();
  process.exitCode = 1;
}
