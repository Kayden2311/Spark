"use client";

import { useEffect, useId, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { initials } from "../../../../components";
import { ApiError, messageOf } from "../../../_lib/api";
import { addCard, columnIssues, currentTarget, keyboardTarget, moveCard, positionOf, removeCard, replaceCard, wipBlocked, wipMessage, type ArrowKey, type MoveTarget } from "../../../_lib/board-moves";
import { boardPath, createIssue, moveIssue, priorityLabel, toCard, typeLabel, type BoardState, type BoardStatus, type IssueCard, type IssueDetail, type IssueMove } from "../../../_lib/issues";
import { formatDay, methodologyOf, todayIso } from "../../../_lib/projects";
import { useOptimisticBoard } from "../../../_lib/use-optimistic-board";
import { useWorkspace } from "../../workspace-context";
import { MoveMenu } from "./move-menu";
import { useProject } from "./project-context";
import { TASK_GONE, TaskDrawer } from "./task-drawer";

export const TEAMMATE_MOVED = "Updated by a teammate — the board was refreshed.";
export const TEAMMATE_MOVED_STALE = "Updated by a teammate. Reload the page to see the latest board.";
const ARROWS: readonly string[] = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
const ISSUE_PARAM = "issue";
/** `?phase=none` (the Timeline's Unphased link) shows only the cards without a phase. */
const PHASE_PARAM = "phase";
export const TASK_NOT_LOADED = "That task isn't on the loaded board. Open it from the task list.";

/** Sets or removes ?issue= without a navigation; Next.js syncs useSearchParams with history.replaceState. */
function replaceIssueParam(key: string | null) {
  const url = new URL(window.location.href);
  if (key === null) url.searchParams.delete(ISSUE_PARAM);
  else url.searchParams.set(ISSUE_PARAM, key);
  if (url.href !== window.location.href) window.history.replaceState(null, "", url);
}

function taskCount(count: number): string {
  return `${count} ${count === 1 ? "task" : "tasks"}`;
}

function wipState(status: BoardStatus): "ok" | "at" | "over" {
  if (status.wipLimit === null || status.count < status.wipLimit) return "ok";
  return status.count === status.wipLimit ? "at" : "over";
}

interface Pickup {
  issueId: string;
  /** The board as the picked-up card is being moved around; nothing is sent until it is dropped. */
  preview: BoardState;
}

interface Drag {
  issueId: string;
  over: MoveTarget | null;
}

type MoveSource = "keyboard" | "pointer" | "menu";

export function ProjectBoard() {
  const { project, notify, announce, reloadProject } = useProject();
  const { workspace } = useWorkspace();
  const searchParams = useSearchParams();
  const issueParam = searchParams.get(ISSUE_PARAM);
  const unphasedOnly = searchParams.get(PHASE_PARAM) === "none";
  const path = boardPath(project.id);
  const { loaded, base, committed, pendingRef, update, refresh } = useOptimisticBoard(path);
  const [pickup, setPickup] = useState<Pickup | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [focusRequest, setFocusRequest] = useState<{ selector: string; serial: number } | null>(null);
  const helpId = useId();
  // The task drawer. A ?issue=<KEY>-<n> link (the assignment email's; the schedule links by issue id) opens it once the board is loaded;
  // the parameter is acted on when it changes, so opening and closing here only keep it in sync.
  const [drawer, setDrawer] = useState<{ id: string; key: string } | null>(null);
  const [seenParam, setSeenParam] = useState<string | null>(null);
  const [missingLink, setMissingLink] = useState<{ key: string; truncated: boolean } | null>(null);
  // Where focus goes when the drawer closes after its card left the board (archived by a teammate).
  const focusAfterCloseRef = useRef<string | null>(null);
  if (committed && issueParam !== seenParam) {
    setSeenParam(issueParam);
    if (issueParam !== null) {
      const linked = committed.issues.find((issue) => issue.key.toUpperCase() === issueParam.toUpperCase() || issue.id === issueParam);
      if (linked) {
        if (drawer?.id !== linked.id) setDrawer({ id: linked.id, key: linked.key });
      } else {
        // A board cut at 500 cards may simply not include the task, so only a complete board can say it is gone.
        setMissingLink({ key: issueParam, truncated: committed.truncated });
      }
    }
  }

  useEffect(() => {
    if (!missingLink) return;
    replaceIssueParam(null);
    notify(missingLink.truncated ? TASK_NOT_LOADED : TASK_GONE, missingLink.truncated ? "info" : "error");
  }, [missingLink, notify]);

  // Moving a card to another column remounts it, so focus follows it explicitly.
  useEffect(() => {
    if (focusRequest) document.querySelector<HTMLElement>(focusRequest.selector)?.focus();
  }, [focusRequest]);

  const focusCard = (issueId: string) => setFocusRequest((current) => ({ selector: `[data-card-id="${issueId}"]`, serial: (current?.serial ?? 0) + 1 }));
  const focusMoveButton = (issueId: string) => setFocusRequest((current) => ({ selector: `[data-move-for="${issueId}"]`, serial: (current?.serial ?? 0) + 1 }));

  const setNotice = (statusId: string, text: string | null) =>
    setNotices((current) => {
      const next = { ...current };
      if (text === null) delete next[statusId];
      else next[statusId] = text;
      return next;
    });

  if (!committed) {
    if (loaded.error && !loaded.loading) {
      return (
        <section aria-labelledby="board-error-title" className="wsCard wsBoardState">
          <h2 id="board-error-title">We couldn&apos;t load the board</h2>
          <p role="alert">{loaded.error}</p>
          <button className="sparkPrimary" onClick={loaded.reload} type="button">Try again</button>
        </section>
      );
    }
    return (
      <div aria-busy="true" className="wsBoardSkeleton" role="status">
        <span className="wsSrOnly">Loading board…</span>
        <span /><span /><span /><span />
      </div>
    );
  }

  const source = base ?? committed;
  const board = pickup?.preview ?? committed;
  const methodology = methodologyOf(project.methodology);
  const phases = new Map(project.phases.map((phase) => [phase.id, phase.name]));
  const today = todayIso();
  const statusById = new Map(board.statuses.map((status) => [status.id, status]));

  /**
   * The cards the viewer sees: with ?phase=none only unphased ones. Keyboard targets, positions and focus
   * use it, so a move steps over visible cards only; the API still places the card among all of them.
   */
  const view = (state: BoardState): BoardState => (unphasedOnly ? { ...state, issues: state.issues.filter((issue) => issue.phaseId === null) } : state);

  const describe = (state: BoardState, issue: IssueCard) => {
    const where = positionOf(view(state), issue.id);
    const status = where ? state.statuses.find((item) => item.id === where.statusId) : undefined;
    return where && status ? `${status.name}, position ${where.position} of ${where.size}` : "";
  };

  const performMove = (issueId: string, target: MoveTarget, how: MoveSource) => {
    const issue = committed.issues.find((item) => item.id === issueId);
    const origin = currentTarget(committed, issueId);
    const status = committed.statuses.find((item) => item.id === target.statusId);
    if (!issue || !origin || !status) return;
    if (target.statusId === origin.statusId && target.afterIssueId === origin.afterIssueId) {
      if (how === "keyboard") announce(`Dropped ${issue.key} in ${describe(committed, issue)}.`);
      return;
    }
    if (wipBlocked(committed, issueId, target.statusId)) {
      const message = wipMessage(status);
      setNotice(status.id, message);
      announce(message);
      return;
    }

    const next = moveCard(committed, issueId, target.statusId, target.afterIssueId);
    update(source, (current) => moveCard(current, issueId, target.statusId, target.afterIssueId));
    setNotice(status.id, null);
    announce(`${how === "keyboard" ? "Dropped" : "Moved"} ${issue.key} ${how === "keyboard" ? "in" : "to"} ${describe(next, issue)}.`);
    setBusy((current) => ({ ...current, [issueId]: true }));
    pendingRef.current += 1;
    let outcome: "moved" | "wip" | "stale" | "failed" = "failed";
    const body: IssueMove = target.statusId === issue.statusId ? { afterIssueId: target.afterIssueId } : { statusId: target.statusId, afterIssueId: target.afterIssueId };
    moveIssue(issue, body)
      .then((detail) => {
        outcome = "moved";
        update(source, (current) => replaceCard(current, toCard(detail)));
        // The overview's progress counts depend on where tasks are.
        reloadProject();
      })
      .catch((error: unknown) => {
        update(source, (current) => moveCard(current, issueId, origin.statusId, origin.afterIssueId));
        if (error instanceof ApiError && error.code === "wip_limit_reached") {
          outcome = "wip";
          const message = wipMessage(status, error.message);
          setNotice(status.id, message);
          announce(message);
        } else if (error instanceof ApiError && error.status === 412) {
          outcome = "stale";
        } else {
          notify(messageOf(error), "error");
        }
      })
      .finally(() => {
        pendingRef.current -= 1;
        setBusy((current) => {
          const next = { ...current };
          delete next[issueId];
          return next;
        });
        if (outcome === "stale") {
          void refresh(true).then((ok) => notify(ok ? TEAMMATE_MOVED : TEAMMATE_MOVED_STALE, "info"));
        } else if (outcome === "moved" || outcome === "wip") {
          // A move can rerank neighbours (new versions) and a 409 means our counts were stale.
          void refresh(false);
        }
      });
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
      if (busy[issue.id]) return;
      setMenuFor(null);
      setNotices({});
      setPickup({ issueId: issue.id, preview: committed });
      announce(`Picked up ${issue.key}. Use arrow keys to move, Enter to drop, Escape to cancel.`);
      return;
    }
    if (ARROWS.includes(key)) {
      event.preventDefault();
      const target = keyboardTarget(view(pickup.preview), issue.id, key as ArrowKey);
      if (!target) {
        announce(`${issue.key} in ${describe(pickup.preview, issue)}`);
        return;
      }
      const preview = moveCard(pickup.preview, issue.id, target.statusId, target.afterIssueId);
      setPickup({ issueId: issue.id, preview });
      announce(`${issue.key} in ${describe(preview, issue)}`);
      focusCard(issue.id);
    } else if (key === " " || key === "Enter") {
      event.preventDefault();
      const target = currentTarget(pickup.preview, issue.id);
      setPickup(null);
      if (target) performMove(issue.id, target, "keyboard");
      focusCard(issue.id);
    } else if (key === "Escape" || key === "Tab") {
      if (key === "Escape") event.preventDefault();
      setPickup(null);
      announce(`Move cancelled. ${issue.key} is back in ${describe(committed, issue)}.`);
      if (key === "Escape") focusCard(issue.id);
    }
  };

  const openDrawer = (issue: IssueCard) => {
    setPickup(null);
    setMenuFor(null);
    setDrawer({ id: issue.id, key: issue.key });
    setSeenParam(issue.key);
    replaceIssueParam(issue.key);
  };

  // The parameter stays "seen" until the URL catches up, so a render in between cannot reopen the drawer.
  const closeDrawer = () => {
    setDrawer(null);
    replaceIssueParam(null);
    const target = focusAfterCloseRef.current;
    focusAfterCloseRef.current = null;
    if (target) setFocusRequest((current) => ({ selector: target, serial: (current?.serial ?? 0) + 1 }));
  };

  /**
   * Where focus should land once a card leaves the board: the next card in its column, else the previous
   * one, else the column's quick-add, else any other card.
   */
  const focusTargetAfterRemoval = (issueId: string): string => {
    const issue = committed.issues.find((item) => item.id === issueId);
    const fallback = `[data-card-id]:not([data-card-id="${issueId}"])`;
    if (!issue) return fallback;
    const column = columnIssues(view(committed), issue.statusId);
    const index = column.findIndex((item) => item.id === issueId);
    const neighbour = column[index + 1] ?? column[index - 1];
    if (neighbour) return `[data-card-id="${neighbour.id}"]`;
    const status = committed.statuses.find((item) => item.id === issue.statusId);
    return status && status.category !== "done" ? `[data-quick-add-for="${status.id}"]` : fallback;
  };

  /** A newer version of a task from the drawer: the card follows it, to the end of a new column when its status changed. */
  const onIssueChanged = (detail: IssueDetail) => {
    if (detail.archivedAt) {
      // A teammate archived it (seen on 412): the card leaves now, the read-only drawer stays until closed.
      focusAfterCloseRef.current = focusTargetAfterRemoval(detail.id);
      update(source, (current) => removeCard(current, detail.id));
      reloadProject();
      void refresh(false);
      return;
    }
    update(source, (current) => {
      const before = current.issues.find((item) => item.id === detail.id);
      if (!before) return current;
      const moved = before.statusId === detail.statusId
        ? current
        : moveCard(current, detail.id, detail.statusId, columnIssues(current, detail.statusId).filter((item) => item.id !== detail.id).at(-1)?.id ?? null);
      return replaceCard(moved, toCard(detail));
    });
    reloadProject();
    void refresh(false);
  };

  const onIssueArchived = (detail: IssueDetail) => {
    focusAfterCloseRef.current = focusTargetAfterRemoval(detail.id);
    closeDrawer();
    update(source, (current) => removeCard(current, detail.id));
    reloadProject();
    void refresh(false);
  };

  const dropTarget = (event: DragEvent<HTMLUListElement>, statusId: string, draggedId: string): MoveTarget => {
    let afterIssueId: string | null = null;
    for (const element of Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-card-id]"))) {
      const id = element.dataset.cardId;
      if (!id || id === draggedId) continue;
      const rect = element.getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) break;
      afterIssueId = id;
    }
    return { statusId, afterIssueId };
  };

  const onDragOver = (event: DragEvent<HTMLUListElement>, statusId: string) => {
    if (!drag) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const over = dropTarget(event, statusId, drag.issueId);
    if (drag.over?.statusId !== over.statusId || drag.over.afterIssueId !== over.afterIssueId) setDrag({ ...drag, over });
  };

  const onDrop = (event: DragEvent<HTMLUListElement>, statusId: string) => {
    const issueId = drag?.issueId ?? event.dataTransfer.getData("text/plain");
    if (!issueId || !committed.issues.some((issue) => issue.id === issueId)) return;
    event.preventDefault();
    const target = dropTarget(event, statusId, issueId);
    setDrag(null);
    performMove(issueId, target, "pointer");
  };

  const moveToColumn = (issue: IssueCard, status: BoardStatus) => {
    if (status.id === issue.statusId) {
      setMenuFor(null);
      focusMoveButton(issue.id);
      return;
    }
    if (wipBlocked(committed, issue.id, status.id)) return;
    const last = columnIssues(committed, status.id).filter((item) => item.id !== issue.id).at(-1);
    setMenuFor(null);
    performMove(issue.id, { statusId: status.id, afterIssueId: last?.id ?? null }, "menu");
    focusCard(issue.id);
  };

  const create = async (status: BoardStatus, title: string, idempotencyKey: string) => {
    try {
      const detail = await createIssue(project.id, { title, statusId: status.id }, idempotencyKey);
      update(source, (current) => addCard(current, toCard(detail)));
      reloadProject();
      setNotice(status.id, null);
      announce(`Added ${detail.key} to ${status.name}.`);
    } catch (error) {
      if (error instanceof ApiError && error.code === "wip_limit_reached") {
        const message = wipMessage(status, error.message);
        setNotice(status.id, message);
        announce(message);
      }
      throw error;
    }
  };

  return (
    <section aria-label="Board" className="wsBoard">
      <p className="wsSrOnly" id={helpId}>Press Enter to open the task. Press Space to pick it up, arrow keys to move it, Enter or Space to drop it and Escape to cancel. The Move to button offers the same moves from a menu.</p>
      {board.truncated && (
        <p className="wsBoardBanner" role="note">
          <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 7.5v.5" /></svg>
          Showing the first 500 tasks.
        </p>
      )}
      {unphasedOnly && (
        <p className="wsBoardFilter">
          <span>Showing unphased tasks</span>
          <span aria-hidden="true">·</span>
          <Link aria-label="Clear the unphased filter" href={`/w/${workspace.slug}/p/${encodeURIComponent(project.key)}`}>Clear</Link>
        </p>
      )}
      <div className="wsBoardScroller">
        {board.statuses.map((status) => {
          const cards = columnIssues(view(board), status.id);
          const full = wipBlocked(committed, null, status.id);
          const notice = notices[status.id] ?? (full && status.category !== "done" ? wipMessage(status) : null);
          const noticeId = `${helpId}-notice-${status.id}`;
          const over = drag?.over?.statusId === status.id ? drag.over : null;
          const blockedDrop = Boolean(over && drag && wipBlocked(committed, drag.issueId, status.id));
          const marker = <li aria-hidden="true" className="wsBoardDropMarker" data-blocked={blockedDrop || undefined} key="drop-marker" />;
          return (
            <div aria-label={`${status.name} column, ${taskCount(status.count)}`} className="wsBoardColumn" data-category={status.category} data-drop={over ? (blockedDrop ? "blocked" : "ok") : undefined} key={status.id} role="group">
              <header className="wsBoardColumnHead">
                <h2>{status.name}</h2>
                <span aria-hidden="true" className="wsBoardCount">{status.count}</span>
                {status.wipLimit !== null && <span className="wsBoardWip" data-state={wipState(status)}>WIP {status.wipLimit}</span>}
              </header>
              {notice && <p className="wsBoardNotice" id={noticeId}>{notice}</p>}
              <ul aria-label={`${status.name} tasks`} className="wsBoardList" onDragLeave={(event) => {
                if (drag?.over?.statusId === status.id && !event.currentTarget.contains(event.relatedTarget as Node | null)) setDrag({ ...drag, over: null });
              }} onDragOver={(event) => onDragOver(event, status.id)} onDrop={(event) => onDrop(event, status.id)}>
                {over && over.afterIssueId === null && marker}
                {cards.map((issue) => (
                  <BoardCardItem
                    busy={Boolean(busy[issue.id])}
                    dragging={drag?.issueId === issue.id}
                    helpId={helpId}
                    issue={issue}
                    key={issue.id}
                    marker={over && over.afterIssueId === issue.id ? marker : null}
                    menu={menuFor === issue.id ? (
                      <MoveMenu
                        issueId={issue.id}
                        label={`Move ${issue.key} to`}
                        onClose={(restoreFocus) => {
                          setMenuFor(null);
                          if (restoreFocus) focusMoveButton(issue.id);
                        }}
                        onPick={(option) => {
                          const target = committed.statuses.find((item) => item.id === option.id);
                          if (target) moveToColumn(issue, target);
                        }}
                        options={committed.statuses.map((item) => ({ id: item.id, name: item.name, current: item.id === issue.statusId, disabled: wipBlocked(committed, issue.id, item.id) }))}
                      />
                    ) : null}
                    menuOpen={menuFor === issue.id}
                    onDragEnd={() => setDrag(null)}
                    onDragStart={() => {
                      setPickup(null);
                      setMenuFor(null);
                      setNotices({});
                      setDrag({ issueId: issue.id, over: null });
                    }}
                    onKeyDown={(event) => onCardKeyDown(event, issue)}
                    onOpen={() => openDrawer(issue)}
                    onToggleMenu={() => {
                      setPickup(null);
                      setMenuFor((current) => (current === issue.id ? null : issue.id));
                    }}
                    overdue={Boolean(issue.dueDate && issue.dueDate < today && !issue.completedAt && statusById.get(issue.statusId)?.category !== "done")}
                    phaseName={methodology === "waterfall" && issue.phaseId ? phases.get(issue.phaseId) ?? null : null}
                    picked={pickup?.issueId === issue.id}
                    showPoints={methodology === "scrum"}
                  />
                ))}
              </ul>
              {status.category !== "done" && (
                <QuickAdd blocked={full} describedBy={notice ? noticeId : undefined} onCreate={(title, key) => create(status, title, key)} status={status} />
              )}
            </div>
          );
        })}
      </div>
      {drawer && (
        <TaskDrawer
          board={committed}
          issueId={drawer.id}
          issueKey={drawer.key}
          key={drawer.id}
          onArchived={onIssueArchived}
          onChanged={onIssueChanged}
          onClose={closeDrawer}
          project={project}
          workspaceId={workspace.id}
        />
      )}
    </section>
  );
}

