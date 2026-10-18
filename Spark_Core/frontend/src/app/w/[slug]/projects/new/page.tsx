"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type CSSProperties, type FormEvent } from "react";

import { useAuth } from "../../../../auth-context";
import { MethodologyPicker } from "../../../_components/methodology-picker";
import { ApiError, canManage, messageOf, workspaceApi, type Workspace, type WorkspaceMember } from "../../../_lib/api";
import { METHODOLOGY_ACCENTS, useMethodologies, type MethodologyId, type MethodologyTemplate } from "../../../_lib/methodologies";
import { spreadPhases } from "../../../_lib/phases";
import { cleanKeyInput, deriveProjectKey, isValidProjectKey, PROJECT_KEY_MAX } from "../../../_lib/project-key";
import { useWorkspaceData } from "../../../_lib/use-workspace-data";
import { useWorkspace } from "../../workspace-context";

const NAME_MAX = 80;
const DESCRIPTION_MAX = 2000;
const PHASE_NAME_MAX = 60;
const PHASES_MAX = 12;
const SPRINT_WEEKS = [1, 2, 3, 4] as const;

const KEY_RULE = "Use 2–10 capital letters or digits, starting with a letter.";
const KEY_TAKEN = "That key is already used in this workspace.";
const INVALID_LEAD = "The project lead must be an active member of the workspace.";
const RANGE_TOO_SHORT = "Give each phase at least one day — move the target date or remove a phase.";
const RANGE_REVERSED = "The target date can't be before the start date.";
const PHASES_RULE = "Each phase needs a name and dates inside the project dates, in order and without overlapping.";
const TOO_MANY_PROJECTS = "This workspace already has the maximum of 50 projects. Archive one before creating another.";

interface PhaseRow {
  id: number;
  name: string;
  plannedStart: string;
  plannedEnd: string;
}

interface CreatedProject {
  id: string;
  key: string;
}

export default function NewProjectPage() {
  // useSearchParams needs a Suspense boundary so the rest of the route can prerender.
  return (
    <Suspense fallback={null}>
      <NewProject />
    </Suspense>
  );
}

function NewProject() {
  const { workspace } = useWorkspace();
  const first = useSearchParams().get("first") === "1";

  if (!canManage(workspace.role)) {
    return (
      <section aria-labelledby="project-restricted-title" className="wsStateCard">
        <div aria-hidden="true" className="wsGlow" />
        <p className="sparkKicker"><span aria-hidden="true" />New project</p>
        <h1 id="project-restricted-title">Only owners and admins can create projects</h1>
        <p>Ask an owner or admin of {workspace.name} to set up the project. You&apos;ll see it here as soon as it exists.</p>
        <Link className="sparkPrimary" href={`/w/${workspace.slug}`}>Back to workspace home</Link>
      </section>
    );
  }
  return <ProjectCreator first={first} workspace={workspace} />;
}

/** Why the Waterfall range cannot hold the phases, or null when it fits (or is not complete yet). */
function rangeProblem(startDate: string, targetDate: string, phaseCount: number): string | null {
  if (!startDate || !targetDate) return null;
  if (targetDate < startDate) return RANGE_REVERSED;
  try {
    spreadPhases(startDate, targetDate, Array.from({ length: phaseCount }, (_, index) => String(index)));
    return null;
  } catch {
    return RANGE_TOO_SHORT;
  }
}

/** Re-spreads the phase dates over the project range; rows keep their names. Dates are cleared when they don't fit. */
function respread(rows: PhaseRow[], startDate: string, targetDate: string): PhaseRow[] {
  if (!startDate || !targetDate || rows.length === 0) return rows.map((row) => ({ ...row, plannedStart: "", plannedEnd: "" }));
  try {
    const spread = spreadPhases(startDate, targetDate, rows.map((row) => row.name));
    return rows.map((row, index) => ({ ...row, plannedStart: spread[index].plannedStart, plannedEnd: spread[index].plannedEnd }));
  } catch {
    return rows.map((row) => ({ ...row, plannedStart: "", plannedEnd: "" }));
  }
}

function phasesValid(rows: PhaseRow[], startDate: string, targetDate: string): boolean {
  let previousEnd = "";
  for (const row of rows) {
    const name = row.name.trim();
    if (!name || name.length > PHASE_NAME_MAX || !row.plannedStart || !row.plannedEnd) return false;
    if (row.plannedStart > row.plannedEnd || row.plannedStart < startDate || row.plannedEnd > targetDate) return false;
    if (previousEnd && row.plannedStart <= previousEnd) return false;
    previousEnd = row.plannedEnd;
  }
  return rows.length > 0;
}

