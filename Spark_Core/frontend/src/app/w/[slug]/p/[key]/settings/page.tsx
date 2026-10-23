"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { useAuth } from "../../../../../auth-context";
import { ApiError, messageOf } from "../../../../_lib/api";
import { boardPath, type BoardState } from "../../../../_lib/issues";
import {
  canPlan,
  cardCountLabel,
  categoryLabel,
  COLUMN_NAME_MAX,
  columnNameProblem,
  parseWipLimit,
  periodLabel,
  PLAN_AUTHORITY_MESSAGE,
  planPath,
  updateStatus,
  WIP_LIMIT_MAX,
  WIP_RULE,
  type ProjectPlan,
  type StatusPatch,
  type SwitchResult,
} from "../../../../_lib/planning";
import { methodologyName, methodologyOf, type ProjectDetail, type ProjectStatus } from "../../../../_lib/projects";
import { useWorkspaceData } from "../../../../_lib/use-workspace-data";
import { useWorkspace } from "../../../workspace-context";
import { useProject } from "../project-context";
import { ProjectSettingsForm, TEAMMATE_UPDATE } from "../settings-form";
import { SwitchWizard } from "../switch-wizard";

/**
 * Project settings for the people who can change the plan: General (the M2 fields), board columns (names and
 * WIP limits against the cards already in them) and the methodology with its history and the switch wizard.
 * Anyone else who opens the address sees the columns and the history read-only.
 */
export default function ProjectSettingsPage() {
  const { project, etag, notify, replaceProject } = useProject();
  const { workspace } = useWorkspace();
  const { user } = useAuth();
  const router = useRouter();
  const planner = canPlan(workspace.role, project, user?.id);
  const board = useWorkspaceData<BoardState>(boardPath(project.id));
  const plan = useWorkspaceData<ProjectPlan>(planPath(project.id));
  const [switching, setSwitching] = useState(false);

  // Occupancy per column from the loaded board (non-archived cards, the API's WIP definition).
  const counts = board.data && board.dataPath === boardPath(project.id) ? new Map(board.data.statuses.map((status) => [status.id, status.count])) : null;
  const statuses = [...project.statuses].sort((a, b) => a.position - b.position);
  const boardUrl = `/w/${workspace.slug}/p/${encodeURIComponent(project.key)}`;
  const periods = plan.data ? [...(plan.data.periods ?? [])].reverse() : null;

  const onSwitched = (result: SwitchResult) => {
    setSwitching(false);
    replaceProject(result.project);
    const moved = result.movedIssues;
    notify(`Switched to ${methodologyName(result.project.methodology)}. ${moved} ${moved === 1 ? "card" : "cards"} moved.`);
    router.push(boardUrl);
  };

  return (
    <section aria-label="Settings" className="wsPlan wsSettings">
      {!planner && (
        <p className="wsBacklogReadOnly" role="note">
          <svg aria-hidden="true" viewBox="0 0 24 24"><rect height="9" rx="2" width="14" x="5" y="11" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
          {PLAN_AUTHORITY_MESSAGE}
        </p>
      )}

      {planner && (
        <section aria-labelledby="settings-general-title" className="wsCard wsSettingsCard">
          <header className="wsCardHeader">
            <div>
              <h2 id="settings-general-title">General</h2>
              <p>Name, description, lead and dates.</p>
            </div>
          </header>
          <ProjectSettingsForm
            etag={etag}
            key={project.id}
            onSaved={(saved, nextEtag) => {
              replaceProject(saved, nextEtag);
              notify("Project settings saved.");
            }}
            onStale={(current) => replaceProject(current)}
            project={project}
            workspace={workspace}
          />
        </section>
      )}

      <section aria-labelledby="settings-columns-title" className="wsCard wsSettingsCard">
        <header className="wsCardHeader">
          <div>
            <h2 id="settings-columns-title">Board columns</h2>
            <p>{planner ? "Rename columns and set work-in-progress limits. A limit can't be below the cards already in the column." : "The board's columns, their cards and WIP limits."}</p>
          </div>
        </header>
        {board.error && !board.data && (
          <p className="wsBoardBanner wsTimelineNote" role="alert">
            <span>Card counts couldn&apos;t load. {board.error}</span>
            <button className="wsGhostButton" onClick={board.reload} type="button">Try again</button>
          </p>
        )}
        <div className="wsSettingsColumns">
          {statuses.map((status) => planner
            ? <ColumnRow cards={counts?.get(status.id) ?? null} etag={etag} key={status.id} onSaved={(saved, nextEtag) => { replaceProject(saved, nextEtag); notify(`${saved.statuses.find((item) => item.id === status.id)?.name ?? status.name} saved.`); }} onStale={replaceProject} projectId={project.id} status={status} />
            : <ReadOnlyColumn cards={counts?.get(status.id) ?? null} key={status.id} status={status} />)}
        </div>
      </section>

      <section aria-labelledby="settings-methodology-title" className="wsCard wsSettingsCard">
        <header className="wsCardHeader">
          <div>
            <h2 id="settings-methodology-title">Methodology</h2>
            <p>
              {project.name} uses <span className="wsMethodPill" data-methodology={methodologyOf(project.methodology)}>{methodologyName(project.methodology)}</span>
            </p>
          </div>
          {planner && <button className="sparkSecondary" data-switch-methodology onClick={() => setSwitching(true)} type="button">Switch methodology</button>}
        </header>
        {periods
          ? <ol aria-label="Methodology history" className="wsSettingsPeriods">
              {periods.map((period) => <li data-current={period.endedAt === null || undefined} key={`${period.startedAt}-${period.methodology}`}>{periodLabel(period)}</li>)}
            </ol>
          : plan.error && !plan.loading
            ? <p className="wsAlert wsInlineAlert" role="alert">The history couldn&apos;t load. {plan.error} <button className="textButton" onClick={plan.reload} type="button">Try again</button></p>
            : <p className="wsProjectMuted" role="status">Loading history…</p>}
      </section>

      {planner && switching && (
        <SwitchWizard
          backlogHref={`${boardUrl}/backlog`}
          counts={counts}
          etag={etag}
          onClose={() => setSwitching(false)}
          onStale={(current) => {
            replaceProject(current);
            board.reload();
          }}
          onSwitched={onSwitched}
          onWipRefused={board.reload}
          project={project}
        />
      )}
    </section>
  );
}

