/** Frontend copy of backend src/modules/work/domain/phases.ts — keep the algorithm and its test vectors identical. */

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function parseDay(value: string): number {
  const ms = ISO_DATE.test(value) ? Date.parse(`${value}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(ms)) throw new RangeError("Invalid project dates");
  return ms;
}

function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Spreads inclusive days startDate..targetDate over the named phases: with D days and n phases, phase i covers
 * day offsets floor(i*D/n) .. floor((i+1)*D/n) - 1. Computed in UTC; throws when the range is reversed or shorter than n.
 */
export function spreadPhases(startDate: string, targetDate: string, names: string[]): Array<{ name: string; plannedStart: string; plannedEnd: string }> {
  const start = parseDay(startDate);
  const target = parseDay(targetDate);
  const days = Math.round((target - start) / DAY_MS) + 1;
  const count = names.length;
  if (target < start || count < 1 || days < count) throw new RangeError("Invalid project dates");
  return names.map((name, index) => ({
    name,
    plannedStart: formatDay(start + Math.floor((index * days) / count) * DAY_MS),
    plannedEnd: formatDay(start + (Math.floor(((index + 1) * days) / count) - 1) * DAY_MS),
  }));
}

// ---------- The M2 phase editor rules (project creation and the Timeline's phase plan dialog) ----------

export const PHASE_NAME_MAX = 60;
export const PHASES_MAX = 12;
export const PHASES_RULE = "Each phase needs a name and dates inside the project dates, in order and without overlapping.";

/** A phase row being edited: dates are ISO days, or "" while unset. */
export interface PhaseDraft {
  name: string;
  plannedStart: string;
  plannedEnd: string;
}

/** The ISO day after `day`, computed in UTC ("" for a malformed day). */
function nextDay(day: string): string {
  const ms = ISO_DATE.test(day) ? Date.parse(`${day}T00:00:00Z`) : Number.NaN;
  return Number.isNaN(ms) ? "" : formatDay(ms + DAY_MS);
}

/** A row added after hand-edited dates runs from the day after the previous phase to the target date, when that fits. */
export function appendedDates(rows: readonly PhaseDraft[], startDate: string, targetDate: string): Pick<PhaseDraft, "plannedStart" | "plannedEnd"> {
  const previousEnd = rows.at(-1)?.plannedEnd ?? "";
  const plannedStart = previousEnd ? nextDay(previousEnd) : startDate;
  if (!plannedStart || !targetDate || plannedStart > targetDate) return { plannedStart: "", plannedEnd: "" };
  return { plannedStart, plannedEnd: targetDate };
}

/** The API's phase rules: 1–12 named phases (≤ 60 characters), inside the project dates, in order and not overlapping. */
export function phasesValid(rows: readonly PhaseDraft[], startDate: string, targetDate: string): boolean {
  if (rows.length < 1 || rows.length > PHASES_MAX) return false;
  let previousEnd = "";
  for (const row of rows) {
    const name = row.name.trim();
    if (!name || name.length > PHASE_NAME_MAX || !row.plannedStart || !row.plannedEnd) return false;
    if (row.plannedStart > row.plannedEnd || row.plannedStart < startDate || row.plannedEnd > targetDate) return false;
    if (previousEnd && row.plannedStart <= previousEnd) return false;
    previousEnd = row.plannedEnd;
  }
  return true;
}

/** Re-spreads rows evenly over the project dates (names kept); dates are cleared when the range can't hold them. */
export function respreadPhases<T extends PhaseDraft>(rows: readonly T[], startDate: string, targetDate: string): T[] {
  const cleared = () => rows.map((row) => ({ ...row, plannedStart: "", plannedEnd: "" }));
  if (!startDate || !targetDate || rows.length === 0) return cleared();
  try {
    const spread = spreadPhases(startDate, targetDate, rows.map((row) => row.name));
    return rows.map((row, index) => ({ ...row, plannedStart: spread[index].plannedStart, plannedEnd: spread[index].plannedEnd }));
  } catch {
    return cleared();
  }
}
