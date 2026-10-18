import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, SESSION_EXPIRED_EVENT } from "../src/app/_lib/http";
import { workspaceApi } from "../src/app/w/_lib/api";

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];

function stubFetch(response: () => Response) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response();
  }));
}

const headersOf = (call: Call) => new Headers(call.init.headers);

afterEach(() => vi.unstubAllGlobals());

describe("workspaceApi", () => {
  it("returns the body and the ETag, with credentials included", async () => {
    stubFetch(() => new Response(JSON.stringify({ id: "w1", slug: "northstar" }), { status: 200, headers: { "content-type": "application/json", ETag: "\"v3\"" } }));
    const result = await workspaceApi<{ id: string }>("/workspaces/by-slug/northstar");
    expect(result).toEqual({ data: { id: "w1", slug: "northstar" }, etag: "\"v3\"" });
    expect(calls[0].url).toBe("/api/v1/workspaces/by-slug/northstar");
    expect(calls[0].init.credentials).toBe("include");
    expect(calls[0].init.method).toBe("GET");
  });

  it("sends JSON bodies with If-Match and Idempotency-Key headers", async () => {
    stubFetch(() => new Response(JSON.stringify({ id: "w1" }), { status: 200, headers: { "content-type": "application/json" } }));
    await workspaceApi("/workspaces/w1", { method: "PATCH", body: { name: "Renamed" }, ifMatch: "\"v3\"", idempotencyKey: "key-1" });
    const headers = headersOf(calls[0]);
    expect(calls[0].init.method).toBe("PATCH");
    expect(calls[0].init.body).toBe(JSON.stringify({ name: "Renamed" }));
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("If-Match")).toBe("\"v3\"");
    expect(headers.get("Idempotency-Key")).toBe("key-1");
  });

  it("returns undefined data for 204", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    await expect(workspaceApi("/workspaces/w1/members/me", { method: "DELETE" })).resolves.toEqual({ data: undefined, etag: null });
  });

  it("announces an expired session on 401", async () => {
    stubFetch(() => new Response(JSON.stringify({ code: "unauthenticated" }), { status: 401 }));
    const listener = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, listener);
    await expect(workspaceApi("/workspaces")).rejects.toMatchObject({ status: 401 });
    window.removeEventListener(SESSION_EXPIRED_EVENT, listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("turns 412 into an ApiError carrying the status and code", async () => {
    stubFetch(() => new Response(JSON.stringify({ code: "version_mismatch", detail: "Workspace was changed by someone else." }), { status: 412 }));
    const error = await workspaceApi("/workspaces/w1", { method: "PATCH", body: {}, ifMatch: "\"v1\"" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 412, code: "version_mismatch", message: "Workspace was changed by someone else." });
  });

  it("uses workspace-specific fallback copy for 403 and 409", async () => {
    stubFetch(() => new Response("{}", { status: 403 }));
    await expect(workspaceApi("/workspaces/w1/invitations")).rejects.toMatchObject({ message: "Your workspace role does not allow this action." });
    stubFetch(() => new Response("{}", { status: 409 }));
    await expect(workspaceApi("/workspaces", { method: "POST", body: {} })).rejects.toMatchObject({ message: "This changed since you loaded it. Refresh and try again." });
  });

  it("reports network failures as status 0", async () => {
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(workspaceApi("/workspaces")).rejects.toMatchObject({ status: 0, code: "network_error" });
  });
});
