"use client";

import "./admin.css";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { useAuth } from "../auth-context";
import { AdminProvider, useAdmin } from "./_components/admin-context";
import { AuditIcon, BillingIcon, ChartIcon, ChevronIcon, CloseIcon, CommunityIcon, ExternalIcon, FlagIcon, LogoutIcon, MegaphoneIcon, MenuIcon, OverviewIcon, SidebarIcon, UserIcon } from "./_components/icons";
import { Avatar } from "./_components/ui";
import { SESSION_EXPIRED_EVENT } from "./_lib/api";
import { isStaff, sectionForPath, visibleSections, type SectionId } from "./_lib/access";
import { adminFont } from "./_lib/font";
import { ROLE_LABELS } from "./_lib/format";
import type { Overview, PlatformRole } from "./_lib/types";

const SECTION_ICONS: Record<SectionId, ReactNode> = {
  overview: <OverviewIcon />,
  analytics: <ChartIcon />,
  reports: <FlagIcon />,
  communities: <CommunityIcon />,
  campaigns: <MegaphoneIcon />,
  users: <UserIcon />,
  billing: <BillingIcon />,
  audit: <AuditIcon />,
};

const ROLE_ORDER: PlatformRole[] = ["super_admin", "platform_admin", "content_moderator", "community_moderator", "campaign_moderator"];

function badgeFor(section: SectionId, overview: Overview | null): number | null {
  if (!overview) return null;
  if (section === "reports") return overview.reports.open;
  if (section === "campaigns") return overview.campaigns.pending;
  if (section === "communities") return overview.communities.flagged;
  return null;
}

function SparkMark() {
  return (
    <svg aria-hidden="true" className="sparkMark" viewBox="0 0 48 48">
      <path className="sparkBolt" d="M27 2 8 27h13l-2 19 21-27H27z" />
    </svg>
  );
}

const RAIL_KEY = "spark.admin.sidebar";

function readRail(): boolean {
  try {
    const stored = window.localStorage.getItem(RAIL_KEY);
    return stored === null ? railMemory : stored === "collapsed";
  } catch {
    return railMemory;
  }
}

// Fallback when storage is blocked: the choice then lasts for this visit only.
let railMemory = false;
const RAIL_EVENT = "spark:admin-rail";

function saveRail(collapsed: boolean) {
  railMemory = collapsed;
  try {
    window.localStorage.setItem(RAIL_KEY, collapsed ? "collapsed" : "expanded");
  } catch {
    // Blocked storage: keep the in-memory value.
  }
  window.dispatchEvent(new Event(RAIL_EVENT));
}

