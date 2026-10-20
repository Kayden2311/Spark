"use client";

import Link from "next/link";

import { canAccess } from "../_lib/access";
import { AUDIT_ACTIONS, describeAction, formatCount, formatDateTime, formatDuration, formatMoney, formatRelative } from "../_lib/format";
import { SERIES, VIZ } from "../_lib/palette";
import type { ActivityResponse, AuditEntry, BillingOverview, MrrResponse, Overview, Page, ReportStats, SystemStatus } from "../_lib/types";
import { BarList, ChartCard, Gauge } from "./charts";
import { Avatar, Badge, Card, ErrorBanner, SkeletonRows } from "./ui";
import type { TrendCardItem } from "./trend-cards";

/** The read state each tile needs (a subset of what `useAdminData` returns). */
export interface Read<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** A failed read with nothing to show reads "–" instead of a skeleton that never ends. */
function valueOf<T>(read: Read<T>, format: (data: T) => string): string | undefined {
  if (read.data) return format(read.data);
  return read.error ? "–" : undefined;
}

/** The currency the MRR card reports: USD when there is USD revenue, otherwise the first one. */
function mrrMonths(mrr: MrrResponse | null) {
  const series = mrr?.series ?? [];
  const currency = series.some((point) => point.currency === "USD") ? "USD" : (series[0]?.currency ?? "USD");
  const months = series.filter((point) => point.currency === currency);
  // Start at the month before the first paid activity instead of a run of empty months (as Billing does).
  const firstActive = months.findIndex((point) => point.mrrMinor > 0 || point.newPaid > 0 || point.churned > 0);
  return { currency, months: firstActive <= 0 ? months : months.slice(firstActive - 1) };
}

/** Admins: platform activity and revenue. Each card is built only from a read the viewer's role can open. */
export function adminTrendCards({ roles, activity, mrr }: { roles: readonly string[]; activity: Read<ActivityResponse>; mrr: Read<MrrResponse> }): TrendCardItem[] {
  const items: TrendCardItem[] = [];
  if (canAccess(roles, "analytics")) {
    const series = activity.data?.series ?? [];
    const current = activity.data?.current;
    const previous = activity.data?.previous ?? null;
    items.push(
      {
        label: "Avg. daily users",
        value: valueOf(activity, (data) => formatCount(Math.round(data.current.avgActiveUsers))),
        dot: SERIES.activeUsers.color,
        color: SERIES.activeUsers.color,
        change: current ? { current: current.avgActiveUsers, previous: previous ? previous.avgActiveUsers : null } : undefined,
        series: series.map((point) => point.activeUsers),
        href: "/admin/analytics",
      },
      {
        label: "New sign-ups",
        value: valueOf(activity, (data) => formatCount(data.current.signups)),
        dot: SERIES.signups.color,
        color: SERIES.signups.color,
        change: current ? { current: current.signups, previous: previous ? previous.signups : null } : undefined,
        series: series.map((point) => point.signups),
        href: "/admin/users",
      },
      {
        label: "Posts, comments",
        value: valueOf(activity, (data) => formatCount(data.current.posts + data.current.comments)),
        dot: SERIES.posts.color,
        color: SERIES.posts.color,
        change: current ? { current: current.posts + current.comments, previous: previous ? previous.posts + previous.comments : null } : undefined,
        series: series.map((point) => point.posts + point.comments),
        href: "/admin/analytics",
      },
    );
  }
  if (canAccess(roles, "billing")) {
    const { currency, months } = mrrMonths(mrr.data);
    const last = months[months.length - 1];
    const before = months[months.length - 2];
    items.push({
      label: "MRR",
      value: valueOf(mrr, () => formatMoney(last?.mrrMinor ?? 0, currency)),
      dot: SERIES.mrr.color,
      color: SERIES.mrr.color,
      change: last ? { current: last.mrrMinor, previous: before ? before.mrrMinor : null } : undefined,
      series: months.map((point) => point.mrrMinor),
      href: "/admin/billing",
    });
  }
  return items;
}

