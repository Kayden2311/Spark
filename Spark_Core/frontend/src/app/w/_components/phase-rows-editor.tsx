"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { PHASE_NAME_MAX, PHASES_MAX, type PhaseDraft } from "../_lib/phases";

export interface PhaseEditorRow extends PhaseDraft {
  /** Stable React key for the row. */
  key: number;
}

/**
 * The M2 phase editor rows (project creation and the Timeline's phase plan): numbered name, start and end
 * fields, Remove per row (never the last one) and Add up to the phase limit. After a removal, focus moves to
 * the name of the row that took its place (or the new last row). With `error` every field is marked invalid.
 */
export function PhaseRowsEditor({ idPrefix, rows, startDate, targetDate, hint, error, onChange, onAdd, onRemove, extraActions, autoFocusFirst = false }: {
  idPrefix: string;
  rows: readonly PhaseEditorRow[];
  startDate: string;
  targetDate: string;
  hint: ReactNode;
  error: string | null;
  onChange(key: number, patch: Partial<PhaseDraft>): void;
  onAdd(): void;
  onRemove(key: number): void;
  extraActions?: ReactNode;
  autoFocusFirst?: boolean;
}) {
  const list = useRef<HTMLOListElement>(null);
  const [focusRequest, setFocusRequest] = useState<{ index: number; serial: number } | null>(null);
  const errorId = `${idPrefix}-error`;
  const hintId = `${idPrefix}-hint`;

  useEffect(() => {
    if (focusRequest) list.current?.querySelector<HTMLElement>(`[data-phase-name="${focusRequest.index}"]`)?.focus();
  }, [focusRequest]);

  const remove = (key: number, index: number) => {
    if (rows.length <= 1) return;
    onRemove(key);
    setFocusRequest((current) => ({ index: Math.min(index, rows.length - 2), serial: (current?.serial ?? 0) + 1 }));
  };

  return (
    <fieldset aria-describedby={error ? errorId : hintId} className="wsProjectPhases">
      <legend>Phases</legend>
      <p className="wsFieldHint" id={hintId}>{hint}</p>
      <ol className="wsProjectPhaseList" ref={list}>
        {rows.map((row, index) => {
          const number = index + 1;
          const invalid = error ? true : undefined;
          return (
            <li className="wsProjectPhase" key={row.key}>
              <span aria-hidden="true" className="wsProjectPhaseNumber">{number}</span>
              <input
                aria-invalid={invalid}
                aria-label={`Phase ${number} name`}
                className="wsProjectPhaseName"
                data-autofocus={(autoFocusFirst && index === 0) || undefined}
                data-phase-name={index}
                maxLength={PHASE_NAME_MAX}
                onChange={(event) => onChange(row.key, { name: event.target.value })}
                value={row.name}
              />
              <input
                aria-invalid={invalid}
                aria-label={`Phase ${number} start`}
                max={targetDate || undefined}
                min={startDate || undefined}
                onChange={(event) => onChange(row.key, { plannedStart: event.target.value })}
                type="date"
                value={row.plannedStart}
              />
              <input
                aria-invalid={invalid}
                aria-label={`Phase ${number} end`}
                max={targetDate || undefined}
                min={startDate || undefined}
                onChange={(event) => onChange(row.key, { plannedEnd: event.target.value })}
                type="date"
                value={row.plannedEnd}
              />
              <button aria-label={`Remove phase ${number}`} className="wsGhostButton danger" disabled={rows.length <= 1} onClick={() => remove(row.key, index)} type="button">
                Remove
              </button>
            </li>
          );
        })}
      </ol>
      {error && <p className="wsFieldError" id={errorId} role="alert">{error}</p>}
      <div className="wsProjectPhaseActions">
        <button className="sparkSecondary wsProjectAddPhase" disabled={rows.length >= PHASES_MAX} onClick={onAdd} type="button">Add phase</button>
        {extraActions}
      </div>
    </fieldset>
  );
}
