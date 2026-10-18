"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { Workspace } from "../_lib/api";

interface WorkspaceContextValue {
  workspace: Workspace;
  reload(): void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ workspace, reload, children }: WorkspaceContextValue & { children: ReactNode }) {
  return <WorkspaceContext.Provider value={{ workspace, reload }}>{children}</WorkspaceContext.Provider>;
}

/** The workspace the current /w/[slug] route belongs to. Only valid below the workspace layout. */
export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside the workspace layout");
  return value;
}
