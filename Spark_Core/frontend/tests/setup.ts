import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => cleanup());

// next/font is compiled by Next.js; tests only need its class names.
vi.mock("next/font/google", () => ({ Plus_Jakarta_Sans: () => ({ className: "font-sans", variable: "font-sans-var", style: {} }) }));

// jsdom has no 2D canvas. Decorative canvases (the background dot field) already bail out on a null
// context; returning null here keeps jsdom from logging "Not implemented" for every render.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
