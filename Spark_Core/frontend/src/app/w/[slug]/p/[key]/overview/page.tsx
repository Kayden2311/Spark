"use client";

import Link from "next/link";

import { initials } from "../../../../../components";
import { useMethodologies } from "../../../../_lib/methodologies";
import { formatDay, formatShortDay, methodologyOf, sprintLabel, todayIso, type ProjectDetail } from "../../../../_lib/projects";
import { useWorkspace } from "../../../workspace-context";
import { PhaseTimeline } from "../phase-timeline";
import { useProject } from "../project-context";

/** The M2 project overview: facts, columns, methodology cards, the Waterfall timeline and practices. */
export default function ProjectOverviewPage() {
  const { project } = useProject();
  const { workspace } = useWorkspace();
  const catalog = useMethodologies();
  const methodology = methodologyOf(project.methodology);
  const template = catalog.data?.find((item) => item.id === methodology);
  const { done, total } = project.progress;

  return (
    <>
      <section aria-label="Project details" className="wsProjectDetails">
        {project.description && <p className="wsProjectDescription">{project.description}</p>}
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
            <svg aria-hidden="true" viewBox="0 0 24 24"><rect height="14" rx="2" width="5" x="3.5" y="5" /><rect height="9" rx="2" width="5" x="9.5" y="5" /><rect height="11" rx="2" width="5" x="15.5" y="5" /></svg>
            <Link href={`/w/${workspace.slug}/p/${encodeURIComponent(project.key)}`}>Open the board</Link>
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

    </>
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
