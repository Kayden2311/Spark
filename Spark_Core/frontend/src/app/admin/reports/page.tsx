"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAdmin } from "../_components/admin-context";
import { BarList, InlineBar } from "../_components/charts";
import { ClockIcon, InboxIcon, KeyboardIcon, PulseIcon } from "../_components/icons";
import { PostPreview } from "../_components/post-preview";
import { ReasonDialog, type ReasonRequest } from "../_components/reason-dialog";
import { Avatar, Badge, Card, CheckboxFacet, EmptyState, ErrorBanner, FilterTabs, KeyValue, LoadMore, MetricTile, NoAccess, PageHeader, SkeletonRows, Tag } from "../_components/ui";
import { adminApi, reloadIfStale } from "../_lib/api";
import { canAccess } from "../_lib/access";
import { REPORT_STATUS, formatCount, formatDate, formatDateTime, formatRelative, humanize } from "../_lib/format";
import { VIZ } from "../_lib/palette";
import type { Report, ReportContext, ReportPreview, ReportStats, ReportStatus } from "../_lib/types";
import { useAdminData } from "../_lib/use-admin-data";
import { usePagedList } from "../_lib/use-paged-list";
import { useQueryState } from "../_lib/use-query-state";

const STATUSES: readonly ReportStatus[] = ["open", "reviewing", "resolved", "dismissed"];
type ReportAction = "hide" | "restore" | "dismiss";

const ACTIONS: Record<ReportAction, { key: string; label: string; title: string; description: string; tone: "primary" | "danger"; done: string; templates: string[] }> = {
  hide: {
    key: "h",
    label: "Hide content",
    title: "Hide this content?",
    description: "The content is hidden from members and the report is marked resolved.",
    tone: "danger",
    done: "Content hidden and report resolved.",
    templates: ["Spam or unsolicited promotion.", "Harassment or a personal attack.", "Misinformation that could cause harm.", "Repeated off-topic posting after warnings."],
  },
  restore: {
    key: "e",
    label: "Keep content",
    title: "Keep this content visible?",
    description: "The content stays visible (and is restored if it was hidden). The report is marked resolved.",
    tone: "primary",
    done: "Content kept and report resolved.",
    templates: ["Reviewed: within the community guidelines.", "A disagreement, not a policy violation."],
  },
  dismiss: {
    key: "d",
    label: "Dismiss report",
    title: "Dismiss this report?",
    description: "Use this when the report is not a policy violation. The content is not changed.",
    tone: "primary",
    done: "Report dismissed.",
    templates: ["Not a policy violation.", "Duplicate of a report already handled.", "Not enough detail to act on."],
  },
};

const SHORTCUTS: Array<[string, string]> = [
  ["J or ↓", "Next report"],
  ["K or ↑", "Previous report"],
  ["H", "Hide content"],
  ["E", "Keep content"],
  ["D", "Dismiss report"],
  ["?", "Show or hide shortcuts"],
];

