"use client";

import { Suspense, useMemo, useState } from "react";

import { useAdmin } from "../_components/admin-context";
import { BarList, InlineBar } from "../_components/charts";
import { Drawer } from "../_components/drawer";
import { ReasonDialog, type ReasonRequest } from "../_components/reason-dialog";
import { BoardIcon, ClockIcon, ListIcon, MegaphoneIcon, ShieldIcon } from "../_components/icons";
import { Badge, Card, CheckboxFacet, EmptyState, ErrorBanner, FilterTabs, KeyValue, KpiCards, LoadMore, NoAccess, PageHeader, Panel, Segmented, SkeletonRows } from "../_components/ui";
import { adminApi, reloadIfStale } from "../_lib/api";
import { canAccess } from "../_lib/access";
import { REVIEW_STATUS, formatCount, formatDate, formatDateTime, formatPercent, formatRelative, humanize } from "../_lib/format";
import { VIZ } from "../_lib/palette";
import type { Campaign, ReviewStatus } from "../_lib/types";
import { usePagedList } from "../_lib/use-paged-list";
import { useQueryState } from "../_lib/use-query-state";

type Filter = "pending" | "approved" | "rejected" | "all";
const FILTERS: readonly Filter[] = ["pending", "approved", "rejected", "all"];
type View = "board" | "list";
const COLUMNS: ReviewStatus[] = ["pending", "approved", "rejected", "draft"];

function waitingDays(campaign: Campaign): number {
  return Math.max(0, Math.floor((Date.now() - Date.parse(campaign.createdAt)) / 86_400_000));
}

