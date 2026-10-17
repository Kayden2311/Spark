import { notFound } from "next/navigation";
import { communities } from "../../mock-data";
import { RequestForm } from "./request-form";

export default async function RequestAccessPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const community = communities.find((entry) => entry.slug === slug);
  if (!community) notFound();

  return (
    <div className="authPageRoot">
      <RequestForm slug={community.slug} name={community.name} />
    </div>
  );
}
