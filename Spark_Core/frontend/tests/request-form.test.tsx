import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
const auth = { isAuthenticated: true, isLoading: false };

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));

import { MAX_MESSAGE_LENGTH, RequestForm } from "../src/app/communities/[slug]/request/request-form";

describe("RequestForm", () => {
  beforeEach(() => {
    push.mockClear();
    auth.isAuthenticated = true;
    auth.isLoading = false;
  });

  it("asks signed-out visitors to sign in and returns them to the request screen", () => {
    auth.isAuthenticated = false;
    render(<RequestForm slug="northstar-founders" name="Northstar Founders" />);
    const signIn = screen.getByRole("link", { name: "Sign in" });
    expect(signIn).toHaveAttribute("href", "/login?redirect=%2Fcommunities%2Fnorthstar-founders%2Frequest");
    expect(screen.queryByRole("button", { name: "Send request" })).not.toBeInTheDocument();
  });

  it("navigates to the sent screen on submit", async () => {
    render(<RequestForm slug="northstar-founders" name="Northstar Founders" />);
    await userEvent.type(screen.getByLabelText(/message to the owner/i), "Hello");
    await userEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(push).toHaveBeenCalledWith("/communities/northstar-founders/request/sent");
  });

  it("rejects an over-long message and does not navigate", async () => {
    render(<RequestForm slug="northstar-founders" name="Northstar Founders" />);
    const box = screen.getByLabelText(/message to the owner/i);
    await userEvent.click(box);
    await userEvent.paste("a".repeat(MAX_MESSAGE_LENGTH + 1));
    await userEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(screen.getByRole("alert")).toHaveTextContent(String(MAX_MESSAGE_LENGTH));
    expect(push).not.toHaveBeenCalled();
  });
});
