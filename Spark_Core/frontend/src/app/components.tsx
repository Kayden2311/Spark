"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { useUnreadCount } from "./_lib/use-unread-count";
import { useAuth } from "./auth-context";
import { shellCrumbs } from "./_ui/crumbs";
import { PageHeader } from "./_ui/page-header";
import { SparkLogo as SparkMark } from "./brand/spark-logo";
import { readLastWorkspace, subscribeLastWorkspace } from "./w/_lib/last-workspace";
import { methodologyAccent, methodologyOf } from "./w/_lib/projects";

const STAFF_ROLES = ["super_admin", "platform_admin", "community_moderator", "content_moderator", "campaign_moderator"];
const ROLE_NAMES: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/** The workspace the shell is showing. Pages under /w/[slug] pass the loaded one; other pages fall back to the remembered one. */
export interface ShellWorkspace {
  slug: string;
  name: string;
  role: string;
}

/** A project as the shell lists it. */
export interface ShellProject {
  key: string;
  name: string;
  methodology: string;
}

/** How many projects the sidebar lists before linking to the full list on the workspace home. */
const SHELL_PROJECT_LIMIT = 8;

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
  Insights: <Icon><path d="M5 19V11M12 19V5M19 19v-5" /></Icon>,
  Communities: <Icon><circle cx="12" cy="12" r="8" /><path d="m15.5 8.5-2.1 4.9-4.9 2.1 2.1-4.9z" /></Icon>,
  Schedule: <Icon><rect height="14" rx="2.5" width="16" x="4" y="6" /><path d="M8 4v4M16 4v4M4 11h16" /></Icon>,
  Notifications: <Icon><path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5z" /><path d="M10 20.5a2.2 2.2 0 0 0 4 0" /></Icon>,
  Billing: <Icon><rect height="13" rx="2.5" width="18" x="3" y="5.5" /><path d="M3 10h18M7 15h3" /></Icon>,
  Admin: <Icon><path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z" /></Icon>,
};

