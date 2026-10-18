"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiError, DEFAULT_FALLBACK_MESSAGES, NETWORK_ERROR_MESSAGE, toApiError } from "../../_lib/http";

export type MethodologyId = "scrum" | "kanban" | "waterfall";
export type StatusCategory = "backlog" | "todo" | "in_progress" | "done";

export interface StatusTemplate {
  name: string;
  category: StatusCategory;
  wipLimit: number | null;
}

/** One entry of GET /api/v1/methodologies. */
export interface MethodologyTemplate {
  id: MethodologyId;
  name: string;
  tagline: string;
  bestFor: string;
  planningObject: string;
  practices: string[];
  metrics: string[];
  statuses: StatusTemplate[];
  defaults: { sprintLengthDays: number | null; phaseNames: string[] };
}

/** Accent colour per methodology, shared by the picker and project screens. */
export const METHODOLOGY_ACCENTS: Record<MethodologyId, string> = { scrum: "#2563eb", kanban: "#1baf7a", waterfall: "#d97706" };

export async function fetchMethodologies(signal?: AbortSignal): Promise<MethodologyTemplate[]> {
  let response: Response;
  try {
    // The catalog is public: no cookie needed.
    response = await fetch("/api/v1/methodologies", { credentials: "omit", headers: { Accept: "application/json" }, signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, "network_error", NETWORK_ERROR_MESSAGE);
  }
  if (!response.ok) throw await toApiError(response, DEFAULT_FALLBACK_MESSAGES);
  const body = (await response.json()) as { items: MethodologyTemplate[] };
  return body.items;
}

/** Loads the methodology catalog once per mount; `reload` retries after a failure. */
export function useMethodologies() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ attempt: number; data: MethodologyTemplate[] | null; error: string | null }>({ attempt: -1, data: null, error: null });

  useEffect(() => {
    const controller = new AbortController();
    fetchMethodologies(controller.signal)
      .then((data) => setState({ attempt, data, error: null }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState((previous) => ({ attempt, data: previous.data, error: error instanceof ApiError ? error.message : "Something went wrong. Try again." }));
      });
    return () => controller.abort();
  }, [attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { data: state.data, error: state.attempt === attempt ? state.error : null, loading: state.attempt !== attempt, reload };
}
