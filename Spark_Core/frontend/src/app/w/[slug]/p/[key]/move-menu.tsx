"use client";

import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

export interface MoveOption {
  id: string;
  name: string;
  /** Where the task is now (checked). */
  current: boolean;
  /** Shown but refused, e.g. a column at its WIP limit. */
  disabled?: boolean;
}

/**
 * The "Move to…" menu of a task card (board columns, backlog lanes). Its button carries
 * `data-move-for={issueId}`. The menu lives in <body> with fixed coordinates taken from that button
 * (scrolling containers would clip it) and closes when anything scrolls or the viewport changes.
 */
export function MoveMenu({ issueId, label, options, disabledNote = "full", onClose, onPick }: {
  issueId: string;
  /** Accessible name, e.g. "Move OPS-1 to". */
  label: string;
  options: readonly MoveOption[];
  /** Appended to a disabled option's name: "Review (full)". */
  disabledNote?: string;
  onClose(restoreFocus: boolean): void;
  onPick(option: MoveOption): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  // Below the button, or above it when the viewport has no room below.
  useLayoutEffect(() => {
    const menu = ref.current;
    const anchor = document.querySelector<HTMLElement>(`[data-move-for="${issueId}"]`);
    if (!menu || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    const below = window.innerHeight - rect.bottom;
    const top = below >= menu.offsetHeight + margin || rect.top < menu.offsetHeight + margin ? rect.bottom + 4 : rect.top - menu.offsetHeight - 4;
    const left = Math.min(Math.max(margin, rect.right - menu.offsetWidth), window.innerWidth - menu.offsetWidth - margin);
    menu.style.top = `${Math.max(margin, top)}px`;
    menu.style.left = `${Math.max(margin, left)}px`;
  }, [issueId]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[role=\"menuitemradio\"]:not([aria-disabled=\"true\"])")?.focus({ preventScroll: true });
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      const anchor = document.querySelector(`[data-move-for="${issueId}"]`);
      if (!ref.current?.contains(target) && !anchor?.contains(target)) closeRef.current(false);
    };
    // Fixed coordinates go stale when anything scrolls or the viewport changes.
    const onMoved = (event: Event) => {
      if (!(event.target instanceof Node && ref.current?.contains(event.target))) closeRef.current(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onMoved, true);
    window.addEventListener("resize", onMoved);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onMoved, true);
      window.removeEventListener("resize", onMoved);
    };
  }, [issueId]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("[role=\"menuitemradio\"]") ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      onClose(true);
    } else if (event.key === "Tab") {
      // The menu sits at the end of <body>; return to the button so Tab continues from the card.
      event.preventDefault();
      onClose(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? items[0] : items.at(-1))?.focus();
    }
  };

  return createPortal(
    <div aria-label={label} className="wsBoardMenu" onKeyDown={onKeyDown} ref={ref} role="menu">
      {options.map((option) => {
        const disabled = !option.current && Boolean(option.disabled);
        return (
          <button aria-checked={option.current} aria-disabled={disabled || undefined} aria-label={`${option.name}${option.current ? " (current)" : disabled ? ` (${disabledNote})` : ""}`} className="wsBoardMenuItem" key={option.id} onClick={() => !disabled && onPick(option)} role="menuitemradio" tabIndex={-1} type="button">
            <span aria-hidden="true" className="wsBoardMenuCheck">{option.current && <svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>}</span>
            {option.name}
            {option.current && <span className="wsBoardMenuHint"> (current)</span>}
            {disabled && <span className="wsBoardMenuHint"> ({disabledNote})</span>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
