"use client";

import Link from "next/link";
import { Fragment, Suspense } from "react";

import { useAdmin } from "../_components/admin-context";
import { BarList } from "../_components/charts";
import { DownloadIcon } from "../_components/icons";
import { Avatar, Badge, Card, EmptyState, ErrorBanner, LoadMore, NoAccess, PageHeader, Panel, SkeletonRows } from "../_components/ui";
import { query } from "../_lib/api";
import { canAccess } from "../_lib/access";
import { downloadCsv, toCsv } from "../_lib/csv";
import { AUDIT_ACTIONS, describeAction, formatDateTime, humanize } from "../_lib/format";
import { VIZ } from "../_lib/palette";
import type { AuditAction, AuditEntry } from "../_lib/types";
import { usePagedList } from "../_lib/use-paged-list";
import { useQueryState, useQueryUpdater } from "../_lib/use-query-state";

const ACTIONS = Object.keys(AUDIT_ACTIONS) as AuditAction[];
const TARGETS = ["report", "community", "user", "campaign"] as const;
type TargetFilter = "any" | (typeof TARGETS)[number];
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

function detailOf(entry: AuditEntry): string | null {
  // Role changes already name the role in the action label.
  const { previousState, previousStatus, reasonCode, version } = entry.metadata;
  if (typeof previousState === "string") return `Was ${previousState}`;
  if (typeof previousStatus === "string") return `Was ${previousStatus}`;
  if (typeof reasonCode === "string") return `Reported for ${humanize(reasonCode).toLowerCase()}`;
  if (typeof version === "number") return `Version ${version}`;
  return null;
}

/** Converts a yyyy-mm-dd date input to the start of that day, or the day after for an inclusive end. */
function dayBoundary(day: string, endOfDay: boolean): string | undefined {
  if (!DATE.test(day)) return undefined;
  const date = new Date(`${day}T00:00:00`);
  if (endOfDay) date.setDate(date.getDate() + 1);
  return date.toISOString();
}

/** "Today", "Yesterday" or a full date, for grouping entries by local day. */
function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function tally(values: string[]): Array<{ key: string; value: number }> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value);
}

