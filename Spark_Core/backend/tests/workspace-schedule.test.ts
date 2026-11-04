import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { fakePool, principalRow, type QueryHandler } from "./fake-pool.js";

const config = loadConfig({ NODE_ENV: "test" });
const cookie = `spark_session=${"b".repeat(64)}`;
const actorId = principalRow.user_id;
const tenantId = "1d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const eventId = "9d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const projectId = "3d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const issueId = "4d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const userA = "aa4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const userGone = "ac4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
const organizerId = "ab4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";

const eventUrl = `/api/v1/calendar-events/${eventId}`;
const cancelUrl = `${eventUrl}/cancel`;
const respondUrl = `${eventUrl}/attendees/me`;
const eventsUrl = `/api/v1/workspaces/${tenantId}/calendar-events`;
const calendarUrl = (query = "from=2026-11-02T00:00:00.000Z&to=2026-11-09T00:00:00.000Z") => `/api/v1/workspaces/${tenantId}/calendar?${query}`;

type Request = { method: "GET" | "POST" | "PATCH" | "PUT"; url: string; payload?: unknown; headers?: Record<string, string> };
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
const ifMatch = (version = 3) => ({ "if-match": `"v${version}"` });

const eventRow = (over: object = {}) => ({
  id: eventId,
  tenant_id: tenantId,
  title: "Sprint review",
  description: "Demo the sprint",
  location: null,
  starts_at: new Date("2026-11-03T09:00:00Z"),
  ends_at: new Date("2026-11-03T10:00:00Z"),
  timezone: "Europe/Berlin",
  status: "scheduled",
  version: 3,
  organizer_user_id: organizerId,
  organizer_name: "Olga",
  project_id: projectId,
  project_key: "WEB",
  project_name: "Website",
  issue_id: issueId,
  issue_number: "7",
  issue_title: "Landing page",
  ...over,
});
const attendeeRows = [
  { event_id: eventId, user_id: organizerId, display_name: "Olga", response: "accepted" },
  { event_id: eventId, user_id: actorId, display_name: "Admin", response: "pending" },
  { event_id: eventId, user_id: userGone, display_name: null, response: "declined" },
];
const eventHandler = (over: object = {}): [string, QueryHandler] => ["FROM spark.calendar_events e", () => [eventRow(over)]];
const attendeesHandler = (rows: object[] = attendeeRows): [string, QueryHandler] => ["FROM spark.event_attendees a", () => rows];
const roleHandler = (role: string | null = "member"): [string, QueryHandler] => ["FROM spark.workspace_memberships m", () => (role ? [{ role }] : [])];
const readHandlers = (role: string | null = "member", over: object = {}): Array<[string, QueryHandler]> => [eventHandler(over), attendeesHandler(), roleHandler(role)];
const workspaceHandler: [string, QueryHandler] = ["FROM spark.workspaces w", () => [{ id: tenantId }]];
const zoneHandler: [string, QueryHandler] = ["pg_timezone_names", () => [{ name: "UTC" }]];

const expectedEvent = (over: object = {}) => ({
  id: eventId,
  title: "Sprint review",
  description: "Demo the sprint",
  location: null,
  startsAt: "2026-11-03T09:00:00.000Z",
  endsAt: "2026-11-03T10:00:00.000Z",
  timezone: "Europe/Berlin",
  status: "scheduled",
  organizer: { id: organizerId, displayName: "Olga" },
  project: { id: projectId, key: "WEB", name: "Website" },
  issue: { id: issueId, key: "WEB-7", title: "Landing page" },
  attendees: [
    { user: { id: organizerId, displayName: "Olga" }, response: "accepted" },
    { user: { id: actorId, displayName: "Admin" }, response: "pending" },
    { user: { id: userGone, displayName: "Former member" }, response: "declined" },
  ],
  myResponse: "pending",
  canEdit: false,
  version: 3,
  ...over,
});

const createBody = { title: "Sprint review", startsAt: "2026-11-03T10:00:00+01:00", endsAt: "2026-11-03T11:00:00+01:00", timezone: "Europe/Berlin" };
const manyIds = (count: number) => Array.from({ length: count }, (_, i) => `aa4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e${String(i).padStart(3, "0")}`);

