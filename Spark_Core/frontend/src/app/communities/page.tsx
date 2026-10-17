"use client";

import Image from "next/image";
import Link from "next/link";
import { useState, useMemo } from "react";
import { useAuth } from "../auth-context";
import { SignalParticles } from "../signal-particles";
import { ALL_TOPICS, ALL_VALUES, emptyFilters, filterCommunities, hasActiveFilters } from "./filter";
import { CommunityCard } from "./community-card";
import { communitySummaries } from "./community-summaries";
import { formatCount, formatEventDate } from "./format";
import type { CommunityCategory } from "./types";

function SparkMark() {
  return (
    <svg aria-hidden="true" className="sparkMark" viewBox="0 0 48 48">
      <path className="sparkBolt" d="M27 2 8 27h13l-2 19 21-27H27z" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

const CATEGORIES: CommunityCategory[] = ["B2B SaaS", "AI & Data", "Climate Tech", "Product", "FinTech", "Founders Circle"];
const LOCATIONS = ["Ho Chi Minh City", "Hanoi", "Remote · Vietnam"];
const STAGES = ["Idea to Pre-seed", "Pre-seed to Seed", "Seed to Series A", "Any stage"];

const totals = {
  circles: communitySummaries.length,
  members: communitySummaries.reduce((sum, item) => sum + item.memberCount, 0),
  posts: communitySummaries.reduce((sum, item) => sum + item.weeklyPosts, 0),
};
const mostActive = [...communitySummaries].sort((a, b) => b.weeklyPosts - a.weeklyPosts)[0]!;
const nextUp = communitySummaries
  .filter((item) => item.nextEventAt)
  .sort((a, b) => a.nextEventAt!.localeCompare(b.nextEventAt!))[0];

export default function CommunitiesPage() {
  const { isAuthenticated } = useAuth();
  const [searchTerm, setSearchTerm] = useState(emptyFilters.searchTerm);
  const [selectedCategory, setSelectedCategory] = useState<string>(ALL_TOPICS);
  const [selectedLocation, setSelectedLocation] = useState<string>(ALL_VALUES);
  const [selectedStage, setSelectedStage] = useState<string>(ALL_VALUES);

  const filters = useMemo(
    () => ({ searchTerm, category: selectedCategory, location: selectedLocation, stage: selectedStage }),
    [searchTerm, selectedCategory, selectedLocation, selectedStage],
  );
  const filteredCommunities = useMemo(() => filterCommunities(communitySummaries, filters), [filters]);
  const hasFilters = hasActiveFilters(filters);
  // Category counts follow the other filters, so each chip shows what clicking it would return.
  const categoryCounts = useMemo(() => {
    const others = filterCommunities(communitySummaries, { ...filters, category: ALL_TOPICS });
    const counts = new Map<string, number>([[ALL_TOPICS, others.length]]);
    for (const item of others) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    return counts;
  }, [filters]);

  const handleResetFilters = () => {
    setSearchTerm(emptyFilters.searchTerm);
    setSelectedCategory(ALL_TOPICS);
    setSelectedLocation(ALL_VALUES);
    setSelectedStage(ALL_VALUES);
  };

  const resultsTitle = selectedCategory === ALL_TOPICS ? "All circles" : selectedCategory;

  return (
    <main className="sparkLanding communityPageRoot">
      <SignalParticles />

      <header className="sparkHeader">
        <Link className="sparkBrand" href="/" aria-label="Spark home">
          <SparkMark />
          <span>Spark</span>
        </Link>
        <nav aria-label="Main navigation">
          <Link href="/#product">Product</Link>
          <Link href="/#pathways">Pathways</Link>
          <Link href="/#workflow">Workflow</Link>
          <Link href="/pricing">Pricing</Link>
          <Link aria-current="page" href="/communities" style={{ color: "var(--landing-blue)" }}>
            Community
          </Link>
        </nav>
        <div className="headerActions">
          {isAuthenticated ? (
            <Link className="sparkNavButton" href="/workspace">
              Workspace
            </Link>
          ) : (
            <>
              <Link href="/login">Sign in</Link>
              <Link className="sparkNavButton" href="/signup?redirect=/workspace">
                Start free
              </Link>
            </>
          )}
        </div>
      </header>

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
                <dd>{totals.circles}</dd>
              </div>
              <div>
                <dt>Members</dt>
                <dd>{formatCount(totals.members)}</dd>
              </div>
              <div>
                <dt>Posts this week</dt>
                <dd>{formatCount(totals.posts)}</dd>
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
            <div className="dirHeroChip dirHeroChipActive">
              <span className="dirHeroChipDot" />
              <div>
                <strong>{mostActive.weeklyPosts} posts this week</strong>
                <span>{mostActive.name}</span>
              </div>
            </div>
            {nextUp && (
              <div className="dirHeroChip dirHeroChipEvent">
                <span className="dirHeroChipDate">{formatEventDate(nextUp.nextEventAt)}</span>
                <div>
                  <strong>Next session</strong>
                  <span>{nextUp.name}</span>
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
              placeholder="Search by name, topic or tag"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </label>
          <div className="dirSelects">
            <label className="dirSelect">
              <span>Location</span>
              <select value={selectedLocation} onChange={(e) => setSelectedLocation(e.target.value)}>
                <option value={ALL_VALUES}>Anywhere</option>
                {LOCATIONS.map((location) => <option key={location} value={location}>{location}</option>)}
              </select>
            </label>
            <label className="dirSelect">
              <span>Stage</span>
              <select value={selectedStage} onChange={(e) => setSelectedStage(e.target.value)}>
                <option value={ALL_VALUES}>Any stage</option>
                {STAGES.filter((stage) => stage !== "Any stage").map((stage) => <option key={stage} value={stage}>{stage}</option>)}
              </select>
            </label>
          </div>
        </div>
      </section>

      <section className="dirResults" aria-labelledby="directory-results-title">
        <div className="dirChips" role="group" aria-label="Filter by topic">
          {[ALL_TOPICS, ...CATEGORIES].map((category) => (
            <button
              aria-pressed={selectedCategory === category}
              className="dirChip"
              key={category}
              onClick={() => setSelectedCategory(category)}
              type="button"
            >
              {category}
              <span className="dirChipCount">{categoryCounts.get(category) ?? 0}</span>
            </button>
          ))}
        </div>

        <div className="dirResultsHeader">
          <h2 id="directory-results-title">
            {resultsTitle}
            <span>{filteredCommunities.length} {filteredCommunities.length === 1 ? "circle" : "circles"}</span>
          </h2>
          {hasFilters && (
            <button type="button" className="dirReset" onClick={handleResetFilters}>
              Clear filters
            </button>
          )}
        </div>

        <div className="communityGrid">
          {filteredCommunities.length > 0 ? (
            filteredCommunities.map((community) => <CommunityCard community={community} key={community.slug} />)
          ) : (
            <div className="communityEmptyState">
              <h3>No circles match these filters</h3>
              <p>Try a broader topic or location, or clear the filters to see every circle.</p>
              <button type="button" className="sparkPrimary" onClick={handleResetFilters}>
                Clear all filters
              </button>
            </div>
          )}
        </div>
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

      {/* Fully Styled Spark Footer */}
      <footer className="sparkFooter">
        <div className="footerInner">
          <div className="footerGrid">
            {/* Brand Column */}
            <div className="footerBrandCol">
              <Link className="sparkBrand footerBrand" href="/" aria-label="Spark home">
                <SparkMark />
                <span>Spark</span>
              </Link>
              <p className="footerTagline">
                One calm operating system for startup communities, founder circles, and high-velocity product teams.
              </p>
              <div className="footerStatusBadge">
                <span className="footerStatusDot" />
                <span>All systems operational</span>
              </div>
            </div>

            {/* Column 1: Product */}
            <div className="footerCol">
              <h4 className="footerColTitle">Product</h4>
              <ul className="footerLinksList">
                <li><Link href="/workspace">Workspace Boards</Link></li>
                <li><Link href="/communities">Community Circles</Link></li>
                <li><Link href="/schedule">Schedule & Timeline</Link></li>
                <li><Link href="/notifications">Signal Notifications</Link></li>
                <li><Link href="/pricing">Pricing & Plans</Link></li>
              </ul>
            </div>

            {/* Column 2: Ecosystem */}
            <div className="footerCol">
              <h4 className="footerColTitle">Ecosystem</h4>
              <ul className="footerLinksList">
                <li><Link href="/communities">Browse Directory</Link></li>
                <li><Link href="/communities">Founder Circles</Link></li>
                <li><Link href="/communities">Builder Network</Link></li>
                <li><Link href="/workspace">Agile Templates</Link></li>
                <li><Link href="/#pathways">Pathway Choices</Link></li>
              </ul>
            </div>

            {/* Column 3: Trust & Resources */}
            <div className="footerCol">
              <h4 className="footerColTitle">Trust & Resources</h4>
              <ul className="footerLinksList">
                <li><Link href="/#workflow">Workflow Guide</Link></li>
                <li><Link href="/pricing">Plan Matrix</Link></li>
                <li><Link href="/#main-content">Privacy Policy</Link></li>
                <li><Link href="/#main-content">Terms of Service</Link></li>
                <li><Link href="/#main-content">Security & RLS</Link></li>
              </ul>
            </div>
          </div>

          {/* Footer Bottom Bar */}
          <div className="footerBottom">
            <p className="footerCopyright">
              &copy; {new Date().getFullYear()} Spark Technologies, Inc. Built for high-velocity teams.
            </p>
            <div className="footerSocialLinks">
              <a href="https://github.com" target="_blank" rel="noopener noreferrer" aria-label="GitHub">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
                </svg>
              </a>
              <a href="https://x.com" target="_blank" rel="noopener noreferrer" aria-label="X (formerly Twitter)">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                </svg>
              </a>
              <a href="https://discord.com" target="_blank" rel="noopener noreferrer" aria-label="Discord">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                  <path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.893.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
                </svg>
              </a>
              <a href="https://linkedin.com" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                  <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z"/>
                </svg>
              </a>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}
