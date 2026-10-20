"use client";

import Link from "next/link";

import { Bento, Tile } from "../_components/bento";
import { BarList, ChartCard, ChartLegend, CohortGrid, TrendChart } from "../_components/charts";
import { EngagementHeatmapCard } from "../_components/engagement-heatmap";
import { valueOf } from "../_components/overview-tiles";
import { TrendCards, type TrendCardItem } from "../_components/trend-cards";
import { RangePicker, Segmented } from "../_components/ui";
import { formatCount, shortDate } from "../_lib/format";
import { SERIES, VIZ } from "../_lib/palette";
import { useRange } from "../_lib/range";
import type { ActivityResponse, EngagementResponse, RetentionResponse, TopCommunity } from "../_lib/types";
import { useAdminData } from "../_lib/use-admin-data";
import { useQueryState } from "../_lib/use-query-state";

const RETENTION_WEEKS = 8;
type Rank = "activity" | "growth";
type Rows = Array<Record<string, unknown>>;

/** Who is active, when they show up, whether they come back, and which communities drive it. */
export function EngagementPanel() {
  const [range, setRange] = useRange(30);
  const [rank, setRank] = useQueryState<Rank>("rank", "activity", ["activity", "growth"]);

  // Each tile has its own read, so one slow read never holds up the others.
  const activity = useAdminData<ActivityResponse>(`/analytics/activity?days=${range}`);
  const engagement = useAdminData<EngagementResponse>(`/analytics/engagement?days=${range}`);
  const top = useAdminData<{ items: TopCommunity[] }>(`/analytics/top-communities?days=${range}&limit=6`);
  const retention = useAdminData<RetentionResponse>(`/analytics/retention?weeks=${RETENTION_WEEKS}`);

  const series = activity.data?.series ?? [];
  const current = activity.data?.current;
  const previous = activity.data?.previous ?? null;
  const cohorts = retention.data?.cohorts ?? [];
  const cohortWidth = Math.max(0, ...cohorts.map((cohort) => cohort.retained.length));
  const ranked = [...(top.data?.items ?? [])]
    .sort((a, b) => (rank === "growth" ? b.newMembers - a.newMembers : b.posts + b.comments - (a.posts + a.comments)));

  // Audience counts are point-in-time figures with no history of their own, so WAU and MAU carry no
  // sparkline. DAU uses the daily active-user series, whose last point is today.
  const cards: TrendCardItem[] = [
    { label: "Active today", value: valueOf(activity, (data) => formatCount(data.audience.dau)), dot: SERIES.activeUsers.color, color: SERIES.activeUsers.color, series: series.map((point) => point.activeUsers) },
    { label: "Active this week", value: valueOf(activity, (data) => formatCount(data.audience.wau)), dot: VIZ.violet, color: VIZ.violet },
    { label: "Active this month", value: valueOf(activity, (data) => formatCount(data.audience.mau)), dot: VIZ.aqua, color: VIZ.aqua },
    {
      label: "Sign-ups",
      value: valueOf(activity, (data) => formatCount(data.current.signups)),
      dot: SERIES.signups.color,
      color: SERIES.signups.color,
      change: current ? { current: current.signups, previous: previous ? previous.signups : null } : undefined,
      series: series.map((point) => point.signups),
      href: "/admin/users",
    },
  ];

  return (
    <>
      <div className="admToolbar"><RangePicker onChange={setRange} value={range} /></div>
      <TrendCards items={cards} label="Engagement numbers" />

      <Bento label="Engagement charts">
        <Tile span={8}>
          <EngagementHeatmapCard engagement={engagement} subtitle="Sign-ins, posts and comments by weekday and hour (UTC). Use it to schedule announcements and moderation cover." />
        </Tile>
        <Tile span={4}>
          <ChartCard
            actions={<Segmented label="Rank communities by" onChange={setRank} options={[{ value: "activity", label: "Activity" }, { value: "growth", label: "New members" }]} value={rank} />}
            empty={top.data?.items.length === 0}
            emptyText="No community activity in this period."
            error={top.error}
            height={200}
            loading={top.loading && !top.data}
            onRetry={top.reload}
            subtitle={rank === "growth" ? `New members, last ${range} days` : `Posts and comments, last ${range} days`}
            table={{ columns: ["Community", "Posts", "Comments", "New members", "Contributors"], rows: ranked.map((item) => [item.name, item.posts, item.comments, item.newMembers, item.contributors]) }}
            title="Top communities"
          >
            <BarList
              color={rank === "growth" ? SERIES.newMembers.color : VIZ.aqua}
              items={ranked.map((item) => ({
                key: item.id,
                label: <Link href={`/admin/communities/${item.id}`}>{item.name}</Link>,
                value: rank === "growth" ? item.newMembers : item.posts + item.comments,
                hint: `${formatCount(item.contributors)} contributors`,
              }))}
            />
          </ChartCard>
        </Tile>
        <Tile span={12}>
          <ChartCard
            empty={retention.data !== null && cohorts.length === 0}
            emptyText={`No sign-up cohorts in the last ${RETENTION_WEEKS} weeks yet.`}
            error={retention.error}
            height={180}
            loading={retention.loading && !retention.data}
            onRetry={retention.reload}
            subtitle={`Members who signed up each week, and the share still active in each week after, last ${RETENTION_WEEKS} weeks`}
            table={{
              columns: ["Cohort", "Members", ...Array.from({ length: cohortWidth }, (_, index) => (index === 0 ? "Week 0" : `Week ${index}`))],
              rows: cohorts.map((cohort) => [shortDate(cohort.week), cohort.size, ...Array.from({ length: cohortWidth }, (_, index) => cohort.retained[index] ?? "–")]),
            }}
            title="Retention cohorts"
          >
            <CohortGrid cohorts={cohorts} />
          </ChartCard>
        </Tile>
        <Tile span={12}>
          <ChartCard
            empty={activity.data !== null && series.every((point) => point.activeUsers === 0 && point.signups === 0)}
            emptyText="No member activity in this period yet."
            error={activity.error}
            legend={<ChartLegend series={[SERIES.activeUsers, SERIES.signups]} />}
            loading={activity.loading && !activity.data}
            onRetry={activity.reload}
            subtitle={current ? `${formatCount(Math.round(current.avgActiveUsers))} active on an average day · ${formatCount(current.signIns)} sign-ins · last ${range} days (UTC)` : "Members active and new sign-ups each day"}
            table={{ columns: ["Day", "Active users", "Sign-ups", "Sign-ins"], rows: series.map((point) => [shortDate(point.day), point.activeUsers, point.signups, point.signIns]) }}
            title="Activity trend"
          >
            <TrendChart data={series as unknown as Rows} series={[{ key: "activeUsers", ...SERIES.activeUsers }, { key: "signups", ...SERIES.signups }]} />
          </ChartCard>
        </Tile>
      </Bento>
    </>
  );
}
