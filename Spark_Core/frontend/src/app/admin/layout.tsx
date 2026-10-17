"use client";

import "./admin.css";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { useAuth } from "../auth-context";
import { AdminProvider, useAdmin } from "./_components/admin-context";
import { AuditIcon, CommunityIcon, FlagIcon, HomeIcon, LogoutIcon, MegaphoneIcon, MenuIcon, CloseIcon, OverviewIcon, UserIcon } from "./_components/icons";
import { Avatar } from "./_components/ui";
import { SESSION_EXPIRED_EVENT } from "./_lib/api";
import { isStaff, sectionForPath, visibleSections, type SectionId } from "./_lib/access";
import { ROLE_LABELS } from "./_lib/format";
import type { Overview, PlatformRole } from "./_lib/types";

const SECTION_ICONS: Record<SectionId, ReactNode> = {
  overview: <OverviewIcon />,
  reports: <FlagIcon />,
  communities: <CommunityIcon />,
  campaigns: <MegaphoneIcon />,
  users: <UserIcon />,
  audit: <AuditIcon />,
};

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

function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const { roles, overview } = useAdmin();
  const sections = visibleSections(roles);
  const active = sectionForPath(pathname)?.id;
  const groups = [...new Set(sections.map((section) => section.group))];
  const primaryRole = (["super_admin", "platform_admin", "content_moderator", "community_moderator", "campaign_moderator"] as PlatformRole[]).find((role) => roles.includes(role));

  return (
    <aside className="admSidebar" data-open={open} id="admin-navigation">
      <Link className="admBrand" href="/admin" onClick={onNavigate}>
        <SparkMark />
        <span>Spark</span>
        <span className="admBrandTag">Admin</span>
      </Link>
      <nav aria-label="Admin sections" className="admNav">
        {groups.map((group) => (
          <div className="admNavGroup" key={group}>
            <p className="admNavGroupLabel">{group}</p>
            <ul>
              {sections.filter((section) => section.group === group).map((section) => {
                const count = badgeFor(section.id, overview);
                return (
                  <li key={section.id}>
                    <Link aria-current={active === section.id ? "page" : undefined} className="admNavLink" href={section.href} onClick={onNavigate}>
                      {SECTION_ICONS[section.id]}
                      <span>{section.label}</span>
                      {count ? <span className="admNavCount" aria-label={`${count} need attention`}>{count}</span> : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="admSidebarFooter">
        <div className="admMe">
          <Avatar name={user?.displayName ?? "Staff"} />
          <div>
            <strong>{user?.displayName ?? "Staff member"}</strong>
            <span>{primaryRole ? ROLE_LABELS[primaryRole] : "Staff"}{roles.length > 1 ? ` +${roles.length - 1}` : ""}</span>
          </div>
        </div>
        <div className="admSidebarActions">
          <Link className="admBtn admBtnGhost admBtnSm" href="/"><HomeIcon /> Site</Link>
          <button className="admBtn admBtnGhost admBtnSm" onClick={() => void logout()} type="button"><LogoutIcon /> Sign out</button>
        </div>
      </div>
    </aside>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();
  const current = sectionForPath(pathname);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <div className="admShell">
      <a className="admSkip" href="#admin-main">Skip to content</a>
      <Sidebar onNavigate={() => setMenuOpen(false)} open={menuOpen} />
      {menuOpen && <button aria-label="Close navigation" className="admScrim" onClick={() => setMenuOpen(false)} type="button" />}
      <div className="admBody">
        <div className="admTopbar">
          <button aria-controls="admin-navigation" aria-expanded={menuOpen} aria-label={menuOpen ? "Close navigation" : "Open navigation"} className="admIconBtn" onClick={() => setMenuOpen((value) => !value)} type="button">
            {menuOpen ? <CloseIcon /> : <MenuIcon />}
          </button>
          <span className="admTopbarTitle">{current?.label ?? "Admin"}</span>
        </div>
        <main className="admMain" id="admin-main" tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}

function CenteredMessage({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="admCentered">
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
