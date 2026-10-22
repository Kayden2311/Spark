"use client";

import type { EngagementResponse } from "../_lib/types";
import { ChartCard, Heatmap } from "./charts";
import type { Read } from "./overview-tiles";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "When members are active": the `/admin/analytics/engagement` weekday × hour heatmap with its table view. */
export function EngagementHeatmapCard({ engagement, subtitle }: { engagement: Read<EngagementResponse>; subtitle: string }) {
  const cells = engagement.data?.cells ?? [];
  return (
    <ChartCard
      empty={engagement.data !== null && cells.every((cell) => cell.events === 0)}
      emptyText="No sign-ins, posts or comments in this period yet."
      error={engagement.error}
      height={240}
      loading={engagement.loading && !engagement.data}
      onRetry={engagement.reload}
      subtitle={subtitle}
      table={{
        columns: ["Day", ...Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}h`)],
        rows: DAYS.map((day, index) => [day, ...Array.from({ length: 24 }, (_, hour) => cells.find((cell) => cell.dow === index + 1 && cell.hour === hour)?.events ?? 0)]),
      }}
      title="When members are active"
    >
      <Heatmap cells={cells} />
    </ChartCard>
  );
}
