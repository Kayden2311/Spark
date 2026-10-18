/** HTTP error handling shared by the admin console and the member workspace clients. */

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

export const NETWORK_ERROR_MESSAGE = "Spark could not be reached. Check your connection and try again.";

export const DEFAULT_FALLBACK_MESSAGES: Record<number, string> = {
  400: "Some of the details were not accepted. Check them and try again.",
  401: "Your session has ended. Sign in again to continue.",
  403: "You do not have access to this action.",
  404: "This item no longer exists.",
  409: "This item changed since you loaded it. Refresh and try again.",
  429: "Too many actions in a short time. Wait a minute and try again.",
};

export async function toApiError(response: Response, fallbacks: Record<number, string> = DEFAULT_FALLBACK_MESSAGES): Promise<ApiError> {
  let code = "request_failed";
  let detail = "";
  try {
    const body = (await response.json()) as { code?: unknown; detail?: unknown };
    if (typeof body.code === "string") code = body.code;
    if (typeof body.detail === "string") detail = body.detail;
  } catch {
    // Non-JSON error body: fall back to a status-based message.
  }
  // Server-side detail is written for people, except generic 5xx text, which we replace. The API's own
  // "database unavailable" explanation is kept, because it says exactly what is wrong.
  const message = (response.status >= 500 && code !== "database_unavailable") || !detail ? fallbacks[response.status] ?? "Something went wrong on our side. Try again in a moment." : detail;
  return new ApiError(response.status, code, message);
}