function ProjectCreator({ workspace, first }: { workspace: Workspace; first: boolean }) {
  const router = useRouter();
  const { user } = useAuth();
  const catalog = useMethodologies();
  const members = useWorkspaceData<{ items: WorkspaceMember[] }>(`/workspaces/${workspace.id}/members`);

  const [methodology, setMethodology] = useState<MethodologyId | null>(null);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [lead, setLead] = useState<string | null>(null);
  const [sprintLength, setSprintLength] = useState<number | null>(null);
  const [startDate, setStartDate] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [phases, setPhases] = useState<PhaseRow[] | null>(null);
  const [nextPhaseId, setNextPhaseId] = useState(0);

  const [nameError, setNameError] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [leadError, setLeadError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [phasesError, setPhasesError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const templates = catalog.data ?? [];
  const template: MethodologyTemplate | undefined = templates.find((item) => item.id === methodology);
  const memberList = members.data?.items ?? [];
  // Default lead: the current user once the member list confirms they belong here.
  const effectiveLead = lead ?? (memberList.some((member) => member.userId === user?.id) ? user?.id ?? "" : "");
  const sprintDays = sprintLength ?? template?.defaults.sprintLengthDays ?? 14;
  const rows = phases ?? [];
  const range = methodology === "waterfall" ? rangeProblem(startDate, targetDate, rows.length) : null;
  const liveKeyProblem = keyEdited && key !== "" && !isValidProjectKey(key) ? KEY_RULE : null;
  const keyProblem = keyError ?? liveKeyProblem;
  const targetProblem = range ?? targetError;

  const onMethodologyChange = (id: MethodologyId) => {
    setMethodology(id);
    setFormError(null);
    if (id === "waterfall" && phases === null) {
      const names = templates.find((item) => item.id === id)?.defaults.phaseNames ?? [];
      const initial = names.map((phaseName, index) => ({ id: index, name: phaseName, plannedStart: "", plannedEnd: "" }));
      setPhases(respread(initial, startDate, targetDate));
      setNextPhaseId(names.length);
    }
  };

  const onNameChange = (value: string) => {
    setName(value);
    setNameError(null);
    if (!keyEdited) {
      setKey(value.trim() ? deriveProjectKey(value) : "");
      setKeyError(null);
    }
  };

  const onKeyChange = (value: string) => {
    const cleaned = cleanKeyInput(value);
    setKey(cleaned);
    // Clearing the field hands the key back to the name.
    setKeyEdited(cleaned !== "");
    setKeyError(null);
  };

  const onDatesChange = (nextStart: string, nextTarget: string) => {
    setStartDate(nextStart);
    setTargetDate(nextTarget);
    setStartError(null);
    setTargetError(null);
    setPhasesError(null);
    setPhases((current) => (current ? respread(current, nextStart, nextTarget) : current));
  };

  const updatePhase = (id: number, patch: Partial<PhaseRow>) => {
    setPhasesError(null);
    setPhases((current) => (current ?? []).map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const addPhase = () => {
    if (rows.length >= PHASES_MAX) return;
    setPhasesError(null);
    setPhases(respread([...rows, { id: nextPhaseId, name: `Phase ${rows.length + 1}`, plannedStart: "", plannedEnd: "" }], startDate, targetDate));
    setNextPhaseId((value) => value + 1);
  };

  const removePhase = (id: number) => {
    if (rows.length <= 1) return;
    setPhasesError(null);
    setPhases(respread(rows.filter((row) => row.id !== id), startDate, targetDate));
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting || !methodology) return;
    const trimmed = name.trim();
    const nextKey = key || deriveProjectKey(trimmed);
    const nameProblem = trimmed === "" ? "Give the project a name." : trimmed.length > NAME_MAX ? `Keep the name under ${NAME_MAX} characters.` : null;
    const keyRule = isValidProjectKey(nextKey) ? null : KEY_RULE;
    let startProblem: string | null = null;
    let targetMissing: string | null = null;
    let phaseProblem: string | null = null;
    if (methodology === "waterfall") {
      startProblem = startDate ? null : "Pick a start date.";
      targetMissing = targetDate ? null : "Pick a target date.";
      if (!startProblem && !targetMissing && !range && !phasesValid(rows, startDate, targetDate)) phaseProblem = PHASES_RULE;
    }
    setNameError(nameProblem);
    setKeyError(keyRule);
    setStartError(startProblem);
    setTargetError(targetMissing);
    setPhasesError(phaseProblem);
    setFormError(null);
    if (nameProblem || keyRule || startProblem || targetMissing || range || phaseProblem) return;

    const body: Record<string, unknown> = { key: nextKey, name: trimmed };
    if (description.trim()) body.description = description.trim();
    body.methodology = methodology;
    if (effectiveLead) body.leadUserId = effectiveLead;
    if (methodology === "scrum") body.sprintLengthDays = sprintDays;
    if (methodology === "waterfall") {
      body.startDate = startDate;
      body.targetDate = targetDate;
      body.phases = rows.map((row) => ({ name: row.name.trim(), plannedStart: row.plannedStart, plannedEnd: row.plannedEnd }));
    }

    setSubmitting(true);
    try {
      const { data } = await workspaceApi<CreatedProject>(`/workspaces/${workspace.id}/projects`, { method: "POST", body });
      router.push(`/w/${workspace.slug}/p/${data.key}`);
    } catch (error) {
      setSubmitting(false);
      const code = error instanceof ApiError ? error.code : null;
      if (code === "key_taken") setKeyError(KEY_TAKEN);
      else if (code === "invalid_lead") setLeadError(INVALID_LEAD);
      else if (code === "too_many_projects") setFormError(TOO_MANY_PROJECTS);
      else setFormError(messageOf(error));
    }
  };

  const accent = methodology ? ({ "--method-accent": METHODOLOGY_ACCENTS[methodology] } as CSSProperties) : undefined;

  return (
    <div className="wsProjectNew">
      <div aria-hidden="true" className="wsGlow" />
      <header className="wsProjectNewIntro">
        <p className="sparkKicker"><span aria-hidden="true" />{first ? "Your first project" : "New project"}</p>
        <h1 id="project-new-title">How does your team work?</h1>
        <p className="wsLead">Pick the way of working that fits this project. Spark sets up the board, planning and reports to match — you can fine-tune the details next.</p>
      </header>

      {catalog.error && !catalog.data && (
        <div className="wsAlert wsInlineAlert" role="alert">
          {catalog.error}
          <button className="textButton" onClick={catalog.reload} type="button">Try again</button>
        </div>
      )}
      {!catalog.data && !catalog.error && (
        <div aria-busy="true" className="wsPickerSkeleton" role="status">
          <span className="wsSrOnly">Loading ways of working…</span>
          <span /><span /><span />
        </div>
      )}
      {catalog.data && <MethodologyPicker labelledBy="project-new-title" onChange={onMethodologyChange} templates={templates} value={methodology} />}

      {template && (
        <form aria-labelledby="project-form-title" className="wsFormCard wsProjectForm" noValidate onSubmit={onSubmit} style={accent}>
          <div className="wsProjectFormHead">
            <span aria-hidden="true" className="wsProjectFormDot" />
            <h2 id="project-form-title">Set up your {template.name} project</h2>
          </div>

          <div className="wsProjectFormGrid">
            <div className="wsField">
              <label htmlFor="project-name">Project name</label>
              <input
                aria-describedby={nameError ? "project-name-error" : undefined}
                aria-invalid={nameError ? true : undefined}
                autoComplete="off"
                id="project-name"
                maxLength={NAME_MAX}
                onChange={(event) => onNameChange(event.target.value)}
                placeholder="Product launch"
                value={name}
              />
              {nameError && <p className="wsFieldError" id="project-name-error" role="alert">{nameError}</p>}
            </div>

            <div className="wsField wsProjectKeyField">
              <label htmlFor="project-key">Project key</label>
              <input
                aria-describedby={keyProblem ? "project-key-error" : "project-key-hint"}
                aria-invalid={keyProblem ? true : undefined}
                autoCapitalize="characters"
                autoComplete="off"
                className="wsProjectKeyInput"
                id="project-key"
                maxLength={PROJECT_KEY_MAX}
                onChange={(event) => onKeyChange(event.target.value)}
                placeholder="PL"
                spellCheck={false}
                value={key}
              />
              {keyProblem
                ? <p className="wsFieldError" id="project-key-error" role="alert">{keyProblem}</p>
                : <p className="wsFieldHint" id="project-key-hint">Prefixes every work item, like {(key || "PL")}-12.</p>}
            </div>
          </div>

          <div className="wsField">
            <label htmlFor="project-description">Description</label>
            <textarea
              className="wsProjectTextarea"
              id="project-description"
              maxLength={DESCRIPTION_MAX}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What is this project about? Optional."
              rows={3}
              value={description}
            />
          </div>

          <div className="wsProjectFormGrid">
            <div className="wsField">
              <label htmlFor="project-lead">Project lead</label>
              <select
                aria-describedby={leadError ? "project-lead-error" : members.error ? "project-lead-hint" : undefined}
                aria-invalid={leadError ? true : undefined}
                className="wsSelect"
                disabled={!members.data}
                id="project-lead"
                onChange={(event) => {
                  setLead(event.target.value);
                  setLeadError(null);
                }}
                value={effectiveLead}
              >
                <option value="">No lead yet</option>
                {memberList.map((member) => (
                  <option key={member.userId} value={member.userId}>{member.displayName}{member.userId === user?.id ? " (you)" : ""}</option>
                ))}
              </select>
              {leadError
                ? <p className="wsFieldError" id="project-lead-error" role="alert">{leadError}</p>
                : members.error && <p className="wsFieldHint" id="project-lead-hint">Members couldn&apos;t be loaded. You can pick a lead later.</p>}
            </div>

            {methodology === "scrum" && (
              <div className="wsField">
                <label htmlFor="project-sprint-length">Sprint length</label>
                <select className="wsSelect" id="project-sprint-length" onChange={(event) => setSprintLength(Number(event.target.value))} value={sprintDays}>
                  {SPRINT_WEEKS.map((weeks) => <option key={weeks} value={weeks * 7}>{weeks} {weeks === 1 ? "week" : "weeks"}</option>)}
                </select>
              </div>
            )}
          </div>

          {methodology === "waterfall" && (
            <>
              <div className="wsProjectFormGrid">
                <div className="wsField">
                  <label htmlFor="project-start">Start date</label>
                  <input
                    aria-describedby={startError ? "project-start-error" : undefined}
                    aria-invalid={startError ? true : undefined}
                    id="project-start"
                    onChange={(event) => onDatesChange(event.target.value, targetDate)}
                    type="date"
                    value={startDate}
                  />
                  {startError && <p className="wsFieldError" id="project-start-error" role="alert">{startError}</p>}
                </div>
                <div className="wsField">
                  <label htmlFor="project-target">Target date</label>
                  <input
                    aria-describedby={targetProblem ? "project-target-error" : undefined}
                    aria-invalid={targetProblem ? true : undefined}
                    id="project-target"
                    min={startDate || undefined}
                    onChange={(event) => onDatesChange(startDate, event.target.value)}
                    type="date"
                    value={targetDate}
                  />
                  {targetProblem && <p className="wsFieldError" id="project-target-error" role="alert">{targetProblem}</p>}
                </div>
              </div>

              <fieldset aria-describedby={phasesError ? "project-phases-error" : "project-phases-hint"} className="wsProjectPhases">
                <legend>Phases</legend>
                <p className="wsFieldHint" id="project-phases-hint">Spread evenly over the project dates. Rename them or adjust the dates — up to {PHASES_MAX} phases.</p>
                <ol className="wsProjectPhaseList">
                  {rows.map((row, index) => {
                    const number = index + 1;
                    return (
                      <li className="wsProjectPhase" key={row.id}>
                        <span aria-hidden="true" className="wsProjectPhaseNumber">{number}</span>
                        <input
                          aria-label={`Phase ${number} name`}
                          className="wsProjectPhaseName"
                          maxLength={PHASE_NAME_MAX}
                          onChange={(event) => updatePhase(row.id, { name: event.target.value })}
                          value={row.name}
                        />
                        <input
                          aria-label={`Phase ${number} start`}
                          max={targetDate || undefined}
                          min={startDate || undefined}
                          onChange={(event) => updatePhase(row.id, { plannedStart: event.target.value })}
                          type="date"
                          value={row.plannedStart}
                        />
                        <input
                          aria-label={`Phase ${number} end`}
                          max={targetDate || undefined}
                          min={startDate || undefined}
                          onChange={(event) => updatePhase(row.id, { plannedEnd: event.target.value })}
                          type="date"
                          value={row.plannedEnd}
                        />
                        <button
                          aria-label={`Remove phase ${number}`}
                          className="wsGhostButton danger"
                          disabled={rows.length <= 1}
                          onClick={() => removePhase(row.id)}
                          type="button"
                        >
                          Remove
                        </button>
                      </li>
                    );
                  })}
                </ol>
                {phasesError && <p className="wsFieldError" id="project-phases-error" role="alert">{phasesError}</p>}
                <button className="sparkSecondary wsProjectAddPhase" disabled={rows.length >= PHASES_MAX} onClick={addPhase} type="button">Add phase</button>
              </fieldset>
            </>
          )}

          <details className="wsProjectPractices">
            <summary>Practices we&apos;ll suggest</summary>
            <ul>
              {template.practices.map((practice) => <li key={practice}>{practice}</li>)}
            </ul>
          </details>

          {formError && <div className="wsAlert" role="alert">{formError}</div>}

          <div className="wsProjectFormActions">
            {first && <Link className="wsGhostButton" href={`/w/${workspace.slug}`}>Skip for now</Link>}
            <button className="sparkPrimary wsSubmit" disabled={submitting || Boolean(range)} type="submit">
              {submitting ? "Creating project…" : "Create project"}
              {!submitting && <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
