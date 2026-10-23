"use client";

import { useId, useState, type FormEvent } from "react";

import { Modal } from "../../../_components/modal";
import { ApiError, messageOf } from "../../../_lib/api";
import { PhaseRowsEditor, type PhaseEditorRow } from "../../../_components/phase-rows-editor";
import { appendedDates, PHASES_MAX, PHASES_RULE, phasesValid, type PhaseDraft } from "../../../_lib/phases";
import {
  BASELINE_REASON_MAX,
  createMilestone,
  MILESTONE_NAME_MAX,
  rebaselinePlan,
  savePhasePlan,
  updateMilestone,
  type MilestonePatch,
  type PlanMilestone,
  type ProjectPlan,
} from "../../../_lib/planning";
import { formatDay } from "../../../_lib/projects";
import { TEAMMATE_UPDATE } from "./settings-form";

export const PHASE_IN_USE = "A phase you removed still has tasks or milestones. Move them to another phase first, or keep the phase.";
const PROJECT_DATES_MISSING = "Set the project's start and target dates in Settings before planning phases.";
export const MILESTONE_UPDATED = "Updated by a teammate — review the milestone and save again.";
export const PLAN_REFRESHED = "Updated by a teammate — the plan was refreshed. Review it and confirm again.";
const PHASE_GONE = "That phase is no longer in the plan. Pick another one.";

/** The newer representation a 412 carries, if any. */
function staleCurrent<T>(error: unknown): T | null {
  return error instanceof ApiError && error.status === 412 ? (error.body as { current?: T } | null)?.current ?? null : null;
}

const inputError = (error: unknown, message: string) => error instanceof ApiError && error.status === 400 && error.message === message;

interface PhaseRow extends PhaseEditorRow {
  /** The saved phase the row edits (absent for a new one). */
  id?: string;
}

const rowsOf = (plan: ProjectPlan): PhaseRow[] =>
  plan.phases.map((phase, index) => ({ key: index, id: phase.id, name: phase.name, plannedStart: phase.plannedStart, plannedEnd: phase.plannedEnd }));

/**
 * Edits the Waterfall phase plan with the M2 phase rules: rename, re-date, add and remove phases. Saved phases
 * keep their baseline; added ones have none until the next re-baseline. The save carries the plan's If-Match.
 */
