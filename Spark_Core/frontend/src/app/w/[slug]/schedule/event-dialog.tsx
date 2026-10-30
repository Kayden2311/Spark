"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";

import { initials } from "../../../components";
import { Modal } from "../../_components/modal";
import { ApiError, messageOf, workspaceApi, type WorkspaceMember } from "../../_lib/api";
import { boardPath, type BoardState } from "../../_lib/issues";
import type { Project } from "../../_lib/projects";
import {
  createEventBody,
  eventEtag,
  eventPatchBody,
  formValuesOf,
  overlapCount,
  validateEventForm,
  viewerZone,
  wallClockInstant,
  zoneChoices,
  type CalendarEvent,
  type EventField,
  type EventFormValues,
} from "../../_lib/schedule";
import { useWorkspaceData } from "../../_lib/use-workspace-data";

export const UPDATED_BY_TEAMMATE = "Updated by a teammate. The event was reloaded with their changes; review it and save again.";
export const EVENT_CANCELLED = "This event was cancelled";

type FieldErrors = Partial<Record<EventField, string>>;

const FIELD_OF_DETAIL: Record<string, EventField> = {
  title: "title",
  description: "description",
  location: "location",
  time: "time",
  timezone: "timezone",
  project: "project",
  issue: "issue",
  attendees: "attendees",
};

/** Which field a 400 detail such as "Invalid event title" is about. */
function fieldOfDetail(message: string): EventField | null {
  const match = /^Invalid event (\w+)/u.exec(message);
  return match ? FIELD_OF_DETAIL[match[1]] ?? null : null;
}

export interface EventDialogProps {
  workspaceId: string;
  /** The signed-in user. */
  me: string | null;
  /** `edit` needs `event`. */
  mode: "create" | "edit";
  event?: CalendarEvent;
  /** The day a new event starts on (YYYY-MM-DD). */
  day: string;
  projects: Project[];
  /** The loaded week, for the overlap note. */
  calendarEvents: CalendarEvent[];
  onClose(): void;
  /** The server accepted the write. */
  onSaved(event: CalendarEvent): void;
  /** The schedule behind the dialog changed (reload it). */
  onStale(): void;
}

/** Create or edit one event. Edits send only what changed, with If-Match; a stale version reloads the event into the form. */
export function EventDialog(props: EventDialogProps) {
  const { workspaceId, mode, onClose, onStale } = props;
  const members = useWorkspaceData<{ items: WorkspaceMember[] }>(`/workspaces/${workspaceId}/members`);
  // The event the form edits; a 412 swaps in the teammate's version and remounts the form.
  const [base, setBase] = useState<CalendarEvent | undefined>(props.event);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ready = mode === "create" || members.data !== null || members.error !== null;

  return (
    <Modal busy={saving} onClose={onClose} title={mode === "create" ? "New event" : "Edit event"} variant="wide">
      {ready ? (
        <EventForm
          {...props}
          base={base}
          key={base?.version ?? 0}
          members={members.data?.items ?? null}
          membersError={members.error}
          notice={notice}
          onSavingChange={setSaving}
          onStaleEvent={(current) => {
            setBase(current);
            setNotice(UPDATED_BY_TEAMMATE);
            onStale();
          }}
        />
      ) : (
        <div aria-busy="true" className="wsEventLoading" role="status">Loading people…</div>
      )}
    </Modal>
  );
}

