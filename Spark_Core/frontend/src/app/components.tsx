"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useAuth } from "./auth-context";

function SparkMark() {
  return (
    <svg aria-hidden="true" className="sparkMark" viewBox="0 0 48 48" style={{ width: "1.4rem", height: "1.4rem" }}>
      <path className="sparkBolt" d="M27 2 8 27h13l-2 19 21-27H27z" fill="#38bdf8" />
    </svg>
  );
}

const navigation = [
  ["Board", "/workspace"],
  ["Communities", "/communities"],
  ["Schedule", "/schedule"],
  ["Notifications", "/notifications"],
  ["Billing", "/billing"],
] as const;

export function WorkspaceShell({ children, current }: { children: ReactNode; current: string }) {
  const { user, workspaces, platformRoles, logout } = useAuth();
  const router = useRouter();

  const handleLogout = async () => {
    await logout();
    router.push("/login");
  };

  const isPlatformStaff =
    user?.role === "super_admin" ||
    user?.role === "platform_admin" ||
    user?.role === "community_moderator" ||
    user?.role === "content_moderator" ||
    user?.role === "campaign_moderator" ||
    platformRoles.some((r) =>
      ["super_admin", "platform_admin", "community_moderator", "content_moderator", "campaign_moderator"].includes(r)
    );

  const primaryWorkspace = workspaces[0];
  const workspaceInitials = primaryWorkspace?.workspaceName
    ? primaryWorkspace.workspaceName.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()
    : "SL";
  const userInitials = user?.displayName
    ? user.displayName.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()
    : "US";

  return (
    <div className="appShell">
      <a className="skipLink workspaceSkip" href="#workspace-main">Skip to content</a>
      <aside className="sidebar">
        <Link className="brand sidebarBrand" href="/">
          <SparkMark />
          <span>Spark</span>
        </Link>
        <div className="workspacePicker">
          <span className="avatar">{workspaceInitials}</span>
          <span>{primaryWorkspace?.workspaceName || "Spark Workspace"}</span>
        </div>
        <nav className="sideNav" aria-label="Workspace navigation">
          {navigation.map(([label, href]) => (
            <Link
              aria-current={label === current ? "page" : undefined}
              className={label === current ? "navItem active" : "navItem"}
              href={href}
              key={label}
            >
              {label}
              {label === "Notifications" && <b>3</b>}
            </Link>
          ))}
          {isPlatformStaff && (
            <Link
              className={current === "Admin" ? "navItem active" : "navItem"}
              href="/admin"
              style={{ color: "#38bdf8", borderLeft: "2px solid #38bdf8", marginTop: "0.5rem" }}
            >
              Governance Console
            </Link>
          )}
        </nav>
        <div className="sidebarFoot">
          <span className="avatar">{userInitials}</span>
          <div style={{ display: "grid", lineHeight: "1.2" }}>
            <span style={{ color: "#f8fafc", fontWeight: 600 }}>{user?.displayName || "Member"}</span>
            <small style={{ color: "#94a3b8", fontSize: "0.72rem" }}>{user?.role || "Active"}</small>
          </div>
          <button
            type="button"
            className="signOutBtn"
            onClick={handleLogout}
            aria-label="Sign out"
            title="Sign out"
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="appMain" id="workspace-main">{children}</main>
    </div>
  );
}

export function PageTitle({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return <header className="pageTitle"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1></div>{children}</header>;
}