/** Moderators without analytics: their queues. Queue counts have no history, so they carry no sparkline. */
export function moderatorTrendCards({ roles, overview, reportStats }: { roles: readonly string[]; overview: Overview | null; reportStats: Read<ReportStats> }): TrendCardItem[] {
  const items: TrendCardItem[] = [];
  const count = (value: number | undefined) => (value === undefined ? undefined : formatCount(value));
  if (canAccess(roles, "reports")) {
    items.push(
      {
        label: "Open reports",
        value: count(overview?.reports.open),
        dot: SERIES.reportsOpened.color,
        color: SERIES.reportsOpened.color,
        series: reportStats.data?.series.map((point) => point.backlog),
        href: "/admin/reports",
        valueTone: (overview?.reports.open ?? 0) > 0 ? "bad" : "default",
      },
      {
        label: "Reports closed",
        value: valueOf(reportStats, (data) => formatCount(data.closed)),
        dot: SERIES.reportsClosed.color,
        color: SERIES.reportsClosed.color,
        series: reportStats.data?.series.map((point) => point.closed),
      },
    );
  }
  if (canAccess(roles, "communities")) {
    items.push({ label: "Flagged communities", value: count(overview?.communities.flagged), dot: VIZ.orange, color: VIZ.orange, href: "/admin/communities?status=flagged", valueTone: (overview?.communities.flagged ?? 0) > 0 ? "bad" : "default" });
  }
  if (canAccess(roles, "campaigns")) {
    items.push({ label: "Campaign reviews", value: count(overview?.campaigns.pending), dot: VIZ.violet, color: VIZ.violet, href: "/admin/campaigns" });
  }
  return items;
}

/** A status colour, not a series colour: queue size is not a metric charted elsewhere. */
const STATUS_AMBER = "#d97706";

const QUEUES = [
  { section: "reports", label: "Reported content", href: "/admin/reports", value: (overview: Overview) => overview.reports.open },
  { section: "communities", label: "Flagged communities", href: "/admin/communities?status=flagged", value: (overview: Overview) => overview.communities.flagged },
  { section: "campaigns", label: "Campaign reviews", href: "/admin/campaigns", value: (overview: Overview) => overview.campaigns.pending },
] as const;

/** Every queue the viewer works, as ranked bars that link to the queue. Counts come from `/admin/overview`. */
export function NeedsAttentionTile({ roles, overview, onRetry }: { roles: readonly string[]; overview: Overview | null; onRetry: () => void }) {
  const queues = QUEUES.filter((queue) => canAccess(roles, queue.section));
  if (queues.length === 0) return null;
  const rows = overview ? queues.map((queue) => ({ ...queue, count: queue.value(overview) })) : [];
  const waiting = rows.reduce((total, row) => total + row.count, 0);
  return (
    <ChartCard
      height={120}
      loading={!overview}
      onRetry={onRetry}
      subtitle={!overview ? "Loading your queues…" : waiting === 0 ? "All queues are clear." : `${waiting} ${waiting === 1 ? "item is" : "items are"} waiting.`}
      table={{ columns: ["Queue", "Waiting"], rows: rows.map((row) => [row.label, row.count]) }}
      title="Needs attention"
    >
      <BarList
        color={STATUS_AMBER}
        items={rows.map((row) => ({ key: row.section, label: <Link href={row.href}>{row.label}</Link>, value: row.count }))}
      />
    </ChartCard>
  );
}

/** DAU / MAU: the share of this month's active members who were also active today. */
export function StickinessTile({ activity }: { activity: Read<ActivityResponse> }) {
  const audience = activity.data?.audience;
  const ratio = audience && audience.mau > 0 ? audience.dau / audience.mau : 0;
  // One decimal below 10%, so a small but real share does not read as "0%".
  const percent = `${(ratio * 100).toFixed(ratio > 0 && ratio < 0.1 ? 1 : 0)}%`;
  return (
    <ChartCard
      empty={audience !== undefined && audience.mau === 0}
      emptyText="No active members in the last 30 days yet."
      error={activity.error}
      height={150}
      loading={activity.loading && !activity.data}
      onRetry={activity.reload}
      subtitle="Members active today, out of those active in the last 30 days"
      table={audience ? { columns: ["Measure", "Value"], rows: [["Active today", audience.dau], ["Active in the last 30 days", audience.mau], ["Stickiness (DAU / MAU)", percent]] } : undefined}
      title="Audience stickiness"
    >
      {audience && (
        <div className="admStickiness">
          <div aria-label={`Stickiness ${percent}: ${formatCount(audience.dau)} daily of ${formatCount(audience.mau)} monthly active members`} role="img">
            <Gauge ratio={ratio} size={128} thickness={12} tone={SERIES.activeUsers.color} valueText={percent} />
          </div>
          <p aria-hidden="true">
            <strong>{formatCount(audience.dau)}</strong> today · <strong>{formatCount(audience.mau)}</strong> this month
          </p>
        </div>
      )}
    </ChartCard>
  );
}

