"use client";

import { useCallback, useEffect, useState } from "react";

interface Settled<T> {
  key: string;
  items: T[] | null;
  error: unknown;
}

/**
 * Loads one list for the manage page. `load` must be stable (useCallback); `reload` refetches while the last
 * items stay on screen, and `setItems` applies a local change after a successful write.
 */
export function useList<T>(load: ((signal: AbortSignal) => Promise<{ items: T[] }>) | null) {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled<T>>({ key: "", items: null, error: null });
  const [loader, setLoader] = useState(() => load);
  // A new loader (another community) starts over instead of showing the previous community's rows.
  if (loader !== load) {
    setLoader(() => load);
    setSettled({ key: "", items: null, error: null });
  }
  const key = String(attempt);

  useEffect(() => {
    if (!load) return;
    const controller = new AbortController();
    load(controller.signal).then(
      (page) => setSettled({ key, items: page.items, error: null }),
      (error: unknown) => {
        if (!controller.signal.aborted) setSettled((previous) => ({ key, items: previous.items, error }));
      },
    );
    return () => controller.abort();
  }, [key, load]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const setItems = useCallback(
    (change: (items: T[]) => T[]) => setSettled((previous) => (previous.items ? { ...previous, items: change(previous.items) } : previous)),
    [],
  );
  const current = settled.key === key;
  return { items: settled.items, error: current ? settled.error : null, loading: !current, reload, setItems };
}
