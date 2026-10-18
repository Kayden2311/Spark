"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState, type CSSProperties } from "react";

import { useAuth } from "../../../../auth-context";
import { initials } from "../../../../components";
import { canManage } from "../../../_lib/api";
import { useMethodologies } from "../../../_lib/methodologies";
import { isValidProjectKey } from "../../../_lib/project-key";
import {
  formatDay,
  formatShortDay,
  methodologyAccent,
  methodologyName,
  methodologyOf,
  projectEtag,
  sprintLabel,
  todayIso,
  type ProjectDetail,
} from "../../../_lib/projects";
import { useWorkspaceData } from "../../../_lib/use-workspace-data";
import { useWorkspace } from "../../workspace-context";
import { PhaseTimeline } from "./phase-timeline";
import { ProjectSettingsDialog } from "./settings-dialog";

type Toast = { id: number; text: string };

export default function ProjectOverviewPage() {
  const { key = "" } = useParams<{ key: string }>();
  const { workspace, projects } = useWorkspace();
  const valid = isValidProjectKey(key);
  const loaded = useWorkspaceData<ProjectDetail>(valid ? `/workspaces/${workspace.id}/projects/by-key/${encodeURIComponent(key)}` : null);
  // A save (or a teammate's newer version seen on 412) replaces the loaded copy until the next load.
  const [override, setOverride] = useState<{ source: unknown; project: ProjectDetail; etag: string } | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast((current) => (current?.id === toast.id ? null : current)), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const replaced = override && override.source === loaded.data ? override : null;
  const project = replaced?.project ?? loaded.data;
  const etag = replaced?.etag ?? loaded.etag ?? (project ? projectEtag(project.version) : "");

  if (!valid || loaded.errorStatus === 404) {
    return (
      <section aria-labelledby="project-missing-title" className="wsStateCard">
        <div aria-hidden="true" className="wsGlow" />
        <p className="sparkKicker"><span aria-hidden="true" />Project</p>
        <h1 id="project-missing-title">This project isn&apos;t available</h1>
        <p>There is no project with the key {key || "—"} in {workspace.name}. It may have been archived, or the address is mistyped.</p>
        <Link className="sparkPrimary" href={`/w/${workspace.slug}`}>Back to workspace home</Link>
      </section>
    );
  }

  if (loaded.error && !loaded.loading && (!project || project.key !== key)) {
    return (
      <section aria-labelledby="project-error-title" className="wsStateCard">
        <p className="sparkKicker"><span aria-hidden="true" />Project</p>
        <h1 id="project-error-title">We couldn&apos;t open this project</h1>
        <p role="alert">{loaded.error}</p>
        <button className="sparkPrimary" onClick={loaded.reload} type="button">Try again</button>
      </section>
    );
  }

  // While another project's copy is still on screen after navigation, show the skeleton instead.
  if (!project || project.key !== key) {
    return (
      <div aria-busy="true" className="wsSkeleton" role="status">
        <span className="wsSrOnly">Loading project…</span>
        <span className="wsSkeletonLine short" />
        <span className="wsSkeletonLine title" />
        <span className="wsSkeletonBlock" />
      </div>
    );
  }

  const onSaved = (saved: ProjectDetail, nextEtag: string) => {
    setOverride({ source: loaded.data, project: saved, etag: nextEtag });
    setToast((current) => ({ id: (current?.id ?? 0) + 1, text: "Project settings saved." }));
    projects.reload();
  };

  const onStale = (current: ProjectDetail) => {
    setOverride({ source: loaded.data, project: current, etag: projectEtag(current.version) });
    projects.reload();
  };

  return (
    <>
      <ProjectOverview etag={etag} onSaved={onSaved} onStale={onStale} project={project} />
      {/* One live region stays mounted so screen readers announce each new message. */}
      <div aria-live="polite" className="wsToastRegion" role="status">
        {toast && (
          <div className="wsToast" data-tone="success" key={toast.id}>
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
            {toast.text}
            <button aria-label="Dismiss" onClick={() => setToast(null)} type="button"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
          </div>
        )}
      </div>
    </>
  );
}

