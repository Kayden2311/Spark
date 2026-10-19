/**
 * Remembers the last workspace a person opened, so /workspace can take them back to it. Storage can be
 * blocked (private windows, strict settings); every access is guarded and the app works without it.
 */

export const LAST_WORKSPACE_KEY = "spark:last-workspace";
const CHANGE_EVENT = "spark:last-workspace-change";

export function readLastWorkspace(): string | null {
  try {
    return window.localStorage.getItem(LAST_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

export function rememberWorkspace(slug: string): void {
  try {
    if (window.localStorage.getItem(LAST_WORKSPACE_KEY) === slug) return;
    window.localStorage.setItem(LAST_WORKSPACE_KEY, slug);
  } catch {
    return;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Forgets `slug` if it is the remembered one (for example after access to it was removed). */
export function forgetWorkspace(slug: string): void {
  try {
    if (window.localStorage.getItem(LAST_WORKSPACE_KEY) !== slug) return;
    window.localStorage.removeItem(LAST_WORKSPACE_KEY);
  } catch {
    return;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeLastWorkspace(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Picks the remembered slug when it is still one of `slugs`, otherwise the first; null when there are none. */
export function pickWorkspace(slugs: readonly string[], remembered: string | null): string | null {
  if (remembered && slugs.includes(remembered)) return remembered;
  return slugs[0] ?? null;
}
