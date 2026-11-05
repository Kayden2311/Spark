"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

import { PageTitle, WorkspaceShell, initials } from "../components";
import { useAuth } from "../auth-context";
import {
  communityKindLabel,
  fetchNotifications,
  internalLink,
  markAllNotificationsRead,
  markNotificationRead,
  newestCreatedAt,
  relativeTime,
  type AppNotification,
  type NotificationFilter,
} from "../_lib/notifications";
import { useUnreadCount } from "../_lib/use-unread-count";
import { ApiError, SESSION_EXPIRED_EVENT, messageOf } from "../w/_lib/api";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; items: AppNotification[]; nextCursor: string | null };
type Settled = Exclude<Load, { status: "loading" }> & { key: string };

const NAVIGATE_AFTER_MS = 1000;
/** A double click must not act twice, so a guard stays up for a moment after the work is done. */
function releaseSoon(guard: { current: string | null }) {
  setTimeout(() => { guard.current = null; }, 800);
}

const FILTERS: Array<[NotificationFilter, string]> = [["all", "All"], ["unread", "Unread"]];

function Row({ item, now, onOpen }: { item: AppNotification; now: number; onOpen(item: AppNotification): void }) {
  const unread = item.readAt === null;
  const community = communityKindLabel(item.kind);
  return (
    <li>
      <button className={unread ? "notification notificationRow unread" : "notification notificationRow"} onClick={() => onOpen(item)} type="button">
        {community ? (
          <span aria-hidden="true" className="notificationCommunityIcon">
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /><path d="m15.5 8.5-2.1 4.9-4.9 2.1 2.1-4.9z" /></svg>
          </span>
        ) : (
          <span aria-hidden="true" className="avatar">{initials(item.workspace.name)}</span>
        )}
        <span className="notificationBody">
          <span className="notificationWorkspace">{community ? `Community · hosted by ${item.workspace.name}` : item.workspace.name}</span>
          <strong className="notificationTitle">{item.title}</strong>
          {community && <span className="spBadge notificationKind" data-kind={item.kind}>{community}</span>}
          {item.body && <span className="notificationText">{item.body}</span>}
          <time dateTime={item.createdAt}>{relativeTime(item.createdAt, now)}</time>
        </span>
        {unread && <span aria-label="Unread" className="unreadDot" role="img" />}
      </button>
    </li>
  );
}

