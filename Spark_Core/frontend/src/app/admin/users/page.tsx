"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useState } from "react";

import { useAuth } from "../../auth-context";
import { useAdmin } from "../_components/admin-context";
import { ChartCard, DonutChart, InlineBar } from "../_components/charts";
import { AlertIcon, BoardIcon, ListIcon, SearchIcon, SignupIcon, UserIcon } from "../_components/icons";
import { ReasonDialog, type ReasonRequest } from "../_components/reason-dialog";
import { Avatar, Badge, EmptyState, ErrorBanner, FilterTabs, KpiCards, LoadMore, NoAccess, PageHeader, Panel, RoleSummary, RowMenu, Segmented, SkeletonRows } from "../_components/ui";
import { query } from "../_lib/api";
import { PLATFORM_ROLES, canAccess } from "../_lib/access";
import { ROLE_LABELS, USER_STATUS, formatCount, formatDate, formatRelative } from "../_lib/format";
import { CATEGORICAL, SERIES } from "../_lib/palette";
import type { ActivityResponse, Page, PlatformRole, UserStatus, UserSummary } from "../_lib/types";
import { useAdminData } from "../_lib/use-admin-data";
import { usePagedList } from "../_lib/use-paged-list";
import { canChangeStatus, statusRequest } from "../_components/user-actions";
import { useDebounced, useQueryState } from "../_lib/use-query-state";
import { RolesMatrix } from "./roles-matrix";

type StatusFilter = "all" | UserStatus;
const STATUS_FILTERS: readonly StatusFilter[] = ["all", "active", "suspended"];
const ROLE_FILTERS: readonly ("any" | PlatformRole)[] = ["any", ...PLATFORM_ROLES];

function useHolderCount(role: PlatformRole) {
  return useAdminData<Page<UserSummary>>(`/users?role=${role}&limit=100`);
}

/** Who holds each platform role right now. An account can hold more than one, so this totals role
 * grants, not staff headcount — the subtitle and center label say so rather than imply otherwise. */
function RoleMix() {
  // PLATFORM_ROLES is a fixed 5-role tuple, so these are named one by one rather than mapped —
  // calling a hook inside a loop or .map() would break React's rules of hooks.
  const holders = [
    useHolderCount("super_admin"),
    useHolderCount("platform_admin"),
    useHolderCount("community_moderator"),
    useHolderCount("content_moderator"),
    useHolderCount("campaign_moderator"),
  ];
  const loading = holders.some((holder) => !holder.data);
  const mix = PLATFORM_ROLES.map((role, index) => ({ label: ROLE_LABELS[role], value: holders[index]!.data?.items.length ?? 0, color: CATEGORICAL[index % CATEGORICAL.length] }));
  const total = mix.reduce((sum, item) => sum + item.value, 0);
  return (
    <ChartCard
      empty={!loading && total === 0}
      height={200}
      loading={loading}
      subtitle="Role grants right now; an account can hold more than one"
      table={{ columns: ["Role", "Holders"], rows: mix.map((item) => [item.label, item.value]) }}
      title="Platform roles"
    >
      <DonutChart centerLabel="role grants" centerValue={formatCount(total)} data={mix} height={180} />
    </ChartCard>
  );
}

/** One person, HR-directory style: a face, a name, their roles and status — the facts you'd scan a
 * roster for, not a row of columns. The overflow menu carries the same actions the table row did. */
function PersonCard({ user, self, canChange, onViewDetails, onChangeStatus }: {
  user: UserSummary;
  self: boolean;
  canChange: boolean;
  onViewDetails: () => void;
  onChangeStatus: () => void;
}) {
  const risk = user.risk;
  const riskTotal = risk ? risk.reportsAgainst + risk.hiddenPosts + risk.hiddenComments : 0;
  return (
    <li className="admPersonCard">
      <div className="admPersonCardMenu">
        <RowMenu
          actions={[
            { label: "View details", onSelect: onViewDetails },
            ...(canChange
              ? [{ label: user.status === "active" ? "Suspend user" : "Reactivate user", tone: user.status === "active" ? ("danger" as const) : undefined, separated: true, onSelect: onChangeStatus }]
              : []),
          ]}
          label={`Actions for ${user.displayName}`}
        />
      </div>
      <Link className="admPersonCardLink" href={`/admin/users/${user.id}`}>
        <Avatar name={user.displayName} size="lg" />
        <span className="admPersonCardName">{user.displayName}{self && <span className="admYou">You</span>}</span>
        <span className="admPersonCardEmail">{user.email ?? "No email"}</span>
      </Link>
      <RoleSummary roles={user.platformRoles} />
      <div className="admPersonCardFoot">
        <Badge tone={USER_STATUS[user.status].tone}>{USER_STATUS[user.status].label}</Badge>
        {riskTotal > 0 && (
          <span className="admPersonCardRisk">
            <InlineBar color={riskTotal > 3 ? "#ef4444" : "#f59e0b"} ratio={riskTotal / 6} title={`${risk!.reportsAgainst} ${risk!.reportsAgainst === 1 ? "report" : "reports"} · ${risk!.hiddenPosts + risk!.hiddenComments} hidden`} />
          </span>
        )}
        <span className="admPersonCardMeta">{user.lastLoginAt ? `Active ${formatRelative(user.lastLoginAt)}` : "Never signed in"}</span>
      </div>
    </li>
  );
}

