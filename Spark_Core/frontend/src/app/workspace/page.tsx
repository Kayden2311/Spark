"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useAuth } from "../auth-context";
import { WorkspaceSplash } from "../w/_components/splash";
import { pickWorkspace, readLastWorkspace } from "../w/_lib/last-workspace";

/** Sends people to the right place: sign in, first-run onboarding, or their last (or first) workspace. */
export default function WorkspaceResolverPage() {
  const { isAuthenticated, isLoading, workspaces } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      router.replace(`/login?redirect=${encodeURIComponent("/workspace")}`);
      return;
    }
    const slug = pickWorkspace(workspaces.map((item) => item.workspaceSlug), readLastWorkspace());
    router.replace(slug ? `/w/${slug}` : "/onboarding");
  }, [isAuthenticated, isLoading, router, workspaces]);

  return <WorkspaceSplash label="Opening your workspace…" />;
}
