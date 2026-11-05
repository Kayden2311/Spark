import type { CSSProperties, ReactNode } from "react";

export interface PageHeaderProps {
  title: string;
  /** One line under the title: a count, an address, a date range. */
  lead?: ReactNode;
  /** Small badges next to the title, such as a project key and methodology. */
  meta?: ReactNode;
  /** Buttons on the right of the title row. */
  actions?: ReactNode;
  /** The workspace or project square shown before the title (decorative: the title names it). */
  square?: { label: string; color: string };
  /** Rendered under the title row, typically view tabs. */
  children?: ReactNode;
}

/** The member app's page header: compact title row, optional entity square, meta, actions and tabs. */
export function PageHeader({ title, lead, meta, actions, square, children }: PageHeaderProps) {
  return (
    <header className={children ? "spPageHeader spPageHeaderTabbed" : "spPageHeader"}>
      <div className="spPageHeaderRow">
        {square && <span aria-hidden="true" className="spSquare spSquareLg" style={{ "--sp-square": square.color } as CSSProperties}>{square.label}</span>}
        <div className="spPageHeading">
          <div className="spPageTitleRow">
            <h1>{title}</h1>
            {meta && <span className="spPageMeta">{meta}</span>}
          </div>
          {lead && <p className="spPageLead">{lead}</p>}
        </div>
        {actions && <div className="spPageActions">{actions}</div>}
      </div>
      {children}
    </header>
  );
}
