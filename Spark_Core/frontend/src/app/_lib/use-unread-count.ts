"use client";

import { useSyncExternalStore } from "react";

import { ApiError } from "../w/_lib/api";
import { fetchUnreadCount } from "./notifications";

const POLL_MS = 30_000;
const GUARD_MS = 1000;
// Every page renders its own shell, so a navigation unmounts one consumer just before the next mounts.
const GRACE_MS = 2000;

/*
 * One poll serves every mounted consumer: the shell badge and the inbox page share a module-level store that
 * starts with the first subscriber and stops with the last one.
 */
let count: number | null = null;
let stopped = false;
let timer: ReturnType<typeof setInterval> | null = null;
let controller: AbortController | null = null;
let lastEvent = 0;
let grace: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function load() {
  if (stopped) return;
  controller?.abort();
  const mine = new AbortController();
  controller = mine;
  fetchUnreadCount(mine.signal)
    .then((value) => {
      if (mine.signal.aborted) return;
      count = value;
      emit();
    })
    .catch((error: unknown) => {
      if (mine.signal.aborted) return;
      // A 401 ends the session for the whole shell: stop asking. Other failures keep the last known count.
      if (error instanceof ApiError && error.status === 401) {
        stopped = true;
        if (timer !== null) clearInterval(timer);
        timer = null;
      }
    });
}

function onVisible() {
  if (document.visibilityState === "hidden") return;
  const at = Date.now();
  // focus and visibilitychange usually fire together, so only the first one within a second reloads.
  if (at - lastEvent < GUARD_MS) return;
  lastEvent = at;
  load();
}

function tick() {
  if (document.visibilityState === "hidden") return;
  load();
}

function start() {
  stopped = false;
  lastEvent = 0;
  load();
  timer = setInterval(tick, POLL_MS);
  window.addEventListener("focus", onVisible);
  document.addEventListener("visibilitychange", onVisible);
}

function stop() {
  if (timer !== null) clearInterval(timer);
  timer = null;
  controller?.abort();
  controller = null;
  window.removeEventListener("focus", onVisible);
  document.removeEventListener("visibilitychange", onVisible);
  count = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (grace !== null) {
    clearTimeout(grace);
    grace = null;
  } else if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      grace = setTimeout(() => {
        grace = null;
        if (listeners.size === 0) stop();
      }, GRACE_MS);
    }
  };
}

function refresh() {
  if (listeners.size > 0) load();
}

const getSnapshot = () => count;
const getServerSnapshot = () => null;

/** The number of unread notifications (null until known), kept fresh while the tab is visible. */
export function useUnreadCount(): { count: number | null; refresh(): void } {
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { count: value, refresh };
}

/** Tests only: drops the shared store so the next test starts without a previous count or timers. */
export function resetUnreadCountForTests() {
  if (grace !== null) clearTimeout(grace);
  grace = null;
  listeners.clear();
  stop();
  stopped = false;
}
