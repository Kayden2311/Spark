"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useAuth } from "../../../../../auth-context";
import { ApiError, messageOf } from "../../../../_lib/api";
import { boardPath, type BoardState } from "../../../../_lib/issues";
import {
  canPlan,
  phaseVariance,
  PLAN_AUTHORITY_MESSAGE,
  planPath,
  planProgress,
  updateMilestone,
  varianceDescription,
  varianceLabel,
  varianceTone,
  withMilestone,
  type PlanMilestone,
  type ProjectPlan,
} from "../../../../_lib/planning";
import { formatDay, formatShortDay, methodologyOf, todayIso } from "../../../../_lib/projects";
import { useWorkspaceData } from "../../../../_lib/use-workspace-data";
import { useWorkspace } from "../../../workspace-context";
import { MilestoneDialog, PhasePlanDialog, RebaselineDialog } from "../phase-plan-dialog";
import { PhaseTimeline, progressLabel } from "../phase-timeline";
import { useProject } from "../project-context";

export const MILESTONE_REFRESHED = "Updated by a teammate — the milestone was refreshed.";

export const HISTORY_NOTE = "Plan from the Waterfall period. Phases are kept as history and can't change; milestones stay editable.";

/**
 * Waterfall planning: the phase Gantt with baselines, progress and milestones, and the same plan as tables.
 * A project that left Waterfall keeps its plan here as history: phases read-only, milestones still editable.
 */
export default function ProjectTimelinePage() {
  const { project } = useProject();
  const { workspace } = useWorkspace();
  const waterfall = methodologyOf(project.methodology) === "waterfall";
  if (!waterfall && project.phases.length === 0 && project.milestones.length === 0) {
    return (
      <section aria-labelledby="timeline-other-title" className="wsCard wsBoardState">
        <h2 id="timeline-other-title">The timeline is for Waterfall projects</h2>
        <p>{project.name} plans its work on the board.</p>
        <Link className="sparkPrimary" href={`/w/${workspace.slug}/p/${encodeURIComponent(project.key)}`}>Open the board</Link>
      </section>
    );
  }
  // Keyed by project so a switch between projects never mixes their plans.
  return <WaterfallTimeline key={project.id} waterfall={waterfall} />;
}

type Dialog = { kind: "phases" } | { kind: "milestone"; milestone: PlanMilestone | null } | { kind: "baseline" };

