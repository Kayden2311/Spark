"use client";

import { useId, useState, type FormEvent } from "react";

import { Modal } from "../../../_components/modal";
import { ApiError, messageOf } from "../../../_lib/api";
import {
  addDays,
  completeSprint,
  createSprint,
  pointsLabel,
  SPRINT_GOAL_MAX,
  SPRINT_MAX_DAYS,
  SPRINT_NAME_MAX,
  startSprint,
  taskCountLabel,
  updateSprint,
  type CompletedSprint,
  type Sprint,
  type SprintFields,
} from "../../../_lib/planning";
import { daysBetween, formatDay } from "../../../_lib/projects";

export const SPRINT_UPDATED = "Updated by a teammate — review the sprint and try again.";
const DATES_INVALID = `A sprint lasts 1 to ${SPRINT_MAX_DAYS} days, ending after it starts.`;
const DATES_PAIRED = "Set both dates, or leave both empty.";
const DATES_REQUIRED = "A sprint needs a start and an end date to start.";

/** The newer sprint a 412 carries, if any. */
function staleSprint(error: unknown): Sprint | null {
  return error instanceof ApiError && error.status === 412 ? (error.body as { current?: Sprint } | null)?.current ?? null : null;
}

function datesProblem(startsOn: string, endsOn: string, required: boolean): string | null {
  if (!startsOn && !endsOn) return required ? DATES_REQUIRED : null;
  if (!startsOn || !endsOn) return required ? DATES_REQUIRED : DATES_PAIRED;
  const length = daysBetween(startsOn, endsOn);
  return Number.isNaN(length) || length < 1 || length > SPRINT_MAX_DAYS ? DATES_INVALID : null;
}

function DateFields({ startsOn, endsOn, error, onStart, onEnd, disabled = false }: {
  startsOn: string;
  endsOn: string;
  error: string | null;
  onStart(value: string): void;
  onEnd(value: string): void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <fieldset aria-describedby={error ? `${id}-error` : undefined} className="wsSettingsDates">
      <legend>Dates</legend>
      <div className="wsField">
        <label htmlFor={`${id}-start`}>Start date</label>
        <input aria-invalid={error ? true : undefined} disabled={disabled} id={`${id}-start`} onChange={(event) => onStart(event.target.value)} type="date" value={startsOn} />
      </div>
      <div className="wsField">
        <label htmlFor={`${id}-end`}>End date</label>
        <input aria-invalid={error ? true : undefined} disabled={disabled} id={`${id}-end`} min={startsOn ? addDays(startsOn, 1) : undefined} onChange={(event) => onEnd(event.target.value)} type="date" value={endsOn} />
      </div>
      {error
        ? <p className="wsFieldError" id={`${id}-error`}>{error}</p>
        : <p className="wsFieldHint">Sprints last 1 to {SPRINT_MAX_DAYS} days.</p>}
    </fieldset>
  );
}

/**
 * Creates a sprint (`sprint` null) or edits a planned one: name, goal and dates. Dates are optional together;
 * a sprint needs them to start.
 */
