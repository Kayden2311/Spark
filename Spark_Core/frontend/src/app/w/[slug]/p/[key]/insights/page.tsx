"use client";

import { useSearchParams } from "next/navigation";
import { useState, type CSSProperties } from "react";

import { RANGE_OPTIONS, insightPaths, parseRange, selectedPeriod, type FlowInsights, type InsightSummary, type MemberInsights } from "../../../../_lib/insights";
import { periodLabel, planPath, type ProjectPlan } from "../../../../_lib/planning";
import { methodologyAccent, methodologyOf } from "../../../../_lib/projects";
import { useWorkspace } from "../../../workspace-context";
import { useProject } from "../project-context";
import { FlowCards, MembersCard } from "./flow-cards";
import { KanbanSection } from "./kanban-section";
import { ScrumSection } from "./scrum-section";
import { GroupHeading, useInsight } from "./shared";
import { KpiStrip, OverdueCard, PlanVsDone } from "./summary-cards";
import { WaterfallSection } from "./waterfall-section";

/** Sets or removes one query parameter without a navigation (Next.js keeps useSearchParams in sync). */
function replaceParam(name: string, value: string | null) {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
}

/**
 * Project insights (read-only). The KPI strip, plan vs done, flow, members and overdue work always show and
 * span the project's whole history; the methodology section follows the selected period (default: the
 * current one). Each card loads on its own, so one failing request only affects its card.
 */
export default function ProjectInsightsPage() {
  const { project } = useProject();
  const { workspace } = useWorkspace();
  const searchParams = useSearchParams();
  const [days, setDays] = useState(() => parseRange(searchParams.get("days")));
  const [requestedPeriod, setRequestedPeriod] = useState<string | null>(() => searchParams.get("period"));

  const plan = useInsight<ProjectPlan>(planPath(project.id));
  const summary = useInsight<InsightSummary>(insightPaths.summary(project.id));
  const flow = useInsight<FlowInsights>(insightPaths.flow(project.id, days));
  const members = useInsight<MemberInsights>(insightPaths.members(project.id, days));

  const periods = plan.data?.periods ?? [];
  const period = selectedPeriod(periods, requestedPeriod);
  // An unknown ?period= falls back to the current period; the API is then asked without one.
  const periodId = requestedPeriod && period?.id === requestedPeriod ? requestedPeriod : null;
  const methodology = methodologyOf(period?.methodology ?? project.methodology);
  // A linked ?period= waits for the period list, so the wrong section never flashes in.
  const methodReady = requestedPeriod === null || plan.data !== null || plan.error !== null;
  const boardHref = `/w/${workspace.slug}/p/${encodeURIComponent(project.key)}`;

  const chooseRange = (value: number) => {
    setDays(value);
    replaceParam("days", value === 30 ? null : String(value));
  };
  const choosePeriod = (id: string) => {
    const current = periods.find((item) => item.endedAt === null);
    const next = id === current?.id ? null : id;
    setRequestedPeriod(next);
    replaceParam("period", next);
  };

  return (
    <div className="wsInsights" key={project.id}>
      <section aria-label="Insights controls" className="wsInsightsBar">
        <div className="wsInsightsBarTitle">
          <h2>Insights</h2>
          <p>Progress, flow and delivery for {project.name}. Day buckets are UTC.</p>
        </div>
        <div className="wsInsightsControls">
          {periods.length > 1 && period && (
            <div className="wsInsightsPeriod" style={{ "--method-accent": methodologyAccent(period.methodology) } as CSSProperties}>
              <select aria-label="Period" className="wsSelect wsInsightsSelect" onChange={(event) => choosePeriod(event.target.value)} value={period.id}>
                {[...periods].reverse().map((item) => <option key={item.id} value={item.id}>{periodLabel(item)}</option>)}
              </select>
            </div>
          )}
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

      <KpiStrip summary={summary} />
      <div className="wsInsightsGrid">
        <PlanVsDone summary={summary} />
      </div>

      {methodReady && methodology === "scrum" && <ScrumSection key={`scrum-${periodId ?? "current"}`} periodId={periodId} projectId={project.id} />}
      {methodReady && methodology === "kanban" && <KanbanSection days={days} key="kanban" projectId={project.id} />}
      {methodReady && methodology === "waterfall" && <WaterfallSection key={`waterfall-${periodId ?? "current"}`} periodId={periodId} projectId={project.id} />}

      <section aria-labelledby="insights-flow" className="wsInsightsGroup">
        <GroupHeading id="insights-flow" note="Across the project's whole history, whatever the methodology." title="Flow" />
        <div className="wsInsightsGrid">
          <FlowCards days={days} flow={flow} />
        </div>
      </section>

      <section aria-labelledby="insights-people" className="wsInsightsGroup">
        <GroupHeading id="insights-people" title="People and deadlines" />
        <div className="wsInsightsGrid">
          <MembersCard members={members} />
          <OverdueCard boardHref={boardHref} summary={summary} />
        </div>
      </section>
    </div>
  );
}
