import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { decodeCursor, encodeCursor } from "../src/routes/pagination.js";
import { dbError, fakePool, principalRow, type QueryHandler } from "./fake-pool.js";

const config = loadConfig({ NODE_ENV: "test" });
const cookie = `spark_session=${"b".repeat(64)}`;
const tenantId = "1d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const noteId = "5d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const noteId2 = "6d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";

const base = "/api/v1/notifications";
const prefsUrl = "/api/v1/me/notification-preferences";

type Request = { method: "GET" | "PATCH" | "PUT"; url: string; payload?: unknown; headers?: Record<string, string> };
type Calls = Array<{ sql: string; params: unknown[] }>;

async function call(request: Request, handlers: Array<[string, QueryHandler]> = [], signedIn = true) {
  const { pool, calls } = fakePool([["auth_session_principal", signedIn ? () => [principalRow] : () => []], ...handlers]);
  const app = await buildApp({ config, pool, rateLimit: false, logger: false });
  try {
    const response = await app.inject({ ...request, headers: { ...(signedIn ? { cookie } : {}), ...request.headers } } as Parameters<typeof app.inject>[0]);
    return { response, calls };
  } finally {
    await app.close();
  }
}

const find = (calls: Calls, fragment: string) => calls.find((c) => c.sql.includes(fragment));
const called = (calls: Calls, fragment: string) => calls.some((c) => c.sql.includes(fragment));

const row = (over: object = {}) => ({
  id: noteId,
  tenant_id: tenantId,
  workspace_slug: "northstar",
  workspace_name: "Northstar",
  kind: "event_invited",
  title: "Sprint review",
  body: "Tomorrow",
  resource_type: "calendar_event",
  resource_id: "9d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6",
  link: "/w/northstar/schedule?week=2026-11-02",
  created_at_iso: "2026-10-31T08:15:30.123456+00:00",
  cursor_ts: "2026-10-31 08:15:30.123456+00",
  read_at: null,
  ...over,
});
const listHandler = (rows: object[]): [string, QueryHandler] => ["spark.ws_list_notifications", () => rows];
const prefsRow = { task_assigned: true, due_reminders: false, weekly_digest: true, timezone: "Europe/Berlin" };
const prefsBody = { email: { taskAssigned: true, dueReminders: false, weeklyDigest: true }, timezone: "Europe/Berlin" };

const ALL: Request[] = [
  { method: "GET", url: base },
  { method: "GET", url: `${base}/unread-count` },
  { method: "PATCH", url: `${base}/${noteId}`, payload: { read: true } },
  { method: "PATCH", url: base, payload: { read: true, before: "2026-10-31T08:15:30.123456+00:00" } },
  { method: "GET", url: prefsUrl },
  { method: "PUT", url: prefsUrl, payload: prefsBody },
];
const WRITES = ALL.filter((r) => r.method !== "GET");

