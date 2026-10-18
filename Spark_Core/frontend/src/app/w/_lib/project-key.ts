/** Project keys: 2–10 capital letters or digits, starting with a letter (the API enforces the same pattern). */
export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/u;
export const PROJECT_KEY_MAX = 10;
const FALLBACK_KEY = "PRJ";

function words(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toUpperCase()
    .split(/\s+/u)
    .map((word) => word.replace(/[^A-Z0-9]/gu, ""))
    .filter((word) => word !== "");
}

export function isValidProjectKey(key: string): boolean {
  return PROJECT_KEY_PATTERN.test(key);
}

/** Initials of up to the first four words, or the first three characters of a single word; "PRJ" when that is not a valid key. */
export function deriveProjectKey(name: string): string {
  const parts = words(name);
  const key = parts.length >= 2 ? parts.slice(0, 4).map((word) => word[0]).join("") : (parts[0] ?? "").slice(0, 3);
  return isValidProjectKey(key) ? key : FALLBACK_KEY;
}

/** What the key field keeps while someone types: uppercase letters and digits, at most 10. */
export function cleanKeyInput(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/gu, "").slice(0, PROJECT_KEY_MAX);
}
