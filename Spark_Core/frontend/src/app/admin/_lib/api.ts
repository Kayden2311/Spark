/** Typed client for /api/v1/admin. Requests go through the Next.js proxy, so the session cookie is first-party. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const SESSION_EXPIRED_EVENT = "spark:session-expired";

const FALLBACK_MESSAGES: Record<number, string> = {
  400: "Some of the details were not accepted. Check them and try again.",
  401: "Your session has ended. Sign in again to continue.",
  403: "Your platform role does not allow this action.",
  404: "This item no longer exists.",
  409: "This item changed since you loaded it. Refresh and try again.",
  429: "Too many actions in a short time. Wait a minute and try again.",
};

async function toError(response: Response): Promise<ApiError> {
  let code = "request_failed";
  let detail = "";
  try {
    const body = (await response.json()) as { code?: unknown; detail?: unknown };
    if (typeof body.code === "string") code = body.code;
    if (typeof body.detail === "string") detail = body.detail;
  } catch {
    // Non-JSON error body: fall back to a status-based message.
  }
  // Server-side detail is written for people, except generic 5xx text, which we replace.
  const message = response.status >= 500 || !detail ? FALLBACK_MESSAGES[response.status] ?? "Something went wrong on our side. Try again in a moment." : detail;
  return new ApiError(response.status, code, message);
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

export async function adminApi<T>(path: string, { method = "GET", body, signal }: RequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/admin${path}`, {
      method,
      credentials: "include",
      headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, "network_error", "Spark could not be reached. Check your connection and try again.");
  }
  if (!response.ok) {
    const error = await toError(response);
    if (response.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : "Something went wrong. Try again.";
}

/**
 * After an action fails because the item changed or disappeared (404/409), the row on screen is stale.
 * Reload the list so it shows the current state, then let the dialog show the error.
 */
export function reloadIfStale(error: unknown, reload: () => void): never {
  if (error instanceof ApiError && (error.status === 404 || error.status === 409)) reload();
  throw error;
}
