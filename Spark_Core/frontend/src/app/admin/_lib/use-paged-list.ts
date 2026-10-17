"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { adminApi, messageOf } from "./api";
import type { Page } from "./types";

interface PagedState<T> {
  items: T[];
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

/**
 * Loads a cursor-paged admin collection. `path` is the collection URL including filters but not the
 * cursor; changing it starts over from the first page. Stale responses from earlier filters are ignored.
 */
export function usePagedList<T extends { id: string }>(path: string | null) {
  const [state, setState] = useState<PagedState<T>>({ items: [], nextCursor: null, loading: path !== null, loadingMore: false, error: null });
  const generation = useRef(0);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const current = ++generation.current;
    if (path === null) {
      // Turned off (no access, or invalid filters): drop rows from the previous query.
      setState({ items: [], nextCursor: null, loading: false, loadingMore: false, error: null });
      return;
    }
    const controller = new AbortController();
    setState((previous) => ({ ...previous, loading: true, error: null }));
    adminApi<Page<T>>(path, { signal: controller.signal })
      .then((page) => {
        if (current === generation.current) setState({ items: page.items, nextCursor: page.nextCursor, loading: false, loadingMore: false, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || current !== generation.current) return;
        setState({ items: [], nextCursor: null, loading: false, loadingMore: false, error: messageOf(error) });
      });
    return () => controller.abort();
  }, [path, reloadKey]);

  const loadMore = useCallback(async () => {
    if (path === null || !state.nextCursor || state.loadingMore) return;
    const current = generation.current;
    setState((previous) => ({ ...previous, loadingMore: true, error: null }));
    try {
      const separator = path.includes("?") ? "&" : "?";
      const page = await adminApi<Page<T>>(`${path}${separator}cursor=${encodeURIComponent(state.nextCursor)}`);
      if (current !== generation.current) return;
      setState((previous) => {
        const seen = new Set(previous.items.map((item) => item.id));
        return { ...previous, items: [...previous.items, ...page.items.filter((item) => !seen.has(item.id))], nextCursor: page.nextCursor, loadingMore: false };
      });
    } catch (error) {
      if (current === generation.current) setState((previous) => ({ ...previous, loadingMore: false, error: messageOf(error) }));
    }
  }, [path, state.nextCursor, state.loadingMore]);

  const update = useCallback((id: string, change: (item: T) => T | null) => {
    setState((previous) => ({
      ...previous,
      items: previous.items.flatMap((item) => {
        if (item.id !== id) return [item];
        const next = change(item);
        return next ? [next] : [];
      }),
    }));
  }, []);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  return { ...state, hasMore: state.nextCursor !== null, loadMore, update, reload };
}
