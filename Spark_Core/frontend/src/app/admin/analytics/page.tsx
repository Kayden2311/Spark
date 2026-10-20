"use client";

import { Suspense } from "react";

import { useAdmin } from "../_components/admin-context";
import { NoAccess, PageHeader, Segmented, SkeletonRows } from "../_components/ui";
import { canAccess } from "../_lib/access";
import { useQueryState } from "../_lib/use-query-state";
import { EngagementPanel } from "./engagement";
import { SystemHealthPanel } from "./system-health";

type View = "health" | "engagement";

function Analytics() {
  const { roles } = useAdmin();
  const allowed = canAccess(roles, "analytics");
  const [view, setView] = useQueryState<View>("view", "health", ["health", "engagement"]);
  if (!allowed) return <NoAccess />;
  return (
    <>
      <PageHeader
        actions={<Segmented label="Analytics view" onChange={setView} options={[{ value: "health", label: "System health" }, { value: "engagement", label: "Engagement" }]} value={view} />}
        description={view === "health"
          ? "Is Spark up and fast? Live checks for the API, database and Redis, with traffic, errors and response times."
          : "Who is active, when they show up, whether they come back, and which communities drive it."}
        title="Analytics"
      />
      {view === "health" ? <SystemHealthPanel /> : <EngagementPanel />}
    </>
  );
}

export default function AnalyticsPage() {
  return (
    <Suspense fallback={<SkeletonRows />}>
      <Analytics />
    </Suspense>
  );
}
