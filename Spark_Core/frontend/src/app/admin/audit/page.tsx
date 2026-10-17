"use client";

import Link from "next/link";
import { Suspense } from "react";

import { useAdmin } from "../_components/admin-context";
import { Avatar, Badge, EmptyState, ErrorBanner, LoadMore, NoAccess, PageHeader, Panel, SkeletonRows } from "../_components/ui";
import { query } from "../_lib/api";
import { canAccess } from "../_lib/access";
import { AUDIT_ACTIONS, describeAction, formatDateTime, humanize } from "../_lib/format";
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

  return (
    <>
      <PageHeader title="Audit log" description="Every governance action, who took it and why. Entries are permanent and cannot be edited." />

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
              {list.items.map((entry) => {
                const detail = detailOf(entry);
                return (
                  <tr key={entry.id}>
                    <td className="admNowrap admMutedCell" data-label="Time"><time dateTime={entry.createdAt} title={formatDateTime(entry.createdAt)}>{formatDateTime(entry.createdAt)}</time></td>
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