function EventForm({ workspaceId, me, mode, base, day, projects, calendarEvents, members, membersError, notice, onClose, onSaved, onStale, onStaleEvent, onSavingChange }: EventDialogProps & {
  base: CalendarEvent | undefined;
  members: WorkspaceMember[] | null;
  membersError: string | null;
  notice: string | null;
  onSavingChange(saving: boolean): void;
  onStaleEvent(current: CalendarEvent): void;
}) {
  const titleInput = useRef<HTMLInputElement>(null);
  const zoneList = useId();
  const [viewer] = useState(viewerZone);
  const activeIds = useMemo(() => new Set((members ?? []).map((member) => member.userId)), [members]);
  // Edits start from the event as it is now; attendees who have left the workspace are dropped from the selection.
  const initial = useMemo<EventFormValues>(
    () => (base ? formValuesOf(base, activeIds) : { title: "", description: "", location: "", date: day, startTime: "09:00", endDate: day, endTime: "10:00", timezone: viewer, projectId: "", issueId: "", attendeeIds: [] }),
    // The starting point is fixed for the life of this form (a 412 remounts it with the new event).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [values, setValues] = useState<EventFormValues>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(notice);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (mode === "edit" || document.activeElement === document.body) titleInput.current?.focus();
  }, [mode]);

  const board = useWorkspaceData<BoardState>(values.projectId === "" ? null : boardPath(values.projectId));
  const doneStatuses = useMemo(() => new Set((board.data?.statuses ?? []).filter((status) => status.category === "done").map((status) => status.id)), [board.data]);
  const tasks = useMemo(() => {
    const open = (board.data?.issues ?? []).filter((issue) => !doneStatuses.has(issue.statusId)).map((issue) => ({ id: issue.id, label: `${issue.key} ${issue.title}` }));
    if (base?.issue && base.project?.id === values.projectId && !open.some((task) => task.id === base.issue?.id)) open.unshift({ id: base.issue.id, label: `${base.issue.key} ${base.issue.title}` });
    return open;
  }, [base, board.data, doneStatuses, values.projectId]);

  const zones = useMemo(() => zoneChoices(values.timezone, base?.timezone ?? viewer, viewer), [base, values.timezone, viewer]);
  const organizerId = base ? base.organizer.id : me;
  const people = (members ?? []).filter((member) => member.userId !== organizerId);

  const startMs = Date.parse(wallClockInstant(values.date, values.startTime, values.timezone) ?? "");
  const endMs = Date.parse(wallClockInstant(values.endDate, values.endTime, values.timezone) ?? "");
  const overlaps = endMs > startMs ? overlapCount(calendarEvents, me, startMs, endMs, base?.id ?? null) : 0;

  const change = (next: Partial<EventFormValues>, field?: EventField) => {
    setValues((current) => ({ ...current, ...next }));
    if (field) setErrors((current) => ({ ...current, [field]: undefined }));
    setFormError(null);
  };

  const onSubmit = async (submitted: FormEvent) => {
    submitted.preventDefault();
    if (saving) return;
    const checked = validateEventForm(values);
    setErrors(checked.errors);
    if (Object.keys(checked.errors).length > 0 || checked.startsAt === null || checked.endsAt === null) return;
    let request: { path: string; method: "POST" | "PATCH"; body: unknown; ifMatch?: string };
    if (base) {
      const patch = eventPatchBody(initial, values, checked.startsAt, checked.endsAt, members !== null);
      if (Object.keys(patch).length === 0) {
        setFormError("Nothing has changed.");
        return;
      }
      request = { path: `/calendar-events/${encodeURIComponent(base.id)}`, method: "PATCH", body: patch, ifMatch: eventEtag(base.version) };
    } else {
      request = { path: `/workspaces/${workspaceId}/calendar-events`, method: "POST", body: createEventBody(values, checked.startsAt, checked.endsAt) };
    }
    setFormError(null);
    setSaving(true);
    onSavingChange(true);
    try {
      const { data } = await workspaceApi<CalendarEvent>(request.path, { method: request.method, body: request.body, ifMatch: request.ifMatch });
      onSaved(data);
    } catch (problem) {
      setSaving(false);
      onSavingChange(false);
      await fail(problem);
    }
  };

  const fail = async (problem: unknown) => {
    if (problem instanceof ApiError) {
      if (problem.status === 412 && base) {
        const current = (problem.body as { current?: CalendarEvent } | null)?.current;
        if (current && typeof current.id === "string") {
          onStaleEvent(current);
          return;
        }
        try {
          const { data } = await workspaceApi<CalendarEvent>(`/calendar-events/${encodeURIComponent(base.id)}`);
          onStaleEvent(data);
        } catch {
          setFormError("Updated by a teammate. Close this and open the event again to see their changes.");
        }
        return;
      }
      if (problem.status === 409) {
        setFormError(problem.code === "event_cancelled" || problem.code === "event_already_cancelled" ? EVENT_CANCELLED : problem.message);
        onStale();
        return;
      }
      if (problem.status === 404) {
        setFormError("This event no longer exists.");
        onStale();
        return;
      }
      if (problem.status === 400) {
        const field = fieldOfDetail(problem.message);
        if (field) {
          setErrors({ [field]: problem.message });
          return;
        }
      }
    }
    setFormError(messageOf(problem));
  };

  const togglePerson = (id: string) =>
    change({ attendeeIds: values.attendeeIds.includes(id) ? values.attendeeIds.filter((item) => item !== id) : [...values.attendeeIds, id] }, "attendees");

  const projectOptions = projects.some((project) => project.id === base?.project?.id) || !base?.project ? projects.map((project) => ({ id: project.id, label: `${project.key} · ${project.name}` })) : [{ id: base.project.id, label: `${base.project.key} · ${base.project.name}` }, ...projects.map((project) => ({ id: project.id, label: `${project.key} · ${project.name}` }))];

  return (
    <form className="wsEventForm" noValidate onSubmit={onSubmit}>
      <div className="wsField">
        <label htmlFor="event-title">Title</label>
        <input aria-describedby={errors.title ? "event-title-error" : undefined} aria-invalid={errors.title ? true : undefined} autoComplete="off" data-autofocus id="event-title" maxLength={200} onChange={(event) => change({ title: event.target.value }, "title")} ref={titleInput} type="text" value={values.title} />
        {errors.title && <p className="wsFieldError" id="event-title-error">{errors.title}</p>}
      </div>

      <div className="wsEventTimes">
        <div className="wsField">
          <label htmlFor="event-date">Date</label>
          <input id="event-date" onChange={(event) => change({ date: event.target.value, endDate: values.endDate === values.date ? event.target.value : values.endDate }, "time")} required type="date" value={values.date} />
        </div>
        <div className="wsField">
          <label htmlFor="event-start">Start time</label>
          <input id="event-start" onChange={(event) => change({ startTime: event.target.value }, "time")} required type="time" value={values.startTime} />
        </div>
        <div className="wsField">
          <label htmlFor="event-end-date">End date</label>
          <input id="event-end-date" onChange={(event) => change({ endDate: event.target.value }, "time")} required type="date" value={values.endDate} />
        </div>
        <div className="wsField">
          <label htmlFor="event-end">End time</label>
          <input id="event-end" onChange={(event) => change({ endTime: event.target.value }, "time")} required type="time" value={values.endTime} />
        </div>
        {errors.time && <p className="wsFieldError wsEventWide" role="alert">{errors.time}</p>}
        {!errors.time && overlaps > 0 && <p className="wsEventNote wsEventWide" role="status">Overlaps with {overlaps} of your events</p>}
      </div>

      <div className="wsField">
        <label htmlFor="event-zone">Time zone</label>
        <input aria-describedby={errors.timezone ? "event-zone-error" : undefined} aria-invalid={errors.timezone ? true : undefined} autoComplete="off" id="event-zone" list={zoneList} onChange={(event) => change({ timezone: event.target.value.trim() }, "timezone")} spellCheck={false} type="text" value={values.timezone} />
        <datalist id={zoneList}>{zones.map((zone) => <option key={zone} value={zone} />)}</datalist>
        {errors.timezone && <p className="wsFieldError" id="event-zone-error">{errors.timezone}</p>}
      </div>

      <div className="wsField">
        <label htmlFor="event-location">Location</label>
        <input aria-describedby={errors.location ? "event-location-error" : undefined} aria-invalid={errors.location ? true : undefined} autoComplete="off" id="event-location" maxLength={200} onChange={(event) => change({ location: event.target.value }, "location")} type="text" value={values.location} />
        {errors.location && <p className="wsFieldError" id="event-location-error">{errors.location}</p>}
      </div>

      <div className="wsField">
        <label htmlFor="event-description">Description</label>
        <textarea aria-describedby={errors.description ? "event-description-error" : undefined} aria-invalid={errors.description ? true : undefined} id="event-description" maxLength={2000} onChange={(event) => change({ description: event.target.value }, "description")} rows={3} value={values.description} />
        {errors.description && <p className="wsFieldError" id="event-description-error">{errors.description}</p>}
      </div>

      <div className="wsEventPair">
        <div className="wsField">
          <label htmlFor="event-project">Project</label>
          <select aria-invalid={errors.project ? true : undefined} className="wsSelect" id="event-project" onChange={(event) => change({ projectId: event.target.value, issueId: "" }, "project")} value={values.projectId}>
            <option value="">No project</option>
            {projectOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          {errors.project && <p className="wsFieldError">{errors.project}</p>}
        </div>
        <div className="wsField">
          <label htmlFor="event-task">Task</label>
          <select aria-invalid={errors.issue ? true : undefined} className="wsSelect" disabled={values.projectId === ""} id="event-task" onChange={(event) => change({ issueId: event.target.value }, "issue")} value={values.issueId}>
            <option value="">{values.projectId !== "" && board.loading ? "Loading tasks…" : "No task"}</option>
            {tasks.map((task) => <option key={task.id} value={task.id}>{task.label}</option>)}
          </select>
          {errors.issue && <p className="wsFieldError">{errors.issue}</p>}
          {values.projectId !== "" && board.error && <p className="wsFieldHint">Tasks could not be loaded.</p>}
        </div>
      </div>

      <fieldset className="wsEventPeople">
        <legend>Attendees</legend>
        {members === null ? (
          <p className="wsFieldHint">{membersError ? "People could not be loaded. Attendees stay as they are." : "Loading people…"}</p>
        ) : people.length === 0 ? (
          <p className="wsFieldHint">No other people in this workspace yet.</p>
        ) : (
          <ul className="wsEventPeopleList">
            {people.map((member) => (
              <li key={member.userId}>
                <label>
                  <input checked={values.attendeeIds.includes(member.userId)} onChange={() => togglePerson(member.userId)} type="checkbox" />
                  <span aria-hidden="true" className="avatar tiny">{initials(member.displayName, "?")}</span>
                  <span>{member.displayName}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <p className="wsFieldHint">You are the organizer and always attend.</p>
        {errors.attendees && <p className="wsFieldError">{errors.attendees}</p>}
      </fieldset>

      {formError && <p className="wsAlert" role="alert">{formError}</p>}
      <div className="wsModalActions">
        <button className="sparkSecondary" disabled={saving} onClick={onClose} type="button">Cancel</button>
        <button className="sparkPrimary" disabled={saving} type="submit">{saving ? (base ? "Saving…" : "Creating…") : base ? "Save changes" : "Create event"}</button>
      </div>
    </form>
  );
}
