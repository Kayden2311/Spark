import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BarList, ChartCard, Sparkline, TargetGauge } from "../src/app/_ui/viz";

function mockReducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query === "(prefers-reduced-motion: reduce)",
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("shared viz module", () => {
  it("ChartCard toggles to an accessible table", async () => {
    const { container } = render(
      <ChartCard table={{ columns: ["Day", "Posts"], rows: [["Oct 1", 4], ["Oct 2", 7]] }} title="Content created">
        <p>chart</p>
      </ChartCard>,
    );
    expect(container.querySelector("section")).toHaveClass("vizCard");
    expect(screen.getByText("chart")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "View as table" }));
    const table = screen.getByRole("table", { name: "Content created" });
    expect(within(table).getByRole("rowheader", { name: "Oct 2" })).toBeInTheDocument();
    expect(within(table).getByText("7")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show chart" })).toHaveAttribute("aria-pressed", "true");
  });

  it("ChartCard shows error with retry", async () => {
    const onRetry = vi.fn();
    render(
      <ChartCard error="Could not load" onRetry={onRetry} title="Sign-ups">
        <p>chart</p>
      </ChartCard>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("chart")).not.toBeInTheDocument();
  });

  it("ChartCard uses a custom error renderer", async () => {
    const onRetry = vi.fn();
    const renderError = vi.fn((message: string) => <p data-testid="custom-error">{`Custom: ${message}`}</p>);
    render(
      <ChartCard error="Could not load" onRetry={onRetry} renderError={renderError} title="Sign-ups">
        <p>chart</p>
      </ChartCard>,
    );
    expect(renderError).toHaveBeenCalledWith("Could not load", onRetry);
    expect(screen.getByTestId("custom-error")).toHaveTextContent("Custom: Could not load");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ChartCard empty state", () => {
    render(
      <ChartCard empty title="Sign-ups">
        <p>chart</p>
      </ChartCard>,
    );
    expect(screen.getByText("No activity in this period yet.")).toBeInTheDocument();
    expect(screen.queryByText("chart")).not.toBeInTheDocument();
  });

  it("BarList renders labels and percent share", () => {
    const { unmount } = render(
      <BarList color="#2563eb" items={[{ key: "a", label: "Alpha", value: 3 }, { key: "b", label: "Beta", value: 1 }]} />,
    );
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
    unmount();

    render(<BarList color="#2563eb" items={[]} />);
    expect(screen.getByText("Nothing to rank yet.")).toBeInTheDocument();
  });

  it("TargetGauge stays green within target", () => {
    const { container } = render(<TargetGauge label="Report backlog" target={10} value={4} />);
    const gauge = screen.getByRole("img", { name: "Report backlog: 4, Within target" });
    expect(gauge).not.toHaveClass("vizTargetGaugeOver");
    expect(screen.getByText("Within target")).toBeInTheDocument();
    expect(container.querySelector(".vizTargetGaugeFill")).not.toBeNull();
  });

  it("TargetGauge turns red and says how far over target", () => {
    const { container, unmount } = render(<TargetGauge label="Report backlog" target={10} value={20} />);
    expect(screen.getByRole("img", { name: "Report backlog: 20, 2× over target" })).toHaveClass("vizTargetGaugeOver");
    expect(screen.getByText("2× over target")).toBeInTheDocument();
    // Full at twice the target: the fill ends at the right end of the half arc.
    expect(container.querySelector(".vizTargetGaugeFill")?.getAttribute("d")).toMatch(/ 108 60$/u);
    unmount();

    render(<TargetGauge label="Report backlog" target={10} value={15} />);
    expect(screen.getByRole("img", { name: "Report backlog: 15, 1.5× over target" })).toBeInTheDocument();
  });

  it("TargetGauge shows an empty arc at zero", () => {
    const { container } = render(<TargetGauge label="Report backlog" target={10} value={0} />);
    expect(screen.getByRole("img", { name: "Report backlog: 0, Within target" })).toBeInTheDocument();
    expect(container.querySelector(".vizTargetGaugeTrack")).not.toBeNull();
    expect(container.querySelector(".vizTargetGaugeFill")).toBeNull();
  });

  it("draws sparklines, gauges and bars in only when motion is allowed", () => {
    mockReducedMotion(false);
    const animated = render(
      <>
        <Sparkline color="#2563eb" values={[1, 3, 2]} />
        <TargetGauge label="Backlog" target={10} value={4} />
        <BarList color="#2563eb" items={[{ key: "a", label: "Alpha", value: 3 }]} />
      </>,
    );
    expect(animated.container.querySelectorAll(".admDrawIn")).toHaveLength(2);
    expect(animated.container.querySelector(".vizBarListTrack .admGrowIn")).not.toBeNull();
    animated.unmount();

    mockReducedMotion(true);
    const still = render(
      <>
        <Sparkline color="#2563eb" values={[1, 3, 2]} />
        <TargetGauge label="Backlog" target={10} value={4} />
        <BarList color="#2563eb" items={[{ key: "a", label: "Alpha", value: 3 }]} />
      </>,
    );
    expect(still.container.querySelector(".admDrawIn, .admGrowIn, .admFadeIn")).toBeNull();
    expect(still.container.querySelector(".vizTargetGaugeFill")).not.toBeNull();
    expect(still.container.querySelector(".vizBarListTrack span")).toHaveStyle({ "--viz-bar-w": "100%" });
  });

  it("shared modules never import admin", () => {
    const appDir = path.resolve(__dirname, "../src/app");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx|css)$/u.test(name)) files.push(full);
      }
    };
    walk(path.join(appDir, "_ui"));
    walk(path.join(appDir, "_lib"));
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => /^\s*(import|export)\b.*["'][^"']*\/admin(\/|["'])/u.test(line) || /^\s*@import\b.*\/admin\//u.test(line))
        .map((line) => `${path.relative(appDir, file)}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
