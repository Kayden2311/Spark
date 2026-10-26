"use client";

import { useEffect, useRef, useState } from "react";

import { workspaceApi } from "./api";
import type { BoardState } from "./issues";
import { useWorkspaceData } from "./use-workspace-data";

/**
 * GET /projects/{id}/board with an optimistic local copy, shared by the board and the backlog.
 * Optimistic edits apply to the loaded copy they were made on; a reload (or a 412 refresh) drops them.
 */
export function useOptimisticBoard(path: string) {
  const loaded = useWorkspaceData<BoardState>(path);
  const base = loaded.dataPath === path ? loaded.data : null;
  const [local, setLocal] = useState<{ source: BoardState; board: BoardState } | null>(null);
  const committed = base && local?.source === base ? local.board : base;
  const baseRef = useRef<BoardState | null>(null);
  /** Writes still waiting for the API; callers count them so a silent refresh can wait until none are left. */
  const pendingRef = useRef(0);

  useEffect(() => {
    baseRef.current = base;
  }, [base]);

  /** Applies a change to the board copy that `source` was loaded as; changes for an outdated copy are dropped. */
  const update = (source: BoardState, change: (board: BoardState) => BoardState) => {
    if (baseRef.current !== null && source !== baseRef.current) return;
    setLocal((previous) => ({ source, board: change(previous && previous.source === source ? previous.board : source) }));
  };

  /**
   * Refetches the board without a loading state and puts it in place of the local copy, so versions
   * reranked by the server and counts stay current. A silent refresh is skipped while other writes are
   * in flight (the last one to settle refreshes again); `force` applies it regardless. Resolves false
   * when the board could not be fetched.
   */
  const refresh = async (force: boolean): Promise<boolean> => {
    const source = baseRef.current;
    if (!source) return false;
    try {
      const { data } = await workspaceApi<BoardState>(path);
      if (baseRef.current === source && (force || pendingRef.current === 0)) setLocal({ source, board: data });
      return true;
    } catch {
      return false;
    }
  };

  return { loaded, base, committed, pendingRef, update, refresh };
}
