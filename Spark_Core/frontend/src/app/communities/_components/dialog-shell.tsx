"use client";

import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { takeFocusTarget } from "../_lib/focus-return";

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), textarea:not([disabled])";

/**
 * Focus handling shared by the community dialogs. On open, takes the trigger the menu left behind (or the
 * element that had focus) and moves focus to `initial`; on close, gives focus back to that opener, or to
 * `fallback` when the opener is gone (for example the card was deleted or the row left the list).
 */
export function useDialogFocus(initial: RefObject<HTMLElement | null>, fallback?: () => HTMLElement | null): void {
  useEffect(() => {
    const opener = takeFocusTarget() ?? (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null);
    initial.current?.focus();
    return () => {
      const back = opener?.isConnected ? opener : fallback?.();
      back?.focus();
    };
    // Mount only: the opener is whatever had focus when the dialog appeared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * The controls Tab can reach. A radio group has one tab stop: its checked radio, or its first radio when none
 * is checked, so the other radios must not count as the first or last control.
 */
function tabbable(root: HTMLElement): HTMLElement[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
  return all.filter((element) => {
    if (!(element instanceof HTMLInputElement) || element.type !== "radio" || !element.name) return true;
    const group = all.filter((other): other is HTMLInputElement => other instanceof HTMLInputElement && other.type === "radio" && other.name === element.name);
    const stop = group.find((radio) => radio.checked) ?? group[0];
    return element === stop;
  });
}

/** Escape closes (unless busy); Tab and Shift+Tab cycle between the dialog's own controls. */
export function trapDialogKeys(event: ReactKeyboardEvent<HTMLElement>, busy: boolean, onClose: () => void): void {
  if (event.key === "Escape" && !busy) {
    onClose();
    return;
  }
  if (event.key !== "Tab") return;
  const controls = tabbable(event.currentTarget);
  if (controls.length === 0) return;
  const first = controls[0]!;
  const last = controls[controls.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !controls.includes(active as HTMLElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !controls.includes(active as HTMLElement))) {
    event.preventDefault();
    first.focus();
  }
}
