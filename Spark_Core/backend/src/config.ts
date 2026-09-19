import { isIP } from "node:net";

export interface AppConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly corsOrigins: readonly string[];
  readonly trustedProxies: readonly string[];
  readonly databaseUrl: string;
  readonly databaseSsl: boolean;
  readonly redisUrl: string;
  readonly rateLimitMax: number;
  readonly rateLimitWindowMs: number;
}

function integer(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function required(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name] ?? fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseOrigins(raw: string, production: boolean): string[] {
  return raw.split(",").map((value) => {
    const origin = value.trim().replace(/\/$/, "");
    const url = new URL(origin);
    if (production && url.protocol !== "https:") {
      throw new Error("CORS_ORIGINS must use HTTPS in production");
    }
    if (!production && !["http:", "https:"].includes(url.protocol)) {
      throw new Error("CORS_ORIGINS must use HTTP or HTTPS");
    }
    if (url.origin !== origin) {
      throw new Error("CORS_ORIGINS entries must be origins without paths");
    }
    return url.origin;
  });
}

function parseProxies(raw: string): string[] {
  if (!raw) return [];
  return raw.split(",").map((value) => {
    const proxy = value.trim();
    const parts = proxy.split("/");
    const address = parts[0] ?? "";
    const prefix = parts[1];
    const family = isIP(address);
    const maximum = family === 4 ? 32 : 128;
    if (
      parts.length > 2 ||
      !family ||
      (prefix !== undefined &&
        (!/^\d+$/u.test(prefix) || +prefix < 1 || +prefix > maximum))
    ) {
      throw new Error(`Invalid trusted proxy: ${proxy}`);
    }
    return proxy;
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const production = env.NODE_ENV === "production";
  const databaseUrl = required(
    env,
    "DATABASE_URL",
    production ? "" : "postgresql://spark_app:spark_app_local_only@127.0.0.1:5432/spark",
  );
  const redisUrl = required(
    env,
    "REDIS_URL",
    production ? "" : "redis://127.0.0.1:6379",
  );
  const databaseSsl = env.DATABASE_SSL === "true";
  const trustedProxies = parseProxies(env.TRUSTED_PROXIES ?? "");

  if (production && !databaseSsl) throw new Error("DATABASE_SSL must be true in production");
  if (production && !redisUrl.startsWith("rediss://")) {
    throw new Error("REDIS_URL must use rediss:// in production");
  }
  if (production && trustedProxies.length === 0) {
    throw new Error("TRUSTED_PROXIES is required in production");
  }

  return {
    host: env.HOST ?? (production ? "0.0.0.0" : "127.0.0.1"),
    port: integer(env.PORT, 4000, "PORT"),
    logLevel: env.LOG_LEVEL ?? "info",
    corsOrigins: parseOrigins(
      required(
        env,
        "CORS_ORIGINS",
        production ? "" : "http://127.0.0.1:3000,http://localhost:3000",
      ),
      production,
    ),
    trustedProxies,
    databaseUrl,
    databaseSsl,
    redisUrl,
    rateLimitMax: integer(env.RATE_LIMIT_MAX, 120, "RATE_LIMIT_MAX"),
    rateLimitWindowMs: integer(env.RATE_LIMIT_WINDOW_MS, 60_000, "RATE_LIMIT_WINDOW_MS"),
  };
}