function UsersList() {
  const { user: me } = useAuth();
  const router = useRouter();
  const { roles, overview, refreshOverview, notify } = useAdmin();
  const allowed = canAccess(roles, "users");
  const [status, setStatus] = useQueryState<StatusFilter>("status", "all", STATUS_FILTERS);
  const [role, setRole] = useQueryState<"any" | PlatformRole>("role", "any", ROLE_FILTERS);
  const [view, setView] = useQueryState<"directory" | "roles">("view", "directory", ["directory", "roles"]);
  const [layout, setLayout] = useQueryState<"cards" | "table">("layout", "cards", ["cards", "table"]);
  const [search, setSearch] = useState("");
  const settledSearch = useDebounced(search.trim());
  const list = usePagedList<UserSummary>(
    allowed && view === "directory" ? `/users${query({ status: status === "all" ? undefined : status, role: role === "any" ? undefined : role, search: settledSearch })}` : null,
  );
  const [dialog, setDialog] = useState<ReasonRequest | null>(null);
  const growth = useAdminData<ActivityResponse>(allowed ? "/analytics/activity?days=30" : null);

  if (!allowed) return <NoAccess />;
  const viewSwitch = <Segmented label="Users view" onChange={setView} options={[{ value: "directory", label: "Directory" }, { value: "roles", label: "Roles & access" }]} value={view} />;
  if (view === "roles") {
    return (
      <>
        <PageHeader actions={viewSwitch} description="What each platform role can do and who holds it." title="Users" />
        <RolesMatrix />
      </>
    );
  }
  const audience = growth.data?.audience;

  const changeStatus = (user: UserSummary) =>
    setDialog(statusRequest(user, (next) => {
      list.update(user.id, (item) => (status === "all" || status === next ? { ...item, status: next } : null));
      refreshOverview();
      notify(next === "suspended" ? `${user.displayName} suspended and signed out.` : `${user.displayName} reactivated.`);
    }, list.reload));

  const layoutSwitch = <Segmented label="Directory layout" onChange={setLayout} options={[{ value: "cards", label: "Cards", icon: <BoardIcon /> }, { value: "table", label: "Table", icon: <ListIcon /> }]} value={layout} />;

  return (
    <>
      <PageHeader actions={<>{viewSwitch}{layoutSwitch}</>} description="See how membership is growing, find any account, and act on risky ones." title="Users" />

      <KpiCards
        items={[
          {
            label: "New members (30d)",
            value: growth.data ? formatCount(growth.data.current.signups) : undefined,
            change: growth.data ? { current: growth.data.current.signups, previous: growth.data.previous?.signups } : undefined,
            icon: <SignupIcon />,
            tone: "amber",
            trend: { values: growth.data?.series.map((point) => point.signups) ?? [], color: SERIES.signups.color },
          },
          { label: "Active accounts", value: overview ? formatCount(overview.users.active) : undefined, hint: audience ? `${formatCount(audience.mau)} active in the last 30 days` : undefined, icon: <UserIcon />, tone: "blue" },
          { label: "Suspended", value: overview ? formatCount(overview.users.suspended) : undefined, hint: "Signed out and blocked", icon: <AlertIcon />, tone: "red", href: "/admin/users?status=suspended" },
        ]}
        label="Membership"
      />

      <RoleMix />

      {list.error && <ErrorBanner message={list.error} onRetry={list.reload} />}
      <Panel
        footer={!list.loading && list.items.length > 0 ? <LoadMore hasMore={list.hasMore} loading={list.loadingMore} noun="user" onClick={() => void list.loadMore()} shown={list.items.length} /> : undefined}
        label="Users"
        tabs={
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
        }
        tools={
          <>
            <label className="admSearch">
              <SearchIcon />
              <span className="admSrOnly">Search users</span>
              <input onChange={(event) => setSearch(event.target.value)} placeholder="Search name or email" type="search" value={search} />
            </label>
            <label className="admSelect">
              <span className="admSrOnly">Platform role</span>
              <select onChange={(event) => setRole(event.target.value as "any" | PlatformRole)} value={role}>
                <option value="any">All roles</option>
                {PLATFORM_ROLES.map((value) => <option key={value} value={value}>{ROLE_LABELS[value]}</option>)}
              </select>
            </label>
          </>
        }
      >
        {list.loading ? (
          <SkeletonRows />
        ) : list.items.length === 0 && !list.error ? (
          <EmptyState title="No users match">Try a different name, email, status or role.</EmptyState>
        ) : layout === "cards" ? (
          <ul className="admPersonGrid">
            {list.items.map((user) => (
              <PersonCard
                canChange={user.id !== me?.id && canChangeStatus(roles, user)}
                key={user.id}
                onChangeStatus={() => changeStatus(user)}
                onViewDetails={() => router.push(`/admin/users/${user.id}`)}
                self={user.id === me?.id}
                user={user}
              />
            ))}
          </ul>
        ) : (
          <table className="admTable">
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Platform roles</th>
                <th scope="col">Status</th>
                <th scope="col">Signals</th>
                <th scope="col">Last sign-in</th>
                <th scope="col">Joined</th>
                <th scope="col"><span className="admSrOnly">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((user) => {
                const canChange = user.id !== me?.id && canChangeStatus(roles, user);
                return (
                  <tr key={user.id}>
                    <td data-label="User">
                      <Link className="admPerson" href={`/admin/users/${user.id}`}>
                        <Avatar name={user.displayName} />
                        <span className="admCellMain">
                          <span className="admCellTitle">{user.displayName}{user.id === me?.id ? <span className="admYou">You</span> : null}</span>
                          <span className="admCellSub">{user.email ?? "No email"}</span>
                        </span>
                      </Link>
                    </td>
                    <td data-label="Roles">
                      <RoleSummary roles={user.platformRoles} />
                    </td>
                    <td data-label="Status"><Badge tone={USER_STATUS[user.status].tone}>{USER_STATUS[user.status].label}</Badge></td>
                    <td data-label="Signals">
                      {user.risk && (user.risk.reportsAgainst > 0 || user.risk.hiddenPosts + user.risk.hiddenComments > 0) ? (
                        <div className="admCellMain">
                          <div className="admTagRow">
                            {user.risk.reportsAgainst > 0 && <Badge tone={user.risk.reportsAgainst > 2 ? "red" : "amber"}>{user.risk.reportsAgainst} {user.risk.reportsAgainst === 1 ? "report" : "reports"}</Badge>}
                            {user.risk.hiddenPosts + user.risk.hiddenComments > 0 && <Badge tone="red">{user.risk.hiddenPosts + user.risk.hiddenComments} hidden</Badge>}
                          </div>
                          <InlineBar
                            color={user.risk.reportsAgainst + user.risk.hiddenPosts + user.risk.hiddenComments > 3 ? "#ef4444" : "#f59e0b"}
                            ratio={(user.risk.reportsAgainst + user.risk.hiddenPosts + user.risk.hiddenComments) / 6}
                            title={`${user.risk.reportsAgainst} ${user.risk.reportsAgainst === 1 ? "report" : "reports"} · ${user.risk.hiddenPosts + user.risk.hiddenComments} hidden`}
                          />
                        </div>
                      ) : <span className="admMutedCell">None</span>}
                    </td>
                    <td className="admNowrap admMutedCell" data-label="Last sign-in">{formatRelative(user.lastLoginAt)}</td>
                    <td className="admNowrap admMutedCell" data-label="Joined">{formatDate(user.createdAt)}</td>
                    <td className="admCellActions">
                      <RowMenu
                        actions={[
                          { label: "View details", onSelect: () => router.push(`/admin/users/${user.id}`) },
                          ...(canChange
                            ? [{ label: user.status === "active" ? "Suspend user" : "Reactivate user", tone: user.status === "active" ? ("danger" as const) : undefined, separated: true, onSelect: () => changeStatus(user) }]
                            : []),
                        ]}
                        label={`Actions for ${user.displayName}`}
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

export default function UsersAdminPage() {
  return (
    <Suspense fallback={<SkeletonRows />}>
      <UsersList />
    </Suspense>
  );
}
