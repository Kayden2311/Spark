/** Workspace address rules, matching the API: 3–40 characters, lowercase letters, digits and inner hyphens. */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/u;
export const SLUG_MAX = 40;

/** Suggests an address from a workspace name: "Northstar Labs!" becomes "northstar-labs". */
export function deriveSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+/u, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/u, "");
}

/** Cleans what the person types in the address field without fighting them mid-word (hyphens stay). */
export function cleanSlugInput(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/gu, "-").slice(0, SLUG_MAX);
}

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}
