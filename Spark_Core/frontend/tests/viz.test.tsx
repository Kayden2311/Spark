import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BarList, ChartCard } from "../src/app/_ui/viz";

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
