"use client";

import { useEffect, useRef } from "react";

type Dot = { x: number; y: number; originX: number; originY: number; targetX: number; targetY: number; size: number };

const maxDots = 700;

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
          const distance = Math.hypot(dx, dy) || 1;
          const push = active ? Math.max(0, 1 - distance / 155) * 52 : 0;
          dot.targetX = dot.originX + dx / distance * push;
          dot.targetY = dot.originY + dy / distance * push;
        }
        pendingPointer = false;
      }

      context.shadowBlur = 6;
      context.shadowColor = "rgba(16, 185, 129, .75)";
      for (const dot of dots) {
        dot.x += (dot.targetX - dot.x) * .2;
        dot.y += (dot.targetY - dot.y) * .2;
        moving ||= Math.abs(dot.targetX - dot.x) > .2 || Math.abs(dot.targetY - dot.y) > .2;
        context.beginPath();
        context.fillStyle = "rgba(5, 150, 105, .88)";
        context.arc(dot.x, dot.y, dot.size, 0, Math.PI * 2);
        context.fill();
      }

      frame = moving ? requestAnimationFrame(draw) : 0;
    };

    const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio, 2);
      canvas.width = Math.round(bounds.width * ratio);
      canvas.height = Math.round(bounds.height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const columns = Math.ceil(Math.sqrt(maxDots * bounds.width / bounds.height));
      const rows = Math.ceil(maxDots / columns);
      dots = Array.from({ length: maxDots }, (_, index) => {
        const x = ((index % columns) + .5) * bounds.width / columns;
        const y = (Math.floor(index / columns) + .5) * bounds.height / rows;
        return { x, y, originX: x, originY: y, targetX: x, targetY: y, size: index % 3 === 0 ? 1.8 : 1.25 };
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
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", move);
    };
  }, []);

  return <canvas ref={canvasRef} className="heroParticleMotion" aria-hidden="true" />;
}
