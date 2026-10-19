import type { ComponentProps } from "react";

import { ChartCard as SharedChartCard } from "../../_ui/viz/charts";
import { ErrorBanner } from "./ui";

export * from "../../_ui/viz/charts";

/** Admin chart card: the shared card with the console's icon error banner. */
export function ChartCard(props: ComponentProps<typeof SharedChartCard>) {
  return <SharedChartCard renderError={(message, onRetry) => <ErrorBanner message={message} onRetry={onRetry} />} {...props} />;
}
