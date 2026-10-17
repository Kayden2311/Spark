const compactNumber = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

// A fixed time zone keeps server and client renders identical.
const eventDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "Asia/Ho_Chi_Minh" });

export function formatCount(value: number): string {
  return compactNumber.format(value);
}

export function formatEventDate(iso: string | null): string {
  if (!iso) return "TBA";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "TBA" : eventDate.format(date);
}
