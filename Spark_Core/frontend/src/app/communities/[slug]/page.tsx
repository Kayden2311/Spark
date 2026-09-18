import Link from "next/link";
import { notFound } from "next/navigation";
import { HeroParticles } from "../../hero-particles";
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
      {/* Global Background Particles */}
      <HeroParticles fixed />

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
            </div>
            <div className="footerCol">
              <h4 className="footerColTitle">Product</h4>
              <ul className="footerLinksList">
                <li><Link href="/#product">Features</Link></li>
                <li><Link href="/#pathways">Pathways</Link></li>
                <li><Link href="/pricing">Pricing & Plans</Link></li>
              </ul>
            </div>
            <div className="footerCol">
              <h4 className="footerColTitle">Ecosystem</h4>
              <ul className="footerLinksList">
                <li><Link href="/communities">Community Circles</Link></li>
                <li><Link href="/workspace">Workspace App</Link></li>
                <li><Link href="/schedule">Events & Calendar</Link></li>
              </ul>
            </div>
            <div className="footerCol">
              <h4 className="footerColTitle">Trust</h4>
              <ul className="footerLinksList">
                <li><Link href="/admin">Platform Moderation</Link></li>
                <li><Link href="/pricing">Security & RLS</Link></li>
              </ul>
            </div>
          </div>
          <div className="footerBottom">
            <p className="footerCopyright">
              © {new Date().getFullYear()} Spark Inc. All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </main>
  );
}
