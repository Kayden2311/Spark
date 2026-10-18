import { describe, expect, it } from "vitest";
import { DEFAULT_FALLBACK_MESSAGES, toApiError } from "../src/app/_lib/http";

describe("toApiError", () => {
  it("uses problem detail when present", async () => {
    const error = await toApiError(new Response(JSON.stringify({ code: "slug_taken", detail: "That address is taken." }), { status: 409 }));
    expect(error.status).toBe(409);
    expect(error.code).toBe("slug_taken");
    expect(error.message).toBe("That address is taken.");
  });

  it("falls back by status for non-JSON bodies", async () => {
    const error = await toApiError(new Response("slow down", { status: 429 }));
    expect(error.message).toBe(DEFAULT_FALLBACK_MESSAGES[429]);
    expect(error.code).toBe("request_failed");
  });

  it("hides generic 5xx detail but keeps database_unavailable", async () => {
    const generic = await toApiError(new Response(JSON.stringify({ detail: "boom" }), { status: 500 }));
    expect(generic.message).not.toBe("boom");
    const database = await toApiError(new Response(JSON.stringify({ code: "database_unavailable", detail: "Database is down." }), { status: 503 }));
    expect(database.message).toBe("Database is down.");
  });

  it("accepts custom fallbacks", async () => {
    const error = await toApiError(new Response("", { status: 403 }), { 403: "Custom" });
    expect(error.message).toBe("Custom");
  });
});