export function PhasePlanDialog({ projectId, plan, startDate, targetDate, onClose, onSaved, onStale }: {
  projectId: string;
  plan: ProjectPlan;
  startDate: string;
  targetDate: string;
  onClose(): void;
  onSaved(plan: ProjectPlan): void;
  /** A teammate's newer plan seen on 412; the dialog shows it for review. */
  onStale(plan: ProjectPlan): void;
}) {
  const [base, setBase] = useState(plan);
  const [rows, setRows] = useState<PhaseRow[]>(() => rowsOf(plan));
  const [nextKey, setNextKey] = useState(plan.phases.length);
  const [phasesError, setPhasesError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const datesSet = Boolean(startDate && targetDate);

  const clearErrors = () => {
    setPhasesError(null);
    setFormError(null);
  };

  const updateRow = (key: number, patch: Partial<PhaseDraft>) => {
    clearErrors();
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const addRow = () => {
    if (rows.length >= PHASES_MAX) return;
    clearErrors();
    setRows([...rows, { key: nextKey, name: `Phase ${rows.length + 1}`, ...appendedDates(rows, startDate, targetDate) }]);
    setNextKey((value) => value + 1);
  };

  const removeRow = (key: number) => {
    if (rows.length <= 1) return;
    clearErrors();
    setRows(rows.filter((row) => row.key !== key));
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    if (!datesSet) {
      setPhasesError(PROJECT_DATES_MISSING);
      return;
    }
    if (!phasesValid(rows, startDate, targetDate)) {
      setPhasesError(PHASES_RULE);
      return;
    }
    clearErrors();
    setSaving(true);
    try {
      const entries = rows.map((row) => ({ ...(row.id ? { id: row.id } : {}), name: row.name.trim(), plannedStart: row.plannedStart, plannedEnd: row.plannedEnd }));
      onSaved(await savePhasePlan(projectId, base.version, entries));
    } catch (error) {
      setSaving(false);
      const current = staleCurrent<ProjectPlan>(error);
      if (current) {
        setBase(current);
        setRows(rowsOf(current));
        setNextKey(current.phases.length);
        setConflict(true);
        onStale(current);
        return;
      }
      setConflict(false);
      if (inputError(error, "Invalid project phases.")) setPhasesError(PHASES_RULE);
      else if (inputError(error, "Invalid phase.")) setPhasesError(PHASE_IN_USE);
      else if (inputError(error, "Invalid project dates.")) setPhasesError(PROJECT_DATES_MISSING);
      else setFormError(messageOf(error));
    }
  };

  return (
    <Modal busy={saving} onClose={onClose} title="Edit phases">
      <form className="wsSettingsForm" noValidate onSubmit={onSubmit}>
        {conflict && <p className="wsConflict" role="alert">{TEAMMATE_UPDATE}</p>}
        <PhaseRowsEditor
          autoFocusFirst
          error={phasesError}
          hint={`Between ${formatDay(startDate || null)} and ${formatDay(targetDate || null)}, in order and without overlapping — up to ${PHASES_MAX} phases. New phases have no baseline until the next re-baseline.`}
          idPrefix="plan-phases"
          onAdd={addRow}
          onChange={updateRow}
          onRemove={removeRow}
          rows={rows}
          startDate={startDate}
          targetDate={targetDate}
        />
        {formError && <p className="wsAlert" role="alert">{formError}</p>}
        <div className="wsModalActions">
          <button className="sparkSecondary" disabled={saving} onClick={onClose} type="button">Cancel</button>
          <button className="sparkPrimary" disabled={saving} type="submit">{saving ? "Saving…" : "Save phases"}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Adds a milestone (`milestone` null) or edits one: name, due date inside the project dates, optional phase. */
export function MilestoneDialog({ projectId, milestone, phases, startDate, targetDate, onClose, onSaved, onStale }: {
  projectId: string;
  milestone: PlanMilestone | null;
  phases: ProjectPlan["phases"];
  startDate: string;
  targetDate: string;
  onClose(): void;
  onSaved(milestone: PlanMilestone): void;
  /** A teammate's newer milestone seen on 412; the dialog shows it for review. */
  onStale(milestone: PlanMilestone): void;
}) {
  const id = useId();
  const [base, setBase] = useState(milestone);
  const initial = (from: PlanMilestone | null) => ({ name: from?.name ?? "", dueDate: from?.dueDate ?? "", phaseId: from?.phaseId ?? "" });
  const [values, setValues] = useState(() => initial(milestone));
  const [nameError, setNameError] = useState<string | null>(null);
  const [dueError, setDueError] = useState<string | null>(null);
  const [phaseError, setPhaseError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const rangeRule = startDate && targetDate ? `Pick a due date between ${formatDay(startDate)} and ${formatDay(targetDate)}.` : "Pick a due date inside the project dates.";
  // A milestone kept from another methodology period may sit outside the dates and stays listed with its phase.
  const phaseMissing = values.phaseId !== "" && !phases.some((phase) => phase.id === values.phaseId);

  const update = (patch: Partial<typeof values>) => {
    setValues((current) => ({ ...current, ...patch }));
    setFormError(null);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const name = values.name.trim();
    const nameProblem = name === "" ? "Give the milestone a name." : name.length > MILESTONE_NAME_MAX ? `Use at most ${MILESTONE_NAME_MAX} characters.` : null;
    const dueChanged = !base || values.dueDate !== base.dueDate;
    let dueProblem: string | null = null;
    if (!values.dueDate) dueProblem = "Pick a due date.";
    else if (dueChanged && ((startDate && values.dueDate < startDate) || (targetDate && values.dueDate > targetDate))) dueProblem = rangeRule;
    setNameError(nameProblem);
    setDueError(dueProblem);
    setPhaseError(null);
    if (nameProblem || dueProblem) return;

    const fields = { name, dueDate: values.dueDate, phaseId: values.phaseId || null };
    const patch: MilestonePatch = {};
    if (base) {
      if (fields.name !== base.name) patch.name = fields.name;
      if (fields.dueDate !== base.dueDate) patch.dueDate = fields.dueDate;
      if (fields.phaseId !== base.phaseId) patch.phaseId = fields.phaseId;
      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }
    }
    setSaving(true);
    try {
      onSaved(base ? await updateMilestone(base, patch) : await createMilestone(projectId, fields));
    } catch (error) {
      setSaving(false);
      const current = staleCurrent<PlanMilestone>(error);
      if (current) {
        setBase(current);
        setValues(initial(current));
        setNameError(null);
        setDueError(null);
        setConflict(true);
        onStale(current);
        return;
      }
      setConflict(false);
      if (inputError(error, "Invalid milestone.")) setDueError(rangeRule);
      else if (inputError(error, "Invalid phase.")) setPhaseError(PHASE_GONE);
      else setFormError(messageOf(error));
    }
  };

  return (
    <Modal busy={saving} onClose={onClose} title={milestone ? `Edit ${milestone.name}` : "Add milestone"}>
      <form className="wsSettingsForm" noValidate onSubmit={onSubmit}>
        {conflict && <p className="wsConflict" role="alert">{MILESTONE_UPDATED}</p>}
        <div className="wsField">
          <label htmlFor={`${id}-name`}>Milestone name</label>
          <input
            aria-describedby={nameError ? `${id}-name-error` : undefined}
            aria-invalid={nameError ? true : undefined}
            autoComplete="off"
            data-autofocus
            id={`${id}-name`}
            maxLength={MILESTONE_NAME_MAX}
            onChange={(event) => { update({ name: event.target.value }); setNameError(null); }}
            value={values.name}
          />
          {nameError && <p className="wsFieldError" id={`${id}-name-error`} role="alert">{nameError}</p>}
        </div>
        <div className="wsField">
          <label htmlFor={`${id}-due`}>Due date</label>
          <input
            aria-describedby={dueError ? `${id}-due-error` : `${id}-due-hint`}
            aria-invalid={dueError ? true : undefined}
            id={`${id}-due`}
            max={targetDate || undefined}
            min={startDate || undefined}
            onChange={(event) => { update({ dueDate: event.target.value }); setDueError(null); }}
            type="date"
            value={values.dueDate}
          />
          {dueError
            ? <p className="wsFieldError" id={`${id}-due-error`} role="alert">{dueError}</p>
            : <p className="wsFieldHint" id={`${id}-due-hint`}>{startDate && targetDate ? `Inside the project dates, ${formatDay(startDate)} – ${formatDay(targetDate)}.` : "Any day while the project has no start and target dates."}</p>}
        </div>
        <div className="wsField">
          <label htmlFor={`${id}-phase`}>Phase</label>
          <select
            aria-describedby={phaseError ? `${id}-phase-error` : undefined}
            aria-invalid={phaseError ? true : undefined}
            className="wsSelect"
            id={`${id}-phase`}
            onChange={(event) => { update({ phaseId: event.target.value }); setPhaseError(null); }}
            value={values.phaseId}
          >
            <option value="">No phase</option>
            {phaseMissing && <option value={values.phaseId}>Earlier phase</option>}
            {phases.map((phase) => <option key={phase.id} value={phase.id}>{phase.name}</option>)}
          </select>
          {phaseError && <p className="wsFieldError" id={`${id}-phase-error`} role="alert">{phaseError}</p>}
        </div>
        {formError && <p className="wsAlert" role="alert">{formError}</p>}
        <div className="wsModalActions">
          <button className="sparkSecondary" disabled={saving} onClick={onClose} type="button">Cancel</button>
          <button className="sparkPrimary" disabled={saving} type="submit">{saving ? "Saving…" : milestone ? "Save milestone" : "Add milestone"}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Confirms a re-baseline: a reason (1–200 characters) is required and recorded in the audit log. */
export function RebaselineDialog({ projectId, plan, onClose, onSaved, onStale }: {
  projectId: string;
  plan: ProjectPlan;
  onClose(): void;
  onSaved(plan: ProjectPlan): void;
  onStale(plan: ProjectPlan): void;
}) {
  const id = useId();
  const [version, setVersion] = useState(plan.version);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const phaseCount = plan.phases.length;
  const milestoneCount = plan.milestones.length;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const trimmed = reason.trim();
    const problem = trimmed === "" ? "Give a reason for the new baseline." : trimmed.length > BASELINE_REASON_MAX ? `Use at most ${BASELINE_REASON_MAX} characters.` : null;
    setReasonError(problem);
    setFormError(null);
    if (problem) return;
    setSaving(true);
    try {
      onSaved(await rebaselinePlan(projectId, version, trimmed));
    } catch (error) {
      setSaving(false);
      const current = staleCurrent<ProjectPlan>(error);
      if (current) {
        setVersion(current.version);
        setConflict(true);
        onStale(current);
        return;
      }
      setConflict(false);
      if (inputError(error, "Invalid baseline reason.")) setReasonError("Give a reason of 1 to 200 characters.");
      else setFormError(messageOf(error));
    }
  };

  return (
    <Modal
      busy={saving}
      description={`The planned dates of ${phaseCount} ${phaseCount === 1 ? "phase" : "phases"} and ${milestoneCount} ${milestoneCount === 1 ? "milestone" : "milestones"} become the new baseline, and variance starts again from there. The current baseline isn't kept.`}
      onClose={onClose}
      title="Re-baseline the plan?"
    >
      <form className="wsSettingsForm" noValidate onSubmit={onSubmit}>
        {conflict && <p className="wsConflict" role="alert">{PLAN_REFRESHED}</p>}
        <div className="wsField">
          <label htmlFor={`${id}-reason`}>Reason</label>
          <textarea
            aria-describedby={reasonError ? `${id}-reason-error` : `${id}-reason-hint`}
            aria-invalid={reasonError ? true : undefined}
            className="wsProjectTextarea"
            data-autofocus
            id={`${id}-reason`}
            maxLength={BASELINE_REASON_MAX}
            onChange={(event) => { setReason(event.target.value); setReasonError(null); setFormError(null); }}
            placeholder="For example: scope change approved on Nov 20"
            rows={3}
            value={reason}
          />
          {reasonError
            ? <p className="wsFieldError" id={`${id}-reason-error`} role="alert">{reasonError}</p>
            : <p className="wsFieldHint" id={`${id}-reason-hint`}>Required. Recorded in the workspace audit log.</p>}
        </div>
        {formError && <p className="wsAlert" role="alert">{formError}</p>}
        <div className="wsModalActions">
          <button className="sparkSecondary" disabled={saving} onClick={onClose} type="button">Cancel</button>
          <button className="sparkPrimary" disabled={saving} type="submit">{saving ? "Re-baselining…" : "Re-baseline"}</button>
        </div>
      </form>
    </Modal>
  );
}
