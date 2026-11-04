"use client";

import { useEffect, useRef, useState } from "react";

import { initials } from "../../../components";
import { Modal } from "../../_components/modal";
import { ApiError, messageOf, workspaceApi } from "../../_lib/api";
import { RESPONSE_LABELS, eventEtag, formatEventRange, type CalendarEvent } from "../../_lib/schedule";
import { EVENT_CANCELLED } from "./event-dialog";

const EVENT_RELOADED = "Updated by a teammate. The event was reloaded; check it and try again.";

const ANSWERS = [
  { response: "accepted", label: "Accept" },
  { response: "tentative", label: "Maybe" },
  { response: "declined", label: "Decline" },
] as const;

export interface EventDetailsProps {
  event: CalendarEvent;
  /** The signed-in user. */
  me: string | null;
  /** The viewer's time zone. */
  tz: string;
  onClose(): void;
  onEdit(): void;
  /** The event as it should show now (optimistic answers, a teammate's version). */
  onChange(event: CalendarEvent): void;
  /** Something changed on the server: reload the week. */
  onStale(): void;
  /** The event was cancelled by this user. */
  onCancelled(): void;
}

/** One event in full: answers for invitees (Accept / Maybe / Decline) and Edit / Cancel event for those who may change it. */
export function EventDetails({ event, me, tz, onClose, onEdit, onChange, onStale, onCancelled }: EventDetailsProps) {
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const answering = useRef(false);
  const [answerBusy, setAnswerBusy] = useState(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const confirmed = useRef(false);

  // Moving between the action row and the confirmation must not drop focus to the page.
  useEffect(() => {
    if (!confirmed.current && !confirming) return;
    confirmed.current = true;
    (confirming ? keepButton : cancelButton).current?.focus();
  }, [confirming]);
  const cancelled = event.status === "cancelled";
  const invited = event.myResponse !== null && !cancelled;
  const crossZone = event.timezone !== tz;

  const answer = async (response: (typeof ANSWERS)[number]["response"]) => {
    if (answering.current || event.myResponse === response) return;
    answering.current = true;
    setAnswerBusy(true);
    setError(null);
    const before = event;
    onChange({ ...event, myResponse: response, attendees: event.attendees.map((attendee) => (attendee.user.id === me ? { ...attendee, response } : attendee)) });
    try {
      const { data } = await workspaceApi<CalendarEvent>(`/calendar-events/${encodeURIComponent(event.id)}/attendees/me`, { method: "PUT", body: { response } });
      onChange(data);
      onStale();
    } catch (problem) {
      onChange(before);
      if (problem instanceof ApiError && problem.status === 409) {
        setError(EVENT_CANCELLED);
        onStale();
      } else {
        setError(messageOf(problem));
      }
    } finally {
      answering.current = false;
      setAnswerBusy(false);
    }
  };

  const cancelEvent = async () => {
    if (cancelling) return;
    setCancelling(true);
    setError(null);
    try {
      // The command takes no input: an empty JSON object, never an empty body that claims to be JSON.
      await workspaceApi<CalendarEvent>(`/calendar-events/${encodeURIComponent(event.id)}/cancel`, { method: "POST", body: {}, ifMatch: eventEtag(event.version) });
      onCancelled();
    } catch (problem) {
      setCancelling(false);
      setConfirming(false);
      if (problem instanceof ApiError && problem.status === 412) {
        const current = (problem.body as { current?: CalendarEvent } | null)?.current;
        if (current && typeof current.id === "string") onChange(current);
        setError(EVENT_RELOADED);
        onStale();
      } else if (problem instanceof ApiError && problem.status === 409) {
        setError(EVENT_CANCELLED);
        onChange({ ...event, status: "cancelled", canEdit: false });
        onStale();
      } else {
        setError(messageOf(problem));
      }
    }
  };

  return (
    <Modal busy={cancelling} onClose={onClose} title={event.title} variant="wide">
      <div className="wsEventDetails">
        {cancelled && <p className="wsSchedBadge wsEventCancelledBadge" data-tone="cancelled">Cancelled</p>}
        <p className="wsEventWhen">
          <time dateTime={event.startsAt}>{formatEventRange(event, tz)}</time>
          {crossZone && <small>{formatEventRange(event, event.timezone)} in {event.timezone}</small>}
        </p>
        <dl className="wsEventFacts">
          <div><dt>Organizer</dt><dd>{event.organizer.displayName}</dd></div>
          {event.location && <div><dt>Location</dt><dd>{event.location}</dd></div>}
          {event.project && <div><dt>Project</dt><dd>{event.project.key} · {event.project.name}</dd></div>}
          {event.issue && <div><dt>Task</dt><dd>{event.issue.key} {event.issue.title}</dd></div>}
        </dl>
        {event.description && <p className="wsEventDescription">{event.description}</p>}

        <div className="wsEventAttendees">
          <h3>Attendees</h3>
          <ul aria-label="Attendees" className="wsEventPeopleList">
            {event.attendees.map((attendee) => (
              <li key={attendee.user.id}>
                <span aria-hidden="true" className="avatar tiny">{initials(attendee.user.displayName, "?")}</span>
                <span className="wsEventPerson">{attendee.user.displayName}</span>
                <span className="wsSchedBadge" data-response={attendee.response}>{RESPONSE_LABELS[attendee.response] ?? attendee.response}</span>
              </li>
            ))}
          </ul>
        </div>

        {invited && (
          <div aria-label="Your response" className="wsEventRsvp" role="group">
            {ANSWERS.map(({ response, label }) => (
              <button aria-pressed={event.myResponse === response} className="wsEventAnswer" aria-disabled={answerBusy || undefined} data-response={response} key={response} onClick={() => void answer(response)} type="button">{label}</button>
            ))}
          </div>
        )}

        {error && <p className="wsAlert" role="alert">{error}</p>}

        {event.canEdit && !confirming && (
          <div className="wsModalActions">
            <button className="sparkSecondary" onClick={() => setConfirming(true)} ref={cancelButton} type="button">Cancel event</button>
            <button className="sparkPrimary" onClick={onEdit} type="button">Edit</button>
          </div>
        )}
        {event.canEdit && confirming && (
          <div aria-label="Confirm cancellation" className="wsEventConfirm" role="group">
            <p>Cancel this event? Everyone invited is told it was cancelled. This cannot be undone.</p>
            <div className="wsModalActions">
              <button className="sparkSecondary" disabled={cancelling} onClick={() => setConfirming(false)} ref={keepButton} type="button">Keep event</button>
              <button className="wsDangerButton" disabled={cancelling} onClick={() => void cancelEvent()} type="button">{cancelling ? "Cancelling…" : "Yes, cancel event"}</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
