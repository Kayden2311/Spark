import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/app/auth-context", () => ({ useAuth: () => ({ isAuthenticated: false }) }));
// Canvas particle backgrounds are decorative and need APIs jsdom lacks.
vi.mock("../src/app/signal-particles", () => ({ SignalParticles: () => null }));

import CommunitiesPage from "../src/app/communities/page";
import { communitySummaries } from "../src/app/communities/community-summaries";

const results = () => screen.getByRole("heading", { level: 2, name: /circles?$/i });

describe("communities directory page", () => {
  it("shows directory totals and every circle by default", () => {
    render(<CommunitiesPage />);
    expect(screen.getByRole("heading", { level: 1, name: /find the right room/i })).toBeInTheDocument();
    expect(screen.getByText("Circles").nextElementSibling).toHaveTextContent(String(communitySummaries.length));
    expect(results()).toHaveTextContent(`All circles${communitySummaries.length} circles`);
    expect(screen.getAllByRole("article")).toHaveLength(communitySummaries.length);
  });

  it("filters by topic chip, shows counts and clears filters", async () => {
    render(<CommunitiesPage />);
    const chips = screen.getByRole("group", { name: /filter by topic/i });
    const fintech = within(chips).getByRole("button", { name: /fintech/i });
    expect(fintech).toHaveTextContent("FinTech1");

    await userEvent.click(fintech);
    expect(fintech).toHaveAttribute("aria-pressed", "true");
    expect(results()).toHaveTextContent("FinTech1 circle");
    expect(screen.getAllByRole("article")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getAllByRole("article")).toHaveLength(communitySummaries.length);
  });

  it("updates topic counts from the search and shows an empty state", async () => {
    render(<CommunitiesPage />);
    await userEvent.type(screen.getByRole("searchbox", { name: /search communities/i }), "zzz-no-match");
    const chips = screen.getByRole("group", { name: /filter by topic/i });
    expect(within(chips).getByRole("button", { name: /all topics/i })).toHaveTextContent("All topics0");
    expect(screen.getByText("No circles match these filters")).toBeInTheDocument();
  });
});
