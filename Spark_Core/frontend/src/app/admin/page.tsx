"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "../auth-context";
import { SignalParticles } from "../signal-particles";

function SparkMark() {
  return (
    <svg aria-hidden="true" className="sparkMark" viewBox="0 0 48 48" style={{ width: "1.5rem", height: "1.5rem" }}>
      <path className="sparkBolt" d="M27 2 8 27h13l-2 19 21-27H27z" fill="#38bdf8" />
    </svg>
  );
}

const API_BASE = "";

type AdminTab = "reports" | "communities" | "users" | "campaigns";

interface OverviewMetrics {
  activeCommunitiesCount: number;
  registeredUsersCount: number;
  pendingReportsCount: number;
  activeCampaignsCount: number;
}

interface ReportItem {
  id: string;
  tenantId: string;
  communityId: string;
  communityName: string;
  communitySlug: string;
  reporter: {
    id: string;
    displayName: string;
  };
  targetType: "post" | "comment" | "community";
  targetTitle: string;
  targetSnippet: string;
  moderationStatus: "visible" | "hidden";
  reasonCode: string;
  details: string | null;
  status: "open" | "reviewing" | "resolved" | "dismissed";
  createdAt: string;
  resolvedAt: string | null;
}

interface ManagedCommunity {
  id: string;
  slug: string;
  name: string;
  description: string;
  stage: string | null;
  memberCount: number;
  reportCount: number;
  status: "active" | "flagged" | "archived";
  archivedAt: string | null;
}

interface ManagedUser {
  id: string;
  displayName: string;
  primaryEmail: string | null;
  status: "active" | "suspended" | "deleted";
  platformRoles: string[];
  workspaceCount: number;
  createdAt: string;
}

