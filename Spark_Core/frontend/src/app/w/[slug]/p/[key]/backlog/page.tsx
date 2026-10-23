"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";

import { initials } from "../../../../../components";
import { useAuth } from "../../../../../auth-context";
import { ApiError, messageOf, workspaceApi } from "../../../../_lib/api";
import { removeCard, replaceCard } from "../../../../_lib/board-moves";
import { boardPath, toCard, typeLabel, type BoardState, type IssueCard, type IssueDetail } from "../../../../_lib/issues";
import {
  addDays,
  assignIssueToSprint,
  canPlan,
  capacityPercent,
  DEFAULT_SPRINT_DAYS,
  formatPoints,
  laneKeyOf,
  laneSprintId,
  OVER_CAPACITY_PERCENT,
  openSprints,
  PLAN_AUTHORITY_MESSAGE,
  planLanes,
  pointsLabel,
  sprintsPath,
  sumPoints,
  taskCountLabel,
  velocityLabel,
  velocityOf,
  withSprint,
  type PlanLane,
  type Sprint,
  type SprintFields,
  type Velocity,
} from "../../../../_lib/planning";
import { daysBetween, formatShortDay, methodologyOf, todayIso } from "../../../../_lib/projects";
import { useWorkspaceData } from "../../../../_lib/use-workspace-data";
import { useWorkspace } from "../../../workspace-context";
import { MoveMenu } from "../move-menu";
import { useProject } from "../project-context";
import { CompleteSprintDialog, SprintFormDialog, StartSprintDialog } from "../sprint-dialogs";
import { TaskDrawer } from "../task-drawer";

const BACKLOG_REFRESHED = "Updated by a teammate — the backlog was refreshed.";
const BACKLOG_REFRESH_FAILED = "Updated by a teammate. Reload the page to see the latest backlog.";
const ARROWS: readonly string[] = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];

/** Scrum planning: the active sprint, planned sprints and the backlog. Other methodologies get a pointer to the board. */
export default function ProjectBacklogPage() {
  const { project } = useProject();
  const { workspace } = useWorkspace();
  if (methodologyOf(project.methodology) !== "scrum") {
    return (
      <section aria-labelledby="backlog-other-title" className="wsCard wsBoardState">
        <h2 id="backlog-other-title">The backlog is for Scrum projects</h2>
        <p>{project.name} plans its work on the board.</p>
        <Link className="sparkPrimary" href={`/w/${workspace.slug}/p/${encodeURIComponent(project.key)}`}>Open the board</Link>
      </section>
    );
  }
  // Keyed by project so a switch between projects never mixes their plans.
  return <ScrumBacklog key={project.id} />;
}

type Dialog =
  | { kind: "create" }
  | { kind: "edit"; sprint: Sprint }
  | { kind: "start"; sprint: Sprint }
  | { kind: "complete"; sprint: Sprint };

type MoveSource = "keyboard" | "pointer" | "menu";

