import { CommunityView } from "./community-view";

export default async function CommunityPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <CommunityView slug={slug} />;
}
