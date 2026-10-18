"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useAuth } from "./auth-context";
import { SparkLogo as SparkMark } from "./brand/spark-logo";
import { readLastWorkspace, subscribeLastWorkspace } from "./w/_lib/last-workspace";

const STAFF_ROLES = ["super_admin", "platform_admin", "community_moderator", "content_moderator", "campaign_moderator"];
const ROLE_NAMES: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/** The workspace the shell is showing. Pages under /w/[slug] pass the loaded one; other pages fall back to the remembered one. */
export interface ShellWorkspace {
  slug: string;
  name: string;
  role: string;
}

export function initials(name: string | undefined | null, fallback = "S"): string {
  const words = (name ?? "").trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return fallback;
  return words.slice(0, 2).map((word) => [...word][0] ?? "").join("").toUpperCase();
}

function Icon({ children }: { children: ReactNode }) {
  return <svg aria-hidden="true" className="navIcon" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24">{children}</svg>;
}

const ICONS: Record<string, ReactNode> = {
  Home: <Icon><path d="M4 11.5 12 5l8 6.5" /><path d="M6.5 10v9h11v-9" /></Icon>,
  Members: <Icon><circle cx="9" cy="9" r="3.2" /><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6" /><path d="M16 6.3a3 3 0 0 1 0 5.6M17.5 14.6c1.6.5 2.7 1.9 3 4.4" /></Icon>,
  Communities: <Icon><circle cx="12" cy="12" r="8" /><path d="m15.5 8.5-2.1 4.9-4.9 2.1 2.1-4.9z" /></Icon>,
  Schedule: <Icon><rect height="14" rx="2.5" width="16" x="4" y="6" /><path d="M8 4v4M16 4v4M4 11h16" /></Icon>,
  Notifications: <Icon><path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5z" /><path d="M10 20.5a2.2 2.2 0 0 0 4 0" /></Icon>,
  Billing: <Icon><rect height="13" rx="2.5" width="18" x="3" y="5.5" /><path d="M3 10h18M7 15h3" /></Icon>,
  Admin: <Icon><path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z" /></Icon>,
};

function WorkspaceSwitcher({ active }: { active: ShellWorkspace | null }) {
  const { workspaces } = useAuth();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const name = active?.name ?? "No workspace yet";
  return (
    <div className="workspaceSwitcher" ref={wrap}>
      <button
        aria-controls={panelId}
        aria-expanded={open}
        aria-label={`Switch workspace, current: ${name}`}
        className="workspacePicker"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="avatar workspaceAvatar">{active ? initials(active.name) : "+"}</span>
        <span className="workspacePickerText">
          <strong>{name}</strong>
          <small>{active ? ROLE_NAMES[active.role] ?? "Member" : "Create one to start"}</small>
        </span>
        <svg aria-hidden="true" className="workspacePickerChevron" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24"><path d="m8 10 4-4 4 4M8 14l4 4 4-4" /></svg>
      </button>
      {open && (
        <nav aria-label="Your workspaces" className="workspaceMenu" id={panelId}>
          {workspaces.length > 0 && (
            <ul>
              {workspaces.map((item) => (
                <li key={item.workspaceId}>
                  <Link
                    aria-current={item.workspaceSlug === active?.slug ? "true" : undefined}
                    className="workspaceMenuItem"
                    href={`/w/${item.workspaceSlug}`}
                    onClick={() => setOpen(false)}
                  >
                    <span className="avatar tiny">{initials(item.workspaceName)}</span>
                    <span className="workspaceMenuName">{item.workspaceName}</span>
                    <small>{ROLE_NAMES[item.role] ?? "Member"}</small>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Link className="workspaceMenuItem workspaceMenuCreate" href="/onboarding" onClick={() => setOpen(false)}>
            <span aria-hidden="true" className="workspaceMenuPlus">+</span>
            <span className="workspaceMenuName">Create workspace</span>
          </Link>
        </nav>
      )}
    </div>
  );
}

export function WorkspaceShell({ children, current, workspace }: { children: ReactNode; current: string; workspace?: ShellWorkspace | null }) {
  const { user, workspaces, platformRoles, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [menu, setMenu] = useState<{ open: boolean; path: string }>({ open: false, path: pathname });
  // The mobile menu closes whenever the route changes.
  const menuOpen = menu.open && menu.path === pathname;
  const remembered = useSyncExternalStore(subscribeLastWorkspace, readLastWorkspace, () => null);

  const handleLogout = async () => {
    await logout();
    router.push("/login");
  };

  const isPlatformStaff = STAFF_ROLES.includes(user?.role ?? "") || platformRoles.some((role) => STAFF_ROLES.includes(role));

  const fallback = workspaces.find((item) => item.workspaceSlug === remembered) ?? workspaces[0];
  const active: ShellWorkspace | null = workspace === undefined
    ? fallback ? { slug: fallback.workspaceSlug, name: fallback.workspaceName, role: fallback.role } : null
    : workspace;

  const navigation: Array<[string, string]> = [
    ["Home", active ? `/w/${active.slug}` : "/workspace"],
    ...(active ? [["Members", `/w/${active.slug}/members`] as [string, string]] : []),
    ["Communities", "/communities"],
    ["Schedule", "/schedule"],
    ["Notifications", "/notifications"],
    ["Billing", "/billing"],
  ];

  return (
    <div className="appShell">
      <a className="skipLink workspaceSkip" href="#workspace-main">Skip to content</a>
      <aside className="sidebar" data-open={menuOpen}>
        <div className="sidebarTop">
          <Link className="brand sidebarBrand" href="/">
            <SparkMark tone="dark" />
            <span>Spark</span>
          </Link>
          <button
            aria-controls="workspace-sidebar-panel"
            aria-expanded={menuOpen}
            className="sidebarMenuToggle"
            onClick={() => setMenu({ open: !menuOpen, path: pathname })}
            type="button"
          >
            <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" viewBox="0 0 24 24">{menuOpen ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}</svg>
            <span>{menuOpen ? "Close" : "Menu"}</span>
          </button>
        </div>
        <WorkspaceSwitcher active={active} />
        <div className="sidebarPanel" id="workspace-sidebar-panel">
          <nav className="sideNav" aria-label="Workspace navigation">
            {navigation.map(([label, href]) => (
              <Link
                aria-current={label === current ? "page" : undefined}
                className={label === current ? "navItem active" : "navItem"}
                href={href}
                key={label}
              >
                {ICONS[label]}
                {label}
              </Link>
            ))}
            {isPlatformStaff && (
              <Link aria-current={current === "Admin" ? "page" : undefined} className={current === "Admin" ? "navItem navItemStaff active" : "navItem navItemStaff"} href="/admin">
                {ICONS.Admin}
                Governance Console
              </Link>
            )}
          </nav>
          <div className="sidebarFoot">
            <span className="avatar">{initials(user?.displayName, "U")}</span>
            <span className="sidebarUser">
              <strong>{user?.displayName || "Member"}</strong>
              <small>{user?.email ?? ""}</small>
            </span>
            <button aria-label="Sign out" className="signOutBtn" onClick={handleLogout} title="Sign out" type="button">
              <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14" /><path d="M10 8l-4 4 4 4M6 12h10" /></svg>
            </button>
          </div>
        </div>
      </aside>
      <main className="appMain" id="workspace-main" tabIndex={-1}>{children}</main>
    </div>
  );
}

export function PageTitle({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return <header className="pageTitle"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1></div>{children}</header>;
}