function ScrumBacklog() {
  const { project, notify, announce, reloadProject } = useProject();
  const { workspace } = useWorkspace();
  const { user } = useAuth();
  const planner = canPlan(workspace.role, project, user?.id);
  const path = boardPath(project.id);
  const loadedBoard = useWorkspaceData<BoardState>(path);
  const loadedSprints = useWorkspaceData<{ items: Sprint[] }>(sprintsPath(project.id));
  const base = loadedBoard.dataPath === path ? loadedBoard.data : null;
  // Optimistic moves apply to the loaded copy they were made on; a reload (or 412 refresh) drops them.
  const [local, setLocal] = useState<{ source: BoardState; board: BoardState } | null>(null);
  const committed = base && local?.source === base ? local.board : base;
  const baseRef = useRef<BoardState | null>(null);
  // Sprint writes show at once; the reload that follows replaces them with the server's list.
  const sprintBase = loadedSprints.data;
  const [sprintLocal, setSprintLocal] = useState<{ source: unknown; items: Sprint[] } | null>(null);
  const sprints = sprintBase ? (sprintLocal?.source === sprintBase ? sprintLocal.items : sprintBase.items) : null;
  const [pickup, setPickup] = useState<{ issueId: string; preview: BoardState } | null>(null);
  const [drag, setDrag] = useState<{ issueId: string; over: string | null } | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [focusRequest, setFocusRequest] = useState<{ selector: string; serial: number } | null>(null);
  const [drawer, setDrawer] = useState<{ id: string; key: string } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const helpId = useId();

  useEffect(() => {
    baseRef.current = base;
  }, [base]);

  // Moving a task to another lane remounts its card, so focus follows it explicitly.
  useEffect(() => {
    if (focusRequest) document.querySelector<HTMLElement>(focusRequest.selector)?.focus();
  }, [focusRequest]);

  if (!committed || !sprints) {
    const error = loadedBoard.error ?? loadedSprints.error;
    if (error && !loadedBoard.loading && !loadedSprints.loading) {
      return (
        <section aria-labelledby="backlog-error-title" className="wsCard wsBoardState">
          <h2 id="backlog-error-title">We couldn&apos;t load the backlog</h2>
          <p role="alert">{error}</p>
          <button className="sparkPrimary" onClick={() => { loadedBoard.reload(); loadedSprints.reload(); }} type="button">Try again</button>
        </section>
      );
    }
    return (
      <div aria-busy="true" className="wsBacklogSkeleton" role="status">
        <span className="wsSrOnly">Loading backlog…</span>
        <span /><span /><span />
      </div>
    );
  }

  const source = base ?? committed;
  const board = pickup?.preview ?? committed;
  const lanes = planLanes(sprints, board);
  const committedLanes = pickup ? planLanes(sprints, committed) : lanes;
  const openIds = new Set(openSprints(sprints).map((sprint) => sprint.id));
  const laneName = (key: string) => lanes.find((lane) => lane.key === key)?.name ?? "Backlog";
  const doneStatuses = new Set(committed.statuses.filter((status) => status.category === "done").map((status) => status.id));
  const statusById = new Map(committed.statuses.map((status) => [status.id, status]));
  const active = sprints.find((sprint) => sprint.status === "active") ?? null;
  const planned = sprints.filter((sprint) => sprint.status === "planned");
  const velocity = velocityOf(sprints);
  const today = todayIso();
  const lengthDays = project.sprintLengthDays ?? DEFAULT_SPRINT_DAYS;

  const focusCard = (issueId: string) => setFocusRequest((current) => ({ selector: `[data-card-id="${issueId}"]`, serial: (current?.serial ?? 0) + 1 }));
  const focusMoveButton = (issueId: string) => setFocusRequest((current) => ({ selector: `[data-move-for="${issueId}"]`, serial: (current?.serial ?? 0) + 1 }));

  /** Applies a change to the board copy that `from` was loaded as; changes for an outdated copy are dropped. */
  const update = (from: BoardState, change: (current: BoardState) => BoardState) => {
    if (baseRef.current !== null && from !== baseRef.current) return;
    setLocal((previous) => ({ source: from, board: change(previous && previous.source === from ? previous.board : from) }));
  };

  /** Refetches the board without a loading state and puts it in place of the local copy. Resolves false on failure. */
  const refresh = async (): Promise<boolean> => {
    const from = baseRef.current;
    if (!from) return false;
    try {
      const { data } = await workspaceApi<BoardState>(path);
      if (baseRef.current === from) setLocal({ source: from, board: data });
      return true;
    } catch {
      return false;
    }
  };

  const upsertSprint = (sprint: Sprint) => {
    const items = sprints.some((item) => item.id === sprint.id) ? sprints.map((item) => (item.id === sprint.id ? sprint : item)) : [...sprints, sprint];
    setSprintLocal({ source: sprintBase, items });
    loadedSprints.reload();
  };

  const performMove = (issueId: string, targetKey: string, how: MoveSource) => {
    const issue = committed.issues.find((item) => item.id === issueId);
    if (!issue || !planner) return;
    const fromKey = laneKeyOf(issue, openIds);
    if (targetKey === fromKey) {
      if (how === "keyboard") announce(`Dropped ${issue.key} in ${laneName(fromKey)}.`);
      return;
    }
    const sprintId = laneSprintId(targetKey);
    update(source, (current) => withSprint(current, issueId, sprintId));
    announce(how === "keyboard" ? `Dropped ${issue.key} in ${laneName(targetKey)}.` : `Moved ${issue.key} to ${laneName(targetKey)}.`);
    setBusy((current) => ({ ...current, [issueId]: true }));
    let stale = false;
    assignIssueToSprint(issue, sprintId)
      .then((detail) => update(source, (current) => replaceCard(current, toCard(detail))))
      .catch((error: unknown) => {
        update(source, (current) => withSprint(current, issueId, issue.sprintId));
        if (error instanceof ApiError && error.status === 412) stale = true;
        else notify(messageOf(error), "error");
      })
      .finally(() => {
        setBusy((current) => {
          const next = { ...current };
          delete next[issueId];
          return next;
        });
        if (stale) {
          loadedSprints.reload();
          void refresh().then((ok) => notify(ok ? BACKLOG_REFRESHED : BACKLOG_REFRESH_FAILED, "info"));
        }
      });
  };

  const openDrawer = (issue: IssueCard) => {
    setPickup(null);
    setMenuFor(null);
    setDrawer({ id: issue.id, key: issue.key });
  };

  const onCardKeyDown = (event: KeyboardEvent<HTMLDivElement>, issue: IssueCard) => {
    if (event.target !== event.currentTarget) return;
    const { key } = event;
    if (pickup?.issueId !== issue.id) {
      if (key === "Enter") {
        event.preventDefault();
        openDrawer(issue);
        return;
      }
      if (key !== " ") return;
      event.preventDefault();
      if (!planner || busy[issue.id]) return;
      setMenuFor(null);
      setPickup({ issueId: issue.id, preview: committed });
      announce(`Picked up ${issue.key}. Use arrow keys to move between sprints, Enter to drop, Escape to cancel.`);
      return;
    }
    const currentKey = laneKeyOf(pickup.preview.issues.find((item) => item.id === issue.id) ?? issue, openIds);
    if (ARROWS.includes(key)) {
      event.preventDefault();
      const index = lanes.findIndex((lane) => lane.key === currentKey);
      const next = lanes[index + (key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1)];
      if (!next) {
        announce(`${issue.key} in ${laneName(currentKey)}`);
        return;
      }
      setPickup({ issueId: issue.id, preview: withSprint(pickup.preview, issue.id, laneSprintId(next.key)) });
      announce(`${issue.key} in ${next.name}`);
      focusCard(issue.id);
    } else if (key === " " || key === "Enter") {
      event.preventDefault();
      setPickup(null);
      performMove(issue.id, currentKey, "keyboard");
      focusCard(issue.id);
    } else if (key === "Escape" || key === "Tab") {
      if (key === "Escape") event.preventDefault();
      setPickup(null);
      const home = laneKeyOf(committed.issues.find((item) => item.id === issue.id) ?? issue, openIds);
      announce(`Move cancelled. ${issue.key} is back in ${committedLanes.find((lane) => lane.key === home)?.name ?? "Backlog"}.`);
      if (key === "Escape") focusCard(issue.id);
    }
  };

  const onDragOver = (event: DragEvent<HTMLUListElement>, laneKey: string) => {
    if (!drag) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (drag.over !== laneKey) setDrag({ ...drag, over: laneKey });
  };

  const onDrop = (event: DragEvent<HTMLUListElement>, laneKey: string) => {
    const issueId = drag?.issueId ?? event.dataTransfer.getData("text/plain");
    if (!issueId || !committed.issues.some((issue) => issue.id === issueId)) return;
    event.preventDefault();
    setDrag(null);
    performMove(issueId, laneKey, "pointer");
  };

  const onIssueChanged = (detail: IssueDetail) => {
    update(source, (current) => (detail.archivedAt ? removeCard(current, detail.id) : replaceCard(current, toCard(detail))));
    reloadProject();
  };

  const createDefaults = (): SprintFields => {
    // A new sprint follows the open sprint that ends last, or starts today.
    const lastEnd = openSprints(sprints).map((sprint) => sprint.endsOn).filter((day): day is string => Boolean(day)).sort().at(-1);
    const startsOn = lastEnd && lastEnd > today ? lastEnd : today;
    return { name: `Sprint ${sprints.length + 1}`, goal: null, startsOn, endsOn: addDays(startsOn, lengthDays) };
  };

  const doneIn = (lane: PlanLane) => lane.issues.filter((issue) => doneStatuses.has(issue.statusId));

  return (
    <section aria-label="Sprint planning" className="wsBacklog">
      <p className="wsSrOnly" id={helpId}>
        {planner
          ? "Press Enter to open the task. Press Space to pick it up, arrow keys to move it between sprints and the backlog, Enter or Space to drop it and Escape to cancel. The Move to button offers the same moves from a menu."
          : "Press Enter to open the task."}
      </p>
      <div className="wsBacklogToolbar">
        {planner
          ? <button className="sparkPrimary wsBacklogCreate" onClick={() => setDialog({ kind: "create" })} type="button">
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
              Create sprint
            </button>
          : <p className="wsBacklogReadOnly" role="note">
              <svg aria-hidden="true" viewBox="0 0 24 24"><rect height="9" rx="2" width="14" x="5" y="11" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
              {PLAN_AUTHORITY_MESSAGE}
            </p>}
      </div>
      {board.truncated && (
        <p className="wsBoardBanner" role="note">
          <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 7.5v.5" /></svg>
          Showing the first 500 tasks.
        </p>
      )}
      {lanes.map((lane) => {
        const sprint = lane.sprint;
        const kind = sprint ? (sprint.status === "active" ? "active" : "planned") : "backlog";
        const isNext = sprint !== null && sprint.id === planned[0]?.id;
        const points = sumPoints(lane.issues);
        return (
          <BacklogLane
            actions={planner && sprint ? (
              kind === "active"
                ? <button className="sparkPrimary wsBacklogAction" onClick={() => setDialog({ kind: "complete", sprint })} type="button">Complete sprint</button>
                : <>
                    <button aria-label={`Edit ${sprint.name}`} className="sparkSecondary wsBacklogAction" onClick={() => setDialog({ kind: "edit", sprint })} type="button">Edit</button>
                    {!active && <button className="sparkPrimary wsBacklogAction" onClick={() => setDialog({ kind: "start", sprint })} type="button">Start sprint</button>}
                  </>
            ) : null}
            dropping={drag?.over === lane.key}
            key={lane.key}
            kind={kind}
            lane={lane}
            onDragLeave={(event) => {
              if (drag?.over === lane.key && !event.currentTarget.contains(event.relatedTarget as Node | null)) setDrag({ ...drag, over: null });
            }}
            onDragOver={(event) => onDragOver(event, lane.key)}
            onDrop={(event) => onDrop(event, lane.key)}
            planner={planner}
            summary={
              <>
                {kind === "active" && sprint && <ActiveProgress donePoints={sumPoints(doneIn(lane))} sprint={sprint} today={today} />}
                {isNext && <Capacity planned={points} velocity={velocity} />}
              </>
            }
            totals={`${taskCountLabel(lane.issues.length)} · ${pointsLabel(points)}`}
          >
            {lane.issues.map((issue) => (
              <BacklogCard
                busy={Boolean(busy[issue.id])}
                done={doneStatuses.has(issue.statusId)}
                dragging={drag?.issueId === issue.id}
                helpId={helpId}
                issue={issue}
                key={issue.id}
                menu={menuFor === issue.id ? (
                  <MoveMenu
                    issueId={issue.id}
                    label={`Move ${issue.key} to`}
                    onClose={(restoreFocus) => {
                      setMenuFor(null);
                      if (restoreFocus) focusMoveButton(issue.id);
                    }}
                    onPick={(option) => {
                      setMenuFor(null);
                      if (option.current) {
                        focusMoveButton(issue.id);
                        return;
                      }
                      performMove(issue.id, option.id, "menu");
                      focusCard(issue.id);
                    }}
                    options={committedLanes.map((item) => ({ id: item.key, name: item.name, current: item.key === laneKeyOf(issue, openIds) }))}
                  />
                ) : null}
                menuOpen={menuFor === issue.id}
                onDragEnd={() => setDrag(null)}
                onDragStart={() => {
                  setPickup(null);
                  setMenuFor(null);
                  setDrag({ issueId: issue.id, over: null });
                }}
                onKeyDown={(event) => onCardKeyDown(event, issue)}
                onOpen={() => openDrawer(issue)}
                onToggleMenu={() => {
                  setPickup(null);
                  setMenuFor((current) => (current === issue.id ? null : issue.id));
                }}
                picked={pickup?.issueId === issue.id}
                planner={planner}
                statusName={statusById.get(issue.statusId)?.name ?? null}
              />
            ))}
          </BacklogLane>
        );
      })}

      {drawer && (
        <TaskDrawer
          board={committed}
          issueId={drawer.id}
          issueKey={drawer.key}
          key={drawer.id}
          onArchived={(detail) => {
            setDrawer(null);
            onIssueChanged(detail);
          }}
          onChanged={onIssueChanged}
          onClose={() => setDrawer(null)}
          project={project}
          workspaceId={workspace.id}
        />
      )}
      {dialog?.kind === "create" && (
        <SprintFormDialog
          defaults={createDefaults()}
          onClose={() => setDialog(null)}
          onSaved={(sprint) => {
            setDialog(null);
            upsertSprint(sprint);
            notify(`${sprint.name} created.`);
          }}
          projectId={project.id}
          sprint={null}
        />
      )}
      {dialog?.kind === "edit" && (
        <SprintFormDialog
          defaults={createDefaults()}
          onClose={() => setDialog(null)}
          onSaved={(sprint) => {
            setDialog(null);
            upsertSprint(sprint);
            notify(`${sprint.name} saved.`);
          }}
          projectId={project.id}
          sprint={dialog.sprint}
        />
      )}
      {dialog?.kind === "start" && (() => {
        const issues = lanes.find((lane) => lane.key === dialog.sprint.id)?.issues ?? [];
        return (
          <StartSprintDialog
            commitment={{ count: issues.length, points: sumPoints(issues) }}
            lengthDays={lengthDays}
            onClose={() => setDialog(null)}
            onStale={() => loadedSprints.reload()}
            onStarted={(sprint) => {
              setDialog(null);
              upsertSprint(sprint);
              notify(`${sprint.name} started.`);
            }}
            sprint={dialog.sprint}
            today={today}
          />
        );
      })()}
      {dialog?.kind === "complete" && (() => {
        const lane = lanes.find((item) => item.key === dialog.sprint.id);
        const issues = lane?.issues ?? [];
        return (
          <CompleteSprintDialog
            doneCount={lane ? doneIn(lane).length : 0}
            onClose={() => setDialog(null)}
            onCompleted={({ sprint, movedIssues }, targetName) => {
              setDialog(null);
              upsertSprint(sprint);
              void refresh();
              reloadProject();
              notify(movedIssues === 0
                ? `${sprint.name} completed.`
                : `${sprint.name} completed. ${movedIssues} unfinished ${movedIssues === 1 ? "task" : "tasks"} moved to ${targetName ?? "the backlog"}.`);
            }}
            onStale={() => loadedSprints.reload()}
            planned={planned}
            sprint={dialog.sprint}
            totalCount={issues.length}
          />
        );
      })()}
    </section>
  );
}

