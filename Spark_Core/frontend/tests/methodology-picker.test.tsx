import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { MethodologyPicker } from "../src/app/w/_components/methodology-picker";
import type { MethodologyId, MethodologyTemplate } from "../src/app/w/_lib/methodologies";
import { CATALOG } from "./methodology-catalog";

const templates = CATALOG as unknown as MethodologyTemplate[];

function Harness({ initial = null }: { initial?: MethodologyId | null }) {
  const [value, setValue] = useState<MethodologyId | null>(initial);
  return (
    <>
      <MethodologyPicker label="How does your team work?" onChange={setValue} templates={templates} value={value} />
      <output data-testid="selected">{value ?? "none"}</output>
    </>
  );
}

describe("methodology picker", () => {
  it("renders three cards from the catalog", () => {
    render(<Harness />);
    const group = screen.getByRole("radiogroup", { name: "How does your team work?" });
    const cards = within(group).getAllByRole("radio");
    expect(cards.map((card) => card.getAttribute("aria-checked"))).toEqual(["false", "false", "false"]);
    expect(within(group).getByRole("radio", { name: "Scrum" })).toBeInTheDocument();
    const kanban = within(group).getByRole("radio", { name: "Kanban" });
    expect(within(kanban).getByText("Keep work flowing, one card at a time.")).toBeInTheDocument();
    expect(within(kanban).getByText(/Best for teams with a steady stream/)).toBeInTheDocument();
    expect(within(kanban).getByText("WIP 8")).toBeInTheDocument();
    expect(within(kanban).getByText("WIP 4")).toBeInTheDocument();
    expect(within(kanban).getByText("WIP 3")).toBeInTheDocument();
    expect(within(kanban).getByText("Ready")).toBeInTheDocument();
    expect(within(kanban).getByText(/Planning: A continuous board/)).toBeInTheDocument();
    expect(within(kanban).getByText("Weekly throughput")).toBeInTheDocument();
    expect(within(kanban).getByText("You'll see")).toBeInTheDocument();
    const scrum = within(group).getByRole("radio", { name: "Scrum" });
    expect(within(scrum).queryByText(/^WIP/)).not.toBeInTheDocument();
    // Before anything is chosen the first card takes the tab stop.
    expect(cards.map((card) => card.tabIndex)).toEqual([0, -1, -1]);
  });

  it("selects by click and moves the selection with arrow keys", async () => {
    render(<Harness />);
    const scrum = screen.getByRole("radio", { name: "Scrum" });
    await userEvent.click(scrum);
    expect(scrum).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("selected")).toHaveTextContent("scrum");

    await userEvent.keyboard("{ArrowRight}");
    const kanban = screen.getByRole("radio", { name: "Kanban" });
    expect(kanban).toHaveAttribute("aria-checked", "true");
    expect(kanban).toHaveFocus();
    expect(kanban.tabIndex).toBe(0);
    expect(scrum.tabIndex).toBe(-1);

    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByTestId("selected")).toHaveTextContent("waterfall");
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByTestId("selected")).toHaveTextContent("scrum");
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByTestId("selected")).toHaveTextContent("waterfall");
    expect(screen.getByRole("radio", { name: "Waterfall" })).toHaveFocus();
  });

  it("selects the focused card with Space", async () => {
    render(<Harness />);
    await userEvent.tab();
    expect(screen.getByRole("radio", { name: "Scrum" })).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(screen.getByTestId("selected")).toHaveTextContent("scrum");
  });
});
