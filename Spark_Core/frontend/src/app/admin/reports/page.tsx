"use client";

import { Suspense, useState } from "react";

import { useAdmin } from "../_components/admin-context";
import { Drawer } from "../_components/drawer";
import { ReasonDialog, type ReasonRequest } from "../_components/reason-dialog";
import { Avatar, Badge, EmptyState, ErrorBanner, FilterTabs, KeyValue, LoadMore, NoAccess, PageHeader, Panel, SkeletonRows, Tag } from "../_components/ui";
import { adminApi, reloadIfStale } from "../_lib/api";
import { canAccess } from "../_lib/access";
import { REPORT_STATUS, formatDateTime, formatRelative, humanize } from "../_lib/format";
import type { Report, ReportStatus } from "../_lib/types";
import { usePagedList } from "../_lib/use-paged-list";
import { useQueryState } from "../_lib/use-query-state";

const STATUSES: readonly ReportStatus[] = ["open", "reviewing", "resolved", "dismissed"];
type ReportAction = "hide" | "restore" | "dismiss";

const ACTIONS: Record<ReportAction, { label: string; title: string; description: string; tone: "primary" | "danger"; done: string }> = {
  hide: {
    label: "Hide content",
    title: "Hide this content?",
    description: "The content is hidden from members and the report is marked resolved.",
    tone: "danger",
    done: "Content hidden and report resolved.",
  },
  restore: {
    label: "Keep content",
    title: "Keep this content visible?",
    description: "The content stays visible (and is restored if it was hidden). The report is marked resolved.",
    tone: "primary",
    done: "Content kept and report resolved.",
  },
  dismiss: {
    label: "Dismiss report",
    title: "Dismiss this report?",
    description: "Use this when the report is not a policy violation. The content is not changed.",
    tone: "primary",
    done: "Report dismissed.",
  },
};

function excerpt(text: string, length = 140): string {
  return text.length > length ? `${text.slice(0, length).trimEnd()}…` : text;
}

