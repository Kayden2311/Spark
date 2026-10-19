"use client";

import { useState, type FormEvent } from "react";

import { Modal } from "../../../_components/modal";
import { ApiError, messageOf, workspaceApi, type Workspace, type WorkspaceMember } from "../../../_lib/api";
import { projectEtag, type ProjectDetail } from "../../../_lib/projects";
import { useWorkspaceData } from "../../../_lib/use-workspace-data";

const NAME_MAX = 80;
const DESCRIPTION_MAX = 2000;
const SPRINT_WEEKS = [1, 2, 3, 4] as const;

export const TEAMMATE_UPDATE = "Updated by a teammate — review the latest values and save again.";
const INVALID_LEAD = "The project lead must be an active member of the workspace.";
const DATES_REVERSED = "The target date can't be before the start date.";
const DATES_REQUIRED = "Waterfall projects need a start and a target date.";
const PHASES_OUTSIDE = "Every phase has to stay inside the project dates. Pick dates that still cover all phases.";

interface FormValues {
  name: string;
  description: string;
  lead: string;
  startDate: string;
  targetDate: string;
  sprintLengthDays: number;
}

function valuesOf(project: ProjectDetail): FormValues {
  return {
    name: project.name,
    description: project.description ?? "",
    lead: project.lead?.id ?? "",
    startDate: project.startDate ?? "",
    targetDate: project.targetDate ?? "",
    sprintLengthDays: project.sprintLengthDays ?? 14,
  };
}

/** Only the fields that differ from what the dialog was opened (or refreshed) with. */
function changes(values: FormValues, base: ProjectDetail): Record<string, unknown> {
  const before = valuesOf(base);
  const body: Record<string, unknown> = {};
  const name = values.name.trim();
  const description = values.description.trim();
  if (name !== before.name) body.name = name;
  if (description !== before.description.trim()) body.description = description || null;
  if (values.lead !== before.lead) body.leadUserId = values.lead || null;
  if (values.startDate !== before.startDate) body.startDate = values.startDate || null;
  if (values.targetDate !== before.targetDate) body.targetDate = values.targetDate || null;
  if (base.methodology === "scrum" && values.sprintLengthDays !== before.sprintLengthDays) body.sprintLengthDays = values.sprintLengthDays;
  return body;
}

/**
 * Edits a project's settings with optimistic concurrency: the save carries If-Match, and a 412 swaps in the
 * teammate's newer values (and their version) so the next save is deliberate.
 */
