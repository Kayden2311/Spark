"use client";

import { Suspense, useState } from "react";

import { useAdmin } from "../_components/admin-context";
import { Drawer } from "../_components/drawer";
import { ReasonDialog, type ReasonRequest } from "../_components/reason-dialog";
import { Badge, EmptyState, ErrorBanner, FilterTabs, KeyValue, LoadMore, NoAccess, PageHeader, Panel, SkeletonRows } from "../_components/ui";
import { adminApi, query, reloadIfStale } from "../_lib/api";
import { canAccess } from "../_lib/access";
import { REVIEW_STATUS, formatDate, formatDateTime, humanize } from "../_lib/format";
import type { Campaign, ReviewStatus } from "../_lib/types";
import { usePagedList } from "../_lib/use-paged-list";
import { useQueryState } from "../_lib/use-query-state";

type Filter = "pending" | "approved" | "rejected" | "all";
const FILTERS: readonly Filter[] = ["pending", "approved", "rejected", "all"];

function CampaignReview() {
  const { roles, overview, refreshOverview, notify } = useAdmin();
  const allowed = canAccess(roles, "campaigns");
  const [filter, setFilter] = useQueryState<Filter>("status", "pending", FILTERS);
  const list = usePagedList<Campaign>(allowed ? `/campaigns${query({ status: filter === "all" ? undefined : filter })}` : null);
  const [selected, setSelected] = useState<Campaign | null>(null);
  const [dialog, setDialog] = useState<ReasonRequest | null>(null);

  if (!allowed) return <NoAccess />;

  const decide = (campaign: Campaign, decision: "approve" | "reject") =>
    setDialog({
      title: decision === "approve" ? "Approve this campaign?" : "Reject this campaign?",
      description: decision === "approve"
        ? <p><strong>{campaign.name}</strong> becomes eligible to run once its order is paid. The decision is final.</p>
        : <p><strong>{campaign.name}</strong> will not run. Your reason is recorded with the decision, so keep it clear and specific. The decision is final.</p>,
      confirmLabel: decision === "approve" ? "Approve" : "Reject",
      tone: decision === "approve" ? "primary" : "danger",
      onConfirm: async (reason) => {
        await adminApi(`/campaigns/${campaign.id}/review`, { method: "POST", body: { decision, reason } }).catch((error: unknown) => reloadIfStale(error, list.reload));
        const reviewStatus: ReviewStatus = decision === "approve" ? "approved" : "rejected";
        list.update(campaign.id, (item) => (filter === "all" || filter === reviewStatus ? { ...item, reviewStatus } : null));
        setSelected(null);
        refreshOverview();
        notify(decision === "approve" ? "Campaign approved." : "Campaign rejected.");
      },
    });

  return (
    <>
      <PageHeader title="Sponsored campaigns" description="Community promotions wait here for review. Only approved campaigns can be scheduled." />

      {list.error && <ErrorBanner message={list.error} onRetry={list.reload} />}
      <Panel
        footer={!list.loading && list.items.length > 0 ? <LoadMore hasMore={list.hasMore} loading={list.loadingMore} noun="campaign" onClick={() => void list.loadMore()} shown={list.items.length} /> : undefined}
        label="Campaigns"
        tabs={
          <FilterTabs
            label="Review status"
            onChange={setFilter}
            options={FILTERS.map((value) => ({ value, label: value === "all" ? "All" : REVIEW_STATUS[value].label, count: value === "pending" ? overview?.campaigns.pending : undefined }))}
            value={filter}
          />
        }
      >
        {list.loading ? (
          <SkeletonRows />
        ) : list.items.length === 0 && !list.error ? (
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
              {list.items.map((campaign) => (
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
                  <td className="admNowrap" data-label="Requested start">{formatDate(campaign.requestedStartAt)}</td>
                  <td data-label="Status"><Badge tone={REVIEW_STATUS[campaign.reviewStatus].tone}>{REVIEW_STATUS[campaign.reviewStatus].label}</Badge></td>
                  <td className="admCellActions">
                    {campaign.reviewStatus === "pending" ? (
                      <button className="admBtn admBtnSecondary admBtnSm" onClick={() => setSelected(campaign)} type="button">Review</button>
                    ) : (
                      <button className="admBtn admBtnGhost admBtnSm" onClick={() => setSelected(campaign)} type="button">View</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

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

export default function CampaignsAdminPage() {
  return (
    <Suspense fallback={<SkeletonRows />}>
      <CampaignReview />
    </Suspense>
  );
}