function ReportsQueue() {
  const { roles, overview, refreshOverview, notify } = useAdmin();
  const [status, setStatus] = useQueryState<ReportStatus>("status", "open", STATUSES);
  const allowed = canAccess(roles, "reports");
  const list = usePagedList<Report>(allowed ? `/reports?status=${status}` : null);
  const [selected, setSelected] = useState<Report | null>(null);
  const [dialog, setDialog] = useState<ReasonRequest | null>(null);

  if (!allowed) return <NoAccess />;

  const act = (report: Report, action: ReportAction) => {
    const copy = ACTIONS[action];
    setDialog({
      title: copy.title,
      description: (
        <>
          <p>{copy.description}</p>
          <p className="admQuote">{excerpt(report.target.title ? `${report.target.title}: ${report.target.body}` : report.target.body, 200)}</p>
        </>
      ),
      confirmLabel: copy.label,
      tone: copy.tone,
      onConfirm: async (reason) => {
        await adminApi(`/reports/${report.id}/actions`, { method: "POST", body: { action, reason } }).catch((error: unknown) => reloadIfStale(error, list.reload));
        list.update(report.id, () => null);
        setSelected(null);
        refreshOverview();
        notify(copy.done);
      },
    });
  };

  const actionable = (report: Report) => report.status === "open" || report.status === "reviewing";

  return (
    <>
      <PageHeader title="Reports" description="Content members reported. Decide whether it stays, gets hidden, or the report is dismissed." />

      {list.error && <ErrorBanner message={list.error} onRetry={list.reload} />}
      <Panel
        footer={!list.loading && list.items.length > 0 ? <LoadMore hasMore={list.hasMore} loading={list.loadingMore} noun="report" onClick={() => void list.loadMore()} shown={list.items.length} /> : undefined}
        label="Reports"
        tabs={
          <FilterTabs
            label="Report status"
            onChange={setStatus}
            options={STATUSES.map((value) => ({ value, label: REPORT_STATUS[value].label, count: value === "open" ? overview?.reports.open : undefined }))}
            value={status}
          />
        }
      >
        {list.loading ? (
          <SkeletonRows />
        ) : list.items.length === 0 && !list.error ? (
          <EmptyState title={status === "open" ? "The queue is clear" : `No ${REPORT_STATUS[status].label.toLowerCase()} reports`}>
            {status === "open" ? "New reports from members will appear here." : "Reports move here once they reach this status."}
          </EmptyState>
        ) : (
          <table className="admTable">
            <thead>
              <tr>
                <th scope="col">Reported content</th>
                <th scope="col">Community</th>
                <th scope="col">Reason</th>
                <th scope="col">Reporter</th>
                <th scope="col">Status</th>
                <th scope="col">Reported</th>
                <th scope="col"><span className="admSrOnly">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((report) => (
                <tr key={report.id}>
                  <td data-label="Content">
                    <div className="admCellMain">
                      <span className="admCellTitle">
                        <Tag>{report.target.kind === "post" ? "Post" : "Comment"}</Tag>
                        {report.target.title ?? "Comment"}
                      </span>
                      <span className="admCellSub admClamp">{excerpt(report.target.body, 110)}</span>
                    </div>
                  </td>
                  <td data-label="Community">{report.community.name}</td>
                  <td data-label="Reason">{humanize(report.reasonCode)}</td>
                  <td data-label="Reporter">{report.reporter.displayName}</td>
                  <td data-label="Status">
                    {report.target.moderationStatus === "hidden"
                      ? <Badge tone="red">Content hidden</Badge>
                      : <Badge tone={REPORT_STATUS[report.status].tone}>{REPORT_STATUS[report.status].label}</Badge>}
                  </td>
                  <td className="admNowrap admMutedCell" data-label="Reported"><time dateTime={report.createdAt} title={formatDateTime(report.createdAt)}>{formatRelative(report.createdAt)}</time></td>
                  <td className="admCellActions">
                    <button className="admBtn admBtnSecondary admBtnSm" onClick={() => setSelected(report)} type="button">
                      {actionable(report) ? "Review" : "View"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Drawer
        footer={selected && actionable(selected) ? (
          <>
            <button className="admBtn admBtnSecondary" onClick={() => act(selected, "dismiss")} type="button">Dismiss report</button>
            <button className="admBtn admBtnSecondary" onClick={() => act(selected, "restore")} type="button">Keep content</button>
            <button className="admBtn admBtnDanger" onClick={() => act(selected, "hide")} type="button">Hide content</button>
          </>
        ) : undefined}
        onClose={() => setSelected(null)}
        open={selected !== null}
        subtitle={selected ? <>Reported {formatRelative(selected.createdAt)} in {selected.community.name}</> : undefined}
        title={selected?.target.kind === "comment" ? "Reported comment" : "Reported post"}
      >
        {selected && (
          <>
            <div className="admBadgeRow">
              <Badge tone={REPORT_STATUS[selected.status].tone}>{REPORT_STATUS[selected.status].label}</Badge>
              <Badge tone={selected.target.moderationStatus === "hidden" ? "red" : "green"}>{selected.target.moderationStatus === "hidden" ? "Content hidden" : "Content visible"}</Badge>
              <Tag>{selected.target.kind === "post" ? "Post" : "Comment"}</Tag>
            </div>
            <article className="admContentPreview">
              {selected.target.title && <h3>{selected.target.title}</h3>}
              <p>{selected.target.body}</p>
            </article>
            <KeyValue
              items={[
                ["Reason", humanize(selected.reasonCode)],
                ["Reporter's note", selected.details ?? "No note"],
                ["Reporter", <span className="admInline" key="reporter"><Avatar name={selected.reporter.displayName} size="sm" />{selected.reporter.displayName}</span>],
                ["Community", selected.community.slug ? `${selected.community.name} (${selected.community.slug})` : selected.community.name],
                ["Reported", formatDateTime(selected.createdAt)],
                ["Closed", selected.resolvedAt ? formatDateTime(selected.resolvedAt) : "Still open"],
              ]}
            />
            <p className="admMuted admSmall">The reporter&apos;s identity is visible only to staff who handle reports.</p>
          </>
        )}
      </Drawer>
      <ReasonDialog onClose={() => setDialog(null)} request={dialog} />
    </>
  );
}

export default function ReportsPage() {
  return (
    <Suspense fallback={<SkeletonRows />}>
      <ReportsQueue />
    </Suspense>
  );
}
