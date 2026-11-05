"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth-context";
import { SignalParticles } from "../signal-particles";
import { CommunityCard, initialsOf, toneOf } from "./community-card";
import { emptyFilters, filtersFromParams, filtersToSearch, hasActiveFilters, MAX_SEARCH_LENGTH, TOPIC_SLUGS, type CommunityFilters } from "./filter";
import { countryName, formatCount } from "./format";
import { SiteFooter, SiteHeader } from "./site-chrome";
import type { CommunityCard as CommunityCardData, FilterOption } from "./types";
import { useCommunityDirectory, useFilterOptions, useMyCommunities } from "./_lib/use-communities";

const SEARCH_DELAY_MS = 300;

/** Topic names for the chips before the filter options load (same vocabulary as the API). */
const TOPIC_FALLBACK: FilterOption[] = [
  { value: "b2b-saas", label: "B2B SaaS", count: 0 },
  { value: "climate-tech", label: "Climate Tech", count: 0 },
  { value: "ai-data", label: "AI & Data", count: 0 },
  { value: "product", label: "Product", count: 0 },
  { value: "fintech", label: "FinTech", count: 0 },
  { value: "founders", label: "Founders Circle", count: 0 },
];

const ROLE_LABELS: Record<string, string> = { owner: "Owner", moderator: "Moderator", member: "Member", pending: "Requested" };

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

/** Keeps a value from the URL selectable even when the options do not list it (yet). */
function withCurrent(options: FilterOption[], value: string, label: (value: string) => string): FilterOption[] {
  return !value || options.some((option) => option.value === value) ? options : [...options, { value, label: label(value), count: 0 }];
}

