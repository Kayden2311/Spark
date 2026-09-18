"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "./auth-context";


type Pathway = "team" | "idea" | null;
type Point2 = [number, number];

// Sample dense points along a 2D line segment
function sampleLine2D(p1: Point2, p2: Point2, count: number): Point2[] {
  const points: Point2[] = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    points.push([
      p1[0] + (p2[0] - p1[0]) * t,
      p1[1] + (p2[1] - p1[1]) * t,
    ]);
  }
  return points;
}

// Sample points along a 2D circle
function sampleCircle2D(center: Point2, radius: number, count: number): Point2[] {
  const points: Point2[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    points.push([
      center[0] + Math.cos(angle) * radius,
      center[1] + Math.sin(angle) * radius,
    ]);
  }
  return points;
}

// 1. Build 2D Sith Tetrahedron Geometry Data (For Builders)
function create2DTetrahedronData(): {
  points: Point2[];
  strength: number[];
  isCore: boolean[];
  wireLines: [Point2, Point2][];
} {
  const points: Point2[] = [];
  const strength: number[] = [];
  const isCore: boolean[] = [];
  const wireLines: [Point2, Point2][] = [];

  const addStrand = (p1: Point2, p2: Point2, count: number, str = 1.0, core = false) => {
    const pts = sampleLine2D(p1, p2, count);
    for (const p of pts) {
      points.push(p);
      strength.push(str);
      isCore.push(core);
    }
  };

  const addDenseRibbon = (p1: Point2, p2: Point2, count: number, offset = 0.025, str = 1.0, core = false) => {
    addStrand(p1, p2, count, str, core);
    wireLines.push([p1, p2]);
    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * offset;
    const ny = (dx / len) * offset;

    const p1a: Point2 = [p1[0] + nx, p1[1] + ny];
    const p2a: Point2 = [p2[0] + nx, p2[1] + ny];
    addStrand(p1a, p2a, count, str * 0.9, core);

    const p1b: Point2 = [p1[0] - nx, p1[1] - ny];
    const p2b: Point2 = [p2[0] - nx, p2[1] - ny];
    addStrand(p1b, p2b, count, str * 0.9, core);
  };

  // 3 Equilateral Master Vertices
  const V: Point2[] = [
    [0, -1.02],          // Top Vertex V0
    [-0.92, 0.62],       // Bottom-Left V1
    [0.92, 0.62],        // Bottom-Right V2
  ];

  // Truncate corners at tCut = 0.72 from center
  const tCut = 0.72;
  const V_body: Point2[] = V.map(([vx, vy]) => [vx * tCut, vy * tCut]);

  // Main Outer Body Truncated Triangle
  addDenseRibbon(V_body[0], V_body[1], 12, 0.024, 1.0);
  addDenseRibbon(V_body[1], V_body[2], 12, 0.024, 1.0);
  addDenseRibbon(V_body[2], V_body[0], 12, 0.024, 1.0);

  // 3 Rotated Corner Pyramid Caps (180 deg inverted caps)
  const capScale = 0.32;
  const rotAngle = Math.PI;

  for (let i = 0; i < 3; i++) {
    const tip = V[i];
    const nextTip = V[(i + 1) % 3];
    const prevTip = V[(i + 2) % 3];

    const d1: Point2 = [nextTip[0] - tip[0], nextTip[1] - tip[1]];
    const d2: Point2 = [prevTip[0] - tip[0], prevTip[1] - tip[1]];

    const rotate2D = ([x, y]: Point2, angle: number): Point2 => [
      x * Math.cos(angle) - y * Math.sin(angle),
      x * Math.sin(angle) + y * Math.cos(angle),
    ];

    const rotD1 = rotate2D(d1, rotAngle);
    const rotD2 = rotate2D(d2, rotAngle);

    const c1: Point2 = [tip[0] + rotD1[0] * capScale, tip[1] + rotD1[1] * capScale];
    const c2: Point2 = [tip[0] + rotD2[0] * capScale, tip[1] + rotD2[1] * capScale];

    addDenseRibbon(tip, c1, 8, 0.02, 1.0);
    addDenseRibbon(tip, c2, 8, 0.02, 1.0);
    addDenseRibbon(c1, c2, 7, 0.02, 0.92);
  }

  // Nested Inverted Ruby Facet Window
  const innerScale = 0.44;
  const IV: Point2[] = [
    [0, 0.46 * innerScale],
    [-0.88 * innerScale, -0.42 * innerScale],
    [0.88 * innerScale, -0.42 * innerScale],
  ];
  addDenseRibbon(IV[0], IV[1], 8, 0.02, 0.95);
  addDenseRibbon(IV[1], IV[2], 8, 0.02, 0.95);
  addDenseRibbon(IV[2], IV[0], 8, 0.02, 0.95);

  // Core Diamond
  const diamondRad = 0.16;
  const D: Point2[] = [
    [0, -diamondRad],
    [diamondRad * 0.9, 0],
    [0, diamondRad],
    [-diamondRad * 0.9, 0],
  ];
  for (let i = 0; i < 4; i++) {
    addStrand(D[i], D[(i + 1) % 4], 6, 1.0, true);
    wireLines.push([D[i], D[(i + 1) % 4]]);
  }

  // Core dense point
  points.push([0, 0]);
  strength.push(1.0);
  isCore.push(true);

  return { points, strength, isCore, wireLines };
}

