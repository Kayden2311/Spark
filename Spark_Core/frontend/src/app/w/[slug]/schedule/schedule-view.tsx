"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";

import { PageHeader } from "../../../_ui/page-header";
import { useAuth } from "../../../auth-context";
import { initials } from "../../../components";
import { useInsight } from "../../_components/insights/shared";
import { methodologyAccent } from "../../_lib/projects";
import {
  RESPONSE_LABELS,
  addDays,
  bucketWeek,
  calendarPath,
  dayOfInstant,
  formatEventTime,
  formatWeekLabel,
  mondayOf,
  parseWeekParam,
  viewerZone,
  weekBounds,
  type CalendarEvent,
  type CalendarResponse,
  type DayBucket,
  type Deadline,
} from "../../_lib/schedule";
import { useWorkspace } from "../workspace-context";
import { EventDetails } from "./event-details";
import { EventDialog } from "./event-dialog";

// The shell sidebar takes 264 px, so seven day columns need about 1280 px of window to stay readable.
const WIDE_QUERY = "(min-width: 1280px)";
const MAX_AVATARS = 3;
const dayLabel = new Intl.DateTimeFormat("en", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
const weekdayShort = new Intl.DateTimeFormat("en", { weekday: "short", timeZone: "UTC" });

const dayText = (day: string) => dayLabel.format(Date.parse(`${day}T00:00:00Z`));

function subscribeWide(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** True from 1280 px up (also without matchMedia), where the week grid replaces the agenda. */
function useWide(): boolean {
  return useSyncExternalStore(subscribeWide, () => (typeof window.matchMedia === "function" ? window.matchMedia(WIDE_QUERY).matches : true), () => true);
}

/** Sets or removes one query parameter without a navigation. */
function replaceParam(name: string, value: string | null) {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
}

function Chip({ deadline, slug }: { deadline: Deadline; slug: string }) {
  const projectBase = `/w/${slug}/p/${encodeURIComponent(deadline.project.key)}`;
  let href = projectBase;
  let kind = "Milestone";
  if (deadline.kind === "task_due") {
    href = deadline.issueId ? `${projectBase}?issue=${encodeURIComponent(deadline.issueId)}` : projectBase;
    kind = "Task due";
  } else if (deadline.kind === "sprint_end") {
    href = `${projectBase}/backlog`;
    kind = "Sprint ends";
  } else {
    href = `${projectBase}/timeline`;
  }
  return (
    <Link className="wsSchedChip" data-kind={deadline.kind} href={href} style={{ "--method-accent": methodologyAccent(deadline.project.methodology) } as CSSProperties}>
      <span aria-hidden="true" className="wsSchedChipMark" />
      <span className="wsSrOnly">{kind}: </span>
      <span className="wsKeyTag">{deadline.project.key}</span>
      <span className="wsSchedChipTitle">{deadline.title}</span>
    </Link>
  );
}

function EventCard({ day, event, onOpen, tz }: { day: string; event: CalendarEvent; onOpen(event: CalendarEvent): void; tz: string }) {
  const cancelled = event.status === "cancelled";
  const shown = event.attendees.slice(0, MAX_AVATARS);
  const more = event.attendees.length - shown.length;
  const response = event.myResponse ? RESPONSE_LABELS[event.myResponse] : null;
  return (
    <article className="wsSchedEvent" data-response={event.myResponse ?? undefined} data-status={event.status}>
      <time className="wsSchedTime" dateTime={event.startsAt}>{formatEventTime(event, day, tz)}</time>
      <h3 className="wsSchedTitle"><button aria-haspopup="dialog" className="wsSchedOpen" onClick={() => onOpen(event)} type="button">{event.title}</button></h3>
      {event.location && <p className="wsSchedPlace">{event.location}</p>}
      <div className="wsSchedMeta">
        {shown.length > 0 && (
          <span aria-label={`${event.attendees.length} invited`} className="wsSchedPeople" role="group">
            {shown.map((attendee) => <span aria-label={attendee.user.displayName} className="avatar tiny" key={attendee.user.id} role="img" title={attendee.user.displayName}>{initials(attendee.user.displayName, "?")}</span>)}
            {more > 0 && <span className="wsSchedMore">+{more}</span>}
          </span>
        )}
        {cancelled ? <span className="wsSchedBadge" data-tone="cancelled">Cancelled</span> : response && <span className="wsSchedBadge" data-response={event.myResponse ?? undefined}>{response}</span>}
      </div>
    </article>
  );
}

function DayItems({ bucket, onOpen, slug, tz }: { bucket: DayBucket; onOpen(event: CalendarEvent): void; slug: string; tz: string }) {
  return (
    <>
      {bucket.deadlines.length > 0 && (
        <ul aria-label="Deadlines" className="wsSchedChips">
          {bucket.deadlines.map((deadline, index) => <li key={`${deadline.kind}-${deadline.issueId ?? deadline.sprintId ?? deadline.milestoneId ?? index}`}><Chip deadline={deadline} slug={slug} /></li>)}
        </ul>
      )}
      {bucket.events.map((event) => <EventCard day={bucket.day} event={event} key={event.id} onOpen={onOpen} tz={tz} />)}
    </>
  );
}

function WeekSkeleton() {
  return (
    <div aria-busy="true" className="wsSchedSkeleton" role="status">
      <span className="wsSrOnly">Loading the week…</span>
      {Array.from({ length: 4 }, (_, index) => <span className="vizSkeleton" key={index} />)}
    </div>
  );
}

type DialogState = { kind: "create"; day: string } | { kind: "details"; event: CalendarEvent } | { kind: "edit"; event: CalendarEvent } | null;

/** The week view, with the event dialog (new, details and answers, edit) opened from it. */
export function ScheduleView() {
  const { workspace, projects } = useWorkspace();
  const { user } = useAuth();
  const wide = useWide();
  const [tz, setTz] = useState(viewerZone);
  const [zoneFallback, setZoneFallback] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const today = dayOfInstant(now, tz);
  const thisWeek = mondayOf(today);
  const [week, setWeek] = useState(() => parseWeekParam(new URLSearchParams(window.location.search).get("week")) ?? thisWeek);
  const [onlyMine, setOnlyMine] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const calendar = useInsight<CalendarResponse>(calendarPath(workspace.id, weekBounds(week, tz), tz));
  const { reload } = calendar;

  // A browser zone the server does not know (400 invalid_input) falls back to UTC with a note instead of a dead page.
  const zoneRejected = calendar.errorCode === "invalid_input" && tz !== "UTC";
  if (zoneRejected) {
    setTz("UTC");
    setZoneFallback(true);
  }

  // A teammate may have changed the schedule while this tab was in the background, and the day may have rolled over.
  // focus and visibilitychange usually fire together, so only the first one within a second reloads.
  const lastRefresh = useRef(0);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      const at = Date.now();
      if (at - lastRefresh.current < 1000) return;
      lastRefresh.current = at;
      setNow(at);
      reload();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [reload]);

  const goTo = (next: string) => {
    setWeek(next);
    replaceParam("week", next === thisWeek ? null : next);
  };

  const me = user?.id ?? null;
  const dialogOpen = dialog !== null;
  const wasOpen = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);

  // Focus goes back to whatever opened the dialog (a card, the New event button, a day) once it closes.
  useEffect(() => {
    if (dialogOpen) {
      wasOpen.current = true;
      return;
    }
    if (wasOpen.current && trigger.current?.isConnected) trigger.current.focus();
    wasOpen.current = false;
  }, [dialogOpen]);

  const remember = () => {
    if (!dialogOpen) trigger.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  };
  const newEventDay = today >= week && today < addDays(week, 7) ? today : week;
  const openCreate = (day: string) => {
    remember();
    setDialog({ kind: "create", day });
  };
  const openDetails = (event: CalendarEvent) => {
    remember();
    setDialog({ kind: "details", event });
  };

  const buckets = useMemo(() => {
    if (!calendar.data) return null;
    const events = onlyMine ? calendar.data.events.filter((item) => me !== null && (item.organizer.id === me || item.attendees.some((attendee) => attendee.user.id === me))) : calendar.data.events;
    const deadlines = onlyMine ? calendar.data.deadlines.filter((item) => item.kind !== "task_due" || (me !== null && item.assignee?.id === me)) : calendar.data.deadlines;
    return bucketWeek({ monday: week, events, deadlines, tz });
  }, [calendar.data, me, onlyMine, tz, week]);

  const empty = buckets !== null && buckets.every((bucket) => bucket.events.length === 0 && bucket.deadlines.length === 0);
  const truncated = calendar.data?.truncated.events || calendar.data?.truncated.deadlines;

  return (
    <div className="wsSchedule">
      <PageHeader
        actions={(
          <>
            <div aria-label="Week" className="spBtnGroup wsSchedNav" role="group">
              <button aria-label="Previous week" className="spBtn spBtnSecondary wsSchedArrow" onClick={() => goTo(addDays(week, -7))} type="button">
                <svg aria-hidden="true" className="spIcon" viewBox="0 0 24 24"><path d="m15 6-6 6 6 6" /></svg>
              </button>
              <button className="spBtn spBtnSecondary" disabled={week === thisWeek} onClick={() => goTo(thisWeek)} type="button">Today</button>
              <button aria-label="Next week" className="spBtn spBtnSecondary wsSchedArrow" onClick={() => goTo(addDays(week, 7))} type="button">
                <svg aria-hidden="true" className="spIcon" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6" /></svg>
              </button>
            </div>
            <button aria-pressed={onlyMine} className="spBtn spBtnSecondary wsSchedToggle" onClick={() => setOnlyMine((value) => !value)} type="button">Only mine</button>
            <button className="spBtn spBtnPrimary" onClick={() => openCreate(newEventDay)} type="button">
              <svg aria-hidden="true" className="spIcon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
              New event
            </button>
          </>
        )}
        lead={<span aria-live="polite" className="wsSchedWeekLabel">{formatWeekLabel(week)}</span>}
        title="Schedule"
      />

      {calendar.loading && <WeekSkeleton />}
      {zoneFallback && <p className="wsSchedNote" role="status">Your time zone is not known to the server, so the week is shown in UTC.</p>}
      {calendar.error && !zoneRejected && (
        <div className="vizError" role="alert">
          <span>{calendar.error}</span>
          <button className="vizBtn vizBtnSecondary vizBtnSm" onClick={calendar.reload} type="button">Retry</button>
        </div>
      )}
      {truncated && <p className="wsSchedNote">This week has more than the schedule can show. Some items are missing.</p>}

      {buckets && empty && <p className="wsSchedEmpty">Nothing scheduled this week</p>}

      {buckets && wide && (
        <div className="wsSchedWeek">
          {buckets.map((bucket) => (
            // A click on the empty part of a day starts an event there; the "+" button is the keyboard route.
            <section aria-label={dayText(bucket.day)} className="wsSchedDay" data-today={bucket.day === today || undefined} key={bucket.day} onClick={(click) => { if (click.target === click.currentTarget) openCreate(bucket.day); }}>
              <header className="wsSchedDayHead">
                <span>{weekdayShort.format(Date.parse(`${bucket.day}T00:00:00Z`))}</span>
                <strong>{Number(bucket.day.slice(8))}</strong>
                {bucket.day === today && <small>Today</small>}
                <button aria-label={`Add event on ${dayText(bucket.day)}`} className="wsSchedAdd" onClick={() => openCreate(bucket.day)} type="button">+</button>
              </header>
              <DayItems bucket={bucket} onOpen={openDetails} slug={workspace.slug} tz={tz} />
            </section>
          ))}
        </div>
      )}

      {buckets && !wide && !empty && (
        <ol aria-label="Agenda" className="wsSchedAgenda">
          {buckets.filter((bucket) => bucket.events.length > 0 || bucket.deadlines.length > 0).map((bucket) => (
            <li className="wsSchedAgendaDay" data-today={bucket.day === today || undefined} key={bucket.day}>
              <div className="wsSchedAgendaHead">
                <h2>{dayText(bucket.day)}</h2>
                {bucket.day === today && <small>Today</small>}
              </div>
              <DayItems bucket={bucket} onOpen={openDetails} slug={workspace.slug} tz={tz} />
            </li>
          ))}
        </ol>
      )}
    
      {dialog?.kind === "create" && (
        <EventDialog
          calendarEvents={calendar.data?.events ?? []}
          day={dialog.day}
          me={me}
          mode="create"
          onClose={() => setDialog(null)}
          onSaved={() => { setDialog(null); reload(); }}
          onStale={reload}
          projects={projects.items ?? []}
          workspaceId={workspace.id}
        />
      )}
      {dialog?.kind === "details" && (
        <EventDetails
          event={dialog.event}
          me={me}
          onCancelled={() => { setDialog(null); reload(); }}
          onChange={(event) => setDialog((current) => (current?.kind === "details" ? { kind: "details", event } : current))}
          onClose={() => setDialog(null)}
          onEdit={() => setDialog({ kind: "edit", event: dialog.event })}
          onStale={reload}
          tz={tz}
        />
      )}
      {dialog?.kind === "edit" && (
        <EventDialog
          calendarEvents={calendar.data?.events ?? []}
          day={dialog.event.startsAt.slice(0, 10)}
          event={dialog.event}
          me={me}
          mode="edit"
          onClose={() => setDialog(null)}
          onSaved={() => { setDialog(null); reload(); }}
          onStale={reload}
          projects={projects.items ?? []}
          workspaceId={workspace.id}
        />
      )}
    </div>
  );
}
