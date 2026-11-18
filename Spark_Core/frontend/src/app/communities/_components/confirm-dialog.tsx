"use client";

import { useEffect, useId, useRef, useState } from "react";
import { contentErrorMessage } from "../_lib/content-api";
import { takeFocusTarget } from "../_lib/focus-return";

interface ConfirmDialogProps {
  /** The question, for example "Delete this post? This can't be undone." */
  message: string;
  confirmLabel: string;
  /** Resolves when the action succeeded; a rejection keeps the dialog open and shows the error. */
  onConfirm: () => Promise<void>;
  onClose: () => void;
  /** Where focus goes on close when the opener no longer exists (for example the deleted card is gone). */
  fallbackFocus?: () => HTMLElement | null;
}

/** A small modal confirmation. Escape and Cancel close it; focus starts on Cancel and returns to the opener. */
export function ConfirmDialog({ message, confirmLabel, onConfirm, onClose, fallbackFocus }: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const messageId = useId();

  useEffect(() => {
    const opener = takeFocusTarget() ?? (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null);
    cancel.current?.focus();
    return () => {
      const back = opener?.isConnected ? opener : fallbackFocus?.();
      back?.focus();
    };
    // Mount only: the opener is whatever had focus when the dialog appeared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tab cycles inside the dialog instead of reaching the page behind it.
  const trap = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !busy) {
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])"));
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
  };

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (failure) {
      setError(contentErrorMessage(failure));
      setBusy(false);
    }
  };

  return (
    <div className="circleDialogBackdrop" onKeyDown={trap}>
      <div aria-describedby={messageId} aria-modal="true" className="circleDialog" role="dialog" aria-label={confirmLabel}>
        <p className="circleDialogMessage" id={messageId}>
          {message}
        </p>
        {error && (
          <p className="circleNotice circleNoticeError" role="alert">
            {error}
          </p>
        )}
        <div className="circleDialogActions">
          <button className="circleGhostBtn" disabled={busy} onClick={onClose} ref={cancel} type="button">
            Cancel
          </button>
          <button className="circleCtaBtn circleDangerBtn" disabled={busy} onClick={() => void confirm()} type="button">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
