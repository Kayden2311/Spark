"use client";

import type { ReactNode } from "react";

import {
  CITY_MAX,
  COMMUNITY_STAGES,
  COMMUNITY_TOPICS,
  DESCRIPTION_MAX,
  MAX_TOPICS,
  MIN_TOPICS,
  NAME_MAX,
  TAGLINE_MAX,
  VISIBILITY_OPTIONS,
  countryOptions,
  visibilityChangeNote,
} from "../_lib/catalog";
import type { CommunityDetail, CommunityFields, CommunityVisibility } from "../types";

/** What the form edits: the API fields, with "" for "no country" and "no city". */
export interface FieldValues {
  name: string;
  tagline: string;
  description: string;
  visibility: CommunityVisibility;
  countryCode: string;
  city: string;
  stage: string;
  topics: string[];
}

export type FieldErrors = Partial<Record<keyof FieldValues, string>>;

export const emptyValues: FieldValues = {
  name: "",
  tagline: "",
  description: "",
  visibility: "public",
  countryCode: "",
  city: "",
  stage: "any",
  topics: [],
};

export function valuesOf(community: CommunityDetail): FieldValues {
  return {
    name: community.name,
    tagline: community.tagline,
    description: community.description,
    visibility: community.visibility,
    countryCode: community.location.countryCode ?? "",
    city: community.location.city ?? "",
    stage: community.stage.code,
    topics: community.topics.map((topic) => topic.slug),
  };
}

/** The API body for these values: trimmed text, null for an empty country or city. */
export function toFields(values: FieldValues): CommunityFields {
  return {
    name: values.name.trim(),
    tagline: values.tagline.trim(),
    description: values.description.trim(),
    visibility: values.visibility,
    countryCode: values.countryCode || null,
    city: values.city.trim() || null,
    stage: values.stage,
    topics: values.topics,
  };
}

/** Only the fields that differ from the saved community (PATCH sends nothing else). */
export function changedFields(saved: FieldValues, values: FieldValues): Partial<CommunityFields> {
  const before = toFields(saved);
  const after = toFields(values);
  const patch: Partial<CommunityFields> = {};
  for (const key of Object.keys(after) as Array<keyof CommunityFields>) {
    const same = key === "topics" ? before.topics.join(",") === after.topics.join(",") : before[key] === after[key];
    if (!same) (patch as Record<string, unknown>)[key] = after[key];
  }
  return patch;
}

export function validate(values: FieldValues): FieldErrors {
  const errors: FieldErrors = {};
  if (!values.name.trim()) errors.name = "Give the community a name.";
  else if (values.name.trim().length > NAME_MAX) errors.name = `Keep the name to ${NAME_MAX} characters.`;
  if (!values.tagline.trim()) errors.tagline = "Add a one-line tagline.";
  else if (values.tagline.trim().length > TAGLINE_MAX) errors.tagline = `Keep the tagline to ${TAGLINE_MAX} characters.`;
  if (!values.description.trim()) errors.description = "Describe what the community is for.";
  else if (values.description.trim().length > DESCRIPTION_MAX) errors.description = `Keep the description to ${DESCRIPTION_MAX} characters.`;
  if (values.city.trim().length > CITY_MAX) errors.city = `Keep the city to ${CITY_MAX} characters.`;
  if (values.topics.length < MIN_TOPICS || values.topics.length > MAX_TOPICS) errors.topics = `Pick ${MIN_TOPICS} to ${MAX_TOPICS} topics.`;
  return errors;
}

function Counter({ value, max }: { value: string; max: number }) {
  const length = value.length;
  return <span className={length > max ? "spFieldCount spFieldCountOver" : "spFieldCount"}>{length}/{max}</span>;
}

function Problem({ id, text }: { id: string; text: string | undefined }) {
  return text ? <p className="spError" id={id} role="alert">{text}</p> : null;
}

/**
 * The shared community fields of the create form and the Settings tab. `savedVisibility` turns on the note that
 * explains what a visibility change does; `afterName` is where the create form puts the address field.
 */