function sprintDates(sprint: Sprint): string {
  return sprint.startsOn && sprint.endsOn ? `${formatShortDay(sprint.startsOn)} – ${formatShortDay(sprint.endsOn)}` : "No dates yet";
}

function daysLeftLabel(today: string, endsOn: string | null): string | null {
  if (!endsOn) return null;
  const left = daysBetween(today, endsOn);
  if (Number.isNaN(left)) return null;
  if (left > 1) return `${left} days left`;
  if (left === 1) return "1 day left";
  if (left === 0) return "Ends today";
  return `Ended ${-left} ${left === -1 ? "day" : "days"} ago`;
}

function ActiveProgress({ sprint, donePoints, today }: { sprint: Sprint; donePoints: number; today: string }) {
  const committed = sprint.committedPoints ?? 0;
  const share = committed > 0 ? Math.min(100, (donePoints / committed) * 100) : 0;
  const daysLeft = daysLeftLabel(today, sprint.endsOn);
  return (
    <div className="wsBacklogProgress">
      <p className="wsBacklogProgressText">
        <span>{formatPoints(donePoints)} of {formatPoints(committed)} committed {committed === 1 ? "pt" : "pts"} done</span>
        {daysLeft && <span className="wsBacklogDaysLeft">{daysLeft}</span>}
      </p>
      <span aria-hidden="true" className="wsBacklogBar"><span style={{ width: `${share}%` }} /></span>
    </div>
  );
}

