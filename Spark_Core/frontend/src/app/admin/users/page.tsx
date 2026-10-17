"use client";

import Link from "next/link";
import { Suspense, useState } from "react";

import { useAuth } from "../../auth-context";
import { useAdmin } from "../_components/admin-context";
import { SearchIcon } from "../_components/icons";
import { ReasonDialog, type ReasonRequest } from "../_components/reason-dialog";
import { Avatar, Badge, EmptyState, ErrorBanner, FilterTabs, LoadMore, NoAccess, PageHeader, SkeletonRows } from "../_components/ui";
import { query } from "../_lib/api";
import { PLATFORM_ROLES, canAccess } from "../_lib/access";
import { ROLE_LABELS, ROLE_TONES, USER_STATUS, formatDate, formatRelative } from "../_lib/format";
import type { PlatformRole, UserStatus, UserSummary } from "../_lib/types";
import { usePagedList } from "../_lib/use-paged-list";
import { canChangeStatus, statusRequest } from "../_components/user-actions";
import { useDebounced, useQueryState } from "../_lib/use-query-state";

type StatusFilter = "all" | UserStatus;
const STATUS_FILTERS: readonly StatusFilter[] = ["all", "active", "suspended"];
const ROLE_FILTERS: readonly ("any" | PlatformRole)[] = ["any", ...PLATFORM_ROLES];

function UsersList() {
  const { user: me } = useAuth();
  const { roles, overview, refreshOverview, notify } = useAdmin();
  const allowed = canAccess(roles, "users");
  const [status, setStatus] = useQueryState<StatusFilter>("status", "all", STATUS_FILTERS);
  const [role, setRole] = useQueryState<"any" | PlatformRole>("role", "any", ROLE_FILTERS);
  const [search, setSearch] = useState("");
  const settledSearch = useDebounced(search.trim());
  const list = usePagedList<UserSummary>(
    allowed ? `/users${query({ status: status === "all" ? undefined : status, role: role === "any" ? undefined : role, search: settledSearch })}` : null,
  );
  const [dialog, setDialog] = useState<ReasonRequest | null>(null);

  if (!allowed) return <NoAccess />;

  const changeStatus = (user: UserSummary) =>
    setDialog(statusRequest(user, (next) => {
      list.update(user.id, (item) => (status === "all" || status === next ? { ...item, status: next } : null));
      refreshOverview();
      notify(next === "suspended" ? `${user.displayName} suspended and signed out.` : `${user.displayName} reactivated.`);
    }, list.reload));

  return (
    <>
      <PageHeader eyebrow="Administration" title="Users" description="Find any account, review its platform roles, and suspend or reactivate it." />

      <div className="admToolbar">
        <FilterTabs
          label="Account status"
          onChange={setStatus}
          options={STATUS_FILTERS.map((value) => ({
            value,
            label: value === "all" ? "All" : USER_STATUS[value].label,
            count: value === "active" ? overview?.users.active : value === "suspended" ? overview?.users.suspended : undefined,
          }))}
          value={status}
        />
        <div className="admToolbarFields">
          <label className="admSearch">
            <SearchIcon />
            <span className="admSrOnly">Search users</span>
            <input onChange={(event) => setSearch(event.target.value)} placeholder="Search by name or email" type="search" value={search} />
          </label>
          <label className="admSelect">
            <span className="admSrOnly">Platform role</span>
            <select onChange={(event) => setRole(event.target.value as "any" | PlatformRole)} value={role}>
              <option value="any">Any role</option>
              {PLATFORM_ROLES.map((value) => <option key={value} value={value}>{ROLE_LABELS[value]}</option>)}
            </select>
          </label>
        </div>
      </div>

      {list.error && <ErrorBanner message={list.error} onRetry={list.reload} />}
      {list.loading ? (
        <SkeletonRows />
      ) : list.items.length === 0 && !list.error ? (
        <EmptyState title="No users match">Try a different name, email, status or role.</EmptyState>
      ) : (
        <div className="admTableCard">
          <table className="admTable">
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Platform roles</th>
                <th scope="col">Status</th>
                <th scope="col">Last sign-in</th>
                <th scope="col">Joined</th>
                <th scope="col"><span className="admSrOnly">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((user) => (
                <tr key={user.id}>
                  <td data-label="User">
                    <Link className="admPerson" href={`/admin/users/${user.id}`}>
                      <Avatar name={user.displayName} />
                      <span className="admCellMain">
                        <span className="admCellTitle">{user.displayName}{user.id === me?.id ? " (you)" : ""}</span>
                        <span className="admCellSub">{user.email ?? "No email"}</span>
                      </span>
                    </Link>
                  </td>
                  <td data-label="Roles">
                    {user.platformRoles.length === 0 ? <span className="admMuted">Member</span> : (
                      <div className="admBadgeRow">{user.platformRoles.map((value) => <Badge key={value} tone={ROLE_TONES[value]}>{ROLE_LABELS[value]}</Badge>)}</div>
                    )}
                  </td>
                  <td data-label="Status"><Badge tone={USER_STATUS[user.status].tone}>{USER_STATUS[user.status].label}</Badge></td>
                  <td className="admNowrap" data-label="Last sign-in">{formatRelative(user.lastLoginAt)}</td>
                  <td className="admNowrap" data-label="Joined">{formatDate(user.createdAt)}</td>
                  <td className="admCellActions">
                    <div className="admActionGroup">
                      <Link className="admBtn admBtnSecondary admBtnSm" href={`/admin/users/${user.id}`}>Details</Link>
                      {user.id !== me?.id && canChangeStatus(roles, user) && (
                        <button
                          aria-label={`${user.status === "active" ? "Suspend" : "Reactivate"} ${user.displayName}`}
                          className={`admBtn admBtnSm ${user.status === "active" ? "admBtnDangerOutline" : "admBtnSecondary"}`}
                          onClick={() => changeStatus(user)}
                          type="button"
                        >
                          {user.status === "active" ? "Suspend" : "Reactivate"}
                        </button>
                      )}
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

export default function UsersAdminPage() {
  return (
    <Suspense fallback={<SkeletonRows />}>
      <UsersList />
    </Suspense>
  );
}
