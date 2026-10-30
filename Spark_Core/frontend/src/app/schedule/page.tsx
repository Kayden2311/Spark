"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useAuth } from "../auth-context";
import { WorkspaceSplash } from "../w/_components/splash";
import { pickWorkspace, readLastWorkspace } from "../w/_lib/last-workspace";

/** The schedule lives in a workspace: send people to their last (or first) workspace's schedule, or to onboarding. */
export default function SchedulePage() {
  const { isAuthenticated, isLoading, workspaces } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      router.replace(`/login?redirect=${encodeURIComponent("/schedule")}`);
      return;
    }
    const slug = pickWorkspace(workspaces.map((item) => item.workspaceSlug), readLastWorkspace());
    router.replace(slug ? `/w/${slug}/schedule` : "/onboarding");
  }, [isAuthenticated, isLoading, router, workspaces]);

  return <WorkspaceSplash label="Opening your schedule…" />;
}
