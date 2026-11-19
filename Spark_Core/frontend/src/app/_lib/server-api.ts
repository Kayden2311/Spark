import { headers } from "next/headers";

/** Where the API listens from the server's point of view (the browser reaches it through the /api proxy). */
const apiOrigin = () => process.env.SPARK_API_ORIGIN ?? "http://127.0.0.1:4000";

export interface ServerResult {
  /** The HTTP status, or 0 when the API could not be reached in time. */
  status: number;
  /** The parsed JSON body, or null when there was none. */
  body: unknown;
}

/**
 * GET against the API on behalf of the visitor, forwarding their cookie so the answer matches what the
 * browser would get, and their address (x-forwarded-for, plus x-real-ip when the proxy set it and it is not
 * listed yet) so the API's per-client limiter counts the visitor and not this Next server. The API only
 * trusts that header from its TRUSTED_PROXIES: the Next host must be listed there, as it is for the /api
 * rewrite. Never throws: pages use the status to decide on notFound() and fall back to the client
 * view, which shows its own error state, for anything that is not a plain 404.
 */
export async function serverGet(path: string): Promise<ServerResult> {
  const requestHeaders: Record<string, string> = { Accept: "application/json" };
  const incoming = await headers();
  const cookie = incoming.get("cookie");
  if (cookie) requestHeaders.cookie = cookie;
  const forwarded = incoming.get("x-forwarded-for");
  const client = incoming.get("x-real-ip");
  const chain = [forwarded, client && !forwarded?.split(",").some((hop) => hop.trim() === client) ? client : null].filter(Boolean).join(", ");
  if (chain) requestHeaders["x-forwarded-for"] = chain;
  try {
    const response = await fetch(`${apiOrigin()}${path}`, { headers: requestHeaders, cache: "no-store", signal: AbortSignal.timeout(5000) });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch {
    return { status: 0, body: null };
  }
}
