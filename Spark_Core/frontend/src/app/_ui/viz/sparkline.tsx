"use client";

import { useId } from "react";

import { useReducedMotion } from "./motion";

/**
 * Tiny trend line for KPI and trend cards. Decorative: the card states the number and change in text.
 * The line draws in and its area fades in on mount, unless reduced motion is set.
 */
export function Sparkline({ values, color, height = 36 }: { values: number[]; color: string; height?: number }) {
  const gradient = useId().replace(/:/gu, "");
  const reduced = useReducedMotion();
  if (values.length < 2) return <svg aria-hidden="true" className="vizSpark" height={height} />;
  const width = 120;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const points = values.map((value, index) => [(index / (values.length - 1)) * width, height - 3 - ((value - min) / span) * (height - 6)] as const);
  const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return (
    <svg aria-hidden="true" className="vizSpark" height={height} preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
      <defs>
        <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.18} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path className={reduced ? undefined : "admFadeIn"} d={`${line} L${width} ${height} L0 ${height} Z`} fill={`url(#${gradient})`} />
      <path
        className={reduced ? undefined : "admDrawIn"}
        d={line}
        fill="none"
        pathLength={1}
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
