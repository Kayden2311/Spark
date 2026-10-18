import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { fakePool } from "./fake-pool.js";

describe("GET /api/v1/methodologies", () => {
  it("is public, ordered and cacheable", async () => {
    const { pool } = fakePool([]);
    const app = await buildApp({ config: loadConfig({ NODE_ENV: "test" }), pool, rateLimit: false, logger: false });
    try {
      const response = await app.inject({ method: "GET", url: "/api/v1/methodologies" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("public, max-age=3600");
      const body = response.json<{ items: Array<{ id: string; statuses: unknown[] }> }>();
      expect(body.items.map((i) => i.id)).toEqual(["scrum", "kanban", "waterfall"]);
      expect(body.items[1]?.statuses).toHaveLength(5);
    } finally {
      await app.close();
    }
  });
});
