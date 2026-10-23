"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { MethodologyPicker } from "../../../_components/methodology-picker";
import { Modal } from "../../../_components/modal";
import { PhaseRowsEditor } from "../../../_components/phase-rows-editor";
import { ApiError, messageOf } from "../../../_lib/api";
import { METHODOLOGY_ACCENTS, useMethodologies, type MethodologyId, type MethodologyTemplate, type StatusCategory } from "../../../_lib/methodologies";
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
  type SwitchColumn,
  type SwitchRequest,
  type SwitchResult,
} from "../../../_lib/planning";
import { methodologyName, methodologyOf, type ProjectDetail, type ProjectStatus } from "../../../_lib/projects";
import { useWorkspaceData } from "../../../_lib/use-workspace-data";
import { TEAMMATE_UPDATE } from "./settings-form";

const STEPS = ["Choose a methodology", "Map columns", "Plan", "Confirm"] as const;
const CATEGORIES: StatusCategory[] = ["backlog", "todo", "in_progress", "done"];
const SPRINT_WEEKS = [1, 2, 3, 4] as const;
const DATES_REVERSED = "The target date can't be before the start date.";
const REASON_REQUIRED = "Say why the project is switching.";

/** A column of the board after the switch; `sourceId` keeps that current column (and its cards). */
interface TargetColumn {
  key: number;
  sourceId: string | null;
  name: string;
  category: StatusCategory;
  /** The WIP field's text ("" is no limit). */
  wip: string;
}

interface WizardPhase {
  key: number;
  /** An existing phase from an earlier Waterfall period keeps its id (and baseline). */
  id?: string;
  name: string;
  plannedStart: string;
  plannedEnd: string;
}

