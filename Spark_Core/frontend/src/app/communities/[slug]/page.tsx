import { notFound } from "next/navigation";
import { serverGet } from "../../_lib/server-api";
import { CommunityView } from "./community-view";

// The C1 slug rule: anything else cannot name a community, so there is nothing to ask the API.
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/u;

/**
 * Resolves the community on the server so a hidden or unknown slug answers a real HTTP 404. Any other failure
 * renders the client view, which shows its own error state, so a brief API blip never becomes a 404.
 */
export default async function CommunityPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!SLUG.test(slug)) notFound();
  const result = await serverGet(`/api/v1/communities/${encodeURIComponent(slug)}`);
  if (result.status === 404) notFound();
  return <CommunityView slug={slug} />;
}
