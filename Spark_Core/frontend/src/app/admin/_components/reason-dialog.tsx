"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";

import { messageOf } from "../_lib/api";
import { CloseIcon } from "./icons";

export const REASON_MIN = 3;
export const REASON_MAX = 500;

export interface ReasonRequest {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  tone?: "primary" | "danger";
  /** Common reasons offered as one-click starting points; staff can still edit the text. */
  templates?: string[];
  /** Resolves when the action succeeded; a rejection keeps the dialog open and shows the error. */
  onConfirm: (reason: string) => Promise<void>;
}

const FOCUSABLE = 'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Confirmation dialog for every governance action. A reason is required because the platform audit
 * log records it with the change (US-G3). Focus is trapped inside and returns to the trigger on close.
 */
export function ReasonDialog({ request, onClose }: { request: ReasonRequest | null; onClose: () => void }) {
  if (!request) return null;
  return <ReasonDialogPanel key={request.title} onClose={onClose} request={request} />;
}

function ReasonDialogPanel({ request, onClose }: { request: ReasonRequest; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const hintId = useId();
  const trimmed = reason.trim();
  const invalid = trimmed.length < REASON_MIN;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    field.current?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, []);

  const close = () => {
    if (!submitting) onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab" || !panel.current) return;
    const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (invalid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await request.onConfirm(trimmed);
      onClose();
    } catch (failure) {
      setError(messageOf(failure));
      setSubmitting(false);
    }
  };

  return (
    <div className="admOverlay" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div aria-describedby={descriptionId} aria-labelledby={titleId} aria-modal="true" className="admDialog" onKeyDown={onKeyDown} ref={panel} role="dialog">
        <form noValidate onSubmit={submit}>
          <div className="admDialogHeader">
            <h2 id={titleId}>{request.title}</h2>
            <button aria-label="Close" className="admIconBtn" disabled={submitting} onClick={close} type="button"><CloseIcon /></button>
          </div>
          <div className="admDialogBody">
            <div className="admDialogText" id={descriptionId}>{request.description}</div>
            <label className="admField">
              <span>Reason <em>(recorded in the audit log)</em></span>
              <textarea
                aria-describedby={hintId}
                aria-invalid={touched && invalid}
                maxLength={REASON_MAX}
                onBlur={() => setTouched(true)}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Explain why, so other staff can understand this decision later."
                ref={field}
                rows={4}
                value={reason}
              />
            </label>
            {request.templates && request.templates.length > 0 && (
              <div aria-label="Common reasons" className="admTemplates" role="group">
                {request.templates.map((template) => (
                  <button
                    aria-pressed={trimmed === template}
                    className="admTemplate"
                    key={template}
                    onClick={() => {
                      setReason(template);
                      setTouched(true);
                      field.current?.focus();
                    }}
                    type="button"
                  >
                    {template}
                  </button>
                ))}
              </div>
            )}
            <div className="admFieldHint" id={hintId}>
              {touched && invalid ? <span className="admFieldError">Enter at least {REASON_MIN} characters.</span> : <span>Required, {REASON_MIN} to {REASON_MAX} characters.</span>}
              <span>{reason.length}/{REASON_MAX}</span>
            </div>
            {error && <p className="admDialogError" role="alert">{error}</p>}
          </div>
          <div className="admDialogFooter">
            <button className="admBtn admBtnSecondary" disabled={submitting} onClick={close} type="button">Cancel</button>
            <button className={`admBtn ${request.tone === "danger" ? "admBtnDanger" : "admBtnPrimary"}`} disabled={submitting} type="submit">
              {submitting ? "Saving…" : request.confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