function ProjectOverview({ project, etag, onSaved, onStale }: {
  project: ProjectDetail;
  etag: string;
  onSaved(project: ProjectDetail, etag: string): void;
  onStale(project: ProjectDetail): void;
}) {
  const { workspace } = useWorkspace();
  const { user } = useAuth();
  const catalog = useMethodologies();
  const [editing, setEditing] = useState(false);
  const methodology = methodologyOf(project.methodology);
  const name = methodologyName(project.methodology);
  const template = catalog.data?.find((item) => item.id === methodology);
  const canEdit = canManage(workspace.role) || (Boolean(user?.id) && project.lead?.id === user?.id);
  const accent = { "--method-accent": methodologyAccent(project.methodology) } as CSSProperties;
  const { done, total } = project.progress;

  return (
    <div className="wsProject" style={accent}>
      <div aria-hidden="true" className="wsGlow" />

      <section aria-label="Project details" className="wsProjectHero">
        <div className="wsProjectHeroMain">
          <p className="wsProjectHeroTags">
            <span className="wsKeyTag">{project.key}</span>
            <span className="wsMethodPill" data-methodology={methodology}>{name}</span>
          </p>
          <h1>{project.name}</h1>
          {project.description && <p className="wsProjectDescription">{project.description}</p>}
        </div>
        {canEdit && (
          <button className="sparkSecondary wsProjectSettingsButton" onClick={() => setEditing(true)} type="button">
            <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
            Settings
          </button>
        )}
        <dl className="wsProjectFacts">
          <div>
            <dt>Lead</dt>
            <dd>
              {project.lead
                ? <span className="wsProjectLead"><span aria-hidden="true" className="avatar tiny">{initials(project.lead.displayName, "?")}</span><span>{project.lead.displayName}</span></span>
                : <span className="muted">No lead</span>}
            </dd>
          </div>
          <div><dt>Start</dt><dd>{formatDay(project.startDate)}</dd></div>
          <div><dt>Target</dt><dd>{formatDay(project.targetDate)}</dd></div>
          <div><dt>Progress</dt><dd>{total > 0 ? `${done}/${total} done` : "No tasks yet"}</dd></div>
        </dl>
      </section>

      {/* Waterfall has no side card here (its timeline follows), so the board takes the full width. */}
      <div className={methodology === "waterfall" ? "wsProjectGridLayout single" : "wsProjectGridLayout"}>
        <section aria-labelledby="board-title" className="wsCard wsProjectBoard">
          <header className="wsCardHeader">
            <div>
              <h2 id="board-title">Board columns</h2>
              <p>Work items move through these columns, left to right.</p>
            </div>
          </header>
          <ol className="wsBoardColumns">
            {project.statuses.map((status) => (
              <li className="wsPickerColumn" data-category={status.category} key={status.id}>
                <span>{status.name}</span>
                {status.wipLimit !== null && <span className="wsPickerWip">WIP {status.wipLimit}</span>}
              </li>
            ))}
          </ol>
          <p className="wsProjectNote">
            <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path d="M12 8v4.5l3 1.8" /></svg>
            The board arrives in the next update.
          </p>
        </section>

        {methodology === "scrum" && (
          <section aria-labelledby="sprints-title" className="wsCard wsProjectMethod">
            <header className="wsCardHeader"><div><h2 id="sprints-title">Sprints</h2><p>Time-boxed cycles with a goal, a review and a retro.</p></div></header>
            <p className="wsProjectBig">{sprintLabel(project.sprintLengthDays)}</p>
            <p className="wsProjectMuted">Sprints start once tasks exist.</p>
          </section>
        )}

        {methodology === "kanban" && <WipSummary project={project} />}
      </div>

      {methodology === "waterfall" && (
        <section aria-labelledby="timeline-title" className="wsCard wsProjectTimeline">
          <header className="wsCardHeader">
            <div>
              <h2 id="timeline-title">Timeline</h2>
              <p>{formatDay(project.startDate)} – {formatDay(project.targetDate)}{project.baselinedAt ? " · baseline saved at creation" : ""}</p>
            </div>
            <ul aria-label="Legend" className="wsTimelineLegend">
              <li><span aria-hidden="true" className="wsLegendBar" />Planned</li>
              <li><span aria-hidden="true" className="wsLegendBaseline" />Baseline</li>
              <li><span aria-hidden="true" className="wsLegendMilestone" />Milestone</li>
            </ul>
          </header>
          <PhaseTimeline milestones={project.milestones} phases={project.phases} startDate={project.startDate} targetDate={project.targetDate} today={todayIso()} />
          {project.milestones.length > 0 && (
            <>
              <h3 className="wsMilestonesTitle">Milestones</h3>
              <ol aria-label="Milestones" className="wsMilestoneList">
                {project.milestones.map((milestone) => {
                  const phase = project.phases.find((item) => item.id === milestone.phaseId);
                  return (
                    <li key={milestone.id}>
                      <span aria-hidden="true" className="wsLegendMilestone" data-done={milestone.completedAt ? true : undefined} />
                      <span className="wsMilestoneName">{milestone.name}{phase && <small>{phase.name}</small>}</span>
                      <span className="wsMilestoneDue">
                        {milestone.completedAt ? "Done" : formatShortDay(milestone.dueDate)}
                        {milestone.baselineDueDate && milestone.baselineDueDate !== milestone.dueDate && <small>Baseline {formatShortDay(milestone.baselineDueDate)}</small>}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </section>
      )}

      {template && (
        <section aria-labelledby="practices-title" className="wsCard wsProjectPracticesCard">
          <header className="wsCardHeader"><div><h2 id="practices-title">Practices for {template.name}</h2><p>{template.tagline}</p></div></header>
          <ul className="wsPracticeList">
            {template.practices.map((practice) => <li key={practice}>{practice}</li>)}
          </ul>
        </section>
      )}

      {editing && (
        <ProjectSettingsDialog
          etag={etag}
          onClose={() => setEditing(false)}
          onSaved={(saved, nextEtag) => {
            setEditing(false);
            onSaved(saved, nextEtag);
          }}
          onStale={onStale}
          project={project}
          workspace={workspace}
        />
      )}
    </div>
  );
}

function WipSummary({ project }: { project: ProjectDetail }) {
  const limited = project.statuses.filter((status) => status.wipLimit !== null);
  const count = project.statuses.length;
  return (
    <section aria-labelledby="wip-title" className="wsCard wsProjectMethod">
      <header className="wsCardHeader"><div><h2 id="wip-title">WIP limits</h2><p>Limits keep the team finishing work before starting more.</p></div></header>
      <p className="wsProjectMuted">
        {limited.length === 0 ? "No column has a WIP limit yet." : `${limited.length} of ${count} ${count === 1 ? "column has" : "columns have"} a WIP limit.`}
      </p>
      {limited.length > 0 && (
        <ul className="wsWipList">
          {limited.map((status) => (
            <li key={status.id}>
              <span>{status.name}</span>
              <strong>{status.wipLimit}</strong>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
