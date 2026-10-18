/** Typed client for the member workspace API (/api/v1). Requests go through the Next.js proxy, so the session cookie is first-party. */

import { ApiError, DEFAULT_FALLBACK_MESSAGES, NETWORK_ERROR_MESSAGE, SESSION_EXPIRED_EVENT, toApiError } from "../../_lib/http";

export { ApiError, SESSION_EXPIRED_EVENT };

export type WorkspaceRole = "owner" | "admin" | "member";

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  role: WorkspaceRole;
  memberCount: number;
  version: number;
  createdAt: string;
}

export const ROLE_LABELS: Record<WorkspaceRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };

export function roleLabel(role: string): string {
  return ROLE_LABELS[role as WorkspaceRole] ?? "Member";
}

export function canManage(role: string): boolean {
  return role === "owner" || role === "admin";
}

const WORKSPACE_FALLBACK_MESSAGES: Record<number, string> = {
  ...DEFAULT_FALLBACK_MESSAGES,
  403: "Your workspace role does not allow this action.",
  409: "This changed since you loaded it. Refresh and try again.",
};

export interface WorkspaceRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  ifMatch?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export async function workspaceApi<T>(path: string, { method = "GET", body, ifMatch, idempotencyKey, signal }: WorkspaceRequestOptions = {}): Promise<{ data: T; etag: string | null }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (ifMatch) headers["If-Match"] = ifMatch;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

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
  if (!response.ok) {
    const error = await toApiError(response, WORKSPACE_FALLBACK_MESSAGES);
    if (response.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    throw error;
  }
  const etag = response.headers.get("ETag");
  if (response.status === 204) return { data: undefined as T, etag };
  return { data: (await response.json()) as T, etag };
}

export function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : "Something went wrong. Try again.";
}

export interface WorkspaceMember {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  /** Only owners and admins receive email addresses. */
  email: string | null;
  role: WorkspaceRole;
  joinedAt: string;
}

export type InvitationRole = "admin" | "member";

export interface WorkspaceInvitation {
  id: string;
  email: string;
  role: InvitationRole;
  status: "pending" | "accepted" | "revoked" | "expired";
  invitedBy: { id: string; displayName: string };
  expiresAt: string;
  createdAt: string;
}

/** What an emailed invitation link shows before it is accepted. Non-pending invitations only carry `status`. */
export interface InvitationPreview {
  status: WorkspaceInvitation["status"];
  workspaceName: string | null;
  inviterName: string | null;
  role: InvitationRole | null;
  emailHint: string | null;
  expiresAt: string | null;
}

export interface AcceptedInvitation {
  workspace: { id: string; slug: string };
  role: WorkspaceRole;
  alreadyMember: boolean;
}
