"use client";

import { useEffect, useRef } from "react";

type Dot = { x: number; y: number; originX: number; originY: number; targetX: number; targetY: number; size: number; angle: number };

const maxDots = 1600;

export function HeroParticles() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    let frame = 0;
    let dots: Dot[] = [];
    let active = false;
    let pointerX = -1;
    let pointerY = -1;
    let pendingPointer = false;
    let sphereRadius = 154;
    let captureRadius = 270;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const draw = () => {
      const bounds = canvas.getBoundingClientRect();
      context.clearRect(0, 0, bounds.width, bounds.height);
      let moving = false;

      if (pendingPointer) {
        active = pointerX >= 0 && pointerX <= bounds.width && pointerY >= 0 && pointerY <= bounds.height;
        for (const dot of dots) {
          const dx = dot.originX - pointerX;
          const dy = dot.originY - pointerY;
          const distance = Math.hypot(dx, dy);
          const surface = Math.min(distance / sphereRadius, 1);
          const curve = active && surface < 1 ? sphereRadius * .12 * Math.sin(surface * Math.PI) : 0;
          const clothPull = active ? sphereRadius * .06 / (1 + distance / captureRadius) : 0;
          const directionX = distance ? dx / distance : Math.cos(dot.angle);
          const directionY = distance ? dy / distance : Math.sin(dot.angle);
          dot.targetX = dot.originX + directionX * (curve - clothPull);
          dot.targetY = dot.originY + directionY * (curve - clothPull);
        }
        pendingPointer = false;
      }

      const breathing = active ? 1 + Math.sin(performance.now() / 700) * .09 : 1;
      context.shadowBlur = active ? 14 : 7;
      context.shadowColor = active ? "rgba(96, 165, 250, .95)" : "rgba(59, 130, 246, .72)";
      for (const dot of dots) {
        dot.x += (dot.targetX - dot.x) * .2;
        dot.y += (dot.targetY - dot.y) * .2;
        moving ||= active || Math.abs(dot.targetX - dot.x) > .2 || Math.abs(dot.targetY - dot.y) > .2;
        const inSphere = active && Math.hypot(dot.x - pointerX, dot.y - pointerY) <= sphereRadius * 1.05;
        const x = inSphere ? pointerX + (dot.x - pointerX) * breathing : dot.x;
        const y = inSphere ? pointerY + (dot.y - pointerY) * breathing : dot.y;
        const depth = inSphere ? Math.max(0, 1 - Math.hypot(x - pointerX, y - pointerY) / sphereRadius) : 0;
        context.beginPath();
        context.fillStyle = active ? "rgba(96, 165, 250, .98)" : "rgba(37, 99, 235, .84)";
        context.globalAlpha = active ? .45 + depth * .55 : 1;
        context.arc(x, y, dot.size * (inSphere ? .9 + depth * .9 : 1), 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;

      frame = moving ? requestAnimationFrame(draw) : 0;
    };

    const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };

    const settle = () => {
      active = false;
      for (const dot of dots) {
        dot.targetX = dot.originX;
        dot.targetY = dot.originY;
      }
      schedule();
    };

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio, 2);
      canvas.width = Math.round(bounds.width * ratio);
      canvas.height = Math.round(bounds.height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      sphereRadius = Math.min(bounds.width, bounds.height) * .38;
      captureRadius = sphereRadius * 1.8;
      const columns = Math.ceil(Math.sqrt(maxDots * bounds.width / bounds.height));
      const rows = Math.ceil(maxDots / columns);
      dots = Array.from({ length: maxDots }, (_, index) => {
        const x = ((index % columns) + .5) * bounds.width / columns;
        const y = (Math.floor(index / columns) + .5) * bounds.height / rows;
        return { x, y, originX: x, originY: y, targetX: x, targetY: y, size: index % 3 === 0 ? 1.8 : 1.25, angle: index * 2.4 };
      });
      schedule();
    };

    const move = (event: PointerEvent) => {
      if (motion.matches) return;
      const bounds = canvas.getBoundingClientRect();
      pointerX = event.clientX - bounds.left;
      pointerY = event.clientY - bounds.top;
      pendingPointer = true;
      schedule();
    };

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerup", settle, { passive: true });
    window.addEventListener("pointercancel", settle, { passive: true });
    motion.addEventListener("change", settle);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", settle);
      window.removeEventListener("pointercancel", settle);
      motion.removeEventListener("change", settle);
    };
  }, []);

  return <canvas ref={canvasRef} className="heroParticleMotion" aria-hidden="true" />;
}