/** `waterfall` false: the plan of an earlier Waterfall period (the API only edits phases of Waterfall projects). */
function WaterfallTimeline({ waterfall }: { waterfall: boolean }) {
  const { project, notify, reloadProject } = useProject();
  const { workspace } = useWorkspace();
  const { user } = useAuth();
  const planner = canPlan(workspace.role, project, user?.id);
  const loadedPlan = useWorkspaceData<ProjectPlan>(planPath(project.id));
  const loadedBoard = useWorkspaceData<BoardState>(boardPath(project.id));
  // A write shows at once; it replaces the loaded plan until the next load.
  const [local, setLocal] = useState<{ source: unknown; plan: ProjectPlan } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [focusRequest, setFocusRequest] = useState<{ selector: string; serial: number } | null>(null);

  useEffect(() => {
    if (focusRequest) document.querySelector<HTMLElement>(focusRequest.selector)?.focus();
  }, [focusRequest]);

  const plan = loadedPlan.data ? (local?.source === loadedPlan.data ? local.plan : loadedPlan.data) : null;

  if (!plan) {
    if (loadedPlan.error && !loadedPlan.loading) {
      return (
        <section aria-labelledby="timeline-error-title" className="wsCard wsBoardState">
          <h2 id="timeline-error-title">We couldn&apos;t load the timeline</h2>
          <p role="alert">{loadedPlan.error}</p>
          <button className="sparkPrimary" onClick={loadedPlan.reload} type="button">Try again</button>
        </section>
      );
    }
    return (
      <div aria-busy="true" className="wsBacklogSkeleton" role="status">
        <span className="wsSrOnly">Loading timeline…</span>
        <span /><span />
      </div>
    );
  }

  const today = todayIso();
  const startDate = project.startDate ?? "";
  const targetDate = project.targetDate ?? "";
  const boardUrl = `/w/${workspace.slug}/p/${encodeURIComponent(project.key)}`;
  const board = loadedBoard.data;
  const counts = board ? planProgress(board, plan.phases.map((phase) => phase.id)) : null;
  const boardFailed = !board && Boolean(loadedBoard.error) && !loadedBoard.loading;
  const phaseName = new Map(plan.phases.map((phase) => [phase.id, phase.name]));

  const source = loadedPlan.data;
  /** Applies a change to the plan on screen (several milestone writes may settle in any order). */
  const changePlan = (change: (current: ProjectPlan) => ProjectPlan) =>
    setLocal((previous) => ({ source, plan: change(previous && previous.source === source ? previous.plan : (source as ProjectPlan)) }));
  const showPlan = (next: ProjectPlan) => changePlan(() => next);
  const focusSelector = (selector: string) => setFocusRequest((current) => ({ selector, serial: (current?.serial ?? 0) + 1 }));

  const toggleCompleted = (milestone: PlanMilestone) => {
    if (!planner || busy[milestone.id]) return;
    const completed = !milestone.completedAt;
    setBusy((current) => ({ ...current, [milestone.id]: true }));
    updateMilestone(milestone, { completed })
      .then((saved) => {
        changePlan((current) => withMilestone(current, saved));
        notify(completed ? `${saved.name} completed.` : `${saved.name} reopened.`);
        reloadProject();
      })
      .catch((error: unknown) => {
        const current = error instanceof ApiError && error.status === 412 ? (error.body as { current?: PlanMilestone } | null)?.current : undefined;
        if (current) {
          changePlan((latest) => withMilestone(latest, current));
          notify(MILESTONE_REFRESHED, "info");
        } else {
          notify(messageOf(error), "error");
        }
      })
      .finally(() => {
        setBusy((current) => {
          const next = { ...current };
          delete next[milestone.id];
          return next;
        });
        focusSelector(`[data-complete-for="${milestone.id}"]`);
      });
  };

  return (
    <section aria-label="Timeline" className="wsPlan">
      <div className="wsTimelineToolbar">
        {planner
          ? <div className="wsTimelineActions">
              {waterfall && <button className="sparkPrimary" data-edit-phases onClick={() => setDialog({ kind: "phases" })} type="button">Edit phases</button>}
              <button className={waterfall ? "sparkSecondary" : "sparkPrimary"} data-add-milestone onClick={() => setDialog({ kind: "milestone", milestone: null })} type="button">Add milestone</button>
              {waterfall && <button className="sparkSecondary" data-rebaseline onClick={() => setDialog({ kind: "baseline" })} type="button">Re-baseline</button>}
            </div>
          : <p className="wsBacklogReadOnly" role="note">
              <svg aria-hidden="true" viewBox="0 0 24 24"><rect height="9" rx="2" width="14" x="5" y="11" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
              {PLAN_AUTHORITY_MESSAGE}
            </p>}
        {/* Off Waterfall every task is unphased, so the count only means something on a Waterfall project. */}
        {waterfall && (
          counts === null
            ? <span className="wsTimelineUnphased" data-empty>Unphased <strong aria-hidden="true">—</strong><span className="wsSrOnly">count not loaded</span></span>
            : counts.unphased > 0
              ? <Link
                  aria-label={`Unphased ${counts.unphased} ${counts.unphased === 1 ? "task" : "tasks"} — show them on the board`}
                  className="wsTimelineUnphased"
                  href={`${boardUrl}?phase=none`}
                >
                  Unphased <strong>{counts.unphased}</strong>
                </Link>
              : <span className="wsTimelineUnphased" data-empty>Unphased <strong>0</strong></span>
        )}
      </div>
      {!waterfall && (
        <p className="wsBacklogReadOnly" role="note">
          <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
          {HISTORY_NOTE}
        </p>
      )}
      {boardFailed && (
        <p className="wsBoardBanner wsTimelineNote" role="alert">
          <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path d="M12 7v6M12 16.5v.5" /></svg>
          <span>Progress couldn&apos;t load. {loadedBoard.error}</span>
          <button className="wsGhostButton" onClick={loadedBoard.reload} type="button">Try again</button>
        </p>
      )}
      {board?.truncated && (
        <p className="wsBoardBanner" role="note">
          <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 7.5v.5" /></svg>
          Progress counts the first 500 tasks.
        </p>
      )}

      <section aria-labelledby="plan-gantt-title" className="wsCard wsProjectTimeline">
        <header className="wsCardHeader">
          <div>
            <h2 id="plan-gantt-title">Phases and milestones</h2>
            <p>
              {project.startDate && project.targetDate && `${formatDay(project.startDate)} – ${formatDay(project.targetDate)} · `}
              {plan.baselinedAt ? `Baseline from ${formatDay(plan.baselinedAt.slice(0, 10))}` : "No baseline yet"}
            </p>
          </div>
          <ul aria-label="Legend" className="wsTimelineLegend">
            <li><span aria-hidden="true" className="wsLegendBar" />Planned · done share filled</li>
            <li><span aria-hidden="true" className="wsLegendBaseline" />Baseline</li>
            <li><span aria-hidden="true" className="wsLegendMilestone" />Milestone</li>
            <li><span aria-hidden="true" className="wsLegendMilestone" data-overdue />Overdue</li>
          </ul>
        </header>
        <PhaseTimeline milestones={plan.milestones} phases={plan.phases} detailed progress={counts?.byPhase ?? null} startDate={project.startDate} targetDate={project.targetDate} today={today} />
      </section>

      <section aria-labelledby="plan-table-title" className="wsCard">
        <header className="wsCardHeader">
          <div>
            <h2 id="plan-table-title">Plan details</h2>
            <p>The same plan as a table: dates, baseline, variance and progress.</p>
          </div>
        </header>
        <div className="wsTimelineTableWrap">
          <table className="wsTimelineTable">
            <caption className="wsSrOnly">Phases</caption>
            <thead>
              <tr><th scope="col">Phase</th><th scope="col">Planned</th><th scope="col">Baseline</th><th scope="col">Variance</th><th scope="col">Progress</th></tr>
            </thead>
            <tbody>
              {plan.phases.map((phase) => {
                const variance = phaseVariance(phase);
                const progress = counts?.byPhase.get(phase.id);
                return (
                  <tr key={phase.id}>
                    <th scope="row">{phase.name}</th>
                    <td>{formatShortDay(phase.plannedStart)} – {formatShortDay(phase.plannedEnd)}</td>
                    <td>{phase.baselineStart && phase.baselineEnd ? `${formatShortDay(phase.baselineStart)} – ${formatShortDay(phase.baselineEnd)}` : "No baseline"}</td>
                    <td>
                      <span className="wsTimelineVariance" data-tone={varianceTone(variance)}>
                        <span aria-hidden="true">{varianceLabel(variance)}</span>
                        <span className="wsSrOnly">{varianceDescription(variance)}</span>
                      </span>
                    </td>
                    <td>{progress ? progressLabel(progress) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <h3 className="wsMilestonesTitle">Milestones</h3>
        {plan.milestones.length === 0
          ? <p className="wsProjectMuted">{planner ? "No milestones yet. Add one to mark a sign-off or a delivery." : "No milestones yet."}</p>
          : <div className="wsTimelineTableWrap">
              <table className="wsTimelineTable">
                <caption className="wsSrOnly">Milestones</caption>
                <thead>
                  <tr>
                    <th scope="col">Milestone</th><th scope="col">Phase</th><th scope="col">Due</th><th scope="col">Baseline</th><th scope="col">Status</th>
                    {planner && <th scope="col"><span className="wsSrOnly">Actions</span></th>}
                  </tr>
                </thead>
                <tbody>
                  {plan.milestones.map((milestone) => {
                    const done = Boolean(milestone.completedAt);
                    const overdue = !done && milestone.dueDate < today;
                    const outside = Boolean((startDate && milestone.dueDate < startDate) || (targetDate && milestone.dueDate > targetDate));
                    return (
                      <tr data-milestone-id={milestone.id} key={milestone.id}>
                        <th scope="row">{milestone.name}</th>
                        <td>{milestone.phaseId ? phaseName.get(milestone.phaseId) ?? "Earlier phase" : "—"}</td>
                        <td>
                          {formatDay(milestone.dueDate)}
                          {outside && <small className="wsTimelineOutside">Outside the project dates</small>}
                        </td>
                        <td>{milestone.baselineDueDate ? formatDay(milestone.baselineDueDate) : "No baseline"}</td>
                        <td><span className="wsTimelineState" data-state={done ? "done" : overdue ? "overdue" : "upcoming"}>{done ? "Done" : overdue ? "Overdue" : "Upcoming"}</span></td>
                        {planner && (
                          <td className="wsTimelineRowActions">
                            <button aria-label={`Edit ${milestone.name}`} className="wsGhostButton" data-edit-for={milestone.id} onClick={() => setDialog({ kind: "milestone", milestone })} type="button">Edit</button>
                            <button
                              aria-label={done ? `Reopen ${milestone.name}` : `Mark ${milestone.name} complete`}
                              className="wsGhostButton"
                              data-complete-for={milestone.id}
                              disabled={Boolean(busy[milestone.id])}
                              onClick={() => toggleCompleted(milestone)}
                              type="button"
                            >
                              {done ? "Reopen" : "Complete"}
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>}
      </section>

      {waterfall && dialog?.kind === "phases" && (
        <PhasePlanDialog
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            setDialog(null);
            showPlan(saved);
            reloadProject();
            notify("Phases saved.");
          }}
          onStale={(current) => {
            showPlan(current);
            reloadProject();
          }}
          plan={plan}
          projectId={project.id}
          startDate={startDate}
          targetDate={targetDate}
        />
      )}
      {dialog?.kind === "milestone" && (
        <MilestoneDialog
          milestone={dialog.milestone}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            const added = dialog.milestone === null;
            setDialog(null);
            changePlan((current) => withMilestone(current, saved));
            reloadProject();
            notify(added ? `${saved.name} added.` : `${saved.name} saved.`);
          }}
          onStale={(current) => changePlan((latest) => withMilestone(latest, current))}
          phases={plan.phases}
          projectId={project.id}
          startDate={startDate}
          targetDate={targetDate}
        />
      )}
      {waterfall && dialog?.kind === "baseline" && (
        <RebaselineDialog
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            setDialog(null);
            showPlan(saved);
            reloadProject();
            notify("New baseline saved.");
          }}
          onStale={(current) => {
            showPlan(current);
            reloadProject();
          }}
          plan={plan}
          projectId={project.id}
        />
      )}
    </section>
  );
}
