"use client";

import Link from "next/link";
import { useEffect } from "react";

import { useAdmin } from "../_components/admin-context";
import { Bento, Tile } from "../_components/bento";
import { BarList, ChartCard, DonutChart, Gauge } from "../_components/charts";
import { EngagementHeatmapCard } from "../_components/engagement-heatmap";
import { valueOf, type Read } from "../_components/overview-tiles";
import { TrendCards, type TrendCardItem } from "../_components/trend-cards";
import type { RangeDays } from "../_components/ui";
import { canAccess } from "../_lib/access";
import { formatCount } from "../_lib/format";
import { SERIES, VIZ } from "../_lib/palette";
import type { ActivityResponse, CommunityHealthCounts, CommunityStats, EngagementResponse, Overview, ReportStats, TopCommunity } from "../_lib/types";
import { useAdminData } from "../_lib/use-admin-data";

/** The periods `/admin/communities/stats` accepts. */
export const COMMUNITY_RANGES = [7, 30, 90] as const satisfies readonly RangeDays[];

/**
 * The health groups in display order: the server's count key, the SQL column name, the `healthOf`
 * label the table badges use, and one categorical colour each (never relied on alone: legend and table).
 */
export const HEALTH_GROUPS: ReadonlyArray<{ key: keyof CommunityHealthCounts; sqlKey: string; label: string; words: string; color: string }> = [
  { key: "growing", sqlKey: "growing", label: "Growing", words: "growing", color: VIZ.aqua },
  { key: "steady", sqlKey: "steady", label: "Steady", words: "steady", color: VIZ.blue },
  { key: "slowing", sqlKey: "slowing", label: "Slowing", words: "slowing", color: VIZ.yellow },
  { key: "quiet", sqlKey: "quiet", label: "Quiet", words: "quiet", color: VIZ.violet },
  { key: "needsReview", sqlKey: "needs_review", label: "Needs review", words: "need review", color: VIZ.magenta },
  { key: "archived", sqlKey: "archived", label: "Archived", words: "archived", color: "#94a3b8" },
];

function plural(count: number, one: string, many: string): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/** Trend cards, each built only from a read the viewer's role can open. */
function communityCards({ roles, overview, overviewError, stats, activity, reportStats }: {
  roles: readonly string[];
  overview: Overview | null;
  overviewError: string | null;
  stats: Read<CommunityStats>;
  activity: Read<ActivityResponse>;
  reportStats: Read<ReportStats>;
}): TrendCardItem[] {
  const data = stats.data;
  // The live count per day is only drawn when the server could rebuild every day of it; otherwise the
  // card shows today's count from the overview and no sparkline (no guessed history).
  const liveSeries = data && data.series.length > 0 && data.series.every((point) => point.liveCommunities !== null) ? data.series.map((point) => point.liveCommunities as number) : undefined;
  const liveValue = liveSeries ? formatCount(liveSeries[liveSeries.length - 1]!) : overview ? formatCount(overview.communities.active) : overviewError ? "–" : undefined;
  const items: TrendCardItem[] = [
    {
      label: "Live communities",
      value: liveValue,
      dot: VIZ.blue,
      color: VIZ.blue,
      series: liveSeries,
      change: data ? { current: data.current.newCommunities, previous: data.previous.newCommunities, subject: { short: "new", long: "new communities" } } : undefined,
    },
    {
      label: "New members",
      value: valueOf(stats, (value) => formatCount(value.current.newMembers)),
      dot: SERIES.newMembers.color,
      color: SERIES.newMembers.color,
      series: data?.series.map((point) => point.newMembers),
      change: data ? { current: data.current.newMembers, previous: data.previous.newMembers } : undefined,
    },
  ];
  if (canAccess(roles, "analytics")) {
    const current = activity.data?.current;
    const previous = activity.data?.previous;
    items.push({
      label: "Posts & comments",
      value: valueOf(activity, (value) => formatCount(value.current.posts + value.current.comments)),
      dot: SERIES.posts.color,
      color: SERIES.posts.color,
      series: activity.data?.series.map((point) => point.posts + point.comments),
      change: current ? { current: current.posts + current.comments, previous: previous ? previous.posts + previous.comments : null } : undefined,
    });
  }
  if (canAccess(roles, "reports")) {
    // The report read has no previous-period totals, so this card carries no change chip.
    items.push({
      label: "Open reports",
      value: valueOf(reportStats, (value) => formatCount(value.backlog)),
      dot: SERIES.reportsOpened.color,
      color: SERIES.reportsOpened.color,
      series: reportStats.data?.series.map((point) => point.backlog),
      href: "/admin/reports",
      valueTone: (reportStats.data?.backlog ?? 0) > 0 ? "bad" : "default",
    });
  }
  return items;
}

