/**
 * Directory filters live in the URL (`?q=&topic=&country=&stage=`), so a filtered view survives a reload
 * and can be shared. Values the API would reject are dropped here instead of turning into a 400.
 */

export const TOPIC_SLUGS = ["b2b-saas", "climate-tech", "ai-data", "product", "fintech", "founders"] as const;
export const STAGE_CODES = ["idea", "pre_seed", "seed", "series_a", "growth", "any"] as const;
export const MAX_SEARCH_LENGTH = 100;

/** An empty string means "any". */
export interface CommunityFilters {
  q: string;
  topic: string;
  country: string;
  stage: string;
}

export const emptyFilters: CommunityFilters = { q: "", topic: "", country: "", stage: "" };

const FILTER_KEYS = ["q", "topic", "country", "stage"] as const;

interface ParamReader {
  get(name: string): string | null;
}

function oneOf(value: string | null, allowed: readonly string[]): string {
  return value !== null && allowed.includes(value) ? value : "";
}

export function filtersFromParams(params: ParamReader): CommunityFilters {
  const country = (params.get("country") ?? "").toUpperCase();
  return {
    q: (params.get("q") ?? "").slice(0, MAX_SEARCH_LENGTH),
    topic: oneOf(params.get("topic"), TOPIC_SLUGS),
    country: /^[A-Z]{2}$/.test(country) ? country : "",
    stage: oneOf(params.get("stage"), STAGE_CODES),
  };
}

/** The query string (without "?") for these filters; empty filters are left out. */
export function filtersToSearch(filters: CommunityFilters): string {
  const search = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = key === "q" ? filters.q.trim() : filters[key];
    if (value) search.set(key, value);
  }
  return search.toString();
}

export function hasActiveFilters(filters: CommunityFilters): boolean {
  return filtersToSearch(filters) !== "";
}
