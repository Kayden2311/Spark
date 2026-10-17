"use client";

import { useId } from "react";

export type SparkLogoTone = "light" | "dark";

const COLORS: Record<SparkLogoTone, { ring: [string, string]; top: [string, string]; ridge: string; sliver: string; bottom: [string, string] }> = {
  // For light backgrounds (pages, cards).
  light: { ring: ["#93c5fd", "#2563eb"], top: ["#7cb3ff", "#3b82f6"], ridge: "#2563eb", sliver: "#60a5fa", bottom: ["#2563eb", "#1e3a8a"] },
  // For navy backgrounds (footer, sidebars).
  dark: { ring: ["#bfdbfe", "#3b82f6"], top: ["#dbeafe", "#93c5fd"], ridge: "#60a5fa", sliver: "#bfdbfe", bottom: ["#60a5fa", "#2563eb"] },
};

/**
 * The Spark mark ("Halo"): a faceted lightning bolt breaking out of a glowing ring, an idea taking off.
 * Decorative by default; pass `title` when the mark stands alone as the only label.
 * Keeps the `sparkMark` class so existing sizing and the landing reveal animation still apply.
 */
export function SparkLogo({ tone = "light", className = "sparkMark", title }: { tone?: SparkLogoTone; className?: string; title?: string }) {
  const id = useId().replace(/:/gu, "");
  const c = COLORS[tone];
  const a11y = title ? { role: "img", "aria-label": title } : { "aria-hidden": true as const };
  return (
    <svg className={className} viewBox="0 0 48 48" {...a11y}>
      <defs>
        <linearGradient gradientUnits="userSpaceOnUse" id={`${id}r`} x1="6" x2="42" y1="6" y2="42">
          <stop offset="0" stopColor={c.ring[0]} />
          <stop offset="1" stopColor={c.ring[1]} />
        </linearGradient>
        <linearGradient gradientUnits="userSpaceOnUse" id={`${id}t`} x1="12" x2="26" y1="4" y2="27">
          <stop offset="0" stopColor={c.top[0]} />
          <stop offset="1" stopColor={c.top[1]} />
        </linearGradient>
        <linearGradient gradientUnits="userSpaceOnUse" id={`${id}b`} x1="34" x2="20" y1="20" y2="44">
          <stop offset="0" stopColor={c.bottom[0]} />
          <stop offset="1" stopColor={c.bottom[1]} />
        </linearGradient>
      </defs>
      <circle cx="24" cy="24" fill="none" opacity=".9" r="16" stroke={`url(#${id}r)`} strokeWidth="2.6" />
      <g transform="translate(-1.2 -1.2) scale(1.05)">
        <path d="M28 4 11 27h11z" fill={`url(#${id}t)`} />
        <path d="M28 4 22 27l4-7z" fill={c.ridge} />
        <path d="M26 20h11l-15 7z" fill={c.sliver} />
        <path d="M37 20 19 44l3-17z" fill={`url(#${id}b)`} />
      </g>
    </svg>
  );
}
