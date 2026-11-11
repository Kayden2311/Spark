"use client";

import Link from "next/link";
import { notFound, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "../../../auth-context";
import { ApiError, communitiesApi, cooldownMessage, isSignedOut, loginPath, membershipErrorMessage, PAUSED_MESSAGE } from "../../_lib/api";
import { useCommunity, useRequestCooldown } from "../../_lib/use-communities";

export const MAX_MESSAGE_LENGTH = 500;

const MEMBER_STATUSES = new Set(["owner", "moderator", "member"]);

function StateCard({ title, children, slug, name }: { title: string; children: React.ReactNode; slug: string; name: string | null }) {
  return (
    <div className="authCardWrapper">
      <h1 className="authHeading">{title}</h1>
      {children}
      <div className="authSwitchNotice">
        <Link href={`/communities/${encodeURIComponent(slug)}`}>Back to {name ?? "the community"}</Link>
      </div>
    </div>
  );
}

export function RequestForm({ slug }: { slug: string }) {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const signedOut = !isLoading && !isAuthenticated;
  const { community, status, error: loadError, retry } = useCommunity(slug, isAuthenticated);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [alreadyMember, setAlreadyMember] = useState(false);

  const base = `/communities/${encodeURIComponent(slug)}`;
  const requestPath = `${base}/request`;
  const outsider = community !== null && (community.viewerStatus === null || community.viewerStatus === "none");
  // Public communities are joined on their page; there is nothing to request.
  const joinInstead = community?.visibility === "public" && outsider;
  const cooldown = useRequestCooldown(slug, outsider && !community?.canManage && !community?.frozen);

  useEffect(() => {
    if (signedOut || status === "signed_out") router.replace(loginPath(requestPath));
  }, [requestPath, router, signedOut, status]);
  useEffect(() => {
    if (joinInstead) router.replace(base);
  }, [base, joinInstead, router]);

  if (status === "not_found") notFound();

  if (signedOut || status === "signed_out") {
    return (
      <div className="authCardWrapper">
        <h1 className="authHeading">Sign in to request access</h1>
        <p className="authSubheading">Taking you to sign in. You will come back here afterwards.</p>
        <Link className="authSubmitBtn" href={loginPath(requestPath)}>
          Sign in
        </Link>
      </div>
    );
  }

  if (status === "error") {
    return (
      <StateCard title="This community could not load" slug={slug} name={null}>
        <div className="authAlertBanner" role="alert">
          <span>{loadError}</span>
        </div>
        <button className="authSubmitBtn" onClick={retry} type="button">Try again</button>
      </StateCard>
    );
  }

  if (!community || joinInstead) {
    return (
      <div className="authCardWrapper" aria-busy="true">
        <p className="authSubheading" role="status">Loading…</p>
      </div>
    );
  }

  const viewerStatus = community.viewerStatus;
  if (alreadyMember || (viewerStatus !== null && MEMBER_STATUSES.has(viewerStatus))) {
    return (
      <StateCard title="You're already a member" slug={slug} name={community.name}>
        <p className="authSubheading">You are a member of {community.name}.</p>
      </StateCard>
    );
  }
  if (viewerStatus === "pending") {
    return (
      <StateCard title="Request pending" slug={slug} name={community.name}>
        <p className="authSubheading">
          Your request to join {community.name} is waiting for the owners. You can withdraw it on the community page.
        </p>
      </StateCard>
    );
  }
  if (community.canManage) {
    // Managers (for example host workspace admins) never need to ask; they manage the community instead.
    return (
      <StateCard title="You manage this community" slug={slug} name={community.name}>
        <p className="authSubheading">You already help run {community.name}, so there is nothing to request.</p>
        <Link className="authSubmitBtn" href={`${base}/manage`}>Manage community</Link>
      </StateCard>
    );
  }
  if (community.frozen) {
    return (
      <StateCard title={`Request access to ${community.name}`} slug={slug} name={community.name}>
        <p className="authSubheading">{PAUSED_MESSAGE}</p>
      </StateCard>
    );
  }

  if (!cooldown.checked) {
    return (
      <div className="authCardWrapper" aria-busy="true">
        <p className="authSubheading" role="status">Loading…</p>
      </div>
    );
  }
  if (cooldown.until) {
    return (
      <StateCard title={`Request access to ${community.name}`} slug={slug} name={community.name}>
        <p className="authSubheading">{cooldownMessage(cooldown.until)}</p>
      </StateCard>
    );
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (sending) return;
    if (message.length > MAX_MESSAGE_LENGTH) {
      setError(`Keep your message to ${MAX_MESSAGE_LENGTH} characters or fewer.`);
      return;
    }
    setError(null);
    setSending(true);
    try {
      await communitiesApi.requestAccess(community.id, message.trim());
      router.push(`${requestPath}/sent`);
    } catch (failure) {
      setSending(false);
      if (isSignedOut(failure)) {
        router.push(loginPath(requestPath));
      } else if (failure instanceof ApiError && failure.code === "join_instead") {
        router.replace(base);
      } else if (failure instanceof ApiError && failure.code === "already_member") {
        setAlreadyMember(true);
      } else {
        setError(membershipErrorMessage(failure));
      }
    }
  };

  return (
    <div className="authCardWrapper">
      <h1 className="authHeading">Request access to {community.name}</h1>
      <p className="authSubheading">The owners of {community.name} review each request. You will get a notification when they decide.</p>
      {error && (
        <div className="authAlertBanner" role="alert">
          <span>{error}</span>
        </div>
      )}
      <form onSubmit={(event) => void handleSubmit(event)} className="authForm" noValidate>
        <div className="authField">
          <label htmlFor="request-message" className="authLabel">
            Message to the owners (optional)
          </label>
          <textarea
            id="request-message"
            className="authInput"
            rows={5}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="What are you building and why this circle?"
            aria-describedby="request-message-count"
          />
          <small id="request-message-count" aria-live="polite">
            {message.length}/{MAX_MESSAGE_LENGTH}
          </small>
        </div>
        <button type="submit" className="authSubmitBtn" disabled={sending}>
          {sending ? "Sending…" : "Send request"}
        </button>
      </form>
      <div className="authSwitchNotice">
        <Link href={base}>Back to {community.name}</Link>
      </div>
    </div>
  );
}
