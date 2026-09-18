"use client";

import Link from "next/link";
import { useState } from "react";
import { useAuth } from "../auth-context";
import { SignalParticles } from "../signal-particles";

function SparkMark() {
  return (
    <svg aria-hidden="true" className="sparkMark" viewBox="0 0 48 48">
      <path className="sparkBolt" d="M27 2 8 27h13l-2 19 21-27H27z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="checkIcon" viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function TableCheckIcon() {
  return (
    <span className="compareValCheck" aria-label="Included">
      <svg viewBox="0 0 20 20" fill="currentColor">
        <path
          fillRule="evenodd"
          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
          clipRule="evenodd"
        />
      </svg>
    </span>
  );
}

function TableDash() {
  return <span className="compareValDash" aria-label="Not included">—</span>;
}

function PointerClickIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 3l7.07 16.97 2.51-7.39 7.39-2.51L4 3z" />
      <path d="M13 13l6 6" />
    </svg>
  );
}

export default function PricingPage() {
  const { isAuthenticated } = useAuth();
  const [isAnnual, setIsAnnual] = useState(true);

  const plans = [
    {
      id: "starter",
      name: "Starter",
      description: "For early founding teams and small circles getting their initial operating cadence in place.",
      monthlyPrice: 0,
      annualPrice: 0,
      isPopular: false,
      ctaText: "Start free",
      ctaHref: "/signup?redirect=/workspace",
      features: [
        "Up to 10 workspace members",
        "1 Public or private community circle",
        "3 Agile Kanban project boards",
        "Basic calendar and member schedule",
        "Real-time signal notifications",
        "Standard community support",
      ],
    },
    {
      id: "growth",
      name: "Growth",
      description: "For fast-moving startups and active networks that need multi-circle collaboration and sprint tools.",
      monthlyPrice: 29,
      annualPrice: 24,
      isPopular: true,
      ctaText: "Start 14-day free trial",
      ctaHref: "/signup?plan=growth&redirect=/workspace",
      features: [
        "Up to 50 workspace members",
        "Unlimited community circles & sub-rooms",
        "Unlimited project boards & sprint management",
        "Custom community moderation & queue filters",
        "Automated event reminders & attendee tracking",
        "Exportable board analytics & CSV reports",
        "Priority founder circle support",
      ],
    },
    {
      id: "scale",
      name: "Scale & Network",
      description: "For startup accelerators, venture studios, and regional ecosystem hubs managing multiple cohorts.",
      monthlyPrice: 99,
      annualPrice: 79,
      isPopular: false,
      ctaText: "Start Scale trial",
      ctaHref: "/signup?plan=scale&redirect=/workspace",
      features: [
        "Unlimited workspace members & guest seats",
        "Multi-community cross-network governance",
        "Sponsored promotion placement & banner tools",
        "Enterprise SSO (Google, GitHub, SAML)",
        "Audit log retention & RLS compliance reports",
        "Dedicated onboarding manager & SLA guarantee",
        "Custom contract & invoice billing",
      ],
    },
  ];

  const comparisonCategories = [
    {
      name: "Workspace & Collaboration",
      features: [
        {
          name: "Workspace Members",
          detail: "Active team members with workspace access",
          starter: "Up to 10",
          growth: "Up to 50",
          scale: "Unlimited",
        },
        {
          name: "Kanban Project Boards",
          detail: "Interactive boards with customizable WIP limits",
          starter: "3 Boards",
          growth: "Unlimited",
          scale: "Unlimited",
        },
        {
          name: "Sprint & Issue Management",
          detail: "Backlog grooming, sprints, issue events history",
          starter: "Basic",
          growth: "Full Sprint Suite",
          scale: "Multi-team Sprints",
        },
        {
          name: "Calendar & Schedule Timeline",
          detail: "Shared member schedule and milestone dates",
          starter: "Basic",
          growth: "Advanced + Reminders",
          scale: "Custom Integrations",
        },
        {
          name: "Signal Notifications",
          detail: "Transactional outbox event notifications",
          starter: <TableCheckIcon />,
          growth: <TableCheckIcon />,
          scale: <TableCheckIcon />,
        },
      ],
    },
    {
      name: "Community & Network Discovery",
      features: [
        {
          name: "Community Circles",
          detail: "Public or private spaces for founder discussions",
          starter: "1 Circle",
          growth: "Unlimited Circles",
          scale: "Unlimited Networks",
        },
        {
          name: "Private Sub-Rooms",
          detail: "Restricted discussion channels for vetted members",
          starter: <TableDash />,
          growth: <TableCheckIcon />,
          scale: <TableCheckIcon />,
        },
        {
          name: "Startup Discovery Directory",
          detail: "Opt-in profiles visible across the ecosystem",
          starter: "Public listing",
          growth: "Featured Badge",
          scale: "Priority Placement",
        },
        {
          name: "Sponsored Campaign Manager",
          detail: "Submit paid banners and hackathon showcases",
          starter: <TableDash />,
          growth: "Self-serve ads",
          scale: "Multi-placement Suite",
        },
      ],
    },
    {
      name: "Platform Governance & Moderation",
      features: [
        {
          name: "Content Reporting Queue",
          detail: "Review flagged posts with hidden reporter identity",
          starter: "Standard Queue",
          growth: "Custom Rules Queue",
          scale: "Platform Console",
        },
        {
          name: "Role Delegation (RBAC)",
          detail: "Granular roles for community & content moderators",
          starter: <TableDash />,
          growth: "3 Moderator Seats",
          scale: "Custom Platform Roles",
        },
        {
          name: "Audit Trail & Activity Log",
          detail: "Tamper-evident log of moderation & state changes",
          starter: "7 Days",
          growth: "90 Days",
          scale: "Permanent Archive",
        },
      ],
    },
    {
      name: "Security, SSO & Compliance",
      features: [
        {
          name: "Authentication Methods",
          detail: "Argon2id passwords and 32-byte opaque sessions",
          starter: "Password + OAuth",
          growth: "Password + OAuth",
          scale: "Enterprise SSO (SAML/Okta)",
        },
        {
          name: "Row-Level Security (RLS)",
          detail: "Database-enforced isolation across workspaces",
          starter: <TableCheckIcon />,
          growth: <TableCheckIcon />,
          scale: <TableCheckIcon />,
        },
        {
          name: "Support SLA",
          detail: "Response time and dedicated technical onboarding",
          starter: "Community / Forum",
          growth: "Priority Email (24h)",
          scale: "Dedicated CSM (1h SLA)",
        },
        {
          name: "Invoice & Wire Billing",
          detail: "Custom invoices and corporate payment terms",
          starter: <TableDash />,
          growth: <TableDash />,
          scale: <TableCheckIcon />,
        },
      ],
    },
  ];

  return (
    <main className="sparkLanding pricingPageRoot">
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
          <Link aria-current="page" href="/pricing" style={{ color: "var(--landing-blue)" }}>
            Pricing
          </Link>
          <Link href="/communities">Community</Link>
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
      <section className="pricingHero">
        <div className="authHeroGlow1" aria-hidden="true" />
        <div className="authHeroGlow2" aria-hidden="true" />

        <div className="pricingHeroInner">
          <p className="sparkKicker" style={{ justifyContent: "center" }}>
            <span></span>
            Simple, Transparent Pricing
          </p>
          <h1>Predictable plans for startups, circles, and networks</h1>
          <p className="pricingLead">
            Start free with your core founding team. Scale communities, private rooms, and sprint
            boards as your company grows.
          </p>

          {/* Billing Switcher */}
          <div className="billingToggleWrapper" role="radiogroup" aria-label="Billing frequency">
            <button
              type="button"
              className={`billingToggleBtn ${!isAnnual ? "active" : ""}`}
              onClick={() => setIsAnnual(false)}
            >
              Monthly billing
            </button>
            <button
              type="button"
              className={`billingToggleBtn ${isAnnual ? "active" : ""}`}
              onClick={() => setIsAnnual(true)}
            >
              Annual billing
              <span className="discountPill">Save 20%</span>
            </button>
          </div>
        </div>
      </section>

      {/* Pricing Cards Grid */}
      <section className="pricingCardsContainer" aria-label="Pricing plans">
        {plans.map((plan) => {
          const price = isAnnual ? plan.annualPrice : plan.monthlyPrice;
          return (
            <article
              key={plan.id}
              className={`pricingCard ${plan.isPopular ? "popular" : ""}`}
            >
              {plan.isPopular && <span className="popularBadge">Most Popular</span>}

              <h2 className="planName">{plan.name}</h2>
              <p className="planDescription">{plan.description}</p>

              <div className="priceWrapper">
                <span className="priceCurrency">$</span>
                <span className="priceAmount">{price}</span>
                <span className="pricePeriod">/ month</span>
              </div>
              <p className="priceSubnote">
                {price === 0
                  ? "Free forever for small teams"
                  : isAnnual
                    ? `Billed annually ($${price * 12}/year)`
                    : "Billed monthly, cancel anytime"}
              </p>

              <div className="planDivider" />

              <p className="planFeatureTitle">What&apos;s included</p>
              <ul className="planFeaturesList">
                {plan.features.map((feat, idx) => (
                  <li key={idx}>
                    <CheckIcon />
                    <span>{feat}</span>
                  </li>
                ))}
              </ul>

              <Link
                href={plan.ctaHref}
                className={`planActionBtn ${plan.isPopular ? "primary" : "secondary"}`}
              >
                {plan.ctaText}
              </Link>
            </article>
          );
        })}
      </section>

      {/* Feature Comparison Matrix Table */}
      <section className="pricingComparisonSection" aria-labelledby="pricing-compare-title">
        <div className="pricingComparisonHeader">
          <p className="sparkKicker" style={{ justifyContent: "center" }}>
            <span></span>
            Feature Breakdown
          </p>
          <h2 id="pricing-compare-title">Compare all features & capabilities</h2>
          <p>
            Detailed breakdown of what is included in each tier, from early stage exploration to
            ecosystem-scale operations.
          </p>
        </div>

        <div className="comparisonTableWrapper">
          <table className="comparisonTable">
            <thead>
              <tr>
                <th className="featureColHeader">Plan Features</th>
                <th className="planColHeader">Starter ($0)</th>
                <th className="planColHeader popularColHeader">Growth ($24/mo)</th>
                <th className="planColHeader">Scale ($79/mo)</th>
              </tr>
            </thead>
            <tbody>
              {comparisonCategories.map((category, catIdx) => (
                <tr key={catIdx} className="comparisonCategoryRow">
                  <td colSpan={4}>{category.name}</td>
                </tr>
              )).reduce<(React.ReactNode)[]>((acc, categoryRow, catIdx) => {
                const category = comparisonCategories[catIdx]!;
                acc.push(categoryRow);
                category.features.forEach((feat, featIdx) => {
                  acc.push(
                    <tr key={`feat-${catIdx}-${featIdx}`} className="comparisonFeatureRow">
                      <td className="featureNameCell">
                        {feat.name}
                        <small>{feat.detail}</small>
                      </td>
                      <td className="planValCell">{feat.starter}</td>
                      <td className="planValCell popularValCell">{feat.growth}</td>
                      <td className="planValCell">{feat.scale}</td>
                    </tr>
                  );
                });
                return acc;
              }, [])}
            </tbody>
          </table>
        </div>
      </section>

      {/* High-Impact Bottom Conversion Section */}
      <section className="sparkCtaSection" aria-labelledby="pricing-cta-heading">
        <div className="ctaBackgroundGlow" aria-hidden="true" />
        <div className="sparkCtaCard">
          <div className="ctaRadarField" aria-hidden="true">
            <span className="ctaRadarRing ctaRadarRing1" />
            <span className="ctaRadarRing ctaRadarRing2" />
          </div>
          <div className="sparkCtaContent">
            <div className="sparkKicker ctaKicker">
              <span className="ctaPulseDot" />
              Get started today
            </div>
            <h2 id="pricing-cta-heading">Ready to bring clarity to your startup workflow?</h2>
            <p className="ctaDescription">
              Join hundreds of founders and startup circles who use Spark every day to organize work,
              schedule releases, and build together.
            </p>
            <div className="ctaActions">
              <Link className="ctaPrimaryBtn" href={isAuthenticated ? "/workspace" : "/signup?redirect=/workspace"}>
                Start your free workspace <PointerClickIcon />
              </Link>
              <Link className="ctaSecondaryBtn" href="/communities">
                Explore communities
              </Link>
            </div>
            <div className="ctaTrustRow">
              <span>✓ Free 14-day trial on paid tiers</span>
              <span>✓ No credit card required for Starter</span>
              <span>✓ Instant workspace setup</span>
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
