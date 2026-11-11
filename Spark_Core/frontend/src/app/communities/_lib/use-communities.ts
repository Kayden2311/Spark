"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { filtersFromParams, filtersToSearch, type CommunityFilters } from "../filter";
import type { CommunityCard, CommunityDetail, CommunityFilterOptions } from "../types";
import { ApiError, communitiesApi, cooldownEndsAt, messageOf } from "./api";

interface DirectorySettled {
  /** The request (retry count and filters) this result belongs to. */
  key: string;
  items: CommunityCard[];
  nextCursor: string | null;
  error: string | null;
}

interface MoreState {
  key: string;
  loading: boolean;
  error: string | null;
}

/** Appends `next` to `items`, skipping communities already listed (pages can overlap after edits). */
export function appendUnique(items: CommunityCard[], next: CommunityCard[]): CommunityCard[] {
  const seen = new Set(items.map((item) => item.id));
  const added = next.filter((item) => !seen.has(item.id) && seen.add(item.id));
  return added.length > 0 ? [...items, ...added] : items;
}

/**
 * The directory for a set of filters: the first page, then "Show more" pages by `nextCursor`.
 * While new filters load, the previous results stay on screen (`loading` is true).
 */
export function useCommunityDirectory(filters: CommunityFilters) {
  const search = filtersToSearch(filters);
  const stable = useMemo(() => filtersFromParams(new URLSearchParams(search)), [search]);
  const [attempt, setAttempt] = useState(0);
  const key = `${attempt}:${search}`;
  const [settled, setSettled] = useState<DirectorySettled>({ key: "", items: [], nextCursor: null, error: null });
  const [more, setMore] = useState<MoreState>({ key: "", loading: false, error: null });

  useEffect(() => {
    const controller = new AbortController();
    communitiesApi
      .list(stable, null, controller.signal)
      .then((page) => setSettled({ key, items: page.items, nextCursor: page.nextCursor, error: null }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSettled((previous) => ({ key, items: previous.items, nextCursor: null, error: messageOf(error) }));
      });
    return () => controller.abort();
  }, [key, stable]);

  const current = settled.key === key;
  const cursor = current ? settled.nextCursor : null;
  const loadingMore = more.key === key && more.loading;

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setMore({ key, loading: true, error: null });
    try {
      const page = await communitiesApi.list(stable, cursor);
      setSettled((previous) => (previous.key === key ? { ...previous, items: appendUnique(previous.items, page.items), nextCursor: page.nextCursor } : previous));
      setMore({ key, loading: false, error: null });
    } catch (error) {
      setMore({ key, loading: false, error: messageOf(error) });
    }
  }, [cursor, key, loadingMore, stable]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return {
    items: settled.items,
    nextCursor: cursor,
    loading: !current,
    error: current ? settled.error : null,
    loadMore,
    loadingMore,
    loadMoreError: more.key === key ? more.error : null,
    retry,
  };
}

/** Topic, stage and country options with counts; null until loaded (or when they could not load). */
export function useFilterOptions(): CommunityFilterOptions | null {
  const [options, setOptions] = useState<CommunityFilterOptions | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    communitiesApi
      .filterOptions(controller.signal)
      .then(setOptions)
      .catch(() => {
        // The filter bar falls back to "any" choices; the results still load.
      });
    return () => controller.abort();
  }, []);
  return options;
}

/** The signed-in viewer's communities; empty when signed out or when the list could not load. */
export function useMyCommunities(enabled: boolean): CommunityCard[] {
  const [settled, setSettled] = useState<{ enabled: boolean; items: CommunityCard[] }>({ enabled: false, items: [] });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    communitiesApi
      .mine(controller.signal)
      .then((data) => setSettled({ enabled: true, items: data.items }))
      .catch(() => {
        // The strip is a shortcut; without it the directory still works.
      });
    return () => controller.abort();
  }, [enabled]);
  return enabled && settled.enabled ? settled.items : [];
}

/** "signed_out": the read answered 401 (the session ended); callers send the user to sign in. */
export type CommunityStatus = "loading" | "ready" | "not_found" | "signed_out" | "error";

interface CommunitySettled {
  key: string;
  community: CommunityDetail | null;
  status: CommunityStatus;
  error: string | null;
}

/** One community by slug as the session sees it. Hidden and unknown communities are "not_found". */
export function useCommunity(slug: string, enabled = true) {
  const [attempt, setAttempt] = useState(0);
  const key = `${attempt}:${slug}`;
  const [settled, setSettled] = useState<CommunitySettled>({ key: "", community: null, status: "loading", error: null });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    communitiesApi
      .detail(slug, controller.signal)
      .then((community) => setSettled({ key, community, status: "ready", error: null }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const missing = error instanceof ApiError && error.status === 404;
        const signedOut = error instanceof ApiError && error.status === 401;
        setSettled({ key, community: null, status: missing ? "not_found" : signedOut ? "signed_out" : "error", error: messageOf(error) });
      });
    return () => controller.abort();
  }, [enabled, key, slug]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  /** Applies a local change after a successful write (for example a new viewer status). */
  const update = useCallback(
    (change: (community: CommunityDetail) => CommunityDetail) =>
      setSettled((previous) => (previous.key === key && previous.community ? { ...previous, community: change(previous.community) } : previous)),
    [key],
  );

  const current = settled.key === key;
  return {
    community: current ? settled.community : null,
    status: current ? settled.status : ("loading" as CommunityStatus),
    error: current ? settled.error : null,
    retry,
    update,
  };
}

/**
 * Whether a declined request still holds the viewer back from asking again (GET /me/community-requests).
 * `checked` stays false until the answer arrives; a failed read counts as no cooldown (the API still refuses).
 */
export function useRequestCooldown(slug: string, enabled: boolean): { checked: boolean; until: string | null } {
  const [settled, setSettled] = useState<{ slug: string; until: string | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    communitiesApi
      .myRequests(controller.signal)
      .then(({ items }) => setSettled({ slug, until: cooldownEndsAt(items, slug) }))
      .catch(() => {
        if (!controller.signal.aborted) setSettled({ slug, until: null });
      });
    return () => controller.abort();
  }, [enabled, slug]);
  const current = enabled && settled?.slug === slug ? settled : null;
  return { checked: current !== null, until: current?.until ?? null };
}
