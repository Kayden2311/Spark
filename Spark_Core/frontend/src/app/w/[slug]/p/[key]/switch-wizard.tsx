"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

import { MethodologyPicker } from "../../../_components/methodology-picker";
import { Modal } from "../../../_components/modal";
import { PhaseRowsEditor } from "../../../_components/phase-rows-editor";
import { ApiError, messageOf } from "../../../_lib/api";
import { METHODOLOGY_ACCENTS, useMethodologies, type MethodologyId, type MethodologyTemplate, type StatusCategory } from "../../../_lib/methodologies";
import type { IssueCard } from "../../../_lib/issues";
import { appendedDates, PHASES_MAX, PHASES_RULE, phasesValid, respreadPhases } from "../../../_lib/phases";
import {
  cardCountLabel,
  categoryLabel,
  COLUMN_NAME_MAX,
  COLUMNS_MAX,
  COLUMNS_MIN,
  columnNameProblem,
  DEFAULT_SPRINT_DAYS,
  parseWipLimit,
  sprintsPath,
  SWITCH_REASON_MAX,
  switchMethodology,
  WIP_LIMIT_MAX,
  WIP_RULE,
  wipBelowOccupancyMessage,
  type Sprint,
  type SwitchResult,
} from "../../../_lib/planning";
import { methodologyName, methodologyOf, type ProjectDetail, type ProjectStatus } from "../../../_lib/projects";
import { buildSwitchRequest, columnOccupancy, keptIds as keptIdsOf, plannedSprintNote, proposeColumns, reconcileColumns, type ColumnPlan, type TargetColumn } from "../../../_lib/switch";
import { useWorkspaceData } from "../../../_lib/use-workspace-data";
import { PHASE_IN_USE } from "./phase-plan-dialog";
import { TEAMMATE_UPDATE } from "./settings-form";

const STEPS = ["Choose a methodology", "Map columns", "Plan", "Confirm"] as const;
const CATEGORIES: StatusCategory[] = ["backlog", "todo", "in_progress", "done"];
const SPRINT_WEEKS = [1, 2, 3, 4] as const;
const DATES_REVERSED = "The target date can't be before the start date.";
const REASON_REQUIRED = "Say why the project is switching.";
const HEADING_ID = "switch-step-title";

/** A 400 from the API for one whitelisted input error. */
const inputError = (error: unknown, message: string) => error instanceof ApiError && error.status === 400 && error.message === message;

interface WizardPhase {
  key: number;
  /** An existing phase from an earlier Waterfall period keeps its id (and baseline). */
  id?: string;
  name: string;
  plannedStart: string;
  plannedEnd: string;
}

interface PhaseState {
  rows: WizardPhase[];
  /** Once dates are set by hand, date and row changes stop re-spreading. */
  edited: boolean;
}

const byPosition = (statuses: readonly ProjectStatus[]) => [...statuses].sort((a, b) => a.position - b.position);

function initialPhases(project: ProjectDetail, template: MethodologyTemplate | undefined): PhaseState {
  if (project.phases.length > 0) {
    const rows = [...project.phases].sort((a, b) => a.position - b.position).map((phase, index) => ({ key: index, id: phase.id, name: phase.name, plannedStart: phase.plannedStart, plannedEnd: phase.plannedEnd }));
    return { rows, edited: true };
  }
  const names = template?.defaults.phaseNames.length ? template.defaults.phaseNames : ["Phase 1"];
  const rows = names.map((name, index) => ({ key: index, name, plannedStart: "", plannedEnd: "" }));
  return { rows: respreadPhases(rows, project.startDate ?? "", project.targetDate ?? ""), edited: false };
}

/**
 * Switches a project's methodology in four steps: pick the target, map the columns (with card counts from the
 * loaded board and the proposed WIP limits checked against them), resolve planning (sprint length, an active
 * sprint, Waterfall dates and phases) and confirm with a reason. One POST does the whole switch.
 */
