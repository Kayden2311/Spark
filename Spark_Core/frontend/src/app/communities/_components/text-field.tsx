"use client";

import { useId } from "react";

interface TextFieldProps {
  label: string;
  value: string;
  max: number;
  onChange: (value: string) => void;
  /** Rows of a textarea; without it the field is a single line. */
  rows?: number;
}

/** A labelled input or textarea with a "length/max" counter under it. */
export function TextField({ label, value, max, onChange, rows }: TextFieldProps) {
  const id = useId();
  return (
    <div className="circleField">
      <label htmlFor={id}>{label}</label>
      {rows ? (
        <textarea id={id} maxLength={max} onChange={(event) => onChange(event.target.value)} rows={rows} value={value} />
      ) : (
        <input id={id} maxLength={max} onChange={(event) => onChange(event.target.value)} value={value} />
      )}
      <small className="circleCounter">{`${value.length}/${max}`}</small>
    </div>
  );
}
