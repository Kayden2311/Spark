"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { rememberFocus } from "../_lib/focus-return";
import type { ContentViewer } from "../_lib/content-api";

export type ModerateAction = "hide" | "restore";

interface ContentMenuProps {
  viewer: ContentViewer;
  /** True when moderators hid the item; the moderator item then reads Restore. */
  hidden: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
  /** Hooks for the report and moderation dialogs. An item is offered only when its hook is passed. */
  onReport?: () => void;
  onModerate?: (action: ModerateAction) => void;
  /** What the menu acts on, for its accessible name: "More actions for <subject>". */
  subject?: string;
}

interface Item {
  label: string;
  run: () => void;
  disabled?: boolean;
}

export const REPORTED_LABEL = "You reported this";

/** The "More actions" menu of a post or comment; what it offers follows the viewer flags the API sent. */
export function ContentMenu({ viewer, hidden, onEdit, onDelete, onReport, onModerate, subject }: ContentMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const items: Item[] = [];
  if (viewer.canEdit && onEdit) items.push({ label: "Edit", run: onEdit });
  if (viewer.canDelete && onDelete) items.push({ label: "Delete", run: onDelete });
  if (viewer.canReport && !viewer.reported && onReport) items.push({ label: "Report", run: onReport });
  if (viewer.reported && onReport) items.push({ label: REPORTED_LABEL, run: () => undefined, disabled: true });
  if (viewer.canModerate && onModerate) {
    const action: ModerateAction = hidden ? "restore" : "hide";
    items.push({ label: hidden ? "Restore" : "Hide", run: () => onModerate(action) });
  }
  const visible = items.length > 0;

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  // Opening the menu puts focus on its first item.
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  if (!visible) return null;

  const onListKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const entries = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const go = (index: number) => {
      event.preventDefault();
      entries[(index + entries.length) % entries.length]?.focus();
    };
    if (event.key === "ArrowDown") go(at + 1);
    else if (event.key === "ArrowUp") go(at < 0 ? entries.length - 1 : at - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(entries.length - 1);
    else if (event.key === "Tab") setOpen(false);
  };

  return (
    <div className="circleMenu" ref={root}>
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={subject ? `More actions for ${subject}` : "More actions"}
        className="circleMenuTrigger"
        onClick={() => setOpen((value) => !value)}
        ref={trigger}
        type="button"
      >
        <svg aria-hidden="true" fill="currentColor" height="18" viewBox="0 0 20 20" width="18">
          <circle cx="4" cy="10" r="1.6" />
          <circle cx="10" cy="10" r="1.6" />
          <circle cx="16" cy="10" r="1.6" />
        </svg>
      </button>
      {open && (
        <div className="circleMenuList" id={menuId} onKeyDown={onListKey} ref={list} role="menu">
          {items.map((item) => (
            <button
              className={`circleMenuItem${item.label === "Delete" ? " circleMenuItemDanger" : ""}${item.disabled ? " circleMenuItemDisabled" : ""}`}
              key={item.label}
              aria-disabled={item.disabled || undefined}
              onClick={() => {
                if (item.disabled) return;
                if (item.label !== "Edit") rememberFocus(trigger.current);
                setOpen(false);
                item.run();
              }}
              role="menuitem"
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
