const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Collapses whitespace, including CR/LF, so values are safe in a subject line and in prose. */
export function plain(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** "2026-10-26" becomes "Oct 26"; anything else is returned as plain text. */
export function shortDay(value: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})/u.exec(value);
  const month = match ? MONTHS[Number(match[1]) - 1] : undefined;
  return match && month ? `${month} ${Number(match[2])}` : plain(value);
}
