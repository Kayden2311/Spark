import Link from "next/link";
import type { ReactNode } from "react";

const navigation = [["Board", "/workspace", "▦"], ["Schedule", "/schedule", "◷"], ["Notifications", "/notifications", "●"], ["Billing", "/billing", "◫"]] as const;

export function WorkspaceShell({ children, current }: { children: ReactNode; current: string }) {
  return <div className="appShell"><aside className="sidebar"><Link className="brand sidebarBrand" href="/">Spark</Link><div className="workspacePicker"><span className="avatar">NF</span><span>Northstar Founders</span><span>⌄</span></div><nav className="sideNav" aria-label="Workspace navigation">{navigation.map(([label, href, icon]) => <Link className={label === current ? "navItem active" : "navItem"} href={href} key={label}><span>{icon}</span>{label}{label === "Notifications" && <b>3</b>}</Link>)}</nav><div className="sidebarFoot"><span className="avatar">ML</span><span>Mai Linh</span><button type="button" aria-label="Account settings">•••</button></div></aside><main className="appMain">{children}</main></div>;
}

export function PageTitle({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return <header className="pageTitle"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1></div>{children}</header>;
}
