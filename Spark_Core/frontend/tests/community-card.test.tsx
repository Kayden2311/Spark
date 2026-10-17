import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CommunityCard, initialsOf } from "../src/app/communities/community-card";
import { communitySummaries } from "../src/app/communities/community-summaries";
import { formatCount, formatEventDate } from "../src/app/communities/format";
import { communities } from "../src/app/communities/mock-data";
import type { CommunitySummary } from "../src/app/communities/types";

const sample: CommunitySummary = {
  slug: "northstar-founders",
  name: "Northstar Founders",
  tagline: "Founders building B2B software.",
  category: "B2B SaaS",
  location: "Ho Chi Minh City",
  stage: "Seed to Series A",
  visibility: "private",
  memberCount: 1250,
  weeklyPosts: 42,
  nextEventAt: "2026-10-22T12:00:00.000Z",
  tags: ["GTM"],
  featured: true,
  image: { url: "/spark-community-discussion.png", alt: "Founders around a laptop" },
};

describe("CommunityCard", () => {
  it("renders every structured field and links to the community", () => {
    render(<CommunityCard community={sample} />);
    expect(screen.getByRole("link", { name: "Northstar Founders" })).toHaveAttribute("href", "/communities/northstar-founders");
    expect(screen.getByAltText("Founders around a laptop")).toBeInTheDocument();
    expect(screen.getByText("Private")).toBeInTheDocument();
    expect(screen.getByText("Featured")).toBeInTheDocument();
    expect(screen.getByText("B2B SaaS")).toBeInTheDocument();
    expect(screen.getByText("Ho Chi Minh City")).toBeInTheDocument();
    expect(screen.getByText("Seed to Series A")).toBeInTheDocument();
    const members = screen.getByText("Members").parentElement!;
    expect(within(members).getByText("1.3K")).toBeInTheDocument();
    expect(screen.getByText("Oct 22").closest("time")).toHaveAttribute("dateTime", sample.nextEventAt);
  });

  it("renders a generated cover when no image exists, without a featured badge or event", () => {
    const { container } = render(
      <CommunityCard community={{ ...sample, image: null, featured: false, visibility: "public", nextEventAt: null }} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("NF")).toBeInTheDocument();
    expect(screen.getByText("Public")).toBeInTheDocument();
    expect(screen.queryByText("Featured")).not.toBeInTheDocument();
    expect(screen.getByText("TBA")).toBeInTheDocument();
  });
});

describe("helpers", () => {
  it("builds initials from up to two words", () => {
    expect(initialsOf("Early-Stage Founders Circle")).toBe("ES");
    expect(initialsOf("Product")).toBe("P");
  });

  it("formats counts compactly", () => {
    expect(formatCount(186)).toBe("186");
    expect(formatCount(12400)).toBe("12.4K");
  });

  it("formats event dates in a fixed time zone and tolerates bad input", () => {
    expect(formatEventDate("2026-10-22T18:30:00.000Z")).toBe("Oct 23");
    expect(formatEventDate("not-a-date")).toBe("TBA");
  });
});

describe("communitySummaries fixture", () => {
  it("has unique slugs that all have a detail page", () => {
    const slugs = communitySummaries.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    const detailSlugs = new Set(communities.map((c) => c.slug));
    for (const slug of slugs) expect(detailSlugs.has(slug)).toBe(true);
  });

  it("keeps API-shaped values: short taglines, bounded tags, ISO 8601 dates", () => {
    for (const item of communitySummaries) {
      expect(item.tagline.length).toBeLessThanOrEqual(90);
      expect(item.tags.length).toBeLessThanOrEqual(4);
      if (item.nextEventAt) expect(new Date(item.nextEventAt).toISOString()).toBe(item.nextEventAt);
    }
  });
});
