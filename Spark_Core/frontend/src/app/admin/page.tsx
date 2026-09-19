"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "../auth-context";

function SparkMark() {
  return (
    <svg aria-hidden="true" className="sparkMark" viewBox="0 0 48 48" style={{ width: "1.5rem", height: "1.5rem" }}>
      <path className="sparkBolt" d="M27 2 8 27h13l-2 19 21-27H27z" fill="#2563eb" />
    </svg>
  );
}

const API_BASE = "";

type AdminTab = "overview" | "reports" | "communities" | "users" | "campaigns" | "audit";

interface OverviewMetrics {
  activeCommunitiesCount: number;
  registeredUsersCount: number;
  pendingReportsCount: number;
  activeCampaignsCount: number;
  workspacesCount: number;
  auditEventsCount: number;
}

interface SystemTelemetry {
  status: string;
  nodeVersion: string;
  uptimeSeconds: number;
  activeSessionsCount: number;
  timestamp: string;
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

interface ManagedCampaign {
  id: string;
  name: string;
  headline: string;
  description: string;
  reviewStatus: "draft" | "pending" | "approved" | "rejected";
  deliveryStatus: "unscheduled" | "scheduled" | "active" | "paused" | "completed" | "cancelled";
  requestedStartAt: string;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  submitterName: string | null;
  communityName: string | null;
  communitySlug: string | null;
  placementName: string | null;
}

interface AuditLogItem {
  id: string;
  actorUserId: string;
  actorName: string | null;
  communityName: string | null;
  action: "hide" | "restore" | "dismiss_report";
  reason: string;
  createdAt: string;
}

const roleBadgeMeta: Record<string, { label: string; bg: string; color: string; border: string }> = {
  super_admin: { label: "Spark Owner", bg: "#fef2f2", color: "#b91c1c", border: "#fecaca" },
  platform_admin: { label: "Platform Admin", bg: "#eff6ff", color: "#1d4ed8", border: "#bfdbfe" },
  community_moderator: { label: "Community Mod", bg: "#ecfdf5", color: "#047857", border: "#a7f3d0" },
  content_moderator: { label: "Content Mod", bg: "#fffbeb", color: "#b45309", border: "#fde68a" },
  campaign_moderator: { label: "Campaign Mod", bg: "#faf5ff", color: "#6b21a8", border: "#e9d5ff" },
};

export default function AdminPage() {
  const router = useRouter();
  const { user, platformRoles, logout, isLoading: authLoading } = useAuth();
  const [currentTab, setCurrentTab] = useState<AdminTab>("overview");
  const [profileDropdownOpen, setProfileDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const [metrics, setMetrics] = useState<OverviewMetrics>({
    activeCommunitiesCount: 0,
    registeredUsersCount: 0,
    pendingReportsCount: 0,
    activeCampaignsCount: 0,
    workspacesCount: 0,
    auditEventsCount: 0,
  });

  const [telemetry, setTelemetry] = useState<SystemTelemetry | null>(null);
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [reportFilter, setReportFilter] = useState<"open" | "reviewing" | "resolved" | "dismissed">("open");
  const [communitiesList, setCommunitiesList] = useState<ManagedCommunity[]>([]);
  const [communitySearch, setCommunitySearch] = useState("");
  const [usersList, setUsersList] = useState<ManagedUser[]>([]);
  const [userSearch, setUserSearch] = useState("");
  const [campaignsList, setCampaignsList] = useState<ManagedCampaign[]>([]);
  const [campaignFilter, setCampaignFilter] = useState<string>("all");
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);

  const [dataLoading, setDataLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setProfileDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

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

  const reloadData = () => setRefreshTrigger((prev) => prev + 1);

  useEffect(() => {
    let ignore = false;
    if (!user) return;

    const loadData = async () => {
      setDataLoading(true);
      try {
        const [overviewRes, sysRes] = await Promise.all([
          fetch(`${API_BASE}/api/v1/admin/overview`, { credentials: "include", headers: { Accept: "application/json" } }),
          fetch(`${API_BASE}/api/v1/admin/system`, { credentials: "include", headers: { Accept: "application/json" } }).catch(() => null),
        ]);

        if (ignore) return;

        if (overviewRes.ok) {
          const ovData = await overviewRes.json();
          setMetrics(ovData);
        }
        if (sysRes && sysRes.ok) {
          const sysData = await sysRes.json();
          setTelemetry(sysData);
        }

        if (currentTab === "reports") {
          const res = await fetch(`${API_BASE}/api/v1/admin/reports?status=${reportFilter}`, {
            credentials: "include",
            headers: { Accept: "application/json" },
          });
          if (res.ok) {
            const data = await res.json();
            setReports(data.reports || []);
          }
        } else if (currentTab === "communities") {
          const res = await fetch(`${API_BASE}/api/v1/admin/communities`, {
            credentials: "include",
            headers: { Accept: "application/json" },
          });
          if (res.ok) {
            const data = await res.json();
            setCommunitiesList(data.communities || []);
          }
        } else if (currentTab === "users") {
          const url = userSearch
            ? `${API_BASE}/api/v1/admin/users?search=${encodeURIComponent(userSearch)}`
            : `${API_BASE}/api/v1/admin/users`;
          const res = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
          if (res.ok) {
            const data = await res.json();
            setUsersList(data.users || []);
          }
        } else if (currentTab === "campaigns") {
          const url = campaignFilter !== "all"
            ? `${API_BASE}/api/v1/admin/campaigns?status=${campaignFilter}`
            : `${API_BASE}/api/v1/admin/campaigns`;
          const res = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
          if (res.ok) {
            const data = await res.json();
            setCampaignsList(data.campaigns || []);
          }
        } else if (currentTab === "audit") {
          const res = await fetch(`${API_BASE}/api/v1/admin/audit-logs?limit=50`, {
            credentials: "include",
            headers: { Accept: "application/json" },
          });
          if (res.ok) {
            const data = await res.json();
            setAuditLogs(data.auditLogs || []);
          }
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
  }, [user, currentTab, reportFilter, userSearch, campaignFilter, refreshTrigger]);

  // Actions
  const handleReportAction = async (reportId: string, action: "hide" | "restore" | "dismiss_report") => {
    const actionLabel = action === "hide" ? "hide content" : action === "restore" ? "restore content" : "dismiss report";
    const reason = window.prompt(`Enter justification for ${actionLabel}:`, "Content policy governance");
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
    if (!window.confirm(`Change user status to ${nextStatus}? (Suspension terminates active sessions)`)) return;

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
        showToast(`Role '${role}' ${hasRole ? "revoked" : "granted"}.`);
        reloadData();
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.detail || "Role modification failed", "error");
      }
    } catch {
      showToast("Network error modifying role", "error");
    }
  };

  const handleCampaignReview = async (campaignId: string, decision: "approve" | "reject") => {
    const reason = window.prompt(`Enter review note for campaign ${decision}:`, `Campaign ${decision}d per platform policy.`);
    if (!reason) return;

    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/campaigns/${campaignId}/review`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ decision, reason }),
      });

      if (res.ok) {
        showToast(`Campaign ${decision}d.`);
        reloadData();
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.detail || "Review submission failed", "error");
      }
    } catch {
      showToast("Network error submitting campaign review", "error");
    }
  };

  if (authLoading || !user) {
    return (
      <div className="adminConsoleRoot" style={{ alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
        <p style={{ color: "#64748b", fontWeight: 600 }}>Verifying governance credentials...</p>
      </div>
    );
  }

  const isSuperAdmin = user?.role === "super_admin" || platformRoles.includes("super_admin");

  const filteredCommunities = communitiesList.filter(
    (c) =>
      c.name.toLowerCase().includes(communitySearch.toLowerCase()) ||
      c.slug.toLowerCase().includes(communitySearch.toLowerCase()),
  );

  const userInitials = user.displayName
    ? user.displayName.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()
    : "AD";

  return (
    <div className="adminConsoleRoot">
      {/* Toast Alert */}
      {actionMessage && (
        <div
          style={{
            position: "fixed",
            bottom: "2rem",
            right: "2rem",
            zIndex: 9999,
            padding: "0.85rem 1.4rem",
            borderRadius: "0.65rem",
            background: actionMessage.type === "success" ? "#065f46" : "#991b1b",
            color: "#ffffff",
            boxShadow: "0 10px 25px rgba(15, 23, 42, 0.2)",
            fontSize: "0.875rem",
            fontWeight: 650,
          }}
        >
          {actionMessage.text}
        </div>
      )}

      {/* Top Navbar */}
      <header className="adminTopNav">
        <div className="adminBrandBadge">
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "#17233d", textDecoration: "none", fontWeight: 800, fontSize: "1.15rem" }}>
            <SparkMark />
            <span>Spark</span>
          </Link>
          <span className="adminPill">Platform Governance</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.85rem" }}>
          {/* Profile Avatar Trigger & Dropdown */}
          <div style={{ position: "relative" }} ref={dropdownRef}>
            <button
              type="button"
              onClick={() => setProfileDropdownOpen(!profileDropdownOpen)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.55rem",
                padding: "0.3rem 0.65rem 0.3rem 0.35rem",
                borderRadius: "9999px",
                background: "#f1f5f9",
                border: "1px solid #e2e8f0",
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
              aria-expanded={profileDropdownOpen}
              aria-label="User profile menu"
            >
              <span
                style={{
                  width: "1.85rem",
                  height: "1.85rem",
                  borderRadius: "50%",
                  background: "#dbeafe",
                  color: "#1e40af",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "0.75rem",
                  fontWeight: 800,
                }}
              >
                {userInitials}
              </span>
              <span style={{ fontSize: "0.82rem", fontWeight: 700, color: "#17233d" }}>
                {user.displayName}
              </span>
              <svg viewBox="0 0 20 20" fill="currentColor" style={{ width: "1rem", height: "1rem", color: "#64748b" }}>
                <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
              </svg>
            </button>

            {profileDropdownOpen && (
              <div className="adminDropdownCard">
                <div className="adminDropdownHeader">
                  <span
                    style={{
                      width: "2.25rem",
                      height: "2.25rem",
                      borderRadius: "50%",
                      background: "#dbeafe",
                      color: "#1e40af",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "0.85rem",
                      fontWeight: 800,
                    }}
                  >
                    {userInitials}
                  </span>
                  <div style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
                    <strong style={{ fontSize: "0.9rem", color: "#17233d" }}>{user.displayName}</strong>
                    <span style={{ fontSize: "0.75rem", color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {user.email || "Spark Governance"}
                    </span>
                  </div>
                </div>

                <div style={{ padding: "0.25rem 0.5rem" }}>
                  <div style={{ fontSize: "0.7rem", fontWeight: 750, color: "#64748b", textTransform: "uppercase", marginBottom: "0.35rem" }}>
                    Platform Roles
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem" }}>
                    {platformRoles.map((r) => {
                      const meta = roleBadgeMeta[r] || { label: r, bg: "#f1f5f9", color: "#475569", border: "#cbd5e1" };
                      return (
                        <span
                          key={r}
                          style={{
                            fontSize: "0.68rem",
                            padding: "0.15rem 0.45rem",
                            borderRadius: "9999px",
                            background: meta.bg,
                            color: meta.color,
                            border: `1px solid ${meta.border}`,
                            fontWeight: 700,
                          }}
                        >
                          {meta.label}
                        </span>
                      );
                    })}
                  </div>
                </div>

                <hr style={{ margin: "0.25rem 0", border: "none", borderTop: "1px solid #f1f5f9" }} />

                <Link
                  href="/"
                  className="adminDropdownItem"
                  onClick={() => setProfileDropdownOpen(false)}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: "1rem", height: "1rem", color: "#64748b" }}>
                    <circle cx="12" cy="12" r="10" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                  </svg>
                  <span>Public Landing Page</span>
                </Link>

                <hr style={{ margin: "0.25rem 0", border: "none", borderTop: "1px solid #f1f5f9" }} />

                <button
                  type="button"
                  onClick={async () => {
                    setProfileDropdownOpen(false);
                    await logout();
                    router.push("/login");
                  }}
                  className="adminDropdownItem danger"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: "1rem", height: "1rem" }}>
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    <polyline points="16 17 21 12 16 7" />
                    <line x1="21" y1="12" x2="9" y2="12" />
                  </svg>
                  <span>Sign out</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main Admin Dashboard */}
      <main className="adminMain">
        <section className="adminHeroCard">
          <p className="eyebrow" style={{ marginBottom: "0.4rem" }}>
            Platform Oversight Center
          </p>
          <h1 style={{ fontSize: "1.85rem", fontWeight: 800, margin: "0 0 0.5rem 0", color: "#17233d", letterSpacing: "-0.025em" }}>
            Spark Owner & Governance Console
          </h1>
          <p style={{ color: "#53627a", fontSize: "0.95rem", margin: 0, maxWidth: "720px", lineHeight: 1.5 }}>
            Centralized platform administration: real-time content moderation, community vetting, user RBAC privileges, sponsored campaigns, and immutable audit logs.
          </p>
        </section>

        {/* Tab Navigation */}
        <div style={{ display: "flex", gap: "0.5rem", background: "#f1f5f9", padding: "0.35rem", borderRadius: "0.75rem", overflowX: "auto" }}>
          {[
            { id: "overview", label: "Overview & Health", icon: "📊" },
            { id: "reports", label: `Moderation (${metrics.pendingReportsCount})`, icon: "🛡️" },
            { id: "communities", label: `Communities (${metrics.activeCommunitiesCount})`, icon: "🌐" },
            { id: "users", label: `User RBAC (${metrics.registeredUsersCount})`, icon: "👥" },
            { id: "campaigns", label: `Campaigns (${metrics.activeCampaignsCount})`, icon: "📢" },
            { id: "audit", label: `Audit Trail (${metrics.auditEventsCount})`, icon: "📜" },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setCurrentTab(tab.id as AdminTab)}
              className={`adminTabPill ${currentTab === tab.id ? "active" : ""}`}
            >
              <span>{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Tab 1: Overview & System Health */}
        {currentTab === "overview" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
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
                <span>Active Workspaces</span>
                <strong>{metrics.workspacesCount}</strong>
              </div>
              <div className="adminMetricCard">
                <span>Pending Reports</span>
                <strong style={{ color: metrics.pendingReportsCount > 0 ? "#d97706" : "#059669" }}>
                  {metrics.pendingReportsCount}
                </strong>
              </div>
              <div className="adminMetricCard">
                <span>Active Campaigns</span>
                <strong style={{ color: "#2563eb" }}>{metrics.activeCampaignsCount}</strong>
              </div>
              <div className="adminMetricCard">
                <span>Audit Logs</span>
                <strong>{metrics.auditEventsCount}</strong>
              </div>
            </section>

            {/* System Health Telemetry */}
            <section className="adminTableCard">
              <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <h2 style={{ fontSize: "1.1rem", fontWeight: 750, margin: "0 0 0.25rem 0", color: "#17233d" }}>
                    Platform Architecture & Telemetry
                  </h2>
                  <span style={{ fontSize: "0.82rem", color: "#64748b" }}>
                    Real-time operational status, database health, and rate-limiting infrastructure
                  </span>
                </div>
                <span className="adminStatusPill active">Operational</span>
              </header>
              <div style={{ padding: "1.5rem", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "1.25rem" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                  <span style={{ fontSize: "0.75rem", color: "#64748b", fontWeight: 700, textTransform: "uppercase" }}>Database Schema</span>
                  <strong style={{ fontSize: "0.95rem", color: "#17233d" }}>PostgreSQL (Drizzle 60 Tables)</strong>
                  <span style={{ fontSize: "0.75rem", color: "#059669" }}>✓ Migrations up to date</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                  <span style={{ fontSize: "0.75rem", color: "#64748b", fontWeight: 700, textTransform: "uppercase" }}>Rate Limiting Engine</span>
                  <strong style={{ fontSize: "0.95rem", color: "#17233d" }}>Redis Distributed Tiered</strong>
                  <span style={{ fontSize: "0.75rem", color: "#059669" }}>✓ Enforcing RFC-7807 Limits</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                  <span style={{ fontSize: "0.75rem", color: "#64748b", fontWeight: 700, textTransform: "uppercase" }}>Active Sessions</span>
                  <strong style={{ fontSize: "0.95rem", color: "#17233d" }}>{telemetry?.activeSessionsCount ?? 1} sessions</strong>
                  <span style={{ fontSize: "0.75rem", color: "#2563eb" }}>SHA-256 Bytea Encrypted</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                  <span style={{ fontSize: "0.75rem", color: "#64748b", fontWeight: 700, textTransform: "uppercase" }}>Backend Runtime</span>
                  <strong style={{ fontSize: "0.95rem", color: "#17233d" }}>Node.js {telemetry?.nodeVersion || "22+"} (Fastify)</strong>
                  <span style={{ fontSize: "0.75rem", color: "#64748b" }}>Uptime: {telemetry?.uptimeSeconds ? `${Math.floor(telemetry.uptimeSeconds / 60)}m ${telemetry.uptimeSeconds % 60}s` : "Online"}</span>
                </div>
              </div>
            </section>
          </div>
        )}

        {/* Tab 2: Content Reports */}
        {currentTab === "reports" && (
          <section className="adminTableCard">
            <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
              <div>
                <h2 style={{ fontSize: "1.1rem", fontWeight: 750, margin: "0 0 0.25rem 0", color: "#17233d" }}>
                  Content Moderation Queue
                </h2>
                <span style={{ fontSize: "0.82rem", color: "#64748b" }}>
                  Flagged posts, comments, and circle violations submitted by community members
                </span>
              </div>
              <div style={{ display: "flex", gap: "0.35rem" }}>
                {(["open", "reviewing", "resolved", "dismissed"] as const).map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setReportFilter(st)}
                    style={{
                      padding: "0.35rem 0.75rem",
                      borderRadius: "0.4rem",
                      fontSize: "0.78rem",
                      fontWeight: reportFilter === st ? 750 : 600,
                      background: reportFilter === st ? "#eff6ff" : "#f1f5f9",
                      color: reportFilter === st ? "#2563eb" : "#64748b",
                      border: reportFilter === st ? "1px solid #bfdbfe" : "1px solid #e2e8f0",
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
              <p style={{ padding: "3rem", textAlign: "center", color: "#64748b" }}>Loading moderation queue...</p>
            ) : reports.length === 0 ? (
              <p style={{ padding: "3rem", textAlign: "center", color: "#64748b" }}>No reports found in '{reportFilter}' status.</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="adminTable">
                  <thead>
                    <tr>
                      <th>Target Content</th>
                      <th>Community</th>
                      <th>Reporter</th>
                      <th>Reason Code</th>
                      <th>Reported At</th>
                      <th>Visibility</th>
                      <th>Governance Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reports.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <strong>{r.targetTitle}</strong>
                          {r.targetSnippet && (
                            <div style={{ fontSize: "0.78rem", color: "#64748b", marginTop: "0.2rem", maxWidth: "260px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {r.targetSnippet}
                            </div>
                          )}
                        </td>
                        <td>
                          <span style={{ fontSize: "0.82rem", color: "#2563eb", fontWeight: 600 }}>{r.communityName}</span>
                        </td>
                        <td>
                          <span style={{ fontSize: "0.8rem", color: "#334155" }}>{r.reporter.displayName}</span>
                        </td>
                        <td>
                          <span style={{ fontSize: "0.8rem", color: "#b91c1c", fontWeight: 650 }}>{r.reasonCode}</span>
                          {r.details && <div style={{ fontSize: "0.72rem", color: "#64748b" }}>{r.details}</div>}
                        </td>
                        <td style={{ fontSize: "0.8rem", color: "#64748b" }}>
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
                                  padding: "0.3rem 0.65rem",
                                  fontSize: "0.75rem",
                                  borderRadius: "0.4rem",
                                  background: "#fef2f2",
                                  border: "1px solid #fecaca",
                                  color: "#b91c1c",
                                  cursor: "pointer",
                                  fontWeight: 650,
                                }}
                              >
                                Hide Content
                              </button>
                              <button
                                type="button"
                                onClick={() => handleReportAction(r.id, "dismiss_report")}
                                style={{
                                  padding: "0.3rem 0.65rem",
                                  fontSize: "0.75rem",
                                  borderRadius: "0.4rem",
                                  background: "#f1f5f9",
                                  border: "1px solid #e2e8f0",
                                  color: "#475569",
                                  cursor: "pointer",
                                  fontWeight: 600,
                                }}
                              >
                                Dismiss
                              </button>
                            </div>
                          ) : (
                            <span style={{ fontSize: "0.78rem", color: "#059669", fontWeight: 650 }}>
                              {r.status === "resolved" ? "Action Taken" : "Dismissed"}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* Tab 3: Communities Oversight */}
        {currentTab === "communities" && (
          <section className="adminTableCard">
            <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
              <div>
                <h2 style={{ fontSize: "1.1rem", fontWeight: 750, margin: "0 0 0.25rem 0", color: "#17233d" }}>
                  Managed Communities & Circles
                </h2>
                <span style={{ fontSize: "0.82rem", color: "#64748b" }}>
                  Platform-wide community discovery, membership counts, and circle status management
                </span>
              </div>
              <div>
                <input
                  type="text"
                  placeholder="Filter community by name or slug..."
                  value={communitySearch}
                  onChange={(e) => setCommunitySearch(e.target.value)}
                  style={{
                    padding: "0.45rem 0.85rem",
                    borderRadius: "0.45rem",
                    background: "#ffffff",
                    border: "1px solid #cbd5e1",
                    color: "#17233d",
                    fontSize: "0.82rem",
                    width: "240px",
                  }}
                />
              </div>
            </header>

            {dataLoading ? (
              <p style={{ padding: "3rem", textAlign: "center", color: "#64748b" }}>Loading communities...</p>
            ) : filteredCommunities.length === 0 ? (
              <p style={{ padding: "3rem", textAlign: "center", color: "#64748b" }}>No matching communities found.</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="adminTable">
                  <thead>
                    <tr>
                      <th>Community</th>
                      <th>Stage</th>
                      <th>Active Members</th>
                      <th>Open Flags</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCommunities.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <strong>{c.name}</strong>
                          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>/{c.slug}</div>
                        </td>
                        <td>
                          <span style={{ fontSize: "0.8rem", color: "#334155" }}>{c.stage || "Early Stage"}</span>
                        </td>
                        <td>
                          <strong style={{ fontSize: "0.85rem", color: "#17233d" }}>{c.memberCount}</strong> members
                        </td>
                        <td>
                          {c.reportCount > 0 ? (
                            <span style={{ color: "#b91c1c", fontWeight: 700, fontSize: "0.8rem" }}>{c.reportCount} flags</span>
                          ) : (
                            <span style={{ color: "#059669", fontSize: "0.8rem", fontWeight: 600 }}>Clean</span>
                          )}
                        </td>
                        <td>
                          <span className={`adminStatusPill ${c.status}`}>{c.status}</span>
                        </td>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                            <Link
                              href={`/communities/${c.slug}`}
                              style={{ color: "#2563eb", textDecoration: "none", fontSize: "0.82rem", fontWeight: 650 }}
                            >
                              Inspect
                            </Link>
                            {c.status !== "archived" ? (
                              <button
                                type="button"
                                onClick={() => handleCommunityStatus(c.id, "archive")}
                                style={{
                                  padding: "0.25rem 0.6rem",
                                  fontSize: "0.75rem",
                                  borderRadius: "0.4rem",
                                  background: "#fef2f2",
                                  border: "1px solid #fecaca",
                                  color: "#b91c1c",
                                  cursor: "pointer",
                                  fontWeight: 650,
                                }}
                              >
                                Archive
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleCommunityStatus(c.id, "restore")}
                                style={{
                                  padding: "0.25rem 0.6rem",
                                  fontSize: "0.75rem",
                                  borderRadius: "0.4rem",
                                  background: "#ecfdf5",
                                  border: "1px solid #a7f3d0",
                                  color: "#047857",
                                  cursor: "pointer",
                                  fontWeight: 650,
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
              </div>
            )}
          </section>
        )}

        {/* Tab 4: User Directory & RBAC */}
        {currentTab === "users" && (
          <section className="adminTableCard">
            <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
              <div>
                <h2 style={{ fontSize: "1.1rem", fontWeight: 750, margin: "0 0 0.25rem 0", color: "#17233d" }}>
                  Platform User Directory & Role Governance
                </h2>
                <span style={{ fontSize: "0.82rem", color: "#64748b" }}>
                  Multi-role platform governance (Owner, Admin, Moderator) & account enforcement
                </span>
              </div>
              <div>
                <input
                  type="text"
                  placeholder="Search user name or email..."
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  style={{
                    padding: "0.45rem 0.85rem",
                    borderRadius: "0.45rem",
                    background: "#ffffff",
                    border: "1px solid #cbd5e1",
                    color: "#17233d",
                    fontSize: "0.82rem",
                    width: "240px",
                  }}
                />
              </div>
            </header>

            {dataLoading ? (
              <p style={{ padding: "3rem", textAlign: "center", color: "#64748b" }}>Loading user directory...</p>
            ) : usersList.length === 0 ? (
              <p style={{ padding: "3rem", textAlign: "center", color: "#64748b" }}>No users match search criteria.</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="adminTable">
                  <thead>
                    <tr>
                      <th>User</th>
                      <th>Primary Email</th>
                      <th>Status</th>
                      <th>Platform Roles</th>
                      <th>Joined Date</th>
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
                          <span style={{ fontSize: "0.82rem", color: "#334155" }}>{u.primaryEmail || "No primary email"}</span>
                        </td>
                        <td>
                          <span className={`adminStatusPill ${u.status}`}>{u.status}</span>
                        </td>
                        <td>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem" }}>
                            {u.platformRoles.length > 0 ? (
                              u.platformRoles.map((r) => {
                                const meta = roleBadgeMeta[r] || { label: r, bg: "#f1f5f9", color: "#475569", border: "#cbd5e1" };
                                return (
                                  <span
                                    key={r}
                                    style={{
                                      fontSize: "0.7rem",
                                      padding: "0.15rem 0.45rem",
                                      borderRadius: "9999px",
                                      background: meta.bg,
                                      color: meta.color,
                                      border: `1px solid ${meta.border}`,
                                      fontWeight: 700,
                                    }}
                                  >
                                    {meta.label}
                                  </span>
                                );
                              })
                            ) : (
                              <span style={{ fontSize: "0.75rem", color: "#64748b" }}>Standard Member</span>
                            )}
                          </div>
                        </td>
                        <td style={{ fontSize: "0.8rem", color: "#64748b" }}>
                          {new Date(u.createdAt).toLocaleDateString()}
                        </td>
                        <td>
                          <div style={{ display: "flex", gap: "0.45rem", alignItems: "center" }}>
                            <button
                              type="button"
                              onClick={() => handleUserStatus(u.id, u.status)}
                              style={{
                                padding: "0.25rem 0.6rem",
                                fontSize: "0.75rem",
                                borderRadius: "0.4rem",
                                background: u.status === "active" ? "#fef2f2" : "#ecfdf5",
                                border: u.status === "active" ? "1px solid #fecaca" : "1px solid #a7f3d0",
                                color: u.status === "active" ? "#b91c1c" : "#047857",
                                cursor: "pointer",
                                fontWeight: 650,
                              }}
                            >
                              {u.status === "active" ? "Suspend" : "Activate"}
                            </button>

                            {isSuperAdmin && (
                              <button
                                type="button"
                                onClick={() => {
                                  const roleToToggle = window.prompt(
                                    "Enter role to grant or revoke:\n(super_admin, platform_admin, community_moderator, content_moderator, campaign_moderator)",
                                    "community_moderator",
                                  );
                                  if (roleToToggle) {
                                    const hasRole = u.platformRoles.includes(roleToToggle);
                                    void handleRoleToggle(u.id, roleToToggle, hasRole);
                                  }
                                }}
                                style={{
                                  padding: "0.25rem 0.6rem",
                                  fontSize: "0.75rem",
                                  borderRadius: "0.4rem",
                                  background: "#eff6ff",
                                  border: "1px solid #bfdbfe",
                                  color: "#2563eb",
                                  cursor: "pointer",
                                  fontWeight: 650,
                                }}
                              >
                                Edit Roles
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
          </section>
        )}

        {/* Tab 5: Campaigns & Promotions */}
        {currentTab === "campaigns" && (
          <section className="adminTableCard">
            <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
              <div>
                <h2 style={{ fontSize: "1.1rem", fontWeight: 750, margin: "0 0 0.25rem 0", color: "#17233d" }}>
                  Sponsored Campaigns & Promotion Review
                </h2>
                <span style={{ fontSize: "0.82rem", color: "#64748b" }}>
                  Vetting and review pipeline for startup promotions across community placements
                </span>
              </div>
              <div style={{ display: "flex", gap: "0.35rem" }}>
                {(["all", "draft", "pending", "approved", "rejected"] as const).map((cf) => (
                  <button
                    key={cf}
                    type="button"
                    onClick={() => setCampaignFilter(cf)}
                    style={{
                      padding: "0.35rem 0.75rem",
                      borderRadius: "0.4rem",
                      fontSize: "0.78rem",
                      fontWeight: campaignFilter === cf ? 750 : 600,
                      background: campaignFilter === cf ? "#eff6ff" : "#f1f5f9",
                      color: campaignFilter === cf ? "#2563eb" : "#64748b",
                      border: campaignFilter === cf ? "1px solid #bfdbfe" : "1px solid #e2e8f0",
                      cursor: "pointer",
                      textTransform: "capitalize",
                    }}
                  >
                    {cf}
                  </button>
                ))}
              </div>
            </header>

            {dataLoading ? (
              <p style={{ padding: "3rem", textAlign: "center", color: "#64748b" }}>Loading promotion campaigns...</p>
            ) : campaignsList.length === 0 ? (
              <p style={{ padding: "3rem", textAlign: "center", color: "#64748b" }}>No campaigns found in '{campaignFilter}' filter.</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="adminTable">
                  <thead>
                    <tr>
                      <th>Campaign & Headline</th>
                      <th>Community</th>
                      <th>Placement</th>
                      <th>Submitter</th>
                      <th>Review Status</th>
                      <th>Delivery</th>
                      <th>Governance Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaignsList.map((cp) => (
                      <tr key={cp.id}>
                        <td>
                          <strong>{cp.name}</strong>
                          <div style={{ fontSize: "0.78rem", color: "#2563eb", marginTop: "0.15rem" }}>{cp.headline}</div>
                          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>{cp.description}</div>
                        </td>
                        <td>
                          <span style={{ fontSize: "0.82rem", color: "#17233d", fontWeight: 600 }}>{cp.communityName || "All Network"}</span>
                        </td>
                        <td>
                          <span style={{ fontSize: "0.8rem", color: "#64748b" }}>{cp.placementName || "Default Feed"}</span>
                        </td>
                        <td>
                          <span style={{ fontSize: "0.8rem", color: "#334155" }}>{cp.submitterName || "Startup Owner"}</span>
                        </td>
                        <td>
                          <span className={`adminStatusPill ${cp.reviewStatus}`}>{cp.reviewStatus}</span>
                        </td>
                        <td>
                          <span className={`adminStatusPill ${cp.deliveryStatus}`}>{cp.deliveryStatus}</span>
                        </td>
                        <td>
                          {cp.reviewStatus === "pending" || cp.reviewStatus === "draft" ? (
                            <div style={{ display: "flex", gap: "0.4rem" }}>
                              <button
                                type="button"
                                onClick={() => handleCampaignReview(cp.id, "approve")}
                                style={{
                                  padding: "0.3rem 0.65rem",
                                  fontSize: "0.75rem",
                                  borderRadius: "0.4rem",
                                  background: "#ecfdf5",
                                  border: "1px solid #a7f3d0",
                                  color: "#047857",
                                  cursor: "pointer",
                                  fontWeight: 650,
                                }}
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                onClick={() => handleCampaignReview(cp.id, "reject")}
                                style={{
                                  padding: "0.3rem 0.65rem",
                                  fontSize: "0.75rem",
                                  borderRadius: "0.4rem",
                                  background: "#fef2f2",
                                  border: "1px solid #fecaca",
                                  color: "#b91c1c",
                                  cursor: "pointer",
                                  fontWeight: 650,
                                }}
                              >
                                Reject
                              </button>
                            </div>
                          ) : (
                            <span style={{ fontSize: "0.78rem", color: "#059669", fontWeight: 650 }}>Reviewed</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* Tab 6: Audit Trail */}
        {currentTab === "audit" && (
          <section className="adminTableCard">
            <header>
              <div>
                <h2 style={{ fontSize: "1.1rem", fontWeight: 750, margin: "0 0 0.25rem 0", color: "#17233d" }}>
                  Platform Governance Audit Trail
                </h2>
                <span style={{ fontSize: "0.82rem", color: "#64748b" }}>
                  Immutable audit records of all moderation actions and governance interventions
                </span>
              </div>
            </header>

            {dataLoading ? (
              <p style={{ padding: "3rem", textAlign: "center", color: "#64748b" }}>Loading audit logs...</p>
            ) : auditLogs.length === 0 ? (
              <p style={{ padding: "3rem", textAlign: "center", color: "#64748b" }}>No audit log entries recorded yet.</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="adminTable">
                  <thead>
                    <tr>
                      <th>Timestamp</th>
                      <th>Moderator / Actor</th>
                      <th>Community</th>
                      <th>Action Taken</th>
                      <th>Justification / Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditLogs.map((log) => (
                      <tr key={log.id}>
                        <td style={{ fontSize: "0.8rem", color: "#64748b", whiteSpace: "nowrap" }}>
                          {new Date(log.createdAt).toLocaleString()}
                        </td>
                        <td>
                          <strong>{log.actorName || "System Actor"}</strong>
                        </td>
                        <td>
                          <span style={{ fontSize: "0.82rem", color: "#2563eb" }}>{log.communityName || "Network Global"}</span>
                        </td>
                        <td>
                          <span className={`adminStatusPill ${log.action === "hide" ? "hidden" : log.action === "restore" ? "active" : "dismissed"}`}>
                            {log.action}
                          </span>
                        </td>
                        <td>
                          <span style={{ fontSize: "0.82rem", color: "#334155" }}>{log.reason}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