export function SprintFormDialog({ projectId, sprint, defaults, onClose, onSaved }: {
  projectId: string;
  sprint: Sprint | null;
  /** The new sprint's pre-filled values. */
  defaults: SprintFields;
  onClose(): void;
  onSaved(sprint: Sprint): void;
}) {
  const id = useId();
  const [base, setBase] = useState<Sprint | null>(sprint);
  const initial = (from: Sprint | null) => ({
    name: from?.name ?? defaults.name,
    goal: from ? from.goal ?? "" : defaults.goal ?? "",
    startsOn: from ? from.startsOn ?? "" : defaults.startsOn ?? "",
    endsOn: from ? from.endsOn ?? "" : defaults.endsOn ?? "",
  });
  const [values, setValues] = useState(() => initial(sprint));
  const [nameError, setNameError] = useState<string | null>(null);
  const [datesError, setDatesError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const editing = sprint !== null;
  const title = editing ? `Edit ${sprint.name}` : "Create sprint";

  const update = (patch: Partial<typeof values>) => {
    setValues((current) => ({ ...current, ...patch }));
    setFormError(null);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const name = values.name.trim();
    const goal = values.goal.trim();
    const nameProblem = name === "" ? "Give the sprint a name." : name.length > SPRINT_NAME_MAX ? `Keep the name under ${SPRINT_NAME_MAX} characters.` : null;
    const dateProblem = datesProblem(values.startsOn, values.endsOn, false);
    setNameError(nameProblem);
    setDatesError(dateProblem);
    if (nameProblem || dateProblem || goal.length > SPRINT_GOAL_MAX) return;

    const fields: SprintFields = { name, goal: goal || null, startsOn: values.startsOn || null, endsOn: values.endsOn || null };
    let patch: Partial<SprintFields> = fields;
    if (base) {
      patch = {};
      if (fields.name !== base.name) patch.name = fields.name;
      if (fields.goal !== base.goal) patch.goal = fields.goal;
      if (fields.startsOn !== base.startsOn) patch.startsOn = fields.startsOn;
      if (fields.endsOn !== base.endsOn) patch.endsOn = fields.endsOn;
      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }
    }
    setSaving(true);
    try {
      onSaved(base ? await updateSprint(base, patch) : await createSprint(projectId, fields));
    } catch (error) {
      setSaving(false);
      const current = staleSprint(error);
      if (current) {
        setBase(current);
        setValues(initial(current));
        setConflict(true);
        return;
      }
      setFormError(messageOf(error));
    }
  };

  return (
    <Modal busy={saving} onClose={onClose} title={title}>
      <form className="wsSettingsForm" noValidate onSubmit={onSubmit}>
        {conflict && <p className="wsConflict" role="alert">{SPRINT_UPDATED}</p>}
        <div className="wsField">
          <label htmlFor={`${id}-name`}>Sprint name</label>
          <input
            aria-describedby={nameError ? `${id}-name-error` : undefined}
            aria-invalid={nameError ? true : undefined}
            autoComplete="off"
            data-autofocus
            id={`${id}-name`}
            maxLength={SPRINT_NAME_MAX}
            onChange={(event) => { update({ name: event.target.value }); setNameError(null); }}
            value={values.name}
          />
          {nameError && <p className="wsFieldError" id={`${id}-name-error`}>{nameError}</p>}
        </div>
        <div className="wsField">
          <label htmlFor={`${id}-goal`}>Sprint goal</label>
          <textarea
            className="wsProjectTextarea"
            id={`${id}-goal`}
            maxLength={SPRINT_GOAL_MAX}
            onChange={(event) => update({ goal: event.target.value })}
            placeholder="What should this sprint achieve? Optional."
            rows={2}
            value={values.goal}
          />
        </div>
        <DateFields
          endsOn={values.endsOn}
          error={datesError}
          onEnd={(endsOn) => { update({ endsOn }); setDatesError(null); }}
          onStart={(startsOn) => { update({ startsOn }); setDatesError(null); }}
          startsOn={values.startsOn}
        />
        {formError && <p className="wsAlert" role="alert">{formError}</p>}
        <div className="wsModalActions">
          <button className="sparkSecondary" disabled={saving} onClick={onClose} type="button">Cancel</button>
          <button className="sparkPrimary" disabled={saving} type="submit">{saving ? "Saving…" : editing ? "Save sprint" : "Create sprint"}</button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Starts a planned sprint. Dates come from the sprint, else today and today + the project's sprint length;
 * changed dates are saved first (If-Match), then the start command runs with the sprint's new version.
 */
export function StartSprintDialog({ sprint, lengthDays, today, commitment, onClose, onStarted, onStale }: {
  sprint: Sprint;
  lengthDays: number;
  today: string;
  /** The sprint's tasks now: the commitment the start snapshots. */
  commitment: { count: number; points: number };
  onClose(): void;
  onStarted(sprint: Sprint): void;
  /** A teammate changed the sprint (seen on 412); the page refreshes its copy. */
  onStale(): void;
}) {
  const [current, setCurrent] = useState(sprint);
  const initialStart = sprint.startsOn ?? today;
  const [startsOn, setStartsOn] = useState(initialStart);
  const [endsOn, setEndsOn] = useState(sprint.endsOn ?? addDays(initialStart, lengthDays));
  // The end follows the start by the sprint length until someone picks an end date.
  const [endTouched, setEndTouched] = useState(Boolean(sprint.endsOn));
  const [datesError, setDatesError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const problem = datesProblem(startsOn, endsOn, true);
    setDatesError(problem);
    if (problem) return;
    setSaving(true);
    setFormError(null);
    let target = current;
    try {
      if (startsOn !== target.startsOn || endsOn !== target.endsOn) {
        target = await updateSprint(target, { startsOn, endsOn });
        setCurrent(target);
      }
      onStarted(await startSprint(target));
    } catch (error) {
      setSaving(false);
      const newer = staleSprint(error);
      if (newer) {
        setCurrent(newer);
        if (newer.startsOn && newer.endsOn) {
          setStartsOn(newer.startsOn);
          setEndsOn(newer.endsOn);
        }
        setConflict(true);
        onStale();
        return;
      }
      setConflict(false);
      setFormError(messageOf(error));
    }
  };

  return (
    <Modal
      busy={saving}
      description={<p>{taskCountLabel(commitment.count)} · {pointsLabel(commitment.points)} will be committed.</p>}
      onClose={onClose}
      title={`Start ${sprint.name}`}
    >
      <form className="wsSettingsForm" noValidate onSubmit={onSubmit}>
        {conflict && <p className="wsConflict" role="alert">{SPRINT_UPDATED}</p>}
        {current.goal && <p className="wsBacklogDialogGoal"><span>Goal</span>{current.goal}</p>}
        <DateFields
          endsOn={endsOn}
          error={datesError}
          onEnd={(value) => { setEndsOn(value); setEndTouched(true); setDatesError(null); }}
          onStart={(value) => {
            setStartsOn(value);
            if (!endTouched && value) setEndsOn(addDays(value, lengthDays));
            setDatesError(null);
          }}
          startsOn={startsOn}
        />
        {formError && <p className="wsAlert" role="alert">{formError}</p>}
        <div className="wsModalActions">
          <button className="sparkSecondary" disabled={saving} onClick={onClose} type="button">Cancel</button>
          <button className="sparkPrimary" data-autofocus disabled={saving} type="submit">{saving ? "Starting…" : "Start sprint"}</button>
        </div>
      </form>
    </Modal>
  );
}

const BACKLOG_CHOICE = "";

/** Completes the active sprint; unfinished work moves to a planned sprint (the next one by default) or the backlog. */
export function CompleteSprintDialog({ sprint, planned, doneCount, totalCount, onClose, onCompleted, onStale }: {
  sprint: Sprint;
  /** Planned sprints in plan order; the first is "next". */
  planned: readonly Sprint[];
  doneCount: number;
  totalCount: number;
  onClose(): void;
  /** `targetName` is where unfinished work went: a sprint's name, or null for the backlog. */
  onCompleted(result: CompletedSprint, targetName: string | null): void;
  onStale(): void;
}) {
  const id = useId();
  const [current, setCurrent] = useState(sprint);
  const [choice, setChoice] = useState(planned[0]?.id ?? BACKLOG_CHOICE);
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const unfinished = totalCount - doneCount;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setFormError(null);
    const carryTo = choice === BACKLOG_CHOICE ? null : choice;
    try {
      const result = await completeSprint(current, carryTo);
      onCompleted(result, planned.find((item) => item.id === carryTo)?.name ?? null);
    } catch (error) {
      setSaving(false);
      const newer = staleSprint(error);
      if (newer) {
        setCurrent(newer);
        setConflict(true);
        onStale();
        return;
      }
      setConflict(false);
      setFormError(messageOf(error));
    }
  };

  const options = [...planned.map((item, index) => ({ value: item.id, label: index === 0 ? `${item.name} (next)` : item.name })), { value: BACKLOG_CHOICE, label: "Backlog" }];

  return (
    <Modal
      busy={saving}
      description={<p>{doneCount} of {taskCountLabel(totalCount)} done · {unfinished === 0 ? "nothing unfinished" : `${unfinished} unfinished ${unfinished === 1 ? "task" : "tasks"}`}</p>}
      onClose={onClose}
      title={`Complete ${sprint.name}`}
    >
      <form className="wsSettingsForm" noValidate onSubmit={onSubmit}>
        {conflict && <p className="wsConflict" role="alert">{SPRINT_UPDATED}</p>}
        {current.endsOn && <p className="wsFieldHint">Planned to end {formatDay(current.endsOn)}. Completed totals are frozen when you confirm.</p>}
        <div aria-labelledby={`${id}-carry`} className="wsBacklogChoices" role="radiogroup">
          <p className="wsBacklogChoicesTitle" id={`${id}-carry`}>Move unfinished work to</p>
          {options.map((option) => (
            <label className="wsBacklogChoice" key={option.value || "backlog"}>
              <input checked={choice === option.value} disabled={saving} name={`${id}-carry`} onChange={() => setChoice(option.value)} type="radio" value={option.value} />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
        {formError && <p className="wsAlert" role="alert">{formError}</p>}
        <div className="wsModalActions">
          <button className="sparkSecondary" disabled={saving} onClick={onClose} type="button">Cancel</button>
          <button className="sparkPrimary" data-autofocus disabled={saving} type="submit">{saving ? "Completing…" : "Complete sprint"}</button>
        </div>
      </form>
    </Modal>
  );
}
