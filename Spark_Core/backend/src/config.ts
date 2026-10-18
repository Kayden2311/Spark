import { isIP } from "node:net";

export interface AppConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly corsOrigins: readonly string[];
  readonly trustedProxies: readonly string[];
  readonly databaseUrl: string;
  /** Base URL of the auth process that alone holds the login database credentials. */
  readonly authServiceUrl: string;
  readonly databaseSsl: boolean;
  readonly redisUrl: string;
  readonly rateLimitMax: number;
  readonly rateLimitWindowMs: number;
}

/** Configuration of the auth process: only the login-only database role, never the runtime role. */
export interface AuthConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly trustedProxies: readonly string[];
  readonly authDatabaseUrl: string;
  readonly databaseSsl: boolean;
  readonly redisUrl: string;
  readonly rateLimitMax: number;
  readonly rateLimitWindowMs: number;
}

/** Configuration of the background worker: only the worker database role and outbound email settings. */
export interface WorkerConfig {
  readonly logLevel: string;
  readonly workerDatabaseUrl: string;
  readonly databaseSsl: boolean;
  readonly smtpUrl: string;
  /** True in production: plain smtp:// must upgrade with STARTTLS (nodemailer requireTLS); smtps:// is TLS already. */
  readonly smtpRequireTls: boolean;
  readonly emailFrom: string;
  /** Origin (plus optional path) of the web app that email links point to, without a trailing slash. */
  readonly appBaseUrl: string;
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

function databaseRole(connectionString: string): string {
  try {
    return decodeURIComponent(new URL(connectionString).username);
  } catch {
    throw new Error("Database URLs must be valid postgresql:// URLs");
  }
}

function serviceUrl(raw: string, production: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("AUTH_SERVICE_URL must be a valid URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.username) {
    throw new Error("AUTH_SERVICE_URL must be an http(s) origin without path, query or credentials");
  }
  // Passwords and session tokens cross this hop, so off-host traffic must be encrypted.
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (production && url.protocol !== "https:" && !loopback) {
    throw new Error("AUTH_SERVICE_URL must use HTTPS in production unless it is a loopback address");
  }
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const production = env.NODE_ENV === "production";
  const databaseUrl = required(
    env,
    "DATABASE_URL",
    production ? "" : "postgresql://spark_app:spark_app_local_only@127.0.0.1:5432/spark",
  );
  // The API must never hold the login credentials; locally both processes share one .env file.
  if (production && env.AUTH_DATABASE_URL) {
    throw new Error("AUTH_DATABASE_URL must not be set for the API process in production");
  }
  if (production && env.MIGRATION_DATABASE_URL) {
    throw new Error("MIGRATION_DATABASE_URL must not be set for the API process in production");
  }
  if (production && env.WORKER_DATABASE_URL) {
    throw new Error("WORKER_DATABASE_URL must not be set for the API process in production");
  }
  const authServiceUrl = serviceUrl(required(env, "AUTH_SERVICE_URL", production ? "" : "http://127.0.0.1:4100"), production);
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
    authServiceUrl,
    databaseSsl,
    redisUrl,
    rateLimitMax: integer(env.RATE_LIMIT_MAX, 120, "RATE_LIMIT_MAX"),
    rateLimitWindowMs: integer(env.RATE_LIMIT_WINDOW_MS, 60_000, "RATE_LIMIT_WINDOW_MS"),
  };
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const production = env.NODE_ENV === "production";
  const authDatabaseUrl = required(
    env,
    "AUTH_DATABASE_URL",
    production ? "" : "postgresql://spark_auth:spark_auth_local_only@127.0.0.1:5432/spark",
  );
  // The auth process must never hold the runtime credentials either.
  if (production && env.DATABASE_URL) {
    throw new Error("DATABASE_URL must not be set for the auth process in production");
  }
  if (production && env.MIGRATION_DATABASE_URL) {
    throw new Error("MIGRATION_DATABASE_URL must not be set for the auth process in production");
  }
  if (production && env.WORKER_DATABASE_URL) {
    throw new Error("WORKER_DATABASE_URL must not be set for the auth process in production");
  }
  if (env.DATABASE_URL && databaseRole(env.DATABASE_URL) === databaseRole(authDatabaseUrl)) {
    throw new Error("AUTH_DATABASE_URL must use a different database role than DATABASE_URL");
  }
  const redisUrl = required(env, "REDIS_URL", production ? "" : "redis://127.0.0.1:6379");
  const databaseSsl = env.DATABASE_SSL === "true";
  // Only the API may forward client addresses; locally it runs on the loopback interface.
  const trustedProxies = parseProxies(env.AUTH_TRUSTED_PROXIES ?? (production ? "" : "127.0.0.1,::1"));

