"use client";

import Link from "next/link";
import { notFound, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "../../auth-context";
import { SignalParticles } from "../../signal-particles";
import { ACCESS_LABELS, GlobeIcon, initialsOf, LockIcon, toneOf, VISIBILITY_LABELS } from "../community-card";
import { formatCount, formatDate, formatLocation } from "../format";
import { SiteFooter, SiteHeader } from "../site-chrome";
import type { CommunityDetail } from "../types";
import { ApiError, communitiesApi, cooldownMessage, isSignedOut, LAST_OWNER_MESSAGE, loginPath, membershipErrorMessage, messageOf, PAUSED_MESSAGE } from "../_lib/api";
import { useCommunity, useRequestCooldown } from "../_lib/use-communities";

type Toast = { id: number; text: string };

const MEMBER_STATUSES = new Set(["owner", "moderator", "member"]);

function LocationPinIcon() {
  return (
    <svg className="metaInlineIcon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
    </svg>
  );
}

function StageIcon() {
  return (
    <svg className="metaInlineIcon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" />
    </svg>
  );
}

interface ActionsProps {
  community: CommunityDetail;
  onChange: (change: (community: CommunityDetail) => CommunityDetail) => void;
  notify: (text: string) => void;
}

/** The membership controls for the viewer's current state. */
function MembershipActions({ community, onChange, notify }: ActionsProps) {
  const { isAuthenticated, isLoading, user } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An expected refusal (the last owner leaving): explained, not shown as a failure.
  const [notice, setNotice] = useState<string | null>(null);

  const base = `/communities/${encodeURIComponent(community.slug)}`;
  const requestPath = `${base}/request`;
  const status = community.viewerStatus;
  const isMember = status !== null && MEMBER_STATUSES.has(status);
  const outsider = status === null || status === "none";
  const paused = community.frozen;
  // A declined request blocks asking again for a while; say when up front instead of offering a request that fails.
  const cooldown = useRequestCooldown(community.slug, isAuthenticated && outsider && community.visibility === "private" && !community.canManage && !paused);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (failure) {
      if (isSignedOut(failure)) {
        router.push(loginPath(base));
        return;
      }
      if (failure instanceof ApiError && failure.code === "last_owner") {
        setNotice(LAST_OWNER_MESSAGE);
        return;
      }
      setError(membershipErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const join = () =>
    run(async () => {
      const result = await communitiesApi.join(community.id);
      onChange((current) => ({
        ...current,
        viewerStatus: current.viewerStatus && MEMBER_STATUSES.has(current.viewerStatus) ? current.viewerStatus : "member",
        memberCount: current.memberCount + (result.alreadyMember ? 0 : 1),
      }));
      notify(result.alreadyMember ? `You're already a member of ${community.name}.` : `You joined ${community.name}.`);
    });

  const withdraw = () =>
    run(async () => {
      const { items } = await communitiesApi.myRequests();
      const pending = items.find((item) => item.community.slug === community.slug && item.status === "pending");
      if (pending) await communitiesApi.withdraw(pending.id);
      onChange((current) => ({ ...current, viewerStatus: null }));
      // Without a pending request it was decided in the meantime; reload to see the outcome.
      notify(pending ? "Request withdrawn." : "This request is no longer pending. Reload to see the latest.");
    });

  const leave = () =>
    run(async () => {
      if (!user) {
        router.push(loginPath(base));
        return;
      }
      try {
        await communitiesApi.leave(community.id, user.id);
      } finally {
        setConfirmLeave(false);
      }
      onChange((current) => ({ ...current, viewerStatus: null, memberCount: Math.max(0, current.memberCount - 1) }));
      notify(`You left ${community.name}.`);
    });

  let control: React.ReactNode = null;
  if (isLoading && status === null) {
    control = null;
  } else if (!isAuthenticated && status === null) {
    // Joins and requests are refused while paused, so there is nothing to sign in for.
    if (paused) {
      control = null;
    } else if (community.visibility === "public") {
      control = <Link className="circleCtaBtn" href={loginPath(base)}>Sign in to join</Link>;
    } else if (community.visibility === "private") {
      control = <Link className="circleCtaBtn" href={loginPath(requestPath)}>Sign in to request access</Link>;
    }
  } else if (isMember) {
    control = confirmLeave ? (
      <div className="circleConfirm" role="group" aria-label={`Leave ${community.name}?`}>
        <span>Leave {community.name}?</span>
        <button className="circleCtaBtn circleDangerBtn" disabled={busy || paused} onClick={() => void leave()} type="button">
          Leave community
        </button>
        <button className="circleGhostBtn" disabled={busy} onClick={() => setConfirmLeave(false)} type="button">
          Cancel
        </button>
      </div>
    ) : (
      <>
        <span className="circleStatePill">You&apos;re a member</span>
        <button className="circleGhostBtn" disabled={busy || paused} onClick={() => setConfirmLeave(true)} type="button">
          Leave
        </button>
      </>
    );
  } else if (status === "pending") {
    control = (
      <>
        <span className="circleStatePill">Request pending</span>
        <button className="circleGhostBtn" disabled={busy || paused} onClick={() => void withdraw()} type="button">
          Withdraw
        </button>
      </>
    );
  } else if (community.visibility === "public") {
    control = (
      <button className="circleCtaBtn" disabled={busy || paused} onClick={() => void join()} type="button">
        {busy ? "Joining…" : "Join"}
      </button>
    );
  } else if (community.visibility === "private" && !community.canManage) {
    // Managers (for example host workspace admins) are never offered a request: they use Manage instead.
    if (paused) {
      control = <button className="circleCtaBtn" disabled type="button">Request access</button>;
    } else if (cooldown.until) {
      control = <span className="circleStatePill">{cooldownMessage(cooldown.until)}</span>;
    } else if (cooldown.checked) {
      control = <Link className="circleCtaBtn" href={requestPath}>Request access</Link>;
    }
  }

  return (
    <section className="circleMembership" aria-label="Membership">
      <div className="circleActionGroup">
        {control}
        {community.canManage && (
          <Link className="circleGhostBtn" href={`${base}/manage`}>
            Manage
          </Link>
        )}
      </div>
      {paused && <p className="circleNotice">{PAUSED_MESSAGE}</p>}
      {notice && <p className="circleNotice">{notice}</p>}
      {error && (
        <p className="circleNotice circleNoticeError" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function CommunityView({ slug }: { slug: string }) {
  const { community, status, error, retry, update } = useCommunity(slug);
  const [toast, setToast] = useState<Toast | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast((current) => (current?.id === toast.id ? null : current)), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const notify = (text: string) => setToast((current) => ({ id: (current?.id ?? 0) + 1, text }));

  if (status === "not_found") notFound();

  let content: React.ReactNode;
  if (status === "error" || status === "signed_out") {
    content = (
      <section className="circleSectionCard circleStateCard">
        <h1 className="circleMainTitle">This community could not load</h1>
        <p role="alert">{error ?? messageOf(null)}</p>
        <button className="circleCtaBtn" onClick={retry} type="button">Try again</button>
      </section>
    );
  } else if (!community) {
    content = (
      <section className="circleSectionCard circleStateCard" aria-busy="true">
        <p role="status">Loading community…</p>
      </section>
    );
  } else {
    const isPublic = community.visibility === "public";
    const location = formatLocation(community.location);
    const since = formatDate(community.createdAt);
    content = (
      <>
        <section className={`circleHeroHeader summaryTone-${toneOf(community)}`}>
          <div className="circleHeroIdentityRow">
            <div aria-hidden="true" className="circleMonogramBadge circleMonogramTone">
              {initialsOf(community.name)}
            </div>
            <div className="circleHeroTitleBlock">
              <div className="circleTagBadgesRow">
                {community.featured && !community.frozen && <span className="circleTagBadge circleTagFeatured">Featured</span>}
                {community.frozen && <span className="circleTagBadge circleTagPaused">Paused</span>}
                <span className={`circleTagBadge circleTagVisibility${isPublic ? "" : " circleTagPrivate"}`}>
                  {isPublic ? <GlobeIcon /> : <LockIcon />}
                  {VISIBILITY_LABELS[community.visibility] ?? "Private"}
                </span>
                <span className="circleTagMeta">
                  <StageIcon /> {community.stage.label}
                </span>
                <span className="circleTagMeta">
                  <LocationPinIcon /> {location}
                </span>
              </div>
              <h1 className="circleMainTitle">{community.name}</h1>
              <p className="circleMainDescription">{community.tagline}</p>
              <p className="circleHostLine">
                Hosted by <strong>{community.host.name}</strong>
              </p>
            </div>
          </div>

          <div className="circleHeroActionBar">
            <ul className="circleStats" aria-label="Community stats">
              <li>
                <strong>{formatCount(community.memberCount)}</strong>
                <span>{community.memberCount === 1 ? "Member" : "Members"}</span>
              </li>
              <li>
                <strong>{formatCount(community.weeklyPosts)}</strong>
                <span>Posts this week</span>
              </li>
            </ul>
            <MembershipActions community={community} notify={notify} onChange={update} />
          </div>

          {community.topics.length > 0 && (
            <div className="circleTopicPills">
              <span className="circleTopicLabel">Topics:</span>
              {community.topics.map((topic) => (
                <span key={topic.slug} className="circlePillTag">
                  {topic.name}
                </span>
              ))}
            </div>
          )}
        </section>

        <div className="circleTwoColLayout">
          <div className="circleFeedCol">
            <section className="circleSectionCard" aria-labelledby="about-title">
              <div className="circleSectionHeading">
                <div>
                  <span className="circleKicker">About</span>
                  <h2 id="about-title">About {community.name}</h2>
                </div>
              </div>
              <p className="circleAboutText">{community.description}</p>
            </section>

            <section className="circleSectionCard" aria-labelledby="discussions-title">
              <div className="circleSectionHeading">
                <div>
                  <span className="circleKicker">Discussions</span>
                  <h2 id="discussions-title">Community discussions</h2>
                </div>
              </div>
              <p className="circleAboutText">Discussions open in the next update</p>
            </section>
          </div>

          <aside className="circleAsideCol">
            <div className="circleSidebarPanel">
              <span className="circleKicker">Circle details</span>
              <ul className="logisticsList">
                <li>
                  <span>Access</span>
                  <strong>{ACCESS_LABELS[community.visibility] ?? "On request"}</strong>
                </li>
                <li>
                  <span>Host workspace</span>
                  <strong>{community.host.name}</strong>
                </li>
                <li>
                  <span>Location</span>
                  <strong>{location}</strong>
                </li>
                <li>
                  <span>Target stage</span>
                  <strong>{community.stage.label}</strong>
                </li>
                {since && (
                  <li>
                    <span>Since</span>
                    <strong>{since}</strong>
                  </li>
                )}
              </ul>
            </div>
          </aside>
        </div>
      </>
    );
  }

  return (
    <main className="sparkLanding circleDetailRoot">
      <SignalParticles />
      <SiteHeader />

      <nav className="circleBreadcrumbHeader" aria-label="Breadcrumb">
        <div className="circleBreadcrumbContainer">
          <Link href="/communities" className="circleBackLink">
            Back to directory
          </Link>
          {community && (
            <>
              <span className="circleBreadcrumbDivider">/</span>
              <span className="circleBreadcrumbCurrent">{community.name}</span>
            </>
          )}
        </div>
      </nav>

      <div className="circlePageContainer">{content}</div>

      <div aria-live="polite" className="circleToastRegion" role="status">
        {toast && (
          <div className="circleToast" key={toast.id}>
            {toast.text}
          </div>
        )}
      </div>

      <SiteFooter />
    </main>
  );
}
