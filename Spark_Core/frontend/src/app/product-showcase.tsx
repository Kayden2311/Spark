"use client";

import Image from "next/image";
import Link from "next/link";
import { useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";

import { useAuth } from "./auth-context";
import { TypingHeading } from "./typing-heading";

type SceneId = "people" | "plan" | "next";

const SCENE_SECONDS = 7;
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia?.(REDUCED_MOTION);
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}

function usePrefersReducedMotion() {
  return useSyncExternalStore(subscribeReducedMotion, () => window.matchMedia?.(REDUCED_MOTION).matches ?? false, () => false);
}

function SceneIcon({ type }: { type: SceneId }) {
  if (type === "people") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle cx="8" cy="8" r="3" />
        <circle cx="17" cy="9" r="2.5" />
        <path d="M2.5 21c.5-4 2.3-6 5.5-6s5 2 5.5 6M14 16c3.7-.4 6 1.3 6.5 5" />
      </svg>
    );
  }
  if (type === "plan") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M9 3v18M15 3v18" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M7 3v4M17 3v4M3 10h18" />
    </svg>
  );
}

function PointerIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M9 4v10.5l-2.2-2.2a1.6 1.6 0 0 0-2.3 2.3L9.6 20h8.2l1.2-6.4a2 2 0 0 0-1.6-2.3L13 10.5V4a2 2 0 0 0-4 0Z" />
    </svg>
  );
}

function PeopleScene({ onInteract }: { onInteract: () => void }) {
  const [requested, setRequested] = useState(false);
  return (
    <div className="stageScene">
      <Image alt="" className="stagePhoto" fill sizes="(max-width: 900px) 100vw, 46rem" src="/spark-community-discussion.png" />
      <div className="stagePhotoShade" />
      <div className="stageGlass stageCircleCard">
        <div className="stageCircleTop">
          <span className="stageCircleMark">NF</span>
          <div>
            <strong>Northstar Founders</strong>
            <span>B2B SaaS · Ho Chi Minh City · Seed</span>
          </div>
        </div>
        <div className="stageCircleStats">
          <span><b>186</b> members</span>
          <span><b>42</b> posts this week</span>
        </div>
        <button
          className={`stageAction${requested ? " stageActionDone" : ""}`}
          onClick={() => { setRequested((value) => !value); onInteract(); }}
          type="button"
        >
          {requested ? "✓ Request sent" : "Request to join"}
        </button>
      </div>
      <div className="stageGlass stageProfileCard">
        <span className="stageAvatarLg tone-amber">TL</span>
        <div>
          <strong>Thu Le</strong>
          <span>Looking for a technical co-founder</span>
        </div>
      </div>
      {requested && (
        <div className="stageToast" role="status">
          <span className="stageToastCheck">✓</span> The owner of Northstar Founders will review your request.
        </div>
      )}
    </div>
  );
}

const COLUMNS = ["To do", "In progress", "Done"] as const;
const INITIAL_TASKS = [
  { id: 1, tag: "Research", tone: "green", title: "Interview 5 founders", who: "HN", column: 0 },
  { id: 2, tag: "Design", tone: "violet", title: "Sketch onboarding flow", who: "TL", column: 0 },
  { id: 3, tag: "Growth", tone: "amber", title: "Launch community page", who: "ML", column: 1 },
  { id: 4, tag: "P0", tone: "blue", title: "Ship session security", who: "DK", column: 2 },
];