export function StaffActivityTile({ feed }: { feed: Read<Page<AuditEntry>> }) {
  return (
    <Card actions={<Link className="admBtn admBtnSecondary admBtnSm" href="/admin/audit">View audit log</Link>} flush subtitle="The latest decisions by staff, with their reasons." title="Recent staff activity">
      {feed.error && <div className="admCardInset"><ErrorBanner message={feed.error} onRetry={feed.reload} /></div>}
      {!feed.data && !feed.error && <div className="admCardInset"><SkeletonRows rows={4} /></div>}
      {feed.data && feed.data.items.length === 0 && <p className="admCardEmpty">No governance actions yet. Every action you take will appear here.</p>}
      {feed.data && feed.data.items.length > 0 && (
        <ul className="admActivity">
          {feed.data.items.map((entry) => (
            <li key={entry.id}>
              <Avatar name={entry.actor.displayName} size="sm" />
              <div className="admActivityText">
                <p><strong>{entry.actor.displayName}</strong> {describeAction(entry).toLowerCase()} <strong>{entry.target.label}</strong></p>
                <p className="admActivityReason">{entry.reason}</p>
              </div>
              <span className={`admActivityKind admTone-${AUDIT_ACTIONS[entry.action]?.tone ?? "neutral"}`}>{entry.target.type}</span>
              <time dateTime={entry.createdAt} title={formatDateTime(entry.createdAt)}>{formatRelative(entry.createdAt)}</time>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function RevenueTile({ billing }: { billing: Read<BillingOverview> }) {
  const usd = billing.data?.revenue.find((row) => row.currency === "USD") ?? billing.data?.revenue[0];
  return (
    <Card actions={<Link className="admBtn admBtnSecondary admBtnSm" href="/admin/billing">Open billing</Link>} subtitle="Subscription health right now." title="Revenue snapshot">
      {billing.error && <div className="admCardInset"><ErrorBanner message={billing.error} onRetry={billing.reload} /></div>}
      {!billing.data && !billing.error && <div className="admCardInset"><SkeletonRows rows={4} /></div>}
      {billing.data && (
        <ul className="admStatList">
          <li><span>Annual run rate</span><strong>{usd ? formatMoney(usd.arrMinor, usd.currency) : formatMoney(0)}</strong></li>
          <li><span>Collected, last 30 days</span><strong>{usd ? formatMoney(usd.collected30dMinor, usd.currency) : formatMoney(0)}</strong></li>
          <li><span>New paid, last 30 days</span><strong>{formatCount(billing.data.counts.newPaid30d)}</strong></li>
          <li><span>Past due</span>{billing.data.counts.pastDue > 0 ? <Badge tone="red">{billing.data.counts.pastDue} past due</Badge> : <Badge tone="green">None</Badge>}</li>
          <li><span>Failed payments, 30 days</span><strong>{formatCount(billing.data.counts.failedPayments30d)}</strong></li>
        </ul>
      )}
    </Card>
  );
}

export function ApiHealthTile({ system }: { system: Read<SystemStatus> }) {
  return (
    <Card actions={system.data ? <Badge tone="green">Operational</Badge> : undefined} subtitle={system.data ? `Checked ${formatRelative(system.data.checkedAt)}` : "Checking…"} title="API health">
      {system.error && <div className="admCardInset"><ErrorBanner message={system.error} onRetry={system.reload} /></div>}
      {system.data ? (
        <ul className="admStatList">
          <li><span>Active sessions</span><strong>{formatCount(system.data.activeSessions)}</strong></li>
          <li><span>API uptime</span><strong>{formatDuration(system.data.uptimeSeconds)}</strong></li>
          <li><span>Runtime</span><strong>Node.js {system.data.nodeVersion.replace(/^v/u, "")}</strong></li>
        </ul>
      ) : !system.error && <div className="admCardInset"><SkeletonRows rows={3} /></div>}
    </Card>
  );
}
