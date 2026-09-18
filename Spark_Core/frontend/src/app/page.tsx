"use client";

import Link from "next/link";
import type { CSSProperties } from "react";

import { useAuth } from "./auth-context";
import { HeroParticles } from "./hero-particles";
import { SignalParticles } from "./signal-particles";
import { SparkWordmarkReveal } from "./spark-wordmark-reveal";
import { LiveSignalFlow } from "./live-signal-flow";
import { PathwayShowcase } from "./pathway-showcase";
import { ProductShowcase } from "./product-showcase";


function SparkMark() {
  return <svg aria-hidden="true" className="sparkMark" viewBox="0 0 48 48"><path className="sparkBolt" d="M27 2 8 27h13l-2 19 21-27H27z" /></svg>;
}

function PointerClickIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 3l7.07 16.97 2.51-7.39 7.39-2.51L4 3z" />
      <path d="M13 13l6 6" />
    </svg>
  );
}

function ComputerIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

function PlayVideoIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  );
}

const heroHeadline = "Turn scattered work into forward motion.";

function HeroTypingHeadline() {
  let characterIndex = 0;

  return <h1 className="sparkTypingHeadline" aria-label={heroHeadline}>
    {heroHeadline.split(" ").map((word, wordIndex) => <span className="heroTypingWord" aria-hidden="true" key={`${word}-${wordIndex}`}>
      {Array.from(word).map((character) => {
        const index = characterIndex++;
        return <span className={wordIndex >= 4 ? "heroTypingCharacter heroTypingAccent" : "heroTypingCharacter"} key={`${character}-${index}`} style={{ "--character-index": index } as CSSProperties}>{character}</span>;
      })}
    </span>)}
  </h1>;
}

function RadarIcons() {
  return (
    <div className="radarSpokeRing" aria-hidden="true">
      {/* Line 1 (18deg) - End A: Hub (18deg) */}
      <div className="radarSpoke spoke-18">
        <span className="radarNode" title="Device Hub">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2.5" /><circle cx="5" cy="18" r="2.5" /><circle cx="19" cy="18" r="2.5" /><path d="M12 7.5v5M12 12.5l-5 3.5M12 12.5l5 3.5" /></svg>
        </span>
      </div>

      {/* Line 2 (78deg) - End A: Dashboard (78deg) */}
      <div className="radarSpoke spoke-78">
        <span className="radarNode" title="Dashboard Customize">
          <svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><path d="M17.5 14v7M14 17.5h7" /></svg>
        </span>
      </div>

      {/* Line 3 (138deg) - End A: Deployed Code (138deg) */}
      <div className="radarSpoke spoke-138">
        <span className="radarNode" title="Deployed Code">
          <svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /><line x1="10" y1="19" x2="14" y2="5" /></svg>
        </span>
      </div>

      {/* Line 1 (18deg) - End B: Folder (198deg = 18deg + 180deg) */}
      <div className="radarSpoke spoke-198">
        <span className="radarNode" title="Workspace Folder">
          <svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
        </span>
      </div>

      {/* Line 2 (78deg) - End B: Security / Guard Shield (258deg = 78deg + 180deg) */}
      <div className="radarSpoke spoke-258">
        <span className="radarNode" title="Security & Governance">
          <svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></svg>
        </span>
      </div>

      {/* Line 3 (138deg) - End B: Search Spark (318deg = 138deg + 180deg) */}
      <div className="radarSpoke spoke-318">
        <span className="radarNode" title="Search Spark">
          <svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5L21 21M9 7l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" /></svg>
        </span>
      </div>
    </div>
  );
}

