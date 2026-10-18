"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import type { Tone } from "../_lib/format";
import { ROLE_LABELS, ROLE_TONES, describeChange, initials } from "../_lib/format";
import type { PlatformRole } from "../_lib/types";
import { Sparkline } from "./sparkline";
import { AlertIcon, ArrowDownIcon, ArrowUpIcon, ChevronIcon, InboxIcon, MoreIcon, RefreshIcon, ShieldIcon } from "./icons";

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

export interface KpiCardItem {
  label: string;
  value: string | undefined;
  /** Current and previous period values; the card states the change in words. */
  change?: { current: number; previous: number | null | undefined; higherIsBetter?: boolean };
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: Tone;
  trend?: { values: number[]; color: string };
  href?: string;
}

/** KPI cards: a tinted icon chip, the value, the change against the previous period and a sparkline. */
export function KpiCards({ items, label }: { items: KpiCardItem[]; label: string }) {
  return (
    <ul aria-label={label} className="admKpiCards">
      {items.map((item) => {
        const change = item.change ? describeChange(item.change.current, item.change.previous) : null;
        const good = change && item.change && change.direction !== "flat" && change.direction !== "none"
          ? (change.direction === "up") === (item.change.higherIsBetter ?? true)
          : null;
        const body = (
          <>
            <div className="admKpiCardTop">
              {item.icon && <span aria-hidden="true" className={`admKpiChip admTone-${item.tone ?? "blue"}`}>{item.icon}</span>}
              <span className="admKpiCardLabel">{item.label}</span>
            </div>
            <div className="admKpiCardRow">
              <div className="admKpiCardMain">
                <span className="admKpiCardValue">{item.value ?? "–"}</span>
                {change && (
                  <span className="admDelta" data-direction={change.direction} data-good={good === null ? undefined : String(good)}>
                    {change.direction === "up" ? <ArrowUpIcon /> : change.direction === "down" ? <ArrowDownIcon /> : null}
                    {change.text}
                    {change.direction !== "none" && <span className="admDeltaNote"> vs previous period</span>}
                  </span>
                )}
                {item.hint && <span className="admKpiCardHint">{item.hint}</span>}
              </div>
              {item.trend && <Sparkline color={item.trend.color} values={item.trend.values} />}
            </div>
          </>
        );
        return (
          <li key={item.label}>
            {item.href ? <Link className="admKpiCard admKpiCardLink" href={item.href}>{body}</Link> : <div className="admKpiCard">{body}</div>}
          </li>
        );
      })}
    </ul>
  );
}

/** Segmented control for a small set of mutually exclusive views or ranges. */
export function Segmented<T extends string | number>({ label, options, value, onChange }: { label: string; options: Array<{ value: T; label: string; icon?: ReactNode }>; value: T; onChange: (value: T) => void }) {
  return (
    <div aria-label={label} className="admSegmented" role="group">
      {options.map((option) => (
        <button aria-pressed={option.value === value} key={String(option.value)} onClick={() => onChange(option.value)} type="button">
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

export const RANGES = [7, 30, 90, 180] as const;
export type RangeDays = (typeof RANGES)[number];

export function RangePicker({ value, onChange }: { value: RangeDays; onChange: (value: RangeDays) => void }) {
  return <Segmented label="Date range" onChange={onChange} options={RANGES.map((days) => ({ value: days, label: `${days}d` }))} value={value} />;
}

/** Icon chip plus a big number: one focused fact, used in place of a dense list row. */
export function MetricTile({ icon, label, value, hint }: { icon: ReactNode; label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="admMetricTile">
      {icon}
      <div className="admMetricText">
        <span className="admMetricLabel">{label}</span>
        <strong className="admMetricValue">{value}</strong>
        {hint && <span className="admMetricHint">{hint}</span>}
      </div>
    </div>
  );
}

export interface FacetOption {
  value: string;
  label: string;
  count?: number;
}

/**
 * A checkbox multi-select filter in a popover, for narrowing a list by a facet (reason, community…)
 * with more options than a segmented control or tabs comfortably hold. Nothing selected means "all".
 */
export function CheckboxFacet({ label, options, selected, onChange }: { label: string; options: FacetOption[]; selected: Set<string>; onChange: (next: Set<string>) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };

  return (
    <div className="admFacet" ref={wrap}>
      <button aria-controls={open ? panelId : undefined} aria-expanded={open} className="admBtn admBtnSecondary admBtnSm admFacetBtn" onClick={() => setOpen((value) => !value)} type="button">
        {label}
        {selected.size > 0 && <span className="admFacetCount">{selected.size}</span>}
        <ChevronIcon aria-hidden="true" className="admFacetChevron" />
      </button>
      {open && (
        <div aria-label={`Filter by ${label.toLowerCase()}`} className="admFacetPanel" id={panelId}>
          {options.length === 0 ? (
            <p className="admFacetEmpty">Nothing to filter yet.</p>
          ) : (
            <>
              <ul className="admFacetOptions">
                {options.map((option) => (
                  <li key={option.value}>
                    <label className="admFacetOption">
                      <input checked={selected.has(option.value)} onChange={() => toggle(option.value)} type="checkbox" />
                      <span className="admFacetOptionLabel">{option.label}</span>
                      {option.count !== undefined && <span className="admFacetOptionCount">{option.count}</span>}
                    </label>
                  </li>
                ))}
              </ul>
              {selected.size > 0 && (
                <button className="admBtn admBtnGhost admBtnSm admFacetClear" onClick={() => onChange(new Set())} type="button">Clear</button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** A card with a heading row; the building block for non-chart sections. */
export function Card({ title, subtitle, actions, children, className, flush }: { title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={`admCard${flush ? " admCardFlush" : ""}${className ? ` ${className}` : ""}`}>
      <div className="admCardHead">
        <div>
          <h2 id={headingId}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {actions && <div className="admCardActions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

const ROLE_RANK: PlatformRole[] = ["super_admin", "platform_admin", "content_moderator", "community_moderator", "campaign_moderator"];

/** A member's platform roles in one line: the highest role, then "+N more" with the full list on hover. */
export function RoleSummary({ roles, empty = "Member" }: { roles: PlatformRole[]; empty?: string }) {
  if (roles.length === 0) return <span className="admMutedCell">{empty}</span>;
  const sorted = [...roles].sort((a, b) => ROLE_RANK.indexOf(a) - ROLE_RANK.indexOf(b));
  const [top, ...rest] = sorted;
  const all = sorted.map((role) => ROLE_LABELS[role]).join(", ");
  return (
    <span className="admRoleSummary" title={all}>
      <span className={`admRoleChip admTone-${ROLE_TONES[top!]}`}><ShieldIcon aria-hidden="true" />{ROLE_LABELS[top!]}</span>
      {rest.length > 0 && <span aria-hidden="true" className="admRoleMore">+{rest.length}</span>}
      {rest.length > 0 && <span className="admSrOnly">, also {rest.map((role) => ROLE_LABELS[role]).join(", ")}</span>}
    </span>
  );
}
