"use client";

import Link from "next/link";
import { Suspense } from "react";

import { useAdmin } from "../_components/admin-context";
import { BarList, ChartCard, ChartLegend, ContributionCalendar, Heatmap, TrendChart } from "../_components/charts";
import { PulseIcon, SignupIcon, TrendIcon, UserIcon } from "../_components/icons";
import { ErrorBanner, KpiCards, NoAccess, PageHeader, RangePicker, Segmented, SkeletonRows } from "../_components/ui";
import { canAccess } from "../_lib/access";
import { formatCount, formatPercent, shortDate } from "../_lib/format";
import { SERIES, VIZ } from "../_lib/palette";
import { useRange } from "../_lib/range";
import type { ActivityResponse, EngagementResponse, TopCommunity } from "../_lib/types";
import { useAdminData } from "../_lib/use-admin-data";
import { useQueryState } from "../_lib/use-query-state";
import { SystemHealthPanel } from "./system-health";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
type Rank = "activity" | "growth";
type View = "health" | "engagement";

function Analytics() {
  const { roles } = useAdmin();
  const allowed = canAccess(roles, "analytics");
  const [view, setView] = useQueryState<View>("view", "health", ["health", "engagement"]);
  if (!allowed) return <NoAccess />;
  return (
    <>
      <PageHeader
        actions={<Segmented label="Analytics view" onChange={setView} options={[{ value: "health", label: "System health" }, { value: "engagement", label: "Engagement" }]} value={view} />}
        description={view === "health"
          ? "Is Spark up and fast? Live checks for the API, database and Redis, with traffic, errors and response times."
          : "Who is active, when they show up, and which communities drive it."}
        title="Analytics"
      />
      {view === "health" ? <SystemHealthPanel /> : <Engagement />}
    </>
  );
}

function Engagement() {
  const [range, setRange] = useRange(30);
  const [rank, setRank] = useQueryState<Rank>("rank", "activity", ["activity", "growth"]);

  const activity = useAdminData<ActivityResponse>(`/analytics/activity?days=${range}`);
  const engagement = useAdminData<EngagementResponse>(`/analytics/engagement?days=${range}`);
  const top = useAdminData<{ items: TopCommunity[] }>(`/analytics/top-communities?days=${range}&limit=8`);

  const series = activity.data?.series ?? [];
  const audience = activity.data?.audience;
  const current = activity.data?.current;
  const stickiness = audience && audience.mau > 0 ? audience.dau / audience.mau : 0;
  const ranked = [...(top.data?.items ?? [])]
    .sort((a, b) => (rank === "growth" ? b.newMembers - a.newMembers : b.posts + b.comments - (a.posts + a.comments)));

  return (
    <>
      <div className="admToolbar"><RangePicker onChange={setRange} value={range} /></div>

      {activity.error && <ErrorBanner message={activity.error} onRetry={activity.reload} />}
      <KpiCards
        items={[
          { label: "Active today", value: audience ? formatCount(audience.dau) : undefined, hint: "Signed in, posted or commented (UTC day)", icon: <PulseIcon />, tone: "blue", trend: { values: series.map((point) => point.activeUsers), color: SERIES.activeUsers.color } },
          { label: "Active this week", value: audience ? formatCount(audience.wau) : undefined, hint: audience ? `${formatPercent(audience.totalUsers ? audience.wau / audience.totalUsers : 0)} of all members` : undefined, icon: <UserIcon />, tone: "violet" },
          { label: "Active this month", value: audience ? formatCount(audience.mau) : undefined, hint: audience ? `${formatCount(audience.totalUsers)} members in total` : undefined, icon: <TrendIcon />, tone: "green" },
          {
            label: "Stickiness (DAU ÷ MAU)",
            value: audience ? formatPercent(stickiness) : undefined,
            hint: "How many monthly users come back daily",
            icon: <SignupIcon />,
            tone: "amber",
          },
        ]}
        label="Audience"
      />

      <div className="admGrid2">
        <ChartCard
          error={activity.error}
          loading={activity.loading && !activity.data}
          onRetry={activity.reload}
          subtitle={current ? `${formatCount(Math.round(current.avgActiveUsers))} on an average day · ${formatCount(current.signIns)} sign-ins` : "Members active each day"}
          table={{ columns: ["Day", "Active users", "Sign-ins"], rows: series.map((point) => [shortDate(point.day), point.activeUsers, point.signIns]) }}
          title="Daily active users"
        >
          <TrendChart data={series as unknown as Array<Record<string, unknown>>} series={[{ key: "activeUsers", ...SERIES.activeUsers }]} />
        </ChartCard>
        <ChartCard
          error={activity.error}
          loading={activity.loading && !activity.data}
          onRetry={activity.reload}
          subtitle={current ? `${formatCount(current.signups)} new members in ${range} days` : "New accounts each day"}
          table={{ columns: ["Day", "Sign-ups"], rows: series.map((point) => [shortDate(point.day), point.signups]) }}
          title="Sign-ups"
        >
          <TrendChart data={series as unknown as Array<Record<string, unknown>>} kind="bar" series={[{ key: "signups", ...SERIES.signups }]} />
        </ChartCard>
      </div>

      <ChartCard
        empty={series.every((point) => point.activeUsers === 0)}
        error={activity.error}
        height={series.length > 0 ? undefined : 160}
        loading={activity.loading && !activity.data}
        onRetry={activity.reload}
        subtitle={`Active members per day, ${range} days · darker means busier, like a commit calendar`}
        table={{ columns: ["Day", "Active users"], rows: series.map((point) => [shortDate(point.day), point.activeUsers]) }}
        title="Activity calendar"
      >
        <ContributionCalendar data={series.map((point) => ({ day: point.day, value: point.activeUsers }))} unit="active members" />
      </ChartCard>

      <ChartCard
        empty={engagement.data?.cells.every((cell) => cell.events === 0)}
        error={engagement.error}
        height={240}
        loading={engagement.loading && !engagement.data}
        onRetry={engagement.reload}
        subtitle="Sign-ins, posts and comments by weekday and hour (UTC). Use it to schedule announcements and moderation cover."
        table={{
          columns: ["Day", ...Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}h`)],
          rows: DAYS.map((day, index) => [day, ...Array.from({ length: 24 }, (_, hour) => engagement.data?.cells.find((cell) => cell.dow === index + 1 && cell.hour === hour)?.events ?? 0)]),
        }}
        title="When members are active"
      >
        <Heatmap cells={engagement.data?.cells ?? []} />
      </ChartCard>

        <ChartCard
          actions={<Segmented label="Rank communities by" onChange={setRank} options={[{ value: "activity", label: "Activity" }, { value: "growth", label: "New members" }]} value={rank} />}
          empty={top.data?.items.length === 0}
          emptyText="No community activity in this period."
          error={top.error}
          height={200}
          legend={<ChartLegend series={[rank === "growth" ? SERIES.newMembers : { label: "Posts and comments", color: VIZ.aqua }]} />}
          loading={top.loading && !top.data}
          onRetry={top.reload}
          subtitle={`The communities driving Spark over the last ${range} days`}
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
    </>
  );
}

export default function AnalyticsPage() {
  return (
    <Suspense fallback={<SkeletonRows />}>
      <Analytics />
    </Suspense>
  );
}