export function SwitchWizard({ project, etag, counts, cards, backlogHref, onClose, onSwitched, onStale, onWipRefused }: {
  project: ProjectDetail;
  etag: string;
  /** Cards per current column, or null while the board loads (the server still checks WIP limits). */
  counts: ReadonlyMap<string, number> | null;
  /** The loaded board's cards (for the planned sprints a switch away from Scrum empties), or null while it loads. */
  cards: ReadonlyArray<IssueCard> | null;
  backlogHref: string;
  onClose(): void;
  onSwitched(result: SwitchResult): void;
  onStale(project: ProjectDetail): void;
  /** The server found a column over its limit: card counts are stale. */
  onWipRefused(): void;
}) {
  const catalog = useMethodologies();
  const from = methodologyOf(project.methodology);
  const sprints = useWorkspaceData<{ items: Sprint[] }>(from === "scrum" ? sprintsPath(project.id) : null);
  const statuses = byPosition(project.statuses);

  const [step, setStep] = useState(0);
  const [target, setTarget] = useState<MethodologyId | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<(ColumnPlan & { for: MethodologyId }) | null>(null);
  const [columnErrors, setColumnErrors] = useState<Record<number, string>>({});
  const [mappingErrors, setMappingErrors] = useState<Record<string, string>>({});
  const [boardError, setBoardError] = useState<string | null>(null);
  const [sprintDays, setSprintDays] = useState(project.sprintLengthDays ?? DEFAULT_SPRINT_DAYS);
  const [startDate, setStartDate] = useState(project.startDate ?? "");
  const [targetDate, setTargetDate] = useState(project.targetDate ?? "");
  const [phases, setPhases] = useState<PhaseState | null>(null);
  const [dateErrors, setDateErrors] = useState<{ start: string | null; target: string | null }>({ start: null, target: null });
  const [phasesError, setPhasesError] = useState<string | null>(null);
  const [sprintBlockedByServer, setSprintBlockedByServer] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const heading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    // Each step starts at its heading, so keyboard and screen reader users land on the new content.
    if (mounted.current) heading.current?.focus();
    mounted.current = true;
  }, [step]);

  const templates = catalog.data ?? [];
  const template = templates.find((item) => item.id === target);
  const plan: ColumnPlan = proposal ?? { columns: [], mapping: {} };
  const kept = keptIdsOf(plan);
  const totals = counts ? columnOccupancy(plan, counts) : null;
  const activeSprint = from === "scrum" ? sprints.data?.items.find((sprint) => sprint.status === "active") ?? null : null;
  const sprintsChecking = from === "scrum" && !sprints.data && !sprints.error;
  const sprintBlocked = from === "scrum" && (Boolean(activeSprint) || sprintBlockedByServer);
  const sprintNote = from === "scrum" ? plannedSprintNote(sprints.data?.items ?? null, cards, statuses) : null;
  const phaseRows = phases?.rows ?? [];
  const targetName = target ? methodologyName(target) : "";

  /** Moving forward means the user has reviewed the teammate's changes. */
  const goTo = (index: number) => {
    if (index > step) setConflict(false);
    setSubmitError(null);
    setStep(index);
  };

  const changePlan = (change: (current: ColumnPlan) => ColumnPlan) => {
    setProposal((current) => (current ? { ...change(current), for: current.for } : current));
    setBoardError(null);
  };

  // ---------- Step transitions ----------

  const leavePick = () => {
    if (!target || !template) {
      setPickError("Pick a methodology.");
      return;
    }
    if (target === from) {
      setPickError(`${project.name} already uses ${methodologyName(from)}. Pick another way of working.`);
      return;
    }
    if (proposal?.for !== target) {
      setProposal({ ...proposeColumns(statuses, template), for: target });
      setColumnErrors({});
      setMappingErrors({});
      setBoardError(null);
    }
    if (target === "waterfall" && phases === null) setPhases(initialPhases(project, template));
    goTo(1);
  };

  const leaveColumns = () => {
    const errors: Record<number, string> = {};
    const seen = new Set<string>();
    for (const column of plan.columns) {
      const problem = columnNameProblem(column.name);
      const name = column.name.trim().toLowerCase();
      const wip = parseWipLimit(column.wip);
      const cards = totals?.get(column.key) ?? 0;
      if (problem) errors[column.key] = problem;
      else if (seen.has(name)) errors[column.key] = "Another column already has this name.";
      else if (wip === undefined) errors[column.key] = WIP_RULE;
      else if (totals && wip !== null && cards > wip) errors[column.key] = wipBelowOccupancyMessage(cards);
      seen.add(name);
    }
    const missing: Record<string, string> = {};
    for (const status of statuses) {
      if (!kept.has(status.id) && (plan.mapping[status.id] ?? null) === null) missing[status.id] = `Choose where the cards in ${status.name} go.`;
    }
    const countProblem = plan.columns.length < COLUMNS_MIN || plan.columns.length > COLUMNS_MAX ? `A board needs ${COLUMNS_MIN} to ${COLUMNS_MAX} columns.` : null;
    setColumnErrors(errors);
    setMappingErrors(missing);
    setBoardError(countProblem);
    if (countProblem || Object.keys(errors).length > 0 || Object.keys(missing).length > 0) return;
    goTo(2);
  };

  const leavePlanning = () => {
    if (sprintBlocked || sprintsChecking) return;
    if (target === "waterfall") {
      const start = startDate ? null : "Pick a start date.";
      const end = targetDate ? (startDate && targetDate < startDate ? DATES_REVERSED : null) : "Pick a target date.";
      const phaseProblem = !start && !end && !phasesValid(phaseRows, startDate, targetDate) ? PHASES_RULE : null;
      setDateErrors({ start, target: end });
      setPhasesError(phaseProblem);
      if (start || end || phaseProblem) return;
    }
    goTo(3);
  };

  const submit = async () => {
    if (submitting || !target) return;
    if (!reason.trim()) {
      setReasonError(REASON_REQUIRED);
      return;
    }
    const body = buildSwitchRequest(target, plan, { sprintLengthDays: sprintDays, startDate, targetDate, phases: phaseRows }, reason);
    setSubmitting(true);
    setSubmitError(null);
    try {
      onSwitched(await switchMethodology(project.id, etag, body));
    } catch (error) {
      setSubmitting(false);
      const code = error instanceof ApiError ? error.code : null;
      const current = error instanceof ApiError && error.status === 412 ? (error.body as { current?: ProjectDetail } | null)?.current : undefined;
      if (current) {
        // The user's column plan is kept and re-applied to the teammate's columns, for review.
        onStale(current);
        setProposal({ ...reconcileColumns(plan, byPosition(current.statuses)), for: target });
        setColumnErrors({});
        setMappingErrors({});
        setConflict(true);
        goTo(1);
      } else if (code === "active_sprint") {
        setSprintBlockedByServer(true);
        sprints.reload();
        goTo(2);
      } else if (code === "wip_below_occupancy") {
        onWipRefused();
        setBoardError(messageOf(error));
        goTo(1);
      } else if (target === "waterfall" && (inputError(error, "Invalid phase.") || inputError(error, "Invalid project phases."))) {
        // A removed phase still has tasks or milestones, or the plan breaks the phase rules: fix it on the Plan step.
        setPhasesError(inputError(error, "Invalid phase.") ? PHASE_IN_USE : PHASES_RULE);
        goTo(2);
      } else {
        setSubmitError(messageOf(error));
      }
    }
  };

  // ---------- Rendering ----------

  let body;
  let primary;
  if (step === 0) {
    body = <PickStep catalog={catalog} error={pickError} from={from} heading={heading} onPick={(id) => { setTarget(id); setPickError(null); }} projectName={project.name} target={target} />;
    primary = <button className="sparkPrimary" onClick={leavePick} type="button">Next</button>;
  } else if (step === 1) {
    body = (
      <ColumnsStep
        boardError={boardError}
        columnErrors={columnErrors}
        counts={counts}
        heading={heading}
        mappingErrors={mappingErrors}
        onChange={changePlan}
        onColumnEdited={(key) => setColumnErrors((current) => ({ ...current, [key]: "" }))}
        onMappingEdited={(statusId) => setMappingErrors((current) => ({ ...current, [statusId]: "" }))}
        plan={plan}
        statuses={statuses}
        target={target}
        totals={totals}
      />
    );
    primary = <button className="sparkPrimary" onClick={leaveColumns} type="button">Next</button>;
  } else if (step === 2) {
    body = (
      <PlanningStep
        activeSprint={activeSprint}
        backlogHref={backlogHref}
        blocked={sprintBlocked}
        checking={sprintsChecking}
        dateErrors={dateErrors}
        heading={heading}
        hadPhases={project.phases.length > 0}
        onDatesChange={(nextStart, nextTarget) => {
          setStartDate(nextStart);
          setTargetDate(nextTarget);
          setDateErrors({ start: null, target: null });
          setPhasesError(null);
          setPhases((current) => (current && !current.edited ? { ...current, rows: respreadPhases(current.rows, nextStart, nextTarget) } : current));
        }}
        onPhasesChange={(next) => { setPhasesError(null); setPhases(next); }}
        onSprintDays={setSprintDays}
        phases={phases}
        phasesError={phasesError}
        sprintDays={sprintDays}
        startDate={startDate}
        target={target}
        targetDate={targetDate}
      />
    );
    primary = <button className="sparkPrimary" disabled={sprintBlocked || sprintsChecking} onClick={leavePlanning} type="button">Next</button>;
  } else {
    body = (
      <ConfirmStep
        counts={counts}
        error={submitError}
        from={from}
        heading={heading}
        kept={kept}
        onReason={(value) => { setReason(value); setReasonError(null); }}
        plan={plan}
        reason={reason}
        reasonError={reasonError}
        sprintNote={sprintNote}
        statuses={statuses}
        targetName={targetName}
      />
    );
    primary = <button className="sparkPrimary" disabled={submitting} onClick={submit} type="button">{submitting ? "Switching…" : `Switch to ${targetName}`}</button>;
  }

  return (
    <Modal busy={submitting} onClose={onClose} title="Switch methodology" variant="wide">
      <div className="wsWizard" style={target ? ({ "--method-accent": METHODOLOGY_ACCENTS[target] } as CSSProperties) : undefined}>
        <ol aria-label="Switch steps" className="wsWizardSteps">
          {STEPS.map((label, index) => (
            <li aria-current={index === step ? "step" : undefined} data-done={index < step || undefined} key={label}>
              <span aria-hidden="true">{index + 1}</span>{label}
            </li>
          ))}
        </ol>
        {conflict && <p className="wsConflict" role="alert">{TEAMMATE_UPDATE}</p>}
        {body}
        <div className="wsModalActions">
          {step === 0
            ? <button className="sparkSecondary" onClick={onClose} type="button">Cancel</button>
            : <button className="sparkSecondary" disabled={submitting} onClick={() => goTo(step - 1)} type="button">Back</button>}
          {primary}
        </div>
      </div>
    </Modal>
  );
}

