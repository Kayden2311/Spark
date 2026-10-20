"use client";

import Link from "next/link";
import { Suspense, useState } from "react";

import { useAdmin } from "../_components/admin-context";
import { AVAILABLE, COPY, RESULT, healthOf } from "../_components/community-actions";
import { SearchIcon } from "../_components/icons";
import { ReasonDialog, type ReasonRequest } from "../_components/reason-dialog";
import { Sparkline } from "../_components/sparkline";
import { Badge, EmptyState, ErrorBanner, FilterTabs, LoadMore, NoAccess, PageHeader, Panel, RangePicker, RowMenu, SkeletonRows } from "../_components/ui";
import { adminApi, query, reloadIfStale } from "../_lib/api";
import { canAccess } from "../_lib/access";
import { COMMUNITY_STATE, formatCount, humanize } from "../_lib/format";
import { VIZ } from "../_lib/palette";
import { useRange } from "../_lib/range";
import type { Community, CommunityAction, CommunityState } from "../_lib/types";
import { usePagedList } from "../_lib/use-paged-list";
import { useDebounced, useQueryState } from "../_lib/use-query-state";
import { COMMUNITY_RANGES, CommunityInsights } from "./community-insights";

type Filter = "all" | CommunityState | "flagged";
const FILTERS: readonly Filter[] = ["all", "active", "featured", "frozen", "archived", "flagged"];

function CommunitiesList() {
  const { roles, overview, refreshOverview, notify } = useAdmin();
  const allowed = canAccess(roles, "communities");
  const [filter, setFilter] = useQueryState<Filter>("status", "all", FILTERS);
  const [search, setSearch] = useState("");
  const settledSearch = useDebounced(search.trim());
  const list = usePagedList<Community>(allowed ? `/communities${query({ status: filter === "all" ? undefined : filter, search: settledSearch })}` : null);
  const [dialog, setDialog] = useState<ReasonRequest | null>(null);
  const [range, setRange] = useRange(30, COMMUNITY_RANGES);
  // Bumped after an action, so the health counts above the table follow the change.
  const [statsVersion, setStatsVersion] = useState(0);

  if (!allowed) return <NoAccess />;

  const counts: Partial<Record<Filter, number>> = overview
    ? { featured: overview.communities.featured, frozen: overview.communities.frozen, archived: overview.communities.archived, flagged: overview.communities.flagged }
    : {};

  const act = (community: Community, action: CommunityAction) => {
    const copy = COPY[action];
    setDialog({
      title: copy.title,
      description: <p><strong>{community.name}</strong>. {copy.description}</p>,
      confirmLabel: copy.label,
      tone: copy.tone,
      templates: copy.templates,
      onConfirm: async (reason) => {
        await adminApi(`/communities/${community.id}/actions`, { method: "POST", body: { action, reason } }).catch((error: unknown) => reloadIfStale(error, list.reload));
        const state = RESULT[action];
        // Drop the row when it no longer matches the active filter.
        list.update(community.id, (item) => (filter === "all" || filter === "flagged" || filter === state ? { ...item, state } : null));
        refreshOverview();
        setStatsVersion((value) => value + 1);
        notify(copy.done);
      },
    });
  };

  return (
    <>
      <PageHeader
        actions={<RangePicker onChange={setRange} options={COMMUNITY_RANGES} value={range} />}
        description="Spot communities that are growing, slowing down or drawing reports, and act on them."
        title="Communities"
      />

      <CommunityInsights range={range} refreshKey={statsVersion} />

      {list.error && <ErrorBanner message={list.error} onRetry={list.reload} />}
      <Panel
        footer={!list.loading && list.items.length > 0 ? <LoadMore hasMore={list.hasMore} loading={list.loadingMore} noun="community" plural="communities" onClick={() => void list.loadMore()} shown={list.items.length} /> : undefined}
        label="Communities"
        tabs={<FilterTabs label="Community state" onChange={setFilter} options={FILTERS.map((value) => ({ value, label: value === "all" ? "All" : value === "flagged" ? "Flagged" : COMMUNITY_STATE[value].label, count: counts[value] }))} value={filter} />}
        tools={
          <label className="admSearch">
            <SearchIcon />
            <span className="admSrOnly">Search communities</span>
            <input onChange={(event) => setSearch(event.target.value)} placeholder="Search name or slug" type="search" value={search} />
          </label>
        }
      >
        {list.loading ? (
          <SkeletonRows />
        ) : list.items.length === 0 && !list.error ? (
          <EmptyState title="No communities match">{settledSearch ? "Try a different name or slug." : "Communities in this state will appear here."}</EmptyState>
        ) : (
          <table className="admTable">
            <thead>
              <tr>
                <th scope="col">Community</th>
                <th scope="col">Health</th>
                <th className="admNum" scope="col">Members</th>
                <th scope="col">Activity, 8 weeks</th>
                <th className="admNum" scope="col">Posts · comments (30d)</th>
                <th className="admNum" scope="col">Open reports</th>
                <th scope="col"><span className="admSrOnly">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((community) => {
                const health = healthOf(community);
                const weekly = community.weeklyActivity ?? [];
                return (
                  <tr key={community.id}>
                    <td data-label="Community">
                      <Link className="admEntity admEntityLink" href={`/admin/communities/${community.id}`}>
                        <span aria-hidden="true" className="admEntityMark">{community.name.slice(0, 1).toUpperCase()}</span>
                        <span className="admCellMain">
                          <span className="admCellTitle">{community.name}</span>
                          <span className="admCellSub">/{community.slug} · {humanize(community.visibility)}{community.stage ? ` · ${community.stage}` : ""}</span>
                        </span>
                      </Link>
                    </td>
                    <td data-label="Health">
                      <span className="admCellMain">
                        <Badge tone={health.tone}>{health.label}</Badge>
                        {community.state !== "active" && community.state !== "archived" && <span className="admCellSub">{COMMUNITY_STATE[community.state].label}</span>}
                      </span>
                    </td>
                    <td className="admNum" data-label="Members">
                      <span className="admCellMain admCellNum">
                        <span>{formatCount(community.memberCount)}</span>
                        {community.newMembers30d > 0 && <span className="admCellSub">+{formatCount(community.newMembers30d)} this month</span>}
                      </span>
                    </td>
                    <td data-label="Activity">
                      <span className="admInline">
                        <Sparkline color={VIZ.aqua} height={28} values={weekly} />
                        <span className="admSrOnly">Weekly posts and comments: {weekly.join(", ")}</span>
                      </span>
                    </td>
                    <td className="admNum" data-label="Posts · comments">{formatCount(community.posts30d)} · {formatCount(community.comments30d)}</td>
                    <td className="admNum" data-label="Open reports">{community.openReports > 0 ? <Badge tone="red">{community.openReports}</Badge> : <span className="admMutedCell">0</span>}</td>
                    <td className="admCellActions">
                      <RowMenu
                        actions={[
                          ...AVAILABLE[community.state].map((action) => ({
                            label: COPY[action].label,
                            tone: COPY[action].tone === "danger" ? ("danger" as const) : undefined,
                            separated: action === "archive" && community.state !== "frozen",
                            onSelect: () => act(community, action),
                          })),
                        ]}
                        label={`Actions for ${community.name}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
      <ReasonDialog onClose={() => setDialog(null)} request={dialog} />
    </>
  );
}

export default function CommunitiesAdminPage() {
  return (
    <Suspense fallback={<SkeletonRows />}>
      <CommunitiesList />
    </Suspense>
  );
}
