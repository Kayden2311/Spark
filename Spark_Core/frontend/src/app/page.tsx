"use client";

import Link from "next/link";
import { type PointerEvent, useRef } from "react";

const particles = Array.from({ length: 252 }, (_, index) => { const column = index % 18; const row = Math.floor(index / 18); return [4 + column * 5.35 + ((row * 3 + column * 5) % 5 - 2) * 0.55, 5 + row * 6.9 + ((row * 7 + column * 2) % 5 - 2) * 0.55] as const; });

function SparkMark() {
  return <svg aria-hidden="true" className="sparkMark" viewBox="0 0 48 48"><path className="sparkBolt" d="M27 2 8 27h13l-2 19 21-27H27z" /></svg>;
}

export default function HomePage() {
  const particleRefs = useRef<(HTMLElement | null)[]>([]);
  const resetParticles = () => particleRefs.current.forEach((particle) => particle?.style.removeProperty("transform"));
  const trackParticles = (event: PointerEvent<HTMLElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;
    event.currentTarget.style.setProperty("--cursor-x", `${x * 100}%`);
    event.currentTarget.style.setProperty("--cursor-y", `${y * 100}%`);
    particles.forEach(([particleX, particleY], index) => {
      const particle = particleRefs.current[index];
      if (!particle) return;
      const dx = particleX / 100 - x;
      const dy = particleY / 100 - y;
      const distance = Math.hypot(dx, dy);
      const strength = Math.max(0.08, 1 - distance / 0.42);
      const scale = 1 + strength * 1.4;
      const push = strength * 70;
      particle.style.transform = `translate(${dx / (distance || 1) * push}px, ${dy / (distance || 1) * push}px) scale(${scale})`;
    });
  };
  return <main className="sparkLanding">
    <header className="sparkHeader">
      <Link className="sparkBrand" href="/"><SparkMark /><span>Spark</span></Link>
      <nav aria-label="Main navigation"><a href="#how-it-works">How it works</a><a href="#teams">For teams</a><Link className="sparkNavButton" href="/workspace">Open workspace ↗</Link></nav>
    </header>

    <section className="sparkHero" onPointerMove={trackParticles} onPointerLeave={resetParticles}>
      <div className="particleField" aria-hidden="true">{particles.map(([x, y], index) => <i key={`${x}-${y}`} ref={(element) => { particleRefs.current[index] = element; }} style={{ left: `${x}%`, top: `${y}%` }} />)}</div>
      <div className="sparkHeroCopy"><p className="sparkKicker"><span />Built for teams in motion</p><h1>Make the work<br /><span className="heroAccent">feel lighter.</span></h1><p className="sparkLead">Spark brings your startup community, work board, and next decision into one calm, focused place.</p><div className="sparkActions"><Link className="sparkPrimary" href="/workspace">See your workspace <span>→</span></Link><a className="sparkSecondary" href="#teams">Take a quick tour <span>↓</span></a></div></div>
      <aside className="sparkPreview" aria-label="Workspace preview"><div className="previewTop"><span className="previewLogo"><SparkMark /></span><div><strong>Northstar</strong><small>Product launch</small></div><span className="previewMore">•••</span></div><div className="previewMeta"><span>This week</span><strong>06 tasks in motion</strong><b>58%</b></div><div className="previewProgress"><i /></div><div className="previewColumns"><section><header>To do <b>2</b></header><article><span className="previewTag orange">Growth</span><strong>Share demo with HN Founders</strong><footer><i>ML</i><small>Fri</small></footer></article><article><span className="previewTag blue">Product</span><strong>Outline onboarding emails</strong><footer><i>DK</i><small>Next week</small></footer></article></section><section><header>In progress <b>2</b></header><article><span className="previewTag green">Research</span><strong>Refine investor update</strong><footer><i>ML</i><small>Today</small></footer></article><article className="faded"><strong>Set up customer calls</strong></article></section></div></aside>
    </section>

    <section className="sparkStrip" id="how-it-works"><p><span className="stripBolt">↯</span> One place for the people and the work that matters</p><div><span>01</span><strong>Find your circle</strong><span>02</span><strong>Plan the work</strong><span>03</span><strong>Keep momentum</strong></div></section>

    <section className="sparkTeams" id="teams"><p className="sparkKicker"><span />The everyday operating system</p><div className="teamsHeading"><h2>Clear enough for the team.<br />Quiet enough to think.</h2><p>Projects, schedules and community signals live together, so work does not disappear between tools.</p></div><div className="sparkFeatureGrid"><article><span className="featureIcon">▦</span><h3>Work that stays visible</h3><p>A practical board for what needs attention today, this week, and later.</p><Link href="/workspace">Explore the board →</Link></article><article><span className="featureIcon">◷</span><h3>Time with a purpose</h3><p>See customer calls, member sessions, and team moments in one schedule.</p><Link href="/schedule">Open schedule →</Link></article><article><span className="featureIcon">✦</span><h3>Signal, not noise</h3><p>Keep important decisions close without a stream of busywork.</p><Link href="/notifications">View notifications →</Link></article></div></section>

    <footer className="sparkFooter"><Link className="sparkBrand" href="/"><SparkMark /><span>Spark</span></Link><p>Startup work, with more signal.</p><Link href="/workspace">Enter workspace ↗</Link></footer>
  </main>;
}