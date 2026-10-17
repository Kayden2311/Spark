"use client";

import Link from "next/link";
import { Suspense } from "react";

import { useAdmin } from "../_components/admin-context";
import { Badge, EmptyState, ErrorBanner, LoadMore, NoAccess, PageHeader, SkeletonRows } from "../_components/ui";
import { query } from "../_lib/api";
import { canAccess } from "../_lib/access";
import { AUDIT_ACTIONS, describeAction, formatDateTime, formatRelative, humanize } from "../_lib/format";
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
      <PageHeader eyebrow="Administration" title="Audit log" description="Every governance action, who took it and why. Entries are permanent and cannot be edited." />

      <div className="admFilters" role="group" aria-label="Filter the audit log">
        <label className="admSelect admLabeled">
          <span>Action</span>
          <select onChange={(event) => setAction(event.target.value as "any" | AuditAction)} value={action}>
            <option value="any">Any action</option>
            {ACTIONS.map((value) => <option key={value} value={value}>{AUDIT_ACTIONS[value].label}</option>)}
          </select>
        </label>
        <label className="admSelect admLabeled">
          <span>Target</span>
          <select onChange={(event) => setTarget(event.target.value as TargetFilter)} value={target}>
            <option value="any">Anything</option>
            {TARGETS.map((value) => <option key={value} value={value}>{humanize(value)}s</option>)}
          </select>
        </label>
        <label className="admDate admLabeled">
          <span>From</span>
          <input max={to || undefined} onChange={(event) => setFrom(event.target.value)} type="date" value={from} />
        </label>
        <label className="admDate admLabeled">
          <span>To</span>
          <input min={from || undefined} onChange={(event) => setTo(event.target.value)} type="date" value={to} />
        </label>
        {filtered && <button className="admBtn admBtnGhost admBtnSm" onClick={clear} type="button">Clear filters</button>}
      </div>

      {invalidRange && <ErrorBanner message="The start date must be on or before the end date." />}
      {list.error && <ErrorBanner message={list.error} onRetry={list.reload} />}
      {list.loading ? (
        <SkeletonRows />
      ) : list.items.length === 0 && !list.error && !invalidRange ? (
        <EmptyState title={filtered ? "No entries match these filters" : "No governance actions yet"}>
          {filtered ? "Try a wider date range or a different action." : "Actions taken in this console are recorded here automatically."}
        </EmptyState>
      ) : (
        <div className="admTableCard">
          <table className="admTable">
            <thead>
              <tr>
                <th scope="col">When</th>
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
                    <td className="admNowrap" data-label="When"><time dateTime={entry.createdAt} title={formatDateTime(entry.createdAt)}>{formatRelative(entry.createdAt)}</time></td>
                    <td data-label="Action">
                      <Badge tone={AUDIT_ACTIONS[entry.action]?.tone ?? "neutral"}>{describeAction(entry)}</Badge>
                      {detail && <span className="admCellSub admBlock">{detail}</span>}
                    </td>
                    <td data-label="Target">
                      {entry.target.type === "user" && canAccess(roles, "users")
                        ? <Link className="admTextLink" href={`/admin/users/${entry.target.id}`}>{entry.target.label}</Link>
                        : entry.target.label}
                      <span className="admCellSub admBlock">{humanize(entry.target.type)}</span>
                    </td>
                    <td data-label="Staff">{entry.actor.displayName}</td>
                    <td className="admReasonCell" data-label="Reason">{entry.reason}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!list.loading && <LoadMore hasMore={list.hasMore} loading={list.loadingMore} onClick={() => void list.loadMore()} shown={list.items.length} />}
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
