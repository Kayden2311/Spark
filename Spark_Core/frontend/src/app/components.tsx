"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useAuth } from "./auth-context";

const navigation = [["Board", "/workspace"], ["Schedule", "/schedule"], ["Notifications", "/notifications"], ["Billing", "/billing"]] as const;

export function WorkspaceShell({ children, current }: { children: ReactNode; current: string }) {
  const { user, workspaces, logout } = useAuth();
  const router = useRouter();

  const handleLogout = async () => {
    await logout();
    router.push("/login");
  };

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
        <Link className="brand sidebarBrand" href="/">Spark</Link>
        <div className="workspacePicker">
          <span className="avatar">{workspaceInitials}</span>
          <span>{primaryWorkspace?.workspaceName || "Spark Lab"}</span>
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
        </nav>
        <div className="sidebarFoot">
          <span className="avatar">{userInitials}</span>
          <span>{user?.displayName || "Member"}</span>
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

