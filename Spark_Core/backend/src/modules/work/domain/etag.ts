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
  return match?.[1] === undefined ? "invalid" : Number(match[1]);
}
