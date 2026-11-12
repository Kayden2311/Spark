import type { Metadata } from "next";

import { WorkspaceShell } from "../../../components";
import { ManageCommunity } from "./manage-view";

export const metadata: Metadata = { title: "Manage community" };

/** A member-app screen (shell, fonts, sp* styles) even though it lives under /communities. */
export default async function ManageCommunityPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <WorkspaceShell current="Communities">
      <ManageCommunity slug={slug} />
    </WorkspaceShell>
  );
}
