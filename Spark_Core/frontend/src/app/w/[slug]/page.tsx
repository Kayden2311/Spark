"use client";

import Link from "next/link";

import { PageTitle } from "../../components";
import { canManage, roleLabel } from "../_lib/api";
import { useWorkspaceData } from "../_lib/use-workspace-data";
import { useWorkspace } from "./workspace-context";

const ROLE_HINTS: Record<string, string> = {
  owner: "Full control, including roles",
  admin: "Invite and manage members",
  member: "Collaborate on every project",
};

const METHODS = [
  { name: "Scrum", tone: "blue", tag: "Sprints", text: "Time-boxed sprints, a groomed backlog and a review at the end of each cycle." },
  { name: "Kanban", tone: "green", tag: "Flow", text: "Work moves across columns with limits that keep the team focused." },
  { name: "Waterfall", tone: "amber", tag: "Phases", text: "Planned phases with milestones and a clear sign-off between them." },
] as const;

const dateFormat = new Intl.DateTimeFormat("en", { day: "numeric", month: "long", year: "numeric" });

export default function WorkspaceHomePage() {
  const { workspace } = useWorkspace();
  const manager = canManage(workspace.role);
  const invites = useWorkspaceData<{ items: unknown[]; nextCursor?: string | null }>(manager ? `/workspaces/${workspace.id}/invitations?status=pending` : null);
  const pending = invites.data ? `${invites.data.items.length}${invites.data.nextCursor ? "+" : ""}` : "—";
  const created = new Date(workspace.createdAt);

  return (
    <div className="wsHome">
      <div aria-hidden="true" className="wsGlow" />
      <PageTitle eyebrow={roleLabel(workspace.role)} title={workspace.name}>
        {manager && (
          <Link className="sparkPrimary" href={`/w/${workspace.slug}/members`}>
            <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10" cy="8.5" r="3.5" /><path d="M3.5 19.5c.7-3.4 3.3-5.2 6.5-5.2 1.4 0 2.7.3 3.8 1M18 13v6M15 16h6" /></svg>
            Invite teammates
          </Link>
        )}
      </PageTitle>
      <p className="wsHomeMeta">
        <span>spark.app/w/{workspace.slug}</span>
        {!Number.isNaN(created.getTime()) && <span>Created {dateFormat.format(created)}</span>}
      </p>

      <section aria-label="Workspace at a glance" className="wsStats">
        <article className="wsStat" data-testid="stat-members">
          <span className="wsStatLabel">Members</span>
          <strong>{workspace.memberCount}</strong>
          <span className="wsStatHint">{workspace.memberCount === 1 ? "Just you for now" : "Active in this workspace"}</span>
        </article>
        {manager && (
          <article aria-busy={invites.loading} className="wsStat" data-testid="stat-invites">
            <span className="wsStatLabel">Pending invites</span>
            <strong>{pending}</strong>
            <span className="wsStatHint">{invites.error ? "Couldn't load invitations" : "Waiting to join"}</span>
          </article>
        )}
        <article className="wsStat">
          <span className="wsStatLabel">Your role</span>
          <strong className="wsStatWord">{roleLabel(workspace.role)}</strong>
          <span className="wsStatHint">{ROLE_HINTS[workspace.role] ?? ROLE_HINTS.member}</span>
        </article>
      </section>

      <section aria-labelledby="projects-title" className="wsCard wsProjects">
        <header className="wsCardHeader">
          <div>
            <h2 id="projects-title">Projects</h2>
            <p>Plans, boards and timelines for everything your team ships.</p>
          </div>
          <span className="tag blue">Coming next</span>
        </header>
        <div className="wsEmpty">
          <div aria-hidden="true" className="wsEmptyArt">
            <span className="wsEmptyRing" />
            <span className="wsEmptyRing two" />
            <svg viewBox="0 0 24 24"><rect height="13" rx="2.5" width="16" x="4" y="6" /><path d="M9 6v13M15 6v13" /></svg>
          </div>
          <p className="wsEmptyTitle">Your first project starts here — choose Scrum, Kanban or Waterfall.</p>
          <p className="wsEmptyText">Projects are on their way to Spark workspaces. Each one runs the way your team already works.</p>
          <ul className="wsMethods">
            {METHODS.map((method) => (
              <li className="wsMethod" key={method.name}>
                <span className={`tag ${method.tone}`}>{method.tag}</span>
                <strong>{method.name}</strong>
                <span>{method.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
