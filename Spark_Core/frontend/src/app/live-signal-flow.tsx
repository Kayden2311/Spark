"use client";

import { useEffect, useRef, useState } from "react";

type NodeId =
  | "founder-ml"
  | "founder-dk"
  | "founder-hn"
  | "task-onboarding"
  | "task-launch"
  | "task-research"
  | "event-circle"
  | "event-ama"
  | null;

interface Connection {
  from: string;
  to: string;
  color: string;
  gradientId: string;
  path: string;
}

type Dot = {
  originX: number;
  originY: number;
  size: number;
  phase: number;
  strand: number;
};

export function LiveSignalFlow() {
  const [activeNode, setActiveNode] = useState<NodeId>("founder-ml");
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Full-width Edge-to-Edge Ambient Particle Canvas with Relaxed Dot Spacing
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    let frame = 0;
    let dots: Dot[] = [];
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio, 2);
      canvas.width = Math.round(bounds.width * ratio);
      canvas.height = Math.round(bounds.height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);

      // Relaxed, spacious grid spacing (~32px between particles)
      const spacingX = 34;
      const spacingY = 32;
      const columns = Math.ceil(bounds.width / spacingX) + 1;
      const rows = Math.ceil(bounds.height / spacingY) + 1;

      dots = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < columns; c++) {
          const x = c * spacingX;
          const y = r * spacingY;
          dots.push({
            originX: x,
            originY: y,
            size: (c + r) % 3 === 0 ? 1.35 : 0.9,
            phase: c * 0.14 + r * 0.16,
            strand: c % 2 === 0 ? 1 : -1,
          });
        }
      }
    };

    const draw = (time: number) => {
      const bounds = canvas.getBoundingClientRect();
      context.clearRect(0, 0, bounds.width, bounds.height);

      if (motion.matches) {
        frame = requestAnimationFrame(draw);
        return;
      }

      const t = time * 0.0012;

      for (const dot of dots) {
        // Morphing gene string / code bracket wave displacement
        const waveX = Math.sin(dot.originY * 0.015 + t * 1.6) * 5 * dot.strand;
        const waveY = Math.cos(dot.originX * 0.012 + t * 1.4) * 6 + Math.sin(dot.phase + t * 2.0) * 4;

        const curX = dot.originX + waveX;
        const curY = dot.originY + waveY;

        // Gentle breathing opacity wave
        const alpha = 0.15 + (Math.sin(dot.phase + t * 1.8) + 1) * 0.18;

        context.beginPath();
        context.fillStyle = `rgba(37, 99, 235, ${alpha})`;
        context.arc(curX, curY, dot.size, 0, Math.PI * 2);
        context.fill();
      }

      frame = requestAnimationFrame(draw);
    };

    resize();
    frame = requestAnimationFrame(draw);

    window.addEventListener("resize", resize);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, []);

  // Correct SVG Bezier paths aligning accurately with card anchors and centers
  const connections: Connection[] = [
    // Column 1 -> Column 2
    // Mai Linh (y=64) -> Onboarding Task (y=72)
    {
      from: "founder-ml",
      to: "task-onboarding",
      color: "#2563eb",
      gradientId: "blue",
      path: "M 270 64 C 320 64, 335 72, 385 72",
    },
    // Diep Khanh (y=144) -> Launch Task (y=168)
    {
      from: "founder-dk",
      to: "task-launch",
      color: "#f59e0b",
      gradientId: "orange",
      path: "M 270 144 C 320 144, 335 168, 385 168",
    },
    // Hai Nguyen (y=224) -> Research Task (y=264) - Fixed Bezier curve to eliminate misplacement
    {
      from: "founder-hn",
      to: "task-research",
      color: "#10b981",
      gradientId: "green",
      path: "M 270 224 C 320 224, 335 264, 385 264",
    },

    // Column 2 -> Column 3
    // Onboarding Task (y=72) -> Product Circle Event (y=92)
    {
      from: "task-onboarding",
      to: "event-circle",
      color: "#2563eb",
      gradientId: "blue",
      path: "M 645 72 C 695 72, 710 92, 760 92",
    },
    // Launch Task (y=168) -> Founder AMA Event (y=224)
    {
      from: "task-launch",
      to: "event-ama",
      color: "#f59e0b",
      gradientId: "orange",
      path: "M 645 168 C 695 168, 710 224, 760 224",
    },
    // Research Task (y=264) -> Product Circle Event (y=92)
    {
      from: "task-research",
      to: "event-circle",
      color: "#10b981",
      gradientId: "green",
      path: "M 645 264 C 710 264, 695 92, 760 92",
    },
  ];

  const isConnected = (fromId: string, toId: string) => {
    if (!activeNode) return true;
    if (activeNode === fromId || activeNode === toId) return true;
    if (activeNode === "founder-ml" && (toId === "event-circle" || fromId === "task-onboarding")) return true;
    if (activeNode === "founder-dk" && (toId === "event-ama" || fromId === "task-launch")) return true;
    if (activeNode === "founder-hn" && (toId === "event-circle" || fromId === "task-research")) return true;
    return false;
  };

  return (
    <section className="liveFlowSection" aria-label="Interactive Live Connectivity Flow">
      {/* Full-width Background Particle Canvas spanning edge-to-edge */}
      <div className="flowParticleFullBleed" aria-hidden="true">
        <canvas ref={canvasRef} className="flowParticleCanvas" />
      </div>

      <div className="liveFlowInner">
        {/* Section Header */}
        <div className="liveFlowHeader">
          <p className="sparkKicker"><span />Unified Signal Architecture</p>
          <h2>Everything stays connected in realtime.</h2>
          <p>Conversations in your community immediately turn into owned tasks, assigned milestones, and scheduled moments without chasing status.</p>
        </div>

        {/* Live Signal Flow Canvas with Pulse Lasers */}
        <div className="liveFlowCanvasWrapper">
          {/* SVG Dynamic Light Beams */}
          <svg className="liveFlowSvgBeams" viewBox="0 0 1030 330" fill="none" preserveAspectRatio="none">
            <defs>
              <filter id="glow-beam" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="3.5" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
              <linearGradient id="beam-grad-blue" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.8" />
                <stop offset="50%" stopColor="#93c5fd" stopOpacity="1" />
                <stop offset="100%" stopColor="#2563eb" stopOpacity="0.8" />
              </linearGradient>
              <linearGradient id="beam-grad-orange" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.8" />
                <stop offset="50%" stopColor="#fde68a" stopOpacity="1" />
                <stop offset="100%" stopColor="#d97706" stopOpacity="0.8" />
              </linearGradient>
              <linearGradient id="beam-grad-green" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#10b981" stopOpacity="0.8" />
                <stop offset="50%" stopColor="#a7f3d0" stopOpacity="1" />
                <stop offset="100%" stopColor="#059669" stopOpacity="0.8" />
              </linearGradient>
            </defs>

            {/* Base Wire Paths & Animated Pulse Beams */}
            {connections.map((c, i) => {
              const active = isConnected(c.from, c.to);
              return (
                <g key={`beam-${i}`}>
                  {/* Subtle Background Guide Wire */}
                  <path
                    d={c.path}
                    stroke={c.color}
                    strokeWidth={active ? 2.5 : 1.2}
                    strokeOpacity={active ? 0.65 : 0.18}
                    strokeDasharray={active ? "none" : "4 4"}
                    className="wirePath"
                  />
                  {/* Streaming Data Laser Pulse */}
                  {active && (
                    <path
                      d={c.path}
                      stroke={`url(#beam-grad-${c.gradientId})`}
                      strokeWidth="3.5"
                      strokeLinecap="round"
                      filter="url(#glow-beam)"
                      className="pulseBeam"
                    />
                  )}
                </g>
              );
            })}
          </svg>

          {/* 3 Columns of Live Interactive Nodes */}
          <div className="liveFlowGrid">
            {/* Column 1: Community Network */}
            <div className="flowColumn colCommunity">
              <div className="colHeader">
                <span className="dotIndicator" />
                <span>01 / Community Network</span>
              </div>

              <div
                className={`nodeCard nodePerson ${activeNode === "founder-ml" ? "active" : ""}`}
                onMouseEnter={() => setActiveNode("founder-ml")}
              >
                <span className="nodeAvatar blue">ML</span>
                <div className="nodeBody">
                  <strong>Mai Linh</strong>
                  <small>Fintech Founder · Ho Chi Minh</small>
                </div>
                <span className="liveSignalBadge">Online</span>
              </div>

              <div
                className={`nodeCard nodePerson ${activeNode === "founder-dk" ? "active" : ""}`}
                onMouseEnter={() => setActiveNode("founder-dk")}
              >
                <span className="nodeAvatar orange">DK</span>
                <div className="nodeBody">
                  <strong>Diep Khanh</strong>
                  <small>Product Lead · Hanoi</small>
                </div>
                <span className="liveSignalBadge">Active</span>
              </div>

              <div
                className={`nodeCard nodePerson ${activeNode === "founder-hn" ? "active" : ""}`}
                onMouseEnter={() => setActiveNode("founder-hn")}
              >
                <span className="nodeAvatar green">HN</span>
                <div className="nodeBody">
                  <strong>Hai Nguyen</strong>
                  <small>Climate Tech · Da Nang</small>
                </div>
                <span className="liveSignalBadge">Syncing</span>
              </div>
            </div>

            {/* Column 2: Active Work & Tasks */}
            <div className="flowColumn colTasks">
              <div className="colHeader">
                <span className="dotIndicator" />
                <span>02 / Live Workspaces</span>
              </div>

              <div
                className={`nodeCard nodeTask ${activeNode === "task-onboarding" || activeNode === "founder-ml" ? "active" : ""}`}
                onMouseEnter={() => setActiveNode("task-onboarding")}
              >
                <div className="nodeTag blue">Product Milestone</div>
                <strong>Finalize Onboarding UX Flow</strong>
                <div className="taskMeta">
                  <span><i>ML</i> Assigned</span>
                  <span className="statusPill inProgress">In Progress</span>
                </div>
              </div>

              <div
                className={`nodeCard nodeTask ${activeNode === "task-launch" || activeNode === "founder-dk" ? "active" : ""}`}
                onMouseEnter={() => setActiveNode("task-launch")}
              >
                <div className="nodeTag orange">Community Growth</div>
                <strong>Launch Cohort Announcement</strong>
                <div className="taskMeta">
                  <span><i>DK</i> Assigned</span>
                  <span className="statusPill review">Reviewing</span>
                </div>
              </div>

              <div
                className={`nodeCard nodeTask ${activeNode === "task-research" || activeNode === "founder-hn" ? "active" : ""}`}
                onMouseEnter={() => setActiveNode("task-research")}
              >
                <div className="nodeTag green">Market Insights</div>
                <strong>Founder Interviews Batch #3</strong>
                <div className="taskMeta">
                  <span><i>HN</i> Assigned</span>
                  <span className="statusPill done">Done</span>
                </div>
              </div>
            </div>

            {/* Column 3: Shared Schedule & Sync */}
            <div className="flowColumn colSchedule">
              <div className="colHeader">
                <span className="dotIndicator" />
                <span>03 / Shared Moments</span>
              </div>

              <div
                className={`nodeCard nodeEvent ${activeNode === "event-circle" || activeNode === "founder-ml" || activeNode === "founder-hn" || activeNode === "task-onboarding" || activeNode === "task-research" ? "active" : ""}`}
                onMouseEnter={() => setActiveNode("event-circle")}
              >
                <div className="eventTime">Today · 14:00 PM</div>
                <strong>Product Circle Weekly Sync</strong>
                <p>Discussing onboarding friction points with active founders.</p>
                <div className="attendeeRow">
                  <i>ML</i>
                  <i>HN</i>
                  <span>+8 members</span>
                </div>
              </div>

              <div
                className={`nodeCard nodeEvent ${activeNode === "event-ama" || activeNode === "founder-dk" || activeNode === "task-launch" ? "active" : ""}`}
                onMouseEnter={() => setActiveNode("event-ama")}
              >
                <div className="eventTime orange">Friday · 16:30 PM</div>
                <strong>Founder AMA & Growth Review</strong>
                <p>Deep-dive review on community distribution with Diep Khanh.</p>
                <div className="attendeeRow">
                  <i>DK</i>
                  <span>+15 founders</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}