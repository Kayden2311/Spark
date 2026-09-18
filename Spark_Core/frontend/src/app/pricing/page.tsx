"use client";

import Link from "next/link";
import { useState } from "react";
import { useAuth } from "../auth-context";
import { HeroParticles } from "../hero-particles";

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
      periodLabel: "forever free",
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
      periodLabel: "per workspace / month",
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
      periodLabel: "per workspace / month",
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

  const faqs = [
    {
      q: "Can I upgrade or downgrade my plan at any time?",
      a: "Yes. You can switch between Starter, Growth, and Scale plans at any point from your workspace billing dashboard. Changes take effect immediately, with prorated billing applied automatically.",
    },
    {
      q: "How do community memberships affect workspace pricing?",
      a: "Only active members inside your private internal workspace count toward workspace seat limits. Ordinary members who join your public community circles do not consume workspace seats.",
    },
    {
      q: "Is there a free trial for the Growth plan?",
      a: "Yes. You can test all Growth tier capabilities free for 14 days without upfront payment. If you decide not to continue, your workspace automatically switches to the free Starter plan.",
    },
    {
      q: "What payment methods are supported?",
      a: "We support all major credit cards (Visa, Mastercard, American Express) via secure Stripe integration. Scale plans also support direct bank transfer (ACH / SEPA) and custom invoice terms.",
    },
  ];

  return (
    <main className="pricingPageRoot">
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
        <HeroParticles />
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
                {plan.ctaText} →
              </Link>
            </article>
          );
        })}
      </section>

      {/* FAQ Section */}
      <section className="pricingFAQSection" aria-labelledby="pricing-faq-title">
        <div className="pricingFAQHeader">
          <p className="sparkKicker" style={{ justifyContent: "center" }}>
            <span></span>
            Frequently Asked Questions
          </p>
          <h2 id="pricing-faq-title">Got questions? We have answers.</h2>
        </div>

        <div className="faqGrid">
          {faqs.map((faq, index) => (
            <div key={index} className="faqCard">
              <h3>{faq.q}</h3>
              <p>{faq.a}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Bottom Conversion Section */}
      <section className="pricingBottomCTA">
        <h2>Ready to bring clarity to your startup workflow?</h2>
        <p>
          Join hundreds of founders and startup circles who use Spark every day to organize work,
          schedule releases, and build together.
        </p>
        <Link className="sparkPrimary" href="/signup?redirect=/workspace">
          Start your free workspace <PointerClickIcon />
        </Link>
      </section>

      {/* Spark Footer */}
      <footer className="sparkFooter">
        <div className="sparkFooterInner">
          <div className="footerTop">
            <div className="footerColBrand">
              <Link className="sparkBrand footerBrand" href="/" aria-label="Spark home">
                <SparkMark />
                <span>Spark</span>
              </Link>
              <p className="footerTagline">
                The calm operating system for startup teams and founder circles.
              </p>
            </div>
            <div className="footerLinksGroup">
              <div className="footerCol">
                <h4>Product</h4>
                <ul>
                  <li>
                    <Link href="/workspace">Workspace Boards</Link>
                  </li>
                  <li>
                    <Link href="/communities">Community Circles</Link>
                  </li>
                  <li>
                    <Link href="/schedule">Schedule & Timeline</Link>
                  </li>
                  <li>
                    <Link href="/notifications">Signal Notifications</Link>
                  </li>
                </ul>
              </div>
              <div className="footerCol">
                <h4>Company</h4>
                <ul>
                  <li>
                    <Link href="/pricing">Pricing & Plans</Link>
                  </li>
                  <li>
                    <Link href="/communities">Browse Directory</Link>
                  </li>
                  <li>
                    <Link href="/communities">Founder Circles</Link>
                  </li>
                  <li>
                    <Link href="/login">Sign In</Link>
                  </li>
                </ul>
              </div>
            </div>
          </div>
          <div className="footerBottom">
            <p>© 2026 Spark Inc. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </main>
  );
}
