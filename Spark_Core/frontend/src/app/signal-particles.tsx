"use client";

import { useEffect, useRef } from "react";

type Dot = {
  originX: number;
  originY: number;
  size: number;
  phase: number;
  strand: number;
};

export function SignalParticles({
  className = "globalBackgroundParticles",
}: {
  className?: string;
} = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    let frame = 0;
    let dots: Dot[] = [];
    let mouseX = -1000;
    let mouseY = -1000;
    let targetMouseX = -1000;
    let targetMouseY = -1000;

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio, 2);
      canvas.width = Math.round(bounds.width * ratio);
      canvas.height = Math.round(bounds.height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);

      // Relaxed, spacious grid spacing (~36px X, ~34px Y)
      const spacingX = 36;
      const spacingY = 34;
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
            size: (c + r) % 3 === 0 ? 1.4 : 0.95,
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

      // Smoothly interpolate mouse target
      mouseX += (targetMouseX - mouseX) * 0.1;
      mouseY += (targetMouseY - mouseY) * 0.1;

      const maxProximity = 160;

      for (const dot of dots) {
        // Morphing signal wave displacement (exact LiveSignalFlow algorithm)
        const waveX = Math.sin(dot.originY * 0.015 + t * 1.6) * 5 * dot.strand;
        const waveY = Math.cos(dot.originX * 0.012 + t * 1.4) * 6 + Math.sin(dot.phase + t * 2.0) * 4;

        let curX = dot.originX + waveX;
        let curY = dot.originY + waveY;

        let glowBonus = 0;
        if (targetMouseX > 0) {
          const dx = curX - mouseX;
          const dy = curY - mouseY;
          const dist = Math.hypot(dx, dy);

          if (dist < maxProximity) {
            const factor = 1 - dist / maxProximity;
            const push = factor * 10;
            curX += dist > 0 ? (dx / dist) * push : 0;
            curY += dist > 0 ? (dy / dist) * push : 0;
            glowBonus = factor * 0.45;
          }
        }

        // Gentle breathing opacity wave
        const alpha = Math.min(1, 0.15 + (Math.sin(dot.phase + t * 1.8) + 1) * 0.18 + glowBonus);

        context.beginPath();
        if (glowBonus > 0.15) {
          context.fillStyle = "rgba(96, 165, 250, " + alpha + ")";
        } else {
          context.fillStyle = "rgba(37, 99, 235, " + alpha + ")";
        }
        context.arc(curX, curY, dot.size + glowBonus * 0.6, 0, Math.PI * 2);
        context.fill();
      }

      frame = requestAnimationFrame(draw);
    };

    const move = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      targetMouseX = event.clientX - bounds.left;
      targetMouseY = event.clientY - bounds.top;
    };

    const leave = () => {
      targetMouseX = -1000;
      targetMouseY = -1000;
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

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