// 2. Build 2D Jedi Cube Holocron Geometry Data (For Founders)
function create2DJediCubeData(): {
  points: Point2[];
  strength: number[];
  isCore: boolean[];
  wireLines: [Point2, Point2][];
} {
  const points: Point2[] = [];
  const strength: number[] = [];
  const isCore: boolean[] = [];
  const wireLines: [Point2, Point2][] = [];

  const addStrand = (p1: Point2, p2: Point2, count: number, str = 1.0, core = false) => {
    const pts = sampleLine2D(p1, p2, count);
    for (const p of pts) {
      points.push(p);
      strength.push(str);
      isCore.push(core);
    }
  };

  const addDenseRibbon = (p1: Point2, p2: Point2, count: number, offset = 0.024, str = 1.0, core = false) => {
    addStrand(p1, p2, count, str, core);
    wireLines.push([p1, p2]);
    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * offset;
    const ny = (dx / len) * offset;

    const p1a: Point2 = [p1[0] + nx, p1[1] + ny];
    const p2a: Point2 = [p2[0] + nx, p2[1] + ny];
    addStrand(p1a, p2a, count, str * 0.9, core);

    const p1b: Point2 = [p1[0] - nx, p1[1] - ny];
    const p2b: Point2 = [p2[0] - nx, p2[1] - ny];
    addStrand(p1b, p2b, count, str * 0.9, core);
  };

  const R = 0.84;
  const SQ: Point2[] = [
    [-R, -R], // Top-Left
    [R, -R],  // Top-Right
    [R, R],   // Bottom-Right
    [-R, R],  // Bottom-Left
  ];

  // 4 Outer Square Borders
  for (let i = 0; i < 4; i++) {
    addDenseRibbon(SQ[i], SQ[(i + 1) % 4], 12, 0.024, 1.0);
  }

  // 4 Corner Crown Pyramid Caps
  const capLen = 0.38;
  for (let i = 0; i < 4; i++) {
    const c = SQ[i];
    const signX = c[0] > 0 ? 1 : -1;
    const signY = c[1] > 0 ? 1 : -1;

    const cEdge1: Point2 = [c[0] - signX * capLen, c[1]];
    const cEdge2: Point2 = [c[0], c[1] - signY * capLen];
    const cApex: Point2 = [c[0] - signX * capLen * 0.58, c[1] - signY * capLen * 0.58];

    addDenseRibbon(c, cApex, 6, 0.02, 0.95);
    addStrand(cApex, cEdge1, 5, 0.85);
    addStrand(cApex, cEdge2, 5, 0.85);
    wireLines.push([cApex, cEdge1], [cApex, cEdge2]);
  }

  // Inscribed 45° Diamond
  const D_rad = R * 0.72;
  const DM: Point2[] = [
    [0, -D_rad],
    [D_rad, 0],
    [0, D_rad],
    [-D_rad, 0],
  ];
  for (let i = 0; i < 4; i++) {
    addDenseRibbon(DM[i], DM[(i + 1) % 4], 9, 0.022, 0.95);
  }

  // Concentric Circular Aperture Rings
  const apertureCircles = [0.38, 0.24];
  for (const radius of apertureCircles) {
    const ringPts = sampleCircle2D([0, 0], radius, 22);
    for (const p of ringPts) {
      points.push(p);
      strength.push(0.92);
      isCore.push(false);
    }
  }

  // Emerald Core Inscribed Diamond & Center
  const coreRad = 0.14;
  const CD: Point2[] = [
    [0, -coreRad],
    [coreRad, 0],
    [0, coreRad],
    [-coreRad, 0],
  ];
  for (let i = 0; i < 4; i++) {
    addStrand(CD[i], CD[(i + 1) % 4], 5, 1.0, true);
    wireLines.push([CD[i], CD[(i + 1) % 4]]);
  }

  points.push([0, 0]);
  strength.push(1.0);
  isCore.push(true);

  return { points, strength, isCore, wireLines };
}

