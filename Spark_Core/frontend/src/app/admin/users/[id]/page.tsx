"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { useAuth } from "../../../auth-context";
import { useAdmin } from "../../_components/admin-context";
import { ChevronIcon } from "../../_components/icons";
import { ReasonDialog, type ReasonRequest } from "../../_components/reason-dialog";
import { canChangeStatus, statusRequest } from "../../_components/user-actions";
import { Avatar, Badge, EmptyState, ErrorBanner, KeyValue, NoAccess, SkeletonRows } from "../../_components/ui";
import { ApiError, adminApi, messageOf, reloadIfStale } from "../../_lib/api";
import { PLATFORM_ROLES, canAccess, canManageRoles } from "../../_lib/access";
import { AUDIT_ACTIONS, ROLE_DESCRIPTIONS, ROLE_LABELS, ROLE_TONES, USER_STATUS, describeAction, formatDate, formatDateTime, formatRelative } from "../../_lib/format";
import type { PlatformRole, UserDetail } from "../../_lib/types";

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
      <nav aria-label="Breadcrumb" className="admBreadcrumb">
        <Link href="/admin/users">Users</Link>
        <ChevronIcon />
        <span aria-current="page">{detail.displayName}</span>
      </nav>

      <header className="admProfileHeader">
        <Avatar name={detail.displayName} size="lg" />
        <div className="admProfileText">
          <h1>{detail.displayName}{isMe ? " (you)" : ""}</h1>
          <p>{detail.email ?? "No email on file"}</p>
          <div className="admBadgeRow">
            <Badge tone={USER_STATUS[detail.status].tone}>{USER_STATUS[detail.status].label}</Badge>
            {detail.platformRoles.map((role) => <Badge key={role} tone={ROLE_TONES[role]}>{ROLE_LABELS[role]}</Badge>)}
          </div>
        </div>
        {!isMe && canChangeStatus(roles, detail) && (
          <button className={`admBtn ${detail.status === "active" ? "admBtnDanger" : "admBtnPrimary"}`} onClick={changeStatus} type="button">
            {detail.status === "active" ? "Suspend user" : "Reactivate user"}
          </button>
        )}
      </header>
      {error && <ErrorBanner message={error} onRetry={reload} />}

      <div className="admSplit">
        <section aria-labelledby="profile-title" className="admCard">
          <h2 className="admSectionTitle" id="profile-title">Account</h2>
          <KeyValue
            items={[
              ["Email", detail.email ? <>{detail.email} {detail.emailVerified ? <Badge tone="green">Verified</Badge> : <Badge>Unverified</Badge>}</> : "None"],
              ["Joined", formatDate(detail.createdAt)],
              ["Last sign-in", detail.lastLoginAt ? `${formatRelative(detail.lastLoginAt)} (${formatDateTime(detail.lastLoginAt)})` : "Never"],
              ["Active sessions", detail.activeSessions],
              ["Workspaces", detail.workspaceCount],
              ["Communities", detail.communityCount],
              ["Locale and time zone", `${detail.locale} · ${detail.timezone}`],
            ]}
          />
        </section>

        <section aria-labelledby="roles-title" className="admCard">
          <h2 className="admSectionTitle" id="roles-title">Platform roles</h2>
          <p className="admMuted admSmall">{manageRoles ? "Every change asks for a reason and is recorded in the audit log." : "Only a super admin can change platform roles."}</p>
          <ul className="admRoleList">
            {PLATFORM_ROLES.map((role) => {
              const grantedAt = held.get(role);
              return (
                <li key={role}>
                  <div>
                    <strong>{ROLE_LABELS[role]}</strong>
                    <span>{ROLE_DESCRIPTIONS[role]}</span>
                    {grantedAt && <span className="admRoleSince">Held since {formatDate(grantedAt)}</span>}
                  </div>
                  {manageRoles ? (
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
                  ) : (
                    grantedAt ? <Badge tone={ROLE_TONES[role]}>Held</Badge> : <span className="admMuted admSmall">Not held</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      <section aria-labelledby="history-title" className="admCard">
        <h2 className="admSectionTitle" id="history-title">Governance history</h2>
        {detail.history.length === 0 ? (
          <p className="admMuted">No staff actions have been taken on this account.</p>
        ) : (
          <ol className="admTimeline">
            {detail.history.map((entry) => (
              <li key={entry.id}>
                <span className={`admTimelineDot admTone-${AUDIT_ACTIONS[entry.action]?.tone ?? "neutral"}`} />
                <div>
                  <p><strong>{describeAction(entry)}</strong> by {entry.actor.displayName}</p>
                  <p className="admMuted">“{entry.reason}” · <time dateTime={entry.createdAt} title={formatDateTime(entry.createdAt)}>{formatRelative(entry.createdAt)}</time></p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
      <ReasonDialog onClose={() => setDialog(null)} request={dialog} />
    </>
  );
}
