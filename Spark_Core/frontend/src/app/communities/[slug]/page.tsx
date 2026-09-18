import Link from "next/link";
import { notFound } from "next/navigation";
import { SignalParticles } from "../../signal-particles";
import { communities, type Community } from "../mock-data";

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

export default async function CommunityDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const community: Community | undefined = communities.find((entry) => entry.slug === slug);
  if (!community) notFound();

  return (
    <main className="sparkLanding communityPageRoot">
      {/* Global Background Particles (Live Signal Flow wave) */}
      <SignalParticles />

      {/* Spark Header */}
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
          <Link href="/login">Sign in</Link>
          <Link className="sparkNavButton" href={`/signup?redirect=/communities/${community.slug}`}>
            Join Circle <PointerClickIcon />
          </Link>
        </div>
      </header>

      {/* Hero Profile */}
      <section className="communityDetailHero">
        <Link className="communityBackLink" href="/communities">
          ← Back to all communities
        </Link>

        <div className="communityProfileCard">
          <div className="communityDetailMonogram" style={{ background: community.gradient }}>
            {community.initials}
          </div>

          <div className="communityProfileInfo">
            <div className="communityCardBadges" style={{ justifyContent: "flex-start", marginBottom: "0.4rem" }}>
              {community.featured && <span className="communityFeaturedBadge">Featured Circle</span>}
              <span className="communityTopicBadge">{community.topic}</span>
            </div>
            <h1>{community.name}</h1>
            <p>{community.description}</p>
          </div>

          <div className="communityProfileActions">
            <Link
              className="communityJoinBtn"
              href={`/signup?redirect=/communities/${community.slug}`}
            >
              Join this circle <PointerClickIcon />
            </Link>
            <span className="communityJoinBtnNotice">
              {community.members} · Free to participate
            </span>
          </div>
        </div>
      </section>

      {/* Two-Column Detail Body */}
      <div className="communityDetailBody">
        {/* Main Column */}
        <div className="communityDetailMainCol">
          {/* About Section */}
          <div className="communityDetailSectionCard">
            <div className="sparkKicker" style={{ marginBottom: "0.5rem" }}>
              <span></span>
              About this Circle
            </div>
            <h2>Small rooms, high context, real follow-through.</h2>
            <p className="sectionBodyText">{community.longDescription}</p>

            <div className="communityTagsRow" style={{ margin: "1rem 0 0" }}>
              {community.tags.map((tag) => (
                <span key={tag} className="communityTagChip">
                  #{tag}
                </span>
              ))}
            </div>
          </div>

          {/* Active Discussion Topics Preview */}
          <div className="communityDetailSectionCard">
            <div className="sparkKicker" style={{ marginBottom: "0.5rem" }}>
              <span></span>
              Recent Circle Discussions
            </div>
            <h2>Topics being discussed this week</h2>
            <div className="communityTopicsList">
              {community.recentTopics.map((topic, idx) => (
                <div key={idx} className="communityTopicItem">
                  <div>
                    <h4>{topic.title}</h4>
                    <small>
                      Started by <b>{topic.author}</b> · {topic.time}
                    </small>
                  </div>
                  <span className="communityTopicRepliesBadge">
                    {topic.replies} replies
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Side Column */}
        <div className="communityDetailSideCol">
          {/* Host Card */}
          <div className="communityDetailSectionCard">
            <div className="sparkKicker" style={{ marginBottom: "0.5rem" }}>
              <span></span>
              Circle Host
            </div>
            <h2>Organized by</h2>
            <div className="communityHostCard">
              <div className="communityHostAvatar">
                {community.host.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
              </div>
              <div className="communityHostInfo">
                <strong>{community.host.name}</strong>
                <span>{community.host.role}</span>
              </div>
            </div>
          </div>

          {/* Upcoming Events */}
          <div className="communityDetailSectionCard">
            <div className="sparkKicker" style={{ marginBottom: "0.5rem" }}>
              <span></span>
              Upcoming Events
            </div>
            <h2>Circle schedule</h2>
            <div className="communityEventsList">
              {community.upcomingEvents.map((evt, idx) => (
                <div key={idx} className="communityEventItem">
                  <h4>{evt.title}</h4>
                  <div className="communityEventMeta">
                    <span>📅 {evt.date}</span>
                    <span>⏰ {evt.time}</span>
                    <span>📍 {evt.format}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Metadata Card */}
          <div className="communityDetailSectionCard">
            <div className="sparkKicker" style={{ marginBottom: "0.5rem" }}>
              <span></span>
              Key Attributes
            </div>
            <h2>Circle Details</h2>
            <dl className="communityMetaDl" style={{ margin: 0 }}>
              <div>
                <dt>Location</dt>
                <dd>{community.location}</dd>
              </div>
              <div>
                <dt>Target Stage</dt>
                <dd>{community.stage}</dd>
              </div>
              <div>
                <dt>Active Size</dt>
                <dd>{community.members}</dd>
              </div>
              <div>
                <dt>Access Type</dt>
                <dd>Open Public Circle</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>

      {/* Bottom Conversion Section */}
      <section className="sparkCtaSection" aria-labelledby="community-detail-cta">
        <div className="ctaBackgroundGlow" aria-hidden="true" />
        <div className="sparkCtaCard">
          <div className="ctaRadarField" aria-hidden="true">
            <span className="ctaRadarRing ctaRadarRing1" />
            <span className="ctaRadarRing ctaRadarRing2" />
          </div>
          <div className="sparkCtaContent">
            <div className="sparkKicker ctaKicker">
              <span className="ctaPulseDot" />
              Get started
            </div>
            <h2 id="community-detail-cta">Ready to join {community.name}?</h2>
            <p className="ctaDescription">
              Connect with founders, join upcoming discussions, and link this circle directly to your Spark workspace.
            </p>
            <div className="ctaActions">
              <Link
                className="ctaPrimaryBtn"
                href={`/signup?redirect=/communities/${community.slug}`}
              >
                Join {community.name} <PointerClickIcon />
              </Link>
              <Link className="ctaSecondaryBtn" href="/communities">
                Explore other circles
              </Link>
            </div>
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