// Dedicated Top-Right Holocron Widget
function PathwayHolocronWidget({
  type,
  active,
}: {
  type: "tetrahedron" | "cube";
  active: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const data = type === "tetrahedron" ? create2DTetrahedronData() : create2DJediCubeData();
    const geoPoints = data.points;

    // Generate particle state
    const particles = geoPoints.map((target, idx) => {
      return {
        x: target[0],
        y: target[1],
        targetX: target[0],
        targetY: target[1],
        strength: data.strength[idx] ?? 1.0,
        isCore: data.isCore[idx] ?? false,
        phase: idx * 0.28,
        seed: Math.sin(idx * 997.1),
      };
    });

    let width = 0;
    let height = 0;
    let frame = 0;
    let isVisible = true;
    let hoverEnergy = active ? 1 : 0;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();

    const draw = (time: number) => {
      ctx.clearRect(0, 0, width, height);

      const isHovered = activeRef.current;
      const targetEnergy = isHovered ? 1 : 0;
      const energySpeed = reducedMotion.matches ? 1 : 0.08;
      hoverEnergy += (targetEnergy - hoverEnergy) * energySpeed;

      const t = time * 0.001;
      const cx = width * 0.5;
      const cy = height * 0.5;
      const scale = Math.min(width, height) * 0.30;
      const floatY = Math.sin(t * 1.6) * 2.5;

      // Harmonized with Spark brand palette:
      // Tetrahedron (Builders): Electric Spark Blue & Sky Cyan
      // Cube (Founders): High-Tech Indigo & Electric Violet
      const glowColor = type === "tetrahedron" ? "37, 99, 235" : "79, 70, 229";
      const coreColor = type === "tetrahedron" ? "147, 197, 253" : "196, 181, 253";

      // 1. Radial Ambient Aura (Properly clamped to avoid canvas bounds clipping)
      const auraIntensity = 0.08 + hoverEnergy * 0.18;
      const radGlow = ctx.createRadialGradient(cx, cy + floatY, 2, cx, cy + floatY, scale * 1.45);
      radGlow.addColorStop(0, `rgba(${glowColor}, ${auraIntensity})`);
      radGlow.addColorStop(0.6, `rgba(${glowColor}, ${auraIntensity * 0.3})`);
      radGlow.addColorStop(1, `rgba(${glowColor}, 0)`);
      ctx.fillStyle = radGlow;
      ctx.beginPath();
      ctx.arc(cx, cy + floatY, scale * 1.45, 0, Math.PI * 2);
      ctx.fill();

      // 2. Rotating Orbital HUD Radar Rings
      ctx.save();
      ctx.translate(cx, cy + floatY);
      const spinSpeed = 0.22 + hoverEnergy * 0.55;
      ctx.rotate(t * spinSpeed);

      // Outer dashed HUD ring
      ctx.beginPath();
      ctx.strokeStyle = `rgba(${glowColor}, ${0.2 + hoverEnergy * 0.35})`;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 8]);
      ctx.arc(0, 0, scale * 1.30, 0, Math.PI * 2);
      ctx.stroke();

      // Inner radar ring
      ctx.beginPath();
      ctx.strokeStyle = `rgba(${glowColor}, ${0.12 + hoverEnergy * 0.22})`;
      ctx.setLineDash([2, 6]);
      ctx.arc(0, 0, scale * 1.12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // 3. Crisp Laser Wireframes
      ctx.save();
      ctx.strokeStyle = `rgba(${glowColor}, ${0.24 + hoverEnergy * 0.45})`;
      ctx.lineWidth = 1.1;
      ctx.shadowBlur = 4 + hoverEnergy * 8;
      ctx.shadowColor = `rgba(${glowColor}, ${0.4 + hoverEnergy * 0.4})`;

      for (const [p1, p2] of data.wireLines) {
        ctx.beginPath();
        ctx.moveTo(cx + p1[0] * scale, cy + p1[1] * scale + floatY);
        ctx.lineTo(cx + p2[0] * scale, cy + p2[1] * scale + floatY);
        ctx.stroke();
      }
      ctx.restore();

      // 4. Dense High-Tech Particles
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        const pulse = Math.sin(p.phase + t * 3.4) * 0.5 + 0.5;

        // Micro vibration on hover
        const jitter = hoverEnergy > 0.1 ? Math.sin(t * 12 + p.seed * 50) * 0.012 * hoverEnergy : 0;
        const targetX = cx + (p.targetX + jitter) * scale;
        const targetY = cy + (p.targetY + jitter) * scale + floatY;

        const lerpSpeed = reducedMotion.matches ? 1 : 0.12;
        p.x += (targetX - p.x) * lerpSpeed;
        p.y += (targetY - p.y) * lerpSpeed;

        const alpha = Math.min(0.98, (0.48 + hoverEnergy * 0.42 + pulse * 0.2) * p.strength);
        const radius = (1.05 + pulse * 0.35) * (p.isCore ? 1.35 : 1.0);

        ctx.beginPath();
        if (hoverEnergy > 0.1 && (p.strength > 0.8 || p.isCore)) {
          ctx.shadowBlur = p.isCore ? 12 : 6;
          ctx.shadowColor = `rgba(${glowColor}, ${0.85})`;
        } else {
          ctx.shadowBlur = 0;
        }

        ctx.fillStyle = p.isCore
          ? `rgba(${coreColor}, ${alpha})`
          : `rgba(${glowColor}, ${alpha})`;

        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fill();
      }

      if (isVisible && !reducedMotion.matches) {
        frame = requestAnimationFrame(draw);
      }
    };

    frame = requestAnimationFrame(draw);

    const resizeObserver = new ResizeObserver(() => {
      resize();
    });
    resizeObserver.observe(canvas);

    const visibilityObserver = new IntersectionObserver(([entry]) => {
      isVisible = Boolean(entry?.isIntersecting);
      if (isVisible && !reducedMotion.matches) {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(draw);
      }
    });
    visibilityObserver.observe(canvas);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
    };
  }, [type]);

  return <canvas ref={canvasRef} className="pathwayHolocronCanvas" aria-hidden="true" />;
}