function ReadOnlyColumn({ status, cards }: { status: ProjectStatus; cards: number | null }) {
  return (
    <div aria-label={`Column ${status.name}`} className="wsSettingsColumn" data-readonly role="group">
      <strong className="wsSettingsColumnName">{status.name}</strong>
      <span className="wsPickerColumn" data-category={status.category}>{categoryLabel(status.category)}</span>
      <span className="wsSettingsCards">{cards === null ? "Cards —" : cardCountLabel(cards)}</span>
      <span className="wsSettingsWip">{status.wipLimit === null ? "No limit" : `WIP ${status.wipLimit}`}</span>
    </div>
  );
}

/** One column's name and WIP limit with its own Save; a refused limit goes back to the saved one. */
function ColumnRow({ projectId, status, etag, cards, onSaved, onStale }: {
  projectId: string;
  status: ProjectStatus;
  etag: string;
  cards: number | null;
  onSaved(project: ProjectDetail, etag: string): void;
  onStale(project: ProjectDetail): void;
}) {
  const saved = { name: status.name, wip: status.wipLimit === null ? "" : String(status.wipLimit) };
  const [draft, setDraft] = useState<typeof saved | null>(null);
  const [error, setError] = useState<{ field: "name" | "wip" | "row"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const values = draft ?? saved;
  const errorId = `column-${status.id}-error`;

  const change = (patch: Partial<typeof saved>) => {
    setDraft({ ...values, ...patch });
    setError(null);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const nameProblem = columnNameProblem(values.name);
    if (nameProblem) {
      setError({ field: "name", text: nameProblem });
      return;
    }
    const wipLimit = parseWipLimit(values.wip);
    if (wipLimit === undefined) {
      setError({ field: "wip", text: WIP_RULE });
      return;
    }
    const patch: StatusPatch = {};
    if (values.name.trim() !== status.name) patch.name = values.name.trim();
    if (wipLimit !== status.wipLimit) patch.wipLimit = wipLimit;
    if (Object.keys(patch).length === 0) {
      setDraft(null);
      setError(null);
      return;
    }
    setSaving(true);
    try {
      const result = await updateStatus(projectId, status.id, etag, patch);
      setDraft(null);
      setError(null);
      onSaved(result.project, result.etag);
    } catch (failure) {
      const code = failure instanceof ApiError ? failure.code : null;
      const current = failure instanceof ApiError && failure.status === 412 ? (failure.body as { current?: ProjectDetail } | null)?.current : undefined;
      if (current) {
        setDraft(null);
        setError({ field: "row", text: TEAMMATE_UPDATE });
        onStale(current);
      } else if (code === "wip_below_occupancy") {
        // Nothing was saved: the limit shows the saved value again.
        setDraft({ ...values, wip: saved.wip });
        setError({ field: "wip", text: messageOf(failure) });
      } else {
        setError({ field: code === "name_taken" ? "name" : "row", text: messageOf(failure) });
      }
    } finally {
      setSaving(false);
    }
  };

  const nameInvalid = error?.field === "name" || undefined;
  const wipInvalid = error?.field === "wip" || undefined;
  return (
    <form aria-busy={saving || undefined} aria-label={`Column ${status.name}`} className="wsSettingsColumn" noValidate onSubmit={onSubmit} role="group">
      <div className="wsField wsSettingsColumnField">
        <label htmlFor={`column-${status.id}-name`}>Column name</label>
        <input
          aria-describedby={nameInvalid ? errorId : undefined}
          aria-invalid={nameInvalid}
          autoComplete="off"
          id={`column-${status.id}-name`}
          maxLength={COLUMN_NAME_MAX}
          onChange={(event) => change({ name: event.target.value })}
          value={values.name}
        />
      </div>
      <span className="wsPickerColumn" data-category={status.category}>{categoryLabel(status.category)}</span>
      <span className="wsSettingsCards">{cards === null ? "Cards —" : cardCountLabel(cards)}</span>
      <div className="wsField wsSettingsWipField">
        <label htmlFor={`column-${status.id}-wip`}>WIP limit</label>
        <input
          aria-describedby={wipInvalid ? errorId : undefined}
          aria-invalid={wipInvalid}
          id={`column-${status.id}-wip`}
          inputMode="numeric"
          max={WIP_LIMIT_MAX}
          min={1}
          onChange={(event) => change({ wip: event.target.value })}
          placeholder="No limit"
          type="number"
          value={values.wip}
        />
      </div>
      <button aria-label={`Save ${status.name}`} className="sparkSecondary wsSettingsSave" disabled={saving} type="submit">{saving ? "Saving…" : "Save"}</button>
      {error && <p className={error.field === "row" && error.text === TEAMMATE_UPDATE ? "wsConflict wsSettingsColumnError" : "wsFieldError wsSettingsColumnError"} id={errorId} role="alert">{error.text}</p>}
    </form>
  );
}
