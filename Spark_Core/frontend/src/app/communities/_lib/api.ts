/**
 * Client for the community discovery and membership API (/api/v1). Requests go through the Next.js proxy
 * with the session cookie (`credentials: "include"`); discovery works signed out too.
 */

import { ApiError, DEFAULT_FALLBACK_MESSAGES, NETWORK_ERROR_MESSAGE, toApiError } from "../../_lib/http";
import { filtersToSearch, type CommunityFilters } from "../filter";
import { formatDate } from "../format";
import type { CommunityCard, CommunityDetail, CommunityFilterOptions, CommunityPage, JoinRequest, JoinResult, MyCommunityRequest } from "../types";

export { ApiError };

const COMMUNITY_FALLBACK_MESSAGES: Record<number, string> = {
  ...DEFAULT_FALLBACK_MESSAGES,
  404: "This community is not available.",
  409: "This community changed since you loaded it. Refresh and try again.",
};

interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(path: string, { method = "GET", body, signal }: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      credentials: "include",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, "network_error", NETWORK_ERROR_MESSAGE);
  }
  if (!response.ok) throw await toApiError(response, COMMUNITY_FALLBACK_MESSAGES);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const PAUSED_MESSAGE = "This community is paused by Spark moderators.";

const id = encodeURIComponent;

export const communitiesApi = {
  list(filters: CommunityFilters, cursor: string | null, signal?: AbortSignal) {
    const search = new URLSearchParams(filtersToSearch(filters));
    if (cursor) search.set("cursor", cursor);
    const text = search.toString();
    return request<CommunityPage>(`/communities${text ? `?${text}` : ""}`, { signal });
  },
  filterOptions(signal?: AbortSignal) {
    return request<CommunityFilterOptions>("/communities/filters", { signal });
  },
  mine(signal?: AbortSignal) {
    return request<{ items: CommunityCard[] }>("/me/communities", { signal });
  },
  detail(slug: string, signal?: AbortSignal) {
    return request<CommunityDetail>(`/communities/${id(slug)}`, { signal });
  },
  join(communityId: string) {
    return request<JoinResult>(`/communities/${id(communityId)}/join`, { method: "POST" });
  },
  requestAccess(communityId: string, message: string) {
    return request<{ request: JoinRequest }>(`/communities/${id(communityId)}/requests`, { method: "POST", body: { message } });
  },
  myRequests(signal?: AbortSignal) {
    return request<{ items: MyCommunityRequest[] }>("/me/community-requests", { signal });
  },
  withdraw(requestId: string) {
    return request<void>(`/community-requests/${id(requestId)}`, { method: "DELETE" });
  },
  leave(communityId: string, userId: string) {
    return request<void>(`/communities/${id(communityId)}/members/${id(userId)}`, { method: "DELETE" });
  },
};

export function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : "Something went wrong. Try again.";
}

/** True when a write failed because there is no live session; the caller sends the user to sign in. */
export function isSignedOut(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function loginPath(returnTo: string): string {
  return `/login?redirect=${encodeURIComponent(returnTo)}`;
}

/** Copy for a failed join or request, with the cooldown date when the API sent one. */
export function membershipErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "request_cooldown") {
      const retryAfter = (error.body as { retryAfter?: unknown } | null)?.retryAfter;
      const date = typeof retryAfter === "string" ? formatDate(retryAfter) : null;
      return date ? `You can request again on ${date}` : "Your last request was declined recently. You can request again later.";
    }
    if (error.code === "community_frozen") return PAUSED_MESSAGE;
    if (error.code === "membership_suspended") return "Your membership in this community is suspended.";
  }
  return messageOf(error);
}
