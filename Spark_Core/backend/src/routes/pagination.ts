/**
 * Opaque keyset cursors for newest-first collections ordered by (created_at DESC, id DESC).
 *
 * The timestamp is PostgreSQL's own text form of `created_at` (microsecond precision). A JavaScript
 * Date would drop microseconds and make the next page skip rows created within the same millisecond.
 */
export interface Cursor {
  /** `created_at::text` of the last row on the previous page. */
  readonly createdAt: string;
  readonly id: string;
}

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

const POSTGRES_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2}){0,2}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// The pattern accepts impossible values such as month 19; PostgreSQL would reject them with a 500.
function plausibleTimestamp(text: string): boolean {
  const [month, day, hour, minute, second] = [text.slice(5, 7), text.slice(8, 10), text.slice(11, 13), text.slice(14, 16), text.slice(17, 19)].map(Number);
  return month! >= 1 && month! <= 12 && day! >= 1 && day! <= 31 && hour! <= 23 && minute! <= 59 && second! <= 59;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.createdAt, id: cursor.id }), "utf8").toString("base64url");
}

/** Returns null for a missing cursor and "invalid" for anything that is not a cursor this API issued. */
export function decodeCursor(value: string | undefined): Cursor | null | "invalid" {
  if (value === undefined || value === "") return null;
  if (value.length > 200 || !/^[A-Za-z0-9_-]+$/u.test(value)) return "invalid";
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return "invalid";
    const { t, id } = parsed as Record<string, unknown>;
    if (typeof t !== "string" || typeof id !== "string" || !POSTGRES_TIMESTAMP.test(t) || !UUID.test(id) || !plausibleTimestamp(t)) return "invalid";
    return { createdAt: t, id };
  } catch {
    return "invalid";
  }
}

export function pageSize(value: number | undefined): number {
  return value === undefined ? DEFAULT_PAGE_SIZE : Math.min(Math.max(Math.trunc(value), 1), MAX_PAGE_SIZE);
}

/** Drops the internal cursor field before a row is serialized. */
export function withoutCursor<T extends { cursorTs: string }>(row: T): Omit<T, "cursorTs"> {
  const { cursorTs, ...rest } = row;
  void cursorTs;
  return rest;
}

/**
 * Callers fetch `limit + 1` rows; the extra row only signals that another page exists.
 * Each row must carry `cursorTs` (`created_at::text`) and `id`.
 */
export function toPage<T extends { cursorTs: string; id: string }>(rows: T[], limit: number): { items: Omit<T, "cursorTs">[]; nextCursor: string | null } {
  const visible = rows.slice(0, limit);
  const last = visible[visible.length - 1];
  return {
    items: visible.map(withoutCursor),
    nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.cursorTs, id: last.id }) : null,
  };
}
