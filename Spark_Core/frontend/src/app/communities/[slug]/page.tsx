import Link from "next/link";
import { notFound } from "next/navigation";
import { communities } from "../mock-data";

export default async function CommunityDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const community = communities.find((entry) => entry.slug === slug);
  if (!community) notFound();

  return <main className="communityDetail">
    <header className="communityHeader"><Link className="communityBrand" href="/">Spark</Link><nav aria-label="Main navigation"><Link href="/">Home</Link><Link href="/communities">Communities</Link><Link href="/workspace">Workspace</Link></nav></header>
    <section className="communityProfile"><Link className="backLink" href="/communities">← All communities</Link><div className="communityProfileTop"><div className="communityMonogram">{community.initials}</div><div><p className="communityEyebrow">{community.topic}</p><h1>{community.name}</h1><p>{community.description}</p></div></div><div className="communityProfileActions"><button type="button">Request access</button><small>Prototype only — requests are not sent yet.</small></div></section>
    <section className="communityDetailGrid"><article><p className="communityEyebrow">Community focus</p><h2>Small rooms, useful context, real follow-through.</h2><p>Members use this space to exchange practical feedback, find relevant peers, and prepare for the next decision.</p><div className="communitySignals"><span>{community.location}</span><span>{community.stage}</span><span>{community.members}</span></div></article><aside><p className="communityEyebrow">This week</p><h2>{community.activity}</h2><p>Example activity preview for the mockup. Live posts and membership workflows come after the interaction model is approved.</p></aside></section>
  </main>;
}
