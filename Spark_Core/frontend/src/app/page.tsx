import Link from "next/link";

import { HeroParticles } from "./hero-particles";

function SparkMark() {
  return <svg aria-hidden="true" className="sparkMark" viewBox="0 0 48 48"><path className="sparkBolt" d="M27 2 8 27h13l-2 19 21-27H27z" /></svg>;
}

function ArrowIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M4 10h11m-4-4 4 4-4 4" /></svg>;
}

function FeatureIcon({ type }: { type: "people" | "board" | "calendar" }) {
  const paths = {
    people: <><circle cx="8" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M2.5 21c.5-4 2.3-6 5.5-6s5 2 5.5 6M14 16c3.7-.4 6 1.3 6.5 5" /></>,
    board: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18M15 3v18M5.5 7h1M11.5 9h1M17.5 6h1" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4M17 3v4M3 10h18M7 14h3M14 14h3M7 17h3" /></>,
  };
  return <svg aria-hidden="true" className="featureIcon" viewBox="0 0 24 24">{paths[type]}</svg>;
}

export default function HomePage() {
  return <main className="sparkLanding">
    <a className="skipLink" href="#main-content">Skip to content</a>
    <header className="sparkHeader">
      <Link className="sparkBrand" href="/" aria-label="Spark home"><SparkMark /><span>Spark</span></Link>
      <nav aria-label="Main navigation"><a href="#product">Product</a><a href="#workflow">Workflow</a><Link href="/communities">Community</Link></nav>
      <div className="headerActions"><Link href="/workspace">Sign in</Link><Link className="sparkNavButton" href="/workspace">Start free <ArrowIcon /></Link></div>
    </header>

    <section className="sparkHero" id="main-content">
      <HeroParticles />
      <div className="heroGlow" aria-hidden="true" />
      <div className="sparkHeroCopy">
        <p className="sparkKicker"><span />Built for startup teams</p>
        <h1>Turn scattered work into <span>forward motion.</span></h1>
        <p className="sparkLead">Spark brings your startup community, member work, and shared schedule into one focused workspace, so every conversation has a clear next step.</p>
        <div className="sparkActions"><Link className="sparkPrimary" href="/workspace">Open your workspace <ArrowIcon /></Link><a className="sparkSecondary" href="#product">See how it works</a></div>
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
    </section>

    <section className="sparkWordmarkReveal" aria-label="Spark"><div className="sparkWordmarkLockup"><SparkMark /><span aria-hidden="true">PARK</span></div></section>
    <section className="sparkSignal" aria-label="Spark capabilities"><p>One calm operating system for</p><div><span>Startup communities</span><span>Product teams</span><span>Founder networks</span><span>Accelerators</span></div></section>

    <section className="sparkProduct" id="product">
      <div className="sectionIntro"><p className="sparkKicker"><span />Everything in context</p><h2>The people, the plan, and the next move.</h2><p>Replace fragmented updates with one place for community activity, member work, and the people who can help.</p></div>
      <div className="sparkFeatureGrid">
        <article className="featureMain" id="community"><div className="featureCopy"><FeatureIcon type="people" /><p className="featureIndex">01 / Community</p><h3>Connect the people who can unblock the work.</h3><p>Discover relevant startup communities by topic, location, or stage, then turn membership conversations into owned tasks, milestones, and community sessions.</p></div><div className="networkVisual" aria-hidden="true"><p>Founder network</p><span className="memberCard memberA"><b>ML</b><span>Mai Linh<small>Founder · Fintech</small></span></span><span className="memberCard memberB"><b>DK</b><span>Diep Khanh<small>Product · SaaS</small></span></span><span className="memberCard memberC"><b>HN</b><span>Hai Nguyen<small>Growth · Climate</small></span></span><i /><i /><i /></div></article>
        <article><FeatureIcon type="board" /><p className="featureIndex">02 / Projects</p><h3>Keep momentum visible.</h3><p>A practical Jira-like board without the ceremony. Priorities, ownership, and progress stay easy to read.</p><Link href="/workspace">Explore boards <ArrowIcon /></Link></article>
        <article><FeatureIcon type="calendar" /><p className="featureIndex">03 / Schedule</p><h3>Make time match the work.</h3><p>Coordinate meetings, community sessions, and delivery dates from the same operating view.</p><Link href="/schedule">View schedule <ArrowIcon /></Link></article>
      </div>
    </section>

    <section className="workflowSection" id="workflow">
      <div className="workflowCopy"><p className="sparkKicker"><span />A lighter workflow</p><h2>From signal to done, without losing context.</h2><p>Every step stays connected to the people and decisions behind it.</p></div>
      <ol><li><span>01</span><div><h3>Bring your circle together</h3><p>Create a focused space for a startup, cohort, or working group.</p></div></li><li><span>02</span><div><h3>Shape the work</h3><p>Turn conversations into owned tasks, milestones, and scheduled moments.</p></div></li><li><span>03</span><div><h3>Keep the signal clear</h3><p>Receive useful updates without another noisy stream demanding attention.</p></div></li></ol>
    </section>

    <section className="sparkCta"><div><p className="sparkKicker"><span />Ready when you are</p><h2>Give your team one clear place to move forward.</h2></div><Link className="sparkPrimary" href="/workspace">Start with Spark <ArrowIcon /></Link></section>
    <footer className="sparkFooter"><Link className="sparkBrand" href="/"><SparkMark /><span>Spark</span></Link><p>Startup work, with more signal.</p><div><a href="#product">Product</a><a href="#community">Community</a><Link href="/workspace">Workspace</Link></div></footer>
  </main>;
}
