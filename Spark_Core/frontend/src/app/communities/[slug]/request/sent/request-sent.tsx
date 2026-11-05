"use client";

import Link from "next/link";
import { notFound } from "next/navigation";
import { useCommunity } from "../../../_lib/use-communities";

export function RequestSent({ slug }: { slug: string }) {
  const { community, status } = useCommunity(slug);
  if (status === "not_found") notFound();
  const name = community?.name ?? "this community";

  return (
    <div className="authCardWrapper">
      <h1 className="authHeading">Request sent</h1>
      <p className="authSubheading" role="status">
        The owners of {name} will review your request. You will get a notification when they decide.
      </p>
      <Link className="authSubmitBtn" href={`/communities/${encodeURIComponent(slug)}`}>
        Back to {name}
      </Link>
      <div className="authSwitchNotice">
        <Link href="/communities">Return to discovery</Link>
      </div>
    </div>
  );
}
