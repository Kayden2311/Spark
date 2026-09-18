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

function LocationPinIcon() {
  return (
    <svg className="metaInlineIcon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function StageIcon() {
  return (
    <svg className="metaInlineIcon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" />
    </svg>
  );
}

function ChatBubbleIcon() {
  return (
    <svg className="metaInlineIcon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zm-5 0H8v2h2V9z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg className="metaInlineIcon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export default async function CommunityDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const community: Community | undefined = communities.find((entry) => entry.slug === slug);
  if (!community) notFound();

  const relatedCommunities = communities
    .filter((c) => c.slug !== community.slug)
    .slice(0, 2);

  // Mock active member avatars for community credibility
  const sampleAvatars = [
    community.host.name.split(" ").map((n) => n[0]).join("").slice(0, 2),
    community.recentTopics[0]?.author.split(" ").map((n) => n[0]).join("").slice(0, 2) || "HN",
    community.recentTopics[1]?.author.split(" ").map((n) => n[0]).join("").slice(0, 2) || "AD",
  ];

  return (
    <main className="sparkLanding circleDetailRoot">
      <SignalParticles />

      {/* Header */}
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
          <Link className="sparkNavButton" href="/signup?redirect=/workspace">
            Start free
          </Link>
        </div>
      </header>

      {/* Direct Breadcrumb Sub-Header */}
      <nav className="circleBreadcrumbHeader" aria-label="Breadcrumb">
        <div className="circleBreadcrumbContainer">
          <Link href="/communities" className="circleBackLink">
            ← Directory
          </Link>
          <span className="circleBreadcrumbDivider">/</span>
          <span className="circleBreadcrumbCategory">{community.category}</span>
          <span className="circleBreadcrumbDivider">/</span>
          <span className="circleBreadcrumbCurrent">{community.name}</span>
        </div>
      </nav>

      {/* Main Container */}
      <div className="circlePageContainer">
        {/* Hero Identity Banner */}
        <section className="circleHeroHeader">
          <div className="circleHeroIdentityRow">
            <div className="circleMonogramBadge" style={{ background: community.gradient }}>
              {community.initials}
              <div className="circleVerifiedMarker" title="Verified Spark Circle">
                <VerifiedBadgeIcon />
              </div>
            </div>

            <div className="circleHeroTitleBlock">
              <div className="circleTagBadgesRow">
                {community.featured && (
                  <span className="circleTagBadge circleTagFeatured">Featured Circle</span>
                )}
                <span className="circleTagBadge circleTagCategory">{community.category}</span>
                <span className="circleTagMeta">
                  <StageIcon /> {community.stage}
                </span>
                <span className="circleTagMeta">
                  <LocationPinIcon /> {community.location}
                </span>
              </div>
              <h1 className="circleMainTitle">{community.name}</h1>
              <p className="circleMainDescription">{community.longDescription}</p>
            </div>
          </div>

          {/* Social Proof & Join Action Bar */}
          <div className="circleHeroActionBar">
            <div className="circleMemberStack">
              <div className="avatarGroup">
                {sampleAvatars.map((init, i) => (
                  <span key={i} className="memberAvatarPill" style={{ zIndex: 3 - i }}>
                    {init}
                  </span>
                ))}
              </div>
              <div className="memberStackText">
                <strong>{community.members}</strong>
                <span>Active discussions & weekly syncs</span>
              </div>
            </div>

            <div className="circleActionGroup">
              <Link
                className="circleCtaBtn"
                href={`/signup?redirect=/communities/${community.slug}`}
              >
                Join {community.name}
              </Link>
            </div>
          </div>

          {/* Topic Focus Tags */}
          <div className="circleTopicPills">
            <span className="circleTopicLabel">Topics:</span>
            {community.tags.map((tag) => (
              <span key={tag} className="circlePillTag">
                #{tag}
              </span>
            ))}
          </div>
        </section>

        {/* 2-Column Content Layout */}
        <div className="circleTwoColLayout">
          {/* Main Feed Column */}
          <div className="circleFeedCol">
            {/* Live Discussions Section */}
            <section className="circleSectionCard">
              <div className="circleSectionHeading">
                <div>
                  <span className="circleKicker">Live Signal</span>
                  <h2>Recent Circle Discussions</h2>
                </div>
                <span className="circleThreadCount">
                  {community.recentTopics.length} active threads
                </span>
              </div>

              <div className="circleThreadsList">
                {community.recentTopics.map((topic, idx) => (
                  <article key={idx} className="circleThreadCard">
                    <div className="threadAvatar">
                      {topic.author.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                    </div>
                    <div className="threadContent">
                      <h3 className="threadTitle">{topic.title}</h3>
                      <div className="threadMetaRow">
                        <span className="threadAuthor">{topic.author}</span>
                        <span className="threadDot">•</span>
                        <span className="threadTime">{topic.time}</span>
                      </div>
                    </div>
                    <div className="threadRepliesBadge">
                      <ChatBubbleIcon />
                      <span>{topic.replies}</span>
                    </div>
                  </article>
                ))}
              </div>
            </section>

            {/* Upcoming Sessions Section */}
            <section className="circleSectionCard">
              <div className="circleSectionHeading">
                <div>
                  <span className="circleKicker">Schedule</span>
                  <h2>Upcoming Live Sessions</h2>
                </div>
              </div>

              <div className="circleEventsList">
                {community.upcomingEvents.map((evt, idx) => (
                  <div key={idx} className="circleEventRow">
                    <div className="eventCalendarTile">
                      <span className="eventCalMonth">{evt.date.split(" ")[1] || "SEP"}</span>
                      <span className="eventCalDay">{evt.date.split(" ")[2] || "24"}</span>
                    </div>
                    <div className="eventInfo">
                      <h3 className="eventHeading">{evt.title}</h3>
                      <div className="eventDetailsMeta">
                        <span>
                          <ClockIcon /> {evt.time}
                        </span>
                        <span className="eventFormatTag">
                          {evt.format}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Operating Norms */}
            <section className="circleSectionCard">
              <div className="circleSectionHeading">
                <div>
                  <span className="circleKicker">Culture</span>
                  <h2>Operating Norms</h2>
                </div>
              </div>

              <div className="circleNormsRow">
                <div className="normBlock">
                  <h4>High Signal Only</h4>
                  <p>Peer teardowns, real customer GTM metrics, and technical problem-solving without sales pitches.</p>
                </div>
                <div className="normBlock">
                  <h4>Strict Confidentiality</h4>
                  <p>Private discussion topics, unreleased roadmaps, and sprint feedback remain inside this circle.</p>
                </div>
                <div className="normBlock">
                  <h4>Follow-Through</h4>
                  <p>Action items and verified benchmarks flow directly into your connected Spark execution boards.</p>
                </div>
              </div>
            </section>
          </div>

          {/* Sidebar Column */}
          <aside className="circleAsideCol">
            {/* Host Profile */}
            <div className="circleSidebarPanel">
              <span className="circleKicker">Facilitator</span>
              <div className="hostCompactRow">
                <div className="hostAvatarBox">
                  {community.host.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                </div>
                <div>
                  <div className="hostNameVerified">
                    <strong>{community.host.name}</strong>
                    <VerifiedBadgeIcon />
                  </div>
                  <span className="hostRoleText">{community.host.role}</span>
                </div>
              </div>
              <p className="hostSummary">
                Organizes peer sessions, vets new member applications, and facilitates weekly sprint accountability.
              </p>
            </div>

            {/* Circle Logistics */}
            <div className="circleSidebarPanel">
              <span className="circleKicker">Circle Logistics</span>
              <ul className="logisticsList">
                <li>
                  <span>Access Model</span>
                  <strong>Open / Free</strong>
                </li>
                <li>
                  <span>Format</span>
                  <strong>Async Chat + Live Syncs</strong>
                </li>
                <li>
                  <span>Location</span>
                  <strong>{community.location}</strong>
                </li>
                <li>
                  <span>Target Stage</span>
                  <strong>{community.stage}</strong>
                </li>
                <li>
                  <span>Workspace Sync</span>
                  <strong>Spark Outbox Enabled</strong>
                </li>
              </ul>
            </div>

            {/* Related Circles */}
            {relatedCommunities.length > 0 && (
              <div className="circleSidebarPanel">
                <span className="circleKicker">Explore Other Circles</span>
                <div className="relatedCirclesGrid">
                  {relatedCommunities.map((rel) => (
                    <Link key={rel.slug} href={`/communities/${rel.slug}`} className="relatedCircleRow">
                      <div className="relatedInitials" style={{ background: rel.gradient }}>
                        {rel.initials}
                      </div>
                      <div className="relatedText">
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
      </div>

      {/* Footer */}
      <footer className="sparkFooter">
        <div className="footerInner">
          <div className="footerGrid">
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

          <div className="footerBottom">
            <p className="footerCopyright">
              &copy; {new Date().getFullYear()} Spark Technologies, Inc. Built for high-velocity teams.
            </p>
          </div>
        </div>
      </footer>
    </main>
  );
}


