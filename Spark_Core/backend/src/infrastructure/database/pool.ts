import type { PoolConfig } from "pg";

// Session time zone for every Spark connection. A local or managed server may default to another zone
// (for example Asia/Bangkok); date casts, intervals and now()-relative windows such as the 14-day
// request cooldown must not depend on it. A startup option applies before the first query of each connection.
const UTC_SESSION = "-c TimeZone=UTC";

/** Pool settings with the session time zone pinned to UTC; other settings and startup options are kept. */
export function poolConfig(config: PoolConfig): PoolConfig {
  return { ...config, options: config.options ? `${UTC_SESSION} ${config.options}` : UTC_SESSION };
}
