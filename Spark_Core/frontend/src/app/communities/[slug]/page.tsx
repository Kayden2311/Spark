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

function ArrowRightIcon() {
  return (
    <svg className="btnInlineIcon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg className="circleCheckIcon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function VerifiedBadgeIcon() {
  return (
    <svg className="circleVerifiedIcon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg className="circleStatIcon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg className="circleStatIcon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ChatBubbleIcon() {
  return (
    <svg className="circleStatIcon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zm-5 0H8v2h2V9z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ShieldCheckIcon() {
  return (
    <svg className="circleStatIcon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M2.166 4.999A11.954 11.954 0 0010 1.944 11.954 11.954 0 0017.834 5c.11.65.166 1.32.166 2.001 0 5.225-3.34 9.67-8 11.317C5.34 16.67 2 12.225 2 7c0-.682.057-1.35.166-2.001zm11.541 3.708a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export default async function CommunityDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const community: Community | undefined = communities.find((entry) => entry.slug === slug);
  if (!community) notFound();

  // Find related communities in similar category
  const relatedCommunities = communities
    .filter((c) => c.slug !== community.slug)
    .slice(0, 2);

  return (
    <main className="sparkLanding circleDetailPageRoot">
      {/* Global Background Wave Particles */}
      <SignalParticles />

      {/* Spark Standard Header */}
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
            Join Circle <ArrowRightIcon />
          </Link>
        </div>
      </header>

      {/* Breadcrumb Navigation Bar */}
      <nav className="circleBreadcrumbBar" aria-label="Breadcrumb">
        <div className="circleBreadcrumbInner">
          <Link href="/communities" className="circleBackLink">
            <span aria-hidden="true">←</span> Directory
          </Link>
          <span className="circleBreadcrumbSeparator">/</span>
          <span className="circleBreadcrumbCategory">{community.category}</span>
          <span className="circleBreadcrumbSeparator">/</span>
          <span className="circleBreadcrumbCurrent" aria-current="page">
            {community.name}
          </span>
        </div>
      </nav>

      {/* Premium Circle Header Hero */}
      <section className="circleHeroContainer">
        <div className="circleHeroCard">
          <div className="circleHeroTop">
            <div className="circleAvatarWrap">
              <div className="circleAvatarMonogram" style={{ background: community.gradient }}>
                {community.initials}
              </div>
              <div className="circleVerifiedPill" title="Verified Spark Circle">
                <VerifiedBadgeIcon />
              </div>
            </div>

            <div className="circleHeroMainInfo">
              <div className="circlePillsRow">
                {community.featured && (
                  <span className="circlePill circlePillFeatured">Featured Circle</span>
                )}
                <span className="circlePill circlePillCategory">{community.category}</span>
                <span className="circlePill circlePillStage">{community.stage}</span>
                <span className="circlePill circlePillLocation">📍 {community.location}</span>
              </div>

              <h1 className="circleTitle">{community.name}</h1>
              <p className="circleSubtitle">{community.description}</p>
            </div>

            <div className="circleHeroActionBox">
              <Link
                className="circlePrimaryJoinBtn"
                href={`/signup?redirect=/communities/${community.slug}`}
              >
                Join this Circle <ArrowRightIcon />
              </Link>
              <div className="circleActionSubtext">
                <span className="circleLiveDot" aria-hidden="true" />
                <span>{community.members} · Free to participate</span>
              </div>
            </div>
          </div>

          {/* Quick Metrics Ribbon */}
          <div className="circleMetricsRibbon">
            <div className="circleMetricItem">
              <UsersIcon />
              <div>
                <strong className="metricVal">{community.members}</strong>
                <span className="metricLabel">Verified Members</span>
              </div>
            </div>
            <div className="circleMetricItem">
              <ChatBubbleIcon />
              <div>
                <strong className="metricVal">{community.recentTopics.length * 7}+ discussions</strong>
                <span className="metricLabel">Weekly Signal Velocity</span>
              </div>
            </div>
            <div className="circleMetricItem">
              <CalendarIcon />
              <div>
                <strong className="metricVal">{community.upcomingEvents[0]?.date || "Bi-weekly"}</strong>
                <span className="metricLabel">Next Live Session</span>
              </div>
            </div>
            <div className="circleMetricItem">
              <ShieldCheckIcon />
              <div>
                <strong className="metricVal">High Context</strong>
                <span className="metricLabel">Zero Spam Policy</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Two-Column Structured Content Body */}
      <div className="circleBodyContainer">
        {/* Main Content Column (68%) */}
        <div className="circleMainCol">
          {/* Mission & Purpose Card */}
          <section className="circleCard" aria-labelledby="section-about">
            <div className="circleCardHeader">
              <div className="sparkKicker">
                <span></span>
                Circle Overview
              </div>
              <h2 id="section-about">About this community</h2>
            </div>
            <p className="circleBodyParagraph">{community.longDescription}</p>

            <div className="circleTagsSection">
              <span className="circleTagsLabel">Core focus areas:</span>
              <div className="circleTagsList">
                {community.tags.map((tag) => (
                  <span key={tag} className="circleTagBadge">
                    #{tag}
                  </span>
                ))}
              </div>
            </div>
          </section>

          {/* Guidelines & High-Trust Norms */}
          <section className="circleCard" aria-labelledby="section-norms">
            <div className="circleCardHeader">
              <div className="sparkKicker">
                <span></span>
                Circle Norms
              </div>
              <h2 id="section-norms">How this circle operates</h2>
            </div>
            <div className="circleNormsGrid">
              <div className="circleNormItem">
                <div className="normCheck"><CheckCircleIcon /></div>
                <div>
                  <h4>High Signal, Zero Self-Promotion</h4>
                  <p>All discussions are focused on solving tactical engineering, GTM, and operational hurdles without sales pitches.</p>
                </div>
              </div>
              <div className="circleNormItem">
                <div className="normCheck"><CheckCircleIcon /></div>
                <div>
                  <h4>Peer Confidentiality</h4>
                  <p>Private room discussions, tear-downs, and sprint metrics shared inside this circle remain confidential.</p>
                </div>
              </div>
              <div className="circleNormItem">
                <div className="normCheck"><CheckCircleIcon /></div>
                <div>
                  <h4>Real Follow-Through</h4>
                  <p>Action items, resources, and insights from weekly syncs are documented directly into your Spark workspace.</p>
                </div>
              </div>
            </div>
          </section>

          {/* Active Discussions Preview */}
          <section className="circleCard" aria-labelledby="section-discussions">
            <div className="circleCardHeaderWithAction">
              <div>
                <div className="sparkKicker">
                  <span></span>
                  Active Discussions
                </div>
                <h2 id="section-discussions">Recent conversations & questions</h2>
              </div>
              <span className="circleCountPill">{community.recentTopics.length} active threads</span>
            </div>

            <div className="circleDiscussionsList">
              {community.recentTopics.map((topic, idx) => (
                <div key={idx} className="circleDiscussionRow">
                  <div className="discussionAvatar">
                    {topic.author.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                  </div>
                  <div className="discussionMain">
                    <h3 className="discussionTitle">{topic.title}</h3>
                    <div className="discussionMeta">
                      <span>Started by <strong>{topic.author}</strong></span>
                      <span>·</span>
                      <span>{topic.time}</span>
                    </div>
                  </div>
                  <div className="discussionRepliesBadge">
                    <ChatBubbleIcon />
                    <span>{topic.replies} replies</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Upcoming Events & Live Syncs */}
          <section className="circleCard" aria-labelledby="section-events">
            <div className="circleCardHeader">
              <div className="sparkKicker">
                <span></span>
                Scheduled Sessions
              </div>
              <h2 id="section-events">Upcoming events & syncs</h2>
            </div>

            <div className="circleEventsGrid">
              {community.upcomingEvents.map((evt, idx) => (
                <div key={idx} className="circleEventCard">
                  <div className="eventDateBox">
                    <span className="eventDateMonth">{evt.date.split(" ")[1] || "SEP"}</span>
                    <span className="eventDateDay">{evt.date.split(" ")[2] || "24"}</span>
                  </div>
                  <div className="eventDetails">
                    <h3 className="eventTitle">{evt.title}</h3>
                    <div className="eventMetaRow">
                      <span className="eventMetaChip">⏰ {evt.time}</span>
                      <span className="eventMetaChip eventFormatChip">📍 {evt.format}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* Sidebar Column (32%) */}
        <aside className="circleSidebarCol">
          {/* Quick Join Card */}
          <div className="circleSidebarCard circleJoinStickyCard">
            <div className="sidebarCardHeader">
              <h3>Participate in {community.name}</h3>
              <span className="sidebarPriceTag">Free</span>
            </div>
            <p className="sidebarSubtext">
              Join this verified founder circle to participate in discussions, attend live rooms, and share resources.
            </p>

            <ul className="sidebarPerksList">
              <li>
                <CheckCircleIcon />
                <span>Full access to circle channels & discussions</span>
              </li>
              <li>
                <CheckCircleIcon />
                <span>Invites to weekly live rooms & tear-downs</span>
              </li>
              <li>
                <CheckCircleIcon />
                <span>Shared sprint templates & resource vault</span>
              </li>
              <li>
                <CheckCircleIcon />
                <span>Direct peer DM network with verified founders</span>
              </li>
            </ul>

            <Link
              className="circleSidebarCtaBtn"
              href={`/signup?redirect=/communities/${community.slug}`}
            >
              Join this Circle <ArrowRightIcon />
            </Link>
            <p className="sidebarCtaNotice">Instant access upon sign up · No credit card required</p>
          </div>

          {/* Circle Host Card */}
          <div className="circleSidebarCard">
            <div className="sparkKicker" style={{ marginBottom: "0.5rem" }}>
              <span></span>
              Circle Host
            </div>
            <div className="hostProfileBox">
              <div className="hostAvatarLarge">
                {community.host.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
              </div>
              <div className="hostProfileInfo">
                <div className="hostNameRow">
                  <strong>{community.host.name}</strong>
                  <span className="hostVerifiedBadge" title="Verified Host">✓</span>
                </div>
                <span className="hostRoleTitle">{community.host.role}</span>
              </div>
            </div>
            <p className="hostBioText">
              Curates high-signal peer discussions and facilitates weekly founder syncs across Southeast Asian venture hubs.
            </p>
          </div>

          {/* Circle Specs Card */}
          <div className="circleSidebarCard">
            <div className="sparkKicker" style={{ marginBottom: "0.5rem" }}>
              <span></span>
              Specifications
            </div>
            <dl className="circleSpecsDl">
              <div className="specRow">
                <dt>Category</dt>
                <dd>{community.category}</dd>
              </div>
              <div className="specRow">
                <dt>Target Stage</dt>
                <dd>{community.stage}</dd>
              </div>
              <div className="specRow">
                <dt>Primary Location</dt>
                <dd>{community.location}</dd>
              </div>
              <div className="specRow">
                <dt>Access Policy</dt>
                <dd>Open Public Circle</dd>
              </div>
              <div className="specRow">
                <dt>Workspace Sync</dt>
                <dd>Enabled (Spark Outbox)</dd>
              </div>
            </dl>
          </div>

          {/* Related Circles */}
          {relatedCommunities.length > 0 && (
            <div className="circleSidebarCard">
              <div className="sparkKicker" style={{ marginBottom: "0.5rem" }}>
                <span></span>
                Related Circles
              </div>
              <div className="relatedCirclesList">
                {relatedCommunities.map((rel) => (
                  <Link key={rel.slug} href={`/communities/${rel.slug}`} className="relatedCircleItem">
                    <div className="relatedCircleAvatar" style={{ background: rel.gradient }}>
                      {rel.initials}
                    </div>
                    <div className="relatedCircleInfo">
                      <h4>{rel.name}</h4>
                      <span>{rel.members} · {rel.category}</span>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </aside>
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
            <h2 id="community-detail-cta">Ready to collaborate with {community.name}?</h2>
            <p className="ctaDescription">
              Connect with founders, participate in weekly syncs, and link this circle directly into your Spark execution workspace.
            </p>
            <div className="ctaActions">
              <Link
                className="ctaPrimaryBtn"
                href={`/signup?redirect=/communities/${community.slug}`}
              >
                Join {community.name} <ArrowRightIcon />
              </Link>
              <Link className="ctaSecondaryBtn" href="/communities">
                Explore all circles
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

