"use client";

import Link from "next/link";
import { Fragment } from "react";

import { CheckIcon } from "../_components/icons";
import { Card } from "../_components/ui";
import { PLATFORM_ROLES } from "../_lib/access";
import { ROLE_DESCRIPTIONS, ROLE_LABELS, formatCount } from "../_lib/format";
import type { Page, PlatformRole, UserSummary } from "../_lib/types";
import { useAdminData } from "../_lib/use-admin-data";

type Capability = { label: string; detail: string; roles: PlatformRole[] };

const ADMINS: PlatformRole[] = ["super_admin", "platform_admin"];

// Mirrors the API's role checks (src/routes/admin/*) and the staff functions in the database, which enforce them.
const GROUPS: Array<{ title: string; items: Capability[] }> = [
  {
    title: "Moderation",
    items: [
      { label: "Resolve reported content", detail: "Hide, keep or dismiss, with a reason", roles: [...ADMINS, "content_moderator"] },
      { label: "Moderate communities", detail: "Feature, freeze, archive or restore", roles: [...ADMINS, "community_moderator"] },
      { label: "Review sponsored campaigns", detail: "Approve or reject, with a reason", roles: [...ADMINS, "campaign_moderator"] },
    ],
  },
  {
    title: "Administration",
    items: [
      { label: "Suspend or reactivate accounts", detail: "Admin-tier accounts need a super admin", roles: ADMINS },
      { label: "Grant or revoke platform roles", detail: "Every change is audited", roles: ["super_admin"] },
      { label: "Analytics and system health", detail: "Engagement, API, database and Redis", roles: ADMINS },
      { label: "Billing insights", detail: "Read-only revenue and invoices", roles: ADMINS },
      { label: "Audit log and CSV export", detail: "Every staff decision and reason", roles: ADMINS },
    ],
  },
];

function useHolders(role: PlatformRole) {
  return useAdminData<Page<UserSummary>>(`/users?role=${role}&limit=100`);
}

function HolderCount({ role }: { role: PlatformRole }) {
  const holders = useHolders(role);
  if (!holders.data) return <span className="admMutedCell">–</span>;
  const count = holders.data.items.length;
  return (
    <Link className="admTextLink" href={`/admin/users?role=${role}`}>
      {formatCount(count)}{holders.data.nextCursor ? "+" : ""} {count === 1 ? "person" : "people"}
    </Link>
  );
}

/** What each platform role can do, checked end to end against the API, and who holds it. */
export function RolesMatrix() {
  return (
    <Card flush subtitle="Every action is enforced twice: by the API and again by the database. Staff also see the overview and their own queues." title="Roles and access">
      <div className="admMatrixWrap">
        <table className="admMatrix">
          <thead>
            <tr>
              <th scope="col">Capability</th>
              {PLATFORM_ROLES.map((role) => (
                <th key={role} scope="col" title={ROLE_DESCRIPTIONS[role]}>
                  <span className="admMatrixRole">{ROLE_LABELS[role]}</span>
                  <HolderCount role={role} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {GROUPS.map((group) => (
              <Fragment key={group.title}>
                <tr className="admGroupRow"><th colSpan={PLATFORM_ROLES.length + 1} scope="colgroup">{group.title}</th></tr>
                {group.items.map((item) => (
                  <tr key={item.label}>
                    <th scope="row">
                      <span className="admCellTitle">{item.label}</span>
                      <span className="admCellSub">{item.detail}</span>
                    </th>
                    {PLATFORM_ROLES.map((role) => (
                      <td key={role}>
                        {item.roles.includes(role)
                          ? <span className="admAllowed"><CheckIcon aria-hidden="true" /><span className="admSrOnly">Allowed</span></span>
                          : <span className="admDenied"><span aria-hidden="true">–</span><span className="admSrOnly">Not allowed</span></span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
