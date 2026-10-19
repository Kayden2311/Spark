"use client";

import { useState, type FormEvent } from "react";

import { initials } from "../../../../components";
import { Modal } from "../../../_components/modal";
import { ApiError, messageOf, workspaceApi, type WorkspaceMember } from "../../../_lib/api";
import { wipBlocked, wipMessage } from "../../../_lib/board-moves";
import { describeEvent, timeAgo, type IssueEvent, type IssueEventPage } from "../../../_lib/issue-history";
import { issueEtag, priorityLabel, typeLabel, type BoardState, type IssueDetail } from "../../../_lib/issues";
import { methodologyOf, type ProjectDetail } from "../../../_lib/projects";
import { useWorkspaceData } from "../../../_lib/use-workspace-data";
import { useProject } from "./project-context";
import { TEAMMATE_UPDATE } from "./settings-dialog";

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 10000;
const TYPES = ["task", "bug", "story"] as const;
const PRIORITIES = ["highest", "high", "medium", "low", "lowest"] as const;
const INVALID_ASSIGNEE = "The assignee must be an active member of the workspace.";
const POINTS_ERROR = "Use a number from 0 to 100 with at most two decimals.";
const DUE_ERROR = "Pick a date between 2000 and 2100.";
export const TASK_GONE = "That task no longer exists.";

interface Values {
  title: string;
  description: string;
  statusId: string;
  assignee: string;
  type: string;
  priority: string;
  storyPoints: string;
  dueDate: string;
  phaseId: string;
}

type FieldErrors = Partial<Record<"title" | "statusId" | "assignee" | "storyPoints" | "dueDate", string>>;

function valuesOf(issue: IssueDetail): Values {
  return {
    title: issue.title,
    description: issue.description ?? "",
    statusId: issue.statusId,
    assignee: issue.assignee?.id ?? "",
    type: issue.type,
    priority: issue.priority,
    storyPoints: issue.storyPoints === null ? "" : String(issue.storyPoints),
    dueDate: issue.dueDate ?? "",
    phaseId: issue.phaseId ?? "",
  };
}

/** Story points as the API takes them: null when empty, undefined when malformed or out of range. */
function parsePoints(text: string): number | null | undefined {
  const value = text.trim();
  if (value === "") return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/u.test(value)) return undefined;
  const points = Number(value);
  return points <= 100 ? points : undefined;
}

/** Only the fields that differ from the version the drawer shows; fields of other methodologies are never sent. */
function changes(values: Values, base: IssueDetail, methodology: string): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const title = values.title.trim();
  const description = values.description.trim();
  if (title !== base.title) body.title = title;
  if (description !== (base.description ?? "").trim()) body.description = description || null;
  if (values.statusId !== base.statusId) body.statusId = values.statusId;
  if ((values.assignee || null) !== (base.assignee?.id ?? null)) body.assigneeUserId = values.assignee || null;
  if (values.type !== base.type) body.type = values.type;
  if (values.priority !== base.priority) body.priority = values.priority;
  if (methodology === "scrum") {
    const points = parsePoints(values.storyPoints);
    if (points !== undefined && points !== base.storyPoints) body.storyPoints = points;
  }
  if ((values.dueDate || null) !== base.dueDate) body.dueDate = values.dueDate || null;
  if (methodology === "waterfall" && (values.phaseId || null) !== base.phaseId) body.phaseId = values.phaseId || null;
  return body;
}

/**
 * The task drawer: edits one task with optimistic concurrency (If-Match; a 412 swaps in the teammate's
 * newer values), archives it after a confirmation and tells its history.
 */
