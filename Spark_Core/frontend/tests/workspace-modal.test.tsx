import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Modal } from "../src/app/w/_components/modal";

function renderModal() {
  render(
    <>
      <button type="button">Outside</button>
      <Modal onClose={vi.fn()} title="Confirm">
        <input aria-label="Reason" />
        <button type="button">Save</button>
      </Modal>
    </>,
  );
  return {
    dialog: screen.getByRole("dialog", { name: "Confirm" }),
    close: screen.getByRole("button", { name: "Close" }),
    save: screen.getByRole("button", { name: "Save" }),
    outside: screen.getByRole("button", { name: "Outside" }),
  };
}

describe("workspace modal", () => {
  it("wraps Tab and Shift+Tab at the ends of the dialog", async () => {
    const { close, save } = renderModal();
    save.focus();
    await userEvent.tab();
    expect(close).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(save).toHaveFocus();
  });

  it("pulls focus back in when it sits on the panel, the body or outside the dialog", async () => {
    const { dialog, close, save, outside } = renderModal();
    for (const start of [dialog, document.body, outside]) {
      if (start === document.body) (document.activeElement as HTMLElement | null)?.blur();
      else start.focus();
      await userEvent.tab();
      expect(close).toHaveFocus();

      if (start === document.body) (document.activeElement as HTMLElement | null)?.blur();
      else start.focus();
      await userEvent.tab({ shift: true });
      expect(save).toHaveFocus();
    }
  });
});
