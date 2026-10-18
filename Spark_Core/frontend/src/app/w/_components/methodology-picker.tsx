"use client";

import { useId, useRef, type CSSProperties, type KeyboardEvent } from "react";

import { METHODOLOGY_ACCENTS, type MethodologyId, type MethodologyTemplate } from "../_lib/methodologies";

interface MethodologyPickerProps {
  templates: MethodologyTemplate[];
  value: MethodologyId | null;
  onChange(value: MethodologyId): void;
  /** Accessible name of the radio group (usually the page headline). */
  label?: string;
  /** Id of an element that names the group, used instead of `label`. */
  labelledBy?: string;
}

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown"]);
const PREVIOUS_KEYS = new Set(["ArrowLeft", "ArrowUp"]);

/** Three large methodology cards with radio-group semantics: one tab stop, arrow keys move the selection. */
export function MethodologyPicker({ templates, value, onChange, label, labelledBy }: MethodologyPickerProps) {
  const baseId = useId();
  const cards = useRef<Array<HTMLDivElement | null>>([]);
  const selectedIndex = templates.findIndex((template) => template.id === value);
  const tabStop = selectedIndex === -1 ? 0 : selectedIndex;

  const select = (index: number) => {
    const template = templates[index];
    if (!template) return;
    onChange(template.id);
    cards.current[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const count = templates.length;
    if (NEXT_KEYS.has(event.key)) select((index + 1) % count);
    else if (PREVIOUS_KEYS.has(event.key)) select((index - 1 + count) % count);
    else if (event.key === "Home") select(0);
    else if (event.key === "End") select(count - 1);
    else if (event.key === " " || event.key === "Enter") select(index);
    else return;
    event.preventDefault();
  };

  return (
    <div aria-label={labelledBy ? undefined : label} aria-labelledby={labelledBy} className="wsPicker" role="radiogroup">
      {templates.map((template, index) => {
        const nameId = `${baseId}-${template.id}-name`;
        const taglineId = `${baseId}-${template.id}-tagline`;
        const checked = template.id === value;
        return (
          <div
            aria-checked={checked}
            aria-describedby={taglineId}
            aria-labelledby={nameId}
            className="wsPickerCard"
            data-methodology={template.id}
            key={template.id}
            onClick={() => select(index)}
            onKeyDown={(event) => onKeyDown(event, index)}
            ref={(element) => {
              cards.current[index] = element;
            }}
            role="radio"
            style={{ "--method-accent": METHODOLOGY_ACCENTS[template.id] } as CSSProperties}
            tabIndex={index === tabStop ? 0 : -1}
          >
            <span aria-hidden="true" className="wsPickerAccent" />
            <div className="wsPickerHead">
              <span className="wsPickerName" id={nameId}>{template.name}</span>
              <span aria-hidden="true" className="wsPickerCheck">
                <svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
              </span>
            </div>
            <p className="wsPickerTagline" id={taglineId}>{template.tagline}</p>
            <p className="wsPickerBestFor">Best for {lowerFirst(template.bestFor)}</p>
            <ul className="wsPickerColumns">
              {template.statuses.map((status) => (
                <li className="wsPickerColumn" data-category={status.category} key={status.name}>
                  <span>{status.name}</span>
                  {status.wipLimit !== null && <span className="wsPickerWip">WIP {status.wipLimit}</span>}
                </li>
              ))}
            </ul>
            <p className="wsPickerPlanning">{`Planning: ${template.planningObject}`}</p>
            <div className="wsPickerMetrics">
              <p className="wsPickerMetricsTitle">You&apos;ll see</p>
              <ul>
                {template.metrics.map((metric) => <li key={metric}>{metric}</li>)}
              </ul>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function lowerFirst(text: string): string {
  return text.length > 0 ? text[0].toLowerCase() + text.slice(1) : text;
}
