"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { initials } from "../../../components";
import { PageHeader } from "../../../_ui/page-header";
import { communitiesApi, messageOf } from "../../../communities/_lib/api";
import { formatLocation } from "../../../communities/format";
import type { CommunityCard } from "../../../communities/types";
import { canManage } from "../../_lib/api";
import { useWorkspace } from "../workspace-context";

/** Matches the database limit on non-archived communities per host workspace. */
export const MAX_HOSTED = 10;

const VISIBILITY: Record<CommunityCard["visibility"], { label: string; access: string }> = {
  public: { label: "Public", access: "Anyone can join" },
  private: { label: "Private", access: "Join on request" },
  hidden: { label: "Hidden", access: "Members only" },
};

type Load = { key: string; items: CommunityCard[] | null; error: string | null };

function CommunityTile({ community, manager }: { community: CommunityCard; manager: boolean }) {
  const href = `/communities/${encodeURIComponent(community.slug)}`;
  const canOpenManage = manager || community.viewerStatus === "owner" || community.viewerStatus === "moderator";
  const visibility = VISIBILITY[community.visibility];
  return (
    <li className="spCommunityTile">
      <div className="spCommunityTileHead">
        <span aria-hidden="true" className="spSquare spSquareLg">{initials(community.name)}</span>
        <div className="spCommunityTileTitle">
          <Link className="spCommunityTileName" href={href}>{community.name}</Link>
          <p>{community.tagline}</p>
        </div>
      </div>
      <div className="spCommunityTileMeta">
        <span className="spBadge" title={visibility.access}>{visibility.label}</span>
        <span className="spBadge">{community.stage.label}</span>
        {community.frozen && <span className="spBadge spBadgeWarn">Paused</span>}
        {community.featured && !community.frozen && <span className="spBadge">Featured</span>}
      </div>
      <dl className="spCommunityTileFacts">
        <div><dt>Members</dt><dd className="spNum">{community.memberCount}</dd></div>
        <div><dt>Location</dt><dd>{formatLocation(community.location)}</dd></div>
      </dl>
      {canOpenManage && (
        <div className="spCommunityTileFoot">
          <Link aria-label={`Manage ${community.name}`} className="spBtn spBtnSecondary spBtnSm" href={`${href}/manage`}>Manage</Link>
        </div>
      )}
    </li>
  );
}

export default function WorkspaceCommunitiesPage() {
  const { workspace } = useWorkspace();
  const manager = canManage(workspace.role);
  const [attempt, setAttempt] = useState(0);
  const key = `${workspace.id}:${attempt}`;
  const [settled, setSettled] = useState<Load>({ key: "", items: null, error: null });

  useEffect(() => {
    const controller = new AbortController();
    communitiesApi.hosted(workspace.id, controller.signal).then(
      (page) => setSettled({ key, items: page.items, error: null }),
      (error: unknown) => {
        if (!controller.signal.aborted) setSettled({ key, items: null, error: messageOf(error) });
      },
    );
    return () => controller.abort();
  }, [key, workspace.id]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const current = settled.key === key ? settled : null;
  const items = current?.items ?? null;
  const full = items !== null && items.length >= MAX_HOSTED;
  const newHref = `/w/${workspace.slug}/communities/new`;

  return (
    <div className="spCommunities">
      <PageHeader
        actions={(
          <>
            <Link className="spBtn spBtnSecondary" href="/communities">Browse communities</Link>
            {manager && !full && (
              <Link className="spBtn spBtnPrimary" href={newHref}>
                <svg aria-hidden="true" className="spIcon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
                Create community
              </Link>
            )}
          </>
        )}
        lead={items === null
          ? `Communities hosted by ${workspace.name}.`
          : `${workspace.name} hosts ${items.length} of ${MAX_HOSTED} communities.${manager ? "" : " Owners and admins create new ones."}`}
        title="Communities"
      />

      {current?.error && (
        <div className="spAlert spAlertDanger" role="alert">
          {current.error}
          <button className="spBtn spBtnSecondary spBtnSm" onClick={retry} type="button">Try again</button>
        </div>
      )}

      {!current && (
        <div aria-busy="true" className="spCommunityGrid" role="status">
          <span className="spSrOnly">Loading communities…</span>
          <span className="spSkeleton spCommunitySkeleton" /><span className="spSkeleton spCommunitySkeleton" />
        </div>
      )}

      {full && manager && <p className="spAlert spCommunitiesLimit">This workspace hosts the maximum of {MAX_HOSTED} communities.</p>}

      {items && items.length === 0 && (
        <section className="spPanel">
          <div className="spEmpty">
            <span aria-hidden="true" className="spEmptyIcon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /><path d="m15.5 8.5-2.1 4.9-4.9 2.1 2.1-4.9z" /></svg></span>
            <h2 className="spEmptyTitle">No communities yet</h2>
            <p className="spEmptyText">
              {manager
                ? "Host a community for founders, customers or partners. Public ones show up in the directory; private and hidden ones stay invite-friendly."
                : "Owners and admins of this workspace can host communities. Meanwhile, browse the public directory."}
            </p>
            {manager ? <Link className="spBtn spBtnPrimary" href={newHref}>Create community</Link> : <Link className="spBtn spBtnSecondary" href="/communities">Browse communities</Link>}
          </div>
        </section>
      )}

      {items && items.length > 0 && (
        <ul aria-label="Hosted communities" className="spCommunityGrid">
          {items.map((community) => <CommunityTile community={community} key={community.id} manager={manager} />)}
        </ul>
      )}
    </div>
  );
}