function CampaignReview() {
  const { roles, overview, refreshOverview, notify } = useAdmin();
  const allowed = canAccess(roles, "campaigns");
  const [filter, setFilter] = useQueryState<Filter>("status", "pending", FILTERS);
  const [view, setView] = useQueryState<View>("view", "board", ["board", "list"]);
  const [communityFilter, setCommunityFilter] = useState<Set<string>>(new Set());
  // Both views share one fetch (newest 100 across every status), so switching views or status tabs never re-queries.
  const list = usePagedList<Campaign>(allowed ? "/campaigns?limit=100" : null);
  const [selected, setSelected] = useState<Campaign | null>(null);
  const [dialog, setDialog] = useState<ReasonRequest | null>(null);

  const communityCounts = useMemo(() => {
    const counts = new Map<string, { name: string; count: number }>();
    for (const item of list.items) counts.set(item.community.id, { name: item.community.name, count: (counts.get(item.community.id)?.count ?? 0) + 1 });
    return counts;
  }, [list.items]);
  const baseItems = useMemo(
    () => (communityFilter.size === 0 ? list.items : list.items.filter((item) => communityFilter.has(item.community.id))),
    [list.items, communityFilter],
  );
  const filteredList = useMemo(() => (filter === "all" ? baseItems : baseItems.filter((item) => item.reviewStatus === filter)), [baseItems, filter]);

  if (!allowed) return <NoAccess />;

  const communityFacet = (
    <CheckboxFacet
      label="Community"
      onChange={setCommunityFilter}
      options={[...communityCounts.entries()].sort((a, b) => b[1].count - a[1].count).map(([value, { name, count }]) => ({ value, label: name, count }))}
      selected={communityFilter}
    />
  );

  const decide = (campaign: Campaign, decision: "approve" | "reject") =>
    setDialog({
      title: decision === "approve" ? "Approve this campaign?" : "Reject this campaign?",
      description: decision === "approve"
        ? <p><strong>{campaign.name}</strong> becomes eligible to run once its order is paid. The decision is final.</p>
        : <p><strong>{campaign.name}</strong> will not run. Your reason is recorded with the decision, so keep it clear and specific. The decision is final.</p>,
      confirmLabel: decision === "approve" ? "Approve" : "Reject",
      tone: decision === "approve" ? "primary" : "danger",
      templates: decision === "approve"
        ? ["Clear value for members and fits the placement policy.", "Accurate claims and an appropriate audience."]
        : ["Makes financial or health claims we cannot verify.", "Overlaps with an approved campaign this month.", "Headline is misleading about the offer."],
      onConfirm: async (reason) => {
        await adminApi(`/campaigns/${campaign.id}/review`, { method: "POST", body: { decision, reason } }).catch((error: unknown) => reloadIfStale(error, list.reload));
        const reviewStatus: ReviewStatus = decision === "approve" ? "approved" : "rejected";
        list.update(campaign.id, (item) => (view === "board" || filter === "all" || filter === reviewStatus ? { ...item, reviewStatus } : null));
        setSelected(null);
        refreshOverview();
        notify(decision === "approve" ? "Campaign approved." : "Campaign rejected.");
      },
    });

  return (
    <>
      <PageHeader
        actions={<Segmented label="View" onChange={setView} options={[{ value: "board", label: "Board", icon: <BoardIcon /> }, { value: "list", label: "List", icon: <ListIcon /> }]} value={view} />}
        description="Community promotions move through review here. Only approved campaigns can be scheduled."
        title="Sponsored campaigns"
      />

      <PipelineSummary items={baseItems} loading={list.loading} />

      {list.error && <ErrorBanner message={list.error} onRetry={list.reload} />}
      {view === "board" ? (
        <>
          <div className="admPanelTools admBoardTools">{communityFacet}</div>
          {list.loading ? <SkeletonRows /> : (
          <div className="admBoard">
            {COLUMNS.filter((column) => column !== "draft" || baseItems.some((item) => item.reviewStatus === "draft")).map((column) => {
              const cards = baseItems.filter((item) => item.reviewStatus === column);
              return (
                <section aria-label={REVIEW_STATUS[column].label} className="admBoardColumn" key={column}>
                  <header className={`admBoardHead admTone-${REVIEW_STATUS[column].tone}`}>
                    <span aria-hidden="true" className="admBadgeDot" />
                    <h2>{REVIEW_STATUS[column].label}</h2>
                    <span className="admTabCount">{cards.length}</span>
                  </header>
                  {cards.length === 0 ? <p className="admBoardEmpty">Nothing here.</p> : (
                    <ul className="admBoardCards">
                      {cards.map((campaign) => {
                        const waiting = waitingDays(campaign);
                        return (
                          <li key={campaign.id}>
                            <button className="admBoardCard" onClick={() => setSelected(campaign)} type="button">
                              <span className="admBoardCardTitle">{campaign.name}</span>
                              <span className="admBoardCardText">{campaign.headline}</span>
                              <span className="admBoardCardMeta">
                                <span>{campaign.community.name}</span>
                                <span>Starts {formatDate(campaign.requestedStartAt)}</span>
                              </span>
                              {column === "pending" && (
                                <Badge tone={waiting >= 3 ? "red" : waiting >= 1 ? "amber" : "neutral"}>{waiting === 0 ? "Submitted today" : `Waiting ${waiting} ${waiting === 1 ? "day" : "days"}`}</Badge>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
          )}
        </>
      ) : (
      <>
        {!list.loading && baseItems.length > 0 && (
          <Card flush subtitle={`${filter === "all" ? "Every" : REVIEW_STATUS[filter].label} campaign loaded, by status`} title="Review pipeline by status">
            <BarList
              color={VIZ.blue}
              items={COLUMNS.filter((column) => baseItems.some((item) => item.reviewStatus === column)).map((column) => ({
                key: column,
                label: REVIEW_STATUS[column].label,
                value: baseItems.filter((item) => item.reviewStatus === column).length,
              }))}
            />
          </Card>
        )}
      <Panel
        footer={!list.loading && filteredList.length > 0 ? <LoadMore hasMore={list.hasMore} loading={list.loadingMore} noun="campaign" onClick={() => void list.loadMore()} shown={filteredList.length} /> : undefined}
        label="Campaigns"
        tabs={
          <FilterTabs
            label="Review status"
            onChange={setFilter}
            options={FILTERS.map((value) => ({ value, label: value === "all" ? "All" : REVIEW_STATUS[value].label, count: value === "pending" ? overview?.campaigns.pending : undefined }))}
            value={filter}
          />
        }
        tools={communityFacet}
      >
        {list.loading ? (
          <SkeletonRows />
        ) : filteredList.length === 0 && !list.error ? (
          <EmptyState title={filter === "pending" ? "Nothing to review" : "No campaigns here"}>{filter === "pending" ? "New submissions will appear here." : "Campaigns appear here once they reach this status."}</EmptyState>
        ) : (
          <table className="admTable">
            <thead>
              <tr>
                <th scope="col">Campaign</th>
                <th scope="col">Community</th>
                <th scope="col">Placement</th>
                <th scope="col">Requested start</th>
                <th scope="col">Status</th>
                <th scope="col"><span className="admSrOnly">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {filteredList.map((campaign) => {
                const waiting = waitingDays(campaign);
                return (
                <tr key={campaign.id}>
                  <td data-label="Campaign">
                    <div className="admCellMain">
                      <button className="admCellLink" onClick={() => setSelected(campaign)} type="button">{campaign.name}</button>
                      <span className="admCellSub admClamp">{campaign.headline}</span>
                    </div>
                  </td>
                  <td data-label="Community">
                    <div className="admCellMain">
                      <span>{campaign.community.name}</span>
                      <span className="admCellSub">by {campaign.submitter.displayName}</span>
                    </div>
                  </td>
                  <td data-label="Placement">{campaign.placement ?? <span className="admMutedCell">Not set</span>}</td>
                  <td data-label="Requested start">
                    <div className="admCellMain">
                      <span className="admNowrap">{formatDate(campaign.requestedStartAt)}</span>
                      {campaign.reviewStatus === "pending" && (
                        <span className="admInline">
                          <InlineBar color={waiting >= 3 ? "#ef4444" : waiting >= 1 ? "#f59e0b" : "#94a3b8"} ratio={waiting / 7} />
                          <span className="admCellSub">{waiting === 0 ? "today" : `${waiting}d waiting`}</span>
                        </span>
                      )}
                    </div>
                  </td>
                  <td data-label="Status"><Badge tone={REVIEW_STATUS[campaign.reviewStatus].tone}>{REVIEW_STATUS[campaign.reviewStatus].label}</Badge></td>
                  <td className="admCellActions">
                    {campaign.reviewStatus === "pending" ? (
                      <button className="admBtn admBtnSecondary admBtnSm" onClick={() => setSelected(campaign)} type="button">Review</button>
                    ) : (
                      <button className="admBtn admBtnGhost admBtnSm" onClick={() => setSelected(campaign)} type="button">View</button>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
      </>
      )}

      <Drawer
        footer={selected?.reviewStatus === "pending" ? (
          <>
            <button className="admBtn admBtnDangerOutline" onClick={() => decide(selected, "reject")} type="button">Reject</button>
            <button className="admBtn admBtnPrimary" onClick={() => decide(selected, "approve")} type="button">Approve</button>
          </>
        ) : undefined}
        onClose={() => setSelected(null)}
        open={selected !== null}
        subtitle={selected ? `${selected.community.name} · submitted by ${selected.submitter.displayName}` : undefined}
        title={selected?.name ?? "Campaign"}
      >
        {selected && (
          <>
            <Badge tone={REVIEW_STATUS[selected.reviewStatus].tone}>{REVIEW_STATUS[selected.reviewStatus].label}</Badge>
            <article className="admContentPreview">
              <h3>{selected.headline}</h3>
              <p>{selected.description}</p>
            </article>
            <KeyValue
              items={[
                ["Placement", selected.placement ?? "Not set"],
                ["Requested start", formatDateTime(selected.requestedStartAt)],
                ["Scheduled", selected.startsAt ? `${formatDateTime(selected.startsAt)} – ${formatDateTime(selected.endsAt)}` : "Not scheduled"],
                ["Delivery", humanize(selected.deliveryStatus)],
                ["Version", selected.version],
                ["Submitted", formatDateTime(selected.createdAt)],
              ]}
            />
          </>
        )}
      </Drawer>
      <ReasonDialog onClose={() => setDialog(null)} request={dialog} />
    </>
  );
}

function PipelineSummary({ items, loading }: { items: Campaign[]; loading: boolean }) {
  const pending = items.filter((item) => item.reviewStatus === "pending");
  const approved = items.filter((item) => item.reviewStatus === "approved").length;
  const rejected = items.filter((item) => item.reviewStatus === "rejected").length;
  const oldest = pending.reduce<Campaign | null>((first, item) => (!first || item.createdAt < first.createdAt ? item : first), null);
  return (
    <KpiCards
      items={[
        { label: "Awaiting review", value: loading ? undefined : formatCount(pending.length), hint: oldest ? `Oldest submitted ${formatRelative(oldest.createdAt)}` : "Nothing waiting", icon: <ClockIcon />, tone: pending.length > 0 ? "amber" : "green" },
        { label: "Approval rate", value: loading ? undefined : approved + rejected > 0 ? formatPercent(approved / (approved + rejected)) : "–", hint: `${approved} approved · ${rejected} rejected`, icon: <ShieldIcon />, tone: "blue" },
        { label: "Campaigns", value: loading ? undefined : formatCount(items.length), hint: "Newest 100 across every status", icon: <MegaphoneIcon />, tone: "violet" },
      ]}
      label="Review pipeline"
    />
  );
}

export default function CampaignsAdminPage() {
  return (
    <Suspense fallback={<SkeletonRows />}>
      <CampaignReview />
    </Suspense>
  );
}