function ShellProjects({ workspace, projects, pathname }: { workspace: ShellWorkspace; projects: ShellProject[] | null; pathname: string }) {
  const base = `/w/${workspace.slug}`;
  const manager = workspace.role === "owner" || workspace.role === "admin";
  const shown = projects?.slice(0, SHELL_PROJECT_LIMIT) ?? [];
  const newHref = `${base}/projects/new`;
  return (
    <nav aria-label="Projects" className="sideProjects">
      <p aria-hidden="true" className="sideProjectsTitle">Projects</p>
      {shown.length > 0 && (
        <ul>
          {shown.map((project) => {
            const href = `${base}/p/${project.key}`;
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <li key={project.key}>
                <Link aria-current={active ? "page" : undefined} className={active ? "sideProject active" : "sideProject"} href={href}>
                  <span aria-hidden="true" className="sideProjectDot spSquare" data-methodology={methodologyOf(project.methodology)} style={{ "--sp-square": methodologyAccent(project.methodology) } as CSSProperties}>{initials(project.name).slice(0, 1)}</span>
                  <span className="sideProjectName">{project.name}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {projects && projects.length > SHELL_PROJECT_LIMIT && (
        <Link className="sideProjectMore" href={`${base}#projects`}>All {projects.length} projects</Link>
      )}
      {projects && projects.length === 0 && !manager && <p className="sideProjectsEmpty">No projects yet</p>}
      {manager && (
        <Link aria-current={pathname === newHref ? "page" : undefined} className={pathname === newHref ? "sideProject sideProjectNew active" : "sideProject sideProjectNew"} href={newHref}>
          <span aria-hidden="true" className="sideProjectPlus">+</span>
          <span className="sideProjectName">New project</span>
        </Link>
      )}
    </nav>
  );
}

function WorkspaceSwitcher({ active }: { active: ShellWorkspace | null }) {
  const { workspaces } = useAuth();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("mousedown", onPointer);
    // Capture phase, so the switcher closes before the mobile menu sees the same Escape.
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey, true);
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
        ref={trigger}
        type="button"
      >
        <span aria-hidden="true" className="spSquare spSquareLg workspaceAvatar">{active ? initials(active.name) : "+"}</span>
        <span className="workspacePickerText">
          <strong>{name}</strong>
          <small>{active ? ROLE_NAMES[active.role] ?? "Member" : "Create one to start"}</small>
        </span>
        <svg aria-hidden="true" className="workspacePickerChevron" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" viewBox="0 0 24 24"><path d="m8 10 4-4 4 4M8 14l4 4 4-4" /></svg>
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
                    <span aria-hidden="true" className="spSquare workspaceMenuSquare">{initials(item.workspaceName)}</span>
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

/** The unread count next to the Notifications link; hidden at zero. */
function NotificationBadge() {
  const { count } = useUnreadCount();
  if (!count || count < 1) return null;
  const label = count > 99 ? "99+" : String(count);
  return <b aria-label={`${label} unread ${count === 1 ? "notification" : "notifications"}`} className="navBadge" role="img">{label}</b>;
}

/** A dot on the collapsed mobile menu button: the Notifications link is hidden until the menu opens. */
function MenuUnreadDot() {
  const { count } = useUnreadCount();
  if (!count || count < 1) return null;
  return <span className="sidebarMenuDot"><span className="wsSrOnly">{count > 99 ? "99+" : count} unread</span></span>;
}

export function WorkspaceShell({ children, current, workspace, projects = null }: { children: ReactNode; current: string; workspace?: ShellWorkspace | null; projects?: ShellProject[] | null }) {
  const { user, workspaces, platformRoles, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [menu, setMenu] = useState<{ open: boolean; path: string }>({ open: false, path: pathname });
  // The mobile menu closes whenever the route changes.
  const menuOpen = menu.open && menu.path === pathname;
  const remembered = useSyncExternalStore(subscribeLastWorkspace, readLastWorkspace, () => null);
  const menuToggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      // The workspace switcher handles its own Escape first.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      setMenu({ open: false, path: pathname });
      menuToggle.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen, pathname]);

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
    ...(active ? [["Members", `/w/${active.slug}/members`] as [string, string], ["Insights", `/w/${active.slug}/insights`] as [string, string]] : []),
    ["Communities", active ? `/w/${active.slug}/communities` : "/communities"],
    ["Schedule", active ? `/w/${active.slug}/schedule` : "/schedule"],
    ["Notifications", "/notifications"],
    ["Billing", "/billing"],
  ];

  const crumbs = shellCrumbs({ pathname, current, workspace: active, projects: workspace ? projects : null });
  const closeMenu = () => setMenu({ open: false, path: pathname });

  return (
    <div className="appShell" data-menu={menuOpen ? "open" : "closed"}>
      <a className="skipLink workspaceSkip" href="#workspace-main">Skip to content</a>
      <aside className="sidebar" data-open={menuOpen} id="workspace-sidebar-panel">
        <div className="sidebarTop">
          <Link aria-label="Spark home" className="brand sidebarBrand" href="/">
            <SparkMark tone="light" />
          </Link>
          <WorkspaceSwitcher active={active} />
        </div>
        <div className="sidebarPanel">
          <nav className="sideNav" aria-label="Workspace navigation">
            {navigation.map(([label, href]) => (
              <Fragment key={label}>
                <Link
                  aria-current={label === current ? "page" : undefined}
                  className={label === current ? "navItem active" : "navItem"}
                  href={href}
                >
                  {ICONS[label]}
                  <span className="navLabel">{label}</span>
                  {label === "Notifications" && user && <NotificationBadge />}
                </Link>
                {/* Inside a workspace, Communities is the hosted list; the public directory stays one click away. */}
                {label === "Communities" && active && (
                  <Link className="navItem navSubItem" href="/communities">
                    <span className="navLabel">Browse communities</span>
                  </Link>
                )}
              </Fragment>
            ))}
            {isPlatformStaff && (
              <Link aria-current={current === "Admin" ? "page" : undefined} className={current === "Admin" ? "navItem navItemStaff active" : "navItem navItemStaff"} href="/admin">
                {ICONS.Admin}
                <span className="navLabel">Governance Console</span>
              </Link>
            )}
          </nav>
          {/* Only pages inside a workspace pass it, so other pages never show a stale project list. */}
          {workspace && <ShellProjects pathname={pathname} projects={projects} workspace={workspace} />}
        </div>
        <div className="sidebarFoot">
          <span className="avatar">{initials(user?.displayName, "U")}</span>
          <span className="sidebarUser">
            <strong>{user?.displayName || "Member"}</strong>
            <small>{user?.email ?? ""}</small>
          </span>
          <Link aria-current={pathname === "/settings/notifications" ? "page" : undefined} aria-label="Settings" className="signOutBtn settingsLink" href="/settings/notifications" title="Settings">
            <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
          </Link>
          <button aria-label="Sign out" className="signOutBtn" onClick={handleLogout} title="Sign out" type="button">
            <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" viewBox="0 0 24 24"><path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14" /><path d="M10 8l-4 4 4 4M6 12h10" /></svg>
          </button>
        </div>
      </aside>
      {/* A tap outside the open phone menu closes it; keyboard users have Escape and the toggle. */}
      {menuOpen && <div aria-hidden="true" className="sidebarScrim" onClick={closeMenu} />}
      <div className="appColumn">
        <header className="spTopbar">
          <button
            aria-controls="workspace-sidebar-panel"
            aria-expanded={menuOpen}
            className="sidebarMenuToggle"
            onClick={() => setMenu({ open: !menuOpen, path: pathname })}
            ref={menuToggle}
            type="button"
          >
            <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.75" viewBox="0 0 24 24">{menuOpen ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}</svg>
            <span>{menuOpen ? "Close" : "Menu"}</span>
            {user && !menuOpen && <MenuUnreadDot />}
          </button>
          {crumbs.length > 0 && (
            <nav aria-label="Breadcrumb" className="spCrumbs">
              <ol>
                {crumbs.map((crumb, index) => (
                  <li key={`${index}-${crumb.label}`}>
                    {index > 0 && <svg aria-hidden="true" className="spCrumbSep" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6" /></svg>}
                    {crumb.href ? <Link href={crumb.href}>{crumb.label}</Link> : <span aria-current="page">{crumb.label}</span>}
                  </li>
                ))}
              </ol>
            </nav>
          )}
        </header>
        <main className="appMain" id="workspace-main" tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}

/** The older title API (eyebrow + title + actions), now drawn by PageHeader. */
export function PageTitle({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return <PageHeader actions={children} lead={eyebrow} title={title} />;
}
