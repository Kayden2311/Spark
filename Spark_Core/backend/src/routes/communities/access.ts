import type { FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { problem } from "../responses.js";
import type { Member, MemberGuard } from "../workspace/guard.js";

/** [status, title, code, detail] for problem(). */
export type Mapped = [number, string, string, string];

export const communityNotFound: Mapped = [404, "Not Found", "community_not_found", "Community not found."];
export const workspaceNotFound: Mapped = [404, "Not Found", "workspace_not_found", "Workspace does not exist."];
export const accessDenied: Mapped = [403, "Forbidden", "insufficient_role", "Your role in this community does not allow this."];

const uuid = { type: "string", format: "uuid" } as const;

export const communityParams = {
  type: "object",
  required: ["communityId"],
  properties: { communityId: uuid },
  additionalProperties: false,
} as const;

export const noQuery = { type: "object", properties: {}, additionalProperties: false, maxProperties: 0 } as const;

// The community read functions (0031) raise these exact errors; any other P0002/42501 stays a 500.
function readDenial(error: unknown): Mapped | null {
  if (typeof error !== "object" || error === null || !("code" in error) || !("message" in error)) return null;
  if (error.code === "P0002" && error.message === "Community not found") return communityNotFound;
  if (error.code === "P0002" && error.message === "Workspace not found") return workspaceNotFound;
  if (error.code === "42501" && error.message === "Community access denied") return accessDenied;
  return null;
}

/**
 * guard.run plus the community read errors: a hidden or unknown community answers 404 and a visible one
 * without the needed standing 403. Returns undefined once a response was sent.
 */
export async function runCommunity<T>(
  guard: MemberGuard,
  request: FastifyRequest,
  reply: FastifyReply,
  member: Member,
  work: (client: PoolClient) => Promise<T>,
): Promise<T | undefined> {
  try {
    return await guard.run(request, reply, member, work);
  } catch (error) {
    const mapped = readDenial(error);
    if (!mapped) throw error;
    void problem(request, reply, ...mapped);
    return undefined;
  }
}

/** Looks up a mapped outcome; an outcome outside the table and the allowed list throws (500). */
export function mapOutcome(table: Record<string, Mapped>, outcome: string | undefined, ...allowed: string[]): Mapped | null {
  const mapped = outcome ? table[outcome] : undefined;
  if (mapped) return mapped;
  if (!outcome || !allowed.includes(outcome)) throw new Error(`Unexpected community outcome: ${outcome ?? "none"}`);
  return null;
}
