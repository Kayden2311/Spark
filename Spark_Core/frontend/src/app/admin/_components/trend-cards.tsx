"use client";

import Link from "next/link";

import { useReducedMotion } from "../../_ui/viz/motion";
import { describeChange } from "../_lib/format";
import { Sparkline } from "./sparkline";

export interface TrendCardItem {
  label: string;
  /** Already formatted. `undefined` while loading: the card shows a skeleton. */
  value: string | undefined;
  /** Colour of the dot before the label (the metric's series colour). */
  dot: string;
  /** Against the previous period. No chip when there is no previous period. */
  change?: { current: number; previous: number | null; higherIsBetter?: boolean };
  /** Drawn only with two or more points; metrics without reliable history pass none. */
  series?: number[];
  /** Sparkline colour. */
  color: string;
  /** Makes the whole card a link. */
  href?: string;
  valueTone?: "default" | "bad";
}

const ARROWS = { up: "↑", down: "↓" } as const;

type ChipTone = "good" | "bad" | "flat";

function chipOf(change: TrendCardItem["change"]): { text: string; label: string; tone: ChipTone } | null {
  if (!change) return null;
  const described = describeChange(change.current, change.previous);
  if (described.direction === "none") return null;
  if (described.direction === "flat") return { text: described.text, label: described.text, tone: "flat" };
  const good = (described.direction === "up") === (change.higherIsBetter ?? true);
  return { text: `${ARROWS[described.direction]} ${described.text}`, label: `${described.text} vs previous period`, tone: good ? "good" : "bad" };
}

/**
 * The compact key-number row at the top of a dashboard: label with a colour dot, the value, a change chip
 * whose colour follows whether the change is good for this metric (stated in words too), and a sparkline.
 * Screen readers get one sentence per card instead of the visual pieces.
 */
export function TrendCards({ items, label }: { items: TrendCardItem[]; label: string }) {
  const reduced = useReducedMotion();
  return (
    <ul aria-label={label} className="admTrendCards">
      {items.map((item) => {
        const loading = item.value === undefined;
        const chip = loading ? null : chipOf(item.change);
        const sentence = loading ? `${item.label}: loading` : `${item.label}: ${item.value}${chip ? `, ${chip.label}` : ""}`;
        const showSpark = !loading && (item.series?.length ?? 0) >= 2;
        const className = `admTrendCard${item.href ? " admTrendCardLink" : ""}${reduced ? "" : " admLift"}`;
        const body = (
          <>
            <span className="admSrOnly">{sentence}</span>
            <div aria-hidden="true" className="admTrendCardText">
              <span className="admTrendCardLabel">
                <span className="admTrendCardDot" style={{ background: item.dot }} />
                {item.label}
              </span>
              {loading ? (
                <span className="admSkeleton admTrendCardSkeleton" />
              ) : (
                <span className={`admTrendCardValue${item.valueTone === "bad" ? " admTrendCardValue-bad" : ""}`}>{item.value}</span>
              )}
              {chip && <span className="admTrendChip" data-tone={chip.tone}>{chip.text}</span>}
            </div>
            {showSpark && (
              <span className="admTrendCardSpark">
                <Sparkline color={item.color} height={40} values={item.series!} />
              </span>
            )}
          </>
        );
        return (
          <li key={item.label}>
            {item.href ? <Link className={className} href={item.href}>{body}</Link> : <div className={className}>{body}</div>}
          </li>
        );
      })}
    </ul>
  );
}
