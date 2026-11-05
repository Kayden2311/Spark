"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { useAuth } from "../../../../auth-context";
import { canPlan } from "../../../_lib/planning";
import { isValidProjectKey } from "../../../_lib/project-key";
import { methodologyAccent, methodologyName, methodologyOf, projectEtag, type ProjectDetail } from "../../../_lib/projects";
import { useWorkspaceData } from "../../../_lib/use-workspace-data";
import { useWorkspace } from "../../workspace-context";
import { ProjectProvider, type ToastTone } from "./project-context";

type Toast = { id: number; text: string; tone: ToastTone };
type Announcement = { id: number; text: string };

/** Shared header (name, methodology, view tabs: Board · Backlog (Scrum) · Timeline (Waterfall, or a kept plan) · Overview · Insights · Settings (planners)) and the one live region for every project view. */
export default function ProjectLayout({ children }: { children: ReactNode }) {
  const { key = "" } = useParams<{ key: string }>();
  const pathname = usePathname();
  const { workspace, projects } = useWorkspace();
  const { user } = useAuth();
  const valid = isValidProjectKey(key);
  const loaded = useWorkspaceData<ProjectDetail>(valid ? `/workspaces/${workspace.id}/projects/by-key/${encodeURIComponent(key)}` : null);
  // A save (or a teammate's newer version seen on 412) replaces the loaded copy until the next load.
  const [override, setOverride] = useState<{ source: unknown; project: ProjectDetail; etag: string } | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast((current) => (current?.id === toast.id ? null : current)), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const notify = useCallback((text: string, tone: ToastTone = "success") => setToast((current) => ({ id: (current?.id ?? 0) + 1, text, tone })), []);
  const announce = useCallback((text: string) => setAnnouncement((current) => ({ id: (current?.id ?? 0) + 1, text })), []);

  const replaced = override && override.source === loaded.data ? override : null;
  const project = replaced?.project ?? loaded.data;
  const etag = replaced?.etag ?? loaded.etag ?? (project ? projectEtag(project.version) : "");
  const ready = project && project.key === key ? project : null;
  const reloadProject = loaded.reload;
  const source = loaded.data;
  const reloadProjects = projects.reload;
  // The shell and home list the project too (name, lead, methodology).
  const replaceProject = useCallback((next: ProjectDetail, nextEtag?: string) => {
    setOverride({ source, project: next, etag: nextEtag ?? projectEtag(next.version) });
    reloadProjects();
  }, [source, reloadProjects]);
  const value = useMemo(
    () => (ready ? { project: ready, etag, notify, announce, reloadProject, replaceProject } : null),
    [ready, etag, notify, announce, reloadProject, replaceProject],
  );

  let content: ReactNode;
  if (!valid || loaded.errorStatus === 404) {
    content = (
      <section aria-labelledby="project-missing-title" className="wsStateCard">
        <h1 id="project-missing-title">This project isn&apos;t available</h1>
        <p>There is no project with the key {key || "—"} in {workspace.name}. It may have been archived, or the address is mistyped.</p>
        <Link className="spBtn spBtnPrimary" href={`/w/${workspace.slug}`}>Back to workspace home</Link>
      </section>
    );
  } else if (loaded.error && !loaded.loading && !ready) {
    content = (
      <section aria-labelledby="project-error-title" className="wsStateCard">
        <h1 id="project-error-title">We couldn&apos;t open this project</h1>
        <p role="alert">{loaded.error}</p>
        <button className="spBtn spBtnPrimary" onClick={loaded.reload} type="button">Try again</button>
      </section>
    );
  } else if (!ready || !value) {
    // While another project's copy is still on screen after navigation, show the skeleton instead.
    content = (
      <div aria-busy="true" className="wsSkeleton" role="status">
        <span className="wsSrOnly">Loading project…</span>
        <span className="wsSkeletonLine short" />
        <span className="wsSkeletonLine title" />
        <span className="wsSkeletonBlock" />
      </div>
    );
  } else {
    const base = `/w/${workspace.slug}/p/${encodeURIComponent(ready.key)}`;
    const methodology = methodologyOf(ready.methodology);
    const canEdit = canPlan(workspace.role, ready, user?.id);
    const accent = { "--method-accent": methodologyAccent(ready.methodology) } as CSSProperties;
    // Backlog belongs to Scrum and Timeline to Waterfall; Settings is for the people who can change the plan.
    const tabs = [
      { href: base, label: "Board", show: true },
      { href: `${base}/backlog`, label: "Backlog", show: methodology === "scrum" },
      // A project that left Waterfall keeps its phases and milestones there as history (milestones stay editable).
      { href: `${base}/timeline`, label: "Timeline", show: methodology === "waterfall" || ready.phases.length > 0 || ready.milestones.length > 0 },
      { href: `${base}/overview`, label: "Overview", show: true },
      // Insights are read-only and visible to every member.
      { href: `${base}/insights`, label: "Insights", show: true },
      { href: `${base}/settings`, label: "Settings", show: canEdit },
    ].filter((tab) => tab.show);
    content = (
      <div className="wsProject" style={accent}>
        <section aria-label="Project" className="wsProjectHero">
          <div className="wsProjectHeroMain">
            <p className="wsProjectHeroTags">
              <span className="wsKeyTag">{ready.key}</span>
              <span className="wsMethodPill" data-methodology={methodology}>{methodologyName(ready.methodology)}</span>
            </p>
            <h1>{ready.name}</h1>
          </div>
          <nav aria-label="Project views" className="wsProjectTabs">
            {tabs.map((tab) => (
              <Link aria-current={pathname === tab.href ? "page" : undefined} href={tab.href} key={tab.href}>{tab.label}</Link>
            ))}
          </nav>
        </section>
        <ProjectProvider value={value}>{children}</ProjectProvider>
      </div>
    );
  }

  return (
    <>
      {content}
      {/* One live region stays mounted so screen readers announce each new message: toasts and board moves alike. */}
      <div aria-live="polite" className="wsToastRegion" role="status">
        {announcement && <span className="wsSrOnly" key={`announcement-${announcement.id}`}>{announcement.text}</span>}
        {toast && (
          <div className="wsToast" data-tone={toast.tone} key={`toast-${toast.id}`}>
            <svg aria-hidden="true" viewBox="0 0 24 24">{toast.tone === "success" ? <path d="m5 12.5 4.5 4.5L19 7.5" /> : toast.tone === "info" ? <path d="M12 11v6M12 7.5v.5" /> : <path d="M12 7v6M12 16.5v.5" />}</svg>
            {toast.text}
            <button aria-label="Dismiss" onClick={() => setToast(null)} type="button"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
          </div>
        )}
      </div>
    </>
  );
}
