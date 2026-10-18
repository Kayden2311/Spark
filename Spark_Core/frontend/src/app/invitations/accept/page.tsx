"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useAuth } from "../../auth-context";
import { SparkLogo as SparkMark } from "../../brand/spark-logo";
import { initials } from "../../components";
import { ApiError, SESSION_EXPIRED_EVENT, messageOf, roleLabel, workspaceApi, type AcceptedInvitation, type InvitationPreview } from "../../w/_lib/api";

/** The emailed token lives here between the link and the accept call, so sign-in and sign-up can come back to it. */
const INVITE_TOKEN_KEY = "spark:invite-token";
const TOKEN_PATTERN = /^[0-9a-f]{64}$/u;
const RETURN_TO = "/invitations/accept";

type Terminal = "invalid" | "expired" | "revoked" | "used";
type State =
  | { kind: "loading" }
  | { kind: "terminal"; reason: Terminal }
  | { kind: "error"; message: string }
  | { kind: "ready"; token: string; preview: InvitationPreview };

const TERMINAL_COPY: Record<Terminal, { title: string; text: string }> = {
  invalid: { title: "This invitation link isn't valid", text: "The link may be incomplete or was replaced by a newer invitation. Ask the person who invited you to send a new one." },
  expired: { title: "This invitation has expired", text: "Invitation links work for 7 days. Ask the person who invited you to resend it." },
  revoked: { title: "This invitation was withdrawn", text: "An owner or admin revoked it. If you still need access, ask them for a new invitation." },
  used: { title: "This invitation was already used", text: "Each invitation link works once. If it was yours, the workspace is waiting in your workspace list." },
};

const ROLE_COPY: Record<string, string> = {
  admin: "invite people and manage members",
  member: "collaborate on every project",
};

const dateFormat = new Intl.DateTimeFormat("en", { day: "numeric", month: "long", year: "numeric" });

function readStored(): string | null {
  try {
    return window.sessionStorage.getItem(INVITE_TOKEN_KEY);
  } catch {
    return null;
  }
}

function store(token: string | null): void {
  try {
    if (token) window.sessionStorage.setItem(INVITE_TOKEN_KEY, token);
    else window.sessionStorage.removeItem(INVITE_TOKEN_KEY);
  } catch {
    // Blocked storage: the token only survives this page view.
  }
}

/** Moves `#token=…` out of the address bar (and history) into session storage, then returns the token to use. */
function takeToken(): string | null {
  const fromHash = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (window.location.hash) window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  if (fromHash) {
    store(fromHash);
    return fromHash;
  }
  return readStored();
}

function terminalFor(status: string): Terminal | null {
  if (status === "expired") return "expired";
  if (status === "revoked") return "revoked";
  if (status === "accepted") return "used";
  return status === "pending" ? null : "invalid";
}

const ACCEPT_CODES: Record<string, Terminal> = {
  invalid_invitation: "invalid",
  invitation_expired: "expired",
  invitation_revoked: "revoked",
  invitation_used: "used",
};

