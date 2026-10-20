"use client";

import { RANGES, type RangeDays } from "../_components/ui";
import { useQueryState } from "./use-query-state";

/**
 * The page's date range (7, 30, 90 or 180 days), kept in the address as ?range= so views can be shared.
 * `allowed` narrows the ranges for pages whose reads accept fewer; any other value falls back.
 */
export function useRange(fallback: RangeDays = 30, allowed: readonly RangeDays[] = RANGES): [RangeDays, (value: RangeDays) => void] {
  const [raw, setRaw] = useQueryState<string>("range", String(fallback), allowed.map(String));
  return [Number(raw) as RangeDays, (value) => setRaw(String(value))];
}