  if (production && !databaseSsl) throw new Error("DATABASE_SSL must be true in production");
  if (production && !redisUrl.startsWith("rediss://")) {
    throw new Error("REDIS_URL must use rediss:// in production");
  }
  if (production && trustedProxies.length === 0) {
    throw new Error("AUTH_TRUSTED_PROXIES is required in production");
  }

  return {
    host: env.AUTH_HOST ?? "127.0.0.1",
    port: integer(env.AUTH_PORT, 4100, "AUTH_PORT"),
    logLevel: env.LOG_LEVEL ?? "info",
    trustedProxies,
    authDatabaseUrl,
    databaseSsl,
    redisUrl,
    rateLimitMax: integer(env.RATE_LIMIT_MAX, 120, "RATE_LIMIT_MAX"),
    rateLimitWindowMs: integer(env.RATE_LIMIT_WINDOW_MS, 60_000, "RATE_LIMIT_WINDOW_MS"),
  };
}

function appBaseUrl(raw: string, production: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("APP_BASE_URL must be a valid URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash || url.username || url.password) {
    throw new Error("APP_BASE_URL must be an http(s) URL without query, fragment or credentials");
  }
  if (production && url.protocol !== "https:") throw new Error("APP_BASE_URL must use HTTPS in production");
  return `${url.origin}${url.pathname}`.replace(/\/+$/u, "");
}

function smtpUrl(raw: string, production: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("SMTP_URL must be a valid smtp:// or smtps:// URL");
  }
  if (!["smtp:", "smtps:"].includes(url.protocol)) throw new Error("SMTP_URL must be a valid smtp:// or smtps:// URL");
  // nodemailer reads options from the query string and lets them override explicit options, which could
  // switch off TLS or certificate checks; production URLs carry no options.
  if (production && url.search) throw new Error("SMTP_URL must not carry query options in production");
  return raw;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const production = env.NODE_ENV === "production";
  const workerDatabaseUrl = required(
    env,
    "WORKER_DATABASE_URL",
    production ? "" : "postgresql://spark_worker:spark_worker_local_only@127.0.0.1:5432/spark",
  );
  // The worker must never hold the runtime, login or migration credentials.
  for (const name of ["DATABASE_URL", "AUTH_DATABASE_URL", "MIGRATION_DATABASE_URL"]) {
    if (production && env[name]) throw new Error(`${name} must not be set for the worker process in production`);
    const other = env[name];
    if (other && databaseRole(other) === databaseRole(workerDatabaseUrl)) {
      throw new Error(`WORKER_DATABASE_URL must use a different database role than ${name}`);
    }
  }
  const databaseSsl = env.DATABASE_SSL === "true";
  if (production && !databaseSsl) throw new Error("DATABASE_SSL must be true in production");

  return {
    logLevel: env.LOG_LEVEL ?? "info",
    workerDatabaseUrl,
    databaseSsl,
    smtpUrl: smtpUrl(required(env, "SMTP_URL", production ? "" : "smtp://127.0.0.1:1025"), production),
    smtpRequireTls: production,
    emailFrom: required(env, "EMAIL_FROM", production ? "" : "Spark <no-reply@spark.local>"),
    appBaseUrl: appBaseUrl(required(env, "APP_BASE_URL", production ? "" : "http://localhost:3000"), production),
  };
}
