"use client";

import { useEffect, useId, useRef, useState } from "react";
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
}

interface Item {
  label: string;
  run: () => void;
}

/** The "More actions" menu of a post or comment; what it offers follows the viewer flags the API sent. */
export function ContentMenu({ viewer, hidden, onEdit, onDelete, onReport, onModerate }: ContentMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const items: Item[] = [];
  if (viewer.canEdit && onEdit) items.push({ label: "Edit", run: onEdit });
  if (viewer.canDelete && onDelete) items.push({ label: "Delete", run: onDelete });
  if (viewer.canReport && !viewer.reported && onReport) items.push({ label: "Report", run: onReport });
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

  if (!visible) return null;

  return (
    <div className="circleMenu" ref={root}>
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="More actions"
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
        <div className="circleMenuList" id={menuId} role="menu">
          {items.map((item) => (
            <button
              className={`circleMenuItem${item.label === "Delete" ? " circleMenuItemDanger" : ""}`}
              key={item.label}
              onClick={() => {
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