function excerpt(text: string, length = 140): string {
  return text.length > length ? `${text.slice(0, length).trimEnd()}…` : text;
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

const actionable = (report: Report) => report.status === "open" || report.status === "reviewing";

function daysOpen(report: Report): number {
  return Math.max(0, (Date.now() - Date.parse(report.createdAt)) / 86_400_000);
}

/** Thin bar under a queue row: how long it has sat open, relative to a one-week horizon. Calm, then amber, then red. */
function AgeBar({ report }: { report: Report }) {
  const days = daysOpen(report);
  const color = days >= 3 ? "#ef4444" : days >= 1 ? "#f59e0b" : "#94a3b8";
  return <InlineBar color={color} ratio={days / 7} wide />;
}

function countBy<T>(items: T[], keyOf: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function ContextPanel({ report }: { report: Report }) {
  const { roles } = useAdmin();
  const context = useAdminData<ReportContext>(`/reports/${report.id}/context`);
  if (context.error) return <ErrorBanner message={context.error} onRetry={context.reload} />;
  if (!context.data) return <SkeletonRows rows={2} />;
  const { author, communityOpenReports, reporterReportsFiled } = context.data;
  const repeat = author && (author.reportsAgainst > 2 || author.hiddenContent > 0);
  return (
    <div className="admTriageContext">
      <div className="admTriageAuthor">
        <Avatar name={author?.displayName ?? "?"} />
        <div className="admCellMain">
          <span className="admCellTitle">
            {author ? (canAccess(roles, "users") ? <Link className="admTextLink" href={`/admin/users/${author.id}`}>{author.displayName}</Link> : author.displayName) : "Deleted account"}
            {author?.status === "suspended" && <Badge tone="red">Suspended</Badge>}
          </span>
          <span className="admCellSub">{author ? `Author · joined ${formatDate(author.joinedAt)}` : "The author's account no longer exists"}</span>
        </div>
        {repeat && <Badge tone="amber">Repeat reports</Badge>}
      </div>
      <dl className="admTriageStats">
        <div><dt>Reports against author</dt><dd>{formatCount(author?.reportsAgainst ?? 0)}</dd></div>
        <div><dt>Author content hidden</dt><dd>{formatCount(author?.hiddenContent ?? 0)}</dd></div>
        <div><dt>Open in this community</dt><dd>{formatCount(communityOpenReports)}</dd></div>
        <div><dt>Reports by this reporter</dt><dd>{formatCount(reporterReportsFiled)}</dd></div>
      </dl>
    </div>
  );
}

function ReportContent({ report }: { report: Report }) {
  const preview = useAdminData<ReportPreview>(`/reports/${report.id}/preview`);
  return (
    <PostPreview
      community={report.community.name}
      error={preview.error}
      fallback={{ title: report.target.title, body: report.target.body }}
      loading={preview.loading}
      onRetry={preview.reload}
      preview={preview.data}
    />
  );
}

function TriageDesk() {
  const { roles, overview, refreshOverview, notify } = useAdmin();
  const [status, setStatus] = useQueryState<ReportStatus>("status", "open", STATUSES);
  const allowed = canAccess(roles, "reports");
  const list = usePagedList<Report>(allowed ? `/reports?status=${status}&limit=100` : null);
  const stats = useAdminData<ReportStats>(allowed ? "/reports/stats?days=30" : null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ReasonRequest | null>(null);
  const [help, setHelp] = useState(false);
  const [reasonFilter, setReasonFilter] = useState<Set<string>>(new Set());
  const [communityFilter, setCommunityFilter] = useState<Set<string>>(new Set());
  const detail = useRef<HTMLElement>(null);

  const loaded = list.items;
  const reasonCounts = useMemo(() => countBy(loaded, (report) => report.reasonCode), [loaded]);
  const communityCounts = useMemo(() => countBy(loaded, (report) => report.community.id), [loaded]);
  const communityNames = useMemo(() => new Map(loaded.map((report) => [report.community.id, report.community.name])), [loaded]);
  const items = useMemo(
    () => loaded.filter((report) => (reasonFilter.size === 0 || reasonFilter.has(report.reasonCode)) && (communityFilter.size === 0 || communityFilter.has(report.community.id))),
    [loaded, reasonFilter, communityFilter],
  );
  const faceted = reasonFilter.size > 0 || communityFilter.size > 0;
  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null;
  const index = selected ? items.indexOf(selected) : -1;

  const select = useCallback((report: Report | undefined, reveal = false) => {
    if (!report) return;
    setSelectedId(report.id);
    document.getElementById(`report-${report.id}`)?.scrollIntoView?.({ block: "nearest" });
    if (reveal && window.matchMedia?.("(max-width: 1100px)").matches) detail.current?.scrollIntoView?.({ block: "start" });
  }, []);

  const act = useCallback((report: Report, action: ReportAction) => {
    const copy = ACTIONS[action];
    const next = items[items.indexOf(report) + 1] ?? items[items.indexOf(report) - 1];
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
      templates: copy.templates,
      onConfirm: async (reason) => {
        await adminApi(`/reports/${report.id}/actions`, { method: "POST", body: { action, reason } }).catch((error: unknown) => reloadIfStale(error, list.reload));
        list.update(report.id, () => null);
        setSelectedId(next?.id ?? null);
        refreshOverview();
        stats.reload();
        notify(copy.done);
      },
    });
  }, [items, list, notify, refreshOverview, stats]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target) || document.querySelector("[aria-modal='true']")) return;
      const key = event.key.toLowerCase();
      if (key === "?") {
        setHelp((value) => !value);
      } else if (key === "j" || key === "arrowdown") {
        if (!selected) return;
        select(items[Math.min(items.length - 1, index + 1)]);
      } else if (key === "k" || key === "arrowup") {
        if (!selected) return;
        select(items[Math.max(0, index - 1)]);
      } else if (selected && actionable(selected) && (key === "h" || key === "e" || key === "d")) {
        act(selected, key === "h" ? "hide" : key === "e" ? "restore" : "dismiss");
      } else {
        return;
      }
      event.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [act, index, items, select, selected]);

  if (!allowed) return <NoAccess />;

  return (
    <>
      <PageHeader
        actions={
          <button aria-expanded={help} aria-keyshortcuts="?" className="admBtn admBtnSecondary admBtnSm" onClick={() => setHelp((value) => !value)} type="button">
            <KeyboardIcon /> Shortcuts
          </button>
        }
        description="Work through reported posts and comments. Check who wrote it and their history, then decide."
        title="Reports"
      />

      {help && (
        <div className="admShortcuts" role="note">
          <strong>Keyboard shortcuts</strong>
          <ul>
            {SHORTCUTS.map(([keys, label]) => <li key={keys}><kbd>{keys}</kbd><span>{label}</span></li>)}
          </ul>
        </div>
      )}

      <div className="admGrid2">
        <Card subtitle="Last 30 days" title="Queue health">
          <div className="admMetricTiles">
            <MetricTile icon={<span aria-hidden="true" className="admMetricIcon admTone-amber"><InboxIcon /></span>} label="Open now" value={stats.data ? formatCount(stats.data.backlog) : "–"} />
            <MetricTile icon={<span aria-hidden="true" className="admMetricIcon admTone-violet"><PulseIcon /></span>} label="Opened (30d)" value={stats.data ? formatCount(stats.data.opened) : "–"} />
            <MetricTile icon={<span aria-hidden="true" className="admMetricIcon admTone-green"><InboxIcon /></span>} label="Closed (30d)" value={stats.data ? formatCount(stats.data.closed) : "–"} />
            <MetricTile icon={<span aria-hidden="true" className="admMetricIcon admTone-blue"><ClockIcon /></span>} label="Median time to decision" value={stats.data?.medianHoursToClose == null ? "–" : `${stats.data.medianHoursToClose.toFixed(1)} h`} />
          </div>
        </Card>
        <Card subtitle={`${REPORT_STATUS[status].label} queue · ${formatCount(loaded.length)} loaded`} title="By reason">
          <BarList
            color={VIZ.violet}
            emptyText="Nothing in this queue yet."
            items={[...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ key: reason, label: humanize(reason), value: count }))}
          />
        </Card>
      </div>

      {list.error && <ErrorBanner message={list.error} onRetry={list.reload} />}
      <div className="admTriage">
        <section aria-label="Report queue" className="admPanel admTriageList">
          <div className="admPanelHeader">
            <FilterTabs
              label="Report status"
              onChange={(value) => { setSelectedId(null); setReasonFilter(new Set()); setCommunityFilter(new Set()); setStatus(value); }}
              options={STATUSES.map((value) => ({ value, label: REPORT_STATUS[value].label, count: value === "open" ? overview?.reports.open : undefined }))}
              value={status}
            />
            <div className="admPanelTools">
              <CheckboxFacet
                label="Reason"
                onChange={setReasonFilter}
                options={[...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, label: humanize(value), count }))}
                selected={reasonFilter}
              />
              <CheckboxFacet
                label="Community"
                onChange={setCommunityFilter}
                options={[...communityCounts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, label: communityNames.get(value) ?? value, count }))}
                selected={communityFilter}
              />
            </div>
          </div>
          {list.loading ? (
            <div className="admCardInset"><SkeletonRows /></div>
          ) : items.length === 0 && !list.error ? (
            faceted && loaded.length > 0 ? (
              <EmptyState action={<button className="admBtn admBtnSecondary admBtnSm" onClick={() => { setReasonFilter(new Set()); setCommunityFilter(new Set()); }} type="button">Clear filters</button>} title="No reports match these filters">
                Try a different reason or community.
              </EmptyState>
            ) : (
              <EmptyState title={status === "open" ? "The queue is clear" : `No ${REPORT_STATUS[status].label.toLowerCase()} reports`}>
                {status === "open" ? "New reports from members will appear here." : "Reports move here once they reach this status."}
              </EmptyState>
            )
          ) : (
            <ul className="admTriageItems">
              {items.map((report) => (
                <li key={report.id}>
                  <button aria-current={report.id === selected?.id ? "true" : undefined} className="admTriageItem" id={`report-${report.id}`} onClick={() => select(report, true)} type="button">
                    <span className="admTriageItemTop">
                      <Tag>{report.target.kind === "post" ? "Post" : "Comment"}</Tag>
                      <span className="admTriageReason">{humanize(report.reasonCode)}</span>
                      <time dateTime={report.createdAt}>{formatRelative(report.createdAt)}</time>
                    </span>
                    <span className="admTriageItemTitle">{report.target.title ?? excerpt(report.target.body, 70)}</span>
                    <span className="admTriageItemMeta">
                      {report.community.name}
                      {report.target.moderationStatus === "hidden" && <Badge tone="red">Hidden</Badge>}
                    </span>
                    {actionable(report) && <AgeBar report={report} />}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!list.loading && items.length > 0 && (
            <div className="admPanelFooter"><LoadMore hasMore={list.hasMore} loading={list.loadingMore} noun="report" onClick={() => void list.loadMore()} shown={items.length} /></div>
          )}
        </section>

        <section aria-label="Selected report" className="admCard admTriageDetail" ref={detail}>
          {!selected ? (
            <p className="admCardEmpty">Select a report to review it.</p>
          ) : (
            <>
              <div className="admTriageHead">
                <div>
                  <p className="admTriageEyebrow">{selected.target.kind === "comment" ? "Reported comment" : "Reported post"} · {selected.community.name}</p>
                  <h2>Reported for {humanize(selected.reasonCode).toLowerCase()}</h2>
                  <div className="admBadgeRow">
                    <Badge tone={REPORT_STATUS[selected.status].tone}>{REPORT_STATUS[selected.status].label}</Badge>
                    <Badge tone={selected.target.moderationStatus === "hidden" ? "red" : "green"}>{selected.target.moderationStatus === "hidden" ? "Content hidden" : "Content visible"}</Badge>
                  </div>
                </div>
                <span className="admTriagePosition">{index + 1} of {items.length}{list.hasMore ? "+" : ""}</span>
              </div>
              <div className="admTriageBody">
                <ReportContent key={`content-${selected.id}`} report={selected} />
                {selected.details && (
                  <div className="admTriageNote">
                    <span>Reporter&apos;s note</span>
                    <p>{selected.details}</p>
                  </div>
                )}
                <ContextPanel key={`context-${selected.id}`} report={selected} />
                <KeyValue
                  items={[
                    ["Reporter", <span className="admInline" key="reporter"><Avatar name={selected.reporter.displayName} size="sm" />{selected.reporter.displayName}</span>],
                    ["Reported", formatDateTime(selected.createdAt)],
                    ["Closed", selected.resolvedAt ? formatDateTime(selected.resolvedAt) : "Still open"],
                  ]}
                />
                <p className="admMuted admSmall">The reporter&apos;s identity is visible only to staff who handle reports.</p>
              </div>
              {actionable(selected) && (
                <div className="admTriageActions">
                  <button aria-keyshortcuts="D" className="admBtn admBtnSecondary" onClick={() => act(selected, "dismiss")} type="button">Dismiss <kbd>D</kbd></button>
                  <button aria-keyshortcuts="E" className="admBtn admBtnSecondary" onClick={() => act(selected, "restore")} type="button">Keep <kbd>E</kbd></button>
                  <button aria-keyshortcuts="H" className="admBtn admBtnDanger" onClick={() => act(selected, "hide")} type="button">Hide content <kbd>H</kbd></button>
                </div>
              )}
            </>
          )}
        </section>
      </div>
      <ReasonDialog onClose={() => setDialog(null)} request={dialog} />
    </>
  );
}

export default function ReportsPage() {
  return (
    <Suspense fallback={<SkeletonRows />}>
      <TriageDesk />
    </Suspense>
  );
}
