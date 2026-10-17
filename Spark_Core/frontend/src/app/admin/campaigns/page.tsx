"use client";

import { Suspense, useState } from "react";

import { useAdmin } from "../_components/admin-context";
import { Drawer } from "../_components/drawer";
import { ReasonDialog, type ReasonRequest } from "../_components/reason-dialog";
import { Badge, EmptyState, ErrorBanner, FilterTabs, KeyValue, LoadMore, NoAccess, PageHeader, SkeletonRows } from "../_components/ui";
import { adminApi, query, reloadIfStale } from "../_lib/api";
import { canAccess } from "../_lib/access";
import { REVIEW_STATUS, formatDate, formatDateTime, formatRelative, humanize } from "../_lib/format";
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
      <PageHeader eyebrow="Moderation" title="Sponsored campaigns" description="Community promotions wait here for review. Only approved campaigns can be scheduled." />

      <div className="admToolbar">
        <FilterTabs
          label="Review status"
          onChange={setFilter}
          options={FILTERS.map((value) => ({ value, label: value === "all" ? "All" : REVIEW_STATUS[value].label, count: value === "pending" ? overview?.campaigns.pending : undefined }))}
          value={filter}
        />
      </div>

      {list.error && <ErrorBanner message={list.error} onRetry={list.reload} />}
      {list.loading ? (
        <SkeletonRows />
      ) : list.items.length === 0 && !list.error ? (
        <EmptyState title={filter === "pending" ? "Nothing to review" : "No campaigns here"}>{filter === "pending" ? "New submissions will appear here." : "Campaigns appear here once they reach this status."}</EmptyState>
      ) : (
        <ul className="admCardGrid">
          {list.items.map((campaign) => (
            <li className="admCampaign" key={campaign.id}>
              <div className="admCampaignTop">
                <Badge tone={REVIEW_STATUS[campaign.reviewStatus].tone}>{REVIEW_STATUS[campaign.reviewStatus].label}</Badge>
                <span className="admMuted admSmall">Submitted {formatRelative(campaign.createdAt)}</span>
              </div>
              <h2>{campaign.name}</h2>
              <p className="admCampaignHeadline">{campaign.headline}</p>
              <KeyValue items={[["Community", campaign.community.name], ["Placement", campaign.placement ?? "Not set"], ["Requested start", formatDate(campaign.requestedStartAt)]]} />
              <div className="admCampaignActions">
                <button className="admBtn admBtnSecondary admBtnSm" onClick={() => setSelected(campaign)} type="button">Details</button>
                {campaign.reviewStatus === "pending" && (
                  <>
                    <button aria-label={`Reject ${campaign.name}`} className="admBtn admBtnDangerOutline admBtnSm" onClick={() => decide(campaign, "reject")} type="button">Reject</button>
                    <button aria-label={`Approve ${campaign.name}`} className="admBtn admBtnPrimary admBtnSm" onClick={() => decide(campaign, "approve")} type="button">Approve</button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {!list.loading && <LoadMore hasMore={list.hasMore} loading={list.loadingMore} onClick={() => void list.loadMore()} shown={list.items.length} />}

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