type Heading = RefObject<HTMLHeadingElement | null>;

function PickStep({ heading, projectName, from, target, catalog, error, onPick }: {
  heading: Heading;
  projectName: string;
  from: MethodologyId;
  target: MethodologyId | null;
  catalog: ReturnType<typeof useMethodologies>;
  error: string | null;
  onPick(id: MethodologyId): void;
}) {
  return (
    <>
      <h3 data-autofocus id={HEADING_ID} ref={heading} tabIndex={-1}>Which way of working should {projectName} use?</h3>
      <p className="wsWizardLead">
        You&apos;re on {methodologyName(from)}. Work, completed sprints and phases stay as history; only the board and planning change.
        {from === "scrum" && " Planned sprints are cancelled and their open cards return to the backlog."}
      </p>
      {catalog.error && !catalog.data && (
        <p className="wsAlert wsInlineAlert" role="alert">{catalog.error} <button className="textButton" onClick={catalog.reload} type="button">Try again</button></p>
      )}
      {!catalog.data && !catalog.error && <p className="wsProjectMuted" role="status">Loading ways of working…</p>}
      {catalog.data && <MethodologyPicker labelledBy={HEADING_ID} onChange={onPick} templates={catalog.data} value={target} />}
      {error && <p className="wsFieldError" role="alert">{error}</p>}
    </>
  );
}

