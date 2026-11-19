"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { SignalParticles } from "../../../../signal-particles";
import { SiteFooter, SiteHeader } from "../../../site-chrome";
import { loginPath } from "../../../_lib/api";

/** The not-found page of a post: a fixed message, a way back and, without a session, a way to sign in. */
export function PostUnavailable({ signedIn }: { signedIn: boolean }) {
  const { slug } = useParams<{ slug: string }>();
  const pathname = usePathname();
  const base = `/communities/${encodeURIComponent(slug)}`;
  return (
    <main className="sparkLanding circleDetailRoot">
      <SignalParticles />
      <SiteHeader />
      <div className="circlePageContainer circlePostPage">
        <section className="circleSectionCard circleStateCard">
          <h1 className="circleMainTitle">This discussion isn&apos;t available.</h1>
          <p>
            <Link href={base}>Back to the community</Link>
          </p>
          {!signedIn && (
            <p>
              <Link href={loginPath(pathname)}>Sign in</Link>
            </p>
          )}
        </section>
      </div>
      <SiteFooter />
    </main>
  );
}
