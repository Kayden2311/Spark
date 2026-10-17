import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => cleanup());

// next/font is compiled by Next.js; tests only need its class names.
vi.mock("next/font/google", () => ({ Plus_Jakarta_Sans: () => ({ className: "font-sans", variable: "font-sans-var", style: {} }) }));
