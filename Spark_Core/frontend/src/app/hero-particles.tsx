"use client";

import { useEffect, useRef } from "react";

type Dot = {
  x: number;
  y: number;
  originX: number;
  originY: number;
  size: number;
  angle: number;
  phase: number;
};

const maxDots = 1600;

export function HeroParticles() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    let frame = 0;
    let dots: Dot[] = [];
    // Smooth moving bubble dome center (interpolates towards mouse)
    let domeX = -1000;
    let domeY = -1000;
    let targetX = -1000;
    let targetY = -1000;

    let sphereRadius = 160;
    let captureRadius = 290;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio, 2);
      canvas.width = Math.round(bounds.width * ratio);
      canvas.height = Math.round(bounds.height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);

      const baseDim = Math.max(bounds.height, Math.min(bounds.width * 0.65, 700));
      sphereRadius = Math.min(bounds.width * 0.42, Math.max(160, baseDim * 0.36));
      captureRadius = sphereRadius * 1.8;

      // Default initial position of the bubble block before hover
      if (targetX < -500) {
        targetX = bounds.width * 0.65;
        targetY = bounds.height * 0.48;
        domeX = targetX;
        domeY = targetY;
      }

      const columns = Math.ceil(Math.sqrt((maxDots * bounds.width) / bounds.height));
      const rows = Math.ceil(maxDots / columns);

      dots = Array.from({ length: maxDots }, (_, index) => {
        const x = (((index % columns) + 0.5) * bounds.width) / columns;
        const y = ((Math.floor(index / columns) + 0.5) * bounds.height) / rows;
        return {
          x,
          y,
          originX: x,
          originY: y,
          size: index % 3 === 0 ? 1.8 : 1.25,
          angle: index * 2.4,
          phase: x * 0.008 + y * 0.01,
        };
      });
    };

    const draw = (time: number) => {
      const bounds = canvas.getBoundingClientRect();
      context.clearRect(0, 0, bounds.width, bounds.height);

      if (motion.matches) {
        frame = requestAnimationFrame(draw);
        return;
      }

      const t = time * 0.0015;

      // Smoothly glide the entire bubble volume towards cursor target
      domeX += (targetX - domeX) * 0.08;
      domeY += (targetY - domeY) * 0.08;

      // Global breathing wave ripple inside the bubble block
      const bubbleBreath = Math.sin(t * 2.2) * 0.15;
      const currentRadius = sphereRadius * (1 + bubbleBreath * 0.4);

      context.shadowBlur = 12;
      context.shadowColor = "rgba(96, 165, 250, 0.85)";

      for (const dot of dots) {
        // Distance from dot to the moving 3D bubble center
        const dx = dot.originX - domeX;
        const dy = dot.originY - domeY;
        const distance = Math.hypot(dx, dy);

        // Spherical surface displacement calculation (Bubble wave volume)
        const normDist = distance / currentRadius;

        let curX = dot.originX;
        let curY = dot.originY;
        let inBubble = false;
        let depth = 0;

        if (normDist < 1.0) {
          inBubble = true;
          // 3D spherical dome elevation + harmonic ripple wave
          const elevation = Math.sqrt(1 - normDist * normDist); // 0 at edge, 1 at peak
          const waveRipple = Math.sin(normDist * Math.PI * 3 - t * 3.5) * 0.12 * elevation;
          depth = Math.max(0, elevation + waveRipple);

          // Radial displacement pushing outwards along sphere surface curvature
          const surfaceDisplace = (elevation * 0.45 + waveRipple * 0.5) * currentRadius * 0.35;
          const dirX = distance > 0 ? dx / distance : Math.cos(dot.angle);
          const dirY = distance > 0 ? dy / distance : Math.sin(dot.angle);

          curX = dot.originX + dirX * surfaceDisplace;
          curY = dot.originY + dirY * surfaceDisplace;
        } else if (distance < captureRadius) {
          // Subtle cloth tension suction towards bubble edge
          const suction = ((captureRadius - distance) / (captureRadius - currentRadius)) * 8;
          const dirX = dx / distance;
          const dirY = dy / distance;
          curX = dot.originX - dirX * suction;
          curY = dot.originY - dirY * suction;
        }

        // Smooth position transition
        dot.x += (curX - dot.x) * 0.25;
        dot.y += (curY - dot.y) * 0.25;

        // Render point with glowing bubble appearance
        const renderSize = dot.size * (inBubble ? 1 + depth * 1.35 : 1);

        context.beginPath();
        if (inBubble && depth > 0.25) {
          context.fillStyle = `rgba(96, 165, 250, ${Math.min(1, 0.7 + depth * 0.35)})`;
          context.shadowBlur = depth * 12;
        } else {
          context.fillStyle = "rgba(37, 99, 235, 0.7)";
          context.shadowBlur = 0;
        }

        context.globalAlpha = inBubble ? 0.6 + depth * 0.4 : 0.38;
        context.arc(dot.x, dot.y, Math.max(0.7, renderSize), 0, Math.PI * 2);
        context.fill();
      }

      context.globalAlpha = 1;
      context.shadowBlur = 0;
      frame = requestAnimationFrame(draw);
    };

    const move = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      targetX = event.clientX - bounds.left;
      targetY = event.clientY - bounds.top;
    };

    const leave = () => {
      const bounds = canvas.getBoundingClientRect();
      targetX = bounds.width * 0.65;
      targetY = bounds.height * 0.48;
    };

    resize();
    frame = requestAnimationFrame(draw);

    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerleave", leave, { passive: true });

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerleave", leave);
    };
  }, []);

  return <canvas ref={canvasRef} className="heroParticleMotion" aria-hidden="true" />;
}

