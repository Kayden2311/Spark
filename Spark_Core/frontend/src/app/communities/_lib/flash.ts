/**
 * A one-shot message that survives a client-side navigation (for example "Post deleted" shown on the community
 * page after the post page was left). It lives in module state, so a full page load starts without it.
 */
let pending: string | null = null;

export function setFlash(text: string): void {
  pending = text;
}

export function peekFlash(): string | null {
  return pending;
}

export function clearFlash(): void {
  pending = null;
}
