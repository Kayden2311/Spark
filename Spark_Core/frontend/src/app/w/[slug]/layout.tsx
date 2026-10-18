"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, type ReactNode } from "react";

import { useAuth } from "../../auth-context";
import { WorkspaceShell } from "../../components";
import { WorkspaceSplash } from "../_components/splash";
import { SESSION_EXPIRED_EVENT, type Workspace } from "../_lib/api";
import { forgetWorkspace, rememberWorkspace } from "../_lib/last-workspace";
import { useWorkspaceData } from "../_lib/use-workspace-data";
import { WorkspaceProvider } from "./workspace-context";

function sectionFor(pathname: string, slug: string): string {
  const base = `/w/${slug}`;
  if (pathname === `${base}/members` || pathname.startsWith(`${base}/members/`)) return "Members";
  return "Home";
}

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  const { slug = "" } = useParams<{ slug: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const { isAuthenticated, isLoading, refreshSession } = useAuth();
  const ready = !isLoading && isAuthenticated;
  const { data: workspace, error, errorStatus, loading, reload } = useWorkspaceData<Workspace>(ready && slug ? `/workspaces/by-slug/${encodeURIComponent(slug)}` : null);
  const notFound = errorStatus === 404;
  // A refresh that failed keeps the last good copy; only show it while it still belongs to this slug.
  const current = workspace && workspace.slug === slug && !notFound ? workspace : null;
  const value = useMemo(() => (current ? { workspace: current, reload } : null), [current, reload]);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace(`/login?redirect=${encodeURIComponent(pathname || `/w/${slug}`)}`);
  }, [isAuthenticated, isLoading, pathname, router, slug]);

  useEffect(() => {
    const onExpired = () => void refreshSession();
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [refreshSession]);

  useEffect(() => {
    if (current) rememberWorkspace(current.slug);
  }, [current]);

  // Access was removed, the workspace was renamed, or it never was ours: drop it from the session list.
  useEffect(() => {
    if (!notFound) return;
    forgetWorkspace(slug);
    void refreshSession();
  }, [notFound, refreshSession, slug]);

  if (!ready) return <WorkspaceSplash label="Checking your access…" />;

  let content: ReactNode;
  if (notFound) {
    content = (
      <section className="wsStateCard" aria-labelledby="workspace-missing-title">
        <div aria-hidden="true" className="wsGlow" />
        <p className="sparkKicker"><span aria-hidden="true" />Workspace</p>
        <h1 id="workspace-missing-title">This workspace isn&apos;t available to you</h1>
        <p>The address may have changed, or your access was removed. Your other workspaces are one click away.</p>
        <Link className="sparkPrimary" href="/workspace">Go to your workspaces</Link>
      </section>
    );
  } else if (current) {
    content = children;
  } else if (error && !loading) {
    content = (
      <section className="wsStateCard" aria-labelledby="workspace-error-title">
        <p className="sparkKicker"><span aria-hidden="true" />Workspace</p>
        <h1 id="workspace-error-title">We couldn&apos;t open this workspace</h1>
        <p role="alert">{error}</p>
        <button className="sparkPrimary" onClick={reload} type="button">Try again</button>
      </section>
    );
  } else {
    content = (
      <div aria-busy="true" className="wsSkeleton" role="status">
        <span className="wsSrOnly">Loading workspace…</span>
        <span className="wsSkeletonLine short" />
        <span className="wsSkeletonLine title" />
        <div className="wsSkeletonRow"><span /><span /><span /></div>
        <span className="wsSkeletonBlock" />
      </div>
    );
  }

  // One wrapper tree for every state, so the shell (and its open menus) never remounts while data loads.
  return (
    <WorkspaceProvider value={value}>
      <WorkspaceShell current={notFound ? "" : sectionFor(pathname, slug)} workspace={notFound ? undefined : current ?? undefined}>
        {content}
      </WorkspaceShell>
    </WorkspaceProvider>
  );
}