function Capacity({ planned, velocity }: { planned: number; velocity: Velocity | null }) {
  const percent = capacityPercent(planned, velocity);
  const over = percent !== null && percent > OVER_CAPACITY_PERCENT;
  return (
    <div className="wsBacklogCapacity" data-over={over || undefined}>
      <p className="wsBacklogCapacityText">
        <span>{pointsLabel(planned)} planned</span>
        <span className="wsBacklogVelocity">{velocityLabel(velocity)}</span>
      </p>
      {percent !== null && <span aria-hidden="true" className="wsBacklogBar"><span style={{ width: `${Math.min(100, percent)}%` }} /></span>}
      {over && <p className="wsBacklogWarning" role="note">Over capacity: {pointsLabel(planned)} planned is {percent}% of velocity.</p>}
    </div>
  );
}

function BacklogLane({ lane, kind, totals, summary, actions, planner, dropping, onDragOver, onDragLeave, onDrop, children }: {
  lane: PlanLane;
  kind: "active" | "planned" | "backlog";
  totals: string;
  summary: ReactNode;
  actions: ReactNode;
  planner: boolean;
  dropping: boolean;
  onDragOver(event: DragEvent<HTMLUListElement>): void;
  onDragLeave(event: DragEvent<HTMLUListElement>): void;
  onDrop(event: DragEvent<HTMLUListElement>): void;
  children: ReactNode;
}) {
  const titleId = useId();
  const sprint = lane.sprint;
  const empty = lane.issues.length === 0;
  return (
    <section aria-labelledby={titleId} className="wsBacklogLane" data-drop={dropping || undefined} data-kind={kind}>
      <header className="wsBacklogLaneHead">
        <div className="wsBacklogLaneTitle">
          <h2 id={titleId}>{lane.name}</h2>
          {sprint && <span className="wsBacklogState" data-kind={kind}>{kind === "active" ? "Active" : "Planned"}</span>}
          {sprint && <span className="wsBacklogDates">{sprintDates(sprint)}</span>}
        </div>
        <p className="wsBacklogTotals">{totals}</p>
        {actions && <div className="wsBacklogActions">{actions}</div>}
      </header>
      {sprint?.goal && <p className="wsBacklogGoal">{sprint.goal}</p>}
      {summary}
      <ul aria-label={`${lane.name} tasks`} className="wsBacklogList" onDragLeave={onDragLeave} onDragOver={onDragOver} onDrop={onDrop}>
        {children}
        {empty && (
          <li className="wsBacklogEmpty">
            {kind === "backlog" ? "The backlog is empty." : planner ? "No tasks yet. Drag tasks here or use Move to…" : "No tasks yet."}
          </li>
        )}
      </ul>
    </section>
  );
}