function AuditLog() {
  const { roles } = useAdmin();
  const allowed = canAccess(roles, "audit");
  const [action, setAction] = useQueryState<"any" | AuditAction>("action", "any", ["any", ...ACTIONS]);
  const [target, setTarget] = useQueryState<TargetFilter>("target", "any", ["any", ...TARGETS]);
  const [from, setFrom] = useQueryState<string>("from", "");
  const [to, setTo] = useQueryState<string>("to", "");
  const updateQuery = useQueryUpdater();
  const range = { from: dayBoundary(from, false), to: dayBoundary(to, true) };
  const invalidRange = Boolean(range.from && range.to && range.from >= range.to);
  const list = usePagedList<AuditEntry>(
    allowed && !invalidRange
      ? `/audit-logs${query({ action: action === "any" ? undefined : action, targetType: target === "any" ? undefined : target, from: range.from, to: range.to })}`
      : null,
  );
  const filtered = action !== "any" || target !== "any" || from !== "" || to !== "";

  if (!allowed) return <NoAccess />;

  const clear = () => updateQuery({ action: null, target: null, from: null, to: null });

  const exportCsv = () => {
    const rows = list.items.map((entry) => [entry.createdAt, describeAction(entry), entry.action, entry.target.type, entry.target.label, entry.target.id, entry.actor.displayName, entry.reason]);
    downloadCsv(`spark-audit-${new Date().toISOString().slice(0, 10)}.csv`, toCsv([["Time (UTC)", "Action", "Action code", "Target type", "Target", "Target ID", "Staff member", "Reason"], ...rows]));
  };

  const byStaff = tally(list.items.map((entry) => entry.actor.displayName)).slice(0, 6);
  const byTarget = tally(list.items.map((entry) => entry.target.type));

  return (
    <>
      <PageHeader
        actions={
          <button className="admBtn admBtnSecondary admBtnSm" disabled={list.items.length === 0} onClick={exportCsv} type="button">
            <DownloadIcon /> Export {list.items.length > 0 ? `${list.items.length} ${list.items.length === 1 ? "entry" : "entries"}` : "CSV"}
          </button>
        }
        description="Every governance action, who took it and why. Entries are permanent and cannot be edited."
        title="Audit log"
      />

      {list.items.length > 0 && (
        <div className="admGrid2">
          <Card subtitle={`Across the ${list.items.length} entries loaded below`} title="Actions by staff member" tone="navy">
            <div className="admCardInset">
              <BarList color={VIZ.blue} items={byStaff.map((item) => ({ key: item.key, label: item.key, value: item.value }))} />
            </div>
          </Card>
          <Card subtitle={`Across the ${list.items.length} entries loaded below`} title="Actions by target" tone="violet">
            <div className="admCardInset">
              <BarList color={VIZ.violet} items={byTarget.map((item) => ({ key: item.key, label: item.key === "community" ? "Communities" : `${humanize(item.key)}s`, value: item.value }))} />
            </div>
          </Card>
        </div>
      )}

      {invalidRange && <ErrorBanner message="The start date must be on or before the end date." />}
      {list.error && <ErrorBanner message={list.error} onRetry={list.reload} />}
      <Panel
        footer={!list.loading && list.items.length > 0 ? <LoadMore hasMore={list.hasMore} loading={list.loadingMore} noun="entry" plural="entries" onClick={() => void list.loadMore()} shown={list.items.length} /> : undefined}
        label="Audit entries"
        tabs={
          <div aria-label="Filter the audit log" className="admFilters" role="group">
            <label className="admSelect">
              <span className="admSrOnly">Action</span>
              <select onChange={(event) => setAction(event.target.value as "any" | AuditAction)} value={action}>
                <option value="any">All actions</option>
                {ACTIONS.map((value) => <option key={value} value={value}>{AUDIT_ACTIONS[value].label}</option>)}
              </select>
            </label>
            <label className="admSelect">
              <span className="admSrOnly">Target</span>
              <select onChange={(event) => setTarget(event.target.value as TargetFilter)} value={target}>
                <option value="any">All targets</option>
                {TARGETS.map((value) => <option key={value} value={value}>{humanize(value)}s</option>)}
              </select>
            </label>
            <label className="admDate">
              <span className="admDateLabel">From</span>
              <input max={to || undefined} onChange={(event) => setFrom(event.target.value)} type="date" value={from} />
            </label>
            <label className="admDate">
              <span className="admDateLabel">To</span>
              <input min={from || undefined} onChange={(event) => setTo(event.target.value)} type="date" value={to} />
            </label>
            {filtered && <button className="admBtn admBtnGhost admBtnSm" onClick={clear} type="button">Clear filters</button>}
          </div>
        }
      >
        {list.loading ? (
          <SkeletonRows />
        ) : list.items.length === 0 && !list.error && !invalidRange ? (
          <EmptyState title={filtered ? "No entries match these filters" : "No governance actions yet"}>
            {filtered ? "Try a wider date range or a different action." : "Actions taken in this console are recorded here automatically."}
          </EmptyState>
        ) : (
          <table className="admTable">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Action</th>
                <th scope="col">Target</th>
                <th scope="col">Staff member</th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((entry, index) => {
                const detail = detailOf(entry);
                const day = dayLabel(entry.createdAt);
                const newDay = index === 0 || dayLabel(list.items[index - 1]!.createdAt) !== day;
                return (
                  <Fragment key={entry.id}>
                  {newDay && (
                    <tr className="admGroupRow">
                      <th colSpan={5} scope="colgroup">{day}</th>
                    </tr>
                  )}
                  <tr>
                    <td className="admNowrap admMutedCell" data-label="Time"><time dateTime={entry.createdAt} title={formatDateTime(entry.createdAt)}>{new Date(entry.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</time></td>
                    <td data-label="Action">
                      <div className="admCellMain">
                        <Badge tone={AUDIT_ACTIONS[entry.action]?.tone ?? "neutral"}>{describeAction(entry)}</Badge>
                        {detail && <span className="admCellSub">{detail}</span>}
                      </div>
                    </td>
                    <td data-label="Target">
                      <div className="admCellMain">
                        {entry.target.type === "user" && canAccess(roles, "users")
                          ? <Link className="admTextLink" href={`/admin/users/${entry.target.id}`}>{entry.target.label}</Link>
                          : <span>{entry.target.label}</span>}
                        <span className="admCellSub">{humanize(entry.target.type)}</span>
                      </div>
                    </td>
                    <td data-label="Staff">
                      <span className="admInline"><Avatar name={entry.actor.displayName} size="sm" />{entry.actor.displayName}</span>
                    </td>
                    <td className="admReasonCell" data-label="Reason">{entry.reason}</td>
                  </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

export default function AuditLogPage() {
  return (
    <Suspense fallback={<SkeletonRows />}>
      <AuditLog />
    </Suspense>
  );
}
