/**
 * Client for the community posts and comments API (/api/v1). Requests go through the Next.js proxy with the
 * session cookie; reads work signed out for public communities.
 */

import { ApiError, DEFAULT_FALLBACK_MESSAGES, NETWORK_ERROR_MESSAGE, toApiError } from "../../_lib/http";
import { PAUSED_MESSAGE } from "./api";

/** What the viewer may do with one post or comment, decided by the server. */
export interface ContentViewer {
  isAuthor: boolean;
  reported: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canReport: boolean;
  canModerate: boolean;
}

export interface ContentAuthor {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

interface PostBase {
  id: string;
  communityId: string;
  title: string;
  author: ContentAuthor;
  createdAt: string;
  editedAt: string | null;
  commentCount: number;
  /** "visible", or "hidden" for content moderators hid (only they can read it). */
  moderation: string;
  version: number;
  viewer: ContentViewer;
}

/** A feed item: the first 400 characters of the body. */
export interface PostSummary extends PostBase {
  excerpt: string;
  truncated: boolean;
}

export interface PostDetail extends PostBase {
  body: string;
  communitySlug: string;
}

export interface CommentItem {
  id: string;
  postId: string;
  body: string;
  author: ContentAuthor;
  createdAt: string;
  editedAt: string | null;
  moderation: string;
  version: number;
  viewer: ContentViewer;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export type ContentKind = "post" | "comment";
export type ReportReason = "spam" | "harassment" | "off_topic" | "misinformation" | "self_promotion" | "other";
export type ModerationAction = "hide" | "restore" | "dismiss";

export interface ModerationResult {
  /** "hidden" or "visible": the item's state after the action. */
  moderation: string;
  reportsClosed: number;
  changed: boolean;
  /** The target's version after the call: send it as the next If-Match. */
  version: number;
}

/** One reported post or comment in the manage page queue. The API never says who reported. */
export interface ReportQueueItem {
  target: {
    kind: ContentKind;
    id: string;
    postId: string;
    title: string;
    excerpt: string;
    authorName: string;
    moderation: string;
  };
  openReports: number;
  reasons: Array<{ reason: string; count: number }>;
  latestDetails: string[];
  firstReportedAt: string;
  lastReportedAt: string;
}

export const REPORT_DETAILS_MAX = 1_000;
export const MODERATION_REASON_MIN = 3;
export const MODERATION_REASON_MAX = 500;
export const POST_TITLE_MAX = 150;
export const POST_BODY_MAX = 10_000;
export const COMMENT_BODY_MAX = 2_000;
export const EXCERPT_LENGTH = 400;

const FALLBACK_MESSAGES: Record<number, string> = {
  ...DEFAULT_FALLBACK_MESSAGES,
  403: "Only active members of this community can do this.",
  404: "This is no longer available.",
  409: "This changed since you loaded it. Reload and try again.",
  503: "The request collided with another change. Try again.",
};

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  ifMatch?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

async function request<T>(path: string, { method = "GET", body, ifMatch, idempotencyKey, signal }: RequestOptions = {}): Promise<T> {
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
  if (!response.ok) throw await toApiError(response, FALLBACK_MESSAGES);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const id = encodeURIComponent;

function withCursor(path: string, cursor: string | null): string {
  return cursor ? `${path}?cursor=${id(cursor)}` : path;
}

export const contentApi = {
  feed(communityId: string, cursor: string | null, signal?: AbortSignal) {
    return request<Page<PostSummary>>(withCursor(`/communities/${id(communityId)}/posts`, cursor), { signal });
  },
  post(postId: string, signal?: AbortSignal) {
    return request<PostDetail>(`/posts/${id(postId)}`, { signal });
  },
  /** The key makes a retry of the same submission safe: the API answers it with the post it already made. */
  createPost(communityId: string, body: { title: string; body: string }, idempotencyKey: string) {
    return request<PostDetail>(`/communities/${id(communityId)}/posts`, { method: "POST", body, idempotencyKey });
  },
  /** A stale `version` answers 412; the error body's `current` is the newer post. */
  updatePost(postId: string, version: number, patch: { title?: string; body?: string }) {
    return request<PostDetail>(`/posts/${id(postId)}`, { method: "PATCH", body: patch, ifMatch: `"v${version}"` });
  },
  deletePost(postId: string) {
    return request<void>(`/posts/${id(postId)}`, { method: "DELETE" });
  },
  comments(postId: string, cursor: string | null, signal?: AbortSignal) {
    return request<Page<CommentItem>>(withCursor(`/posts/${id(postId)}/comments`, cursor), { signal });
  },
  createComment(postId: string, body: string, idempotencyKey: string) {
    return request<CommentItem>(`/posts/${id(postId)}/comments`, { method: "POST", body: { body }, idempotencyKey });
  },
  updateComment(commentId: string, version: number, body: string) {
    return request<CommentItem>(`/comments/${id(commentId)}`, { method: "PATCH", body: { body }, ifMatch: `"v${version}"` });
  },
  deleteComment(commentId: string) {
    return request<void>(`/comments/${id(commentId)}`, { method: "DELETE" });
  },
  /** 201 for a new report, 200 when this viewer already has an open one; both mean "reported". */
  report(kind: ContentKind, targetId: string, body: { reason: ReportReason; details?: string }) {
    return request<{ report: { id: string; status: string } }>(`/${kind}s/${id(targetId)}/reports`, { method: "POST", body });
  },
  moderate(kind: ContentKind, targetId: string, body: { action: ModerationAction; reason: string }) {
    return request<ModerationResult>(`/${kind}s/${id(targetId)}/moderation`, { method: "POST", body });
  },
  reports(communityId: string, signal?: AbortSignal) {
    return request<{ items: ReportQueueItem[] }>(`/communities/${id(communityId)}/reports`, { signal });
  },
};

/** What the viewer flags look like once this viewer has reported the item. */
export function asReported<T extends { viewer: ContentViewer }>(item: T): T {
  return { ...item, viewer: { ...item.viewer, reported: true, canReport: false } };
}

/** The newer representation a 412 carries, or null. */
export function currentOf<T>(error: unknown): T | null {
  if (!(error instanceof ApiError) || error.status !== 412) return null;
  const current = (error.body as { current?: unknown } | null)?.current;
  return current && typeof current === "object" ? (current as T) : null;
}

export const GONE_MESSAGE = FALLBACK_MESSAGES[404]!;

export const CHANGED_ELSEWHERE = "This was changed elsewhere — reloaded the latest version";

/** Copy for a failed content write; a frozen community uses the same words as everywhere else. */
export function contentErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.code === "community_frozen" ? PAUSED_MESSAGE : error.message;
  return "Something went wrong. Try again.";
}

/** A feed item built from a freshly created post (the create answer is the full post). */
export function summaryOf(post: PostDetail): PostSummary {
  const { body, communitySlug, ...rest } = post;
  void communitySlug;
  const characters = Array.from(body);
  const truncated = characters.length > EXCERPT_LENGTH;
  return { ...rest, excerpt: truncated ? characters.slice(0, EXCERPT_LENGTH).join("") : body, truncated };
}

/** Appends `next` to `items`, skipping entries already listed (pages can overlap after changes). */
export function appendUnique<T extends { id: string }>(items: T[], next: T[]): T[] {
  const seen = new Set(items.map((item) => item.id));
  const added = next.filter((item) => !seen.has(item.id) && seen.add(item.id));
  return added.length > 0 ? [...items, ...added] : items;
}

/**
 * One Idempotency-Key per submission. The same content keeps its key across failed attempts, so a retry of a
 * request that actually went through returns the existing item; changed content gets a fresh key (the API
 * refuses a key reused with another body).
 */
export class SubmissionKey {
  private current: { key: string; fingerprint: string } | null = null;

  forContent(fingerprint: string): string {
    if (!this.current || this.current.fingerprint !== fingerprint) {
      this.current = { key: `spark-${globalThis.crypto.randomUUID()}`, fingerprint };
    }
    return this.current.key;
  }

  /** Call after a success so the next submission starts clean. */
  done(): void {
    this.current = null;
  }
}
