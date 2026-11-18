"use client";

import { useEffect, useId, useRef, useState } from "react";
import { contentErrorMessage } from "../_lib/content-api";

interface ConfirmDialogProps {
  /** The question, for example "Delete this post? This can't be undone." */
  message: string;
  confirmLabel: string;
  /** Resolves when the action succeeded; a rejection keeps the dialog open and shows the error. */
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

/** A small modal confirmation. Escape and Cancel close it; focus starts on Cancel and returns to the opener. */
export function ConfirmDialog({ message, confirmLabel, onConfirm, onClose }: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const messageId = useId();

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancel.current?.focus();
    return () => opener?.focus();
  }, []);

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
    <div className="circleDialogBackdrop" onKeyDown={(event) => event.key === "Escape" && !busy && onClose()}>
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
