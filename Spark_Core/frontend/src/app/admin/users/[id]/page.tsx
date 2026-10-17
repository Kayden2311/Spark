"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { useAuth } from "../../../auth-context";
import { useAdmin } from "../../_components/admin-context";
import { ChartCard, ChartLegend, TrendChart } from "../../_components/charts";
import { ArrowLeftIcon } from "../../_components/icons";
import { ReasonDialog, type ReasonRequest } from "../../_components/reason-dialog";
import { canChangeStatus, statusRequest } from "../../_components/user-actions";
import { Avatar, Badge, EmptyState, ErrorBanner, KeyValue, NoAccess, SkeletonRows, Tag } from "../../_components/ui";
import { ApiError, adminApi, messageOf, reloadIfStale } from "../../_lib/api";
import { PLATFORM_ROLES, canAccess, canManageRoles } from "../../_lib/access";
import { AUDIT_ACTIONS, ROLE_DESCRIPTIONS, ROLE_LABELS, USER_STATUS, describeAction, formatDate, formatDateTime, formatRelative, shortDate } from "../../_lib/format";
import { SERIES } from "../../_lib/palette";
import type { PlatformRole, UserActivityResponse, UserDetail, UserSession } from "../../_lib/types";
import { useAdminData } from "../../_lib/use-admin-data";

