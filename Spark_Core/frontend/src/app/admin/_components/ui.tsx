"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import type { Tone } from "../_lib/format";
import { initials } from "../_lib/format";
import { AlertIcon, InboxIcon, MoreIcon, RefreshIcon } from "./icons";

export function PageHeader({ title, description, actions, meta }: { title: string; description?: ReactNode; actions?: ReactNode; meta?: ReactNode }) {
  return (
    <header className="admPageHeader">
      <div className="admPageHeading">
        <h1>{title}</h1>
        {description && <p className="admPageLead">{description}</p>}
        {meta && <div className="admPageMeta">{meta}</div>}
      </div>
      {actions && <div className="admPageActions">{actions}</div>}
    </header>
  );
}

/** Status label. A leading dot plus text, so meaning never relies on color alone. */
export function Badge({ tone = "neutral", children, dot = true }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`admBadge admTone-${tone}`}>
      {dot && <span aria-hidden="true" className="admBadgeDot" />}
      {children}
    </span>
  );
}

/** Quiet label for categories such as roles or content types. */
export function Tag({ children }: { children: ReactNode }) {
  return <span className="admTag">{children}</span>;
}

export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  return <span aria-hidden="true" className={`admAvatar admAvatar-${size}`}>{initials(name)}</span>;
}

export interface Kpi {
  label: string;
  value: number | string | undefined;
  hint?: ReactNode;
  href?: string;
}

/** A single bordered strip of key numbers, divided into columns (dashboard summary row). */
export function KpiStrip({ items, label }: { items: Kpi[]; label: string }) {
  return (
    <dl aria-label={label} className="admKpis">
      {items.map((item) => {
        const body = (
          <>
            <dt>{item.label}</dt>
            <dd>
              <span className="admKpiValue">{item.value === undefined ? "–" : typeof item.value === "number" ? item.value.toLocaleString("en-US") : item.value}</span>
              {item.hint && <span className="admKpiHint">{item.hint}</span>}
            </dd>
          </>
        );
        return item.href ? (
          <Link className="admKpi admKpiLink" href={item.href} key={item.label}>{body}</Link>
        ) : (
          <div className="admKpi" key={item.label}>{body}</div>
        );
      })}
    </dl>
  );
}

export interface TabOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

/** Underlined filter tabs. They are toggle buttons: each changes the list below rather than switching panels. */
export function FilterTabs<T extends string>({ label, options, value, onChange }: { label: string; options: TabOption<T>[]; value: T; onChange: (value: T) => void }) {
  return (
    <div aria-label={label} className="admTabs" role="group">
      {options.map((option) => (
        <button aria-pressed={option.value === value} className="admTab" key={option.value} onClick={() => onChange(option.value)} type="button">
          {option.label}
          {option.count !== undefined && <span className="admTabCount">{option.count}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * The main container for a list: filters on top, the table or cards in the middle, and a footer.
 * Keeping all three in one bordered surface reads as a single object, as in most admin consoles.
 */
export function Panel({ tabs, tools, children, footer, label }: { tabs?: ReactNode; tools?: ReactNode; children: ReactNode; footer?: ReactNode; label?: string }) {
  return (
    <section aria-label={label} className="admPanel">
      {(tabs || tools) && (
        <div className="admPanelHeader">
          {tabs}
          {tools && <div className="admPanelTools">{tools}</div>}
        </div>
      )}
      <div className="admPanelBody">{children}</div>
      {footer && <div className="admPanelFooter">{footer}</div>}
    </section>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="admEmpty">
      <span className="admEmptyIcon"><InboxIcon /></span>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="admError" role="alert">
      <AlertIcon />
      <span>{message}</span>
      {onRetry && (
        <button className="admBtn admBtnSecondary admBtnSm" onClick={onRetry} type="button">
          <RefreshIcon /> Retry
        </button>
      )}
    </div>
  );
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="admSkeletonList" role="status">
      {Array.from({ length: rows }, (_, index) => <span className="admSkeleton" key={index} />)}
    </div>
  );
}

/** Table footer: how many rows are on screen, and a button to fetch the next page. */
export function LoadMore({ hasMore, loading, onClick, shown, noun = "result", plural }: { hasMore: boolean; loading: boolean; onClick: () => void; shown: number; noun?: string; plural?: string }) {
  return (
    <>
      <span className="admFooterCount">{shown.toLocaleString("en-US")} {shown === 1 ? noun : plural ?? `${noun}s`}{hasMore ? " shown" : ""}</span>
      {hasMore && (
        <button className="admBtn admBtnSecondary admBtnSm" disabled={loading} onClick={onClick} type="button">
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </>
  );
}

export function NoAccess() {
  return (
    <div className="admEmpty admNoAccess">
      <span className="admEmptyIcon admTone-amber"><AlertIcon /></span>
      <h2>You don&apos;t have access to this section</h2>
      <p>Your platform role doesn&apos;t include it. Ask a super admin if you need access.</p>
      <Link className="admBtn admBtnSecondary" href="/admin">Back to overview</Link>
    </div>
  );
}

export function KeyValue({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="admKeyValue">
      {items.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface MenuAction {
  label: string;
  onSelect: () => void;
  tone?: "danger";
  separated?: boolean;
}

/**
 * Overflow ("more actions") menu for a table row. Follows the WAI-ARIA menu button pattern:
 * Enter, Space or ArrowDown opens it, arrow keys move between items, Escape closes and
 * returns focus to the button.
 */
export function RowMenu({ label, actions }: { label: string; actions: MenuAction[] }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const onPointer = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);

  if (actions.length === 0) return null;

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (event.key === "Tab") {
      close(false);
    }
  };

  return (
    <div className="admMenuWrap">
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        className="admIconBtn admIconBtnGhost"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        ref={button}
        type="button"
      >
        <MoreIcon />
      </button>
      {open && (
        <div aria-label={label} className="admMenu" id={menuId} onKeyDown={onMenuKey} ref={menu} role="menu">
          {actions.map((action) => (
            <button
              className={`admMenuItem${action.tone === "danger" ? " admMenuItemDanger" : ""}${action.separated ? " admMenuItemSeparated" : ""}`}
              key={action.label}
              onClick={() => {
                // Refocus the trigger first, so a dialog opened by the action returns focus there.
                close();
                action.onSelect();
              }}
              role="menuitem"
              tabIndex={-1}
              type="button"
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
