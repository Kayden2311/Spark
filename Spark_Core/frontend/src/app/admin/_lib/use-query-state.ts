"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

/**
 * A filter value kept in the URL query, so filtered views can be linked and survive a reload.
 * Unknown values fall back to `fallback`. Pages using it must render inside <Suspense>.
 */
export function useQueryState<T extends string>(key: string, fallback: T, allowed?: readonly T[]): [T, (value: T) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = params.get(key);
  const value = raw !== null && (!allowed || (allowed as readonly string[]).includes(raw)) ? (raw as T) : fallback;

  const setValue = useCallback(
    (next: T) => {
      const search = new URLSearchParams(params.toString());
      if (next === fallback || next === "") search.delete(key);
      else search.set(key, next);
      const text = search.toString();
      router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false });
    },
    [fallback, key, params, pathname, router],
  );

  return [value, setValue];
}

/**
 * Updates several query keys in one navigation. Calling several single-key setters in a row would
 * not work: each builds its URL from the same render-time snapshot, so only the last one would stick.
 */
export function useQueryUpdater(): (updates: Record<string, string | null>) => void {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  return useCallback(
    (updates) => {
      const search = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") search.delete(key);
        else search.set(key, value);
      }
      const text = search.toString();
      router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );
}

/** Returns `value` after it has stopped changing for `delay` ms (for search boxes). */
export function useDebounced<T>(value: T, delay = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