/** Every community by health (server counts, same rules as the table badges), with what needs a decision. */
function HealthMixTile({ stats }: { stats: Read<CommunityStats> }) {
  const health = stats.data?.health;
  const groups = HEALTH_GROUPS.map((group) => ({ ...group, value: health?.[group.key] ?? 0 }));
  const total = groups.reduce((sum, group) => sum + group.value, 0);
  const needsReview = health?.needsReview ?? 0;
  return (
    <ChartCard
      empty={health !== undefined && total === 0}
      emptyText="No communities yet."
      error={stats.error}
      height={240}
      loading={stats.loading && !stats.data}
      onRetry={stats.reload}
      subtitle="Every community, by the same rules as the table badges"
      table={{ columns: ["Health", "Communities"], rows: groups.map((group) => [group.label, group.value]) }}
      title="Health mix"
    >
      <div className="admHealthMix">
        <p className="admSrOnly">{`${plural(total, "community", "communities")}: ${groups.map((group) => `${formatCount(group.value)} ${group.words}`).join(", ")}.`}</p>
        <DonutChart
          centerLabel="communities"
          centerValue={formatCount(total)}
          data={groups.filter((group) => group.value > 0).map((group) => ({ label: group.label, value: group.value, color: group.color }))}
          height={220}
        />
        {needsReview > 0 ? (
          <p className="admHealthCallout" data-tone="bad">
            <span><strong>{plural(needsReview, "community needs", "communities need")}</strong> a decision: they have open reports.</span>
            <Link href="/admin/communities?status=flagged">Show flagged communities</Link>
          </p>
        ) : (
          <p className="admHealthCallout">No community needs a decision right now.</p>
        )}
      </div>
    </ChartCard>
  );
}

function MostActiveTile({ top, range }: { top: Read<{ items: TopCommunity[] }>; range: number }) {
  const ranked = [...(top.data?.items ?? [])].sort((a, b) => b.posts + b.comments - (a.posts + a.comments));
  return (
    <ChartCard
      empty={top.data?.items.length === 0}
      emptyText="No community activity in this period."
      error={top.error}
      height={200}
      loading={top.loading && !top.data}
      onRetry={top.reload}
      subtitle={`Posts and comments, last ${range} days`}
      table={{ columns: ["Community", "Posts", "Comments", "New members", "Contributors"], rows: ranked.map((item) => [item.name, item.posts, item.comments, item.newMembers, item.contributors]) }}
      title="Most active communities"
    >
      <BarList
        color={SERIES.posts.color}
        items={ranked.map((item) => ({
          key: item.id,
          label: <Link href={`/admin/communities/${item.id}`}>{item.name}</Link>,
          value: item.posts + item.comments,
          hint: `${formatCount(item.contributors)} contributors`,
        }))}
      />
    </ChartCard>
  );
}

/** Live communities (every one not archived) with open reports, from the same server health counts as the donut. */
export function flaggedShare(health: CommunityHealthCounts): { flagged: number; live: number; ratio: number } {
  const live = HEALTH_GROUPS.reduce((sum, group) => sum + health[group.key], 0) - health.archived;
  return { flagged: health.needsReview, live, ratio: live > 0 ? health.needsReview / live : 0 };
}

