"use client";

import { planStatusLabel } from "../../../../_lib/insights";
import { useWorkspaceData } from "../../../../_lib/use-workspace-data";

/**
 * One insights card's request. Data loaded for another path (an earlier range or period) is never shown
 * under the new one: the card shows its loading state until the new answer arrives. A retry of the same
 * path keeps the numbers on screen. `error` and `reload` drive the card's own retry.
 */
export function useInsight<T>(path: string | null) {
  const result = useWorkspaceData<T>(path);
  const data = result.dataPath === path ? result.data : null;
  return {
    data,
    loading: result.loading && data === null && !result.error,
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
