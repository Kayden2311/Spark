import Link from "next/link";
import { notFound } from "next/navigation";
import { communities } from "../../../mock-data";

export default async function RequestSentPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const community = communities.find((entry) => entry.slug === slug);
  if (!community) notFound();

  return (
    <div className="authPageRoot">
      <div className="authCardWrapper">
        <h1 className="authHeading">Request sent</h1>
        <p className="authSubheading" role="status">
          The owner of {community.name} will review your request. Preview only: no request was stored.
        </p>
        <Link className="authSubmitBtn" href="/communities">Return to discovery</Link>
      </div>
    </div>
  );
}