function BoardCardItem({ issue, helpId, picked, busy, dragging, overdue, phaseName, showPoints, marker, menu, menuOpen, onKeyDown, onOpen, onDragStart, onDragEnd, onToggleMenu }: {
  issue: IssueCard;
  helpId: string;
  picked: boolean;
  busy: boolean;
  dragging: boolean;
  overdue: boolean;
  phaseName: string | null;
  showPoints: boolean;
  marker: ReactNode;
  menu: ReactNode;
  menuOpen: boolean;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
  /** Opens the task drawer (a click; Enter goes through onKeyDown so a keyboard move can claim it). */
  onOpen(): void;
  onDragStart(): void;
  onDragEnd(): void;
  onToggleMenu(): void;
}) {
  const metaId = useId();
  return (
    <>
      <li className="wsBoardItem">
        <div
          aria-describedby={`${metaId} ${helpId}`}
          aria-label={`${issue.key}: ${issue.title}`}
          className="wsBoardCard"
          data-busy={busy || undefined}
          data-card-id={issue.id}
          data-dragging={dragging || undefined}
          data-picked={picked || undefined}
          draggable={!busy}
          onDragEnd={onDragEnd}
          onDragStart={(event) => {
            if (busy) {
              event.preventDefault();
              return;
            }
            event.dataTransfer.setData("text/plain", issue.id);
            event.dataTransfer.effectAllowed = "move";
            onDragStart();
          }}
          onClick={onOpen}
          onKeyDown={onKeyDown}
          role="button"
          tabIndex={0}
        >
          <div className="wsBoardCardTop">
            <span className="wsKeyTag">{issue.key}</span>
            {showPoints && issue.storyPoints !== null && <span className="wsBoardPoints">{issue.storyPoints} {issue.storyPoints === 1 ? "pt" : "pts"}</span>}
          </div>
          <p className="wsBoardCardTitle">{issue.title}</p>
          <div className="wsBoardCardMeta" id={metaId}>
            <span className="wsBoardTag" data-type={issue.type}>{typeLabel(issue.type)}</span>
            <span className="wsBoardTag" data-priority={issue.priority}>{priorityLabel(issue.priority)}</span>
            {phaseName && <span className="wsBoardPhase">{phaseName}</span>}
            {issue.dueDate && (
              <span className="wsBoardDue" data-overdue={overdue || undefined}>
                <span className="wsSrOnly">{overdue ? "Overdue, due " : "Due "}</span>
                {formatDay(issue.dueDate)}
              </span>
            )}
            {issue.assignee && (
              <span className="wsBoardAssignee">
                <span className="wsSrOnly">Assigned to {issue.assignee.displayName}</span>
                <span aria-hidden="true" className="avatar tiny" title={issue.assignee.displayName}>{initials(issue.assignee.displayName, "?")}</span>
              </span>
            )}
          </div>
        </div>
        <div className="wsBoardMove">
          <button aria-expanded={menuOpen} aria-haspopup="menu" aria-label={`Move to… (${issue.key})`} className="wsBoardMoveButton" data-move-for={issue.id} disabled={busy} onClick={onToggleMenu} type="button">
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            Move to…
          </button>
          {menu}
        </div>
      </li>
      {marker}
    </>
  );
}