export function PathwayShowcase() {
  const [active, setActive] = useState<Pathway>(null);
  const { isAuthenticated } = useAuth();

  return (
    <section className="pathwayShowcaseSection" id="pathways" aria-labelledby="pathways-title">
      <div className="pathwayContentContainer">
        <p className="pathwaySectionKicker">Choose your starting point</p>
        <h2 id="pathways-title">Find your circle. Build what matters.</h2>
        <div className="pathwayPanels">
          <article
            className={`pathwayPanel pathwayPanelBuilder ${active === "team" ? "active" : ""}`}
            onPointerEnter={() => setActive("team")}
            onPointerLeave={() => setActive(null)}
          >
            <div className="pathwayPanelTop">
              <div className="pathwayPanelHeader">
                <p className="pathwayPanelEyebrow">For builders</p>
                <h3>Looking for a team</h3>
              </div>
              <div className="pathwayHolocronContainer">
                <PathwayHolocronWidget type="tetrahedron" active={active === "team"} />
              </div>
            </div>
            <p className="pathwayPanelDescription">
              Find startup circles and collaborators with the context to move from a good conversation to a useful next step.
            </p>
            <Link className="pathwayButton pathwayButtonBuilder" href="/communities">
              Explore communities
            </Link>
          </article>
          <article
            className={`pathwayPanel pathwayPanelFounder ${active === "idea" ? "active" : ""}`}
            onPointerEnter={() => setActive("idea")}
            onPointerLeave={() => setActive(null)}
          >
            <div className="pathwayPanelTop">
              <div className="pathwayPanelHeader">
                <p className="pathwayPanelEyebrow">For founders</p>
                <h3>Start up your idea</h3>
              </div>
              <div className="pathwayHolocronContainer">
                <PathwayHolocronWidget type="cube" active={active === "idea"} />
              </div>
            </div>
            <p className="pathwayPanelDescription">
              Set up one shared home for your people, priorities, and the first milestones that make the idea real.
            </p>
            <Link
              className="pathwayButton pathwayButtonFounder"
              href={isAuthenticated ? "/workspace" : "/login?redirect=/workspace"}
            >
              Start your workspace
            </Link>
          </article>
        </div>
      </div>
    </section>
  );
}





