"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { initials } from "../../../../components";
import { ApiError, messageOf, workspaceApi } from "../../../_lib/api";
import { addCard, columnIssues, currentTarget, keyboardTarget, moveCard, positionOf, replaceCard, wipBlocked, type ArrowKey, type MoveTarget } from "../../../_lib/board-moves";
import { boardPath, createIssue, moveIssue, priorityLabel, toCard, typeLabel, type BoardState, type BoardStatus, type IssueCard, type IssueMove } from "../../../_lib/issues";
import { formatDay, methodologyOf, todayIso } from "../../../_lib/projects";
import { useWorkspaceData } from "../../../_lib/use-workspace-data";
import { useProject } from "./project-context";

export const TEAMMATE_MOVED = "Updated by a teammate — the board was refreshed.";
export const TEAMMATE_MOVED_STALE = "Updated by a teammate. Reload the page to see the latest board.";
const ARROWS: readonly string[] = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];

/** The inline explanation a full column shows. `fallback` is the API's sentence when the local copy has no limit yet. */
export function wipMessage(status: BoardStatus | undefined, fallback?: string): string {
  if (status && status.wipLimit !== null) return `${status.name} is at its WIP limit (${status.wipLimit}). Finish or move a task out first.`;
  return `${fallback ?? "This column is at its WIP limit."} Finish or move a task out first.`;
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
  const path = boardPath(project.id);
  const loaded = useWorkspaceData<BoardState>(path);
  const base = loaded.dataPath === path ? loaded.data : null;
  // Optimistic edits apply to the loaded copy they were made on; a reload (or 412 refresh) drops them.
  const [local, setLocal] = useState<{ source: BoardState; board: BoardState } | null>(null);
  const committed = base && local?.source === base ? local.board : base;
  const baseRef = useRef<BoardState | null>(null);
  // Moves still waiting for the API; the silent refresh after a move waits until none are left.
  const pendingRef = useRef(0);
  const [pickup, setPickup] = useState<Pickup | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [focusRequest, setFocusRequest] = useState<{ selector: string; serial: number } | null>(null);
  const helpId = useId();

  useEffect(() => {
    baseRef.current = base;
  }, [base]);

  // Moving a card to another column remounts it, so focus follows it explicitly.
  useEffect(() => {
    if (focusRequest) document.querySelector<HTMLElement>(focusRequest.selector)?.focus();
  }, [focusRequest]);

  const focusCard = (issueId: string) => setFocusRequest((current) => ({ selector: `[data-card-id="${issueId}"]`, serial: (current?.serial ?? 0) + 1 }));
  const focusMoveButton = (issueId: string) => setFocusRequest((current) => ({ selector: `[data-move-for="${issueId}"]`, serial: (current?.serial ?? 0) + 1 }));

  /** Applies a change to the board copy that `source` was loaded as; changes for an outdated copy are dropped. */
  const update = (source: BoardState, change: (board: BoardState) => BoardState) => {
    if (baseRef.current !== null && source !== baseRef.current) return;
    setLocal((previous) => ({ source, board: change(previous && previous.source === source ? previous.board : source) }));
  };

  /**
   * Refetches the board without a loading state and puts it in place of the local copy, so versions
   * reranked by the server and counts stay current. A silent refresh is skipped while other moves are
   * in flight (the last one to settle refreshes again); `force` applies it regardless. Resolves false
   * when the board could not be fetched.
   */
  const refresh = async (force: boolean): Promise<boolean> => {
    const source = baseRef.current;
    if (!source) return false;
    try {
      const { data } = await workspaceApi<BoardState>(path);
      if (baseRef.current === source && (force || pendingRef.current === 0)) setLocal({ source, board: data });
      return true;
    } catch {
      return false;
    }
  };

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

  const describe = (state: BoardState, issue: IssueCard) => {
    const where = positionOf(state, issue.id);
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
      if (key !== " " && key !== "Enter") return;
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
      const target = keyboardTarget(pickup.preview, issue.id, key as ArrowKey);
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
      <p className="wsSrOnly" id={helpId}>Press Space or Enter to pick up the task, arrow keys to move it, Enter to drop it and Escape to cancel. The Move to button offers the same moves from a menu.</p>
      {board.truncated && (
        <p className="wsBoardBanner" role="note">
          <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 7.5v.5" /></svg>
          Showing the first 500 tasks.
        </p>
      )}
      <div className="wsBoardScroller">
        {board.statuses.map((status) => {
          const cards = columnIssues(board, status.id);
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
                        board={committed}
                        issue={issue}
                        onClose={(restoreFocus) => {
                          setMenuFor(null);
                          if (restoreFocus) focusMoveButton(issue.id);
                        }}
                        onPick={(target) => moveToColumn(issue, target)}
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
    </section>
  );
}

function BoardCardItem({ issue, helpId, picked, busy, dragging, overdue, phaseName, showPoints, marker, menu, menuOpen, onKeyDown, onDragStart, onDragEnd, onToggleMenu }: {
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

function MoveMenu({ issue, board, onClose, onPick }: {
  issue: IssueCard;
  board: BoardState;
  onClose(restoreFocus: boolean): void;
  onPick(status: BoardStatus): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  // The board scrolls sideways, which clips anything inside it, so the menu lives in <body> with fixed
  // coordinates taken from its button: below it, or above it when the viewport has no room below.
  useLayoutEffect(() => {
    const menu = ref.current;
    const anchor = document.querySelector<HTMLElement>(`[data-move-for="${issue.id}"]`);
    if (!menu || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    const below = window.innerHeight - rect.bottom;
    const top = below >= menu.offsetHeight + margin || rect.top < menu.offsetHeight + margin ? rect.bottom + 4 : rect.top - menu.offsetHeight - 4;
    const left = Math.min(Math.max(margin, rect.right - menu.offsetWidth), window.innerWidth - menu.offsetWidth - margin);
    menu.style.top = `${Math.max(margin, top)}px`;
    menu.style.left = `${Math.max(margin, left)}px`;
  }, [issue.id]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[role=\"menuitemradio\"]:not([aria-disabled=\"true\"])")?.focus({ preventScroll: true });
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      const anchor = document.querySelector(`[data-move-for="${issue.id}"]`);
      if (!ref.current?.contains(target) && !anchor?.contains(target)) closeRef.current(false);
    };
    // Fixed coordinates go stale when anything scrolls or the viewport changes.
    const onMoved = (event: Event) => {
      if (!(event.target instanceof Node && ref.current?.contains(event.target))) closeRef.current(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onMoved, true);
    window.addEventListener("resize", onMoved);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onMoved, true);
      window.removeEventListener("resize", onMoved);
    };
  }, [issue.id]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("[role=\"menuitemradio\"]") ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      onClose(true);
    } else if (event.key === "Tab") {
      // The menu sits at the end of <body>; return to the button so Tab continues from the card.
      event.preventDefault();
      onClose(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? items[0] : items.at(-1))?.focus();
    }
  };

  return createPortal(
    <div aria-label={`Move ${issue.key} to`} className="wsBoardMenu" onKeyDown={onKeyDown} ref={ref} role="menu">
      {board.statuses.map((status) => {
        const current = status.id === issue.statusId;
        const full = !current && wipBlocked(board, issue.id, status.id);
        return (
          <button aria-checked={current} aria-disabled={full || undefined} aria-label={`${status.name}${current ? " (current)" : full ? " (full)" : ""}`} className="wsBoardMenuItem" key={status.id} onClick={() => !full && onPick(status)} role="menuitemradio" tabIndex={-1} type="button">
            <span aria-hidden="true" className="wsBoardMenuCheck">{current && <svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>}</span>
            {status.name}
            {current && <span className="wsBoardMenuHint"> (current)</span>}
            {full && <span className="wsBoardMenuHint"> (full)</span>}
          </button>
        );
      })}
    </div>,
    document.body,
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
