"use client";

import Link from "next/link";
import { Suspense } from "react";

import { useAuth } from "../auth-context";
import { useAdmin } from "./_components/admin-context";
import { BarList, ChartCard, ChartLegend, TrendChart } from "./_components/charts";
import { BillingIcon, ChatIcon, ChevronIcon, CommunityIcon, FlagIcon, MegaphoneIcon, PulseIcon, SignupIcon } from "./_components/icons";
import { Avatar, Badge, Card, ErrorBanner, KpiCards, PageHeader, RangePicker, SkeletonRows, type KpiCardItem } from "./_components/ui";
import { canAccess } from "./_lib/access";
import { AUDIT_ACTIONS, describeAction, formatCount, formatDateTime, formatDuration, formatMoney, formatRelative, shortDate } from "./_lib/format";
import { SERIES, VIZ } from "./_lib/palette";
import { useRange } from "./_lib/range";
import type { ActivityResponse, AuditEntry, BillingOverview, Page, ReportStats, SystemStatus, TopCommunity } from "./_lib/types";
import { useAdminData } from "./_lib/use-admin-data";

function greeting(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function CommandCenter() {
  const { user } = useAuth();
  const { roles, overview, refreshOverview } = useAdmin();
  const isAdmin = canAccess(roles, "analytics");
  const handlesReports = canAccess(roles, "reports");
  const [range, setRange] = useRange(30);

  const activity = useAdminData<ActivityResponse>(isAdmin ? `/analytics/activity?days=${range}` : null);
  const billing = useAdminData<BillingOverview>(isAdmin ? "/billing/overview" : null);
  const reportStats = useAdminData<ReportStats>(handlesReports ? `/reports/stats?days=${range}` : null);
  const watchesCommunities = !isAdmin && canAccess(roles, "communities");
  const top = useAdminData<{ items: TopCommunity[] }>(watchesCommunities ? `/analytics/top-communities?days=${range}&limit=6` : null);
  const feed = useAdminData<Page<AuditEntry>>(isAdmin ? "/audit-logs?limit=6" : null);
  const system = useAdminData<SystemStatus>(isAdmin ? "/system" : null);

  const series = activity.data?.series ?? [];
  const current = activity.data?.current;
  const previous = activity.data?.previous;
  const usd = billing.data?.revenue.find((row) => row.currency === "USD") ?? billing.data?.revenue[0];

  const kpis: KpiCardItem[] = isAdmin
    ? [
        {
          label: "Avg. daily active users",
          value: current ? formatCount(Math.round(current.avgActiveUsers)) : undefined,
          change: current ? { current: current.avgActiveUsers, previous: previous?.avgActiveUsers } : undefined,
          hint: activity.data ? `${formatCount(activity.data.audience.mau)} active in the last 30 days` : undefined,
          icon: <PulseIcon />,
          tone: "blue",
          trend: { values: series.map((point) => point.activeUsers), color: SERIES.activeUsers.color },
          href: "/admin/analytics",
        },
        {
          label: "New sign-ups",
          value: current ? formatCount(current.signups) : undefined,
          change: current ? { current: current.signups, previous: previous?.signups } : undefined,
          hint: activity.data ? `${formatCount(activity.data.audience.totalUsers)} members in total` : undefined,
          icon: <SignupIcon />,
          tone: "amber",
          trend: { values: series.map((point) => point.signups), color: SERIES.signups.color },
          href: "/admin/users",
        },
        {
          label: "Posts and comments",
          value: current ? formatCount(current.posts + current.comments) : undefined,
          change: current ? { current: current.posts + current.comments, previous: previous ? previous.posts + previous.comments : undefined } : undefined,
          hint: current ? `${formatCount(current.posts)} posts · ${formatCount(current.comments)} comments` : undefined,
          icon: <ChatIcon />,
          tone: "green",
          trend: { values: series.map((point) => point.posts + point.comments), color: SERIES.posts.color },
          href: "/admin/analytics",
        },
        {
          label: "Monthly recurring revenue",
          value: usd ? formatMoney(usd.mrrMinor, usd.currency) : billing.data ? formatMoney(0) : undefined,
          hint: billing.data ? `${formatCount(billing.data.counts.paying)} paying · ${formatCount(billing.data.counts.trialing)} trialing` : undefined,
          icon: <BillingIcon />,
          tone: "violet",
          href: "/admin/billing",
        },
      ]
    : [
        ...(canAccess(roles, "reports") ? [{ label: "Open reports", value: overview ? formatCount(overview.reports.open) : undefined, hint: "Waiting for a decision", icon: <FlagIcon />, tone: "amber" as const, href: "/admin/reports" }] : []),
        ...(canAccess(roles, "communities") ? [{ label: "Flagged communities", value: overview ? formatCount(overview.communities.flagged) : undefined, hint: "With open reports", icon: <CommunityIcon />, tone: "red" as const, href: "/admin/communities?status=flagged" }] : []),
        ...(canAccess(roles, "campaigns") ? [{ label: "Campaign reviews", value: overview ? formatCount(overview.campaigns.pending) : undefined, hint: "Awaiting approval", icon: <MegaphoneIcon />, tone: "violet" as const, href: "/admin/campaigns" }] : []),
        ...(reportStats.data
          ? [{ label: `Reports closed (${range}d)`, value: formatCount(reportStats.data.closed), hint: reportStats.data.medianHoursToClose === null ? "No decisions yet" : `Median ${reportStats.data.medianHoursToClose.toFixed(1)} h to a decision`, icon: <PulseIcon />, tone: "green" as const }]
          : []),
      ];

  const queues = [
    { section: "reports" as const, label: "Reported content", detail: "Posts and comments waiting for a decision", value: overview?.reports.open, href: "/admin/reports", icon: <FlagIcon />, tone: "amber" as const },
    { section: "communities" as const, label: "Flagged communities", detail: "Communities with open reports", value: overview?.communities.flagged, href: "/admin/communities?status=flagged", icon: <CommunityIcon />, tone: "red" as const },
    { section: "campaigns" as const, label: "Campaign reviews", detail: "Sponsored promotions awaiting approval", value: overview?.campaigns.pending, href: "/admin/campaigns", icon: <MegaphoneIcon />, tone: "violet" as const },
  ].filter((queue) => canAccess(roles, queue.section));
  const waiting = queues.reduce((total, queue) => total + (queue.value ?? 0), 0);

  return (
    <>
      <PageHeader
        actions={
          <>
            {(isAdmin || handlesReports || watchesCommunities) && <RangePicker onChange={setRange} value={range} />}
            <button className="admBtn admBtnSecondary admBtnSm" onClick={() => { refreshOverview(); activity.reload(); billing.reload(); reportStats.reload(); feed.reload(); }} type="button">Refresh</button>
          </>
        }
        description={`${greeting(new Date().getHours())}, ${user?.displayName?.split(" ")[0] ?? "there"}. Here is how Spark is doing and what needs a decision.`}
        title="Overview"
      />

      <KpiCards items={kpis} label="Key numbers" />

      <div className="admGrid3">
        {isAdmin ? (
          <ChartCard
            error={activity.error}
            legend={<ChartLegend series={[SERIES.activeUsers, SERIES.signups]} />}
            loading={activity.loading && !activity.data}
            onRetry={activity.reload}
            subtitle={`Distinct members who signed in, posted or commented each day · last ${range} days (UTC)`}
            table={{ columns: ["Day", "Active users", "Sign-ups"], rows: series.map((point) => [shortDate(point.day), point.activeUsers, point.signups]) }}
            title="Platform activity"
            tone="blue"
          >
            <TrendChart data={series as unknown as Array<Record<string, unknown>>} series={[{ key: "activeUsers", ...SERIES.activeUsers }, { key: "signups", ...SERIES.signups }]} />
          </ChartCard>
        ) : (
          <Card subtitle="Your moderation queues and how fast they are moving." title="Moderation summary" tone="violet">
            {reportStats.data ? (
              <ul className="admStatList">
                <li><span>Reports opened ({range}d)</span><strong>{formatCount(reportStats.data.opened)}</strong></li>
                <li><span>Reports closed ({range}d)</span><strong>{formatCount(reportStats.data.closed)}</strong></li>
                <li><span>Backlog now</span><strong>{formatCount(reportStats.data.backlog)}</strong></li>
                <li><span>Median time to decision</span><strong>{reportStats.data.medianHoursToClose === null ? "–" : `${reportStats.data.medianHoursToClose.toFixed(1)} h`}</strong></li>
              </ul>
            ) : handlesReports ? <div className="admCardInset"><SkeletonRows rows={3} /></div> : <p className="admCardEmpty">Report statistics are available to content moderators.</p>}
          </Card>
        )}

        <Card subtitle={overview ? (waiting === 0 ? "All queues are clear." : `${waiting} ${waiting === 1 ? "item is" : "items are"} waiting.`) : "Loading your queues…"} title="Needs attention" tone="amber">
          <ul className="admQueueList">
            {queues.map((queue) => (
              <li key={queue.section}>
                <Link className="admQueueRow" href={queue.href}>
                  <span className={`admQueueIcon admTone-${queue.tone}`}>{queue.icon}</span>
                  <span className="admQueueText">
                    <strong>{queue.label}</strong>
                    <span>{queue.detail}</span>
                  </span>
                  {queue.value === undefined ? <span className="admQueueCount">–</span> : queue.value > 0 ? <Badge tone={queue.tone}>{queue.value} open</Badge> : <Badge tone="green">Clear</Badge>}
                  <ChevronIcon className="admQueueArrow" />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {watchesCommunities && (
        <Card subtitle={`Posts and comments in the last ${range} days`} title="Most active communities" tone="green">
          {top.error && <div className="admCardInset"><ErrorBanner message={top.error} onRetry={top.reload} /></div>}
          {!top.data && !top.error && <div className="admCardInset"><SkeletonRows rows={4} /></div>}
          {top.data && (
            <div className="admCardInset">
              <BarList
                color={VIZ.aqua}
                emptyText="No community activity in this period."
                items={top.data.items.map((item) => ({ key: item.id, label: <Link href={`/admin/communities/${item.id}`}>{item.name}</Link>, value: item.posts + item.comments, hint: `${formatCount(item.newMembers)} new members` }))}
              />
            </div>
          )}
        </Card>
      )}

      {isAdmin && (
        <div className="admGrid2">
          <ChartCard
            error={activity.error}
            legend={<ChartLegend series={[SERIES.posts, SERIES.comments]} />}
            loading={activity.loading && !activity.data}
            onRetry={activity.reload}
            subtitle="What members published each day"
            table={{ columns: ["Day", "Posts", "Comments"], rows: series.map((point) => [shortDate(point.day), point.posts, point.comments]) }}
            title="Content created"
            tone="blue"
          >
            <TrendChart data={series as unknown as Array<Record<string, unknown>>} height={220} kind="bar" series={[{ key: "posts", ...SERIES.posts }, { key: "comments", ...SERIES.comments }]} stacked />
          </ChartCard>
          <ChartCard
            error={activity.error}
            legend={<ChartLegend series={[SERIES.reportsOpened, SERIES.reportsClosed]} />}
            loading={activity.loading && !activity.data}
            onRetry={activity.reload}
            subtitle={reportStats.data ? `${formatCount(reportStats.data.backlog)} open now · median ${reportStats.data.medianHoursToClose === null ? "–" : `${reportStats.data.medianHoursToClose.toFixed(1)} h`} to a decision` : "Reports filed and closed each day"}
            table={{ columns: ["Day", "Opened", "Closed"], rows: series.map((point) => [shortDate(point.day), point.reportsOpened, point.reportsClosed]) }}
            title="Moderation flow"
            tone="violet"
          >
            <TrendChart data={series as unknown as Array<Record<string, unknown>>} height={220} kind="line" series={[{ key: "reportsOpened", ...SERIES.reportsOpened }, { key: "reportsClosed", ...SERIES.reportsClosed }]} />
          </ChartCard>
        </div>
      )}

      {isAdmin && (
        <div className="admGrid3">
          <Card actions={<Link className="admBtn admBtnSecondary admBtnSm" href="/admin/audit">View audit log</Link>} flush subtitle="The latest decisions by staff, with their reasons." title="Recent staff activity" tone="navy">
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
          <div className="admStack">
          <Card actions={<Link className="admBtn admBtnSecondary admBtnSm" href="/admin/billing">Open billing</Link>} subtitle="Subscription health right now." title="Revenue snapshot" tone="green">
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
          <Card actions={system.data ? <Badge tone="green">Operational</Badge> : undefined} subtitle={system.data ? `Checked ${formatRelative(system.data.checkedAt)}` : "Checking…"} title="API health" tone="blue">
            {system.error && <div className="admCardInset"><ErrorBanner message={system.error} onRetry={system.reload} /></div>}
            {system.data ? (
              <ul className="admStatList">
                <li><span>Active sessions</span><strong>{formatCount(system.data.activeSessions)}</strong></li>
                <li><span>API uptime</span><strong>{formatDuration(system.data.uptimeSeconds)}</strong></li>
                <li><span>Runtime</span><strong>Node.js {system.data.nodeVersion.replace(/^v/u, "")}</strong></li>
              </ul>
            ) : !system.error && <div className="admCardInset"><SkeletonRows rows={3} /></div>}
          </Card>
          </div>
        </div>
      )}
    </>
  );
}

export default function AdminOverviewPage() {
  return (
    <Suspense fallback={<SkeletonRows />}>
      <CommandCenter />
    </Suspense>
  );
}
