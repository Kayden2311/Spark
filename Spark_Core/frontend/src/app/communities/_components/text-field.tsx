"use client";

import { useId } from "react";

interface TextFieldProps {
  label: string;
  value: string;
  max: number;
  onChange: (value: string) => void;
  /** Rows of a textarea; without it the field is a single line. */
  rows?: number;
  /** Locked, for example while the form is being sent. */
  disabled?: boolean;
}

/** A labelled input or textarea with a "length/max" counter under it. */
export function TextField({ label, value, max, onChange, rows, disabled }: TextFieldProps) {
  const id = useId();
  const counterId = `${id}-counter`;
  return (
    <div className="circleField">
      <label htmlFor={id}>{label}</label>
      {rows ? (
        <textarea aria-describedby={counterId} disabled={disabled} id={id} maxLength={max} onChange={(event) => onChange(event.target.value)} rows={rows} value={value} />
      ) : (
        <input aria-describedby={counterId} disabled={disabled} id={id} maxLength={max} onChange={(event) => onChange(event.target.value)} value={value} />
      )}
      <small className="circleCounter" id={counterId}>{`${value.length}/${max}`}</small>
    </div>
  );
}
