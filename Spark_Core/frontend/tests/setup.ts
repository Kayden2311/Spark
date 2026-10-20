import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// The full suite renders many heavy pages in parallel; the default 1 s wait for findBy* queries made the
// first render of the board tests flaky under that load.
configure({ asyncUtilTimeout: 3000 });

afterEach(() => cleanup());

// next/font is compiled by Next.js; tests only need its class names.
vi.mock("next/font/google", () => ({ Plus_Jakarta_Sans: () => ({ className: "font-sans", variable: "font-sans-var", style: {} }) }));

// jsdom has no 2D canvas. Decorative canvases (the background dot field) already bail out on a null
// context; returning null here keeps jsdom from logging "Not implemented" for every render.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
