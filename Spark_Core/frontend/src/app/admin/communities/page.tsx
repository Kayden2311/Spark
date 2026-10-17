"use client";

import { Suspense, useState } from "react";

import { useAdmin } from "../_components/admin-context";
import { SearchIcon } from "../_components/icons";
import { ReasonDialog, type ReasonRequest } from "../_components/reason-dialog";
import { Badge, EmptyState, ErrorBanner, FilterTabs, LoadMore, NoAccess, PageHeader, SkeletonRows } from "../_components/ui";
import { adminApi, query, reloadIfStale } from "../_lib/api";
import { canAccess } from "../_lib/access";
import { COMMUNITY_STATE, formatDate, humanize } from "../_lib/format";
import type { Community, CommunityAction, CommunityState } from "../_lib/types";
import { usePagedList } from "../_lib/use-paged-list";
import { useDebounced, useQueryState } from "../_lib/use-query-state";

type Filter = "all" | CommunityState | "flagged";
const FILTERS: readonly Filter[] = ["all", "active", "featured", "frozen", "archived", "flagged"];

// Mirrors the transitions staff_moderate_community accepts; the database is the authority.
const AVAILABLE: Record<CommunityState, CommunityAction[]> = {
  active: ["feature", "freeze", "archive"],
  featured: ["unfeature", "freeze", "archive"],
  frozen: ["unfreeze", "archive"],
  archived: ["restore"],
};

const RESULT: Record<CommunityAction, CommunityState> = {
  feature: "featured",
  unfeature: "active",
  freeze: "frozen",
  unfreeze: "active",
  archive: "archived",
  restore: "active",
};

const COPY: Record<CommunityAction, { label: string; title: string; description: string; tone: "primary" | "danger"; done: string }> = {
  feature: { label: "Feature", title: "Feature this community?", description: "Marks the community as featured so it can be promoted to members.", tone: "primary", done: "Community featured." },
  unfeature: { label: "Unfeature", title: "Remove from featured?", description: "The community stays live but is no longer highlighted.", tone: "primary", done: "Community removed from featured." },
  freeze: { label: "Freeze", title: "Freeze this community?", description: "Members can still read it, but nobody can publish new posts or comments until it is unfrozen. Freezing also removes it from featured.", tone: "danger", done: "Community frozen." },
  unfreeze: { label: "Unfreeze", title: "Unfreeze this community?", description: "Members can publish posts and comments again.", tone: "primary", done: "Community unfrozen." },
  archive: { label: "Archive", title: "Archive this community?", description: "The community becomes read-only and leaves the directory. You can restore it later.", tone: "danger", done: "Community archived." },
  restore: { label: "Restore", title: "Restore this community?", description: "The community becomes active again. It is not re-featured automatically.", tone: "primary", done: "Community restored." },
};

function CommunitiesList() {
  const { roles, overview, refreshOverview, notify } = useAdmin();
  const allowed = canAccess(roles, "communities");
  const [filter, setFilter] = useQueryState<Filter>("status", "all", FILTERS);
  const [search, setSearch] = useState("");
  const settledSearch = useDebounced(search.trim());
  const list = usePagedList<Community>(allowed ? `/communities${query({ status: filter === "all" ? undefined : filter, search: settledSearch })}` : null);
  const [dialog, setDialog] = useState<ReasonRequest | null>(null);

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
      onConfirm: async (reason) => {
        await adminApi(`/communities/${community.id}/actions`, { method: "POST", body: { action, reason } }).catch((error: unknown) => reloadIfStale(error, list.reload));
        const state = RESULT[action];
        // Drop the row when it no longer matches the active filter.
        list.update(community.id, (item) => (filter === "all" || filter === "flagged" || filter === state ? { ...item, state } : null));
        refreshOverview();
        notify(copy.done);
      },
    });
  };

  return (
    <>
      <PageHeader eyebrow="Moderation" title="Communities" description="Feature standout communities, freeze ones that need a pause, and archive those that are no longer active." />

      <div className="admToolbar">
        <FilterTabs label="Community state" onChange={setFilter} options={FILTERS.map((value) => ({ value, label: value === "all" ? "All" : value === "flagged" ? "Flagged" : COMMUNITY_STATE[value].label, count: counts[value] }))} value={filter} />
        <label className="admSearch">
          <SearchIcon />
          <span className="admSrOnly">Search communities</span>
          <input onChange={(event) => setSearch(event.target.value)} placeholder="Search by name or slug" type="search" value={search} />
        </label>
      </div>

      {list.error && <ErrorBanner message={list.error} onRetry={list.reload} />}
      {list.loading ? (
        <SkeletonRows />
      ) : list.items.length === 0 && !list.error ? (
        <EmptyState title="No communities match">{settledSearch ? "Try a different name or slug." : "Communities in this state will appear here."}</EmptyState>
      ) : (
        <div className="admTableCard">
          <table className="admTable">
            <thead>
              <tr>
                <th scope="col">Community</th>
                <th scope="col">State</th>
                <th scope="col" className="admNum">Members</th>
                <th scope="col" className="admNum">Open reports</th>
                <th scope="col">Created</th>
                <th scope="col"><span className="admSrOnly">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((community) => (
                <tr key={community.id}>
                  <td data-label="Community">
                    <div className="admCellMain">
                      <span className="admCellTitle">{community.name}</span>
                      <span className="admCellSub">/{community.slug} · {humanize(community.visibility)}{community.stage ? ` · ${community.stage}` : ""} · by {community.creator.displayName}</span>
                    </div>
                  </td>
                  <td data-label="State"><Badge tone={COMMUNITY_STATE[community.state].tone}>{COMMUNITY_STATE[community.state].label}</Badge></td>
                  <td className="admNum" data-label="Members">{community.memberCount}</td>
                  <td className="admNum" data-label="Open reports">{community.openReports > 0 ? <Badge tone="red">{community.openReports}</Badge> : "0"}</td>
                  <td className="admNowrap" data-label="Created">{formatDate(community.createdAt)}</td>
                  <td className="admCellActions">
                    <div className="admActionGroup">
                      {AVAILABLE[community.state].map((action) => (
                        <button
                          aria-label={`${COPY[action].label} ${community.name}`}
                          className={`admBtn admBtnSm ${COPY[action].tone === "danger" ? "admBtnDangerOutline" : "admBtnSecondary"}`}
                          key={action}
                          onClick={() => act(community, action)}
                          type="button"
                        >
                          {COPY[action].label}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!list.loading && <LoadMore hasMore={list.hasMore} loading={list.loadingMore} onClick={() => void list.loadMore()} shown={list.items.length} />}
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
