import { afterEach, describe, expect, it, vi } from "vitest";

import { canAccess, canManageRoles, isStaff, sectionForPath, visibleSections } from "../src/app/admin/_lib/access";
import { ApiError, SESSION_EXPIRED_EVENT, adminApi, query } from "../src/app/admin/_lib/api";
import { describeAction, formatDuration, formatRelative, humanize, initials } from "../src/app/admin/_lib/format";

describe("console access", () => {
  it("shows each role only its sections", () => {
    expect(visibleSections(["content_moderator"]).map((s) => s.id)).toEqual(["overview", "reports"]);
    expect(visibleSections(["community_moderator", "campaign_moderator"]).map((s) => s.id)).toEqual(["overview", "communities", "campaigns"]);
    expect(visibleSections(["platform_admin"]).map((s) => s.id)).toEqual(["overview", "reports", "communities", "campaigns", "users", "audit"]);
    expect(visibleSections([])).toEqual([]);
  });

  it("treats only platform roles as staff and only super admins as role managers", () => {
    expect(isStaff(["member"])).toBe(false);
    expect(isStaff(["campaign_moderator"])).toBe(true);
    expect(canAccess(["content_moderator"], "users")).toBe(false);
    expect(canManageRoles(["platform_admin"])).toBe(false);
    expect(canManageRoles(["super_admin"])).toBe(true);
  });

  it("highlights the deepest matching section", () => {
    expect(sectionForPath("/admin")?.id).toBe("overview");
    expect(sectionForPath("/admin/users/123")?.id).toBe("users");
    expect(sectionForPath("/admin/audit")?.id).toBe("audit");
  });
});

describe("admin API client", () => {
  afterEach(() => vi.unstubAllGlobals());

  function respond(status: number, body?: unknown, contentType = "application/problem+json") {
    const fetchMock = vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": contentType } }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("sends JSON with the session cookie and parses the response", async () => {
    const fetchMock = respond(200, { ok: true }, "application/json");
    await expect(adminApi("/reports/1/actions", { method: "POST", body: { action: "hide", reason: "Spam" } })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/admin/reports/1/actions", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ action: "hide", reason: "Spam" }),
    }));
  });

  it("returns undefined for 204", async () => {
    respond(204);
    await expect(adminApi("/users/1/roles/content_moderator", { method: "DELETE", body: { reason: "Done" } })).resolves.toBeUndefined();
  });

  it("surfaces the server's problem detail and code", async () => {
    respond(409, { code: "invalid_transition", detail: 'The community\'s current state does not allow "feature".' });
    await expect(adminApi("/communities/1/actions", { method: "POST", body: {} })).rejects.toMatchObject({ status: 409, code: "invalid_transition", message: expect.stringContaining("does not allow") });
  });

  it("hides server internals behind a generic message for 5xx", async () => {
    respond(500, { code: "internal_error", detail: "An unexpected error occurred." });
    const error = await adminApi("/overview").catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toMatch(/on our side/);
  });

  it("announces an expired session", async () => {
    respond(401, { code: "session_expired", detail: "Session expired or invalid." });
    const listener = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, listener);
    await expect(adminApi("/overview")).rejects.toMatchObject({ status: 401 });
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(SESSION_EXPIRED_EVENT, listener);
  });

  it("reports network failures in plain language", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(adminApi("/overview")).rejects.toMatchObject({ code: "network_error", message: expect.stringMatching(/could not be reached/) });
  });

  it("builds query strings without empty values", () => {
    expect(query({ status: "open", search: "", role: undefined, limit: 25 })).toBe("?status=open&limit=25");
    expect(query({})).toBe("");
  });
});

describe("formatting", () => {
  it("names role changes and humanizes codes", () => {
    expect(describeAction({ action: "role.grant", metadata: { role: "content_moderator" } })).toBe("Granted role: Content moderator");
    expect(describeAction({ action: "community.freeze", metadata: {} })).toBe("Froze community");
    expect(humanize("spam_or_scam")).toBe("Spam or scam");
    expect(initials("Spark Admin")).toBe("SA");
  });

  it("formats durations and relative times", () => {
    expect(formatDuration(90061)).toBe("1d 1h");
    expect(formatDuration(3720)).toBe("1h 2m");
    const now = Date.parse("2026-10-17T12:00:00Z");
    expect(formatRelative("2026-10-17T11:55:00Z", now)).toBe("5 minutes ago");
    expect(formatRelative(null, now)).toBe("Never");
  });
});