export default function AcceptInvitationPage() {
  const router = useRouter();
  const { isAuthenticated, isLoading, user, logout, refreshSession } = useAuth();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);

  useEffect(() => {
    const token = takeToken();
    const controller = new AbortController();
    const settle = (next: State) => { if (!controller.signal.aborted) setState(next); };
    if (!token || !TOKEN_PATTERN.test(token)) {
      store(null);
      queueMicrotask(() => settle({ kind: "terminal", reason: "invalid" }));
      return () => controller.abort();
    }
    workspaceApi<InvitationPreview>("/invitations/preview", { method: "POST", body: { token }, signal: controller.signal })
      .then(({ data }) => {
        const reason = terminalFor(data.status);
        if (reason) store(null);
        settle(reason ? { kind: "terminal", reason } : { kind: "ready", token, preview: data });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 404) {
          store(null);
          settle({ kind: "terminal", reason: "invalid" });
        } else settle({ kind: "error", message: messageOf(error) });
      });
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    const onExpired = () => void refreshSession();
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [refreshSession]);

  const join = async () => {
    if (state.kind !== "ready" || joining) return;
    setJoining(true);
    setJoinError(null);
    try {
      const { data } = await workspaceApi<AcceptedInvitation>("/invitations/accept", { method: "POST", body: { token: state.token } });
      store(null);
      await refreshSession();
      router.push(`/w/${data.workspace.slug}`);
    } catch (error) {
      setJoining(false);
      const code = error instanceof ApiError ? error.code : "";
      if (ACCEPT_CODES[code]) {
        store(null);
        setState({ kind: "terminal", reason: ACCEPT_CODES[code] });
      } else if (code === "recipient_mismatch") setMismatch(true);
      else if (code === "membership_suspended") setJoinError("Your membership in this workspace is suspended. Contact a workspace owner.");
      else setJoinError(messageOf(error));
    }
  };

  const signOut = async () => {
    setMismatch(false);
    await logout();
  };

  return (
    <div className="wsOnboarding wsAccept">
      <div aria-hidden="true" className="authAmbientGrid" />
      <div aria-hidden="true" className="wsGlow" />
      <div aria-hidden="true" className="wsGlow two" />
      <header className="wsOnboardingHeader">
        <Link aria-label="Spark home" className="sparkBrand" href="/">
          <SparkMark />
          <span>Spark</span>
        </Link>
        {isAuthenticated && user && (
          <div className="wsOnboardingUser">
            <span className="wsAcceptWho">{user.email}</span>
            <span aria-hidden="true" className="avatar">{initials(user.displayName, "U")}</span>
          </div>
        )}
      </header>

      <main className="wsAcceptMain">
        {state.kind === "loading" && (
          <div aria-busy="true" className="wsAcceptCard wsAcceptLoading" role="status">
            <span className="wsSrOnly">Checking your invitation…</span>
            <span /><span /><span />
          </div>
        )}

        {state.kind === "terminal" && (
          <section aria-labelledby="accept-title" className="wsAcceptCard wsAcceptState">
            <span aria-hidden="true" className="wsAcceptStateIcon">
              <svg viewBox="0 0 24 24"><rect height="13" rx="2.5" width="16" x="4" y="5.5" /><path d="M4 7.5 12 13l8-5.5" /><path d="m17 15 4 4M21 15l-4 4" /></svg>
            </span>
            <h1 id="accept-title">{TERMINAL_COPY[state.reason].title}</h1>
            <p>{TERMINAL_COPY[state.reason].text}</p>
            <div className="wsAcceptActions">
              {isAuthenticated && <Link className="sparkPrimary" href="/workspace">Open my workspaces</Link>}
              <Link className={isAuthenticated ? "sparkSecondary" : "sparkPrimary"} href="/">Go to Spark</Link>
            </div>
          </section>
        )}

        {state.kind === "error" && (
          <section aria-labelledby="accept-title" className="wsAcceptCard wsAcceptState">
            <h1 id="accept-title">We couldn&apos;t open this invitation</h1>
            <p role="alert">{state.message}</p>
            <div className="wsAcceptActions">
              <button className="sparkPrimary" onClick={() => { setState({ kind: "loading" }); setAttempt((value) => value + 1); }} type="button">Try again</button>
            </div>
          </section>
        )}

        {state.kind === "ready" && (
          <section aria-labelledby="accept-title" className="wsAcceptCard">
            <div className="wsAcceptBanner">
              <span aria-hidden="true" className="avatar wsAcceptAvatar">{initials(state.preview.workspaceName, "W")}</span>
              <div>
                <p className="wsAcceptKicker">You&apos;re invited</p>
                <h1 id="accept-title">Join {state.preview.workspaceName}</h1>
              </div>
            </div>
            <div className="wsAcceptBody">
              <p className="wsAcceptLead">
                {state.preview.inviterName} invited you to join as {state.preview.role === "admin" ? "an" : "a"} <strong>{roleLabel(state.preview.role ?? "member").toLowerCase()}</strong>
                {ROLE_COPY[state.preview.role ?? "member"] ? `, so you can ${ROLE_COPY[state.preview.role ?? "member"]}.` : "."}
              </p>
              <dl className="wsAcceptFacts">
                <div><dt>Workspace</dt><dd>{state.preview.workspaceName}</dd></div>
                <div><dt>Invited by</dt><dd>{state.preview.inviterName}</dd></div>
                <div><dt>Role</dt><dd><span className="wsRole" data-role={state.preview.role ?? "member"}>{roleLabel(state.preview.role ?? "member")}</span></dd></div>
                <div><dt>Sent to</dt><dd className="wsMono">{state.preview.emailHint}</dd></div>
                {state.preview.expiresAt && <div><dt>Expires</dt><dd>{dateFormat.format(new Date(state.preview.expiresAt))}</dd></div>}
              </dl>

              {isLoading ? (
                <div aria-busy="true" className="wsAcceptPending" role="status">Checking your session…</div>
              ) : !isAuthenticated ? (
                <div className="wsAcceptSignedOut">
                  <p>Sign in or create an account with the address this invitation was sent to. You&apos;ll come straight back here to accept.</p>
                  <div className="wsAcceptActions">
                    <Link className="sparkPrimary" href={`/login?redirect=${RETURN_TO}`}>Sign in to accept</Link>
                    <Link className="sparkSecondary" href={`/signup?redirect=${RETURN_TO}`}>Create account</Link>
                  </div>
                </div>
              ) : mismatch ? (
                <div className="wsAcceptMismatch" role="alert">
                  <p><strong>This invitation was sent to {state.preview.emailHint}. Sign out and use that account.</strong></p>
                  <p>You&apos;re signed in as {user?.email}. The invitation stays open until it&apos;s used or expires.</p>
                  <div className="wsAcceptActions">
                    <button className="sparkPrimary" onClick={() => void signOut()} type="button">Sign out</button>
                  </div>
                </div>
              ) : (
                <div className="wsAcceptSignedIn">
                  {joinError && <p className="wsAlert" role="alert">{joinError}</p>}
                  <button className="sparkPrimary wsSubmit" disabled={joining} onClick={() => void join()} type="button">
                    {joining ? "Joining…" : `Join ${state.preview.workspaceName}`}
                  </button>
                  <p className="wsFormFoot">Signed in as {user?.email}.</p>
                </div>
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