function QuickAdd({ status, blocked, describedBy, onCreate }: {
  status: BoardStatus;
  blocked: boolean;
  describedBy?: string;
  onCreate(title: string, idempotencyKey: string): Promise<void>;
}) {
  // One Idempotency-Key per draft: kept for a retry of the same title after a lost response, new after success or an edit.
  const [draft, setDraft] = useState<{ title: string; key: string | null }>({ title: "", key: null });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const title = draft.title.trim();
    if (!title || saving || blocked) return;
    const key = draft.key ?? crypto.randomUUID();
    setDraft({ title: draft.title, key });
    setSaving(true);
    setError(null);
    try {
      await onCreate(title, key);
      setDraft({ title: "", key: null });
    } catch (failure) {
      const uncertain = !(failure instanceof ApiError) || failure.status === 0 || failure.status >= 500;
      // A definite refusal created nothing, so the next attempt is a new request.
      if (!uncertain) setDraft((current) => ({ ...current, key: null }));
      if (!(failure instanceof ApiError && failure.code === "wip_limit_reached")) setError(messageOf(failure));
    } finally {
      setSaving(false);
    }
  };

  const describedByIds = [describedBy, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <form className="wsBoardAdd" onSubmit={submit}>
      <div className="wsBoardAddRow">
        <input
          aria-busy={saving || undefined}
          aria-describedby={describedByIds}
          aria-invalid={error ? true : undefined}
          aria-label={`Add a task to ${status.name}`}
          data-quick-add-for={status.id}
          disabled={blocked}
          maxLength={200}
          onChange={(event) => {
            setDraft({ title: event.target.value, key: null });
            setError(null);
          }}
          placeholder={blocked ? "Column is full" : "Add a task…"}
          readOnly={saving}
          value={draft.title}
        />
        <button aria-label={`Add task to ${status.name}`} className="wsBoardAddButton" disabled={blocked || saving || !draft.title.trim()} type="submit">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>
      {error && <p className="wsFieldError" id={errorId}>{error}</p>}
    </form>
  );
}