function BacklogCard({ issue, statusName, done, planner, picked, busy, dragging, helpId, menu, menuOpen, onKeyDown, onOpen, onDragStart, onDragEnd, onToggleMenu }: {
  issue: IssueCard;
  statusName: string | null;
  done: boolean;
  planner: boolean;
  picked: boolean;
  busy: boolean;
  dragging: boolean;
  helpId: string;
  menu: ReactNode;
  menuOpen: boolean;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
  onOpen(): void;
  onDragStart(): void;
  onDragEnd(): void;
  onToggleMenu(): void;
}) {
  const metaId = useId();
  const draggable = planner && !busy;
  return (
    <li className="wsBacklogItem" data-planner={planner || undefined}>
      <div
        aria-describedby={`${metaId} ${helpId}`}
        aria-label={`${issue.key}: ${issue.title}`}
        className="wsBacklogCard"
        data-busy={busy || undefined}
        data-card-id={issue.id}
        data-done={done || undefined}
        data-dragging={dragging || undefined}
        data-picked={picked || undefined}
        draggable={draggable}
        onClick={onOpen}
        onDragEnd={onDragEnd}
        onDragStart={(event) => {
          if (!draggable) {
            event.preventDefault();
            return;
          }
          event.dataTransfer.setData("text/plain", issue.id);
          event.dataTransfer.effectAllowed = "move";
          onDragStart();
        }}
        onKeyDown={onKeyDown}
        role="button"
        tabIndex={0}
      >
        <span className="wsKeyTag">{issue.key}</span>
        <span className="wsBacklogCardTitle">{issue.title}</span>
        <span className="wsBacklogCardMeta" id={metaId}>
          <span className="wsBoardTag" data-type={issue.type}>{typeLabel(issue.type)}</span>
          {statusName && <span className="wsBacklogStatus" data-done={done || undefined}><span className="wsSrOnly">Status </span>{statusName}</span>}
          <span className="wsBoardPoints" data-empty={issue.storyPoints === null || undefined}>
            {issue.storyPoints === null ? <><span aria-hidden="true">–</span><span className="wsSrOnly">No estimate</span></> : pointsLabel(issue.storyPoints)}
          </span>
          {issue.assignee && (
            <span className="wsBoardAssignee">
              <span className="wsSrOnly">Assigned to {issue.assignee.displayName}</span>
              <span aria-hidden="true" className="avatar tiny" title={issue.assignee.displayName}>{initials(issue.assignee.displayName, "?")}</span>
            </span>
          )}
        </span>
      </div>
      {planner && (
        <div className="wsBacklogMove">
          <button aria-expanded={menuOpen} aria-haspopup="menu" aria-label={`Move to… (${issue.key})`} className="wsBoardMoveButton" data-move-for={issue.id} disabled={busy} onClick={onToggleMenu} type="button">
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            Move to…
          </button>
          {menu}
        </div>
      )}
    </li>
  );
}
