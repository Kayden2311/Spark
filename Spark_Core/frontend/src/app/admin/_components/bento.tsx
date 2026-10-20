"use client";

import type { CSSProperties, ReactNode } from "react";

import { useReducedMotion } from "../../_ui/viz/motion";

/** A 12-column dashboard grid. Tiles that render nothing collapse, and dense packing closes the gaps. */
export function Bento({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section aria-label={label} className="admBento">
      {children}
    </section>
  );
}

/**
 * One bento cell, usually wrapping a ChartCard. `span` is out of 12 columns on desktop; on tablets a tile
 * takes half the row (or the full row when it spans more than half on desktop) and on phones the full row.
 * `spanMd` overrides the tablet width (out of 12), for rows whose desktop split would leave a half row empty.
 * A tile with no content renders nothing; one whose child renders nothing is hidden by `.admTile:empty`.
 * `lift={false}` is for a tile whose own items lift on hover (so the tile does not lift with them).
 */
export function Tile({ span = 4, spanMd, rowSpan = 1, lift = true, children }: { span?: number; spanMd?: number; rowSpan?: number; lift?: boolean; children?: ReactNode }) {
  const reduced = useReducedMotion();
  if (children === null || children === undefined || children === false) return null;
  const style = { "--tile-span": span, "--tile-rows": rowSpan, "--tile-span-md": spanMd ?? (span > 6 ? 12 : 6) } as CSSProperties;
  return (
    <div className={`admTile${reduced || !lift ? "" : " admLift"}`} style={style}>
      {children}
    </div>
  );
}
