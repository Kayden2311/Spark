"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

import { PageTitle, WorkspaceShell, initials } from "../components";
import { useAuth } from "../auth-context";
import {
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

const FILTERS: Array<[NotificationFilter, string]> = [["all", "All"], ["unread", "Unread"]];

function Row({ item, now, onOpen }: { item: AppNotification; now: number; onOpen(item: AppNotification): void }) {
  const unread = item.readAt === null;
  return (
    <li>
      <button className={unread ? "notification notificationRow unread" : "notification notificationRow"} onClick={() => onOpen(item)} type="button">
        <span aria-hidden="true" className="avatar">{initials(item.workspace.name)}</span>
        <span className="notificationBody">
          <span className="notificationWorkspace">{item.workspace.name}</span>
          <strong className="notificationTitle">{item.title}</strong>
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
  const [filter, setFilter] = useState<NotificationFilter>(() => (params.get("filter") === "unread" ? "unread" : "all"));
  const [reloadKey, setReloadKey] = useState(0);
  const [settled, setSettled] = useState<Settled | null>(null);
  const key = `${filter}:${reloadKey}`;
  const load: Load = settled && settled.key === key ? settled : { status: "loading" };
  const [moreBusy, setMoreBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { count, refresh } = useUnreadCount();
  const alive = useRef(true);

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
    const link = internalLink(item.link);
    if (item.readAt !== null) {
      if (link) router.push(link);
      return;
    }
    const stamp = new Date().toISOString();
    patchItems((entry) => (entry.id === item.id ? { ...entry, readAt: stamp } : entry));
    try {
      // Waited for so the next page's badge poll sees the new count.
      await markNotificationRead(item.id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return;
      if (alive.current) {
        patchItems((entry) => (entry.id === item.id ? { ...entry, readAt: null } : entry));
        setNotice(link ? "That notification could not be marked as read." : messageOf(error));
      }
    }
    if (alive.current) refresh();
    if (link) router.push(link);
  };

  const items = load.status === "ready" ? load.items : [];
  const hasUnread = items.some((item) => item.readAt === null) || (count ?? 0) > 0;

  const markAll = async () => {
    const before = newestCreatedAt(items);
    if (before === null) return;
    const stamp = new Date().toISOString();
    setNotice(null);
    try {
      await markAllNotificationsRead(before);
      patchItems((entry) => (entry.createdAt <= before && entry.readAt === null ? { ...entry, readAt: stamp } : entry));
      refresh();
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) setNotice(messageOf(error));
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
        <button className="textButton" disabled={load.status !== "ready" || !hasUnread} onClick={() => void markAll()} type="button">Mark all as read</button>
      </PageTitle>
      <div aria-label="Filter notifications" className="notificationTabs" role="tablist">
        {FILTERS.map(([value, label]) => (
          <button aria-selected={filter === value} className="notificationTab" key={value} onClick={() => chooseFilter(value)} role="tab" tabIndex={filter === value ? 0 : -1} type="button">{label}</button>
        ))}
      </div>
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
