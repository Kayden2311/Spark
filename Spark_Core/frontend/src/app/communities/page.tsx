import Link from "next/link";
import { communities } from "./mock-data";

export default function CommunitiesPage() {
  return <main className="communityExplorer">
    <header className="communityHeader"><Link className="communityBrand" href="/">Spark</Link><nav aria-label="Main navigation"><Link href="/">Home</Link><Link aria-current="page" href="/communities">Communities</Link><Link href="/workspace">Workspace</Link></nav></header>
    <section className="communityHero"><p className="communityEyebrow">Discovery prototype</p><h1>Find the right room for the work ahead.</h1><p>Explore focused startup communities by topic, location, and company stage.</p></section>
    <form className="communityFilters" aria-label="Community filters"><label>Search communities<input type="search" placeholder="Try product, SaaS, or climate" /></label><label>Topic<select defaultValue=""><option value="">All topics</option><option>B2B SaaS</option><option>Climate tech</option><option>Product</option></select></label><label>Location<select defaultValue=""><option value="">Any location</option><option>Ho Chi Minh City</option><option>Hanoi</option><option>Remote · Vietnam</option></select></label><label>Stage<select defaultValue=""><option value="">Any stage</option><option>Pre-seed to Seed</option><option>Seed to Series A</option></select></label></form>
    <section className="communityResults" aria-labelledby="community-results"><div><p className="communityEyebrow">Curated for builders</p><h2 id="community-results">Communities with an active practice</h2></div><p className="communityCount">3 illustrative results</p></section>
    <section className="communityGrid" aria-label="Community results">{communities.map((community) => <article className="communityCard" key={community.slug}><div className="communityMonogram">{community.initials}</div><p>{community.topic}</p><h3>{community.name}</h3><span>{community.description}</span><dl><div><dt>Where</dt><dd>{community.location}</dd></div><div><dt>Stage</dt><dd>{community.stage}</dd></div></dl><footer><small>{community.members} · {community.activity}</small><Link href={`/communities/${community.slug}`}>View community <span aria-hidden="true">→</span></Link></footer></article>)}</section>
  </main>;
}