function Inbox() {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const urlFilter: NotificationFilter = params.get("filter") === "unread" ? "unread" : "all";
  const [filter, setFilter] = useState<NotificationFilter>(urlFilter);
  // Back and forward change the URL parameter; the tab follows it.
  const [seenUrlFilter, setSeenUrlFilter] = useState(urlFilter);
  if (urlFilter !== seenUrlFilter) {
    setSeenUrlFilter(urlFilter);
    setFilter(urlFilter);
  }
  const [reloadKey, setReloadKey] = useState(0);
  const [settled, setSettled] = useState<Settled | null>(null);
  const key = `${filter}:${reloadKey}`;
  const load: Load = settled && settled.key === key ? settled : { status: "loading" };
  const [moreBusy, setMoreBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { count, refresh } = useUnreadCount();
  const alive = useRef(true);
  const inflight = useRef(new Set<string>());
  const navigatedId = useRef<string | null>(null);
  const markAllGuard = useRef<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const [announcement, setAnnouncement] = useState({ id: 0, text: "" });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const toLogin = useCallback(() => router.replace(`/login?redirect=${encodeURIComponent("/notifications")}`), [router]);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) toLogin();
  }, [isAuthenticated, isLoading, toLogin]);

  useEffect(() => {
    window.addEventListener(SESSION_EXPIRED_EVENT, toLogin);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, toLogin);
  }, [toLogin]);

  useEffect(() => {
    const controller = new AbortController();
    fetchNotifications(filter, null, controller.signal)
      .then((page) => {
        setNow(Date.now());
        setSettled({ key, status: "ready", items: page.items, nextCursor: page.nextCursor });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSettled({ key, status: "error", message: messageOf(error) });
      });
    return () => controller.abort();
  }, [filter, key]);

  const chooseFilter = (next: NotificationFilter) => {
    if (next === filter) return;
    setFilter(next);
    setNotice(null);
    const url = new URL(window.location.href);
    if (next === "unread") url.searchParams.set("filter", "unread");
    else url.searchParams.delete("filter");
    window.history.replaceState(window.history.state, "", url);
  };

  const patchItems = (update: (item: AppNotification) => AppNotification) =>
    setSettled((current) => (current && current.status === "ready" ? { ...current, items: current.items.map(update) } : current));

  const open = async (item: AppNotification) => {
    // One click per row at a time; other rows stay clickable while this one is working.
    if (inflight.current.has(item.id) || navigatedId.current === item.id) return;
    const link = internalLink(item.link);
    if (item.readAt !== null) {
      if (link) {
        navigatedId.current = item.id;
        router.push(link);
      }
      return;
    }
    inflight.current.add(item.id);
    const stamp = new Date().toISOString();
    patchItems((entry) => (entry.id === item.id ? { ...entry, readAt: stamp } : entry));
    let expired = false;
    const settle = markNotificationRead(item.id).then(
      () => {
        // The store is module-level, so the badge refreshes even if this page is already gone.
        refresh();
      },
      (error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          expired = true;
          return;
        }
        if (!alive.current) return;
        patchItems((entry) => (entry.id === item.id ? { ...entry, readAt: null } : entry));
        setNotice(link ? "That notification could not be marked as read." : messageOf(error));
      },
    );
    // A slow request must not make the click look dead: after a moment the link is followed anyway.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([settle, new Promise<void>((resolve) => { timer = setTimeout(resolve, NAVIGATE_AFTER_MS); })]);
    clearTimeout(timer);
    inflight.current.delete(item.id);
    // After a 401 the session-expired redirect to the login page wins.
    if (link && alive.current && !expired) {
      navigatedId.current = item.id;
      router.push(link);
    }
  };

  const items = load.status === "ready" ? load.items : [];
  const hasUnread = items.some((item) => item.readAt === null) || (count ?? 0) > 0;

  const markAll = async () => {
    const before = newestCreatedAt(items);
    if (before === null || markAllGuard.current) return;
    markAllGuard.current = "busy";
    setMarkingAll(true);
    const stamp = new Date().toISOString();
    setNotice(null);
    try {
      const updated = await markAllNotificationsRead(before);
      if (!alive.current) return;
      if (updated === 0 && (count ?? 0) > 0) {
        // Newer notifications arrived since the list loaded: show them so the next click covers them.
        refresh();
        setReloadKey((value) => value + 1);
        return;
      }
      setSettled((current) => {
        if (!current || current.status !== "ready") return current;
        const marked = current.items.map((entry) => (entry.createdAt <= before && entry.readAt === null ? { ...entry, readAt: stamp } : entry));
        // Everything older than the newest loaded row is read now, so the unread list has no further page.
        return { ...current, items: marked, nextCursor: filter === "unread" ? null : current.nextCursor };
      });
      setAnnouncement((previous) => ({ id: previous.id + 1, text: `Marked ${updated} as read` }));
      refresh();
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401) && alive.current) setNotice(messageOf(error));
    } finally {
      if (alive.current) setMarkingAll(false);
      releaseSoon(markAllGuard);
    }
  };

  const loadMore = async () => {
    if (load.status !== "ready" || !load.nextCursor || moreBusy) return;
    setMoreBusy(true);
    setNotice(null);
    try {
      const page = await fetchNotifications(filter, load.nextCursor);
      if (!alive.current) return;
      setSettled((current) => {
        if (!current || current.key !== key || current.status !== "ready") return current;
        const known = new Set(current.items.map((entry) => entry.id));
        return { key, status: "ready", items: [...current.items, ...page.items.filter((entry) => !known.has(entry.id))], nextCursor: page.nextCursor };
      });
    } catch (error) {
      if (alive.current) setNotice(messageOf(error));
    } finally {
      if (alive.current) setMoreBusy(false);
    }
  };

  return (
    <>
      <PageTitle eyebrow="Inbox" title="Notifications">
        <button className="textButton" disabled={load.status !== "ready" || !hasUnread || markingAll} onClick={() => void markAll()} type="button">Mark all as read</button>
      </PageTitle>
      <div aria-label="Filter notifications" className="notificationTabs" role="group">
        {FILTERS.map(([value, label]) => (
          <button aria-pressed={filter === value} className="notificationTab" key={value} onClick={() => chooseFilter(value)} type="button">{label}</button>
        ))}
      </div>
      <p aria-live="polite" className="wsSrOnly" key={announcement.id} role="status">{announcement.text}</p>
      {notice && <p className="notificationNotice" role="status">{notice}</p>}
      {load.status === "loading" && (
        <div aria-busy="true" className="notificationLoading" role="status">
          <span className="wsSrOnly">Loading notifications…</span>
          {Array.from({ length: 3 }, (_, index) => <span className="vizSkeleton" key={index} />)}
        </div>
      )}
      {load.status === "error" && (
        <div className="wsCard notificationState" role="alert">
          <p>{load.message}</p>
          <button className="sparkSecondary" onClick={() => { setNotice(null); setReloadKey((value) => value + 1); }} type="button">Try again</button>
        </div>
      )}
      {load.status === "ready" && load.items.length === 0 && (
        <div className="wsEmpty">
          <h2 className="wsEmptyTitle">{filter === "unread" ? "You're all caught up" : "No notifications yet"}</h2>
          <p className="wsEmptyText">{filter === "unread" ? "Nothing unread right now." : "Assignments and reminders from your workspaces show up here."}</p>
        </div>
      )}
      {load.status === "ready" && load.items.length > 0 && (
        <>
          <ul aria-label="Notifications" className="notificationList notificationItems">
            {load.items.map((item) => <Row item={item} key={item.id} now={now} onOpen={(entry) => void open(entry)} />)}
          </ul>
          {load.nextCursor && (
            <div className="notificationMore">
              <button className="sparkSecondary" disabled={moreBusy} onClick={() => void loadMore()} type="button">{moreBusy ? "Loading…" : "Load more"}</button>
            </div>
          )}
        </>
      )}
    </>
  );
}

export default function NotificationsPage() {
  return (
    <WorkspaceShell current="Notifications">
      <Suspense fallback={<PageTitle eyebrow="Inbox" title="Notifications" />}>
        <Inbox />
      </Suspense>
    </WorkspaceShell>
  );
}