export function TaskDrawer({ issueId, issueKey, board, project, workspaceId, onClose, onChanged, onArchived }: {
  issueId: string;
  issueKey: string;
  /** The committed board, for status names and WIP limits. */
  board: BoardState;
  project: ProjectDetail;
  workspaceId: string;
  onClose(): void;
  /** A newer version of the task (saved here or seen on 412) for the board's card. */
  onChanged(issue: IssueDetail): void;
  onArchived(issue: IssueDetail): void;
}) {
  const { notify } = useProject();
  const loaded = useWorkspaceData<IssueDetail>(`/issues/${encodeURIComponent(issueId)}`);
  const members = useWorkspaceData<{ items: WorkspaceMember[] }>(`/workspaces/${encodeURIComponent(workspaceId)}/members`);
  // A save or a teammate's version seen on 412 replaces the loaded copy.
  const [latest, setLatest] = useState<IssueDetail | null>(null);
  const base = latest ?? loaded.data;
  const [edits, setEdits] = useState<{ base: IssueDetail; values: Values } | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const methodology = methodologyOf(project.methodology);
  const events = useHistory(issueId);

  let content;
  if (!base) {
    content = loaded.error && !loaded.loading ? (
      <div className="wsDrawerState">
        <p role="alert">{loaded.errorStatus === 404 ? TASK_GONE : loaded.error}</p>
        {loaded.errorStatus !== 404 && <button className="sparkSecondary" onClick={loaded.reload} type="button">Try again</button>}
      </div>
    ) : (
      <div aria-busy="true" className="wsDrawerSkeleton" role="status">
        <span className="wsSrOnly">Loading task…</span>
        <span /><span /><span />
      </div>
    );
  } else {
    const values = edits && edits.base === base ? edits.values : valuesOf(base);
    const memberList = members.data?.items ?? [];
    const assigneeMissing = values.assignee !== "" && !memberList.some((member) => member.userId === values.assignee);

    const update = (patch: Partial<Values>, clear?: keyof FieldErrors) => {
      setEdits({ base, values: { ...values, ...patch } });
      setFormError(null);
      if (clear) setErrors((current) => ({ ...current, [clear]: undefined }));
    };

    /** Replaces the form with a newer version of the task (after a save or a teammate's change). */
    const adopt = (next: IssueDetail) => {
      setLatest(next);
      setEdits(null);
      setErrors({});
      onChanged(next);
    };

    const fail = (error: unknown, body: Record<string, unknown>): void => {
      const current = error instanceof ApiError && error.status === 412 ? (error.body as { current?: IssueDetail } | null)?.current : undefined;
      if (current) {
        adopt(current);
        setConflict(true);
        setConfirming(false);
        return;
      }
      setConflict(false);
      const code = error instanceof ApiError ? error.code : null;
      if (code === "wip_limit_reached" && "statusId" in body) {
        const status = board.statuses.find((item) => item.id === body.statusId);
        setErrors({ statusId: wipMessage(status, error instanceof ApiError ? error.message : undefined) });
      } else if (code === "invalid_assignee") {
        setErrors({ assignee: INVALID_ASSIGNEE });
      } else {
        setFormError(messageOf(error));
      }
    };

    const onSubmit = async (event: FormEvent) => {
      event.preventDefault();
      if (saving) return;
      const found: FieldErrors = {};
      if (values.title.trim() === "") found.title = "Give the task a title.";
      if (methodology === "scrum" && parsePoints(values.storyPoints) === undefined) found.storyPoints = POINTS_ERROR;
      if (values.dueDate && (values.dueDate < "2000-01-01" || values.dueDate > "2100-12-31")) found.dueDate = DUE_ERROR;
      setErrors(found);
      setFormError(null);
      if (Object.keys(found).length > 0) return;

      const body = changes(values, base, methodology);
      if (Object.keys(body).length === 0) {
        onClose();
        return;
      }
      setSaving(true);
      try {
        const { data } = await workspaceApi<IssueDetail>(`/issues/${encodeURIComponent(base.id)}`, { method: "PATCH", body, ifMatch: issueEtag(base.version) });
        setConflict(false);
        adopt(data);
        events.reload();
        notify(`Saved ${data.key}.`);
      } catch (error) {
        fail(error, body);
      } finally {
        setSaving(false);
      }
    };

    const archive = async () => {
      if (saving) return;
      setSaving(true);
      try {
        const { data } = await workspaceApi<IssueDetail>(`/issues/${encodeURIComponent(base.id)}`, { method: "PATCH", body: { archived: true }, ifMatch: issueEtag(base.version) });
        setSaving(false);
        onArchived(data);
        notify(`Archived ${data.key}.`);
      } catch (error) {
        setSaving(false);
        setConfirming(false);
        fail(error, { archived: true });
      }
    };

    const fieldProps = (name: keyof FieldErrors) => ({
      "aria-describedby": errors[name] ? `drawer-${name}-error` : undefined,
      "aria-invalid": errors[name] ? true : undefined,
    });
    const fieldError = (name: keyof FieldErrors) => errors[name] && <p className="wsFieldError" id={`drawer-${name}-error`} role="alert">{errors[name]}</p>;

    content = (
      <form className="wsDrawerForm" noValidate onSubmit={onSubmit}>
        {conflict && <p className="wsConflict" role="alert">{TEAMMATE_UPDATE}</p>}

        <div className="wsField">
          <label htmlFor="drawer-title">Title</label>
          <textarea
            {...fieldProps("title")}
            className="wsProjectTextarea wsDrawerTitle"
            id="drawer-title"
            maxLength={TITLE_MAX}
            onChange={(event) => update({ title: event.target.value.replace(/\n/gu, " ") }, "title")}
            rows={1}
            value={values.title}
          />
          {fieldError("title")}
        </div>

        <div className="wsField">
          <label htmlFor="drawer-description">Description</label>
          <textarea
            className="wsProjectTextarea"
            id="drawer-description"
            maxLength={DESCRIPTION_MAX}
            onChange={(event) => update({ description: event.target.value })}
            placeholder="Add details, links or acceptance criteria. Optional."
            rows={4}
            value={values.description}
          />
        </div>

        <div className="wsDrawerGrid">
          <div className="wsField">
            <label htmlFor="drawer-status">Status</label>
            <select {...fieldProps("statusId")} className="wsSelect" id="drawer-status" onChange={(event) => update({ statusId: event.target.value }, "statusId")} value={values.statusId}>
              {board.statuses.map((status) => {
                const full = status.id !== base.statusId && wipBlocked(board, base.id, status.id);
                return <option disabled={full} key={status.id} value={status.id}>{full ? `${status.name} (full)` : status.name}</option>;
              })}
            </select>
            {fieldError("statusId")}
          </div>

          <div className="wsField">
            <label htmlFor="drawer-assignee">Assignee</label>
            <select {...fieldProps("assignee")} className="wsSelect" disabled={!members.data && !members.error} id="drawer-assignee" onChange={(event) => update({ assignee: event.target.value }, "assignee")} value={values.assignee}>
              <option value="">Unassigned</option>
              {assigneeMissing && <option value={values.assignee}>{base.assignee?.id === values.assignee ? base.assignee.displayName : "Current assignee"}</option>}
              {memberList.map((member) => <option key={member.userId} value={member.userId}>{member.displayName}</option>)}
            </select>
            {errors.assignee
              ? fieldError("assignee")
              : members.error && <p className="wsFieldHint">Members couldn&apos;t be loaded, so only Unassigned is offered.</p>}
          </div>

          <div className="wsField">
            <label htmlFor="drawer-type">Type</label>
            <select className="wsSelect" id="drawer-type" onChange={(event) => update({ type: event.target.value })} value={values.type}>
              {TYPES.map((type) => <option key={type} value={type}>{typeLabel(type)}</option>)}
            </select>
          </div>

          <div className="wsField">
            <label htmlFor="drawer-priority">Priority</label>
            <select className="wsSelect" id="drawer-priority" onChange={(event) => update({ priority: event.target.value })} value={values.priority}>
              {PRIORITIES.map((priority) => <option key={priority} value={priority}>{priorityLabel(priority)}</option>)}
            </select>
          </div>

          {methodology === "scrum" && (
            <div className="wsField">
              <label htmlFor="drawer-points">Story points</label>
              <input {...fieldProps("storyPoints")} autoComplete="off" id="drawer-points" inputMode="decimal" onChange={(event) => update({ storyPoints: event.target.value }, "storyPoints")} placeholder="Not estimated" value={values.storyPoints} />
              {fieldError("storyPoints")}
            </div>
          )}

          <div className="wsField">
            <label htmlFor="drawer-due">Due date</label>
            <input {...fieldProps("dueDate")} id="drawer-due" max="2100-12-31" min="2000-01-01" onChange={(event) => update({ dueDate: event.target.value }, "dueDate")} type="date" value={values.dueDate} />
            {fieldError("dueDate")}
          </div>

          {methodology === "waterfall" && (
            <div className="wsField">
              <label htmlFor="drawer-phase">Phase</label>
              <select className="wsSelect" id="drawer-phase" onChange={(event) => update({ phaseId: event.target.value })} value={values.phaseId}>
                <option value="">No phase</option>
                {project.phases.map((phase) => <option key={phase.id} value={phase.id}>{phase.name}</option>)}
              </select>
            </div>
          )}
        </div>

        {formError && <p className="wsAlert" role="alert">{formError}</p>}

        {confirming ? (
          <div className="wsDrawerConfirm" role="group" aria-labelledby="drawer-archive-title">
            <p id="drawer-archive-title"><strong>Archive {base.key}?</strong> It leaves the board and stops counting toward progress. Its history is kept.</p>
            <div className="wsModalActions">
              <button className="sparkSecondary" disabled={saving} onClick={() => setConfirming(false)} type="button">Keep task</button>
              <button className="wsDangerButton" disabled={saving} onClick={() => void archive()} type="button">{saving ? "Archiving…" : "Yes, archive"}</button>
            </div>
          </div>
        ) : (
          <div className="wsDrawerActions">
            <button className="wsDrawerArchive" disabled={saving} onClick={() => setConfirming(true)} type="button">
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M6 7v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7M9 4h6M10 11v5M14 11v5" /></svg>
              Archive task
            </button>
            <button className="sparkPrimary" disabled={saving} type="submit">{saving ? "Saving…" : "Save"}</button>
          </div>
        )}
      </form>
    );
  }

  const statusName = (id: string) => board.statuses.find((status) => status.id === id)?.name;
  const memberName = (id: string) => members.data?.items.find((member) => member.userId === id)?.displayName ?? (base?.assignee?.id === id ? base.assignee.displayName : undefined);
  const phaseName = (id: string) => project.phases.find((phase) => phase.id === id)?.name;
  return (
    <Modal busy={saving} onClose={onClose} title={issueKey} variant="drawer">
      {content}
      <section aria-labelledby="drawer-history-title" className="wsDrawerHistory">
        <h3 id="drawer-history-title">History</h3>
        {events.error && events.items.length === 0 ? (
          <p className="wsFieldHint" role="alert">{events.error}</p>
        ) : (
          <ol aria-busy={events.loading || undefined} aria-label="History" className="wsHistoryList">
            {events.items.map((event) => (
              <li key={event.id}>
                <span aria-hidden="true" className="avatar tiny">{initials(event.actor?.displayName ?? "", "?")}</span>
                <p>{describeEvent(event, { status: statusName, member: memberName, phase: phaseName })}</p>
                <time dateTime={event.createdAt} title={new Date(event.createdAt).toLocaleString("en")}>{timeAgo(event.createdAt)}</time>
              </li>
            ))}
          </ol>
        )}
        {events.moreError && <p className="wsFieldHint" role="alert">{events.moreError}</p>}
        {events.nextCursor && (
          <button className="sparkSecondary wsHistoryMore" disabled={events.loadingMore} onClick={() => void events.loadMore()} type="button">
            {events.loadingMore ? "Loading…" : "Load more"}
          </button>
        )}
      </section>
    </Modal>
  );
}

/** The first page of a task's history (reloadable after a save) plus the pages "Load more" appended to it. */
function useHistory(issueId: string) {
  const first = useWorkspaceData<IssueEventPage>(`/issues/${encodeURIComponent(issueId)}/events`);
  const [more, setMore] = useState<{ source: IssueEventPage; items: IssueEvent[]; nextCursor: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const page = first.data;
  const extra = page && more?.source === page ? more : null;
  const nextCursor = extra ? extra.nextCursor : page?.nextCursor ?? null;

  const loadMore = async () => {
    if (!page || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const { data } = await workspaceApi<IssueEventPage>(`/issues/${encodeURIComponent(issueId)}/events?cursor=${encodeURIComponent(nextCursor)}`);
      setMore({ source: page, items: [...(extra?.items ?? []), ...data.items], nextCursor: data.nextCursor });
    } catch (error) {
      setMoreError(messageOf(error));
    } finally {
      setLoadingMore(false);
    }
  };

  return {
    items: [...(page?.items ?? []), ...(extra?.items ?? [])],
    nextCursor,
    loading: first.loading,
    error: first.error,
    loadingMore,
    moreError,
    loadMore,
    reload: first.reload,
  };
}
