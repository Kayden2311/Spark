"use client";

import { useSyncExternalStore } from "react";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}

/**
 * True when the viewer asked for reduced motion. Components drop their entrance and hover effect
 * classes (admDrawIn, admGrowIn, admFadeIn, admLift) when it is set; the CSS also scopes every effect to
 * `prefers-reduced-motion: no-preference`, so the server render (which cannot know) stays still too.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, () => window.matchMedia?.(REDUCED_MOTION).matches ?? false, () => false);
}

/** The class name when motion is allowed, otherwise nothing. */
export function motionClass(reduced: boolean, name: string): string {
  return reduced ? "" : ` ${name}`;
}
