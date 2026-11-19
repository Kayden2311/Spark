"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { useAuth } from "../../../auth-context";
import { PageHeader } from "../../../_ui/page-header";
import { communitiesApi, currentOf, isSignedOut, loginPath } from "../../_lib/api";
import { useCommunity } from "../../_lib/use-communities";
import type { CommunityDetail } from "../../types";
import { MembersTab } from "./members-tab";
import { RequestsTab } from "./requests-tab";
import { ReportsTab } from "./reports-tab";
import { SettingsTab } from "./settings-tab";

export const RESTRICTED_MESSAGE = "Only community owners and moderators can manage this community";

const VISIBILITY_LABELS: Record<CommunityDetail["visibility"], string> = { public: "Public", private: "Private", hidden: "Hidden" };

type Tab = "requests" | "members" | "reports" | "settings";
type Toast = { id: number; text: string; tone: "success" | "error" };

/**
 * Shared by the tabs: a toast and a sign-in redirect after a 401. Only the first detail load decides between the
 * page, the restriction card and "not available"; a 403 or 404 from a later read or write (a race, such as a
 * teammate removing you) stays an inline error in that tab.
 */
export interface ManageContext {
  community: CommunityDetail;
  /** Community owners and host workspace owners/admins: they change roles and settings. Moderators do not. */
  canGovern: boolean;
  notify(text: string, tone?: Toast["tone"]): void;
  /** Handles a 401 for every tab (redirect to sign in); returns true when the error was handled here. */
  handleAccess(error: unknown): boolean;
  update(change: (community: CommunityDetail) => CommunityDetail): void;
  /** Reloads the community quietly (after a change to your own role, the server decides what you may do). */
  refresh(): Promise<void>;
}

function StateCard({ title, text, slug }: { title: string; text?: string; slug: string | null }) {
  return (
    <section aria-labelledby="manage-state-title" className="spPanel spManageState">
      <div className="spEmpty">
        <span aria-hidden="true" className="spEmptyIcon"><svg viewBox="0 0 24 24"><rect height="10" rx="2" width="14" x="5" y="10.5" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></svg></span>
        <h1 className="spEmptyTitle" id="manage-state-title">{title}</h1>
        {text && <p className="spEmptyText">{text}</p>}
        <Link className="spBtn spBtnSecondary" href={slug ? `/communities/${encodeURIComponent(slug)}` : "/communities"}>
          {slug ? "Back to the community" : "Browse communities"}
        </Link>
      </div>
    </section>
  );
}