function YourCommunities({ items }: { items: CommunityCardData[] }) {
  if (items.length === 0) return null;
  return (
    <section className="dirMine" aria-labelledby="your-communities-title">
      <h2 id="your-communities-title">Your communities</h2>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <Link className={`dirMineLink summaryTone-${toneOf(item)}`} href={`/communities/${encodeURIComponent(item.slug)}`}>
              <span aria-hidden="true" className="dirMineLogo">{initialsOf(item.name)}</span>
              <span className="dirMineName">{item.name}</span>
              {item.viewerStatus && <span className="dirMineRole">{ROLE_LABELS[item.viewerStatus] ?? "Member"}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Directory() {
  const { isAuthenticated } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const options = useFilterOptions();
  const directory = useCommunityDirectory(filters);
  const mine = useMyCommunities(isAuthenticated);

  // The search box is typed into locally and written to the URL after a pause.
  const [searchText, setSearchText] = useState(filters.q);
  const [syncedQ, setSyncedQ] = useState(filters.q);
  if (filters.q !== syncedQ) {
    // The URL changed from elsewhere (Clear filters, back button): show what it says.
    setSyncedQ(filters.q);
    if (filters.q !== searchText.trim()) setSearchText(filters.q);
  }
  const latestFilters = useRef(filters);
  const searchTimer = useRef<number | null>(null);
  useEffect(() => {
    latestFilters.current = filters;
  });
  useEffect(() => () => {
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
  }, []);

  const navigate = (next: CommunityFilters) => {
    const search = filtersToSearch(next);
    router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false });
  };
  const cancelSearch = () => {
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    searchTimer.current = null;
  };
  const setFilter = (change: Partial<CommunityFilters>) => {
    cancelSearch();
    navigate({ ...filters, q: searchText, ...change });
  };
  const onSearch = (value: string) => {
    setSearchText(value);
    cancelSearch();
    searchTimer.current = window.setTimeout(() => {
      searchTimer.current = null;
      navigate({ ...latestFilters.current, q: value });
    }, SEARCH_DELAY_MS);
  };
  const clearFilters = () => {
    cancelSearch();
    setSearchText("");
    navigate(emptyFilters);
  };

  const topics = withCurrent(options?.topics ?? TOPIC_FALLBACK, filters.topic, (value) => value);
  const countries = withCurrent(options?.countries ?? [], filters.country, (value) => value);
  const stages = withCurrent(options?.stages ?? [], filters.stage, (value) => value);
  const topicLabel = topics.find((topic) => topic.value === filters.topic)?.label;
  const hasFilters = hasActiveFilters(filters) || searchText.trim() !== "";

  const totals = options && {
    circles: options.stages.reduce((sum, stage) => sum + stage.count, 0),
    topics: options.topics.filter((topic) => topic.count > 0).length,
    countries: options.countries.length,
  };
  const mostActive = directory.items.reduce<CommunityCardData | null>((best, item) => (item.weeklyPosts > (best?.weeklyPosts ?? 0) ? item : best), null);
  const shown = directory.items.length;

  return (
    <main className="sparkLanding communityPageRoot">
      <SignalParticles />
      <SiteHeader />

      <section className="dirHero" aria-labelledby="directory-title">
        <div className="dirHeroPanel">
          <div className="dirHeroCopy">
            <p className="dirEyebrow">Community directory</p>
            <h1 id="directory-title">Find the right room for the work ahead.</h1>
            <p className="dirHeroLead">
              Curated founder circles and practitioner groups where conversations turn into shared plans.
            </p>
            <dl className="dirHeroStats">
              <div>
                <dt>Circles</dt>
                <dd>{totals ? formatCount(totals.circles) : "—"}</dd>
              </div>
              <div>
                <dt>Topics</dt>
                <dd>{totals ? totals.topics : "—"}</dd>
              </div>
              <div>
                <dt>Countries</dt>
                <dd>{totals ? totals.countries : "—"}</dd>
              </div>
            </dl>
          </div>

          <div className="dirHeroArt" aria-hidden="true">
            <div className="dirHeroPhoto dirHeroPhotoMain">
              <Image alt="" fill priority sizes="(max-width: 900px) 90vw, 28rem" src="/spark-community-discussion.png" />
            </div>
            <div className="dirHeroPhoto dirHeroPhotoTop">
              <Image alt="" fill sizes="12rem" src="/spark-builder-circle.png" />
            </div>
            <div className="dirHeroPhoto dirHeroPhotoBottom">
              <Image alt="" fill sizes="13rem" src="/spark-founder-circle.png" />
            </div>
            {mostActive && (
              <div className="dirHeroChip dirHeroChipActive">
                <span className="dirHeroChipDot" />
                <div>
                  <strong>{formatCount(mostActive.weeklyPosts)} posts this week</strong>
                  <span>{mostActive.name}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="dirToolbar" role="search">
          <label className="dirSearch">
            <SearchIcon />
            <span className="srOnly">Search communities</span>
            <input
              type="search"
              maxLength={MAX_SEARCH_LENGTH}
              placeholder="Search by name, tagline or topic"
              value={searchText}
              onChange={(event) => onSearch(event.target.value)}
            />
          </label>
          <div className="dirSelects">
            <label className="dirSelect">
              <span>Location</span>
              <select value={filters.country} onChange={(event) => setFilter({ country: event.target.value })}>
                <option value="">Anywhere</option>
                {countries.map((country) => (
                  <option key={country.value} value={country.value}>{countryName(country.value)}</option>
                ))}
              </select>
            </label>
            <label className="dirSelect">
              <span>Stage</span>
              <select value={filters.stage} onChange={(event) => setFilter({ stage: event.target.value })}>
                <option value="">Any stage</option>
                {stages.filter((stage) => stage.value !== "any").map((stage) => (
                  <option key={stage.value} value={stage.value}>{stage.label}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </section>

      <YourCommunities items={mine} />

      <section className="dirResults" aria-labelledby="directory-results-title">
        <div className="dirChips" role="group" aria-label="Filter by topic">
          <button aria-pressed={filters.topic === ""} className="dirChip" onClick={() => setFilter({ topic: "" })} type="button">
            All topics
          </button>
          {topics.filter((topic) => (TOPIC_SLUGS as readonly string[]).includes(topic.value)).map((topic) => (
            <button
              aria-pressed={filters.topic === topic.value}
              className="dirChip"
              key={topic.value}
              onClick={() => setFilter({ topic: topic.value })}
              type="button"
            >
              {topic.label}
              {options && <span className="dirChipCount">{topic.count}</span>}
            </button>
          ))}
        </div>

        <div className="dirResultsHeader">
          <h2 id="directory-results-title">
            {topicLabel ?? "All circles"}
            <span>
              {shown}
              {directory.nextCursor ? "+" : ""} {shown === 1 && !directory.nextCursor ? "circle" : "circles"}
            </span>
          </h2>
          {hasFilters && (
            <button type="button" className="dirReset" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>

        <div className="communityGrid" aria-busy={directory.loading}>
          {directory.error ? (
            <div className="communityEmptyState">
              <h3>The directory could not load</h3>
              <p role="alert">{directory.error}</p>
              <button type="button" className="sparkPrimary" onClick={directory.retry}>
                Try again
              </button>
            </div>
          ) : shown > 0 ? (
            directory.items.map((community) => <CommunityCard community={community} key={community.id} />)
          ) : directory.loading ? (
            <p className="dirLoading" role="status">Loading communities…</p>
          ) : (
            <div className="communityEmptyState">
              <h3>No communities match — clear filters</h3>
              <p>Try a broader search, topic or location to see more circles.</p>
              <button type="button" className="sparkPrimary" onClick={clearFilters}>
                Clear filters
              </button>
            </div>
          )}
        </div>

        {!directory.error && directory.nextCursor && (
          <div className="dirMore">
            <button type="button" className="dirReset" disabled={directory.loadingMore} onClick={() => void directory.loadMore()}>
              {directory.loadingMore ? "Loading…" : "Show more"}
            </button>
            {directory.loadMoreError && <p role="alert">{directory.loadMoreError}</p>}
          </div>
        )}
      </section>

      <section className="dirCta" aria-labelledby="community-cta-heading">
        <div className="dirCtaCard">
          <div>
            <p className="dirEyebrow">Build with Spark</p>
            <h2 id="community-cta-heading">Run a circle of your own</h2>
            <p>
              Give your cohort, alumni network or builder group discussion rooms, a shared board and one schedule.
              Free to start.
            </p>
          </div>
          <div className="dirCtaActions">
            <Link className="dirCtaPrimary" href={isAuthenticated ? "/workspace" : "/signup?redirect=/workspace"}>
              Create a circle
            </Link>
            <Link className="dirCtaSecondary" href="/pricing">
              See pricing
            </Link>
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}

export default function CommunitiesPage() {
  return (
    <Suspense
      fallback={
        <main className="sparkLanding communityPageRoot">
          <SiteHeader />
        </main>
      }
    >
      <Directory />
    </Suspense>
  );
}
