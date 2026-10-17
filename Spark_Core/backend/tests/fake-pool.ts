import type { Pool } from "pg";

export type QueryHandler = (sql: string, params: unknown[]) => unknown[] | Error;

/** Answers queries by matching SQL fragments and records every call for assertions. */
export function fakePool(handlers: Array<[string, QueryHandler]> = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    for (const [fragment, handler] of handlers) {
      if (sql.includes(fragment)) {
        const result = handler(sql, params);
        if (result instanceof Error) throw result;
        return { rows: result, rowCount: result.length };
      }
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => {} }), on: () => {}, end: async () => {} };
  return { pool: pool as unknown as Pool, calls };
}

export function dbError(code: string, constraint?: string): Error {
  return Object.assign(new Error("database error"), { code, constraint });
}

export const principalRow = {
  user_id: "7b1c7c62-2f62-4f8e-9a3c-5d3f1f0a9e11",
  display_name: "Admin",
  avatar_url: null,
  email: "admin@example.com",
  platform_roles: ["super_admin"],
  workspaces: [],
};
