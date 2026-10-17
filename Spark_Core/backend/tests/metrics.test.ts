import { afterEach, describe, expect, it } from "vitest";

import { RequestMetrics } from "../src/infrastructure/metrics.js";

describe("request metrics", () => {
  let clock = Date.UTC(2026, 9, 17, 10, 0, 30);
  const metrics = new RequestMetrics(() => clock);
  afterEach(() => metrics.close());

  it("buckets requests per minute and estimates latency percentiles", () => {
    for (let i = 0; i < 18; i++) metrics.record("GET", "/api/v1/communities", 200, 8);
    metrics.record("GET", "/api/v1/communities", 404, 40);
    metrics.record("POST", "/api/v1/admin/reports/:id/actions", 500, 900);
    clock += 60_000;
    metrics.record("GET", "/api/v1/communities", 200, 3);

    const { step, points } = metrics.series(3);
    expect(step).toBe(1);
    expect(points.map((point) => point.requests)).toEqual([0, 20, 1]);
    expect(points[1]).toMatchObject({ clientErrors: 1, serverErrors: 1, p95Ms: 50 });
    // A long window is summed into wider buckets, so the series still covers all of it.
    const wide = metrics.series(360);
    expect(wide.step).toBe(2);
    expect(wide.points).toHaveLength(180);
    expect(wide.points.reduce((sum, point) => sum + point.requests, 0)).toBe(21);

    const summary = metrics.summary(5);
    expect(summary).toMatchObject({ requests: 21, clientErrors: 1, serverErrors: 1, p50Ms: 10 });
    const failing = summary.routes.find((route) => route.route === "POST /api/v1/admin/reports/:id/actions");
    expect(failing).toMatchObject({ requests: 1, serverErrors: 1, avgMs: 900, p95Ms: 1000 });
    expect(summary.routes.find((route) => route.route === "GET /api/v1/communities")?.requests).toBe(20);
  });

  it("reports slow requests above the last bound and reads event-loop delay without resetting it", () => {
    metrics.record("GET", "unmatched", 404, 9000);
    expect(metrics.summary(1).routes.find((route) => route.route === "GET unmatched")?.p95Ms).toBe(10000);
    const first = metrics.eventLoop();
    expect(metrics.eventLoop()).toEqual(first);
  });

  it("forgets minutes older than a day", () => {
    clock += 25 * 60 * 60_000;
    metrics.record("GET", "/health", 200, 1);
    expect(metrics.summary(24 * 60).requests).toBe(1);
  });
});