export function ProjectSettingsDialog({ project, etag, workspace, onClose, onSaved, onStale }: {
  project: ProjectDetail;
  etag: string;
  workspace: Workspace;
  onClose(): void;
  onSaved(project: ProjectDetail, etag: string): void;
  onStale(project: ProjectDetail): void;
}) {
  const members = useWorkspaceData<{ items: WorkspaceMember[] }>(`/workspaces/${workspace.id}/members`);
  const [base, setBase] = useState(project);
  const [version, setVersion] = useState(etag);
  const [values, setValues] = useState<FormValues>(() => valuesOf(project));
  const [nameError, setNameError] = useState<string | null>(null);
  const [leadError, setLeadError] = useState<string | null>(null);
  const [datesError, setDatesError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);

  const waterfall = base.methodology === "waterfall";
  const scrum = base.methodology === "scrum";
  const memberList = members.data?.items ?? [];
  // A lead who is no longer listed (or a list that failed to load) still shows as the current choice.
  const leadMissing = values.lead !== "" && !memberList.some((member) => member.userId === values.lead);
  const sprintOptions = SPRINT_WEEKS.map((weeks) => weeks * 7);
  if (!sprintOptions.includes(values.sprintLengthDays)) sprintOptions.push(values.sprintLengthDays);

  const update = (patch: Partial<FormValues>) => {
    setValues((current) => ({ ...current, ...patch }));
    setFormError(null);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const name = values.name.trim();
    const nameProblem = name === "" ? "Give the project a name." : name.length > NAME_MAX ? `Keep the name under ${NAME_MAX} characters.` : null;
    let datesProblem: string | null = null;
    if (waterfall && (!values.startDate || !values.targetDate)) datesProblem = DATES_REQUIRED;
    else if (values.startDate && values.targetDate && values.targetDate < values.startDate) datesProblem = DATES_REVERSED;
    setNameError(nameProblem);
    setDatesError(datesProblem);
    setFormError(null);
    if (nameProblem || datesProblem) return;

    const body = changes(values, base);
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      const { data, etag: next } = await workspaceApi<ProjectDetail>(`/projects/${base.id}`, { method: "PATCH", body, ifMatch: version });
      onSaved(data, next ?? projectEtag(data.version));
    } catch (error) {
      setSaving(false);
      const current = error instanceof ApiError && error.status === 412 ? (error.body as { current?: ProjectDetail } | null)?.current : undefined;
      if (current) {
        setBase(current);
        setVersion(projectEtag(current.version));
        setValues(valuesOf(current));
        setNameError(null);
        setLeadError(null);
        setDatesError(null);
        setConflict(true);
        onStale(current);
        return;
      }
      setConflict(false);
      const code = error instanceof ApiError ? error.code : null;
      if (code === "invalid_lead") setLeadError(INVALID_LEAD);
      else if (code === "invalid_input" && waterfall && ("startDate" in body || "targetDate" in body)) setDatesError(PHASES_OUTSIDE);
      else setFormError(messageOf(error));
    }
  };

  return (
    <Modal busy={saving} onClose={onClose} title="Project settings">
      <form className="wsSettingsForm" noValidate onSubmit={onSubmit}>
        {conflict && <p className="wsConflict" role="alert">{TEAMMATE_UPDATE}</p>}

        <div className="wsField">
          <label htmlFor="settings-name">Project name</label>
          <input
            aria-describedby={nameError ? "settings-name-error" : undefined}
            aria-invalid={nameError ? true : undefined}
            autoComplete="off"
            data-autofocus
            id="settings-name"
            maxLength={NAME_MAX}
            onChange={(event) => { update({ name: event.target.value }); setNameError(null); }}
            value={values.name}
          />
          {nameError && <p className="wsFieldError" id="settings-name-error" role="alert">{nameError}</p>}
        </div>

        <div className="wsField">
          <label htmlFor="settings-description">Description</label>
          <textarea
            className="wsProjectTextarea"
            id="settings-description"
            maxLength={DESCRIPTION_MAX}
            onChange={(event) => update({ description: event.target.value })}
            placeholder="What is this project about? Optional."
            rows={3}
            value={values.description}
          />
        </div>

        <div className="wsField">
          <label htmlFor="settings-lead">Project lead</label>
          <select
            aria-describedby={leadError ? "settings-lead-error" : undefined}
            aria-invalid={leadError ? true : undefined}
            className="wsSelect"
            disabled={!members.data}
            id="settings-lead"
            onChange={(event) => { update({ lead: event.target.value }); setLeadError(null); }}
            value={values.lead}
          >
            <option value="">No lead</option>
            {leadMissing && <option value={values.lead}>{base.lead?.id === values.lead ? base.lead.displayName : "Current lead"}</option>}
            {memberList.map((member) => <option key={member.userId} value={member.userId}>{member.displayName}</option>)}
          </select>
          {leadError
            ? <p className="wsFieldError" id="settings-lead-error" role="alert">{leadError}</p>
            : members.error && <p className="wsFieldHint">Members couldn&apos;t be loaded, so the lead can&apos;t change right now.</p>}
        </div>

        <fieldset aria-describedby={datesError ? "settings-dates-error" : waterfall ? "settings-dates-hint" : undefined} className="wsSettingsDates">
          <legend>Dates</legend>
          <div className="wsField">
            <label htmlFor="settings-start">Start date</label>
            <input
              aria-invalid={datesError ? true : undefined}
              id="settings-start"
              onChange={(event) => { update({ startDate: event.target.value }); setDatesError(null); }}
              type="date"
              value={values.startDate}
            />
          </div>
          <div className="wsField">
            <label htmlFor="settings-target">Target date</label>
            <input
              aria-invalid={datesError ? true : undefined}
              id="settings-target"
              min={values.startDate || undefined}
              onChange={(event) => { update({ targetDate: event.target.value }); setDatesError(null); }}
              type="date"
              value={values.targetDate}
            />
          </div>
          {datesError
            ? <p className="wsFieldError" id="settings-dates-error" role="alert">{datesError}</p>
            : waterfall && <p className="wsFieldHint" id="settings-dates-hint">Both dates are required and must still cover every phase.</p>}
        </fieldset>

        {scrum && (
          <div className="wsField">
            <label htmlFor="settings-sprint">Sprint length</label>
            <select className="wsSelect" id="settings-sprint" onChange={(event) => update({ sprintLengthDays: Number(event.target.value) })} value={values.sprintLengthDays}>
              {sprintOptions.map((days) => (
                <option key={days} value={days}>{days % 7 === 0 ? `${days / 7} ${days === 7 ? "week" : "weeks"}` : `${days} days`}</option>
              ))}
            </select>
          </div>
        )}

        {formError && <p className="wsAlert" role="alert">{formError}</p>}

        <div className="wsModalActions">
          <button className="sparkSecondary" disabled={saving} onClick={onClose} type="button">Cancel</button>
          <button className="sparkPrimary" disabled={saving} type="submit">{saving ? "Saving…" : "Save changes"}</button>
        </div>
      </form>
    </Modal>
  );
}
