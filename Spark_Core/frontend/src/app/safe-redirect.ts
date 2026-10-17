/**
 * Returns `value` only when it is a path on this site, so `?redirect=` cannot send someone who just
 * signed in to another domain (an open redirect). Anything else returns null and callers fall back
 * to their default destination.
 */
export function safeRedirect(value: string | null): string | null {
  if (!value || !isLocalPath(value)) return null;
  try {
    const base = "https://spark.invalid";
    const url = new URL(value, base);
    const path = `${url.pathname}${url.search}${url.hash}`;
    // Check again after parsing: dot segments such as "/.//evil.com" normalize to "//evil.com",
    // which a browser treats as another host.
    return url.origin === base && isLocalPath(path) ? path : null;
  } catch {
    return null;
  }
}

function isLocalPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\");
}
