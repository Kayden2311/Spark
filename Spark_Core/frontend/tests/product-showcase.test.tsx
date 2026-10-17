import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/app/auth-context", () => ({ useAuth: () => ({ isAuthenticated: false }) }));

import { ProductShowcase } from "../src/app/product-showcase";

beforeAll(() => {
  // jsdom has no IntersectionObserver; the typing heading only needs a no-op.
  globalThis.IntersectionObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
    takeRecords() { return []; }
    root = null;
    rootMargin = "";
    thresholds = [];
  } as unknown as typeof IntersectionObserver;
});

describe("ProductShowcase", () => {
  it("starts on the people scene with its call to action", () => {
    render(<ProductShowcase />);
    expect(screen.getByRole("tab", { name: /the people/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("link", { name: /explore communities/i })).toHaveAttribute("href", "/communities");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "product-tab-people");
  });

  it("switches scenes on click and keeps one tab in the tab order", async () => {
    render(<ProductShowcase />);
    await userEvent.click(screen.getByRole("tab", { name: /the plan/i }));
    expect(screen.getByRole("tab", { name: /the plan/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("link", { name: /open boards/i })).toHaveAttribute("href", "/login?redirect=/workspace");
    expect(screen.getAllByRole("tab").filter((tab) => tab.getAttribute("tabindex") === "0")).toHaveLength(1);
  });

  it("moves between tabs with arrow keys and wraps around", async () => {
    render(<ProductShowcase />);
    screen.getByRole("tab", { name: /the people/i }).focus();
    await userEvent.keyboard("{ArrowUp}");
    const last = screen.getByRole("tab", { name: /the next move/i });
    expect(last).toHaveAttribute("aria-selected", "true");
    expect(last).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("tab", { name: /the people/i })).toHaveFocus();
  });

  it("auto-advances when the progress timer completes and can be paused", async () => {
    const { container } = render(<ProductShowcase />);
    // jsdom lacks AnimationEvent, so React may listen under the vendor-prefixed name instead.
    const timer = container.querySelector(".productTabTimerFill")!;
    fireEvent(timer, new Event("animationend", { bubbles: true }));
    if (screen.getByRole("tab", { name: /the people/i }).getAttribute("aria-selected") === "true") {
      fireEvent(timer, new Event("webkitAnimationEnd", { bubbles: true }));
    }
    expect(screen.getByRole("tab", { name: /the plan/i })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("button", { name: /pause the tour/i }));
    expect(container.querySelector(".productTabTimerFill")).toBeNull();
    expect(screen.getByRole("button", { name: /play the tour/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("lets visitors try each scene", async () => {
    render(<ProductShowcase />);
    await userEvent.click(screen.getByRole("button", { name: "Request to join" }));
    expect(screen.getByRole("status")).toHaveTextContent(/will review your request/i);
    expect(screen.getByRole("button", { name: /request sent/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: /the plan/i }));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText(/1 of 4 done/i)).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: /launch community page, in progress/i }));
    expect(within(panel).getByText(/2 of 4 done/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: /the next move/i }));
    await userEvent.click(screen.getByRole("button", { name: "Join session" }));
    expect(screen.getByRole("button", { name: /you're in/i })).toBeInTheDocument();
  });
});
