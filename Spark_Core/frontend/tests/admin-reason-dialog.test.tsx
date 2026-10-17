import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ReasonDialog, type ReasonRequest } from "../src/app/admin/_components/reason-dialog";
import { ApiError } from "../src/app/admin/_lib/api";

function open(onConfirm: ReasonRequest["onConfirm"] = vi.fn(async () => {})) {
  const onClose = vi.fn();
  render(
    <>
      <button type="button">Opener</button>
      <ReasonDialog onClose={onClose} request={{ title: "Freeze this community?", description: <p>Members cannot post.</p>, confirmLabel: "Freeze", tone: "danger", onConfirm }} />
    </>,
  );
  return { onClose, onConfirm };
}

describe("ReasonDialog", () => {
  it("is a labelled modal that focuses the reason field", () => {
    open();
    const dialog = screen.getByRole("dialog", { name: "Freeze this community?" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription(/members cannot post/i);
    expect(screen.getByRole("textbox", { name: /reason/i })).toHaveFocus();
  });

  it("requires a reason of at least three characters", async () => {
    const { onConfirm } = open();
    await userEvent.type(screen.getByRole("textbox", { name: /reason/i }), "  a ");
    await userEvent.click(screen.getByRole("button", { name: "Freeze" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText(/at least 3 characters/i)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /reason/i })).toHaveAttribute("aria-invalid", "true");
  });

  it("confirms with the trimmed reason and closes", async () => {
    const { onConfirm, onClose } = open();
    await userEvent.type(screen.getByRole("textbox", { name: /reason/i }), "  Repeated spam  ");
    expect(screen.getByText("17/500")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Freeze" }));
    expect(onConfirm).toHaveBeenCalledWith("Repeated spam");
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the dialog open and shows the server's message when the action fails", async () => {
    const { onClose } = open(vi.fn(async () => { throw new ApiError(409, "invalid_transition", "The community is already frozen."); }));
    await userEvent.type(screen.getByRole("textbox", { name: /reason/i }), "Repeated spam");
    await userEvent.click(screen.getByRole("button", { name: "Freeze" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The community is already frozen.");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Freeze" })).toBeEnabled();
  });

  it("closes on Escape and keeps Tab inside the dialog", async () => {
    const { onClose } = open();
    // Focus starts in the reason field; Shift+Tab reaches the first control, then wraps to the last.
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Freeze" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
