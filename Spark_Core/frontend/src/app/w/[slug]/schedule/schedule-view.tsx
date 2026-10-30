"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from "react";

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

const WIDE_QUERY = "(min-width: 900px)";
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

/** True from 900 px up (also without matchMedia), where the week grid replaces the phone agenda. */
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

function EventCard({ day, event, tz }: { day: string; event: CalendarEvent; tz: string }) {
  const cancelled = event.status === "cancelled";
  const shown = event.attendees.slice(0, MAX_AVATARS);
  const more = event.attendees.length - shown.length;
  const response = event.myResponse ? RESPONSE_LABELS[event.myResponse] : null;
  return (
    <article className="wsSchedEvent" data-response={event.myResponse ?? undefined} data-status={event.status}>
      <time className="wsSchedTime" dateTime={event.startsAt}>{formatEventTime(event, day, tz)}</time>
      <h3 className="wsSchedTitle">{event.title}</h3>
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

function DayItems({ bucket, slug, tz }: { bucket: DayBucket; slug: string; tz: string }) {
  return (
    <>
      {bucket.deadlines.length > 0 && (
        <ul aria-label="Deadlines" className="wsSchedChips">
          {bucket.deadlines.map((deadline, index) => <li key={`${deadline.kind}-${deadline.issueId ?? deadline.sprintId ?? deadline.milestoneId ?? index}`}><Chip deadline={deadline} slug={slug} /></li>)}
        </ul>
      )}
      {bucket.events.map((event) => <EventCard day={bucket.day} event={event} key={event.id} tz={tz} />)}
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

/**
 * The week view. `onNewEvent` is the hook for the event dialog (wired separately): without it the button is
 * shown but disabled.
 */
export function ScheduleView({ onNewEvent }: { onNewEvent?: () => void }) {
  const { workspace } = useWorkspace();
  const { user } = useAuth();
  const wide = useWide();
  const [tz] = useState(viewerZone);
  const [now] = useState(() => Date.now());
  const today = dayOfInstant(now, tz);
  const thisWeek = mondayOf(today);
  const [week, setWeek] = useState(() => parseWeekParam(new URLSearchParams(window.location.search).get("week")) ?? thisWeek);
  const [onlyMine, setOnlyMine] = useState(false);
  const calendar = useInsight<CalendarResponse>(calendarPath(workspace.id, weekBounds(week, tz), tz));
  const { reload } = calendar;

  // A teammate may have changed the schedule while this tab was in the background.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "hidden") reload();
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
      <section aria-label="Schedule controls" className="wsSchedBar">
        <div className="wsSchedBarTitle">
          <h1>Schedule</h1>
          <p aria-live="polite" className="wsSchedWeekLabel">{formatWeekLabel(week)}</p>
        </div>
        <div className="wsSchedControls">
          <div className="wsSchedNav" role="group" aria-label="Week">
            <button aria-label="Previous week" className="sparkSecondary" onClick={() => goTo(addDays(week, -7))} type="button">‹</button>
            <button className="sparkSecondary" disabled={week === thisWeek} onClick={() => goTo(thisWeek)} type="button">Today</button>
            <button aria-label="Next week" className="sparkSecondary" onClick={() => goTo(addDays(week, 7))} type="button">›</button>
          </div>
          <button aria-pressed={onlyMine} className="wsSchedToggle" onClick={() => setOnlyMine((value) => !value)} type="button">Only mine</button>
          {/* The event dialog is attached through onNewEvent. */}
          <button className="sparkPrimary" disabled={!onNewEvent} onClick={onNewEvent} title={onNewEvent ? undefined : "Creating events is not available yet"} type="button">New event</button>
        </div>
      </section>

      {calendar.loading && <WeekSkeleton />}
      {calendar.error && (
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
            <section aria-label={dayText(bucket.day)} className="wsSchedDay" data-today={bucket.day === today || undefined} key={bucket.day}>
              <header className="wsSchedDayHead">
                <span>{weekdayShort.format(Date.parse(`${bucket.day}T00:00:00Z`))}</span>
                <strong>{Number(bucket.day.slice(8))}</strong>
                {bucket.day === today && <small>Today</small>}
              </header>
              <DayItems bucket={bucket} slug={workspace.slug} tz={tz} />
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
              <DayItems bucket={bucket} slug={workspace.slug} tz={tz} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
