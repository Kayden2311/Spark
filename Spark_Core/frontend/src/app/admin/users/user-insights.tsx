"use client";

import Link from "next/link";

import { useAdmin } from "../_components/admin-context";
import { Bento, Tile } from "../_components/bento";
import { BarList, ChartCard, DonutChart, Gauge, TrendChart } from "../_components/charts";
import { valueOf, type Read } from "../_components/overview-tiles";
import { TrendCards, type TrendCardItem } from "../_components/trend-cards";
import { PLATFORM_ROLES, canRead } from "../_lib/access";
import { ROLE_LABELS, TONE_DOT, formatCount, shortDate } from "../_lib/format";
import { CATEGORICAL, SERIES, VIZ } from "../_lib/palette";
import type { ActivityResponse, Overview, Page, PlatformRole, UserSummary } from "../_lib/types";
import { useAdminData } from "../_lib/use-admin-data";

/** The period of the membership reads. The page has no range picker, so it says so in its subtitles. */
export const USERS_PERIOD_DAYS = 30;

type Rows = Array<Record<string, unknown>>;

function useHolders(role: PlatformRole) {
  return useAdminData<Page<UserSummary>>(`/users?role=${role}&limit=100`);
}

interface RoleMix {
  items: Array<{ role: PlatformRole; label: string; value: number; color: string }>;
  total: number;
  /** A role has more holders than the read returns (100), so the total is a floor. */
  partial: boolean;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** Who holds each platform role right now, from the users read filtered by role. */
function useRoleMix(): RoleMix {
  // PLATFORM_ROLES is a fixed 5-role tuple, so these are named one by one rather than mapped —
  // calling a hook inside a loop or .map() would break React's rules of hooks.
  const holders = [
    useHolders("super_admin"),
    useHolders("platform_admin"),
    useHolders("community_moderator"),
    useHolders("content_moderator"),
    useHolders("campaign_moderator"),
  ];
  const items = PLATFORM_ROLES.map((role, index) => ({ role, label: ROLE_LABELS[role], value: holders[index]!.data?.items.length ?? 0, color: CATEGORICAL[index % CATEGORICAL.length]! }));
  return {
    items,
    total: items.reduce((sum, item) => sum + item.value, 0),
    partial: holders.some((holder) => Boolean(holder.data?.nextCursor)),
    loading: holders.some((holder) => !holder.data && !holder.error),
    error: holders.find((holder) => holder.error)?.error ?? null,
    reload: () => {
      for (const holder of holders) holder.reload();
    },
  };
}

/** Trend cards. Suspensions and role grants have no history, so those two show their value without a sparkline. */
function userTrendCards({ roles, activity, overview, overviewError, mix }: {
  roles: readonly string[];
  activity: Read<ActivityResponse>;
  overview: Overview | null;
  overviewError: string | null;
  mix: RoleMix;
}): TrendCardItem[] {
  const items: TrendCardItem[] = [];
  if (canRead(roles, "analytics/activity")) {
    const series = activity.data?.series ?? [];
    const current = activity.data?.current;
    const previous = activity.data?.previous ?? null;
    items.push(
      {
        label: "New members",
        value: valueOf(activity, (data) => formatCount(data.current.signups)),
        dot: SERIES.signups.color,
        color: SERIES.signups.color,
        change: current ? { current: current.signups, previous: previous ? previous.signups : null } : undefined,
        series: series.map((point) => point.signups),
      },
      {
        label: "Avg. daily users",
        value: valueOf(activity, (data) => formatCount(Math.round(data.current.avgActiveUsers))),
        dot: SERIES.activeUsers.color,
        color: SERIES.activeUsers.color,
        change: current ? { current: current.avgActiveUsers, previous: previous ? previous.avgActiveUsers : null } : undefined,
        series: series.map((point) => point.activeUsers),
        href: "/admin/analytics?view=engagement",
      },
    );
  }
  if (canRead(roles, "overview")) {
    items.push({
      label: "Suspended",
      value: overview ? formatCount(overview.users.suspended) : overviewError ? "–" : undefined,
      dot: TONE_DOT.red,
      color: TONE_DOT.red,
      href: "/admin/users?status=suspended",
    });
  }
  items.push({
    label: "Staff role grants",
    value: mix.loading ? undefined : mix.error ? "–" : `${formatCount(mix.total)}${mix.partial ? "+" : ""}`,
    dot: VIZ.violet,
    color: VIZ.violet,
    href: "/admin/users?view=roles",
  });
  return items;
}

function SignupsTile({ activity }: { activity: Read<ActivityResponse> }) {
  const series = activity.data?.series ?? [];
  return (
    <ChartCard
      empty={activity.data !== null && series.every((point) => point.signups === 0)}
      emptyText="No one signed up in this period yet."
      error={activity.error}
      height={220}
      loading={activity.loading && !activity.data}
      onRetry={activity.reload}
      subtitle={`New accounts created each day · last ${USERS_PERIOD_DAYS} days (UTC)`}
      table={{ columns: ["Day", "Sign-ups"], rows: series.map((point) => [shortDate(point.day), point.signups]) }}
      title="Sign-ups"
    >
      <TrendChart data={series as unknown as Rows} height={220} kind="bar" series={[{ key: "signups", ...SERIES.signups }]} />
    </ChartCard>
  );
}

/** Role grants, not headcount: an account can hold more than one role, and the subtitle says so. */
function RoleMixTile({ mix }: { mix: RoleMix }) {
  const total = `${formatCount(mix.total)}${mix.partial ? "+" : ""}`;
  return (
    <ChartCard
      empty={!mix.loading && !mix.error && mix.total === 0}
      emptyText="No one holds a platform role yet."
      error={mix.error}
      height={200}
      loading={mix.loading}
      onRetry={mix.reload}
      subtitle="Grants right now; one account can hold several"
      table={{ columns: ["Role", "Holders"], rows: mix.items.map((item) => [item.label, item.value]) }}
      title="Platform roles"
    >
      <div className="admRoleMix">
        <p className="admSrOnly">{`${total} role grants: ${mix.items.map((item) => `${formatCount(item.value)} ${item.label}`).join(", ")}.`}</p>
        <DonutChart centerLabel="role grants" centerValue={total} data={mix.items.filter((item) => item.value > 0)} height={180} />
      </div>
    </ChartCard>
  );
}

/** Every account by status, from the overview counts. Each row filters the directory below. */
function AccountStatusTile({ overview, error, onRetry }: { overview: Overview | null; error: string | null; onRetry: () => void }) {
  const rows = overview
    ? [
        { key: "active", label: "Active", value: overview.users.active },
        { key: "suspended", label: "Suspended", value: overview.users.suspended },
      ]
    : [];
  return (
    <ChartCard
      empty={overview !== null && overview.users.active + overview.users.suspended === 0}
      emptyText="No accounts yet."
      error={error}
      height={120}
      loading={!overview && !error}
      onRetry={onRetry}
      subtitle="Every account · choose one to filter"
      table={{ columns: ["Status", "Accounts"], rows: rows.map((row) => [row.label, row.value]) }}
      title="Account status"
    >
      <BarList color={VIZ.blue} items={rows.map((row) => ({ key: row.key, label: <Link href={`/admin/users?status=${row.key}`}>{row.label}</Link>, value: row.value }))} />
    </ChartCard>
  );
}

/** Monthly active members out of every account: how much of the member base is still using Spark. */
function MemberReachTile({ activity }: { activity: Read<ActivityResponse> }) {
  const audience = activity.data?.audience;
  const ratio = audience && audience.totalUsers > 0 ? Math.min(1, audience.mau / audience.totalUsers) : 0;
  // One decimal below 10%, so a small but real share does not read as "0%".
  const percent = `${(ratio * 100).toFixed(ratio > 0 && ratio < 0.1 ? 1 : 0)}%`;
  return (
    <ChartCard
      empty={audience !== undefined && audience.totalUsers === 0}
      emptyText="No accounts yet."
      error={activity.error}
      height={150}
      loading={activity.loading && !activity.data}
      onRetry={activity.reload}
      subtitle="Signed in, posted or commented in 30 days"
      table={audience ? {
        columns: ["Measure", "Members"],
        rows: [["Active today", audience.dau], ["Active in the last 7 days", audience.wau], ["Active in the last 30 days", audience.mau], ["All accounts", audience.totalUsers], ["Reach (30 days)", percent]],
      } : undefined}
      title="Member reach"
    >
      {audience && (
        <div className="admGaugeTile">
          <div aria-label={`${percent}: ${formatCount(audience.mau)} of ${formatCount(audience.totalUsers)} members were active in the last 30 days`} role="img">
            <Gauge ratio={ratio} size={128} thickness={12} tone={SERIES.activeUsers.color} valueText={percent} />
          </div>
          <p aria-hidden="true">
            <strong>{formatCount(audience.mau)}</strong> of <strong>{formatCount(audience.totalUsers)}</strong> members · <strong>{formatCount(audience.wau)}</strong> this week
          </p>
        </div>
      )}
    </ChartCard>
  );
}

/**
 * The Users dashboard above the directory: trend cards and a bento of tiles. Each read is requested, and
 * its card or tile shown, only when the viewer's role can open it (`canRead`); each tile loads on its own.
 */
export function UserInsights() {
  const { roles, overview, overviewError, refreshOverview } = useAdmin();
  const canActivity = canRead(roles, "analytics/activity");
  const canOverview = canRead(roles, "overview");
  const activity = useAdminData<ActivityResponse>(canActivity ? `/analytics/activity?days=${USERS_PERIOD_DAYS}` : null);
  const mix = useRoleMix();
  const cards = userTrendCards({ roles, activity, overview, overviewError, mix });

  return (
    <>
      <TrendCards items={cards} label="Membership numbers" />
      <Bento label="Membership charts">
        {canActivity && (
          <Tile span={8}>
            <SignupsTile activity={activity} />
          </Tile>
        )}
        <Tile rowSpan={canActivity ? 2 : 1} span={canActivity ? 4 : canOverview ? 6 : 12}>
          <RoleMixTile mix={mix} />
        </Tile>
        {canOverview && (
          <Tile span={canActivity ? 4 : 6}>
            <AccountStatusTile error={overviewError} onRetry={refreshOverview} overview={overview} />
          </Tile>
        )}
        {canActivity && (
          <Tile span={4}>
            <MemberReachTile activity={activity} />
          </Tile>
        )}
      </Bento>
    </>
  );
}
