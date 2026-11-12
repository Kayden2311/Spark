import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CommunityCard, initialsOf } from "../src/app/communities/community-card";
import { formatCount, formatDate, formatLocation } from "../src/app/communities/format";
import { card } from "./community-fixtures";

describe("CommunityCard", () => {
  it("renders the API card fields and links to the community", () => {
    const { container } = render(<CommunityCard community={card({ visibility: "private", featured: true })} />);
    expect(screen.getByRole("link", { name: "Northstar Founders" })).toHaveAttribute("href", "/communities/northstar-founders");
    expect(screen.getByText("Private")).toBeInTheDocument();
    expect(screen.getByText("Featured")).toBeInTheDocument();
    expect(screen.queryByText("Paused")).not.toBeInTheDocument();
    expect(screen.getByText("Hanoi, Vietnam")).toBeInTheDocument();
    expect(screen.getByText("Seed")).toBeInTheDocument();
    expect(screen.queryByText("seed")).not.toBeInTheDocument();
    expect(screen.getByText("Hosted by Northstar Labs")).toBeInTheDocument();
    const tags = screen.getByRole("list", { name: "Topics" });
    expect(within(tags).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["B2B SaaS", "Founders Circle"]);
    const members = screen.getByText("Members").parentElement!;
    expect(within(members).getByText("1.3K")).toBeInTheDocument();
    // The first topic picks the tone of the generated cover.
    expect(container.querySelector("article")).toHaveClass("summaryCard", "summaryTone-blue");
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("NF")).toBeInTheDocument();
  });

  it("marks a frozen community as paused and falls back to a neutral tone", () => {
    const { container } = render(<CommunityCard community={card({ frozen: true, topics: [], location: { countryCode: null, city: null } })} />);
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("Public")).toBeInTheDocument();
    expect(screen.getByText("Remote")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Topics" })).not.toBeInTheDocument();
    expect(container.querySelector("article")).toHaveClass("summaryTone-violet");
  });

  it("renders community text as plain text", () => {
    render(<CommunityCard community={card({ name: "<b>Bold</b>", tagline: "<img src=x onerror=alert(1)>" })} />);
    expect(screen.getByRole("link", { name: "<b>Bold</b>" })).toBeInTheDocument();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
  });
});

describe("helpers", () => {
  it("builds initials from up to two words", () => {
    expect(initialsOf("Early-Stage Founders Circle")).toBe("ES");
    expect(initialsOf("Product")).toBe("P");
    expect(initialsOf("  ")).toBe("");
  });

  it("formats counts compactly", () => {
    expect(formatCount(186)).toBe("186");
    expect(formatCount(12400)).toBe("12.4K");
  });

  it("formats locations from a country code and optional city", () => {
    expect(formatLocation({ countryCode: "VN", city: null })).toBe("Vietnam");
    expect(formatLocation({ countryCode: null, city: "Singapore" })).toBe("Singapore");
    expect(formatLocation({ countryCode: null, city: null })).toBe("Remote");
  });

  it("formats a date for people and tolerates bad input", () => {
    expect(formatDate("2026-11-19T12:00:00.000Z")).toBe("November 19, 2026");
    expect(formatDate("not-a-date")).toBeNull();
  });
});
