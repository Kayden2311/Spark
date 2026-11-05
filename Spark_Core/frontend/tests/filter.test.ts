import { describe, expect, it } from "vitest";
import { emptyFilters, filtersFromParams, filtersToSearch, hasActiveFilters } from "../src/app/communities/filter";

describe("community filters in the URL", () => {
  it("round-trips every filter through the query string", () => {
    const filters = { q: "pricing teardown", topic: "fintech", country: "VN", stage: "series_a" };
    const search = filtersToSearch(filters);
    expect(search).toBe("q=pricing+teardown&topic=fintech&country=VN&stage=series_a");
    expect(filtersFromParams(new URLSearchParams(search))).toEqual(filters);
  });

  it("omits empty filters, so no filters means a bare path", () => {
    expect(filtersToSearch(emptyFilters)).toBe("");
    expect(filtersToSearch({ ...emptyFilters, q: "   ", topic: "product" })).toBe("topic=product");
    expect(filtersFromParams(new URLSearchParams(""))).toEqual(emptyFilters);
  });

  it("drops values the API would reject instead of sending them", () => {
    const params = new URLSearchParams({ topic: "crypto", stage: "Seed", country: "vietnam", q: "a".repeat(150) });
    const filters = filtersFromParams(params);
    expect(filters.topic).toBe("");
    expect(filters.stage).toBe("");
    expect(filters.country).toBe("");
    expect(filters.q).toHaveLength(100);
  });

  it("accepts a lowercase country code by normalizing it", () => {
    expect(filtersFromParams(new URLSearchParams("country=sg")).country).toBe("SG");
  });
});

describe("hasActiveFilters", () => {
  it("is false for defaults and true when any filter is set", () => {
    expect(hasActiveFilters(emptyFilters)).toBe(false);
    expect(hasActiveFilters({ ...emptyFilters, q: "  " })).toBe(false);
    expect(hasActiveFilters({ ...emptyFilters, q: "x" })).toBe(true);
    expect(hasActiveFilters({ ...emptyFilters, stage: "growth" })).toBe(true);
  });
});
