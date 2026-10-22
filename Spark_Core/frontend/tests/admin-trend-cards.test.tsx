import { readFileSync } from "node:fs";
import path from "node:path";

import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TrendCards, type TrendCardItem } from "../src/app/admin/_components/trend-cards";

const base: TrendCardItem = { label: "New sign-ups", value: "130", dot: "#eb6834", color: "#eb6834" };

function mockReducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query === "(prefers-reduced-motion: reduce)",
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("trend cards", () => {
  it("shows the label, value and a good change chip in words and arrows", () => {
    render(<TrendCards items={[{ ...base, change: { current: 130, previous: 100 }, series: [1, 3, 2, 5] }]} label="Key numbers" />);
    const list = screen.getByRole("list", { name: "Key numbers" });
    const card = within(list).getByRole("listitem");
    expect(within(card).getByText("New sign-ups")).toBeInTheDocument();
    expect(within(card).getByText("130")).toBeInTheDocument();
    const chip = within(card).getByText("↑ +30%");
    expect(chip).toHaveAttribute("data-tone", "good");
    expect(within(card).getByText("New sign-ups: 130, +30% vs previous period, improving")).toHaveClass("admSrOnly");
    expect(chip).toHaveAttribute("title", "Improving");
    const spark = card.querySelector("svg.vizSpark");
    expect(spark).not.toBeNull();
    expect(spark).toHaveAttribute("aria-hidden", "true");
  });

  it("marks a rise as bad when lower is better", () => {
    render(<TrendCards items={[{ ...base, label: "Open reports", change: { current: 130, previous: 100, higherIsBetter: false } }]} label="Reports" />);
    const chip = screen.getByText("↑ +30%");
    expect(chip).toHaveAttribute("data-tone", "bad");
    expect(chip).toHaveAttribute("title", "Worsening");
    expect(screen.getByText("Open reports: 130, +30% vs previous period, worsening")).toHaveClass("admSrOnly");
  });

  it("marks a fall as good when lower is better, and flat as neutral", () => {
    render(
      <TrendCards
        items={[
          { ...base, label: "Open reports", change: { current: 50, previous: 100, higherIsBetter: false } },
          { ...base, label: "Flat", change: { current: 100, previous: 100 } },
        ]}
        label="Reports"
      />,
    );
    expect(screen.getByText("↓ −50%")).toHaveAttribute("data-tone", "good");
    expect(screen.getByText("No change")).toHaveAttribute("data-tone", "flat");
  });

  it("omits the chip when there is no earlier period", () => {
    render(<TrendCards items={[{ ...base, change: { current: 130, previous: null } }]} label="Key numbers" />);
    expect(screen.queryByText(/No earlier period/u)).not.toBeInTheDocument();
    expect(screen.getByText("New sign-ups: 130")).toHaveClass("admSrOnly");
  });

  it("draws no sparkline for fewer than two points", () => {
    const { container } = render(<TrendCards items={[{ ...base, series: [4] }, { ...base, label: "Empty", series: [] }]} label="Key numbers" />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("makes the whole card a link when href is set", () => {
    render(<TrendCards items={[{ ...base, href: "/admin/users", change: { current: 130, previous: 100 } }]} label="Key numbers" />);
    const link = screen.getByRole("link", { name: "New sign-ups: 130, +30% vs previous period, improving" });
    expect(link).toHaveAttribute("href", "/admin/users");
    expect(link).toHaveClass("admTrendCard");
  });

  it("shows a skeleton while the value is loading", () => {
    render(<TrendCards items={[{ ...base, value: undefined, change: { current: 1, previous: 2 }, series: [1, 2, 3] }]} label="Key numbers" />);
    const card = screen.getByRole("listitem");
    expect(card.querySelector(".admTrendCardSkeleton")).not.toBeNull();
    expect(within(card).getByText("New sign-ups: loading")).toHaveClass("admSrOnly");
    expect(card.querySelector("svg")).toBeNull();
    expect(card.querySelector("[data-tone]")).toBeNull();
  });

  it("colours a bad value", () => {
    render(<TrendCards items={[{ ...base, valueTone: "bad" }]} label="Key numbers" />);
    expect(screen.getByText("130")).toHaveClass("admTrendCardValue-bad");
    expect(screen.getByText("New sign-ups: 130, needs attention")).toHaveClass("admSrOnly");
  });

  it("animates (lift, sparkline draw-in) only when motion is allowed", () => {
    mockReducedMotion(false);
    const { container, unmount } = render(<TrendCards items={[{ ...base, series: [1, 2, 3] }]} label="Key numbers" />);
    expect(container.querySelector(".admTrendCard")).toHaveClass("admLift");
    expect(container.querySelector(".admDrawIn")).not.toBeNull();
    unmount();

    mockReducedMotion(true);
    const reduced = render(<TrendCards items={[{ ...base, series: [1, 2, 3] }]} label="Key numbers" />);
    expect(reduced.container.querySelector(".admTrendCard")).not.toHaveClass("admLift");
    expect(reduced.container.querySelector(".admDrawIn, .admFadeIn, .admGrowIn, .admLift")).toBeNull();
    expect(reduced.container.querySelector("svg.vizSpark path")).not.toBeNull();
  });
  it("sizes the row to its card count so one to four cards fill the width", () => {
    const { container, rerender } = render(<TrendCards items={[base, { ...base, label: "Second" }]} label="Key numbers" />);
    const list = container.querySelector(".admTrendCards")!;
    expect(list).toHaveStyle({ "--trend-cards": "2", "--trend-cards-md": "2" });
    rerender(<TrendCards items={[base]} label="Key numbers" />);
    expect(container.querySelector(".admTrendCards")).toHaveStyle({ "--trend-cards": "1", "--trend-cards-md": "1" });
    rerender(<TrendCards items={[1, 2, 3, 4, 5].map((n) => ({ ...base, label: `Card ${n}` }))} label="Key numbers" />);
    expect(container.querySelector(".admTrendCards")).toHaveStyle({ "--trend-cards": "4", "--trend-cards-md": "2" });
    const css = readFileSync(path.join(__dirname, "../src/app/admin/admin.css"), "utf8");
    expect(css).toContain(".admTrendCards { display: grid; grid-template-columns: repeat(var(--trend-cards, 4), minmax(0, 1fr));");
    expect(css).toContain(".admTrendCards { grid-template-columns: repeat(var(--trend-cards-md, 2), minmax(0, 1fr)); }");
  });
});