function subscribeRail(onChange: () => void): () => void {
  window.addEventListener(RAIL_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(RAIL_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function Sidebar({ open, collapsed, onNavigate, onToggle }: { open: boolean; collapsed: boolean; onNavigate: () => void; onToggle: () => void }) {
  const pathname = usePathname();
  const { roles, overview } = useAdmin();
  const sections = visibleSections(roles);
  const active = sectionForPath(pathname)?.id;
  const groups = [...new Set(sections.map((section) => section.group))];

  return (
    <aside className="admSidebar" data-open={open} id="admin-navigation">
      <div className="admBrandRow">
        <Link aria-label="Spark admin console, overview" className="admBrand" href="/admin" onClick={onNavigate}>
          <span className="admBrandMark"><SparkMark /></span>
          <span className="admBrandText">
            <strong>Spark</strong>
            <span>Admin console</span>
          </span>
        </Link>
        <button
          aria-controls="admin-navigation"
          aria-expanded={!collapsed}
          aria-keyshortcuts="["
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="admRailToggle"
          data-tip={collapsed ? "Expand  [" : "Collapse  ["}
          onClick={onToggle}
          type="button"
        >
          <SidebarIcon />
        </button>
      </div>
      <nav aria-label="Admin sections" className="admNav">
        {groups.map((group) => (
          <div className="admNavGroup" key={group}>
            <p className="admNavGroupLabel">{group}</p>
            <ul>
              {sections.filter((section) => section.group === group).map((section) => {
                const count = badgeFor(section.id, overview);
                return (
                  <li key={section.id}>
                    <Link
                      aria-current={active === section.id ? "page" : undefined}
                      className="admNavLink"
                      data-tip={count ? `${section.label} · ${count}` : section.label}
                      href={section.href}
                      onClick={onNavigate}
                    >
                      {SECTION_ICONS[section.id]}
                      <span className="admNavLabel">{section.label}</span>
                      {count ? <span className="admNavCount"><span aria-hidden="true">{count > 99 ? "99+" : count}</span><span className="admSrOnly">, {count} need attention</span></span> : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <p className="admSidebarNote">Every action you take here is recorded in the audit log.</p>
    </aside>
  );
}

function AccountMenu() {
  const { user, logout } = useAuth();
  const { roles } = useAdmin();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const primaryRole = ROLE_ORDER.find((role) => roles.includes(role));
  const name = user?.displayName ?? "Staff member";

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

  return (
    <div className="admAccount" ref={wrap}>
      <button aria-expanded={open} aria-haspopup="true" aria-label={`Account: ${name}`} className="admAccountButton" onClick={() => setOpen((value) => !value)} type="button">
        <Avatar name={name} size="sm" />
        <span className="admAccountName">{name}</span>
      </button>
      {open && (
        <div className="admAccountPanel">
          <div className="admAccountHead">
            <strong>{name}</strong>
            {user?.email && <span>{user.email}</span>}
          </div>
          <div className="admAccountRoles">
            <span>{primaryRole ? ROLE_LABELS[primaryRole] : "Staff"}</span>
            {roles.length > 1 && <span>+{roles.length - 1} more {roles.length === 2 ? "role" : "roles"}</span>}
          </div>
          <button className="admAccountItem" onClick={() => void logout()} type="button"><LogoutIcon /> Sign out</button>
        </div>
      )}
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  // The server render has no stored choice, so it always starts expanded.
  const collapsed = useSyncExternalStore(subscribeRail, readRail, () => false);
  const toggleRail = useCallback(() => saveRail(!readRail()), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "[" || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (document.querySelector("[aria-modal='true']")) return;
      event.preventDefault();
      toggleRail();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggleRail]);
  const pathname = usePathname();
  const current = sectionForPath(pathname);
  const isDetail = Boolean(current && pathname !== current.href);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <div className={`admShell ${adminFont.variable}`} data-rail={collapsed ? "collapsed" : "expanded"}>
      <a className="admSkip" href="#admin-main">Skip to content</a>
      <Sidebar collapsed={collapsed} onNavigate={() => setMenuOpen(false)} onToggle={toggleRail} open={menuOpen} />
      {menuOpen && <button aria-label="Close navigation" className="admScrim" onClick={() => setMenuOpen(false)} type="button" />}
      <div className="admBody">
        <header className="admTopbar">
          <button aria-controls="admin-navigation" aria-expanded={menuOpen} aria-label={menuOpen ? "Close navigation" : "Open navigation"} className="admIconBtn admMenuToggle" onClick={() => setMenuOpen((value) => !value)} type="button">
            {menuOpen ? <CloseIcon /> : <MenuIcon />}
          </button>
          <nav aria-label="Breadcrumb" className="admCrumbs">
            <ol>
              <li><Link href="/admin">Admin</Link></li>
              {current && current.id !== "overview" && (
                <li>
                  <ChevronIcon aria-hidden="true" />
                  {isDetail ? <Link href={current.href}>{current.label}</Link> : <span aria-current="page">{current.label}</span>}
                </li>
              )}
              {current?.id === "overview" && <li><ChevronIcon aria-hidden="true" /><span aria-current="page">Overview</span></li>}
              {isDetail && <li><ChevronIcon aria-hidden="true" /><span aria-current="page">Details</span></li>}
            </ol>
          </nav>
          <div className="admTopbarActions">
            <Link className="admBtn admBtnGhost admBtnSm admViewSite" href="/">View site <ExternalIcon /></Link>
            <AccountMenu />
          </div>
        </header>
        <main className="admMain" id="admin-main" tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}

function CenteredMessage({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className={`admCentered ${adminFont.variable}`}>
      <div className="admCenteredCard" role="status">
        <SparkMark />
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}

export default function AdminLayout({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading, platformRoles, refreshSession } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const signInUrl = `/login?redirect=${encodeURIComponent(pathname)}`;

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace(signInUrl);
  }, [isLoading, isAuthenticated, router, signInUrl]);

  useEffect(() => {
    const onExpired = () => void refreshSession();
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [refreshSession]);

  if (isLoading || !isAuthenticated) return <CenteredMessage title="Checking your access…" />;
  if (!isStaff(platformRoles)) {
    return (
      <CenteredMessage title="This area is for Spark staff">
        <p>Your account doesn&apos;t have a platform role. If you think it should, ask a super admin.</p>
        <Link className="admBtn admBtnPrimary" href="/workspace">Go to your workspace</Link>
      </CenteredMessage>
    );
  }
  return (
    <AdminProvider roles={platformRoles}>
      <Shell>{children}</Shell>
    </AdminProvider>
  );
}