export function ManageCommunity({ slug }: { slug: string }) {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const signedIn = !isLoading && isAuthenticated;
  const { community, status, error, retry, update } = useCommunity(slug, signedIn);
  const [tab, setTab] = useState<Tab>("requests");
  // Set when a save hit a newer version; the Settings tab shows it until the next successful save.
  const [stale, setStale] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const tabsId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const here = `/communities/${slug}/manage`;

  const sessionEnded = status === "signed_out";
  useEffect(() => {
    if ((!isLoading && !isAuthenticated) || sessionEnded) router.replace(loginPath(here));
  }, [here, isAuthenticated, isLoading, router, sessionEnded]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast((current) => (current?.id === toast.id ? null : current)), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const notify = useCallback((text: string, tone: Toast["tone"] = "success") => setToast((current) => ({ id: (current?.id ?? 0) + 1, text, tone })), []);
  const handleAccess = useCallback(
    (problem: unknown) => {
      if (isSignedOut(problem)) {
        router.push(loginPath(here));
        return true;
      }
      return false;
    },
    [here, router],
  );
  const refresh = useCallback(async () => {
    try {
      const fresh = await communitiesApi.detail(slug);
      update(() => fresh);
    } catch (problem) {
      if (!handleAccess(problem)) retry();
    }
  }, [handleAccess, retry, slug, update]);

  if (!signedIn || sessionEnded) return <div aria-busy="true" className="spManageLoading" role="status"><span className="spSrOnly">Checking your access…</span></div>;

  if (status === "loading") {
    return (
      <div aria-busy="true" className="spManageLoading" role="status">
        <span className="spSrOnly">Loading community…</span>
        <span className="spSkeleton spSkeletonTitle" />
        <span className="spSkeleton spSkeletonBlock" />
      </div>
    );
  }
  if (status === "not_found") {
    return <StateCard slug={null} text="It may have been archived, or it is hidden and you are not a member." title="This community isn't available" />;
  }
  if (status === "error" || !community) {
    return (
      <section className="spPanel spManageState" role="alert">
        <div className="spEmpty">
          <h1 className="spEmptyTitle">We couldn&apos;t open this community</h1>
          <p className="spEmptyText">{error}</p>
          <button className="spBtn spBtnPrimary" onClick={retry} type="button">Try again</button>
        </div>
      </section>
    );
  }
  if (!community.canManage) {
    return <StateCard slug={community.slug} text={`${community.name} is run by its owners and moderators. You can still visit the community page.`} title={RESTRICTED_MESSAGE} />;
  }

  const canGovern = community.canGovern;
  // Reports belong to community owners and moderators; a host admin with no community role does not see them.
  const canModerate = community.viewerStatus === "owner" || community.viewerStatus === "moderator";
  const tabs: Array<[Tab, string]> = [["requests", "Requests"], ["members", "Members"], ...(canModerate ? [["reports", "Reports"] as [Tab, string]] : []), ...(canGovern ? [["settings", "Settings"] as [Tab, string]] : [])];
  const active = tabs.some(([value]) => value === tab) ? tab : "requests";
  const context: ManageContext = { community, canGovern, notify, handleAccess, update, refresh };

  // Roving focus (WAI-ARIA tabs): arrows move and wrap, Home and End jump to the ends; the choice follows focus.
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = tabs.length - 1;
    const next = event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
        : event.key === "Home" ? 0
          : event.key === "End" ? last
            : null;
    if (next === null) return;
    event.preventDefault();
    setTab(tabs[next]![0]);
    tabRefs.current[next]?.focus();
  };

  const onStale = (problem: unknown) => {
    setStale(true);
    const current = currentOf(problem);
    if (current) update(() => current);
    else retry();
  };

  return (
    <div className="spManage">
      <PageHeader
        actions={<Link className="spBtn spBtnSecondary" href={`/communities/${encodeURIComponent(community.slug)}`}>View community</Link>}
        lead={<>Hosted by {community.host.name}<span aria-hidden="true" className="spDot">·</span>{community.memberCount} {community.memberCount === 1 ? "member" : "members"}</>}
        meta={(
          <>
            <span className="spBadge">{VISIBILITY_LABELS[community.visibility]}</span>
            {community.frozen && <span className="spBadge spBadgeWarn">Paused</span>}
          </>
        )}
        title={community.name}
      >
        <div aria-label="Manage community" className="spTabs" role="tablist">
          {tabs.map(([value, label], index) => (
            <button
              aria-controls={`${tabsId}-${value}-panel`}
              aria-selected={active === value}
              id={`${tabsId}-${value}-tab`}
              key={value}
              onClick={() => setTab(value)}
              onKeyDown={(event) => onTabKey(event, index)}
              ref={(element) => { tabRefs.current[index] = element; }}
              role="tab"
              tabIndex={active === value ? 0 : -1}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      </PageHeader>

      {community.frozen && (
        <p className="spAlert spAlertWarn spManageNotice">This community is paused by Spark moderators. Requests can&apos;t be decided and nobody can be added until it is unpaused.</p>
      )}

      <div aria-labelledby={`${tabsId}-${active}-tab`} id={`${tabsId}-${active}-panel`} role="tabpanel">
        {active === "requests" && <RequestsTab context={context} />}
        {active === "members" && <MembersTab context={context} />}
        {active === "reports" && <ReportsTab context={context} />}
        {active === "settings" && <SettingsTab context={context} key={community.version} onSaved={() => setStale(false)} onStale={onStale} stale={stale} />}
      </div>

      {/* One live region stays mounted so screen readers announce each new message. */}
      {/* wsToast is the restyled toast in _ui/app.css (also used by the workspace Members page). */}
      <div aria-live="polite" className="wsToastRegion" role="status">
        {toast && (
          <div className="wsToast" data-tone={toast.tone} key={toast.id}>
            <svg aria-hidden="true" viewBox="0 0 24 24">{toast.tone === "success" ? <path d="m5 12.5 4.5 4.5L19 7.5" /> : <path d="M12 7v6M12 16.5v.5" />}</svg>
            {toast.text}
            <button aria-label="Dismiss" onClick={() => setToast(null)} type="button"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
          </div>
        )}
      </div>
    </div>
  );
}
