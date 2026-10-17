"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useAuth } from "../auth-context";
import { useAdmin } from "./_components/admin-context";
import { ChevronIcon, CommunityIcon, FlagIcon, MegaphoneIcon } from "./_components/icons";
import { Avatar, Badge, ErrorBanner, KeyValue, KpiStrip, PageHeader, SkeletonRows } from "./_components/ui";
import { adminApi, messageOf } from "./_lib/api";
import { canAccess } from "./_lib/access";
import { AUDIT_ACTIONS, describeAction, formatDateTime, formatDuration, formatRelative } from "./_lib/format";
import type { AuditEntry, Page, SystemStatus } from "./_lib/types";

function greeting(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default function AdminOverviewPage() {
  const { user } = useAuth();
  const { roles, overview, refreshOverview } = useAdmin();
  const isAdmin = canAccess(roles, "audit");
  const [activity, setActivity] = useState<AuditEntry[] | null>(null);
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    const controller = new AbortController();
    Promise.all([
      adminApi<Page<AuditEntry>>("/audit-logs?limit=8", { signal: controller.signal }),
      adminApi<SystemStatus>("/system", { signal: controller.signal }),
    ])
      .then(([audit, status]) => {
        setActivity(audit.items);
        setSystem(status);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(messageOf(failure));
      });
    return () => controller.abort();
  }, [isAdmin]);

  const queues = [
    { section: "reports" as const, label: "Reported content", detail: "Posts and comments waiting for a decision", value: overview?.reports.open, href: "/admin/reports", icon: <FlagIcon />, tone: "amber" as const },
    { section: "communities" as const, label: "Flagged communities", detail: "Communities with open reports", value: overview?.communities.flagged, href: "/admin/communities?status=flagged", icon: <CommunityIcon />, tone: "red" as const },
    { section: "campaigns" as const, label: "Campaign reviews", detail: "Sponsored promotions awaiting approval", value: overview?.campaigns.pending, href: "/admin/campaigns", icon: <MegaphoneIcon />, tone: "violet" as const },
  ].filter((queue) => canAccess(roles, queue.section));
  const waiting = queues.reduce((total, queue) => total + (queue.value ?? 0), 0);

  return (
    <>
      <PageHeader
        actions={<button className="admBtn admBtnSecondary admBtnSm" onClick={refreshOverview} type="button">Refresh</button>}
        description={`${greeting(new Date().getHours())}, ${user?.displayName?.split(" ")[0] ?? "there"}. Here is what needs a decision across Spark.`}
        title="Overview"
      />

      <KpiStrip
        items={[
          { label: "Active users", value: overview?.users.active, hint: overview ? `${overview.users.suspended} suspended` : undefined, href: canAccess(roles, "users") ? "/admin/users" : undefined },
          { label: "Live communities", value: overview?.communities.active, hint: overview ? `${overview.communities.featured} featured · ${overview.communities.frozen} frozen` : undefined, href: canAccess(roles, "communities") ? "/admin/communities" : undefined },
          { label: "Workspaces", value: overview?.workspaces.active, hint: "Active team workspaces" },
          { label: "Approved campaigns", value: overview?.campaigns.approved, hint: overview ? `${overview.campaigns.pending} awaiting review` : undefined },
        ]}
        label="Platform summary"
      />

      <div className="admGrid">
        <section aria-labelledby="attention-title" className="admCard">
          <div className="admCardHead">
            <div>
              <h2 id="attention-title">Needs attention</h2>
              <p>{overview ? (waiting === 0 ? "All queues are clear." : `${waiting} ${waiting === 1 ? "item is" : "items are"} waiting across your queues.`) : "Loading your queues…"}</p>
            </div>
          </div>
          <ul className="admQueueList">
            {queues.map((queue) => (
              <li key={queue.section}>
                <Link className="admQueueRow" href={queue.href}>
                  <span className={`admQueueIcon admTone-${queue.tone}`}>{queue.icon}</span>
                  <span className="admQueueText">
                    <strong>{queue.label}</strong>
                    <span>{queue.detail}</span>
                  </span>
                  {queue.value === undefined ? <span className="admQueueCount">–</span> : queue.value > 0
                    ? <Badge tone={queue.tone}>{queue.value} open</Badge>
                    : <Badge tone="green">Clear</Badge>}
                  <ChevronIcon className="admQueueArrow" />
                </Link>
              </li>
            ))}
          </ul>
        </section>

        {isAdmin && (
          <section aria-labelledby="system-title" className="admCard">
            <div className="admCardHead">
              <div>
                <h2 id="system-title">API health</h2>
                <p>{system ? `Checked ${formatRelative(system.checkedAt)}` : "Checking…"}</p>
              </div>
              {system && <Badge tone="green">Operational</Badge>}
            </div>
            {system ? (
              <KeyValue
                items={[
                  ["Active sessions", system.activeSessions.toLocaleString("en-US")],
                  ["API uptime", formatDuration(system.uptimeSeconds)],
                  ["Audit entries", overview?.auditEvents.toLocaleString("en-US") ?? "–"],
                  ["Runtime", `Node.js ${system.nodeVersion.replace(/^v/u, "")}`],
                ]}
              />
            ) : (
              !error && <SkeletonRows rows={3} />
            )}
            <p className="admCardNote">Reported by the API process that answered this request.</p>
          </section>
        )}
      </div>

      {isAdmin && (
        <section aria-labelledby="activity-title" className="admCard admCardFlush">
          <div className="admCardHead">
            <div>
              <h2 id="activity-title">Recent activity</h2>
              <p>The latest governance actions by staff.</p>
            </div>
            <Link className="admBtn admBtnSecondary admBtnSm" href="/admin/audit">View audit log</Link>
          </div>
          {error && <div className="admCardInset"><ErrorBanner message={error} /></div>}
          {!activity && !error && <div className="admCardInset"><SkeletonRows rows={4} /></div>}
          {activity && activity.length === 0 && <p className="admCardEmpty">No governance actions yet. Every action you take will appear here.</p>}
          {activity && activity.length > 0 && (
            <ul className="admActivity">
              {activity.map((entry) => (
                <li key={entry.id}>
                  <Avatar name={entry.actor.displayName} size="sm" />
                  <div className="admActivityText">
                    <p><strong>{entry.actor.displayName}</strong> {describeAction(entry).toLowerCase()} <strong>{entry.target.label}</strong></p>
                    <p className="admActivityReason">{entry.reason}</p>
                  </div>
                  <span className={`admActivityKind admTone-${AUDIT_ACTIONS[entry.action]?.tone ?? "neutral"}`}>{entry.target.type}</span>
                  <time dateTime={entry.createdAt} title={formatDateTime(entry.createdAt)}>{formatRelative(entry.createdAt)}</time>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
