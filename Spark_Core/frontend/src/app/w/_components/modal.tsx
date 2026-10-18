"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal dialog: labelled by its title, focus moves in on open and back to the opener on close,
 * Tab stays inside, Escape and the backdrop close it (unless `busy`).
 */
export function Modal({ title, description, onClose, busy = false, tone = "default", children }: {
  title: string;
  description?: ReactNode;
  onClose(): void;
  busy?: boolean;
  tone?: "default" | "danger";
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const close = useRef(onClose);
  const locked = useRef(busy);

  useEffect(() => {
    close.current = onClose;
    locked.current = busy;
  });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = panel.current;
    const first = node?.querySelector<HTMLElement>("[data-autofocus]") ?? node?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? node)?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!locked.current) close.current();
        return;
      }
      if (event.key !== "Tab" || !node) return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const [head, tail] = [items[0], items[items.length - 1]];
      const active = document.activeElement;
      // Focus on the panel itself, on the body or outside the dialog re-enters at the first or last item.
      if (!(active instanceof HTMLElement) || !items.includes(active)) {
        event.preventDefault();
        (event.shiftKey ? tail : head).focus();
      } else if (event.shiftKey && active === head) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && active === tail) {
        event.preventDefault();
        head.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = overflow;
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return createPortal(
    <div className="wsModalLayer" onMouseDown={(event) => { if (event.target === event.currentTarget && !locked.current) close.current(); }}>
      <div
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className="wsModal"
        data-tone={tone}
        ref={panel}
        role="dialog"
        tabIndex={-1}
      >
        <header className="wsModalHeader">
          <h2 id={titleId}>{title}</h2>
          <button aria-label="Close" className="wsModalClose" disabled={busy} onClick={() => close.current()} type="button">
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </header>
        {description && <div className="wsModalText" id={descriptionId}>{description}</div>}
        {children}
      </div>
    </div>,
    document.body,
  );
}
