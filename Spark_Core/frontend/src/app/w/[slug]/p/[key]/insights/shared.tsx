"use client";

import { planStatusLabel } from "../../../../_lib/insights";
import { useWorkspaceData } from "../../../../_lib/use-workspace-data";

/**
 * One insights card's request. `loading` is true only until the first answer, so a range change keeps the
 * previous numbers on screen while the new ones load; `error` and `reload` drive the card's own retry.
 */
export function useInsight<T>(path: string | null) {
  const result = useWorkspaceData<T>(path);
  return {
    data: result.data,
    loading: result.loading && result.data === null && !result.error,
    error: result.loading ? null : result.error,
    errorCode: result.errorCode,
    reload: result.reload,
  };
}

export type InsightQuery<T> = ReturnType<typeof useInsight<T>>;

/** On track / At risk / Behind / No plan, in words and colour. */
export function StatusPill({ status }: { status: string }) {
  const known = ["on_track", "at_risk", "behind"].includes(status) ? status : "no_plan";
  return <span className="wsInsightsStatus" data-status={known}>{planStatusLabel(known)}</span>;
}

/** The section heading above a group of cards. */
export function GroupHeading({ id, title, note }: { id: string; title: string; note?: string }) {
  return (
    <div className="wsInsightsGroupHead">
      <h2 id={id}>{title}</h2>
      {note && <p>{note}</p>}
    </div>
  );
}
