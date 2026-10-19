"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiError, messageOf, workspaceApi } from "./api";

interface Settled<T> {
  /** The request (reload count and path) this result belongs to. */
  key: string;
  data: T | null;
  /** The path `data` was loaded from; it can lag behind `path` while a new one loads. */
  dataPath: string | null;
  etag: string | null;
  error: string | null;
  /** HTTP status of the last failure (0 for network errors), so pages can tell "not found" apart. */
  errorStatus: number | null;
  errorCode: string | null;
}

const EMPTY: Settled<never> = { key: "", data: null, dataPath: null, etag: null, error: null, errorStatus: null, errorCode: null };

/**
 * Loads one workspace resource. `path` null turns it off. While a new path loads, the previous data
 * stays on screen; a failed refresh keeps the last good data next to the error.
 */
export function useWorkspaceData<T>(path: string | null) {
  const [reloadKey, setReloadKey] = useState(0);
  const [settled, setSettled] = useState<Settled<T>>(EMPTY);
  const key = path === null ? "" : `${reloadKey}:${path}`;

  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    workspaceApi<T>(path, { signal: controller.signal })
      .then(({ data, etag }) => setSettled({ key, data, dataPath: path, etag, error: null, errorStatus: null, errorCode: null }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSettled((previous) => ({ key, data: previous.data, dataPath: previous.dataPath, etag: previous.etag, error: messageOf(error), errorStatus: error instanceof ApiError ? error.status : 0, errorCode: error instanceof ApiError ? error.code : null }));
      });
    return () => controller.abort();
  }, [key, path]);

  const reload = useCallback(() => setReloadKey((value) => value + 1), []);
  if (path === null) return { data: null, dataPath: null, etag: null, error: null, errorStatus: null, errorCode: null, loading: false, reload };
  const current = settled.key === key;
  return {
    data: settled.data,
    dataPath: settled.dataPath,
    etag: settled.etag,
    error: current ? settled.error : null,
    errorStatus: current ? settled.errorStatus : null,
    errorCode: current ? settled.errorCode : null,
    loading: !current,
    reload,
  };
}