export function CommunityFieldset({ idPrefix, values, errors, onChange, savedVisibility, afterName, disabled = false }: {
  idPrefix: string;
  values: FieldValues;
  errors: FieldErrors;
  onChange(next: Partial<FieldValues>): void;
  savedVisibility?: CommunityVisibility;
  afterName?: ReactNode;
  disabled?: boolean;
}) {
  const id = (name: string) => `${idPrefix}-${name}`;
  const described = (name: keyof FieldValues, hint?: string) => (errors[name] ? id(`${name}-error`) : hint);
  const note = savedVisibility ? visibilityChangeNote(savedVisibility, values.visibility) : null;
  const full = values.topics.length >= MAX_TOPICS;

  const toggleTopic = (slug: string) =>
    onChange({ topics: values.topics.includes(slug) ? values.topics.filter((topic) => topic !== slug) : [...values.topics, slug] });

  return (
    <div className="spFormStack">
      <div className="spField">
        <label className="spLabel" htmlFor={id("name")}>Name</label>
        <input
          aria-describedby={described("name")}
          aria-invalid={errors.name ? true : undefined}
          autoComplete="off"
          className="spInput"
          disabled={disabled}
          id={id("name")}
          maxLength={NAME_MAX + 20}
          onChange={(event) => onChange({ name: event.target.value })}
          value={values.name}
        />
        <Problem id={id("name-error")} text={errors.name} />
      </div>

      {afterName}

      <div className="spField">
        <div className="spFieldHead">
          <label className="spLabel" htmlFor={id("tagline")}>Tagline</label>
          <Counter max={TAGLINE_MAX} value={values.tagline} />
        </div>
        <input
          aria-describedby={described("tagline", id("tagline-hint"))}
          aria-invalid={errors.tagline ? true : undefined}
          autoComplete="off"
          className="spInput"
          disabled={disabled}
          id={id("tagline")}
          maxLength={TAGLINE_MAX + 20}
          onChange={(event) => onChange({ tagline: event.target.value })}
          value={values.tagline}
        />
        {errors.tagline ? <Problem id={id("tagline-error")} text={errors.tagline} /> : <p className="spHint" id={id("tagline-hint")}>Shown on the community card in the directory.</p>}
      </div>

      <div className="spField">
        <div className="spFieldHead">
          <label className="spLabel" htmlFor={id("description")}>Description</label>
          <Counter max={DESCRIPTION_MAX} value={values.description} />
        </div>
        <textarea
          aria-describedby={described("description")}
          aria-invalid={errors.description ? true : undefined}
          className="spTextarea"
          disabled={disabled}
          id={id("description")}
          onChange={(event) => onChange({ description: event.target.value })}
          rows={5}
          value={values.description}
        />
        <Problem id={id("description-error")} text={errors.description} />
      </div>

      <fieldset className="spFieldset" disabled={disabled}>
        <legend className="spLabel">Visibility</legend>
        <div className="spChoices">
          {VISIBILITY_OPTIONS.map((option) => (
            <label className="spChoice" key={option.value}>
              <input
                aria-describedby={id(`visibility-${option.value}-help`)}
                checked={values.visibility === option.value}
                name={id("visibility")}
                onChange={() => onChange({ visibility: option.value })}
                type="radio"
                value={option.value}
              />
              <span className="spChoiceText">
                <strong>{option.label}</strong>
                <small id={id(`visibility-${option.value}-help`)}>{option.help}</small>
              </span>
            </label>
          ))}
        </div>
        {note && <p className="spAlert spAlertWarn" role="status">{note}</p>}
      </fieldset>

      <div className="spFormRow">
        <div className="spField">
          <label className="spLabel" htmlFor={id("country")}>Country</label>
          <select className="spSelect" disabled={disabled} id={id("country")} onChange={(event) => onChange({ countryCode: event.target.value })} value={values.countryCode}>
            <option value="">Remote / no country</option>
            {countryOptions().map((country) => <option key={country.code} value={country.code}>{country.name}</option>)}
          </select>
        </div>
        <div className="spField">
          <label className="spLabel" htmlFor={id("city")}>City</label>
          <input
            aria-describedby={described("city")}
            aria-invalid={errors.city ? true : undefined}
            autoComplete="off"
            className="spInput"
            disabled={disabled}
            id={id("city")}
            onChange={(event) => onChange({ city: event.target.value })}
            placeholder="Optional"
            value={values.city}
          />
          <Problem id={id("city-error")} text={errors.city} />
        </div>
      </div>

      <div className="spField spFieldNarrow">
        <label className="spLabel" htmlFor={id("stage")}>Stage</label>
        <select className="spSelect" disabled={disabled} id={id("stage")} onChange={(event) => onChange({ stage: event.target.value })} value={values.stage}>
          {COMMUNITY_STAGES.map((stage) => <option key={stage.code} value={stage.code}>{stage.label}</option>)}
        </select>
      </div>

      <fieldset aria-describedby={errors.topics ? id("topics-error") : id("topics-hint")} className="spFieldset" disabled={disabled}>
        <legend className="spLabel">Topics</legend>
        <div className="spChips">
          {COMMUNITY_TOPICS.map((topic) => {
            const on = values.topics.includes(topic.slug);
            return (
              <button aria-pressed={on} className="spBtn spBtnSecondary spBtnSm" disabled={!on && full} key={topic.slug} onClick={() => toggleTopic(topic.slug)} type="button">
                {topic.name}
              </button>
            );
          })}
        </div>
        {errors.topics ? <Problem id={id("topics-error")} text={errors.topics} /> : <p className="spHint" id={id("topics-hint")}>Pick {MIN_TOPICS} to {MAX_TOPICS}. They decide where people find the community.</p>}
      </fieldset>
    </div>
  );
}