describe("notification routes", () => {
  it.each(ALL)("$method $url answers 401 without a session", async (request) => {
    const { response, calls } = await call(request, [], false);
    expect(response.statusCode).toBe(401);
    expect(called(calls, "spark.ws_")).toBe(false);
  });

  it.each(WRITES)("$method $url refuses a cross-origin request", async (request) => {
    const { response, calls } = await call({ ...request, headers: { origin: "https://evil.example" } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "origin_not_allowed" });
    expect(called(calls, "spark.ws_")).toBe(false);
  });

  describe("list", () => {
    it("maps the item shape with workspace and link, and defaults", async () => {
      const { response, calls } = await call({ method: "GET", url: base }, [listHandler([row()])]);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.json()).toEqual({
        items: [{
          id: noteId,
          kind: "event_invited",
          title: "Sprint review",
          body: "Tomorrow",
          resourceType: "calendar_event",
          resourceId: "9d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6",
          link: "/w/northstar/schedule?week=2026-11-02",
          workspace: { id: tenantId, slug: "northstar", name: "Northstar" },
          createdAt: "2026-10-31T08:15:30.123456+00:00",
          readAt: null,
        }],
        nextCursor: null,
      });
      expect(find(calls, "spark.ws_list_notifications")?.params).toEqual([false, null, null, 26]);
    });

    it("passes unread, limit and keeps a null link and read time", async () => {
      const { response, calls } = await call({ method: "GET", url: `${base}?unread=true&limit=5` }, [
        listHandler([row({ link: null, body: null, read_at: new Date("2026-10-31T09:00:00Z") })]),
      ]);
      expect(find(calls, "spark.ws_list_notifications")?.params).toEqual([true, null, null, 6]);
      expect(response.json().items[0]).toMatchObject({ link: null, body: null, readAt: "2026-10-31T09:00:00.000Z" });
    });

    it("issues a full-precision cursor and sends it back verbatim", async () => {
      const rows = [row(), row({ id: noteId2, created_at_iso: "2026-10-31T08:15:30.123455+00:00", cursor_ts: "2026-10-31 08:15:30.123455+00" })];
      const first = await call({ method: "GET", url: `${base}?limit=1` }, [listHandler(rows)]);
      const { items, nextCursor } = first.response.json();
      expect(items).toHaveLength(1);
      expect(find(first.calls, "spark.ws_list_notifications")?.params[3]).toBe(2);
      expect(decodeCursor(nextCursor)).toEqual({ createdAt: "2026-10-31 08:15:30.123456+00", id: noteId });

      const second = await call({ method: "GET", url: `${base}?limit=1&cursor=${nextCursor}` }, [listHandler([rows[1]])]);
      expect(find(second.calls, "spark.ws_list_notifications")?.params).toEqual([false, "2026-10-31 08:15:30.123456+00", noteId, 2]);
    });

    it("peeks for a next page when the limit is 100", async () => {
      const full = Array.from({ length: 100 }, () => row());
      let n = 0;
      const { response, calls } = await call({ method: "GET", url: `${base}?limit=100` }, [["spark.ws_list_notifications", () => (n++ === 0 ? full : [row({ id: noteId2 })])]]);
      expect(response.json().items).toHaveLength(100);
      expect(response.json().nextCursor).not.toBeNull();
      expect(calls.filter((c) => c.sql.includes("spark.ws_list_notifications")).map((c) => c.params[3])).toEqual([100, 1]);
    });

    it("rejects a malformed cursor, bad limit and unknown query keys", async () => {
      expect((await call({ method: "GET", url: `${base}?cursor=!!!` })).response.json()).toMatchObject({ code: "invalid_cursor" });
      expect((await call({ method: "GET", url: `${base}?limit=0` })).response.statusCode).toBe(400);
      expect((await call({ method: "GET", url: `${base}?limit=101` })).response.statusCode).toBe(400);
      expect((await call({ method: "GET", url: `${base}?unread=maybe` })).response.statusCode).toBe(400);
      const extra = await call({ method: "GET", url: `${base}?foo=1` });
      expect(extra.response.statusCode).toBe(400);
      expect(called(extra.calls, "spark.ws_")).toBe(false);
    });

    it("accepts a cursor made by encodeCursor", async () => {
      const cursor = encodeCursor({ createdAt: "2026-10-31 08:15:30.5+00", id: noteId });
      const { response } = await call({ method: "GET", url: `${base}?cursor=${cursor}` }, [listHandler([])]);
      expect(response.statusCode).toBe(200);
    });
  });

  describe("unread count", () => {
    it("returns the count", async () => {
      const { response, calls } = await call({ method: "GET", url: `${base}/unread-count` }, [["spark.ws_unread_notification_count", () => [{ count: 7 }]]]);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.json()).toEqual({ count: 7 });
      expect(called(calls, "spark.ws_unread_notification_count")).toBe(true);
    });
  });

  describe("mark one", () => {
    it("answers 204 with an empty body and no-store", async () => {
      const { response, calls } = await call({ method: "PATCH", url: `${base}/${noteId}`, payload: { read: true } }, [["spark.ws_mark_notification_read", () => [{ outcome: "ok" }]]]);
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(find(calls, "spark.ws_mark_notification_read")?.params).toEqual([noteId]);
    });

    it("answers identical 404 bodies for unknown and foreign ids", async () => {
      const handlers: Array<[string, QueryHandler]> = [["spark.ws_mark_notification_read", () => [{ outcome: "not_found" }]]];
      const a = await call({ method: "PATCH", url: `${base}/${noteId}`, payload: { read: true } }, handlers);
      const b = await call({ method: "PATCH", url: `${base}/${noteId2}`, payload: { read: true } }, handlers);
      expect(a.response.statusCode).toBe(404);
      expect(a.response.headers["content-type"]).toContain("application/problem+json");
      expect(a.response.json()).toMatchObject({ code: "notification_not_found" });
      const strip = (r: { json: () => Record<string, unknown> }) => ({ ...r.json(), instance: undefined, requestId: undefined });
      expect(strip(a.response)).toEqual(strip(b.response));
    });

    it("rejects read:false, a missing body, unknown keys and a bad id", async () => {
      for (const payload of [{ read: false }, {}, { read: true, extra: 1 }]) {
        const { response, calls } = await call({ method: "PATCH", url: `${base}/${noteId}`, payload });
        expect(response.statusCode).toBe(400);
        expect(called(calls, "spark.ws_")).toBe(false);
      }
      expect((await call({ method: "PATCH", url: `${base}/not-a-uuid`, payload: { read: true } })).response.statusCode).toBe(400);
    });
  });

  describe("mark all", () => {
    const before = "2026-10-31T08:15:30.123456+00:00";

    it("passes before verbatim with microseconds and returns the count", async () => {
      const { response, calls } = await call({ method: "PATCH", url: base, payload: { read: true, before } }, [["spark.ws_mark_notifications_read", () => [{ updated: 3 }]]]);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.json()).toEqual({ updated: 3 });
      expect(find(calls, "spark.ws_mark_notifications_read")?.params).toEqual([before]);
    });

    it("requires before and read:true, rejects bad instants and unknown keys", async () => {
      for (const payload of [{ read: true }, { before }, { read: false, before }, { read: true, before: "yesterday" }, { read: true, before, extra: 1 },
        { read: true, before: "2026-10-31T23:59:60Z" }, { read: true, before: "0000-01-01T00:00:00Z" }]) {
        const { response, calls } = await call({ method: "PATCH", url: base, payload });
        expect(response.statusCode, JSON.stringify(payload)).toBe(400);
        expect(called(calls, "spark.ws_")).toBe(false);
      }
    });
  });

  describe("preferences", () => {
    it("reads the document", async () => {
      const { response } = await call({ method: "GET", url: prefsUrl }, [["spark.ws_get_notification_preferences", () => [prefsRow]]]);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.json()).toEqual(prefsBody);
    });

    it("writes then returns the stored document", async () => {
      const { response, calls } = await call({ method: "PUT", url: prefsUrl, payload: prefsBody }, [
        ["spark.ws_set_notification_preferences", () => [{ outcome: "ok" }]],
        ["spark.ws_get_notification_preferences", () => [prefsRow]],
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(prefsBody);
      expect(find(calls, "spark.ws_set_notification_preferences")?.params).toEqual([true, false, true, "Europe/Berlin"]);
    });

    it("requires every key and rejects unknown ones", async () => {
      const bad = [
        { email: { taskAssigned: true, dueReminders: false }, timezone: "UTC" },
        { email: prefsBody.email },
        { timezone: "UTC" },
        { email: { ...prefsBody.email, extra: true }, timezone: "UTC" },
        { ...prefsBody, extra: 1 },
        { email: { taskAssigned: "yes", dueReminders: false, weeklyDigest: true }, timezone: "UTC" },
      ];
      for (const payload of bad) {
        const { response, calls } = await call({ method: "PUT", url: prefsUrl, payload });
        expect(response.statusCode, JSON.stringify(payload)).toBe(400);
        expect(called(calls, "spark.ws_")).toBe(false);
      }
    });

    it("answers 400 invalid_input with the whitelisted detail for a bad zone", async () => {
      const { response } = await call({ method: "PUT", url: prefsUrl, payload: { ...prefsBody, timezone: "Mars/Base" } }, [
        ["spark.ws_set_notification_preferences", () => Object.assign(new Error("Invalid timezone"), { code: "22023" })],
      ]);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_input", detail: "Invalid timezone." });
    });

    it("does not leak unknown database messages", async () => {
      const { response } = await call({ method: "PUT", url: prefsUrl, payload: prefsBody }, [
        ["spark.ws_set_notification_preferences", () => Object.assign(dbError("22023"), { message: "secret detail" })],
      ]);
      expect(response.json().detail).not.toContain("secret");
    });
  });
});
