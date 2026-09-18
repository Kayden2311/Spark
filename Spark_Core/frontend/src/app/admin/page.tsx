"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "../auth-context";

type AdminTab = "communities" | "reports" | "campaigns" | "users";

export default function AdminPage() {
  const router = useRouter();
  const { user, platformRoles, logout, isLoading } = useAuth();
  const [currentTab, setCurrentTab] = useState<AdminTab>("communities");

  useEffect(() => {
    if (!isLoading && !user) {
      router.replace("/login?redirect=/admin");
    }
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return (
      <div className="loginPageRoot">
        <p style={{ color: "#94a3b8" }}>Verifying platform administrator credentials...</p>
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

  const mockCommunities = [
    { id: "c-1", name: "Hyperdrive Founders", slug: "hyperdrive", stage: "Pre-Seed", members: 42, reports: 0, status: "active" },
    { id: "c-2", name: "Zero-to-One SaaS", slug: "zero-to-one", stage: "Seed", members: 128, reports: 1, status: "pending" },
    { id: "c-3", name: "Climate Tech Circle", slug: "climate-tech", stage: "Series A", members: 89, reports: 0, status: "active" },
    { id: "c-4", name: "Web3 Infra Lab", slug: "web3-infra", stage: "Early Stage", members: 16, reports: 3, status: "flagged" },
  ];

  const mockReports = [
    { id: "r-1", target: "Post in /hyperdrive", reporter: "founder_dk", reason: "Potential spam / solicitation", status: "open", time: "2h ago" },
    { id: "r-2", target: "Comment in /web3-infra", reporter: "builder_hn", reason: "Off-topic solicitation", status: "reviewing", time: "5h ago" },
    { id: "r-3", target: "Community description", reporter: "moderator_ml", reason: "Copyright infringement", status: "resolved", time: "1d ago" },
  ];

  const mockCampaigns = [
    { id: "cmp-1", title: "Global AI Hackathon 2026", sponsor: "Anthropic / Spark Lab", budget: "$1,200", status: "approved", start: "Oct 1" },
    { id: "cmp-2", title: "Early Stage Pitch Showcase", sponsor: "Hyperdrive Circle", budget: "$600", status: "pending", start: "Oct 15" },
  ];

  return (
    <div className="adminConsoleRoot">
      {/* Top Navbar */}
      <header className="adminTopNav">
        <div className="adminBrandBadge">
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "#fff", textDecoration: "none", fontWeight: 800 }}>
            <span style={{ color: "#38bdf8" }}>⚡</span>
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
            Network & Moderator Governance
          </h1>
          <p style={{ color: "#94a3b8", fontSize: "0.95rem", margin: 0 }}>
            Unified dashboard for Super Admins, Content Moderators, and Campaign Reviewers across the Spark ecosystem.
          </p>
        </section>

        {/* Overview Metrics */}
        <section className="adminMetricsGrid">
          <div className="adminMetricCard">
            <span>Active Communities</span>
            <strong>38</strong>
          </div>
          <div className="adminMetricCard">
            <span>Registered Users</span>
            <strong>1,420</strong>
          </div>
          <div className="adminMetricCard">
            <span>Content Flags</span>
            <strong style={{ color: "#fbbf24" }}>3 Pending</strong>
          </div>
          <div className="adminMetricCard">
            <span>Active Campaigns</span>
            <strong style={{ color: "#38bdf8" }}>2 Approved</strong>
          </div>
        </section>

        {/* Tab Navigation */}
        <div style={{ display: "flex", gap: "0.5rem", borderBottom: "1px solid rgba(148, 163, 184, 0.15)", paddingBottom: "0.5rem" }}>
          {[
            { id: "communities", label: "Communities Oversight" },
            { id: "reports", label: "Content Moderation (3)" },
            { id: "campaigns", label: "Sponsored Campaigns (2)" },
            { id: "users", label: "User Directory" },
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

        {/* Tab 1: Communities */}
        {currentTab === "communities" && (
          <section className="adminTableCard">
            <header>
              <div>
                <h2 style={{ fontSize: "1.1rem", fontWeight: 700, margin: "0 0 0.25rem 0" }}>
                  Managed Communities & Circles
                </h2>
                <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
                  Vetting and status oversight for startup networks
                </span>
              </div>
            </header>

            <table className="adminTable">
              <thead>
                <tr>
                  <th>Community Name</th>
                  <th>Stage</th>
                  <th>Members</th>
                  <th>Flags</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {mockCommunities.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.name}</strong>
                      <div style={{ fontSize: "0.75rem", color: "#64748b" }}>/{c.slug}</div>
                    </td>
                    <td>{c.stage}</td>
                    <td>{c.members} members</td>
                    <td>
                      {c.reports > 0 ? (
                        <span style={{ color: "#f87171", fontWeight: 700 }}>{c.reports} flags</span>
                      ) : (
                        <span style={{ color: "#64748b" }}>Clean</span>
                      )}
                    </td>
                    <td>
                      <span className={`adminStatusPill ${c.status}`}>{c.status}</span>
                    </td>
                    <td>
                      <Link
                        href={`/communities/${c.slug}`}
                        style={{ color: "#38bdf8", textDecoration: "none", fontSize: "0.8rem", fontWeight: 600 }}
                      >
                        Inspect Circle
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {/* Tab 2: Content Reports */}
        {currentTab === "reports" && (
          <section className="adminTableCard">
            <header>
              <div>
                <h2 style={{ fontSize: "1.1rem", fontWeight: 700, margin: "0 0 0.25rem 0" }}>
                  Content Moderation Queue
                </h2>
                <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
                  Reports submitted by community members requiring moderator review
                </span>
              </div>
            </header>

            <table className="adminTable">
              <thead>
                <tr>
                  <th>Target Content</th>
                  <th>Reported By</th>
                  <th>Reason</th>
                  <th>Reported At</th>
                  <th>Status</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {mockReports.map((r) => (
                  <tr key={r.id}>
                    <td><strong>{r.target}</strong></td>
                    <td><code style={{ fontSize: "0.8rem", color: "#94a3b8" }}>{r.reporter}</code></td>
                    <td>{r.reason}</td>
                    <td>{r.time}</td>
                    <td>
                      <span className={`adminStatusPill ${r.status}`}>{r.status}</span>
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: "0.5rem" }}>
                        <button
                          type="button"
                          style={{ padding: "0.25rem 0.55rem", fontSize: "0.75rem", borderRadius: "0.35rem", background: "rgba(239, 68, 68, 0.2)", border: "1px solid rgba(239, 68, 68, 0.4)", color: "#fca5a5", cursor: "pointer" }}
                        >
                          Hide Post
                        </button>
                        <button
                          type="button"
                          style={{ padding: "0.25rem 0.55rem", fontSize: "0.75rem", borderRadius: "0.35rem", background: "rgba(148, 163, 184, 0.15)", border: "1px solid rgba(148, 163, 184, 0.3)", color: "#cbd5e1", cursor: "pointer" }}
                        >
                          Dismiss
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {/* Tab 3: Campaigns */}
        {currentTab === "campaigns" && (
          <section className="adminTableCard">
            <header>
              <div>
                <h2 style={{ fontSize: "1.1rem", fontWeight: 700, margin: "0 0 0.25rem 0" }}>
                  Promotion & Sponsored Campaigns
                </h2>
                <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
                  Placement approval for paid community banners and hackathon showcases
                </span>
              </div>
            </header>

            <table className="adminTable">
              <thead>
                <tr>
                  <th>Campaign Title</th>
                  <th>Sponsoring Organization</th>
                  <th>Budget</th>
                  <th>Start Date</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {mockCampaigns.map((cmp) => (
                  <tr key={cmp.id}>
                    <td><strong>{cmp.title}</strong></td>
                    <td>{cmp.sponsor}</td>
                    <td>{cmp.budget}</td>
                    <td>{cmp.start}</td>
                    <td>
                      <span className={`adminStatusPill ${cmp.status}`}>{cmp.status}</span>
                    </td>
                    <td>
                      <button
                        type="button"
                        style={{ padding: "0.25rem 0.6rem", fontSize: "0.75rem", borderRadius: "0.35rem", background: "rgba(56, 189, 248, 0.2)", border: "1px solid rgba(56, 189, 248, 0.4)", color: "#38bdf8", cursor: "pointer" }}
                      >
                        Review Creative
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {/* Tab 4: User Directory */}
        {currentTab === "users" && (
          <section className="adminTableCard">
            <header>
              <div>
                <h2 style={{ fontSize: "1.1rem", fontWeight: 700, margin: "0 0 0.25rem 0" }}>
                  Platform User Directory & Role Assignment
                </h2>
                <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
                  Global user status and platform moderator grants
                </span>
              </div>
            </header>

            <div style={{ padding: "1.5rem", textAlign: "center", color: "#94a3b8" }}>
              <p>Total 1,420 registered accounts across all workspaces.</p>
              <p style={{ fontSize: "0.85rem", color: "#64748b" }}>
                Super Admin permissions enabled for account suspension and platform role delegation.
              </p>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