interface Proposal {
  columns: TargetColumn[];
  /** Current column id → key of the target column its cards move to (null: not chosen yet). Kept columns are absent. */
  mapping: Record<string, number | null>;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The target template's columns. A current column with the same name and category is kept (its cards stay);
 * every other current column moves its cards to a target column of the same category, a new one first, or
 * waits for a choice when the target has no such category.
 */
function propose(statuses: readonly ProjectStatus[], template: MethodologyTemplate): Proposal {
  const kept = new Set<string>();
  const columns = template.statuses.map((column, index): TargetColumn => {
    const match = statuses.find((status) => !kept.has(status.id) && status.category === column.category && sameName(status.name, column.name));
    if (match) kept.add(match.id);
    return { key: index, sourceId: match?.id ?? null, name: column.name, category: column.category, wip: column.wipLimit === null ? "" : String(column.wipLimit) };
  });
  const mapping: Proposal["mapping"] = {};
  for (const status of statuses) {
    if (kept.has(status.id)) continue;
    const same = columns.filter((column) => column.category === status.category);
    mapping[status.id] = (same.find((column) => column.sourceId === null) ?? same[0])?.key ?? null;
  }
  return { columns, mapping };
}

/** Cards each target column would hold: its kept column's own plus every column mapped to it. */
function occupancy(columns: readonly TargetColumn[], mapping: Proposal["mapping"], counts: ReadonlyMap<string, number>): Map<number, number> {
  const totals = new Map(columns.map((column) => [column.key, column.sourceId ? counts.get(column.sourceId) ?? 0 : 0]));
  for (const [statusId, key] of Object.entries(mapping)) {
    if (key !== null && totals.has(key)) totals.set(key, (totals.get(key) ?? 0) + (counts.get(statusId) ?? 0));
  }
  return totals;
}

function initialPhases(project: ProjectDetail, template: MethodologyTemplate | undefined): { rows: WizardPhase[]; edited: boolean } {
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
export function SwitchWizard({ project, etag, counts, backlogHref, onClose, onSwitched, onStale, onWipRefused }: {
  project: ProjectDetail;
  etag: string;
  /** Cards per current column, or null while the board loads (the server still checks WIP limits). */
  counts: ReadonlyMap<string, number> | null;
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
  const statuses = [...project.statuses].sort((a, b) => a.position - b.position);

  const [step, setStep] = useState(0);
  const [target, setTarget] = useState<MethodologyId | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<(Proposal & { for: MethodologyId }) | null>(null);
  const [nextKey, setNextKey] = useState(100);
  const [columnErrors, setColumnErrors] = useState<Record<number, string>>({});
  const [mappingErrors, setMappingErrors] = useState<Record<string, string>>({});
  const [boardError, setBoardError] = useState<string | null>(null);
  const [sprintDays, setSprintDays] = useState(project.sprintLengthDays ?? DEFAULT_SPRINT_DAYS);
  const [startDate, setStartDate] = useState(project.startDate ?? "");
  const [targetDate, setTargetDate] = useState(project.targetDate ?? "");
  const [phases, setPhases] = useState<{ rows: WizardPhase[]; edited: boolean } | null>(null);
  const [nextPhaseKey, setNextPhaseKey] = useState(100);
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
  const columns = proposal?.columns ?? [];
  const mapping = proposal?.mapping ?? {};
  const keptIds = new Set(columns.map((column) => column.sourceId).filter((id): id is string => id !== null));
  const totals = counts ? occupancy(columns, mapping, counts) : null;
  const activeSprint = from === "scrum" ? sprints.data?.items.find((sprint) => sprint.status === "active") ?? null : null;
  const sprintsChecking = from === "scrum" && !sprints.data && !sprints.error;
  const sprintBlocked = from === "scrum" && (Boolean(activeSprint) || sprintBlockedByServer);
  const phaseRows = phases?.rows ?? [];
  const targetName = target ? methodologyName(target) : "";

  const changeProposal = (change: (current: Proposal) => Proposal) =>
    setProposal((current) => (current ? { ...change(current), for: current.for } : current));
  const updateColumn = (key: number, patch: Partial<TargetColumn>) => {
    changeProposal((current) => ({ ...current, columns: current.columns.map((column) => (column.key === key ? { ...column, ...patch } : column)) }));
    setColumnErrors((current) => ({ ...current, [key]: "" }));
    setBoardError(null);
  };

  /** A target column takes over a current column (`sourceId`) or becomes new; the column it gave up moves its cards here. */
  const changeSource = (key: number, sourceId: string | null) => {
    changeProposal((current) => {
      const column = current.columns.find((item) => item.key === key);
      if (!column) return current;
      const nextMapping = { ...current.mapping };
      if (column.sourceId) nextMapping[column.sourceId] = key;
      const source = sourceId ? statuses.find((status) => status.id === sourceId) : undefined;
      if (source) delete nextMapping[source.id];
      const category = (source?.category as StatusCategory | undefined) ?? column.category;
      return { mapping: nextMapping, columns: current.columns.map((item) => (item.key === key ? { ...item, sourceId: source?.id ?? null, category } : item)) };
    });
    setColumnErrors((current) => ({ ...current, [key]: "" }));
    if (sourceId) setMappingErrors((current) => ({ ...current, [sourceId]: "" }));
  };

  const addColumn = () => {
    if (columns.length >= COLUMNS_MAX) return;
    const key = nextKey;
    setNextKey(key + 1);
    changeProposal((current) => ({ ...current, columns: [...current.columns, { key, sourceId: null, name: "", category: "todo", wip: "" }] }));
    setBoardError(null);
  };

  const removeColumn = (key: number) => {
    if (columns.length <= COLUMNS_MIN) return;
    changeProposal((current) => {
      const column = current.columns.find((item) => item.key === key);
      const nextMapping = Object.fromEntries(Object.entries(current.mapping).map(([id, value]) => [id, value === key ? null : value]));
      if (column?.sourceId) nextMapping[column.sourceId] = null;
      return { mapping: nextMapping, columns: current.columns.filter((item) => item.key !== key) };
    });
    setBoardError(null);
  };

  const mapColumn = (statusId: string, key: number | null) => {
    changeProposal((current) => ({ ...current, mapping: { ...current.mapping, [statusId]: key } }));
    setMappingErrors((current) => ({ ...current, [statusId]: "" }));
    setBoardError(null);
  };

  // ---------- Steps ----------

  const goTo = (index: number) => {
    setSubmitError(null);
    setStep(index);
  };

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
      setProposal({ ...propose(statuses, template), for: target });
      setColumnErrors({});
      setMappingErrors({});
      setBoardError(null);
    }
    if (target === "waterfall" && phases === null) setPhases(initialPhases(project, template));
    goTo(1);
  };

  const leaveColumns = () => {
    const errors: Record<number, string> = {};
    const seen = new Map<string, number>();
    for (const column of columns) {
      const problem = columnNameProblem(column.name);
      const key = column.name.trim().toLowerCase();
      const wip = parseWipLimit(column.wip);
      const cards = totals?.get(column.key) ?? 0;
      if (problem) errors[column.key] = problem;
      else if (seen.has(key)) errors[column.key] = "Another column already has this name.";
      else if (wip === undefined) errors[column.key] = WIP_RULE;
      else if (totals && wip !== null && cards > wip) errors[column.key] = wipBelowOccupancyMessage(cards);
      seen.set(key, column.key);
    }
    const missing: Record<string, string> = {};
    for (const status of statuses) {
      if (!keptIds.has(status.id) && (mapping[status.id] ?? null) === null) missing[status.id] = `Choose where the cards in ${status.name} go.`;
    }
    const countProblem = columns.length < COLUMNS_MIN || columns.length > COLUMNS_MAX ? `A board needs ${COLUMNS_MIN} to ${COLUMNS_MAX} columns.` : null;
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

  const onDatesChange = (nextStart: string, nextTarget: string) => {
    setStartDate(nextStart);
    setTargetDate(nextTarget);
    setDateErrors({ start: null, target: null });
    setPhasesError(null);
    setPhases((current) => (current && !current.edited ? { ...current, rows: respreadPhases(current.rows, nextStart, nextTarget) } : current));
  };

  const updatePhase = (key: number, patch: Partial<WizardPhase>) => {
    setPhasesError(null);
    const edited = patch.plannedStart !== undefined || patch.plannedEnd !== undefined;
    setPhases((current) => (current ? { edited: current.edited || edited, rows: current.rows.map((row) => (row.key === key ? { ...row, ...patch } : row)) } : current));
  };

  const addPhase = () => {
    if (phaseRows.length >= PHASES_MAX || !phases) return;
    setPhasesError(null);
    const added: WizardPhase = { key: nextPhaseKey, name: `Phase ${phaseRows.length + 1}`, plannedStart: "", plannedEnd: "" };
    setNextPhaseKey((value) => value + 1);
    setPhases({
      edited: phases.edited,
      rows: phases.edited ? [...phaseRows, { ...added, ...appendedDates(phaseRows, startDate, targetDate) }] : respreadPhases([...phaseRows, added], startDate, targetDate),
    });
  };

  const removePhase = (key: number) => {
    if (phaseRows.length <= 1 || !phases) return;
    setPhasesError(null);
    const kept = phaseRows.filter((row) => row.key !== key);
    setPhases({ edited: phases.edited, rows: phases.edited ? kept : respreadPhases(kept, startDate, targetDate) });
  };

  const request = (): SwitchRequest | null => {
    if (!target) return null;
    const body: SwitchRequest = {
      to: target,
      columns: columns.map((column): SwitchColumn => ({
        ...(column.sourceId ? { id: column.sourceId } : {}),
        name: column.name.trim(),
        category: column.category,
        wipLimit: parseWipLimit(column.wip) ?? null,
      })),
      mapping: Object.fromEntries(
        Object.entries(mapping)
          .filter(([statusId]) => !keptIds.has(statusId))
          .map(([statusId, key]) => [statusId, columns.findIndex((column) => column.key === key)]),
      ),
      reason: reason.trim(),
    };
    if (target === "scrum") body.sprintLengthDays = sprintDays;
    if (target === "waterfall") {
      body.startDate = startDate;
      body.targetDate = targetDate;
      body.phases = phaseRows.map((row) => ({ ...(row.id ? { id: row.id } : {}), name: row.name.trim(), plannedStart: row.plannedStart, plannedEnd: row.plannedEnd }));
    }
    return body;
  };

  const submit = async () => {
    if (submitting) return;
    const trimmed = reason.trim();
    if (!trimmed) {
      setReasonError(REASON_REQUIRED);
      return;
    }
    const body = request();
    if (!body) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await switchMethodology(project.id, etag, body);
      onSwitched(result);
    } catch (error) {
      setSubmitting(false);
      const code = error instanceof ApiError ? error.code : null;
      const current = error instanceof ApiError && error.status === 412 ? (error.body as { current?: ProjectDetail } | null)?.current : undefined;
      if (current && template && target) {
        // The columns may have changed: map again from the teammate's version.
        onStale(current);
        setProposal({ ...propose([...current.statuses].sort((a, b) => a.position - b.position), template), for: target });
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
      } else {
        setSubmitError(messageOf(error));
      }
    }
  };

  // ---------- Rendering ----------

  const moved = counts ? statuses.filter((status) => !keptIds.has(status.id)).reduce((sum, status) => sum + (counts.get(status.id) ?? 0), 0) : null;
  const removed = statuses.filter((status) => !keptIds.has(status.id)).length;
  const summary = [
    moved === null ? null : `${moved} ${moved === 1 ? "card moves" : "cards move"}`,
    `${removed} ${removed === 1 ? "column" : "columns"} removed`,
    `periods: ${methodologyName(from)} → ${targetName}`,
  ].filter(Boolean).join(", ");
  const sprintOptions = SPRINT_WEEKS.map((weeks) => weeks * 7);
  if (!sprintOptions.includes(sprintDays)) sprintOptions.push(sprintDays);
  const accent = target ? ({ "--method-accent": METHODOLOGY_ACCENTS[target] } as CSSProperties) : undefined;
  const headingId = "switch-step-title";

  let body: ReactNode;
  let primary: ReactNode;
  if (step === 0) {
    body = (
      <>
        <h3 data-autofocus id={headingId} ref={heading} tabIndex={-1}>Which way of working should {project.name} use?</h3>
        <p className="wsWizardLead">You&apos;re on {methodologyName(from)}. Work, sprints and phases stay as history; only the board and planning change.</p>
        {catalog.error && !catalog.data && (
          <p className="wsAlert wsInlineAlert" role="alert">{catalog.error} <button className="textButton" onClick={catalog.reload} type="button">Try again</button></p>
        )}
        {!catalog.data && !catalog.error && <p className="wsProjectMuted" role="status">Loading ways of working…</p>}
        {catalog.data && <MethodologyPicker labelledBy={headingId} onChange={(id) => { setTarget(id); setPickError(null); }} templates={templates} value={target} />}
        {pickError && <p className="wsFieldError" role="alert">{pickError}</p>}
      </>
    );
    primary = <button className="sparkPrimary" onClick={leavePick} type="button">Next</button>;
  } else if (step === 1) {
    body = (
      <>
        <h3 id={headingId} ref={heading} tabIndex={-1}>Map your columns</h3>
        <p className="wsWizardLead">
          Spark proposes the {targetName} columns. A column based on a current one keeps it and its cards; cards in every other current column move to the column you choose.
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
                const options = statuses.filter((status) => status.id === column.sourceId || !keptIds.has(status.id));
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
    primary = <button className="sparkPrimary" onClick={leaveColumns} type="button">Next</button>;
  } else if (step === 2) {
    let planning: ReactNode;
    if (sprintBlocked) {
      planning = (
        <div className="wsAlert wsWizardBlocked" role="alert">
          <p>
            <strong>{activeSprint ? `${activeSprint.name} is still active.` : "A sprint is still active."}</strong>{" "}
            Complete it before switching, so its unfinished work lands in the backlog or the next sprint. Sprints stay as history.
          </p>
          <Link className="sparkPrimary" href={backlogHref}>Complete sprint now</Link>
        </div>
      );
    } else if (sprintsChecking) {
      planning = <p className="wsProjectMuted" role="status">Checking for an active sprint…</p>;
    } else if (target === "scrum") {
      planning = (
        <>
          <div className="wsField wsWizardNarrow">
            <label htmlFor="switch-sprint-length">Sprint length</label>
            <select className="wsSelect" id="switch-sprint-length" onChange={(event) => setSprintDays(Number(event.target.value))} value={sprintDays}>
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
              <button className="wsGhostButton" disabled={!startDate || !targetDate} onClick={() => setPhases({ edited: false, rows: respreadPhases(phaseRows, startDate, targetDate) })} type="button">
                Re-spread dates evenly
              </button>
            }
            hint={project.phases.length > 0
              ? "The phases from the last Waterfall period, with their baselines. Adjust them to the new dates."
              : `Spread evenly over the project dates. Rename them or adjust the dates — up to ${PHASES_MAX} phases.`}
            idPrefix="switch-phases"
            onAdd={addPhase}
            onChange={updatePhase}
            onRemove={removePhase}
            rows={phaseRows}
            startDate={startDate}
            targetDate={targetDate}
          />
          <p className="wsProjectMuted">Tasks without a phase show as Unphased on the Timeline.</p>
        </>
      );
    } else {
      planning = <p className="wsProjectMuted">Kanban needs no planning step. The WIP limits from the previous step apply as soon as you switch.</p>;
    }
    body = (
      <>
        <h3 id={headingId} ref={heading} tabIndex={-1}>Plan for {targetName}</h3>
        {planning}
      </>
    );
    primary = <button className="sparkPrimary" disabled={sprintBlocked || sprintsChecking} onClick={leavePlanning} type="button">Next</button>;
  } else {
    body = (
      <>
        <h3 id={headingId} ref={heading} tabIndex={-1}>Confirm the switch</h3>
        <p className="wsWizardSummary">{summary}</p>
        <p className="wsProjectMuted">New board: {columns.map((column) => column.name.trim()).join(" · ")}</p>
        <div className="wsField">
          <label htmlFor="switch-reason">Reason for the switch</label>
          <textarea
            aria-describedby={reasonError ? "switch-reason-error" : "switch-reason-hint"}
            aria-invalid={reasonError ? true : undefined}
            className="wsProjectTextarea"
            id="switch-reason"
            maxLength={SWITCH_REASON_MAX}
            onChange={(event) => { setReason(event.target.value); setReasonError(null); }}
            rows={3}
            value={reason}
          />
          {reasonError
            ? <p className="wsFieldError" id="switch-reason-error" role="alert">{reasonError}</p>
            : <p className="wsFieldHint" id="switch-reason-hint">Kept with the methodology history.</p>}
        </div>
        {submitError && <p className="wsAlert" role="alert">{submitError}</p>}
      </>
    );
    primary = <button className="sparkPrimary" disabled={submitting} onClick={submit} type="button">{submitting ? "Switching…" : `Switch to ${targetName}`}</button>;
  }

  return (
    <Modal busy={submitting} onClose={onClose} title="Switch methodology" variant="wide">
      <div className="wsWizard" style={accent}>
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
