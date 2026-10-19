"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { ProjectDetail } from "../../../_lib/projects";

export type ToastTone = "success" | "error" | "info";

interface ProjectContextValue {
  project: ProjectDetail;
  /** Entity tag of `project`, for If-Match on project writes. */
  etag: string;
  /** Shows a toast in the project's one live region. */
  notify(text: string, tone?: ToastTone): void;
  /** Speaks a message to screen readers through the same live region, without a visible toast. */
  announce(text: string): void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ value, children }: { value: ProjectContextValue; children: ReactNode }) {
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

/** The project the current /w/[slug]/p/[key] route shows. Only valid below the project layout. */
export function useProject(): ProjectContextValue {
  const value = useContext(ProjectContext);
  if (!value) throw new Error("useProject must be used inside the project layout");
  return value;
}
