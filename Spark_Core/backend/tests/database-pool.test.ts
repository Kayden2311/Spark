import { describe, expect, it } from "vitest";

import { poolConfig } from "../src/infrastructure/database/pool.js";

describe("poolConfig", () => {
  it("pins every connection's session time zone to UTC", () => {
    expect(poolConfig({ connectionString: "postgresql://localhost/spark" })).toEqual({
      connectionString: "postgresql://localhost/spark",
      options: "-c TimeZone=UTC",
    });
  });

  it("keeps the other settings and any existing startup options", () => {
    expect(poolConfig({ max: 2, application_name: "spark-worker", options: "-c statement_timeout=0" })).toEqual({
      max: 2,
      application_name: "spark-worker",
      options: "-c TimeZone=UTC -c statement_timeout=0",
    });
  });
});