const WRITES: Array<{ route: Request; fn: string; empty: object; versioned: boolean }> = [
  { route: { method: "POST", url: eventsUrl, payload: createBody }, fn: "spark.ws_create_event", empty: { outcome: "not_found", event_id: null, event_version: null }, versioned: false },
  { route: { method: "PATCH", url: eventUrl, payload: { title: "X" }, headers: ifMatch() }, fn: "spark.ws_update_event", empty: { outcome: "forbidden", event_version: null }, versioned: true },
  { route: { method: "POST", url: cancelUrl, headers: ifMatch() }, fn: "spark.ws_cancel_event", empty: { outcome: "forbidden", event_version: null }, versioned: true },
  { route: { method: "PUT", url: respondUrl, payload: { response: "accepted" } }, fn: "spark.ws_respond_event", empty: { outcome: "not_invited" }, versioned: false },
];
const EVENT_WRITES = WRITES.filter((w) => w.route.url.startsWith("/api/v1/calendar-events"));
const READS: Request[] = [{ method: "GET", url: calendarUrl() }, { method: "GET", url: eventUrl }];

describe("schedule routes", () => {
  it.each([...READS, ...WRITES.map((w) => w.route)])("$method $url requires a session", async (route) => {
    const { response } = await call(route, [], false);
    expect(response.statusCode).toBe(401);
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it.each(EVENT_WRITES)("$route.method $route.url answers an unknown, foreign or non-member event with one uniform 404", async ({ route, fn }) => {
    const notFound: [string, QueryHandler] = [fn, () => [{ outcome: "not_found", event_version: null }]];
    const unknown = await call(route, [notFound]);
    const foreign = await call(route, [notFound, ...readHandlers()]);
    expect(unknown.response.statusCode).toBe(404);
    expect(unknown.response.headers["cache-control"]).toBe("private, no-store");
    expect(unknown.response.headers["content-type"]).toContain("application/problem+json");
    expect(unknown.response.json()).toMatchObject({ code: "event_not_found", status: 404 });
    const strip = (body: string) => body.replace(/"requestId":"[^"]*"/u, "");
    expect(strip(foreign.response.body)).toBe(strip(unknown.response.body));
    // A non-member never reaches the event read.
    expect(called(unknown.calls, "FROM spark.calendar_events e")).toBe(false);
    expect(called(foreign.calls, "FROM spark.calendar_events e")).toBe(false);
  });

  it("answers GET of an unknown or foreign event with the same 404 as the writes", async () => {
    const get = await call({ method: "GET", url: eventUrl });
    const write = await call({ method: "POST", url: cancelUrl, headers: ifMatch() }, [["spark.ws_cancel_event", () => [{ outcome: "not_found" }]]]);
    expect(get.response.statusCode).toBe(404);
    expect(get.response.headers["cache-control"]).toBe("private, no-store");
    const strip = (body: string) => body.replace(/"requestId":"[^"]*"/u, "").replace(/"instance":"[^"]*"/u, "");
    expect(strip(get.response.body)).toBe(strip(write.response.body));
  });

  it("answers create in a foreign workspace with 404 workspace_not_found", async () => {
    const { response } = await call({ method: "POST", url: eventsUrl, payload: createBody }, [["spark.ws_create_event", () => [{ outcome: "not_found", event_id: null, event_version: null }]]]);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "workspace_not_found" });
  });

  it.each(WRITES)("$route.method $route.url fails closed on an unknown outcome", async ({ route, fn, empty }) => {
    const { response } = await call(route, [[fn, () => [{ ...empty, outcome: "weird" }]]]);
    expect(response.statusCode).toBe(500);
  });

  it.each(WRITES)("$route.method $route.url refuses a cross-origin request", async ({ route, fn }) => {
    const { response, calls } = await call({ ...route, headers: { ...route.headers, origin: "https://evil.example" } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "origin_not_allowed" });
    expect(called(calls, fn)).toBe(false);
  });

  it.each(WRITES.filter((w) => w.versioned))("$route.method $route.url requires If-Match", async ({ route, fn }) => {
    const { response, calls } = await call({ ...route, headers: {} });
    expect(response.statusCode).toBe(428);
    expect(response.json()).toMatchObject({ code: "precondition_required" });
    expect(called(calls, fn)).toBe(false);
  });

  it.each(WRITES.filter((w) => w.versioned))("$route.method $route.url rejects a malformed If-Match", async ({ route, fn }) => {
    const { response, calls } = await call({ ...route, headers: { "if-match": 'W/"v3"' } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_if_match" });
    expect(called(calls, fn)).toBe(false);
  });

  it.each(WRITES.filter((w) => w.route.payload !== undefined))("$route.method $route.url rejects an unknown body key", async ({ route, fn }) => {
    const { response, calls } = await call({ ...route, payload: { ...(route.payload as object), color: "red" } });
    expect(response.statusCode).toBe(400);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(called(calls, fn)).toBe(false);
  });

  it("rejects a malformed event id", async () => {
    expect((await call({ method: "GET", url: "/api/v1/calendar-events/not-a-uuid" })).response.statusCode).toBe(400);
  });

  describe("GET /calendar-events/{id}", () => {
    it("returns the event with its ETag, names, attendees and Former member fallback", async () => {
      const { response, calls } = await call({ method: "GET", url: eventUrl }, readHandlers("member"));
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers.etag).toBe('"v3"');
      expect(response.json()).toEqual(expectedEvent());
      const read = find(calls, "FROM spark.calendar_events e");
      expect(read?.sql).toContain("session_workspace_ids");
      expect(read?.sql).not.toMatch(/SELECT \*|e\.\*/u);
      expect(read?.params).toEqual([eventId]);
      expect(find(calls, "FROM spark.event_attendees a")?.sql).toMatch(/a\.tenant_id/u);
      expect(find(calls, "FROM spark.workspace_memberships m")?.params).toEqual([tenantId, actorId]);
    });

    it("reports a missing organizer name, project and issue", async () => {
      const { response } = await call({ method: "GET", url: eventUrl }, [
        eventHandler({ organizer_name: null, project_id: null, project_key: null, project_name: null, issue_id: null, issue_number: null, issue_title: null }),
        attendeesHandler([]),
        roleHandler(),
      ]);
      expect(response.json()).toMatchObject({ organizer: { id: organizerId, displayName: "Former member" }, project: null, issue: null, attendees: [], myResponse: null });
    });

    it("sorts the organizer first, then by name", async () => {
      const { response } = await call({ method: "GET", url: eventUrl }, [
        eventHandler(),
        attendeesHandler([
          { event_id: eventId, user_id: actorId, display_name: "Admin", response: "pending" },
          { event_id: eventId, user_id: organizerId, display_name: "Zed", response: "accepted" },
        ]),
        roleHandler(),
      ]);
      expect(response.json().attendees.map((a: { user: { id: string } }) => a.user.id)).toEqual([organizerId, actorId]);
    });
  });

  describe("canEdit", () => {
    it.each([
      ["a plain member", "member", organizerId, "scheduled", false],
      ["the organizer", "member", actorId, "scheduled", true],
      ["an admin", "admin", organizerId, "scheduled", true],
      ["an owner", "owner", organizerId, "scheduled", true],
      ["the organizer of a cancelled event", "member", actorId, "cancelled", false],
      ["an admin on a cancelled event", "admin", organizerId, "cancelled", false],
    ])("is computed for %s", async (_name, role, organizer, status, expected) => {
      const { response } = await call({ method: "GET", url: eventUrl }, readHandlers(role, { organizer_user_id: organizer, status }));
      expect(response.json().canEdit).toBe(expected);
    });
  });

  describe("POST /workspaces/{id}/calendar-events", () => {
    it("creates an event with normalized instants and answers 201 with Location and ETag", async () => {
      const { response, calls } = await call(
        { method: "POST", url: eventsUrl, payload: { ...createBody, description: "Demo", location: "Room 2", projectId, issueId, attendeeUserIds: [userA] } },
        [["spark.ws_create_event", () => [{ outcome: "ok", event_id: eventId, event_version: 1 }]], ...readHandlers("member", { organizer_user_id: actorId, version: 1 })],
      );
      expect(response.statusCode).toBe(201);
      expect(response.headers.location).toBe(`/api/v1/calendar-events/${eventId}`);
      expect(response.headers.etag).toBe('"v1"');
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.json()).toMatchObject({ id: eventId, canEdit: true, version: 1 });
      expect(find(calls, "spark.ws_create_event")?.params).toEqual([
        tenantId, "Sprint review", "Demo", "Room 2", "2026-11-03T09:00:00.000Z", "2026-11-03T10:00:00.000Z", "Europe/Berlin", projectId, issueId, [userA],
      ]);
    });

    it("sends nulls for omitted optional fields", async () => {
      const { calls } = await call({ method: "POST", url: eventsUrl, payload: createBody }, [["spark.ws_create_event", () => [{ outcome: "not_found" }]]]);
      expect(find(calls, "spark.ws_create_event")?.params).toEqual([
        tenantId, "Sprint review", null, null, "2026-11-03T09:00:00.000Z", "2026-11-03T10:00:00.000Z", "Europe/Berlin", null, null, [],
      ]);
    });

    it.each([
      ["missing title", { ...createBody, title: undefined }],
      ["empty title", { ...createBody, title: "" }],
      ["missing startsAt", { ...createBody, startsAt: undefined }],
      ["missing timezone", { ...createBody, timezone: undefined }],
      ["a date-only start", { ...createBody, startsAt: "2026-11-03" }],
      ["a start without an offset", { ...createBody, startsAt: "2026-11-03T10:00:00" }],
      ["a non-uuid project", { ...createBody, projectId: "nope" }],
      ["51 attendees", { ...createBody, attendeeUserIds: manyIds(51) }],
      ["a non-uuid attendee", { ...createBody, attendeeUserIds: ["x"] }],
      ["an overlong title", { ...createBody, title: "x".repeat(201) }],
    ])("rejects %s with 400 before any database write", async (_name, payload) => {
      const { response, calls } = await call({ method: "POST", url: eventsUrl, payload });
      expect(response.statusCode).toBe(400);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(called(calls, "spark.ws_create_event")).toBe(false);
    });

    it("accepts 50 attendees", async () => {
      const { calls } = await call({ method: "POST", url: eventsUrl, payload: { ...createBody, attendeeUserIds: manyIds(50) } }, [["spark.ws_create_event", () => [{ outcome: "not_found" }]]]);
      expect(called(calls, "spark.ws_create_event")).toBe(true);
    });

    it("rejects an impossible calendar instant such as a leap second", async () => {
      const { response, calls } = await call({ method: "POST", url: eventsUrl, payload: { ...createBody, startsAt: "2026-06-30T23:59:60Z" } });
      expect(response.statusCode).toBe(400);
      expect(called(calls, "spark.ws_create_event")).toBe(false);
    });

    it("maps a 22023 validation message to 400 problem+json", async () => {
      const error = Object.assign(new Error("Invalid event attendees"), { code: "22023" });
      const { response } = await call({ method: "POST", url: eventsUrl, payload: createBody }, [["spark.ws_create_event", () => error]]);
      expect(response.statusCode).toBe(400);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.json()).toMatchObject({ code: "invalid_input", detail: "Invalid event attendees." });
    });
  });

  describe("PATCH /calendar-events/{id}", () => {
    const ok = (version = 4): [string, QueryHandler] => ["spark.ws_update_event", () => [{ outcome: "ok", event_version: version }]];

    it("passes the patch with normalized instants, null clearing and attendees, and returns the event", async () => {
      const patch = { title: "Review", description: null, startsAt: "2026-11-03T10:00:00+01:00", endsAt: "2026-11-03T11:00:00.000Z", projectId: null, issueId: null, attendeeUserIds: [userA] };
      const { response, calls } = await call({ method: "PATCH", url: eventUrl, payload: patch, headers: ifMatch(3) }, [ok(), ...readHandlers("admin", { version: 4 })]);
      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"v4"');
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.json()).toMatchObject({ version: 4, canEdit: true });
      const params = find(calls, "spark.ws_update_event")?.params ?? [];
      expect(params.slice(0, 2)).toEqual([eventId, 3]);
      expect(JSON.parse(params[2] as string)).toEqual({
        title: "Review", description: null, startsAt: "2026-11-03T09:00:00.000Z", endsAt: "2026-11-03T11:00:00.000Z", projectId: null, issueId: null, attendeeUserIds: [userA],
      });
    });

    it("rejects an empty patch with 400", async () => {
      const { response, calls } = await call({ method: "PATCH", url: eventUrl, payload: {}, headers: ifMatch() });
      expect(response.statusCode).toBe(400);
      expect(called(calls, "spark.ws_update_event")).toBe(false);
    });

    it("rejects more than 50 attendees", async () => {
      const { response } = await call({ method: "PATCH", url: eventUrl, payload: { attendeeUserIds: manyIds(51) }, headers: ifMatch() });
      expect(response.statusCode).toBe(400);
    });

    it("answers a member who is not the organizer with 403 insufficient_role", async () => {
      const { response } = await call({ method: "PATCH", url: eventUrl, payload: { title: "X" }, headers: ifMatch() }, [["spark.ws_update_event", () => [{ outcome: "forbidden", event_version: null }]]]);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "insufficient_role" });
    });

    it("answers a cancelled event with 409 event_cancelled", async () => {
      const { response } = await call({ method: "PATCH", url: eventUrl, payload: { title: "X" }, headers: ifMatch() }, [["spark.ws_update_event", () => [{ outcome: "cancelled", event_version: null }]]]);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "event_cancelled" });
    });

    it("answers a stale version with 412 and the current event", async () => {
      const { response } = await call({ method: "PATCH", url: eventUrl, payload: { title: "X" }, headers: ifMatch(2) }, [
        ["spark.ws_update_event", () => [{ outcome: "version_mismatch", event_version: 3 }]],
        ...readHandlers("admin"),
      ]);
      expect(response.statusCode).toBe(412);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.json()).toMatchObject({ code: "version_mismatch", current: { id: eventId, version: 3 } });
    });

    it("maps 'Invalid event issue' (clearing the project while the issue stays) to 400", async () => {
      const error = Object.assign(new Error("Invalid event issue"), { code: "22023" });
      const { response } = await call({ method: "PATCH", url: eventUrl, payload: { projectId: null }, headers: ifMatch() }, [["spark.ws_update_event", () => error]]);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_input", detail: "Invalid event issue." });
    });

    it.each([
      "Invalid event title", "Invalid event description", "Invalid event location", "Invalid event time", "Invalid event timezone",
      "Invalid event project", "Invalid event issue", "Invalid event attendees", "Invalid event patch", "Invalid event response",
    ])("whitelists %s", async (message) => {
      const error = Object.assign(new Error(message), { code: "22023" });
      const { response } = await call({ method: "PATCH", url: eventUrl, payload: { title: "X" }, headers: ifMatch() }, [["spark.ws_update_event", () => error]]);
      expect(response.json().detail).toBe(`${message}.`);
    });
  });

  describe("POST /calendar-events/{id}/cancel", () => {
    it("cancels with If-Match and returns the event", async () => {
      const { response, calls } = await call({ method: "POST", url: cancelUrl, headers: ifMatch(3) }, [
        ["spark.ws_cancel_event", () => [{ outcome: "ok", event_version: 4 }]],
        ...readHandlers("admin", { status: "cancelled", version: 4 }),
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"v4"');
      expect(response.json()).toMatchObject({ status: "cancelled", canEdit: false, version: 4 });
      expect(find(calls, "spark.ws_cancel_event")?.params).toEqual([eventId, 3]);
    });

    it("accepts an empty JSON object body but no keys", async () => {
      const ok = await call({ method: "POST", url: cancelUrl, payload: {}, headers: ifMatch() }, [["spark.ws_cancel_event", () => [{ outcome: "forbidden" }]]]);
      expect(ok.response.statusCode).toBe(403);
      const keyed = await call({ method: "POST", url: cancelUrl, payload: { reason: "x" }, headers: ifMatch() });
      expect(keyed.response.statusCode).toBe(400);
      expect(called(keyed.calls, "spark.ws_cancel_event")).toBe(false);
    });

    it("answers a plain member with 403 insufficient_role", async () => {
      const { response } = await call({ method: "POST", url: cancelUrl, headers: ifMatch() }, [["spark.ws_cancel_event", () => [{ outcome: "forbidden" }]]]);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "insufficient_role" });
    });

    it("answers an already cancelled event with 409 event_already_cancelled", async () => {
      const { response } = await call({ method: "POST", url: cancelUrl, headers: ifMatch() }, [["spark.ws_cancel_event", () => [{ outcome: "already_cancelled" }]]]);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "event_already_cancelled" });
    });

    it("answers a stale cancel with 412 and the current event", async () => {
      const { response } = await call({ method: "POST", url: cancelUrl, headers: ifMatch(1) }, [
        ["spark.ws_cancel_event", () => [{ outcome: "version_mismatch", event_version: 3 }]],
        ...readHandlers("admin"),
      ]);
      expect(response.statusCode).toBe(412);
      expect(response.json()).toMatchObject({ code: "version_mismatch", current: { id: eventId, version: 3 } });
    });
  });

  describe("PUT /calendar-events/{id}/attendees/me", () => {
    it.each(["accepted", "declined", "tentative"])("records %s and returns the event", async (answer) => {
      const { response, calls } = await call({ method: "PUT", url: respondUrl, payload: { response: answer } }, [
        ["spark.ws_respond_event", () => [{ outcome: "ok" }]],
        ...readHandlers(),
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"v3"');
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.json()).toMatchObject({ id: eventId, myResponse: "pending" });
      expect(find(calls, "spark.ws_respond_event")?.params).toEqual([eventId, answer]);
    });

    it.each(["pending", "maybe", "", 3])("rejects the answer %j", async (answer) => {
      const { response, calls } = await call({ method: "PUT", url: respondUrl, payload: { response: answer } });
      expect(response.statusCode).toBe(400);
      expect(called(calls, "spark.ws_respond_event")).toBe(false);
    });

    it("requires the response key", async () => {
      expect((await call({ method: "PUT", url: respondUrl, payload: {} })).response.statusCode).toBe(400);
    });

    it("answers a user who is not invited with 403 not_invited", async () => {
      const { response } = await call({ method: "PUT", url: respondUrl, payload: { response: "accepted" } }, [["spark.ws_respond_event", () => [{ outcome: "not_invited" }]]]);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "not_invited" });
    });

    it("answers a cancelled event with 409 event_cancelled", async () => {
      const { response } = await call({ method: "PUT", url: respondUrl, payload: { response: "accepted" } }, [["spark.ws_respond_event", () => [{ outcome: "cancelled" }]]]);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "event_cancelled" });
    });
  });

  describe("GET /workspaces/{id}/calendar", () => {
    const deadline = (over: object = {}) => ({
      deadline_kind: "task_due", due: "2026-11-05", title: "Fix login", project_id: projectId, project_key: "WEB", project_name: "Website", methodology: "scrum",
      issue_id: issueId, assignee_user_id: userGone, assignee_name: null, sprint_id: null, milestone_id: null, ...over,
    });
    const handlers = (events: object[] = [eventRow()], deadlines: object[] = [deadline()]): Array<[string, QueryHandler]> => [
      workspaceHandler, zoneHandler,
      ["FROM spark.calendar_events e", () => events], attendeesHandler(), roleHandler("admin"),
      ["AS deadline_kind", () => deadlines],
    ];

    it("returns the range, events with attendees, deadlines and truncation flags", async () => {
      const { response, calls } = await call({ method: "GET", url: calendarUrl("from=2026-11-02T00:00:00.000Z&to=2026-11-09T00:00:00.000Z&tz=Asia/Ho_Chi_Minh") }, [
        workspaceHandler,
        ["pg_timezone_names", () => [{ name: "Asia/Ho_Chi_Minh" }]],
        ...handlers().slice(2),
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.json()).toEqual({
        range: { from: "2026-11-02T00:00:00.000Z", to: "2026-11-09T00:00:00.000Z", tz: "Asia/Ho_Chi_Minh" },
        events: [expectedEvent({ canEdit: true })],
        deadlines: [{
          kind: "task_due", date: "2026-11-05", title: "Fix login", project: { id: projectId, key: "WEB", name: "Website", methodology: "scrum" },
          issueId, assignee: { id: userGone, displayName: "Former member" },
        }],
        truncated: { events: false, deadlines: false },
      });
      const events = find(calls, "FROM spark.calendar_events e");
      expect(events?.params.slice(0, 3)).toEqual([tenantId, "2026-11-02T00:00:00.000Z", "2026-11-09T00:00:00.000Z"]);
      expect(events?.sql).toContain("e.tenant_id = $1");
      expect(events?.sql).toMatch(/e\.starts_at < \$3/u);
      expect(events?.sql).toMatch(/e\.ends_at > \$2/u);
      expect(events?.sql).toContain("LIMIT 501");
      const dl = find(calls, "AS deadline_kind");
      expect(dl?.params).toEqual([tenantId, "2026-11-02T00:00:00.000Z", "2026-11-09T00:00:00.000Z", "Asia/Ho_Chi_Minh"]);
      expect(dl?.sql).toContain("AT TIME ZONE $4");
      expect(dl?.sql).toContain("LIMIT 501");
      expect(dl?.sql).toContain("p.archived_at IS NULL");
    });

    it("uses UTC by default and emits sprint and milestone deadlines with their ids", async () => {
      const sprintId = "5d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
      const milestoneId = "8d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";
      const { response, calls } = await call({ method: "GET", url: calendarUrl() }, handlers([], [
        deadline({ deadline_kind: "milestone_due", title: "Beta", issue_id: null, assignee_user_id: null, milestone_id: milestoneId, methodology: "waterfall" }),
        deadline({ deadline_kind: "sprint_end", title: "Sprint 4", issue_id: null, assignee_user_id: null, sprint_id: sprintId }),
        deadline({ assignee_user_id: null }),
      ]));
      expect(response.json().range.tz).toBe("UTC");
      expect(find(calls, "pg_timezone_names")?.params).toEqual(["UTC"]);
      const [milestone, sprint, task] = response.json().deadlines;
      expect(milestone).toEqual({ kind: "milestone_due", date: "2026-11-05", title: "Beta", project: { id: projectId, key: "WEB", name: "Website", methodology: "waterfall" }, milestoneId });
      expect(sprint).toEqual({ kind: "sprint_end", date: "2026-11-05", title: "Sprint 4", project: { id: projectId, key: "WEB", name: "Website", methodology: "scrum" }, sprintId });
      expect(task).toMatchObject({ kind: "task_due", issueId, assignee: null });
    });

    it("selects deadlines by calendar date in the tz: last local day in, next day out", async () => {
      const { calls } = await call({ method: "GET", url: calendarUrl("from=2026-11-01T17:00:00.000Z&to=2026-11-08T17:00:00.000Z&tz=Asia/Ho_Chi_Minh") }, [
        workspaceHandler, ["pg_timezone_names", () => [{ name: "Asia/Ho_Chi_Minh" }]], ["AS deadline_kind", () => []],
      ]);
      const sql = find(calls, "AS deadline_kind")?.sql ?? "";
      // from is 2026-11-02 00:00 local and to - 1 ms is 2026-11-07 23:59:59.999 local: dates 11-02..11-07 inclusive.
      expect(sql).toMatch(/>= \(\$2::timestamptz AT TIME ZONE \$4\)::date/u);
      expect(sql).toMatch(/<= \(\(\$3::timestamptz - interval '1 millisecond'\) AT TIME ZONE \$4\)::date/u);
      // Sprint days are stored as midnight UTC (like the sprint API reads them), so they are read in UTC whatever the tz is.
      expect(sql).toContain("(s.ends_at AT TIME ZONE 'UTC')::date");
      expect(sql).not.toContain("s.ends_at AT TIME ZONE $4");
    });

    it("reports truncation when more than 500 events or deadlines match", async () => {
      const many = (row: object) => Array.from({ length: 501 }, () => ({ ...row }));
      const { response } = await call({ method: "GET", url: calendarUrl() }, handlers(many(eventRow()), many(deadline())));
      const body = response.json();
      expect(body.events).toHaveLength(500);
      expect(body.deadlines).toHaveLength(500);
      expect(body.truncated).toEqual({ events: true, deadlines: true });
    });

    it("includes an event that crosses the range start (overlap, not start-in-range)", async () => {
      const { calls } = await call({ method: "GET", url: calendarUrl() }, handlers());
      const events = find(calls, "FROM spark.calendar_events e");
      expect(events?.sql).toMatch(/e\.ends_at > \$2/u);
      expect(events?.sql).not.toMatch(/e\.starts_at >= \$2/u);
    });

    it("is 404 for an unknown or foreign workspace, uncached", async () => {
      const { response } = await call({ method: "GET", url: calendarUrl() }, [zoneHandler]);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "workspace_not_found" });
      expect(response.headers["cache-control"]).toBe("private, no-store");
    });

    const span = 62 * 24 * 60 * 60 * 1000;
    it.each([
      ["from missing", "to=2026-11-09T00:00:00.000Z"],
      ["to missing", "from=2026-11-02T00:00:00.000Z"],
      ["from unparsable", "from=yesterday&to=2026-11-09T00:00:00.000Z"],
      ["to unparsable", "from=2026-11-02T00:00:00.000Z&to=2026-13-99"],
      ["from without an offset", "from=2026-11-02T00:00:00&to=2026-11-09T00:00:00Z"],
      ["from equal to to", "from=2026-11-02T00:00:00.000Z&to=2026-11-02T00:00:00.000Z"],
      ["from after to", "from=2026-11-09T00:00:00.000Z&to=2026-11-02T00:00:00.000Z"],
      ["a span of 62 days plus 1 ms", `from=2026-11-02T00:00:00.000Z&to=${new Date(Date.parse("2026-11-02T00:00:00.000Z") + span + 1).toISOString()}`],
      ["an unknown query key", "from=2026-11-02T00:00:00.000Z&to=2026-11-09T00:00:00.000Z&bogus=1"],
    ])("rejects %s with 400, uncached", async (_name, query) => {
      const { response, calls } = await call({ method: "GET", url: calendarUrl(query) }, handlers());
      expect(response.statusCode).toBe(400);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(called(calls, "FROM spark.calendar_events e")).toBe(false);
    });

    it("accepts a span of exactly 62 days", async () => {
      const to = new Date(Date.parse("2026-11-02T00:00:00.000Z") + span).toISOString();
      const { response } = await call({ method: "GET", url: calendarUrl(`from=2026-11-02T00:00:00.000Z&to=${to}`) }, handlers([], []));
      expect(response.statusCode).toBe(200);
    });

    it("rejects an unknown time zone with 400", async () => {
      const { response, calls } = await call({ method: "GET", url: calendarUrl("from=2026-11-02T00:00:00.000Z&to=2026-11-09T00:00:00.000Z&tz=Mars/Base") }, [workspaceHandler, ["pg_timezone_names", () => []]]);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_input" });
      expect(called(calls, "FROM spark.calendar_events e")).toBe(false);
    });

    it("normalizes offsets in the echoed range", async () => {
      const { response } = await call({ method: "GET", url: calendarUrl("from=2026-11-02T00:00:00%2B07:00&to=2026-11-09T00:00:00%2B07:00") }, handlers([], []));
      expect(response.json().range).toEqual({ from: "2026-11-01T17:00:00.000Z", to: "2026-11-08T17:00:00.000Z", tz: "UTC" });
    });
  });
});