function ColumnsStep({ heading, target, statuses, plan, counts, totals, columnErrors, mappingErrors, boardError, onChange, onColumnEdited, onMappingEdited }: {
  heading: Heading;
  target: MethodologyId | null;
  statuses: ProjectStatus[];
  plan: ColumnPlan;
  counts: ReadonlyMap<string, number> | null;
  totals: Map<number, number> | null;
  columnErrors: Record<number, string>;
  mappingErrors: Record<string, string>;
  boardError: string | null;
  onChange(change: (current: ColumnPlan) => ColumnPlan): void;
  onColumnEdited(key: number): void;
  onMappingEdited(statusId: string): void;
}) {
  const [nextKey, setNextKey] = useState(100);
  const kept = keptIdsOf(plan);
  const { columns, mapping } = plan;

  const updateColumn = (key: number, patch: Partial<TargetColumn>) => {
    onChange((current) => ({ ...current, columns: current.columns.map((column) => (column.key === key ? { ...column, ...patch } : column)) }));
    onColumnEdited(key);
  };

  /** A target column takes over a current column (`sourceId`) or becomes new; the column it gave up moves its cards here. */
  const changeSource = (key: number, sourceId: string | null) => {
    onChange((current) => {
      const column = current.columns.find((item) => item.key === key);
      if (!column) return current;
      const nextMapping = { ...current.mapping };
      if (column.sourceId) nextMapping[column.sourceId] = key;
      const source = sourceId ? statuses.find((status) => status.id === sourceId) : undefined;
      if (source) delete nextMapping[source.id];
      const category = (source?.category as StatusCategory | undefined) ?? column.category;
      return { mapping: nextMapping, columns: current.columns.map((item) => (item.key === key ? { ...item, sourceId: source?.id ?? null, category } : item)) };
    });
    onColumnEdited(key);
    if (sourceId) onMappingEdited(sourceId);
  };

  const addColumn = () => {
    if (columns.length >= COLUMNS_MAX) return;
    const key = Math.max(nextKey, ...columns.map((column) => column.key + 1));
    setNextKey(key + 1);
    onChange((current) => ({ ...current, columns: [...current.columns, { key, sourceId: null, name: "", category: "todo", wip: "" }] }));
  };

  const removeColumn = (key: number) => {
    if (columns.length <= COLUMNS_MIN) return;
    onChange((current) => {
      const column = current.columns.find((item) => item.key === key);
      const nextMapping = Object.fromEntries(Object.entries(current.mapping).map(([id, value]) => [id, value === key ? null : value]));
      if (column?.sourceId) nextMapping[column.sourceId] = null;
      return { mapping: nextMapping, columns: current.columns.filter((item) => item.key !== key) };
    });
  };

  const mapColumn = (statusId: string, key: number | null) => {
    onChange((current) => ({ ...current, mapping: { ...current.mapping, [statusId]: key } }));
    onMappingEdited(statusId);
  };

  return (
    <>
      <h3 id={HEADING_ID} ref={heading} tabIndex={-1}>Map your columns</h3>
      <p className="wsWizardLead">
        Spark proposes the {target ? methodologyName(target) : ""} columns. A column based on a current one keeps it and its cards; cards in every other current column move to the column you choose.
        {target === "kanban" && " Kanban's WIP limits are proposed — change them to fit your team."}
      </p>
      {boardError && <p className="wsAlert" role="alert">{boardError}</p>}
      <div className="wsWizardColumns">
        <section aria-labelledby="switch-new-title" className="wsWizardPanel">
          <h4 id="switch-new-title">New board</h4>
          <ol aria-label="New columns" className="wsWizardList">
            {columns.map((column, index) => {
              const number = index + 1;
              const source = column.sourceId ? statuses.find((status) => status.id === column.sourceId) : undefined;
              const cards = totals?.get(column.key) ?? null;
              const error = columnErrors[column.key];
              const errorId = `switch-column-${column.key}-error`;
              const options = statuses.filter((status) => status.id === column.sourceId || !kept.has(status.id));
              return (
                <li className="wsWizardColumn" key={column.key}>
                  <span aria-hidden="true" className="wsProjectPhaseNumber">{number}</span>
                  <input
                    aria-describedby={error ? errorId : undefined}
                    aria-invalid={error ? true : undefined}
                    aria-label={`New column ${number} name`}
                    autoComplete="off"
                    className="wsWizardName"
                    maxLength={COLUMN_NAME_MAX}
                    onChange={(event) => updateColumn(column.key, { name: event.target.value })}
                    placeholder="Column name"
                    value={column.name}
                  />
                  <select aria-label={`New column ${number} source`} className="wsSelect wsWizardSource" onChange={(event) => changeSource(column.key, event.target.value || null)} value={column.sourceId ?? ""}>
                    <option value="">New column</option>
                    {options.map((status) => <option key={status.id} value={status.id}>Keep {status.name}</option>)}
                  </select>
                  {source
                    ? <span className="wsPickerColumn wsWizardCategory" data-category={column.category} title="A kept column keeps its category. To change it, add a new column and move the cards there.">{categoryLabel(column.category)}</span>
                    : <select aria-label={`New column ${number} category`} className="wsSelect wsWizardCategory" onChange={(event) => updateColumn(column.key, { category: event.target.value as StatusCategory })} value={column.category}>
                        {CATEGORIES.map((category) => <option key={category} value={category}>{categoryLabel(category)}</option>)}
                      </select>}
                  <input
                    aria-describedby={error ? errorId : undefined}
                    aria-invalid={error ? true : undefined}
                    aria-label={`New column ${number} WIP limit`}
                    className="wsWizardWip"
                    inputMode="numeric"
                    max={WIP_LIMIT_MAX}
                    min={1}
                    onChange={(event) => updateColumn(column.key, { wip: event.target.value })}
                    placeholder="No limit"
                    type="number"
                    value={column.wip}
                  />
                  <span className="wsSettingsCards">{cards === null ? "Cards —" : cardCountLabel(cards)}</span>
                  <button aria-label={`Remove new column ${number}`} className="wsGhostButton danger wsWizardRemove" disabled={columns.length <= COLUMNS_MIN} onClick={() => removeColumn(column.key)} type="button">Remove</button>
                  {error && <p className="wsFieldError wsWizardRowError" id={errorId} role="alert">{error}</p>}
                </li>
              );
            })}
          </ol>
          <button className="sparkSecondary wsWizardAdd" disabled={columns.length >= COLUMNS_MAX} onClick={addColumn} type="button">Add column</button>
        </section>
        <section aria-labelledby="switch-current-title" className="wsWizardPanel">
          <h4 id="switch-current-title">Current columns</h4>
          <ul aria-label="Current columns" className="wsWizardList">
            {statuses.map((status) => {
              const keeper = columns.find((column) => column.sourceId === status.id);
              const error = mappingErrors[status.id];
              const errorId = `switch-map-${status.id}-error`;
              return (
                <li aria-label={status.name} className="wsWizardCurrent" key={status.id}>
                  <span className="wsWizardCurrentName">
                    <strong>{status.name}</strong>
                    <span className="wsSettingsCards">{counts ? cardCountLabel(counts.get(status.id) ?? 0) : "Cards —"}</span>
                  </span>
                  {keeper
                    ? <span className="wsWizardKept">Kept as {keeper.name.trim() || "an unnamed column"}</span>
                    : <select
                        aria-describedby={error ? errorId : undefined}
                        aria-invalid={error ? true : undefined}
                        aria-label={`Move cards from ${status.name}`}
                        className="wsSelect"
                        onChange={(event) => mapColumn(status.id, event.target.value === "" ? null : Number(event.target.value))}
                        value={mapping[status.id] ?? ""}
                      >
                        <option value="">Choose a column</option>
                        {columns.map((column, index) => <option key={column.key} value={column.key}>{column.name.trim() || `Column ${index + 1}`}</option>)}
                      </select>}
                  {error && <p className="wsFieldError wsWizardRowError" id={errorId} role="alert">{error}</p>}
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </>
  );
}

function PlanningStep({ heading, target, blocked, checking, activeSprint, backlogHref, sprintDays, onSprintDays, startDate, targetDate, dateErrors, onDatesChange, phases, phasesError, onPhasesChange, hadPhases }: {
  heading: Heading;
  target: MethodologyId | null;
  blocked: boolean;
  checking: boolean;
  activeSprint: Sprint | null;
  backlogHref: string;
  sprintDays: number;
  onSprintDays(days: number): void;
  startDate: string;
  targetDate: string;
  dateErrors: { start: string | null; target: string | null };
  onDatesChange(start: string, target: string): void;
  phases: PhaseState | null;
  phasesError: string | null;
  onPhasesChange(next: PhaseState): void;
  hadPhases: boolean;
}) {
  const [nextPhaseKey, setNextPhaseKey] = useState(100);
  const rows = phases?.rows ?? [];
  const edited = phases?.edited ?? false;
  const sprintOptions = SPRINT_WEEKS.map((weeks) => weeks * 7);
  if (!sprintOptions.includes(sprintDays)) sprintOptions.push(sprintDays);

  const updatePhase = (key: number, patch: Partial<WizardPhase>) => {
    const datesTouched = patch.plannedStart !== undefined || patch.plannedEnd !== undefined;
    onPhasesChange({ edited: edited || datesTouched, rows: rows.map((row) => (row.key === key ? { ...row, ...patch } : row)) });
  };
  const addPhase = () => {
    if (rows.length >= PHASES_MAX) return;
    const key = Math.max(nextPhaseKey, ...rows.map((row) => row.key + 1));
    setNextPhaseKey(key + 1);
    const added: WizardPhase = { key, name: `Phase ${rows.length + 1}`, plannedStart: "", plannedEnd: "" };
    onPhasesChange({ edited, rows: edited ? [...rows, { ...added, ...appendedDates(rows, startDate, targetDate) }] : respreadPhases([...rows, added], startDate, targetDate) });
  };
  const removePhase = (key: number) => {
    if (rows.length <= 1) return;
    const remaining = rows.filter((row) => row.key !== key);
    onPhasesChange({ edited, rows: edited ? remaining : respreadPhases(remaining, startDate, targetDate) });
  };

  let planning;
  if (blocked) {
    planning = (
      <div className="wsAlert wsWizardBlocked" role="alert">
        <p>
          <strong>{activeSprint ? `${activeSprint.name} is still active.` : "A sprint is still active."}</strong>{" "}
          Complete it before switching, so its unfinished work lands in the backlog. Completed sprints stay as history.
        </p>
        <Link className="sparkPrimary" href={backlogHref}>Complete sprint now</Link>
      </div>
    );
  } else if (checking) {
    planning = <p className="wsProjectMuted" role="status">Checking for an active sprint…</p>;
  } else if (target === "scrum") {
    planning = (
      <>
        <div className="wsField wsWizardNarrow">
          <label htmlFor="switch-sprint-length">Sprint length</label>
          <select className="wsSelect" id="switch-sprint-length" onChange={(event) => onSprintDays(Number(event.target.value))} value={sprintDays}>
            {sprintOptions.map((days) => <option key={days} value={days}>{days % 7 === 0 ? `${days / 7} ${days === 7 ? "week" : "weeks"}` : `${days} days`}</option>)}
          </select>
        </div>
        <p className="wsProjectMuted">Open tasks start in the backlog. Plan them into sprints from the Backlog tab.</p>
      </>
    );
  } else if (target === "waterfall") {
    planning = (
      <>
        <div className="wsProjectFormGrid">
          <div className="wsField">
            <label htmlFor="switch-start">Start date</label>
            <input aria-describedby={dateErrors.start ? "switch-start-error" : undefined} aria-invalid={dateErrors.start ? true : undefined} id="switch-start" onChange={(event) => onDatesChange(event.target.value, targetDate)} type="date" value={startDate} />
            {dateErrors.start && <p className="wsFieldError" id="switch-start-error" role="alert">{dateErrors.start}</p>}
          </div>
          <div className="wsField">
            <label htmlFor="switch-target">Target date</label>
            <input aria-describedby={dateErrors.target ? "switch-target-error" : undefined} aria-invalid={dateErrors.target ? true : undefined} id="switch-target" min={startDate || undefined} onChange={(event) => onDatesChange(startDate, event.target.value)} type="date" value={targetDate} />
            {dateErrors.target && <p className="wsFieldError" id="switch-target-error" role="alert">{dateErrors.target}</p>}
          </div>
        </div>
        <PhaseRowsEditor
          error={phasesError}
          extraActions={
            <button className="wsGhostButton" disabled={!startDate || !targetDate} onClick={() => onPhasesChange({ edited: false, rows: respreadPhases(rows, startDate, targetDate) })} type="button">
              Re-spread dates evenly
            </button>
          }
          hint={hadPhases
            ? "The phases from the last Waterfall period, with their baselines. Adjust them to the new dates."
            : `Spread evenly over the project dates. Rename them or adjust the dates — up to ${PHASES_MAX} phases.`}
          idPrefix="switch-phases"
          onAdd={addPhase}
          onChange={updatePhase}
          onRemove={removePhase}
          rows={rows}
          startDate={startDate}
          targetDate={targetDate}
        />
        <p className="wsProjectMuted">Tasks without a phase show as Unphased on the Timeline.</p>
      </>
    );
  } else {
    planning = <p className="wsProjectMuted">Kanban needs no planning step. The WIP limits from the previous step apply as soon as you switch.</p>;
  }
  return (
    <>
      <h3 id={HEADING_ID} ref={heading} tabIndex={-1}>Plan for {target ? methodologyName(target) : ""}</h3>
      {planning}
    </>
  );
}

function ConfirmStep({ heading, statuses, plan, kept, counts, from, targetName, sprintNote, reason, reasonError, error, onReason }: {
  heading: Heading;
  statuses: ProjectStatus[];
  plan: ColumnPlan;
  kept: Set<string>;
  counts: ReadonlyMap<string, number> | null;
  from: MethodologyId;
  targetName: string;
  /** Leaving Scrum: the planned sprints that are cancelled and the open cards that return to the backlog. */
  sprintNote: string | null;
  reason: string;
  reasonError: string | null;
  error: string | null;
  onReason(value: string): void;
}) {
  const removedColumns = statuses.filter((status) => !kept.has(status.id));
  // Board counts cover open (non-archived) cards; archived ones move with them.
  const moved = counts ? removedColumns.reduce((sum, status) => sum + (counts.get(status.id) ?? 0), 0) : null;
  const summary = [
    moved === null ? null : `${moved} open ${moved === 1 ? "card moves" : "cards move"}`,
    `${removedColumns.length} ${removedColumns.length === 1 ? "column" : "columns"} removed`,
    `periods: ${methodologyName(from)} → ${targetName}`,
  ].filter(Boolean).join(", ");
  return (
    <>
      <h3 id={HEADING_ID} ref={heading} tabIndex={-1}>Confirm the switch</h3>
      <p className="wsWizardSummary">{summary}</p>
      {sprintNote && <p className="wsWizardSummary">{sprintNote}</p>}
      <p className="wsProjectMuted">New board: {plan.columns.map((column) => column.name.trim()).join(" · ")}</p>
      <div className="wsField">
        <label htmlFor="switch-reason">Reason for the switch</label>
        <textarea
          aria-describedby={reasonError ? "switch-reason-error" : "switch-reason-hint"}
          aria-invalid={reasonError ? true : undefined}
          className="wsProjectTextarea"
          id="switch-reason"
          maxLength={SWITCH_REASON_MAX}
          onChange={(event) => onReason(event.target.value)}
          rows={3}
          value={reason}
        />
        {reasonError
          ? <p className="wsFieldError" id="switch-reason-error" role="alert">{reasonError}</p>
          : <p className="wsFieldHint" id="switch-reason-hint">Kept with the methodology history.</p>}
      </div>
      {error && <p className="wsAlert" role="alert">{error}</p>}
    </>
  );
}
