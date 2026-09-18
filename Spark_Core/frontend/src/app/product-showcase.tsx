"use client";

import Link from "next/link";
import { useState } from "react";
import { useAuth } from "./auth-context";


function FeatureIcon({ type }: { type: "people" | "board" | "calendar" }) {
  if (type === "people") {
    return (
      <svg aria-hidden="true" className="productFeatureIcon" viewBox="0 0 24 24">
        <circle cx="8" cy="8" r="3" />
        <circle cx="17" cy="9" r="2.5" />
        <path d="M2.5 21c.5-4 2.3-6 5.5-6s5 2 5.5 6M14 16c3.7-.4 6 1.3 6.5 5" />
      </svg>
    );
  }
  if (type === "board") {
    return (
      <svg aria-hidden="true" className="productFeatureIcon" viewBox="0 0 24 24">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M9 3v18M15 3v18M5.5 7h1M11.5 9h1M17.5 6h1" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" className="productFeatureIcon" viewBox="0 0 24 24">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M7 3v4M17 3v4M3 10h18M7 14h3M14 14h3M7 17h3" />
    </svg>
  );
}

export function ProductShowcase() {
  const { isAuthenticated } = useAuth();
  const [activeMember, setActiveMember] = useState<number>(0);
  const [tasks, setTasks] = useState([
    { id: 1, title: "Finalize Auth & Session Tokens", tag: "P0", tagType: "blue", assignee: "DK", done: true },
    { id: 2, title: "Run 5 Founder Testing Interviews", tag: "Research", tagType: "green", assignee: "HN", done: false },
    { id: 3, title: "Launch Community Showcase", tag: "Growth", tagType: "orange", assignee: "ML", done: false },
  ]);

  const toggleTask = (id: number) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t))
    );
  };

  const members = [
    {
      name: "Mai Linh",
      role: "Founder · Fintech",
      avatar: "ML",
      avatarBg: "blue",
      task: "Setting up Seed round pitch & cap table",
      tags: ["Fintech", "Seed", "Next.js"],
      pos: { top: "16%", left: "10%" },
    },
    {
      name: "Diep Khanh",
      role: "Product · SaaS",
      avatar: "DK",
      avatarBg: "indigo",
      task: "Building Fastify REST & Session backend",
      tags: ["TypeScript", "Fastify", "Postgres"],
      pos: { top: "54%", left: "56%" },
    },
    {
      name: "Hai Nguyen",
      role: "Growth · Climate",
      avatar: "HN",
      avatarBg: "emerald",
      task: "Coordinating Beta Cohort on-boarding",
      tags: ["Growth", "Community", "Analytics"],
      pos: { top: "24%", left: "62%" },
    },
  ];

  return (
    <section className="productShowcaseSection" id="product" aria-labelledby="product-title">
      {/* Background ambient lighting */}
      <div className="productAtmosphereGlow" aria-hidden="true" />

      <div className="productShowcaseInner">
        {/* Section Header */}
        <div className="productSectionHeader">
          <div className="sparkKicker productKicker">
            <span className="productPulseDot" />
            Everything in context
          </div>
          <h2 id="product-title">The people, the plan, and the next move.</h2>
          <p className="productSectionSubtitle">
            Replace fragmented chats and status chasing with one unified operating system for community activity, sprint momentum, and milestone execution.
          </p>
        </div>

        {/* Bento Grid */}
        <div className="productBentoGrid">
          {/* Bento Card 1: The People (Community & Networks) */}
          <article className="bentoCard bentoCardPeople">
            <div className="bentoCopy">
              <div className="bentoIndexHeader">
                <FeatureIcon type="people" />
                <span className="bentoBadge">01 / The People</span>
              </div>
              <h3>Connect the minds that unblock the work.</h3>
              <p>
                Discover startup communities and trusted collaborators by stage, tech stack, and location. Turn casual discussions directly into shared milestones.
              </p>
              <div className="bentoFeatureHighlights">
                <span>✓ Matched by stage & tech stack</span>
                <span>✓ Verified founder network</span>
              </div>
              <Link className="bentoBoxButton bentoBoxButtonBlue" href="/communities">
                Explore directory
              </Link>
            </div>

            {/* Interactive Network Graph Visual (Zero Clipping Docked Layout) */}
            <div className="bentoVisual bentoVisualNetwork" aria-hidden="true">
              <div className="networkHudHeader">
                <span>Live Circle Hub</span>
                <span className="liveStatusPill"><i /> 3 active founders</span>
              </div>

              {/* Connecting Interactive Node Graph */}
              <div className="networkGraphStage">
                <svg className="networkSvgWires" viewBox="0 0 360 120">
                  <line x1="60" y1="55" x2="180" y2="35" className="networkWire" />
                  <line x1="180" y1="35" x2="300" y2="60" className="networkWire" />
                  <line x1="60" y1="55" x2="300" y2="60" className="networkWire" />
                  <circle cx="60" cy="55" r="3" className="wirePulseNode wirePulse1" />
                  <circle cx="180" cy="35" r="3" className="wirePulseNode wirePulse2" />
                  <circle cx="300" cy="60" r="3" className="wirePulseNode wirePulse3" />
                </svg>

                <div className="networkNodesRow">
                  {members.map((m, idx) => (
                    <button
                      key={m.name}
                      type="button"
                      className={`memberInteractiveNode ${idx === activeMember ? "active" : ""}`}
                      onClick={() => setActiveMember(idx)}
                      onMouseEnter={() => setActiveMember(idx)}
                      aria-label={`Select ${m.name}`}
                    >
                      <span className={`memberAvatarNode ${m.avatarBg}`}>
                        {m.avatar}
                      </span>
                      <span className="memberNamePill">{m.name.split(" ")[0]}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Docked Active Member Info Card (Never Clipped) */}
              <div className="dockedMemberCard">
                <div className="dockedMemberTop">
                  <div className="dockedMemberIdentity">
                    <strong>{members[activeMember].name}</strong>
                    <small>{members[activeMember].role}</small>
                  </div>
                  <span className="dockedTaskBadge">Active task</span>
                </div>
                <p className="dockedTaskSnippet">{members[activeMember].task}</p>
                <div className="dockedSkillTags">
                  {members[activeMember].tags.map((t) => (
                    <span key={t}>{t}</span>
                  ))}
                </div>
              </div>
            </div>
          </article>

          {/* Bento Card 2: The Plan (Projects & Boards) */}
          <article className="bentoCard bentoCardPlan">
            <div className="bentoCopy">
              <div className="bentoIndexHeader">
                <FeatureIcon type="board" />
                <span className="bentoBadge">02 / The Plan</span>
              </div>
              <h3>Keep momentum visible.</h3>
              <p>
                A high-speed Kanban board without Jira ceremony. Priorities, assignees, and real-time progress stay completely transparent.
              </p>
              <div className="bentoFeatureHighlights">
                <span>✓ Custom sprint velocity</span>
                <span>✓ Zero setup ceremony</span>
              </div>
              <Link
                className="bentoBoxButton bentoBoxButtonDark"
                href={isAuthenticated ? "/workspace" : "/login?redirect=/workspace"}
              >
                Open boards
              </Link>
            </div>

            {/* Interactive Mini Board Visual */}
            <div className="bentoVisual bentoVisualBoard">
              <div className="boardMiniHeader">
                <div>
                  <span className="boardTitle">Sprint Alpha</span>
                  <span className="boardProgressCount">
                    {tasks.filter((t) => t.done).length}/{tasks.length} Completed
                  </span>
                </div>
                <div className="boardProgressBar">
                  <span
                    style={{
                      width: `${(tasks.filter((t) => t.done).length / tasks.length) * 100}%`,
                    }}
                  />
                </div>
              </div>

              <div className="boardTaskList">
                {tasks.map((task) => (
                  <div
                    key={task.id}
                    className={`boardTaskItem ${task.done ? "taskDone" : ""}`}
                    onClick={() => toggleTask(task.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && toggleTask(task.id)}
                  >
                    <span className={`taskCheckDot ${task.done ? "checked" : ""}`} />
                    <div className="taskItemBody">
                      <div className="taskItemTop">
                        <span className={`taskTag ${task.tagType}`}>{task.tag}</span>
                        <span className="taskAssignee">{task.assignee}</span>
                      </div>
                      <strong>{task.title}</strong>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </article>

          {/* Bento Card 3: The Next Move (Schedule & Delivery) */}
          <article className="bentoCard bentoCardNext">
            <div className="bentoCopy">
              <div className="bentoIndexHeader">
                <FeatureIcon type="calendar" />
                <span className="bentoBadge">03 / The Next Move</span>
              </div>
              <h3>Make time match the work.</h3>
              <p>
                Coordinate syncs, milestone reviews, and delivery targets directly inside the shared context of your circle.
              </p>
              <div className="bentoFeatureHighlights">
                <span>✓ 2-way Google & iCal sync</span>
                <span>✓ Milestone countdown</span>
              </div>
              <Link className="bentoBoxButton bentoBoxButtonIndigo" href="/schedule">
                View schedule
              </Link>
            </div>

            {/* Interactive Schedule & Milestone Visual */}
            <div className="bentoVisual bentoVisualSchedule">
              <div className="scheduleHighlightCard">
                <div className="scheduleTopRow">
                  <span className="schedulePillLive">
                    <span className="scheduleBlinkDot" /> Next Circle
                  </span>
                  <time className="scheduleTime">14:00 Today</time>
                </div>
                <strong>Founder Demo & Architecture Review</strong>
                <div className="scheduleAttendees">
                  <div className="attendeeAvatars">
                    <span className="avatarSm blue">ML</span>
                    <span className="avatarSm indigo">DK</span>
                    <span className="avatarSm emerald">HN</span>
                  </div>
                  <span className="attendeeCount">+5 attending</span>
                </div>
              </div>

              <div className="milestoneMiniCard">
                <div className="milestoneMeta">
                  <span>Target Release</span>
                  <strong>v1.0 Public Beta</strong>
                </div>
                <div className="milestoneStatusBadge">3 days left</div>
              </div>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
