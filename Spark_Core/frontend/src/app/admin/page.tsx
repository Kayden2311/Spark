"use client";

import { Suspense } from "react";

import { useAuth } from "../auth-context";
import { useAdmin } from "./_components/admin-context";
import { Bento, Tile } from "./_components/bento";
import { ChartCard, ChartLegend, TrendChart } from "./_components/charts";
import { ApiHealthTile, NeedsAttentionTile, RevenueTile, StaffActivityTile, StickinessTile, adminTrendCards, moderatorTrendCards } from "./_components/overview-tiles";
import { TrendCards } from "./_components/trend-cards";
import { PageHeader, RangePicker, SkeletonRows } from "./_components/ui";
import { canRead } from "./_lib/access";
import { formatCount, shortDate } from "./_lib/format";
import { SERIES } from "./_lib/palette";
import { useRange } from "./_lib/range";
import type { ActivityResponse, AuditEntry, BillingOverview, MrrResponse, Page, ReportStats, SystemStatus } from "./_lib/types";
import { useAdminData } from "./_lib/use-admin-data";

function greeting(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

type Rows = Array<Record<string, unknown>>;

function CommandCenter() {
  const { user } = useAuth();
  const { roles, overview, overviewError, refreshOverview } = useAdmin();
  // Each read is requested, and its tile shown, only when the viewer's role can open that read.
  const analytics = canRead(roles, "analytics/activity");
  const systemAccess = canRead(roles, "system");
  const reports = canRead(roles, "reports/stats");
  const billingAccess = canRead(roles, "billing/overview") && canRead(roles, "billing/mrr");
  const audit = canRead(roles, "audit-logs");
  const [range, setRange] = useRange(30);

  const activity = useAdminData<ActivityResponse>(analytics ? `/analytics/activity?days=${range}` : null);
  const mrr = useAdminData<MrrResponse>(billingAccess ? "/billing/mrr?months=12" : null);
  const billing = useAdminData<BillingOverview>(billingAccess ? "/billing/overview" : null);
  const reportStats = useAdminData<ReportStats>(reports ? `/reports/stats?days=${range}` : null);
  const feed = useAdminData<Page<AuditEntry>>(audit ? "/audit-logs?limit=6" : null);
  const system = useAdminData<SystemStatus>(systemAccess ? "/system" : null);

  const series = activity.data?.series ?? [];
  const flow = reportStats.data?.series ?? [];
  const cards = analytics || billingAccess ? adminTrendCards({ roles, activity, mrr }) : moderatorTrendCards({ roles, overview, overviewError, reportStats });
  const activityLoading = activity.loading && !activity.data;
  // A series with nothing in it shows the tile's plain empty message, not bare axes or zero lines.
  const quiet = (keys: ReadonlyArray<keyof (typeof series)[number]>) => series.every((point) => keys.every((key) => point[key] === 0));
  const noActivity = activity.data !== null && quiet(["activeUsers", "signups"]);
  const noContent = activity.data !== null && quiet(["posts", "comments"]);
  const noReports = reportStats.data !== null && flow.every((point) => point.opened === 0 && point.closed === 0);
  const median = reportStats.data?.medianHoursToClose;

  const refresh = () => {
    refreshOverview();
    for (const read of [activity, mrr, billing, reportStats, feed, system]) read.reload();
  };

  return (
    <>
      <PageHeader
        actions={
          <>
            {(analytics || reports) && <RangePicker onChange={setRange} value={range} />}
            <button className="admBtn admBtnSecondary admBtnSm" onClick={refresh} type="button">Refresh</button>
          </>
        }
        description={`${greeting(new Date().getHours())}, ${user?.displayName?.split(" ")[0] ?? "there"}. Here is how Spark is doing and what needs a decision.`}
        title="Overview"
      />

      {cards.length > 0 && <TrendCards items={cards} label="Key numbers" />}

      <Bento label="Overview charts">
        {analytics && (
          <Tile span={8}>
            <ChartCard
              empty={noActivity}
              emptyText="No member activity in this period yet."
              error={activity.error}
              legend={<ChartLegend series={[SERIES.activeUsers, SERIES.signups]} />}
              loading={activityLoading}
              onRetry={activity.reload}
              subtitle={`Distinct members who signed in, posted or commented each day · last ${range} days (UTC)`}
              table={{ columns: ["Day", "Active users", "Sign-ups"], rows: series.map((point) => [shortDate(point.day), point.activeUsers, point.signups]) }}
              title="Platform activity"
            >
              <TrendChart data={series as unknown as Rows} series={[{ key: "activeUsers", ...SERIES.activeUsers }, { key: "signups", ...SERIES.signups }]} />
            </ChartCard>
          </Tile>
        )}
        {/* Without analytics, Needs attention and Moderation flow share a row (5 + 7), and half each on tablets. */}
        <Tile span={analytics ? 4 : reports ? 5 : 12} spanMd={analytics || !reports ? undefined : 6}>
          <NeedsAttentionTile error={overviewError} onRetry={refreshOverview} overview={overview} roles={roles} />
        </Tile>
        {analytics && (
          <Tile span={6}>
            <ChartCard
              empty={noContent}
              emptyText="No posts or comments in this period yet."
              error={activity.error}
              legend={<ChartLegend series={[SERIES.posts, SERIES.comments]} />}
              loading={activityLoading}
              onRetry={activity.reload}
              subtitle="What members published each day"
              table={{ columns: ["Day", "Posts", "Comments"], rows: series.map((point) => [shortDate(point.day), point.posts, point.comments]) }}
              title="Content created"
            >
              <TrendChart data={series as unknown as Rows} height={220} kind="bar" series={[{ key: "posts", ...SERIES.posts }, { key: "comments", ...SERIES.comments }]} stacked />
            </ChartCard>
          </Tile>
        )}
        {reports && (
          <Tile span={analytics ? 6 : 7} spanMd={6}>
            <ChartCard
              empty={noReports}
              emptyText="No reports opened or closed in this period yet."
              error={reportStats.error}
              legend={<ChartLegend series={[SERIES.reportsOpened, SERIES.reportsClosed]} />}
              loading={reportStats.loading && !reportStats.data}
              onRetry={reportStats.reload}
              subtitle={reportStats.data ? `${formatCount(reportStats.data.backlog)} open now · median ${median === null || median === undefined ? "–" : `${median.toFixed(1)} h`} to a decision` : "Reports filed and closed each day"}
              table={{ columns: ["Day", "Opened", "Closed", "Open at day end"], rows: flow.map((point) => [shortDate(point.day), point.opened, point.closed, point.backlog]) }}
              title="Moderation flow"
            >
              <TrendChart data={flow as unknown as Rows} height={220} kind="line" series={[{ key: "opened", ...SERIES.reportsOpened }, { key: "closed", ...SERIES.reportsClosed }]} />
            </ChartCard>
          </Tile>
        )}
        {audit && (
          <Tile rowSpan={2} span={6}>
            <StaffActivityTile feed={feed} />
          </Tile>
        )}
        {analytics && (
          <Tile span={3}>
            <StickinessTile activity={activity} />
          </Tile>
        )}
        {systemAccess && (
          <Tile span={3}>
            <ApiHealthTile system={system} />
          </Tile>
        )}
        {billingAccess && (
          <Tile span={6}>
            <RevenueTile billing={billing} />
          </Tile>
        )}
      </Bento>
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
