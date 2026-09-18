"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export function SparkWordmarkReveal({ children }: { children: ReactNode }) {
  const sectionRef = useRef<HTMLElement>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    if (!("IntersectionObserver" in window)) {
      const fallback = globalThis.setTimeout(() => setActive(true), 0);
      return () => globalThis.clearTimeout(fallback);
    }

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setActive(true);
      observer.disconnect();
    }, { threshold: 0.35 });

    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  return <div className="sparkWordmarkScroll"><section ref={sectionRef} className="sparkWordmarkReveal" data-reveal-active={active || undefined} aria-label="Spark">{children}</section></div>;
}
