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
