/** Typed client for /api/v1/admin. Requests go through the Next.js proxy, so the session cookie is first-party. */

import { ApiError, DEFAULT_FALLBACK_MESSAGES, NETWORK_ERROR_MESSAGE, SESSION_EXPIRED_EVENT, toApiError } from "../../_lib/http";

export { ApiError, SESSION_EXPIRED_EVENT };

const ADMIN_FALLBACK_MESSAGES: Record<number, string> = { ...DEFAULT_FALLBACK_MESSAGES, 403: "Your platform role does not allow this action." };

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
    throw new ApiError(0, "network_error", NETWORK_ERROR_MESSAGE);
  }
  if (!response.ok) {
    const error = await toApiError(response, ADMIN_FALLBACK_MESSAGES);
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
