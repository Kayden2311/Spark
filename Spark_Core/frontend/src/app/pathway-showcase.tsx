"use client";

import Image from "next/image";
import Link from "next/link";

import { useAuth } from "./auth-context";
import { TypingHeading } from "./typing-heading";

type Pathway = {
  tone: "builder" | "founder";
  eyebrow: string;
  title: string;
  description: string;
  points: string[];
  cta: string;
  href: string;
  image: { src: string; alt: string; position: string };
};

export function PathwayShowcase() {
  const { isAuthenticated } = useAuth();

  const pathways: Pathway[] = [
    {
      tone: "builder",
      eyebrow: "For builders",
      title: "Looking for a team",
      description: "Find a team with enough context to move the work forward.",
      points: ["Browse by topic, city and stage", "Request access in one step"],
      cta: "Explore communities",
      href: "/communities",
      image: { src: "/spark-builder-circle.png", alt: "Startup builders exchanging ideas around a laptop", position: "50% 30%" },
    },
    {
      tone: "founder",
      eyebrow: "For founders",
      title: "Start up your idea",
      description: "Give your early team one shared home for decisions and momentum.",
      points: ["Invite teammates with single-use links", "Plan work on one shared board"],
      cta: "Start your workspace",
      href: isAuthenticated ? "/workspace" : "/login?redirect=/workspace",
      image: { src: "/spark-founder-circle.png", alt: "Startup founders planning their next step together", position: "55% 30%" },
    },
  ];

  return (
    <section className="pathwayShowcaseSection" id="pathways" aria-labelledby="pathways-title">
      <div className="pathwayContentContainer">
        <div className="pathwayHeader">
          <div>
            <p className="pathwaySectionKicker">Choose your starting point</p>
            <TypingHeading id="pathways-title">Find your circle. Build what matters.</TypingHeading>
          </div>
          <p className="pathwayIntro">Two ways in. Join a circle that already moves, or give your own idea a home.</p>
        </div>
        <div className="pathwayPanels">
          {pathways.map((pathway) => (
            <article className={`pathwayPanel pathwayPanel-${pathway.tone}`} key={pathway.tone}>
              <Image
                alt={pathway.image.alt}
                className="pathwayPanelImage"
                fill
                sizes="(max-width: 900px) 100vw, 50vw"
                src={pathway.image.src}
                style={{ objectPosition: pathway.image.position }}
              />
              <div className="pathwayPanelShade" aria-hidden="true" />
              <div className="pathwayPanelContent">
                <p className="pathwayPanelEyebrow">{pathway.eyebrow}</p>
                <h3>{pathway.title}</h3>
                <p className="pathwayPanelDescription">{pathway.description}</p>
                <ul className="pathwayPanelPoints">
                  {pathway.points.map((point) => (
                    <li key={point}>
                      <svg aria-hidden="true" viewBox="0 0 20 20"><path d="m5 10.5 3.2 3.2L15 7" /></svg>
                      {point}
                    </li>
                  ))}
                </ul>
                <Link className="pathwayButton" href={pathway.href}>
                  {pathway.cta}
                </Link>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
