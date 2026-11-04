import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useUnreadCount } from "../src/app/_lib/use-unread-count";

let visibility: "visible" | "hidden" = "visible";
let counts: Response[] = [];
let requests = 0;

function reply(count: number) {
  return new Response(JSON.stringify({ count }), { status: 200, headers: { "content-type": "application/json" } });
}

function setVisibility(value: "visible" | "hidden") {
  visibility = value;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  requests = 0;
  counts = [];
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    expect(url).toBe("/api/v1/notifications/unread-count");
    requests += 1;
    return counts.shift() ?? reply(3);
  }));
});

afterEach(async () => {
  // Let the store tear down (its grace period) before the next test starts from a clean module state.
  cleanup();
  await vi.advanceTimersByTimeAsync(3000);
  delete (document as { visibilityState?: unknown }).visibilityState;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useUnreadCount", () => {
  it("loads on mount and polls every 30 seconds while visible", async () => {
    counts = [reply(2), reply(5)];
    const { result } = renderHook(() => useUnreadCount());
    expect(result.current.count).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.count).toBe(2);
    expect(requests).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(requests).toBe(2);
    expect(result.current.count).toBe(5);
  });

  it("makes no request while the tab is hidden and one when it returns", async () => {
    renderHook(() => useUnreadCount());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(requests).toBe(1);
    setVisibility("hidden");
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(requests).toBe(1);
    await act(async () => {
      setVisibility("visible");
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(requests).toBe(2);
  });

  it("shares one request between two consumers", async () => {
    const first = renderHook(() => useUnreadCount());
    const second = renderHook(() => useUnreadCount());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(requests).toBe(1);
    expect(first.result.current.count).toBe(3);
    expect(second.result.current.count).toBe(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(requests).toBe(2);
  });

  it("refresh asks again right away", async () => {
    const { result } = renderHook(() => useUnreadCount());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    counts = [reply(0)];
    await act(async () => { result.current.refresh(); await vi.advanceTimersByTimeAsync(0); });
    expect(requests).toBe(2);
    expect(result.current.count).toBe(0);
  });

  it("stops polling after a 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      requests += 1;
      return new Response(JSON.stringify({ code: "unauthorized" }), { status: 401, headers: { "content-type": "application/problem+json" } });
    }));
    const { result } = renderHook(() => useUnreadCount());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(requests).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); result.current.refresh(); await vi.advanceTimersByTimeAsync(0); });
    expect(requests).toBe(1);
    expect(result.current.count).toBeNull();
  });

  it("keeps the store and count across a remount within the grace period, then stops", async () => {
    const first = renderHook(() => useUnreadCount());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(requests).toBe(1);
    first.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    const second = renderHook(() => useUnreadCount());
    expect(second.result.current.count).toBe(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(requests).toBe(1);
    second.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(requests).toBe(1);
    const third = renderHook(() => useUnreadCount());
    expect(third.result.current.count).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(requests).toBe(2);
  });
});