function PlanScene({ onInteract }: { onInteract: () => void }) {
  const [tasks, setTasks] = useState(INITIAL_TASKS);
  const done = tasks.filter((task) => task.column === 2).length;
  const advance = (id: number) => {
    setTasks((current) => current.map((task) => (task.id === id ? { ...task, column: (task.column + 1) % COLUMNS.length } : task)));
    onInteract();
  };
  return (
    <div className="stageScene">
      <Image alt="" className="stagePhoto stagePhotoMuted" fill sizes="(max-width: 900px) 100vw, 46rem" src="/spark-builder-circle.png" />
      <div className="stagePhotoShade stagePhotoShadeStrong" />
      <div className="stagePlanBody">
        <div className="stageBoardHeader">
          <div>
            <strong>Sprint Alpha</strong>
            <span>{done} of {tasks.length} done · click a card to move it</span>
          </div>
          <div className="stageProgress">
            <span className="stageProgressFill" style={{ width: `${(done / tasks.length) * 100}%` }} />
          </div>
        </div>
        <div className="stageBoard">
          {COLUMNS.map((column, columnIndex) => (
            <div className="stageColumn" key={column}>
              <p>{column}</p>
              {tasks.filter((task) => task.column === columnIndex).map((task) => (
                <button
                  aria-label={`${task.title}, ${column}. Move to ${COLUMNS[(columnIndex + 1) % COLUMNS.length]}`}
                  className={`stageTask${columnIndex === 2 ? " stageTaskDone" : ""}`}
                  key={task.id}
                  onClick={() => advance(task.id)}
                  type="button"
                >
                  <span className={`stageTag tone-${task.tone}`}>{task.tag}</span>
                  <strong>{task.title}</strong>
                  <i className="stageTaskOwner">{task.who}</i>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function NextScene({ onInteract }: { onInteract: () => void }) {
  const [joined, setJoined] = useState(false);
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  return (
    <div className="stageScene">
      <Image alt="" className="stagePhoto stagePhotoBanner" fill sizes="(max-width: 900px) 100vw, 46rem" src="/spark-product-banner.png" />
      <div className="stagePhotoShade stagePhotoShadeSide" />
      <div className="stageCalendar">
        <div className="stageCalendarHeader">
          <strong>This week</strong>
          <span>3 sessions · 1 milestone</span>
        </div>
        <div className="stageWeek">
          {days.map((day, index) => (
            <div className={`stageDay${index === 2 ? " stageDayToday" : ""}`} key={day}>
              <span>{day}</span>
              {index === 0 && <i className="stageSlot tone-blue">Standup</i>}
              {index === 2 && <i className="stageSlot stageSlotLive">Founder demo</i>}
              {index === 3 && <i className="stageSlot tone-violet">Mentor sync</i>}
            </div>
          ))}
        </div>
      </div>
      <div className="stageGlass stageEventCard">
        <span className="stageLive"><span /> Starting in 15 min</span>
        <strong>Founder demo &amp; architecture review</strong>
        <div className="stageEventFooter">
          <div className="stageAvatarStack">
            <i className="tone-blue">ML</i>
            <i className="tone-violet">DK</i>
            <i className="tone-green">HN</i>
            {joined && <i className="tone-amber">You</i>}
            <b>+5</b>
          </div>
          <button
            className={`stageAction stageActionSmall${joined ? " stageActionDone" : ""}`}
            onClick={() => { setJoined((value) => !value); onInteract(); }}
            type="button"
          >
            {joined ? "✓ You're in" : "Join session"}
          </button>
        </div>
      </div>
      <div className="stageGlass stageMilestone">
        <svg aria-hidden="true" viewBox="0 0 44 44">
          <circle className="stageRingTrack" cx="22" cy="22" r="18" />
          <circle className="stageRingValue" cx="22" cy="22" r="18" />
        </svg>
        <div>
          <span>Next milestone</span>
          <strong>Public beta · 3 days</strong>
        </div>
      </div>
    </div>
  );
}

export function ProductShowcase() {
  const { isAuthenticated } = useAuth();
  const [active, setActive] = useState<SceneId>("people");
  const [autoplayChoice, setAutoplay] = useState(true);
  const reducedMotion = usePrefersReducedMotion();
  const autoplay = autoplayChoice && !reducedMotion;
  const [hovering, setHovering] = useState(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const scenes: Array<{ id: SceneId; label: string; title: string; summary: string; cta: string; href: string }> = [
    {
      id: "people",
      label: "The people",
      title: "Find the minds that unblock the work",
      summary: "Discover circles by stage and city, then ask to join in one step.",
      cta: "Explore communities",
      href: "/communities",
    },
    {
      id: "plan",
      label: "The plan",
      title: "Keep momentum visible",
      summary: "One light board with clear owners. No ceremony.",
      cta: "Open boards",
      href: isAuthenticated ? "/workspace" : "/login?redirect=/workspace",
    },
    {
      id: "next",
      label: "The next move",
      title: "Make time match the work",
      summary: "Syncs and milestones live next to the work they move.",
      cta: "View schedule",
      href: "/schedule",
    },
  ];
  const activeIndex = scenes.findIndex((scene) => scene.id === active);
  const current = scenes[activeIndex] ?? scenes[0]!;
  const running = autoplay && !hovering;

  const select = (id: SceneId) => {
    setActive(id);
    setAutoplay(false);
  };
  const stopAutoplay = () => setAutoplay(false);
  const showNext = () => setActive(scenes[(activeIndex + 1) % scenes.length]!.id);

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const offset = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (!offset) return;
    event.preventDefault();
    const next = (index + offset + scenes.length) % scenes.length;
    select(scenes[next]!.id);
    tabRefs.current[next]?.focus();
  };

  return (
    <section className="productShowcaseSection" id="product" aria-labelledby="product-title">
      <div className="productShowcaseInner">
        <div className="productSectionHeader">
          <p className="sparkKicker"><span />Everything in context</p>
          <TypingHeading id="product-title">The people, the plan, and the next move.</TypingHeading>
        </div>

        <div
          className="productStage"
          onBlur={() => setHovering(false)}
          onFocus={() => setHovering(true)}
          onMouseEnter={() => setHovering(true)}
          onMouseLeave={() => setHovering(false)}
        >
          <div className="productTabs" role="tablist" aria-label="Spark capabilities" aria-orientation="vertical">
            {scenes.map((scene, index) => (
              <button
                aria-controls="product-stage-panel"
                aria-selected={scene.id === active}
                className="productTab"
                id={`product-tab-${scene.id}`}
                key={scene.id}
                onClick={() => select(scene.id)}
                onKeyDown={(event) => onTabKey(event, index)}
                ref={(element) => { tabRefs.current[index] = element; }}
                role="tab"
                tabIndex={scene.id === active ? 0 : -1}
                type="button"
              >
                <span className="productTabIcon"><SceneIcon type={scene.id} /></span>
                <span className="productTabText">
                  <span className="productTabLabel">0{index + 1} · {scene.label}</span>
                  <strong>{scene.title}</strong>
                  <span className="productTabSummary">{scene.summary}</span>
                </span>
                {scene.id === active && autoplay && (
                  <span aria-hidden="true" className="productTabTimer">
                    <span
                      className="productTabTimerFill"
                      data-running={running}
                      key={active}
                      onAnimationEnd={showNext}
                      style={{ animationDuration: `${SCENE_SECONDS}s` }}
                    />
                  </span>
                )}
              </button>
            ))}
            <div className="productTabsFooter">
              <Link className="productStageCta" href={current.href}>
                {current.cta}
              </Link>
              <button
                aria-label={autoplay ? "Pause the tour" : "Play the tour"}
                aria-pressed={!autoplay}
                className="productAutoplay"
                onClick={() => setAutoplay(!autoplay)}
                type="button"
              >
                {autoplay ? "❚❚" : "▶"}
              </button>
            </div>
          </div>

          <div
            aria-labelledby={`product-tab-${active}`}
            className="productStageView"
            id="product-stage-panel"
            role="tabpanel"
          >
            <span className="productTryHint"><PointerIcon /> Try it</span>
            <div className="productSceneSlot" data-active={active === "people"} inert={active !== "people"}><PeopleScene onInteract={stopAutoplay} /></div>
            <div className="productSceneSlot" data-active={active === "plan"} inert={active !== "plan"}><PlanScene onInteract={stopAutoplay} /></div>
            <div className="productSceneSlot" data-active={active === "next"} inert={active !== "next"}><NextScene onInteract={stopAutoplay} /></div>
            <div className="productStageDots" aria-hidden="true">
              {scenes.map((scene) => <span data-active={scene.id === active} key={scene.id} />)}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
