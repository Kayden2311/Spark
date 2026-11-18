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
 * browser would get. Never throws: pages use the status to decide on notFound() and fall back to the client
 * view, which shows its own error state, for anything that is not a plain 404.
 */
export async function serverGet(path: string): Promise<ServerResult> {
  const requestHeaders: Record<string, string> = { Accept: "application/json" };
  const cookie = (await headers()).get("cookie");
  if (cookie) requestHeaders.cookie = cookie;
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
