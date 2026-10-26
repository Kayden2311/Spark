"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, type CSSProperties } from "react";

import { initials } from "../../../components";
import { ChartCard, ContributionCalendar, VIZ, formatCount } from "../../../_ui/viz";
import { MembersCard } from "../../_components/insights/members-card";
import { GroupHeading, StatusPill, useInsight } from "../../_components/insights/shared";
import { canManage } from "../../_lib/api";
import { RANGE_OPTIONS, insightPaths, parseRange, percentText, unitLabel, type WorkspaceInsights } from "../../_lib/insights";
import { formatShortDay, methodologyAccent, methodologyName, methodologyOf } from "../../_lib/projects";
import { useWorkspace } from "../workspace-context";

/** Sets or removes one query parameter without a navigation (Next.js keeps useSearchParams in sync). */
function replaceParam(name: string, value: string | null) {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
}

type Project = WorkspaceInsights["projects"][number];

function ProjectCard({ project, slug }: { project: Project; slug: string }) {
  const done = Math.min(100, Math.max(0, project.donePercent));
  const plan = project.planPercent === null ? null : Math.min(100, Math.max(0, project.planPercent));
  return (
    <li>
      <Link
        className="wsInsightsProject"
        href={`/w/${slug}/p/${encodeURIComponent(project.key)}/insights`}
        style={{ "--method-accent": methodologyAccent(project.methodology) } as CSSProperties}
      >
        <span className="wsInsightsProjectHead">
          <span className="wsKeyTag">{project.key}</span>
          <span className="wsMethodPill" data-methodology={methodologyOf(project.methodology)}>{methodologyName(project.methodology)}</span>
        </span>
        <strong className="wsInsightsProjectName">{project.name}</strong>
        <span className="wsInsightsProjectStatus">
          <StatusPill status={project.status} />
          <span className="wsInsightsMuted">{percentText(project.donePercent)} of {unitLabel(project.unit)} done{plan !== null ? ` · plan ${percentText(plan)}` : ""}</span>
        </span>
        <span aria-label={`${project.name} done`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={Math.round(done)} aria-valuetext={`${percentText(project.donePercent)} done`} className="wsInsightsPlanTrack" role="meter">
          <span className="wsInsightsPlanFill" style={{ "--insights-w": `${done}%`, background: "var(--method-accent)" } as CSSProperties} />
          {plan !== null && <span aria-hidden="true" className="wsInsightsPlanTick" style={{ "--insights-x": `${plan}%`, background: VIZ.orange } as CSSProperties} />}
        </span>
        <span className="wsInsightsProjectCounts">
          <span>{formatCount(project.open)} open</span>
          <span data-alert={project.overdue > 0 || undefined}>{formatCount(project.overdue)} overdue</span>
        </span>
      </Link>
    </li>
  );
}

/** Progress, member throughput, activity and overdue work across the workspace projects. Read-only; every member sees it all. */
export default function WorkspaceInsightsPage() {
  const { workspace } = useWorkspace();
  const searchParams = useSearchParams();
  const [days, setDays] = useState(() => parseRange(searchParams.get("days")));
  const insights = useInsight<WorkspaceInsights>(insightPaths.workspace(workspace.id, days));
  const data = insights.data;
  const base = `/w/${workspace.slug}`;
  const manager = canManage(workspace.role);

  const chooseRange = (value: number) => {
    setDays(value);
    replaceParam("days", value === 30 ? null : String(value));
  };

  const members = { ...insights, data: data ? { items: data.members } : null };
  const noProjects = data !== null && data.projects.length === 0;
  const overdue = data?.overdue ?? [];

  return (
    <div className="wsInsights">
      <section aria-label="Insights controls" className="wsInsightsBar">
        <div className="wsInsightsBarTitle">
          <h1>Insights</h1>
          <p>Progress, people and deadlines across {workspace.name}. Day buckets are UTC.</p>
        </div>
        <div className="wsInsightsControls">
          <div aria-label="Range" className="wsInsightsSegment" role="group">
            {RANGE_OPTIONS.map((option) => (
              <button aria-pressed={days === option} key={option} onClick={() => chooseRange(option)} type="button">
                <span aria-hidden="true">{option}d</span>
                <span className="wsSrOnly">{option} days</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {noProjects && (
        <section aria-labelledby="insights-empty" className="wsEmpty">
          <h2 id="insights-empty">No projects yet</h2>
          {manager ? (
            <>
              <p>Create a project and its progress, people and deadlines show up here.</p>
              <Link className="sparkPrimary" href={`${base}/projects/new`}>Create a project</Link>
            </>
          ) : (
            <p>Ask a workspace owner or admin to create one. Progress, people and deadlines show up here once there is a project.</p>
          )}
        </section>
      )}

      {!noProjects && (
        <>
          <section aria-label="Projects" className="wsInsightsGroup">
            {insights.loading && (
              <div aria-busy="true" className="wsInsightsProjects" role="status">
                <span className="wsSrOnly">Loading projects…</span>
                {Array.from({ length: 3 }, (_, index) => <span className="vizSkeleton wsInsightsKpiSkeleton" key={index} />)}
              </div>
            )}
            {insights.error && (
              <div className="vizError" role="alert">
                <span>{insights.error}</span>
                <button className="vizBtn vizBtnSecondary vizBtnSm" onClick={insights.reload} type="button">Retry</button>
              </div>
            )}
            {data && (
              <ul className="wsInsightsProjects">
                {data.projects.map((project) => <ProjectCard key={project.id} project={project} slug={workspace.slug} />)}
              </ul>
            )}
          </section>

          <div className="wsInsightsGrid">
            <MembersCard members={members} />
            <ChartCard className="wsInsightsWide" error={insights.error} height={140} loading={insights.loading} onRetry={insights.reload} subtitle={`Issue events per day, last ${days} days`} title="Activity">
              {data && <ContributionCalendar data={data.calendar} unit="events" />}
            </ChartCard>
          </div>

          <section aria-labelledby="insights-overdue" className="wsInsightsGroup">
            <GroupHeading id="insights-overdue" title="Overdue across projects" />
            <ChartCard empty={data !== null && overdue.length === 0} error={insights.error} loading={insights.loading} onRetry={insights.reload} emptyText="Nothing is overdue." height={120} subtitle="Open work past its due date, oldest first" title="Overdue work">
              <ul aria-label="Overdue work" className="wsInsightsList">
                {overdue.map((item) => (
                  <li key={item.issueId}>
                    <Link className="wsInsightsListLink" href={`${base}/p/${encodeURIComponent(item.projectKey)}?issue=${encodeURIComponent(item.key)}`}>
                      <span className="wsKeyTag">{item.key}</span>
                      <span className="wsInsightsListTitle">{item.title}</span>
                    </Link>
                    <span className="wsInsightsListMeta">
                      <span className="wsInsightsDue">Due {formatShortDay(item.dueDate)}</span>
                      {item.assignee
                        ? <span aria-label={item.assignee.displayName} className="avatar tiny" role="img" title={item.assignee.displayName}>{initials(item.assignee.displayName, "?")}</span>
                        : <span className="wsInsightsMuted">Unassigned</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </ChartCard>
          </section>
        </>
      )}
    </div>
  );
}
