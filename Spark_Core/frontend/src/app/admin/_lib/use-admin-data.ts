"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiError, adminApi, messageOf } from "./api";

interface Settled<T> {
  /** The request (reload count and path) this result belongs to. */
  key: string;
  data: T | null;
  error: string | null;
  /** HTTP status of the last failure (0 for network errors), so pages can tell "not found" apart. */
  errorStatus: number | null;
  errorCode: string | null;
}

/**
 * Loads one admin resource. `path` null turns it off (no access). While a new path loads, the previous
 * data stays on screen, so charts do not flash empty when the range changes.
 */
export function useAdminData<T>(path: string | null) {
  const [reloadKey, setReloadKey] = useState(0);
  const [settled, setSettled] = useState<Settled<T>>({ key: "", data: null, error: null, errorStatus: null, errorCode: null });
  const key = path === null ? "" : `${reloadKey}:${path}`;

  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    adminApi<T>(path, { signal: controller.signal })
      .then((data) => setSettled({ key, data, error: null, errorStatus: null, errorCode: null }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // Keep the last good data next to the error, so a failed refresh does not blank the page.
        setSettled((previous) => ({ key, data: previous.data, error: messageOf(error), errorStatus: error instanceof ApiError ? error.status : 0, errorCode: error instanceof ApiError ? error.code : null }));
      });
    return () => controller.abort();
  }, [key, path]);

  const reload = useCallback(() => setReloadKey((value) => value + 1), []);
  // Turned off (no access): never show data from an earlier path.
  if (path === null) return { data: null, error: null, errorStatus: null, loading: false, lastError: null, lastErrorStatus: null, lastErrorCode: null, attempt: "", reload };
  const current = settled.key === key;
  return {
    data: settled.data,
    error: current ? settled.error : null,
    errorStatus: current ? settled.errorStatus : null,
    loading: !current,
    /** Outcome of the most recent finished attempt, even while a newer one is loading. */
    lastError: settled.key ? settled.error : null,
    lastErrorStatus: settled.key ? settled.errorStatus : null,
    lastErrorCode: settled.key ? settled.errorCode : null,
    /** Identifies the current attempt (path and reload count). */
    attempt: key,
    reload,
  };
}
