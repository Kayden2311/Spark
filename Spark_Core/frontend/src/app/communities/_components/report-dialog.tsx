"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { contentApi, contentErrorMessage, REPORT_DETAILS_MAX, type ContentKind, type ReportReason } from "../_lib/content-api";
import { trapDialogKeys, useDialogFocus } from "./dialog-shell";

export const REPORT_THANKS = "Thanks — moderators will review this.";

/** The reasons offered, with the short description under each. Labels are the copy the brief fixes. */
export const REPORT_REASONS: Array<{ value: ReportReason; label: string; hint: string }> = [
  { value: "spam", label: "Spam", hint: "Ads, scams or the same message over and over" },
  { value: "harassment", label: "Harassment", hint: "Insults, threats or targeting a person" },
  { value: "off_topic", label: "Off-topic", hint: "Does not belong in this community" },
  { value: "misinformation", label: "Misinformation", hint: "False or misleading claims" },
  { value: "self_promotion", label: "Self-promotion", hint: "Promotes the author's own product or service" },
  { value: "other", label: "Something else", hint: "Tell the moderators more below" },
];

interface ReportDialogProps {
  kind: ContentKind;
  id: string;
  onClose: () => void;
  /** Called once the report went through, so the item's menu can switch to "You reported this". */
  onReported: () => void;
  fallbackFocus?: () => HTMLElement | null;
}

/** Report a post or comment: pick a reason, add optional details, then see a confirmation. */
export function ReportDialog({ kind, id, onClose, onReported, fallbackFocus }: ReportDialogProps) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const detailsId = useId();
  const hintPrefix = useId();
  // Focus starts on the first reason; the confirmation moves it to Close.
  useDialogFocus(first, fallbackFocus);

  // The form is replaced by the confirmation: keep focus inside the dialog, on Close.
  useEffect(() => {
    if (sent) done.current?.focus();
  }, [sent]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!reason || busy) return;
    setBusy(true);
    setError(null);
    const text = details.trim();
    try {
      await contentApi.report(kind, id, text ? { reason, details: text } : { reason });
      setSent(true);
      onReported();
    } catch (failure) {
      setError(contentErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="circleDialogBackdrop" onKeyDown={(event) => trapDialogKeys(event, busy, onClose)}>
      <div aria-labelledby={titleId} aria-modal="true" className="circleDialog circleDialogWide" role="dialog">
        {sent ? (
          <>
            <h2 className="circleDialogTitle" id={titleId}>
              Report sent
            </h2>
            <p className="circleDialogMessage" role="status">
              {REPORT_THANKS}
            </p>
            <div className="circleDialogActions">
              <button className="circleCtaBtn" onClick={onClose} ref={done} type="button">
                Close
              </button>
            </div>
          </>
        ) : (
          <form className="circleDialogForm" noValidate onSubmit={(event) => void submit(event)}>
            <h2 className="circleDialogTitle" id={titleId}>
              {`Report this ${kind}`}
            </h2>
            <fieldset className="circleReasons" disabled={busy}>
              <legend>Why are you reporting this?</legend>
              {REPORT_REASONS.map((item, index) => (
                <label className="circleReason" key={item.value}>
                  <input
                    aria-describedby={`${hintPrefix}-${item.value}-hint`}
                    aria-labelledby={`${hintPrefix}-${item.value}-name`}
                    checked={reason === item.value}
                    name="report-reason"
                    onChange={() => setReason(item.value)}
                    ref={index === 0 ? first : undefined}
                    type="radio"
                    value={item.value}
                  />
                  <span>
                    <strong id={`${hintPrefix}-${item.value}-name`}>{item.label}</strong>
                    <small id={`${hintPrefix}-${item.value}-hint`}>{item.hint}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="circleField">
              <label htmlFor={detailsId}>Details (optional)</label>
              <textarea id={detailsId} maxLength={REPORT_DETAILS_MAX} onChange={(event) => setDetails(event.target.value)} rows={3} value={details} />
              <small className="circleCounter">{`${details.length}/${REPORT_DETAILS_MAX}`}</small>
            </div>
            {error && (
              <p className="circleNotice circleNoticeError" role="alert">
                {error}
              </p>
            )}
            <div className="circleDialogActions">
              <button className="circleGhostBtn" disabled={busy} onClick={onClose} type="button">
                Cancel
              </button>
              <button className="circleCtaBtn" disabled={!reason || busy} type="submit">
                {busy ? "Sending…" : "Send"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
