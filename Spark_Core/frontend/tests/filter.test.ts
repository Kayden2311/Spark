import { describe, expect, it } from "vitest";
import { communitySummaries } from "../src/app/communities/community-summaries";
import { emptyFilters, filterCommunities, hasActiveFilters } from "../src/app/communities/filter";

describe("filterCommunities", () => {
  it("returns every community for empty filters", () => {
    expect(filterCommunities(communitySummaries, emptyFilters)).toHaveLength(communitySummaries.length);
  });

  it("matches the keyword case-insensitively across name, tagline, category and tags", () => {
    const target = communitySummaries[0];
    const byName = filterCommunities(communitySummaries, { ...emptyFilters, searchTerm: target.name.toUpperCase() });
    expect(byName.map((c) => c.slug)).toContain(target.slug);
    const byTag = filterCommunities(communitySummaries, { ...emptyFilters, searchTerm: target.tags[0].toLowerCase() });
    expect(byTag.map((c) => c.slug)).toContain(target.slug);
  });

  it("requires all active filters to match", () => {
    const target = communitySummaries[0];
    const result = filterCommunities(communitySummaries, {
      ...emptyFilters,
      category: target.category,
      location: target.location,
      stage: target.stage,
    });
    expect(result.length).toBeGreaterThan(0);
    for (const item of result) {
      expect(item.category).toBe(target.category);
      expect(item.location).toBe(target.location);
      expect(item.stage).toBe(target.stage);
    }
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterCommunities(communitySummaries, { ...emptyFilters, searchTerm: "zzz-no-such-community" })).toEqual([]);
  });

  it("ignores whitespace-only keywords", () => {
    expect(filterCommunities(communitySummaries, { ...emptyFilters, searchTerm: "   " })).toHaveLength(communitySummaries.length);
  });
});

describe("hasActiveFilters", () => {
  it("is false for defaults and true when any filter is set", () => {
    expect(hasActiveFilters(emptyFilters)).toBe(false);
    expect(hasActiveFilters({ ...emptyFilters, searchTerm: "x" })).toBe(true);
    expect(hasActiveFilters({ ...emptyFilters, stage: "Growth" })).toBe(true);
  });
});
