"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "../auth-context";

export default function AdminPage() {
  const router = useRouter();
  const { user, platformRoles, logout, isLoading } = useAuth();

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

  const mockCommunities = [
    { id: "c-1", name: "Hyperdrive Founders", slug: "hyperdrive", stage: "Pre-Seed", members: 42, reports: 0, status: "active" },
    { id: "c-2", name: "Zero-to-One SaaS", slug: "zero-to-one", stage: "Seed", members: 128, reports: 1, status: "pending" },
    { id: "c-3", name: "Climate Tech Circle", slug: "climate-tech", stage: "Series A", members: 89, reports: 0, status: "active" },
    { id: "c-4", name: "Web3 Infra Lab", slug: "web3-infra", stage: "Early Stage", members: 16, reports: 3, status: "flagged" },
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
          <span className="adminPill">Platform Oversight</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <span style={{ fontSize: "0.85rem", color: "#94a3b8" }}>
            Signed in as <strong style={{ color: "#f8fafc" }}>{user.displayName}</strong> ({user.email})
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
            Administrative Control Center
          </p>
          <h1 style={{ fontSize: "1.8rem", fontWeight: 800, margin: "0 0 0.5rem 0", color: "#ffffff" }}>
            Network & Community Governance
          </h1>
          <p style={{ color: "#94a3b8", fontSize: "0.95rem", margin: 0 }}>
            Oversee public and private startup communities, audit membership integrity, and resolve content moderation flags across all workspaces.
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
            <span>Moderation Queue</span>
            <strong style={{ color: "#fbbf24" }}>3 Pending</strong>
          </div>
          <div className="adminMetricCard">
            <span>Platform Security</span>
            <strong style={{ color: "#34d399" }}>Argon2id Active</strong>
          </div>
        </section>

        {/* Communities Table */}
        <section className="adminTableCard">
          <header>
            <div>
              <h2 style={{ fontSize: "1.1rem", fontWeight: 700, margin: "0 0 0.25rem 0" }}>
                Managed Communities & Circles
              </h2>
              <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
                Direct oversight of network organizations and their audit records
              </span>
            </div>
          </header>

          <table className="adminTable">
            <thead>
              <tr>
                <th>Community Name</th>
                <th>Stage</th>
                <th>Members</th>
                <th>Content Flags</th>
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
                      Audit View →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </div>
  );
}
