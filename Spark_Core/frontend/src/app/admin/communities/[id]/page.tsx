"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense, useState } from "react";

import { useAdmin } from "../../_components/admin-context";
import { ChartCard, ChartLegend, TrendChart } from "../../_components/charts";
import { AVAILABLE, COPY, healthOf } from "../../_components/community-actions";
import { AlertIcon, ArrowLeftIcon, ChatIcon, CommunityIcon, SignupIcon } from "../../_components/icons";
import { ReasonDialog, type ReasonRequest } from "../../_components/reason-dialog";
import { Avatar, Badge, Card, EmptyState, ErrorBanner, KeyValue, KpiCards, NoAccess, RangePicker, SkeletonRows } from "../../_components/ui";
import { adminApi } from "../../_lib/api";
import { canAccess } from "../../_lib/access";
import { AUDIT_ACTIONS, COMMUNITY_STATE, formatCount, formatDate, formatDateTime, formatRelative, humanize, shortDate } from "../../_lib/format";
import { SERIES } from "../../_lib/palette";
import { useRange } from "../../_lib/range";
import type { CommunityAction, CommunityDetail } from "../../_lib/types";
import { useAdminData } from "../../_lib/use-admin-data";

function CommunityView() {
  const { id } = useParams<{ id: string }>();
  const { roles, refreshOverview, notify } = useAdmin();
  const allowed = canAccess(roles, "communities");
  const isAdmin = canAccess(roles, "audit");
  const [range, setRange] = useRange(90);
  const detail = useAdminData<CommunityDetail>(allowed ? `/communities/${encodeURIComponent(id)}?days=${range}` : null);
  const [dialog, setDialog] = useState<ReasonRequest | null>(null);

  if (!allowed) return <NoAccess />;
  if (detail.error && !detail.data) {
    // 400 means the id in the address is not a valid community id at all.
    return detail.errorStatus === 404 || detail.errorStatus === 400
      ? <EmptyState action={<Link className="admBtn admBtnSecondary" href="/admin/communities">Back to communities</Link>} title="Community not found">It may have been removed, or the link is wrong.</EmptyState>
      : <ErrorBanner message={detail.error} onRetry={detail.reload} />;
  }
  if (!detail.data) return <SkeletonRows rows={6} />;

  const { community, series, history } = detail.data;
  const health = healthOf(community);
  const totals = series.reduce((sum, point) => ({ posts: sum.posts + point.posts, comments: sum.comments + point.comments, members: sum.members + point.newMembers, reports: sum.reports + point.reportsOpened }), { posts: 0, comments: 0, members: 0, reports: 0 });

  const act = (action: CommunityAction) => {
    const copy = COPY[action];
    setDialog({
      title: copy.title,
      description: <p><strong>{community.name}</strong>. {copy.description}</p>,
      confirmLabel: copy.label,
      tone: copy.tone,
      templates: copy.templates,
      onConfirm: async (reason) => {
        await adminApi(`/communities/${community.id}/actions`, { method: "POST", body: { action, reason } }).catch((error: unknown) => {
          detail.reload();
          throw error;
        });
        detail.reload();
        refreshOverview();
        notify(copy.done);
      },
    });
  };

  return (
    <>
      <Link className="admBackLink" href="/admin/communities"><ArrowLeftIcon /> Communities</Link>
      <header className="admProfileHeader">
        <span aria-hidden="true" className="admEntityMark admEntityMarkLg">{community.name.slice(0, 1).toUpperCase()}</span>
        <div className="admProfileText">
          <h1>{community.name}</h1>
          <p>/{community.slug} · {humanize(community.visibility)}{community.stage ? ` · ${community.stage}` : ""} · created {formatDate(community.createdAt)} by {community.creator.displayName}</p>
          <div className="admBadgeRow">
            <Badge tone={COMMUNITY_STATE[community.state].tone}>{COMMUNITY_STATE[community.state].label}</Badge>
            <Badge tone={health.tone}>{health.label}</Badge>
          </div>
        </div>
        <div className="admProfileActions">
          {AVAILABLE[community.state].map((action) => (
            <button className={`admBtn ${COPY[action].tone === "danger" ? "admBtnDangerOutline" : "admBtnSecondary"}`} key={action} onClick={() => act(action)} type="button">{COPY[action].label}</button>
          ))}
        </div>
      </header>

      <KpiCards
        items={[
          { label: "Members", value: formatCount(community.memberCount), hint: `+${formatCount(community.newMembers30d)} in the last 30 days`, icon: <CommunityIcon />, tone: "blue", trend: { values: series.map((point) => point.newMembers), color: SERIES.newMembers.color } },
          { label: `Posts (${range}d)`, value: formatCount(totals.posts), hint: `${formatCount(community.posts30d)} in the last 30 days`, icon: <ChatIcon />, tone: "green", trend: { values: series.map((point) => point.posts), color: SERIES.posts.color } },
          { label: `Comments (${range}d)`, value: formatCount(totals.comments), hint: `${formatCount(community.comments30d)} in the last 30 days`, icon: <SignupIcon />, tone: "amber", trend: { values: series.map((point) => point.comments), color: SERIES.comments.color } },
          { label: "Open reports", value: formatCount(community.openReports), hint: `${formatCount(totals.reports)} filed in ${range} days`, icon: <AlertIcon />, tone: community.openReports > 0 ? "red" : "neutral", href: community.openReports > 0 ? "/admin/reports" : undefined },
        ]}
        label="Community numbers"
      />

      <div className="admGrid3">
        <ChartCard
          actions={<RangePicker onChange={setRange} value={range} />}
          legend={<ChartLegend series={[SERIES.posts, SERIES.comments]} />}
          empty={totals.posts + totals.comments === 0}
          emptyText={`No posts or comments in the last ${range} days.`}
          subtitle="Posts and comments published each day"
          table={{ columns: ["Day", "Posts", "Comments", "New members", "Reports"], rows: series.map((point) => [shortDate(point.day), point.posts, point.comments, point.newMembers, point.reportsOpened]) }}
          title="Activity"
          tone="green"
        >
          <TrendChart data={series as unknown as Array<Record<string, unknown>>} kind="bar" series={[{ key: "posts", ...SERIES.posts }, { key: "comments", ...SERIES.comments }]} stacked />
        </ChartCard>
        <Card title="About">
          <div className="admCardInset">
            <KeyValue
              items={[
                ["Description", community.description || "No description"],
                ["Owner", <span className="admInline" key="owner"><Avatar name={community.creator.displayName} size="sm" />{community.creator.displayName}</span>],
                ["Visibility", humanize(community.visibility)],
                ["Stage", community.stage ?? "Not set"],
                ["Created", formatDateTime(community.createdAt)],
              ]}
            />
          </div>
        </Card>
      </div>

      <div className="admGrid2">
        <ChartCard
          empty={totals.members === 0}
          emptyText={`Nobody joined in the last ${range} days.`}
          height={200}
          subtitle={`${formatCount(totals.members)} joined in the last ${range} days`}
          table={{ columns: ["Day", "New members"], rows: series.map((point) => [shortDate(point.day), point.newMembers]) }}
          title="New members"
          tone="amber"
        >
          <TrendChart data={series as unknown as Array<Record<string, unknown>>} height={200} kind="bar" series={[{ key: "newMembers", ...SERIES.newMembers }]} />
        </ChartCard>
        <Card flush subtitle={isAdmin ? "Every staff decision about this community, with the reason." : "Only admins can see the staff history."} title="Staff history" tone="navy">
          {!isAdmin ? (
            <p className="admCardEmpty">Ask a platform admin if you need the decision history.</p>
          ) : history.length === 0 ? (
            <p className="admCardEmpty">No staff actions on this community yet.</p>
          ) : (
            <ul className="admActivity">
              {history.map((entry) => (
                <li key={entry.id}>
                  <Avatar name={entry.actor.displayName} size="sm" />
                  <div className="admActivityText">
                    <p><strong>{entry.actor.displayName}</strong> {(AUDIT_ACTIONS[entry.action]?.label ?? humanize(entry.action)).toLowerCase()}</p>
                    <p className="admActivityReason">{entry.reason}</p>
                  </div>
                  <span className={`admActivityKind admTone-${AUDIT_ACTIONS[entry.action]?.tone ?? "neutral"}`}>{entry.action.split(".")[1]}</span>
                  <time dateTime={entry.createdAt} title={formatDateTime(entry.createdAt)}>{formatRelative(entry.createdAt)}</time>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <ReasonDialog onClose={() => setDialog(null)} request={dialog} />
    </>
  );
}

export default function CommunityDetailPage() {
  return (
    <Suspense fallback={<SkeletonRows />}>
      <CommunityView />
    </Suspense>
  );
}
