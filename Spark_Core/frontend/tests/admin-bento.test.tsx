import { readFileSync } from "node:fs";
import path from "node:path";

import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Bento, Tile } from "../src/app/admin/_components/bento";

function mockReducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query === "(prefers-reduced-motion: reduce)",
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

afterEach(() => vi.unstubAllGlobals());

function Nothing() {
  return null;
}

describe("bento grid", () => {
  it("renders a labelled section of tiles with their spans", () => {
    render(
      <Bento label="Platform at a glance">
        <Tile span={8} rowSpan={2}><p>Activity</p></Tile>
        <Tile><p>Gauge</p></Tile>
      </Bento>,
    );
    const section = screen.getByRole("region", { name: "Platform at a glance" });
    expect(section).toHaveClass("admBento");
    const big = within(section).getByText("Activity").parentElement!;
    expect(big).toHaveClass("admTile");
    expect(big.style.getPropertyValue("--tile-span")).toBe("8");
    expect(big.style.getPropertyValue("--tile-rows")).toBe("2");
    expect(big.style.getPropertyValue("--tile-span-md")).toBe("12");
    const small = within(section).getByText("Gauge").parentElement!;
    expect(small.style.getPropertyValue("--tile-span")).toBe("4");
    expect(small.style.getPropertyValue("--tile-rows")).toBe("1");
    expect(small.style.getPropertyValue("--tile-span-md")).toBe("6");
  });

  it("renders no element for a tile without content", () => {
    const { container } = render(
      <Bento label="Tiles">
        <Tile>{null}</Tile>
        <Tile>{false}</Tile>
      </Bento>,
    );
    expect(container.querySelector(".admTile")).toBeNull();
  });

  it("collapses a tile whose child renders nothing", () => {
    const { container } = render(
      <Bento label="Tiles">
        <Tile><Nothing /></Tile>
      </Bento>,
    );
    const tile = container.querySelector(".admTile");
    expect(tile).toBeEmptyDOMElement();
    const css = readFileSync(path.resolve(__dirname, "../src/app/admin/admin.css"), "utf8");
    expect(css).toMatch(/\.admTile:empty\s*\{\s*display:\s*none;/u);
  });

  it("lifts tiles on hover only when motion is allowed", () => {
    mockReducedMotion(false);
    const { container, unmount } = render(<Bento label="Tiles"><Tile><p>A</p></Tile></Bento>);
    expect(container.querySelector(".admTile")).toHaveClass("admLift");
    unmount();

    const still = render(<Bento label="Tiles"><Tile lift={false}><p>A</p></Tile></Bento>);
    expect(still.container.querySelector(".admTile")).not.toHaveClass("admLift");
    still.unmount();

    mockReducedMotion(true);
    const reduced = render(<Bento label="Tiles"><Tile><p>A</p></Tile></Bento>);
    expect(reduced.container.querySelector(".admTile")).not.toHaveClass("admLift");
  });

  it("keeps every effect inside a no-preference motion query", () => {
    const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//gu, "");
    const files = ["../src/app/admin/admin.css", "../src/app/_ui/viz/viz.css"].map((file) => strip(readFileSync(path.resolve(__dirname, file), "utf8")));
    for (const css of files) {
      // Top-level rules (outside any @media block) must never style an effect class.
      let depth = 0;
      let top = "";
      for (const char of css) {
        if (char === "{") depth++;
        if (depth === 0) top += char;
        if (char === "}") depth--;
      }
      expect(top).not.toMatch(/\.adm(DrawIn|GrowIn|FadeIn)\b/u);
      expect(top).not.toMatch(/\.admLift[^{]*:hover/u);
    }
    expect(files.join("\n")).toMatch(/@media \(prefers-reduced-motion: no-preference\)/u);
  });
});
