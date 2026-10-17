"use client";

import { RANGES, type RangeDays } from "../_components/ui";
import { useQueryState } from "./use-query-state";

const VALUES = RANGES.map(String);

/** The page's date range (7, 30, 90 or 180 days), kept in the address as ?range= so views can be shared. */
export function useRange(fallback: RangeDays = 30): [RangeDays, (value: RangeDays) => void] {
  const [raw, setRaw] = useQueryState<string>("range", String(fallback), VALUES);
  return [Number(raw) as RangeDays, (value) => setRaw(String(value))];
}
