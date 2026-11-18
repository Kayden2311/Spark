"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../../_lib/api";
import { ModerationDialog } from "../../_components/moderation-dialog";
import { contentApi, contentErrorMessage, type ModerationAction, type ReportQueueItem } from "../../_lib/content-api";
import { formatDate, formatRelative } from "../../format";
import type { ManageContext } from "./manage-view";
import { useList } from "./use-list";

const REASON_LABELS: Record<string, string> = {
  spam: "Spam",
  harassment: "Harassment",
  off_topic: "Off-topic",
  misinformation: "Misinformation",
  self_promotion: "Self-promotion",
  other: "Something else",
};

export const reasonLabel = (reason: string) => REASON_LABELS[reason] ?? reason;

const reportCountLabel = (count: number) => `${count} open ${count === 1 ? "report" : "reports"}`;

const keyOf = (item: ReportQueueItem) => `${item.target.kind}:${item.target.id}`;

/**
 * The open reports of the community, one row per reported post or comment. Moderators decide with Hide or
 * Keep; either way the item's reports close, so the row leaves the list. The queue never says who reported.
 */
export function ReportsTab({ context }: { context: ManageContext }) {
  const { community, notify, handleAccess } = context;
  const communityId = community.id;
  const load = useCallback((signal: AbortSignal) => contentApi.reports(communityId, signal), [communityId]);
  const list = useList<ReportQueueItem>(load);
  const [deciding, setDeciding] = useState<{ item: ReportQueueItem; action: ModerationAction } | null>(null);

  useEffect(() => {
    if (list.error) handleAccess(list.error);
  }, [handleAccess, list.error]);

  const items = list.items ?? [];
  const failed = Boolean(list.error) && !list.items;
  const base = `/communities/${encodeURIComponent(community.slug)}`;

  return (
    <section aria-labelledby="reports-title" className="spPanel">
      <header className="spPanelHead">
        <div className="spPanelHeadText">
          <h2 id="reports-title" tabIndex={-1}>Reported content</h2>
          <p>Posts and comments members reported. Hide removes it from view; Keep leaves it and closes the reports.</p>
        </div>
        <span className="spPanelCount">{list.items ? items.length : "—"}</span>
      </header>

      {failed && !(list.error instanceof ApiError && list.error.status === 401) && (
        <div className="spAlert spAlertDanger spPanelAlert" role="alert">
          {contentErrorMessage(list.error)}
          <button className="spBtn spBtnSecondary spBtnSm" onClick={list.reload} type="button">Try again</button>
        </div>
      )}

      {!list.items && !failed && (
        <div aria-busy="true" className="spRowsSkeleton" role="status">
          <span className="spSrOnly">Loading reports…</span>
          <span className="spSkeleton" /><span className="spSkeleton" /><span className="spSkeleton" />
        </div>
      )}

      {list.items && items.length === 0 && (
        <div className="spEmpty">
          <span aria-hidden="true" className="spEmptyIcon"><svg viewBox="0 0 24 24"><path d="M5 20V4.5M5 5h11l-1.8 3.5L16 12H5" /></svg></span>
          <h3 className="spEmptyTitle">No open reports</h3>
          <p className="spEmptyText">When someone reports a post or comment, it shows up here.</p>
        </div>
      )}

      {items.length > 0 && (
        <ul aria-label="Open reports" className="spReportList">
          {items.map((item) => {
            const { target } = item;
            const href = `${base}/posts/${encodeURIComponent(target.postId)}`;
            const last = formatRelative(item.lastReportedAt);
            const hidden = target.moderation === "hidden";
            return (
              <li className="spReport" key={keyOf(item)}>
                <div className="spReportBody">
                  <p className="spReportWho">
                    <span className="spBadge">{target.kind === "post" ? "Post" : "Comment"}</span>
                    {hidden && <span className="spBadge spBadgeWarn">Hidden</span>}
                    <strong>{target.authorName}</strong>
                  </p>
                  {target.kind === "post" ? (
                    <>
                      <Link className="spReportLink" href={href}>{target.title}</Link>
                      {target.excerpt && <p className="spReportExcerpt">{target.excerpt}</p>}
                    </>
                  ) : (
                    <>
                      <Link className="spReportLink" href={href}>{target.excerpt}</Link>
                      <p className="spReportContext">On &ldquo;{target.title}&rdquo;</p>
                    </>
                  )}
                  <p className="spReportCount">{reportCountLabel(item.openReports)}</p>
                  <ul aria-label="Reasons" className="spChips spReportReasons">
                    {item.reasons.map((entry) => (
                      <li className="spBadge" key={entry.reason}>{`${reasonLabel(entry.reason)} ×${entry.count}`}</li>
                    ))}
                  </ul>
                  {item.latestDetails.length > 0 && (
                    <ul aria-label="Latest details" className="spReportDetails">
                      {item.latestDetails.map((detail, index) => (
                        <li key={`${index}:${detail}`}>{detail}</li>
                      ))}
                    </ul>
                  )}
                  {last && <p className="spReportWhen"><time dateTime={item.lastReportedAt} title={formatDate(item.lastReportedAt) ?? undefined}>{`Last reported ${last}`}</time></p>}
                </div>
                <div className="spReportActions">
                  <button
                    aria-label={`Keep ${target.kind} by ${target.authorName}`}
                    className="spBtn spBtnSecondary spBtnSm"
                    onClick={() => setDeciding({ item, action: "dismiss" })}
                    type="button"
                  >
                    Keep
                  </button>
                  <button
                    aria-label={`${hidden ? "Restore" : "Hide"} ${target.kind} by ${target.authorName}`}
                    className="spBtn spBtnPrimary spBtnSm"
                    onClick={() => setDeciding({ item, action: hidden ? "restore" : "hide" })}
                    type="button"
                  >
                    {hidden ? "Restore" : "Hide"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {deciding && (
        <ModerationDialog
          action={deciding.action}
          hidden={deciding.item.target.moderation === "hidden"}
          fallbackFocus={() => document.getElementById("reports-title")}
          id={deciding.item.target.id}
          kind={deciding.item.target.kind}
          onClose={() => setDeciding(null)}
          onDone={(result) => {
            const done = deciding;
            const noun = done.item.target.kind === "post" ? "Post" : "Comment";
            if (done.action === "restore") {
              // Restoring does not close reports: the row stays, now shown as visible.
              list.setItems((current) => current.map((entry) => (keyOf(entry) === keyOf(done.item) ? { ...entry, target: { ...entry.target, moderation: result.moderation } } : entry)));
              notify(`${noun} restored.`);
              return;
            }
            list.setItems((current) => current.filter((entry) => keyOf(entry) !== keyOf(done.item)));
            notify(done.action === "hide" ? `${noun} hidden.` : "Reports dismissed.");
          }}
        />
      )}
    </section>
  );
}