export default function UserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user: me, refreshSession } = useAuth();
  const { roles, refreshOverview, notify } = useAdmin();
  const allowed = canAccess(roles, "users");
  const manageRoles = canManageRoles(roles);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [dialog, setDialog] = useState<ReasonRequest | null>(null);
  const [version, setVersion] = useState(0);
  const activity = useAdminData<UserActivityResponse>(allowed ? `/users/${encodeURIComponent(id)}/activity?days=90` : null);
  const sessions = useAdminData<{ items: UserSession[] }>(allowed ? `/users/${encodeURIComponent(id)}/sessions` : null);

  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    adminApi<UserDetail>(`/users/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then((data) => {
        setDetail(data);
        setError(null);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        // 400 means the id in the address is not a valid user id at all.
        if (failure instanceof ApiError && (failure.status === 404 || failure.status === 400)) setNotFound(true);
        else setError(messageOf(failure));
      });
    return () => controller.abort();
  }, [allowed, id, version]);

  const reload = useCallback(() => setVersion((value) => value + 1), []);

  if (!allowed) return <NoAccess />;
  if (notFound) {
    return <EmptyState action={<Link className="admBtn admBtnSecondary" href="/admin/users">Back to users</Link>} title="User not found">This account does not exist or was deleted.</EmptyState>;
  }
  if (error && !detail) return <ErrorBanner message={error} onRetry={reload} />;
  if (!detail) return <SkeletonRows rows={5} />;

  const isMe = detail.id === me?.id;
  const held = new Map(detail.roles.map((entry) => [entry.role, entry.grantedAt]));

  const changeStatus = () =>
    setDialog(statusRequest(detail, (status) => {
      refreshOverview();
      reload();
      notify(status === "suspended" ? `${detail.displayName} suspended and signed out.` : `${detail.displayName} reactivated.`);
    }, reload));

  const changeRole = (role: PlatformRole, grant: boolean) =>
    setDialog({
      title: grant ? `Grant ${ROLE_LABELS[role]}?` : `Revoke ${ROLE_LABELS[role]}?`,
      description: (
        <p>
          {grant ? <>{detail.displayName} will be able to: {ROLE_DESCRIPTIONS[role].toLowerCase()}</> : <>{detail.displayName} loses this access on their next request.</>}
        </p>
      ),
      confirmLabel: grant ? "Grant role" : "Revoke role",
      tone: grant ? "primary" : "danger",
      onConfirm: async (reason) => {
        const request = grant
          ? adminApi(`/users/${detail.id}/roles`, { method: "POST", body: { role, reason } })
          : adminApi(`/users/${detail.id}/roles/${role}`, { method: "DELETE", body: { reason } });
        await request.catch((error: unknown) => reloadIfStale(error, reload));
        reload();
        // Changing your own roles changes what this console may show you.
        if (isMe) void refreshSession();
        notify(grant ? `${ROLE_LABELS[role]} granted.` : `${ROLE_LABELS[role]} revoked.`);
      },
    });

  return (
    <>
      <Link className="admBackLink" href="/admin/users"><ArrowLeftIcon /> All users</Link>

      <header className="admProfileHeader">
        <Avatar name={detail.displayName} size="lg" />
        <div className="admProfileText">
          <h1>{detail.displayName}{isMe ? <span className="admYou">You</span> : null}</h1>
          <p>{detail.email ?? "No email on file"} · Joined {formatDate(detail.createdAt)}</p>
          <div className="admBadgeRow">
            <Badge tone={USER_STATUS[detail.status].tone}>{USER_STATUS[detail.status].label}</Badge>
            {detail.platformRoles.map((role) => <Tag key={role}>{ROLE_LABELS[role]}</Tag>)}
          </div>
        </div>
        {!isMe && canChangeStatus(roles, detail) && (
          <button className={`admBtn ${detail.status === "active" ? "admBtnDangerOutline" : "admBtnPrimary"}`} onClick={changeStatus} type="button">
            {detail.status === "active" ? "Suspend user" : "Reactivate user"}
          </button>
        )}
      </header>
      {error && <ErrorBanner message={error} onRetry={reload} />}

      <div className="admGrid3">
        <ChartCard
          empty={activity.data?.series.every((point) => point.signIns + point.posts + point.comments === 0)}
          emptyText="No sign-ins, posts or comments in the last 90 days."
          error={activity.error}
          height={220}
          legend={<ChartLegend series={[SERIES.signIns, SERIES.posts, SERIES.comments]} />}
          loading={activity.loading && !activity.data}
          onRetry={activity.reload}
          subtitle={activity.data ? `${activity.data.series.reduce((sum, point) => sum + point.signIns, 0)} sign-ins · ${activity.data.series.reduce((sum, point) => sum + point.posts, 0)} posts · ${activity.data.series.reduce((sum, point) => sum + point.comments, 0)} comments in 90 days` : "Last 90 days"}
          table={{ columns: ["Day", "Sign-ins", "Posts", "Comments"], rows: (activity.data?.series ?? []).filter((point) => point.signIns + point.posts + point.comments > 0).map((point) => [shortDate(point.day), point.signIns, point.posts, point.comments]) }}
          title="Activity"
        >
          <TrendChart data={(activity.data?.series ?? []) as unknown as Array<Record<string, unknown>>} height={220} kind="bar" series={[{ key: "signIns", ...SERIES.signIns }, { key: "posts", ...SERIES.posts }, { key: "comments", ...SERIES.comments }]} stacked />
        </ChartCard>
        <section aria-labelledby="sessions-title" className="admCard admCardFlush">
          <div className="admCardHead">
            <div>
              <h2 id="sessions-title">Recent sign-ins</h2>
              <p>The latest sessions and whether they still work.</p>
            </div>
          </div>
          {sessions.error && <div className="admCardInset"><ErrorBanner message={sessions.error} onRetry={sessions.reload} /></div>}
          {!sessions.data && !sessions.error && <div className="admCardInset"><SkeletonRows rows={4} /></div>}
          {sessions.data && sessions.data.items.length === 0 && <p className="admCardEmpty">This account has never signed in.</p>}
          {sessions.data && sessions.data.items.length > 0 && (
            <ul className="admSessionList">
              {sessions.data.items.slice(0, 8).map((session) => (
                <li key={session.id}>
                  <div className="admCellMain">
                    <span className="admCellTitle">{formatDateTime(session.createdAt)}</span>
                    <span className="admCellSub">{session.method === "oauth" ? "Social sign-in" : "Password"} · last seen {formatRelative(session.lastSeenAt)}</span>
                  </div>
                  <Badge tone={session.state === "active" ? "green" : session.state === "revoked" ? "red" : "neutral"}>{session.state === "active" ? "Active" : session.state === "revoked" ? "Signed out" : "Expired"}</Badge>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="admGrid">
        <section aria-labelledby="profile-title" className="admCard">
          <div className="admCardHead">
            <div>
              <h2 id="profile-title">Account</h2>
              <p>Sign-in and membership details.</p>
            </div>
          </div>
          <KeyValue
            items={[
              ["Email", detail.email ? <span className="admInline">{detail.email}{detail.emailVerified ? <Badge tone="green">Verified</Badge> : <Badge>Unverified</Badge>}</span> : "None"],
              ["Last sign-in", detail.lastLoginAt ? <span title={formatDateTime(detail.lastLoginAt)}>{formatRelative(detail.lastLoginAt)}</span> : "Never"],
              ["Active sessions", detail.activeSessions],
              ["Workspaces", detail.workspaceCount],
              ["Communities", detail.communityCount],
              ["Locale", detail.locale],
              ["Time zone", detail.timezone],
            ]}
          />
        </section>

        <section aria-labelledby="roles-title" className="admCard">
          <div className="admCardHead">
            <div>
              <h2 id="roles-title">Platform roles</h2>
              <p>{manageRoles ? "Every change asks for a reason and is recorded in the audit log." : "Only a super admin can change platform roles."}</p>
            </div>
          </div>
          <ul className="admRoleList">
            {PLATFORM_ROLES.map((role) => {
              const grantedAt = held.get(role);
              return (
                <li key={role}>
                  <div>
                    <strong>{ROLE_LABELS[role]}{grantedAt && <Badge tone="blue">Held</Badge>}</strong>
                    <span>{ROLE_DESCRIPTIONS[role]}</span>
                    {grantedAt && <span className="admRoleSince">Since {formatDate(grantedAt)}</span>}
                  </div>
                  {manageRoles && (
                    <button
                      aria-label={`${grantedAt ? "Revoke" : "Grant"} ${ROLE_LABELS[role]}`}
                      className={`admBtn admBtnSm ${grantedAt ? "admBtnDangerOutline" : "admBtnSecondary"}`}
                      disabled={!grantedAt && detail.status !== "active"}
                      onClick={() => changeRole(role, !grantedAt)}
                      title={!grantedAt && detail.status !== "active" ? "Reactivate the user before granting roles" : undefined}
                      type="button"
                    >
                      {grantedAt ? "Revoke" : "Grant"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      <section aria-labelledby="history-title" className="admCard admCardFlush">
        <div className="admCardHead">
          <div>
            <h2 id="history-title">Governance history</h2>
            <p>Staff actions taken on this account, newest first.</p>
          </div>
        </div>
        {detail.history.length === 0 ? (
          <p className="admCardEmpty">No staff actions have been taken on this account.</p>
        ) : (
          <ul className="admActivity">
            {detail.history.map((entry) => (
              <li key={entry.id}>
                <Avatar name={entry.actor.displayName} size="sm" />
                <div className="admActivityText">
                  <p><strong>{entry.actor.displayName}</strong> {describeAction(entry).toLowerCase()}</p>
                  <p className="admActivityReason">{entry.reason}</p>
                </div>
                <span className={`admActivityKind admTone-${AUDIT_ACTIONS[entry.action]?.tone ?? "neutral"}`}>{entry.action.split(".")[0]}</span>
                <time dateTime={entry.createdAt} title={formatDateTime(entry.createdAt)}>{formatRelative(entry.createdAt)}</time>
              </li>
            ))}
          </ul>
        )}
      </section>
      <ReasonDialog onClose={() => setDialog(null)} request={dialog} />
    </>
  );
}
