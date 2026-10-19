"use client";

import { SparkLogo as SparkMark } from "../../brand/spark-logo";

/** Full-page calm loading state while the session or workspace list resolves. */
export function WorkspaceSplash({ label }: { label: string }) {
  return (
    <div className="wsSplash">
      <div aria-hidden="true" className="wsGlow" />
      <div className="wsSplashInner" role="status">
        <span className="wsSplashMark"><SparkMark /></span>
        <p>{label}</p>
      </div>
    </div>
  );
}
