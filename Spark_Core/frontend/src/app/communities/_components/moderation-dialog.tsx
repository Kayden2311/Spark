"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import {
  contentApi,
  contentErrorMessage,
  MODERATION_REASON_MAX,
  MODERATION_REASON_MIN,
  type ContentKind,
  type ModerationAction,
  type ModerationResult,
} from "../_lib/content-api";
import { trapDialogKeys, useDialogFocus } from "./dialog-shell";

interface Copy {
  title: (kind: ContentKind) => string;
  confirm: (kind: ContentKind) => string;
  description: (kind: ContentKind, hidden: boolean) => string;
  danger: boolean;
  /** Quick fills, the same wording staff use on the platform reports queue. */
  templates: string[];
}

const COPY: Record<ModerationAction, Copy> = {
  hide: {
    title: (kind) => `Hide this ${kind}`,
    confirm: (kind) => `Hide ${kind}`,
    description: (kind) => `Members will no longer see this ${kind}. Its open reports are closed as resolved.`,
    danger: true,
    templates: ["Spam or unsolicited promotion.", "Harassment or a personal attack.", "Misinformation that could cause harm.", "Repeated off-topic posting after warnings."],
  },
  restore: {
    title: (kind) => `Restore this ${kind}`,
    confirm: (kind) => `Restore ${kind}`,
    description: (kind) => `This ${kind} becomes visible to members again.`,
    danger: false,
    templates: ["Reviewed: within the community guidelines.", "A disagreement, not a policy violation."],
  },
  dismiss: {
    title: () => "Keep and dismiss reports",
    confirm: () => "Keep and dismiss",
    description: (kind, hidden) => (hidden ? `The reports are closed and the ${kind} stays hidden.` : `The ${kind} stays visible and its open reports are closed as dismissed.`),
    danger: false,
    templates: ["Not a policy violation.", "Duplicate of a report already handled.", "Not enough detail to act on."],
  },
};

interface ModerationDialogProps {
  kind: ContentKind;
  id: string;
  action: ModerationAction;
  /** The item is hidden now; it changes what "Keep and dismiss" promises. */
  hidden?: boolean;
  onClose: () => void;
  /** Called with the API answer once the action went through; the dialog then closes itself. */
  onDone: (result: ModerationResult) => void;
  fallbackFocus?: () => HTMLElement | null;
}

/** Hide, restore or keep (dismiss the reports of) a post or comment, with a required reason of 3 to 500 characters. */
export function ModerationDialog({ kind, id, action, hidden = false, onClose, onDone, fallbackFocus }: ModerationDialogProps) {
  const copy = COPY[action];
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const reasonId = useId();
  const trimmed = reason.trim();
  const valid = trimmed.length >= MODERATION_REASON_MIN;
  useDialogFocus(field, fallbackFocus);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await contentApi.moderate(kind, id, { action, reason: trimmed });
      onDone(result);
      onClose();
    } catch (failure) {
      setError(contentErrorMessage(failure));
      setBusy(false);
    }
  };

  return (
    <div className="circleDialogBackdrop" onKeyDown={(event) => trapDialogKeys(event, busy, onClose)}>
      <div aria-describedby={descriptionId} aria-labelledby={titleId} aria-modal="true" className="circleDialog circleDialogWide" role="dialog">
        <form className="circleDialogForm" noValidate onSubmit={(event) => void submit(event)}>
          <h2 className="circleDialogTitle" id={titleId}>
            {copy.title(kind)}
          </h2>
          <p className="circleDialogText" id={descriptionId}>
            {copy.description(kind, hidden)}
          </p>
          <div className="circleField">
            <label htmlFor={reasonId}>Reason</label>
            <textarea id={reasonId} maxLength={MODERATION_REASON_MAX} onChange={(event) => setReason(event.target.value)} ref={field} rows={3} value={reason} />
            <small className="circleCounter">{`${reason.length}/${MODERATION_REASON_MAX}`}</small>
            <small className="circleHint">Required, {MODERATION_REASON_MIN} to {MODERATION_REASON_MAX} characters. Recorded in the moderation history.</small>
          </div>
          <div aria-label="Common reasons" className="circleTemplates" role="group">
            {copy.templates.map((template) => (
              <button
                aria-pressed={trimmed === template}
                className="circleTemplate"
                key={template}
                onClick={() => {
                  setReason(template);
                  field.current?.focus();
                }}
                type="button"
              >
                {template}
              </button>
            ))}
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
            <button className={`circleCtaBtn${copy.danger ? " circleDangerBtn" : ""}`} disabled={!valid || busy} type="submit">
              {busy ? "Saving…" : copy.confirm(kind)}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
