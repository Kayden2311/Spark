import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PageHeader } from "../src/app/_ui/page-header";

describe("PageHeader", () => {
  it("renders the title as the page heading with its lead and actions in one header", () => {
    render(<PageHeader actions={<button type="button">Invite</button>} lead="2 people" title="Members" />);
    const heading = screen.getByRole("heading", { level: 1, name: "Members" });
    const header = heading.closest("header");
    expect(header).not.toBeNull();
    expect(within(header as HTMLElement).getByText("2 people")).toBeInTheDocument();
    expect(within(header as HTMLElement).getByRole("button", { name: "Invite" })).toBeInTheDocument();
  });

  it("shows an entity square that screen readers skip", () => {
    render(<PageHeader square={{ color: "#0e7c3a", label: "SL" }} title="Spark Lab" />);
    const square = screen.getByText("SL");
    expect(square).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("heading", { level: 1, name: "Spark Lab" })).toBeInTheDocument();
  });

  it("renders children such as view tabs below the title row", () => {
    render(<PageHeader title="Atlas"><nav aria-label="Project views" /></PageHeader>);
    const nav = screen.getByRole("navigation", { name: "Project views" });
    expect(nav.closest("header")).toBe(screen.getByRole("heading", { level: 1 }).closest("header"));
  });
});
