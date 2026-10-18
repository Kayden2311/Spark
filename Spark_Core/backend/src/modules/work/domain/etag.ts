const MAX_VERSION = 2_147_483_647;

/** Entity tags are strong, quoted resource versions such as `"v3"`. */
export function formatEtag(version: number): string {
  return `"v${version}"`;
}

/**
 * Reads an If-Match header. A missing header is null; weak tags, wildcards and anything
 * that is not exactly one `"v{n}"` tag are "invalid".
 */
export function parseIfMatch(header: string | undefined): number | null | "invalid" {
  if (header === undefined) return null;
  const match = /^"v(\d{1,15})"$/u.exec(header.trim());
  if (match?.[1] === undefined) return "invalid";
  const version = Number(match[1]);
  // Versions live in a 32-bit integer column; a larger value could never match and would crash the query.
  return version > MAX_VERSION ? "invalid" : version;
}