/** Rendered only while loading, on error, or when there is at least one live community. */
function FlaggedShareTile({ stats }: { stats: Read<CommunityStats> }) {
  const share = stats.data ? flaggedShare(stats.data.health) : null;
  if (share && share.live === 0) return null;
  // One decimal below 10%, so a small but real share does not read as "0%".
  const percent = share ? `${(share.ratio * 100).toFixed(share.ratio > 0 && share.ratio < 0.1 ? 1 : 0)}%` : "";
  return (
    <ChartCard
      error={stats.error}
      height={150}
      loading={stats.loading && !stats.data}
      onRetry={stats.reload}
      subtitle="Live communities with open reports"
      table={share ? { columns: ["Measure", "Value"], rows: [["Live communities with open reports", share.flagged], ["Live communities", share.live], ["Share", percent]] } : undefined}
      title="Flagged communities"
    >
      {share && (
        <div className="admGaugeTile">
          <div aria-label={`${percent}: ${formatCount(share.flagged)} of ${formatCount(share.live)} live communities have open reports`} role="img">
            <Gauge ratio={share.ratio} size={128} thickness={12} tone={VIZ.orange} valueText={percent} />
          </div>
          <p aria-hidden="true">
            <strong>{formatCount(share.flagged)}</strong> of <strong>{formatCount(share.live)}</strong> live communities
          </p>
          {share.flagged > 0 && <Link className="admBtn admBtnSecondary admBtnSm" href="/admin/communities?status=flagged">Review flagged</Link>}
        </div>
      )}
    </ChartCard>
  );
}

/**
 * The Communities dashboard above the table: trend cards and a bento of tiles. Each read is requested
 * only when the viewer's role can open the section that owns it, and each tile loads on its own.
 */
export function CommunityInsights({ range, refreshKey = 0 }: { range: RangeDays; refreshKey?: number }) {
  const { roles, overview, overviewError } = useAdmin();
  const analytics = canAccess(roles, "analytics");
  const reports = canAccess(roles, "reports");

  const stats = useAdminData<CommunityStats>(`/communities/stats?days=${range}`);
  const activity = useAdminData<ActivityResponse>(analytics ? `/analytics/activity?days=${range}` : null);
  const reportStats = useAdminData<ReportStats>(reports ? `/reports/stats?days=${range}` : null);
  const top = useAdminData<{ items: TopCommunity[] }>(analytics ? `/analytics/top-communities?days=${range}&limit=6` : null);
  const engagement = useAdminData<EngagementResponse>(analytics ? `/analytics/engagement?days=${range}` : null);

  // A table action (archive, restore, …) can move a community between health groups.
  const reloadStats = stats.reload;
  useEffect(() => {
    if (refreshKey > 0) reloadStats();
  }, [refreshKey, reloadStats]);

  const showFlagged = !stats.data || flaggedShare(stats.data.health).live > 0;
  const cards = communityCards({ roles, overview, overviewError, stats, activity, reportStats });

  return (
    <>
      <TrendCards items={cards} label="Community numbers" />
      <Bento label="Community charts">
        <Tile rowSpan={analytics && showFlagged ? 2 : 1} span={analytics ? 6 : showFlagged ? 8 : 12}>
          <HealthMixTile stats={stats} />
        </Tile>
        {analytics && (
          <Tile span={6}>
            <MostActiveTile range={range} top={top} />
          </Tile>
        )}
        {showFlagged && (
          <Tile span={analytics ? 6 : 4}>
            <FlaggedShareTile stats={stats} />
          </Tile>
        )}
        {analytics && (
          <Tile span={12}>
            <EngagementHeatmapCard engagement={engagement} subtitle="Sign-ins, posts and comments by weekday and hour (UTC). Use it to plan moderation cover." />
          </Tile>
        )}
      </Bento>
    </>
  );
}
