"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import type { Tone } from "../_lib/format";
import { initials } from "../_lib/format";
import { AlertIcon, InboxIcon, RefreshIcon } from "./icons";

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="admPageHeader">
      <div>
        <p className="admEyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {description && <p className="admPageLead">{description}</p>}
      </div>
      {actions && <div className="admPageActions">{actions}</div>}
    </header>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`admBadge admTone-${tone}`}>{children}</span>;
}

export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  return <span aria-hidden="true" className={`admAvatar admAvatar-${size}`}>{initials(name)}</span>;
}

export function StatTile({ label, value, hint, tone = "blue", icon, href }: { label: string; value: number | string; hint?: ReactNode; tone?: Tone; icon: ReactNode; href?: string }) {
  const body = (
    <>
      <span className={`admStatIcon admTone-${tone}`}>{icon}</span>
      <span className="admStatLabel">{label}</span>
      <strong className="admStatValue">{typeof value === "number" ? value.toLocaleString("en-US") : value}</strong>
      {hint && <span className="admStatHint">{hint}</span>}
    </>
  );
  return href ? <Link className="admStat admStatLink" href={href}>{body}</Link> : <div className="admStat">{body}</div>;
}

export interface TabOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

/** Filter tabs. Implemented as toggle buttons: each changes the list below rather than switching panels. */
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

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="admSkeletonList" role="status">
      {Array.from({ length: rows }, (_, index) => <span className="admSkeleton" key={index} />)}
    </div>
  );
}

export function LoadMore({ hasMore, loading, onClick, shown }: { hasMore: boolean; loading: boolean; onClick: () => void; shown: number }) {
  if (!hasMore && shown === 0) return null;
  return (
    <div className="admLoadMore">
      <span>{shown} shown</span>
      {hasMore && (
        <button className="admBtn admBtnSecondary" disabled={loading} onClick={onClick} type="button">
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
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