export default function HomePage() {
  const { isAuthenticated } = useAuth();
  const workspaceTarget = isAuthenticated ? "/workspace" : "/login?redirect=/workspace";

  return <main className="sparkLanding">
    {/* Global Background Signal Particles */}
    <SignalParticles />

    <a className="skipLink" href="#main-content">Skip to content</a>
    <header className="sparkHeader">
      <Link className="sparkBrand" href="/" aria-label="Spark home"><SparkMark /><span>Spark</span></Link>
      <nav aria-label="Main navigation"><a href="#product">Product</a><a href="#pathways">Pathways</a><a href="#workflow">Workflow</a><Link href="/pricing">Pricing</Link><Link href="/communities">Community</Link></nav>
      <div className="headerActions">
        {isAuthenticated ? (
          <Link className="sparkNavButton" href="/workspace">Workspace <PointerClickIcon /></Link>
        ) : (
          <>
            <Link href="/login">Sign in</Link>
            <Link className="sparkNavButton" href="/signup?redirect=/workspace">Start free <PointerClickIcon /></Link>
          </>
        )}
      </div>
    </header>

    <section className="sparkHero" id="main-content">
      <HeroParticles />
      <div className="heroGlow" aria-hidden="true" />
      <div className="sparkHeroInner">
        <div className="sparkHeroCopy">
          <p className="sparkKicker heroKicker"><span className="heroKickerBrand" aria-label="Spark"><SparkMark /><span aria-hidden="true">Spark</span></span><span className="heroKickerLabel">Built for startup teams</span></p>
          <HeroTypingHeadline />
          <p className="sparkLead">Spark brings your startup community, member work, and shared schedule into one focused workspace, so every conversation has a clear next step.</p>
          <div className="sparkActions">
            <Link className="sparkPrimary" href={workspaceTarget}>Open your workspace <ComputerIcon /></Link>
            <a className="sparkSecondary" href="#product"><PlayVideoIcon /> See how it works</a>
          </div>
          <div className="heroProof" aria-label="Product highlights"><span><b>01</b> One shared view</span><span><b>02</b> Clear ownership</span><span><b>03</b> Less status chasing</span></div>
        </div>

        <aside className="sparkPreview" aria-label="Spark workspace preview">
          <div className="previewRail"><span className="previewRailLogo"><SparkMark /></span><span className="railActive" /><span /><span /><span /><i>ML</i></div>
          <div className="previewBody">
            <div className="previewTop"><div><small>Northstar / Product</small><strong>Launch workspace</strong></div><button type="button" aria-label="More workspace options">•••</button></div>
            <div className="previewStats"><div><span>Weekly progress</span><strong>68%</strong></div><div className="previewProgress"><i /></div></div>
            <div className="previewColumns">
              <section><header><span>To do</span><b>3</b></header><article><span className="previewTag blue">Product</span><strong>Finalize onboarding flow</strong><footer><i>DK</i><small>Today</small></footer></article><article><span className="previewTag orange">Growth</span><strong>Share launch update</strong><footer><i>ML</i><small>Fri</small></footer></article></section>
              <section><header><span>In progress</span><b>2</b></header><article><span className="previewTag green">Research</span><strong>Founder interviews</strong><footer><i>HN</i><small>2 days</small></footer></article><article className="previewNote"><small>Next community session</small><strong>Product Circle · 14:00</strong></article></section>
            </div>
          </div>
        </aside>
      </div>
    </section>

    <SparkWordmarkReveal>
      <div className="sparkRevealField" aria-hidden="true"><i /><i /><i /></div>
      <RadarIcons />
      <div className="sparkWordmarkLockup"><SparkMark /><span aria-hidden="true">Spark</span></div>
    </SparkWordmarkReveal>
    <section className="sparkSignal" aria-label="Spark capabilities"><p>One calm operating system for</p><div><span>Startup communities</span><span>Product teams</span><span>Founder networks</span><span>Accelerators</span></div></section>

    <LiveSignalFlow />

    <PathwayShowcase />

    <ProductShowcase />

    <section className="workflowSection" id="workflow">
      <div className="workflowHeader">
        <p className="sparkKicker"><span />A lighter workflow</p>
        <h2>From signal to done, without losing context.</h2>
        <p className="workflowSubtitle">Every step stays connected to the people and decisions behind it.</p>
      </div>
      <div className="workflowStepsGrid">
        <article className="workflowStepCard">
          <span className="workflowStepBadge">01</span>
          <h3>Bring your circle together</h3>
          <p>Create a focused space for a startup, cohort, or working group.</p>
        </article>
        <article className="workflowStepCard">
          <span className="workflowStepBadge">02</span>
          <h3>Shape the work</h3>
          <p>Turn conversations into owned tasks, milestones, and scheduled moments.</p>
        </article>
        <article className="workflowStepCard">
          <span className="workflowStepBadge">03</span>
          <h3>Keep the signal clear</h3>
          <p>Receive useful updates without another noisy stream demanding attention.</p>
        </article>
      </div>
    </section>

    {/* High-Impact CTA Banner */}
    <section className="sparkCtaSection" aria-labelledby="cta-heading">
      <div className="ctaBackgroundGlow" aria-hidden="true" />
      <div className="sparkCtaCard">
        <div className="ctaRadarField" aria-hidden="true">
          <span className="ctaRadarRing ctaRadarRing1" />
          <span className="ctaRadarRing ctaRadarRing2" />
        </div>
        <div className="sparkCtaContent">
          <div className="sparkKicker ctaKicker">
            <span className="ctaPulseDot" />
            Ready when you are
          </div>
          <h2 id="cta-heading">Give your team one clear place to move forward.</h2>
          <p className="ctaDescription">
            Join founders and builders using Spark to turn community conversations into owned tasks, scheduled moments, and real delivery momentum.
          </p>
          <div className="ctaActions">
            <Link className="ctaPrimaryBtn" href={workspaceTarget}>
              Start with Spark <ComputerIcon />
            </Link>
            <Link className="ctaSecondaryBtn" href="/communities">
              Explore communities
            </Link>
          </div>
          <div className="ctaTrustRow">
            <span>✓ Free for core teams</span>
            <span>✓ No credit card required</span>
            <span>✓ Setup in under 2 minutes</span>
          </div>
        </div>
      </div>
    </section>

    {/* Enterprise-Grade Multi-Column Footer */}
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
              <li><a href="#product">Product Architecture</a></li>
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
              <li><a href="#pathways">Pathway Choices</a></li>
            </ul>
          </div>

          {/* Column 3: Trust & Legal */}
          <div className="footerCol">
            <h4 className="footerColTitle">Trust & Resources</h4>
            <ul className="footerLinksList">
              <li><a href="#workflow">Workflow Guide</a></li>
              <li><Link href="/pricing">Pricing & Plans</Link></li>
              <li><a href="#main-content">Privacy Policy</a></li>
              <li><a href="#main-content">Terms of Service</a></li>
              <li><a href="#main-content">Security & RLS</a></li>
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
  </main>;
}
