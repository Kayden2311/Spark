"use client";

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";

import { CloseIcon } from "./icons";

const FOCUSABLE = 'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Modal side panel for item details. Escape or the backdrop closes it, Tab stays inside it, and focus
 * returns to the opener when it closes. Focus moves only when it opens or closes, not on re-render.
 */
export function Drawer({ title, subtitle, open, onClose, children, footer }: { title: string; subtitle?: ReactNode; open: boolean; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const titleId = useId();

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      // A reason dialog opened on top of the drawer handles its own Escape.
      if (event.key === "Escape" && !document.querySelector(".admDialog")) closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, [open]);

  const trapTab = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab" || !panel.current) return;
    const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;
  return (
    <div className="admDrawerOverlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside aria-labelledby={titleId} aria-modal="true" className="admDrawer" onKeyDown={trapTab} ref={panel} role="dialog" tabIndex={-1}>
        <div className="admDrawerHeader">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button aria-label="Close details" className="admIconBtn" onClick={onClose} type="button"><CloseIcon /></button>
        </div>
        <div className="admDrawerBody">{children}</div>
        {footer && <div className="admDrawerFooter">{footer}</div>}
      </aside>
    </div>
  );
}