export default function AdminPage() {
  const router = useRouter();
  const { user, platformRoles, logout, isLoading: authLoading } = useAuth();
  const [currentTab, setCurrentTab] = useState<AdminTab>("reports");
  const [metrics, setMetrics] = useState<OverviewMetrics>({
    activeCommunitiesCount: 0,
    registeredUsersCount: 0,
    pendingReportsCount: 0,
    activeCampaignsCount: 0,
  });

  const [reports, setReports] = useState<ReportItem[]>([]);
  const [reportFilter, setReportFilter] = useState<"open" | "reviewing" | "resolved" | "dismissed">("open");
  const [communitiesList, setCommunitiesList] = useState<ManagedCommunity[]>([]);
  const [usersList, setUsersList] = useState<ManagedUser[]>([]);
  const [userSearch, setUserSearch] = useState("");
  const [dataLoading, setDataLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  // Authentication guard
  useEffect(() => {
    if (!authLoading && !user) {
      router.replace("/login?redirect=/admin");
    }
  }, [user, authLoading, router]);

  const showToast = (text: string, type: "success" | "error" = "success") => {
    setActionMessage({ text, type });
    setTimeout(() => setActionMessage(null), 4000);
  };

  const [refreshTrigger, setRefreshTrigger] = useState(0);

  useEffect(() => {
    let ignore = false;
    if (!user) return;

    const loadData = async () => {
      setDataLoading(true);
      try {
        const [overviewRes, tabRes] = await Promise.all([
          fetch(`${API_BASE}/api/v1/admin/overview`, { credentials: "include", headers: { Accept: "application/json" } }),
          currentTab === "reports"
            ? fetch(`${API_BASE}/api/v1/admin/reports?status=${reportFilter}`, { credentials: "include", headers: { Accept: "application/json" } })
            : currentTab === "communities"
            ? fetch(`${API_BASE}/api/v1/admin/communities`, { credentials: "include", headers: { Accept: "application/json" } })
            : fetch(userSearch ? `${API_BASE}/api/v1/admin/users?search=${encodeURIComponent(userSearch)}` : `${API_BASE}/api/v1/admin/users`, { credentials: "include", headers: { Accept: "application/json" } }),
        ]);

        if (ignore) return;

        if (overviewRes.ok) {
          const ovData = await overviewRes.json();
          setMetrics(ovData);
        }

        if (tabRes.ok) {
          const tabData = await tabRes.json();
          if (currentTab === "reports") setReports(tabData.reports || []);
          if (currentTab === "communities") setCommunitiesList(tabData.communities || []);
          if (currentTab === "users") setUsersList(tabData.users || []);
        }
      } catch {
        // network fallback
      } finally {
        if (!ignore) setDataLoading(false);
      }
    };

    void loadData();

    return () => {
      ignore = true;
    };
  }, [user, currentTab, reportFilter, userSearch, refreshTrigger]);

  const reloadData = () => setRefreshTrigger((prev) => prev + 1);

  // Actions
  const handleReportAction = async (reportId: string, action: "hide" | "restore" | "dismiss_report") => {
    const reason = window.prompt(
      `Enter reason for ${action === "hide" ? "hiding content" : action === "restore" ? "restoring content" : "dismissing report"}:`,
      "Content policy enforcement",
    );
    if (!reason) return;

    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/reports/${reportId}/actions`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ action, reason }),
      });

      if (res.ok) {
        showToast(`Moderation action '${action}' recorded.`);
        reloadData();
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.detail || "Action failed", "error");
      }
    } catch {
      showToast("Network error executing action", "error");
    }
  };

  const handleCommunityStatus = async (communityId: string, action: "archive" | "restore") => {
    if (!window.confirm(`Are you sure you want to ${action} this community circle?`)) return;

    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/communities/${communityId}/status`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ action }),
      });

      if (res.ok) {
        showToast(`Community ${action}d successfully.`);
        reloadData();
      } else {
        showToast("Failed to update community status", "error");
      }
    } catch {
      showToast("Network error updating community", "error");
    }
  };

  const handleUserStatus = async (userId: string, currentStatus: string) => {
    const nextStatus = currentStatus === "active" ? "suspended" : "active";
    if (!window.confirm(`Change user status to ${nextStatus}?`)) return;

    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/users/${userId}/status`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });

      if (res.ok) {
        showToast(`User status updated to ${nextStatus}.`);
        reloadData();
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.detail || "Failed to update user status", "error");
      }
    } catch {
      showToast("Network error updating user", "error");
    }
  };

  const handleRoleToggle = async (userId: string, role: string, hasRole: boolean) => {
    try {
      const url = `${API_BASE}/api/v1/admin/users/${userId}/roles${hasRole ? `/${role}` : ""}`;
      const method = hasRole ? "DELETE" : "POST";
      const res = await fetch(url, {
        method,
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: hasRole ? undefined : JSON.stringify({ role }),
      });

      if (res.ok) {
        showToast(`Role ${role} ${hasRole ? "revoked" : "granted"}.`);
        reloadData();
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.detail || "Role modification failed", "error");
      }
    } catch {
      showToast("Network error modifying role", "error");
    }
  };

  if (authLoading || !user) {
    return (
      <div className="loginPageRoot">
        <p style={{ color: "#94a3b8" }}>Verifying governance credentials...</p>
      </div>
    );
  }

  const roleLabels: Record<string, { label: string; color: string }> = {
    super_admin: { label: "Super Admin", color: "rgba(239, 68, 68, 0.2)" },
    platform_admin: { label: "Platform Admin", color: "rgba(56, 189, 248, 0.2)" },
    community_moderator: { label: "Community Moderator", color: "rgba(16, 185, 129, 0.2)" },
    content_moderator: { label: "Content Moderator", color: "rgba(245, 158, 11, 0.2)" },
    campaign_moderator: { label: "Campaign Moderator", color: "rgba(168, 85, 247, 0.2)" },
  };

  const isSuperAdmin = user?.role === "super_admin" || platformRoles.includes("super_admin");

  return (
    <div className="adminConsoleRoot">
      <SignalParticles />
      {/* Toast Alert */}
      {actionMessage && (
        <div
          style={{
            position: "fixed",
            bottom: "2rem",
            right: "2rem",
            zIndex: 9999,
            padding: "0.75rem 1.25rem",
            borderRadius: "0.5rem",
            background: actionMessage.type === "success" ? "#065f46" : "#991b1b",
            color: "#ffffff",
            boxShadow: "0 10px 25px rgba(0,0,0,0.4)",
            fontSize: "0.85rem",
            fontWeight: 600,
          }}
        >
          {actionMessage.text}
        </div>
      )}

      {/* Top Navbar */}
      <header className="adminTopNav">
        <div className="adminBrandBadge">
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "#fff", textDecoration: "none", fontWeight: 800 }}>
            <SparkMark />
            <span>Spark</span>
          </Link>
          <span className="adminPill">Platform Governance</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
            {platformRoles.map((r) => (
              <span
                key={r}
                style={{
                  fontSize: "0.7rem",
                  padding: "0.15rem 0.5rem",
                  borderRadius: "9999px",
                  background: roleLabels[r]?.color || "rgba(255,255,255,0.1)",
                  border: "1px solid rgba(255,255,255,0.15)",
                  color: "#f8fafc",
                  fontWeight: 650,
                }}
              >
                {roleLabels[r]?.label || r}
              </span>
            ))}
          </div>
          <span style={{ fontSize: "0.85rem", color: "#94a3b8" }}>
            <strong style={{ color: "#f8fafc" }}>{user.displayName}</strong>
          </span>
          <button
            type="button"
            onClick={async () => {
              await logout();
              router.push("/login");
            }}
            style={{
              padding: "0.45rem 0.85rem",
              borderRadius: "0.5rem",
              background: "rgba(239, 68, 68, 0.15)",
              color: "#fca5a5",
              border: "1px solid rgba(239, 68, 68, 0.3)",
              cursor: "pointer",
              fontSize: "0.8rem",
              fontWeight: 600,
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Main Admin Dashboard */}
      <main className="adminMain">
        <section className="adminHeroCard">
          <p className="sparkKicker" style={{ marginBottom: "0.5rem" }}>
            <span></span>
            Platform Oversight Center
          </p>
          <h1 style={{ fontSize: "1.8rem", fontWeight: 800, margin: "0 0 0.5rem 0", color: "#ffffff" }}>
            Moderator & Governance Console
          </h1>
          <p style={{ color: "#94a3b8", fontSize: "0.95rem", margin: 0 }}>
            Live content review, community status management, and platform permissions control across the Spark network.
          </p>
        </section>

        {/* Overview Metrics */}
        <section className="adminMetricsGrid">
          <div className="adminMetricCard">
            <span>Active Communities</span>
            <strong>{metrics.activeCommunitiesCount}</strong>
          </div>
          <div className="adminMetricCard">
            <span>Registered Users</span>
            <strong>{metrics.registeredUsersCount}</strong>
          </div>
          <div className="adminMetricCard">
            <span>Pending Reports</span>
            <strong style={{ color: metrics.pendingReportsCount > 0 ? "#fbbf24" : "#10b981" }}>
              {metrics.pendingReportsCount} Open
            </strong>
          </div>
          <div className="adminMetricCard">
            <span>Active Campaigns</span>
            <strong style={{ color: "#38bdf8" }}>{metrics.activeCampaignsCount} Active</strong>
          </div>
        </section>

        {/* Tab Navigation */}
        <div style={{ display: "flex", gap: "0.5rem", borderBottom: "1px solid rgba(148, 163, 184, 0.15)", paddingBottom: "0.5rem" }}>
          {[
            { id: "reports", label: `Content Moderation (${metrics.pendingReportsCount})` },
            { id: "communities", label: `Communities Oversight (${metrics.activeCommunitiesCount})` },
            { id: "users", label: `User Directory (${metrics.registeredUsersCount})` },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setCurrentTab(tab.id as AdminTab)}
              style={{
                padding: "0.6rem 1rem",
                borderRadius: "0.5rem",
                background: currentTab === tab.id ? "rgba(37, 99, 235, 0.25)" : "transparent",
                border: currentTab === tab.id ? "1px solid rgba(56, 189, 248, 0.4)" : "1px solid transparent",
                color: currentTab === tab.id ? "#38bdf8" : "#94a3b8",
                fontWeight: currentTab === tab.id ? 700 : 500,
                cursor: "pointer",
                fontSize: "0.85rem",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab 1: Content Reports */}
        {currentTab === "reports" && (
          <section className="adminTableCard">
            <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
              <div>
                <h2 style={{ fontSize: "1.1rem", fontWeight: 700, margin: "0 0 0.25rem 0" }}>
                  Content Moderation Queue
                </h2>
                <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
                  Reports submitted by community members requiring moderator review
                </span>
              </div>
              <div style={{ display: "flex", gap: "0.35rem" }}>
                {(["open", "reviewing", "resolved", "dismissed"] as const).map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setReportFilter(st)}
                    style={{
                      padding: "0.3rem 0.65rem",
                      borderRadius: "0.35rem",
                      fontSize: "0.75rem",
                      fontWeight: reportFilter === st ? 700 : 500,
                      background: reportFilter === st ? "rgba(56, 189, 248, 0.2)" : "rgba(255,255,255,0.05)",
                      color: reportFilter === st ? "#38bdf8" : "#94a3b8",
                      border: "1px solid rgba(255,255,255,0.1)",
                      cursor: "pointer",
                      textTransform: "capitalize",
                    }}
                  >
                    {st}
                  </button>
                ))}
              </div>
            </header>

            {dataLoading ? (
              <p style={{ padding: "2rem", textAlign: "center", color: "#64748b" }}>Loading reports queue...</p>
            ) : reports.length === 0 ? (
              <p style={{ padding: "2rem", textAlign: "center", color: "#64748b" }}>No reports found in {reportFilter} state.</p>
            ) : (
              <table className="adminTable">
                <thead>
                  <tr>
                    <th>Target Content</th>
                    <th>Community</th>
                    <th>Reporter</th>
                    <th>Reason</th>
                    <th>Reported At</th>
                    <th>Moderation</th>
                    <th>Decision Action</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <strong>{r.targetTitle}</strong>
                        {r.targetSnippet && (
                          <div style={{ fontSize: "0.75rem", color: "#94a3b8", marginTop: "0.2rem", maxWidth: "260px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {r.targetSnippet}
                          </div>
                        )}
                      </td>
                      <td>
                        <span style={{ fontSize: "0.8rem", color: "#38bdf8" }}>{r.communityName}</span>
                      </td>
                      <td>
                        <code style={{ fontSize: "0.75rem", color: "#94a3b8" }}>{r.reporter.displayName}</code>
                      </td>
                      <td>
                        <span style={{ fontSize: "0.8rem", color: "#f87171", fontWeight: 600 }}>{r.reasonCode}</span>
                        {r.details && <div style={{ fontSize: "0.7rem", color: "#64748b" }}>{r.details}</div>}
                      </td>
                      <td style={{ fontSize: "0.75rem", color: "#64748b" }}>
                        {new Date(r.createdAt).toLocaleDateString()}
                      </td>
                      <td>
                        <span className={`adminStatusPill ${r.moderationStatus}`}>
                          {r.moderationStatus}
                        </span>
                      </td>
                      <td>
                        {r.status === "open" || r.status === "reviewing" ? (
                          <div style={{ display: "flex", gap: "0.4rem" }}>
                            <button
                              type="button"
                              onClick={() => handleReportAction(r.id, "hide")}
                              style={{
                                padding: "0.25rem 0.55rem",
                                fontSize: "0.75rem",
                                borderRadius: "0.35rem",
                                background: "rgba(239, 68, 68, 0.2)",
                                border: "1px solid rgba(239, 68, 68, 0.4)",
                                color: "#fca5a5",
                                cursor: "pointer",
                                fontWeight: 600,
                              }}
                            >
                              Hide Content
                            </button>
                            <button
                              type="button"
                              onClick={() => handleReportAction(r.id, "dismiss_report")}
                              style={{
                                padding: "0.25rem 0.55rem",
                                fontSize: "0.75rem",
                                borderRadius: "0.35rem",
                                background: "rgba(148, 163, 184, 0.15)",
                                border: "1px solid rgba(148, 163, 184, 0.3)",
                                color: "#cbd5e1",
                                cursor: "pointer",
                              }}
                            >
                              Dismiss
                            </button>
                          </div>
                        ) : (
                          <span style={{ fontSize: "0.75rem", color: "#10b981", fontWeight: 600 }}>
                            {r.status === "resolved" ? "Action Taken" : "Dismissed"}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}

        {/* Tab 2: Communities */}
        {currentTab === "communities" && (
          <section className="adminTableCard">
            <header>
              <div>
                <h2 style={{ fontSize: "1.1rem", fontWeight: 700, margin: "0 0 0.25rem 0" }}>
                  Managed Communities & Circles
                </h2>
                <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
                  Status governance, vetting, and circle archiving
                </span>
              </div>
            </header>

            {dataLoading ? (
              <p style={{ padding: "2rem", textAlign: "center", color: "#64748b" }}>Loading communities...</p>
            ) : (
              <table className="adminTable">
                <thead>
                  <tr>
                    <th>Community Name</th>
                    <th>Stage</th>
                    <th>Members</th>
                    <th>Flags</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {communitiesList.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <strong>{c.name}</strong>
                        <div style={{ fontSize: "0.75rem", color: "#64748b" }}>/{c.slug}</div>
                      </td>
                      <td>{c.stage || "Early Stage"}</td>
                      <td>{c.memberCount} members</td>
                      <td>
                        {c.reportCount > 0 ? (
                          <span style={{ color: "#f87171", fontWeight: 700 }}>{c.reportCount} flags</span>
                        ) : (
                          <span style={{ color: "#64748b" }}>Clean</span>
                        )}
                      </td>
                      <td>
                        <span className={`adminStatusPill ${c.status}`}>{c.status}</span>
                      </td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                          <Link
                            href={`/communities/${c.slug}`}
                            style={{ color: "#38bdf8", textDecoration: "none", fontSize: "0.8rem", fontWeight: 600 }}
                          >
                            Inspect
                          </Link>
                          {c.status !== "archived" ? (
                            <button
                              type="button"
                              onClick={() => handleCommunityStatus(c.id, "archive")}
                              style={{
                                padding: "0.25rem 0.55rem",
                                fontSize: "0.75rem",
                                borderRadius: "0.35rem",
                                background: "rgba(239, 68, 68, 0.15)",
                                border: "1px solid rgba(239, 68, 68, 0.3)",
                                color: "#fca5a5",
                                cursor: "pointer",
                              }}
                            >
                              Archive
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleCommunityStatus(c.id, "restore")}
                              style={{
                                padding: "0.25rem 0.55rem",
                                fontSize: "0.75rem",
                                borderRadius: "0.35rem",
                                background: "rgba(16, 185, 129, 0.15)",
                                border: "1px solid rgba(16, 185, 129, 0.3)",
                                color: "#6ee7b7",
                                cursor: "pointer",
                              }}
                            >
                              Restore
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}

        {/* Tab 3: User Directory */}
        {currentTab === "users" && (
          <section className="adminTableCard">
            <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
              <div>
                <h2 style={{ fontSize: "1.1rem", fontWeight: 700, margin: "0 0 0.25rem 0" }}>
                  Platform User Directory & Role Governance
                </h2>
                <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
                  Global user statuses, account suspension, and platform role assignment
                </span>
              </div>
              <div>
                <input
                  type="text"
                  placeholder="Search user or email..."
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  style={{
                    padding: "0.4rem 0.8rem",
                    borderRadius: "0.4rem",
                    background: "rgba(255,255,255,0.06)",
                    border: "1px solid rgba(255,255,255,0.15)",
                    color: "#ffffff",
                    fontSize: "0.8rem",
                    width: "220px",
                  }}
                />
              </div>
            </header>

            {dataLoading ? (
              <p style={{ padding: "2rem", textAlign: "center", color: "#64748b" }}>Loading user directory...</p>
            ) : (
              <table className="adminTable">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Email</th>
                    <th>Status</th>
                    <th>Platform Roles</th>
                    <th>Joined</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {usersList.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <strong>{u.displayName}</strong>
                        <div style={{ fontSize: "0.75rem", color: "#64748b" }}>{u.workspaceCount} workspaces</div>
                      </td>
                      <td>
                        <code style={{ fontSize: "0.8rem", color: "#94a3b8" }}>{u.primaryEmail || "N/A"}</code>
                      </td>
                      <td>
                        <span className={`adminStatusPill ${u.status}`}>{u.status}</span>
                      </td>
                      <td>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem" }}>
                          {u.platformRoles.length > 0 ? (
                            u.platformRoles.map((r) => (
                              <span
                                key={r}
                                style={{
                                  fontSize: "0.65rem",
                                  padding: "0.1rem 0.4rem",
                                  borderRadius: "4px",
                                  background: roleLabels[r]?.color || "rgba(255,255,255,0.1)",
                                  color: "#f8fafc",
                                  fontWeight: 600,
                                }}
                              >
                                {roleLabels[r]?.label || r}
                              </span>
                            ))
                          ) : (
                            <span style={{ fontSize: "0.75rem", color: "#64748b" }}>Standard User</span>
                          )}
                        </div>
                      </td>
                      <td style={{ fontSize: "0.75rem", color: "#64748b" }}>
                        {new Date(u.createdAt).toLocaleDateString()}
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                          <button
                            type="button"
                            onClick={() => handleUserStatus(u.id, u.status)}
                            style={{
                              padding: "0.25rem 0.55rem",
                              fontSize: "0.75rem",
                              borderRadius: "0.35rem",
                              background: u.status === "active" ? "rgba(239, 68, 68, 0.15)" : "rgba(16, 185, 129, 0.15)",
                              border: u.status === "active" ? "1px solid rgba(239, 68, 68, 0.3)" : "1px solid rgba(16, 185, 129, 0.3)",
                              color: u.status === "active" ? "#fca5a5" : "#6ee7b7",
                              cursor: "pointer",
                              fontWeight: 600,
                            }}
                          >
                            {u.status === "active" ? "Suspend" : "Activate"}
                          </button>

                          {isSuperAdmin && (
                            <button
                              type="button"
                              onClick={() => {
                                const roleToToggle = window.prompt(
                                  "Enter platform role to grant/revoke (community_moderator, content_moderator, campaign_moderator, platform_admin):",
                                  "community_moderator",
                                );
                                if (roleToToggle) {
                                  const hasRole = u.platformRoles.includes(roleToToggle);
                                  void handleRoleToggle(u.id, roleToToggle, hasRole);
                                }
                              }}
                              style={{
                                padding: "0.25rem 0.55rem",
                                fontSize: "0.75rem",
                                borderRadius: "0.35rem",
                                background: "rgba(56, 189, 248, 0.15)",
                                border: "1px solid rgba(56, 189, 248, 0.3)",
                                color: "#38bdf8",
                                cursor: "pointer",
                              }}
                            >
                              Roles
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
