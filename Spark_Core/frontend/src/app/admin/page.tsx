"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useAuth } from "../auth-context";
import { useAdmin } from "./_components/admin-context";
import { AuditIcon, ChevronIcon, ClockIcon, CommunityIcon, FlagIcon, MegaphoneIcon, PulseIcon, ShieldIcon, UserIcon } from "./_components/icons";
import { Badge, ErrorBanner, PageHeader, SkeletonRows, StatTile } from "./_components/ui";
import { adminApi, messageOf } from "./_lib/api";
import { canAccess } from "./_lib/access";
import { AUDIT_ACTIONS, describeAction, formatDuration, formatRelative } from "./_lib/format";
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
      adminApi<Page<AuditEntry>>("/audit-logs?limit=6", { signal: controller.signal }),
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
    { section: "reports" as const, label: "Open reports", value: overview?.reports.open, href: "/admin/reports", icon: <FlagIcon />, tone: "amber" as const, empty: "No reports waiting" },
    { section: "communities" as const, label: "Flagged communities", value: overview?.communities.flagged, href: "/admin/communities?status=flagged", icon: <CommunityIcon />, tone: "red" as const, empty: "No community has open reports" },
    { section: "campaigns" as const, label: "Campaigns to review", value: overview?.campaigns.pending, href: "/admin/campaigns", icon: <MegaphoneIcon />, tone: "violet" as const, empty: "No campaigns waiting" },
  ].filter((queue) => canAccess(roles, queue.section));

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title={`${greeting(new Date().getHours())}, ${user?.displayName?.split(" ")[0] ?? "there"}`}
        description="What needs a decision across Spark today, and the latest actions your team took."
      />

      <section aria-labelledby="attention-title" className="admSection">
        <h2 className="admSectionTitle" id="attention-title">Needs attention</h2>
        <div className="admQueueGrid">
          {queues.map((queue) => (
            <Link className="admQueue" href={queue.href} key={queue.section}>
              <span className={`admStatIcon admTone-${queue.tone}`}>{queue.icon}</span>
              <span className="admQueueText">
                <strong>{queue.value === undefined ? "–" : queue.value}</strong>
                <span>{queue.value === 0 ? queue.empty : queue.label}</span>
              </span>
              <ChevronIcon className="admQueueArrow" />
            </Link>
          ))}
        </div>
      </section>

      <section aria-labelledby="platform-title" className="admSection">
        <div className="admSectionHead">
          <h2 className="admSectionTitle" id="platform-title">Platform at a glance</h2>
          <button className="admBtn admBtnGhost admBtnSm" onClick={refreshOverview} type="button">Refresh</button>
        </div>
        {overview ? (
          <div className="admStatGrid">
            <StatTile icon={<UserIcon />} label="Active users" tone="blue" value={overview.users.active} hint={`${overview.users.suspended} suspended`} href={canAccess(roles, "users") ? "/admin/users" : undefined} />
            <StatTile icon={<CommunityIcon />} label="Live communities" tone="green" value={overview.communities.active} hint={`${overview.communities.featured} featured · ${overview.communities.frozen} frozen`} href={canAccess(roles, "communities") ? "/admin/communities" : undefined} />
            <StatTile icon={<ShieldIcon />} label="Workspaces" tone="navy" value={overview.workspaces.active} hint="Active team workspaces" />
            <StatTile icon={<MegaphoneIcon />} label="Approved campaigns" tone="violet" value={overview.campaigns.approved} hint={`${overview.campaigns.pending} waiting for review`} />
          </div>
        ) : (
          <SkeletonRows rows={2} />
        )}
      </section>

      {isAdmin && (
        <div className="admSplit">
          <section aria-labelledby="activity-title" className="admCard">
            <div className="admCardHead">
              <h2 className="admSectionTitle" id="activity-title">Recent activity</h2>
              <Link className="admTextLink" href="/admin/audit">Open audit log</Link>
            </div>
            {error && <ErrorBanner message={error} />}
            {!activity && !error && <SkeletonRows rows={4} />}
            {activity && activity.length === 0 && <p className="admMuted">No governance actions yet. Every action you take will appear here.</p>}
            {activity && activity.length > 0 && (
              <ol className="admTimeline">
                {activity.map((entry) => (
                  <li key={entry.id}>
                    <span className={`admTimelineDot admTone-${AUDIT_ACTIONS[entry.action]?.tone ?? "neutral"}`} />
                    <div>
                      <p><strong>{entry.actor.displayName}</strong> {describeAction(entry).toLowerCase()} <strong>{entry.target.label}</strong></p>
                      <p className="admMuted">“{entry.reason}” · <time dateTime={entry.createdAt}>{formatRelative(entry.createdAt)}</time></p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section aria-labelledby="system-title" className="admCard">
            <div className="admCardHead">
              <h2 className="admSectionTitle" id="system-title">API health</h2>
              {system && <Badge tone="green">Operational</Badge>}
            </div>
            {system ? (
              <ul className="admHealth">
                <li><PulseIcon /><span>Active sessions</span><strong>{system.activeSessions}</strong></li>
                <li><ClockIcon /><span>API uptime</span><strong>{formatDuration(system.uptimeSeconds)}</strong></li>
                <li><AuditIcon /><span>Audit entries</span><strong>{overview?.auditEvents ?? "–"}</strong></li>
                <li><ShieldIcon /><span>Runtime</span><strong>Node.js {system.nodeVersion.replace(/^v/u, "")}</strong></li>
              </ul>
            ) : (
              !error && <SkeletonRows rows={3} />
            )}
            {system && <p className="admMuted admSmall">Reported by the API process that answered this request, checked {formatRelative(system.checkedAt)}.</p>}
          </section>
        </div>
      )}
    </>
  );
}
