"use client";

import Link from "next/link";
import { useState, useMemo } from "react";
import { useAuth } from "../auth-context";
import { HeroParticles } from "../hero-particles";
import { communities, type Community } from "./mock-data";

function SparkMark() {
  return (
    <svg aria-hidden="true" className="sparkMark" viewBox="0 0 48 48">
      <path className="sparkBolt" d="M27 2 8 27h13l-2 19 21-27H27z" />
    </svg>
  );
}

function PointerClickIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 3l7.07 16.97 2.51-7.39 7.39-2.51L4 3z" />
      <path d="M13 13l6 6" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

const CATEGORIES = [
  "All topics",
  "B2B SaaS",
  "AI & Data",
  "Climate Tech",
  "Product",
  "FinTech",
  "Founders Circle",
] as const;

export default function CommunitiesPage() {
  const { isAuthenticated } = useAuth();
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("All topics");
  const [selectedLocation, setSelectedLocation] = useState<string>("all");
  const [selectedStage, setSelectedStage] = useState<string>("all");

  const filteredCommunities = useMemo(() => {
    return communities.filter((item: Community) => {
      // Category filter
      if (selectedCategory !== "All topics" && item.category !== selectedCategory) {
        return false;
      }
      // Location filter
      if (selectedLocation !== "all" && item.location !== selectedLocation) {
        return false;
      }
      // Stage filter
      if (selectedStage !== "all" && item.stage !== selectedStage) {
        return false;
      }
      // Search term
      if (searchTerm.trim()) {
        const term = searchTerm.toLowerCase();
        const matchesName = item.name.toLowerCase().includes(term);
        const matchesDesc = item.description.toLowerCase().includes(term);
        const matchesTopic = item.topic.toLowerCase().includes(term);
        const matchesTags = item.tags.some((t) => t.toLowerCase().includes(term));
        return matchesName || matchesDesc || matchesTopic || matchesTags;
      }
      return true;
    });
  }, [searchTerm, selectedCategory, selectedLocation, selectedStage]);

  const hasActiveFilters =
    searchTerm.trim() !== "" ||
    selectedCategory !== "All topics" ||
    selectedLocation !== "all" ||
    selectedStage !== "all";

  const handleResetFilters = () => {
    setSearchTerm("");
    setSelectedCategory("All topics");
    setSelectedLocation("all");
    setSelectedStage("all");
  };

  return (
    <main className="sparkLanding communityPageRoot">
      {/* Global Background Particles */}
      <HeroParticles fixed />

      {/* Top Header */}
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
              Workspace <PointerClickIcon />
            </Link>
          ) : (
            <>
              <Link href="/login">Sign in</Link>
              <Link className="sparkNavButton" href="/signup?redirect=/workspace">
                Start free <PointerClickIcon />
              </Link>
            </>
          )}
        </div>
      </header>

      {/* Hero Section */}
      <section className="communityHeroSection">
        <div className="heroGlow" aria-hidden="true" />
        <div className="communityHeroContent">
          <div className="sparkKicker" style={{ justifyContent: "center" }}>
            <span></span>
            Public Community Directory
          </div>
          <h1>Find the right room for the work ahead.</h1>
          <p>
            Explore curated startup circles, founder peer groups, and high-trust practitioner rooms
            built to turn conversations into structured execution.
          </p>
        </div>
      </section>

      {/* Filter and Search Bar */}
      <section className="communityFilterContainer" aria-label="Filter communities">
        <div className="communitySearchRow">
          <div className="communitySearchInputWrapper">
            <SearchIcon />
            <input
              type="search"
              className="communitySearchInput"
              placeholder="Search circles by name, topic, or tags (e.g. SaaS, AI, GTM)..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              aria-label="Search communities"
            />
          </div>

          <div className="communityDropdownFilters">
            <select
              className="communitySelect"
              value={selectedLocation}
              onChange={(e) => setSelectedLocation(e.target.value)}
              aria-label="Filter by location"
            >
              <option value="all">All locations</option>
              <option value="Ho Chi Minh City">Ho Chi Minh City</option>
              <option value="Hanoi">Hanoi</option>
              <option value="Remote · Vietnam">Remote · Vietnam</option>
            </select>

            <select
              className="communitySelect"
              value={selectedStage}
              onChange={(e) => setSelectedStage(e.target.value)}
              aria-label="Filter by stage"
            >
              <option value="all">All stages</option>
              <option value="Idea to Pre-seed">Idea to Pre-seed</option>
              <option value="Pre-seed to Seed">Pre-seed to Seed</option>
              <option value="Seed to Series A">Seed to Series A</option>
              <option value="Any stage">Any stage</option>
            </select>
          </div>
        </div>

        {/* Category Pills */}
        <div className="communityCategoryTabs" role="tablist" aria-label="Categories">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              role="tab"
              aria-selected={selectedCategory === cat}
              className={`categoryTabBtn ${selectedCategory === cat ? "active" : ""}`}
              onClick={() => setSelectedCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      </section>

      {/* Results Count & Reset Bar */}
      <div className="communityResultsBar">
        <span>
          Showing <b>{filteredCommunities.length}</b> {filteredCommunities.length === 1 ? "community circle" : "community circles"}
        </span>
        {hasActiveFilters && (
          <button type="button" className="resetFiltersBtn" onClick={handleResetFilters}>
            Reset filters
          </button>
        )}
      </div>

      {/* Community Grid */}
      <section className="communityGrid" aria-label="Featured communities">
        {filteredCommunities.length > 0 ? (
          filteredCommunities.map((community) => (
            <article className="communityCard" key={community.slug}>
              <div className="communityCardHeader">
                <div className="communityMonogram" style={{ background: community.gradient }}>
                  {community.initials}
                </div>
                <div className="communityCardBadges">
                  {community.featured && (
                    <span className="communityFeaturedBadge">Featured</span>
                  )}
                  <span className="communityTopicBadge">{community.topic}</span>
                </div>
              </div>

              <h3>{community.name}</h3>
              <p className="communityCardDesc">{community.description}</p>

              {/* Tag Chips */}
              <div className="communityTagsRow">
                {community.tags.map((tag) => (
                  <span key={tag} className="communityTagChip">
                    #{tag}
                  </span>
                ))}
              </div>

              {/* Location & Stage Metadata */}
              <dl className="communityMetaDl">
                <div>
                  <dt>Location</dt>
                  <dd title={community.location}>{community.location}</dd>
                </div>
                <div>
                  <dt>Stage</dt>
                  <dd title={community.stage}>{community.stage}</dd>
                </div>
              </dl>

              {/* Activity Indicator */}
              <div className="communityActivityRow">
                <span className="communityActivityDot" />
                <span>{community.activity}</span>
              </div>

              <div className="communityCardFooter">
                <span className="communityMemberStat">{community.members}</span>
                <Link className="communityCardActionBtn" href={`/communities/${community.slug}`}>
                  Explore Circle
                </Link>
              </div>
            </article>
          ))
        ) : (
          <div className="communityEmptyState">
            <h3>No community circles found</h3>
            <p>We couldn&apos;t find any communities matching your current search and filter criteria.</p>
            <button type="button" className="sparkPrimary" onClick={handleResetFilters}>
              Clear all filters
            </button>
          </div>
        )}
      </section>

      {/* High-Impact Bottom Conversion Section */}
      <section className="sparkCtaSection" aria-labelledby="community-cta-heading">
        <div className="ctaBackgroundGlow" aria-hidden="true" />
        <div className="sparkCtaCard">
          <div className="ctaRadarField" aria-hidden="true">
            <span className="ctaRadarRing ctaRadarRing1" />
            <span className="ctaRadarRing ctaRadarRing2" />
          </div>
          <div className="sparkCtaContent">
            <div className="sparkKicker ctaKicker">
              <span className="ctaPulseDot" />
              Build with Spark
            </div>
            <h2 id="community-cta-heading">Start your own community circle on Spark</h2>
            <p className="ctaDescription">
              Organize your startup cohort, founder alumni network, or niche developer group with
              structured discussion rooms, task boards, and member schedules.
            </p>
            <div className="ctaActions">
              <Link className="ctaPrimaryBtn" href={isAuthenticated ? "/workspace" : "/signup?redirect=/workspace"}>
                Create a circle <PointerClickIcon />
              </Link>
              <Link className="ctaSecondaryBtn" href="/pricing">
                View pricing plans
              </Link>
            </div>
            <div className="ctaTrustRow">
              <span>✓ Free for community starters</span>
              <span>✓ Private & public rooms</span>
              <span>✓ Instant setup</span>
            </div>
          </div>
        </div>
      </section>

      {/* Enterprise-Grade Footer */}
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
                <li><Link href="/#product">Features</Link></li>
                <li><Link href="/#pathways">Pathways</Link></li>
                <li><Link href="/#workflow">Kanban Delivery</Link></li>
                <li><Link href="/pricing">Pricing & Plans</Link></li>
              </ul>
            </div>

            {/* Column 2: Ecosystem */}
            <div className="footerCol">
              <h4 className="footerColTitle">Ecosystem</h4>
              <ul className="footerLinksList">
                <li><Link href="/communities">Community Circles</Link></li>
                <li><Link href="/workspace">Workspace App</Link></li>
                <li><Link href="/schedule">Events & Calendar</Link></li>
                <li><Link href="/notifications">Signal Feed</Link></li>
              </ul>
            </div>

            {/* Column 3: Trust & Platform */}
            <div className="footerCol">
              <h4 className="footerColTitle">Trust & Security</h4>
              <ul className="footerLinksList">
                <li><Link href="/admin">Platform Moderation</Link></li>
                <li><Link href="/pricing">RLS & Data Isolation</Link></li>
                <li><Link href="/login">Opaque Session Auth</Link></li>
                <li><Link href="/signup">Create Account</Link></li>
              </ul>
            </div>
          </div>

          <div className="footerBottom">
            <p className="footerCopyright">
              © {new Date().getFullYear()} Spark Inc. All rights reserved. Built for high-trust founder circles.
            </p>
            <div className="footerBottomLinks">
              <Link href="/terms">Terms</Link>
              <Link href="/privacy">Privacy</Link>
              <Link href="/security">Security</Link>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}
