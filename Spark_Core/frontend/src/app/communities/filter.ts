import type { CommunitySummary } from "./types";

export const ALL_TOPICS = "All topics";
export const ALL_VALUES = "all";

export interface CommunityFilters {
  searchTerm: string;
  category: string;
  location: string;
  stage: string;
}

export const emptyFilters: CommunityFilters = {
  searchTerm: "",
  category: ALL_TOPICS,
  location: ALL_VALUES,
  stage: ALL_VALUES,
};

export function hasActiveFilters(filters: CommunityFilters): boolean {
  return (
    filters.searchTerm.trim() !== "" ||
    filters.category !== ALL_TOPICS ||
    filters.location !== ALL_VALUES ||
    filters.stage !== ALL_VALUES
  );
}

export function filterCommunities(items: CommunitySummary[], filters: CommunityFilters): CommunitySummary[] {
  const term = filters.searchTerm.trim().toLowerCase();
  return items.filter((item) => {
    if (filters.category !== ALL_TOPICS && item.category !== filters.category) return false;
    if (filters.location !== ALL_VALUES && item.location !== filters.location) return false;
    if (filters.stage !== ALL_VALUES && item.stage !== filters.stage) return false;
    if (!term) return true;
    return (
      item.name.toLowerCase().includes(term) ||
      item.tagline.toLowerCase().includes(term) ||
      item.category.toLowerCase().includes(term) ||
      item.tags.some((tag) => tag.toLowerCase().includes(term))
    );
  });
}
