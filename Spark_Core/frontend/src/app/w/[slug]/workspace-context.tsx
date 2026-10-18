"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { Workspace } from "../_lib/api";

interface WorkspaceContextValue {
  workspace: Workspace;
  reload(): void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/** `value` is null while the workspace loads or failed; the layout only renders pages once it is set. */
export function WorkspaceProvider({ value, children }: { value: WorkspaceContextValue | null; children: ReactNode }) {
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

/** The workspace the current /w/[slug] route belongs to. Only valid below the workspace layout. */
export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside the workspace layout");
  return value;
}
