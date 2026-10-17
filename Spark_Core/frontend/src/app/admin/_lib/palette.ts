/**
 * Chart colors. Validated with the dataviz palette checker against the white chart surface
 * (lightness band, chroma floor, color-blind separation and normal-vision floor all pass in this order).
 * Aqua, yellow and magenta sit below 3:1 contrast, so every chart ships a legend and a table view.
 *
 * Each metric keeps its color on every page, so "posts" is always aqua.
 * Status colors (green/amber/red badges) are separate and never used for series.
 */
export const VIZ = {
  blue: "#2563eb",
  orange: "#eb6834",
  aqua: "#1baf7a",
  yellow: "#eda100",
  violet: "#6250d6",
  magenta: "#e87ba4",
} as const;

export interface SeriesStyle {
  label: string;
  color: string;
}

export const SERIES = {
  activeUsers: { label: "Active users", color: VIZ.blue },
  signIns: { label: "Sign-ins", color: VIZ.blue },
  signups: { label: "Sign-ups", color: VIZ.orange },
  posts: { label: "Posts", color: VIZ.aqua },
  comments: { label: "Comments", color: VIZ.yellow },
  reportsOpened: { label: "Reports opened", color: VIZ.violet },
  reportsClosed: { label: "Reports closed", color: VIZ.magenta },
  newMembers: { label: "New members", color: VIZ.orange },
  mrr: { label: "MRR", color: VIZ.blue },
  newPaid: { label: "New paid", color: VIZ.aqua },
  churned: { label: "Cancelled", color: VIZ.magenta },
} satisfies Record<string, SeriesStyle>;

/** Plan mix and other part-to-whole charts take categorical slots in this fixed order. */
export const CATEGORICAL = [VIZ.blue, VIZ.orange, VIZ.aqua, VIZ.yellow, VIZ.violet, VIZ.magenta] as const;

/** One hue, light to dark, for magnitude (heatmap, retention). */
export const SEQUENTIAL = ["#eff6ff", "#dbeafe", "#bfdbfe", "#93c5fd", "#60a5fa", "#3b82f6", "#2563eb", "#1d4ed8", "#1e3a8a"] as const;

/** Picks a sequential step for a value in [0, 1]. Zero gets the lightest step. */
export function sequential(ratio: number): { background: string; dark: boolean } {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const index = clamped === 0 ? 0 : Math.min(SEQUENTIAL.length - 1, 1 + Math.floor(clamped * (SEQUENTIAL.length - 1)));
  return { background: SEQUENTIAL[index]!, dark: index >= 5 };
}

export const CHART_INK = { grid: "#edf1f6", axis: "#64748b", cursor: "#cbd5e1", surface: "#ffffff" } as const;
