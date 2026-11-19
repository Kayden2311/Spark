import type { FastifyInstance } from "fastify";

import { problem } from "../responses.js";
import { MUTATION_RATE_LIMIT } from "../session-guard.js";
import type { MemberGuard } from "../workspace/guard.js";
import { accessDenied, communityParams, mapOutcome, noQuery, runCommunity, type Mapped } from "./access.js";
import { NO_NUL, REPORT_RATE_LIMIT, commentNotFound, commentParams, postNotFound, postParams, runWrite } from "./content.js";

// Reports and moderation: every route needs a session and answers private, no-store (the guard sets it,
// the error handler repeats it). No response ever carries a reporter: reporters have no endpoint to read
// a report back, and the queue shows none.

const REASONS = ["spam", "harassment", "off_topic", "misinformation", "self_promotion", "other"] as const;
const ACTIONS = ["hide", "dismiss", "restore"] as const;

// Lengths are generous upper bounds; trimming and the exact limits are the database's (22023 -> invalid_input).
const reportBody = {
  type: "object",
  required: ["reason"],
  propertyNames: { enum: ["reason", "details"] },
  properties: {
    reason: { type: "string", enum: REASONS },
    details: { type: "string", maxLength: 4000, pattern: NO_NUL },
  },
  additionalProperties: false,
} as const;

const moderationBody = {
  type: "object",
  required: ["action", "reason"],
  propertyNames: { enum: ["action", "reason"] },
  properties: {
    action: { type: "string", enum: ACTIONS },
    reason: { type: "string", maxLength: 4000, pattern: NO_NUL },
  },
  additionalProperties: false,
} as const;

const reportResponse = {
  type: "object",
  properties: { report: { type: "object", properties: { id: { type: "string" }, status: { type: "string" } } } },
} as const;

const moderationResponse = {
  type: "object",
  properties: { moderation: { type: "string" }, reportsClosed: { type: "integer" }, changed: { type: "boolean" }, version: { type: "integer" } },
} as const;

const queueResponse = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          target: {
            type: "object",
            properties: {
              kind: { type: "string" },
              id: { type: "string" },
              postId: { type: "string" },
              title: { type: "string" },
              excerpt: { type: "string" },
              authorName: { type: "string" },
              moderation: { type: "string" },
            },
          },
          openReports: { type: "integer" },
          reasons: { type: "array", items: { type: "object", properties: { reason: { type: "string" }, count: { type: "integer" } } } },
          latestDetails: { type: "array", items: { type: "string" } },
          firstReportedAt: { type: "string" },
          lastReportedAt: { type: "string" },
        },
      },
    },
  },
} as const;

const ownContent: Mapped = [409, "Conflict", "own_content", "You cannot report your own content."];

type Kind = "post" | "comment";

const reportOutcomes: Record<Kind, Record<string, Mapped>> = {
  post: { not_found: postNotFound, own_content: ownContent },
  comment: { not_found: commentNotFound, own_content: ownContent },
};
const moderateOutcomes: Record<Kind, Record<string, Mapped>> = {
  post: { not_found: postNotFound, forbidden: accessDenied },
  comment: { not_found: commentNotFound, forbidden: accessDenied },
};

interface QueueRow {
  target_kind: string;
  target_id: string;
  post_id: string;
  post_title: string;
  excerpt: string;
  author_name: string;
  moderation_status: string;
  open_reports: string | number;
  reasons: Array<{ reason: string; count: number | string }>;
  latest_details: string[];
  first_reported_at: Date | string;
  last_reported_at: Date | string;
}

const iso = (value: Date | string) => new Date(value).toISOString();

// Explicit columns and an explicit mapping: nothing but these fields can reach a response.
const QUEUE_SQL = `SELECT target_kind, target_id, post_id, post_title, excerpt, author_name, moderation_status, open_reports, reasons,
  latest_details, first_reported_at, last_reported_at FROM spark.community_report_queue($1::uuid)`;

const targets = [
  { kind: "post", path: "posts/:postId", idParam: "postId", params: postParams },
  { kind: "comment", path: "comments/:commentId", idParam: "commentId", params: commentParams },
] as const;

export function registerModerationRoutes(app: FastifyInstance, guard: MemberGuard): void {
  for (const { kind, path, idParam, params } of targets) {
    app.post<{ Params: Record<string, string>; Body: { reason: (typeof REASONS)[number]; details?: string } }>(
      `/api/v1/${path}/reports`,
      {
        config: REPORT_RATE_LIMIT,
        schema: {
          description: `Reports a ${kind}. 201 for a new report, 200 with the same shape when the caller already has an open report on it. `
            + "Neither answer carries a Location header: reporters have no endpoint to read a report back.",
          params,
          querystring: noQuery,
          body: reportBody,
          response: { 200: reportResponse, 201: reportResponse },
        },
      },
      async (request, reply) => {
        const member = await guard.authenticate(request, reply);
        if (!member) return reply;
        const { reason, details } = request.body;
        const result = await runWrite(guard, request, reply, member, async (client) => {
          const reported = await client.query<{ outcome: string; report_id: string | null }>(
            "SELECT outcome, report_id FROM spark.ws_report_content($1, $2::uuid, $3, $4)",
            [kind, request.params[idParam], reason, details ?? null],
          );
          const row = reported.rows[0];
          const mapped = mapOutcome(reportOutcomes[kind], row?.outcome, "reported", "already_reported");
          if (mapped) return { mapped };
          if (!row?.report_id) throw new Error("Report outcome has no id");
          return { id: row.report_id, created: row.outcome === "reported" };
        });
        if (reply.sent || !result) return reply;
        if (result.mapped) return problem(request, reply, ...result.mapped);
        return reply.code(result.created ? 201 : 200).send({ report: { id: result.id, status: "open" } });
      },
    );

    app.post<{ Params: Record<string, string>; Body: { action: (typeof ACTIONS)[number]; reason: string } }>(
      `/api/v1/${path}/moderation`,
      {
        config: MUTATION_RATE_LIMIT,
        schema: {
          description: `Hides or restores a ${kind}, or dismisses its open reports. Needs an owner or moderator role in the community. The answer carries the target's new version.`,
          params,
          querystring: noQuery,
          body: moderationBody,
          response: { 200: moderationResponse },
        },
      },
      async (request, reply) => {
        const member = await guard.authenticate(request, reply);
        if (!member) return reply;
        const { action, reason } = request.body;
        const result = await runWrite(guard, request, reply, member, async (client) => {
          const moderated = await client.query<{ outcome: string; moderation_status: string | null; reports_closed: number | null }>(
            "SELECT outcome, moderation_status, reports_closed FROM spark.ws_moderate_content($1, $2::uuid, $3, $4)",
            [kind, request.params[idParam], action, reason],
          );
          const row = moderated.rows[0];
          const mapped = mapOutcome(moderateOutcomes[kind], row?.outcome, "ok", "unchanged");
          if (mapped) return { mapped };
          if (!row?.moderation_status) throw new Error("Moderation outcome has no status");
          // The status change bumped the version: read it back so clients can send a correct If-Match next.
          const current = await client.query<{ version: number }>(
            `SELECT version FROM spark.community_${kind}($1::uuid)`,
            [request.params[idParam]],
          );
          const version = current.rows[0]?.version;
          if (version === undefined) throw new Error("Moderated target is not readable");
          return { moderation: row.moderation_status, reportsClosed: Number(row.reports_closed ?? 0), changed: row.outcome === "ok", version };
        });
        if (reply.sent || !result) return reply;
        if (result.mapped) return problem(request, reply, ...result.mapped);
        return result;
      },
    );
  }

  app.get<{ Params: { communityId: string } }>(
    "/api/v1/communities/:communityId/reports",
    {
      schema: {
        description: "The open reports of a community, one entry per reported post or comment. Owners and moderators only.",
        params: communityParams,
        querystring: noQuery,
        response: { 200: queueResponse },
      },
    },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const rows = await runCommunity(guard, request, reply, member, async (client) =>
        (await client.query<QueueRow>(QUEUE_SQL, [request.params.communityId])).rows);
      if (reply.sent || !rows) return reply;
      return {
        items: rows.map((row) => ({
          target: {
            kind: row.target_kind,
            id: row.target_id,
            postId: row.post_id,
            title: row.post_title,
            excerpt: row.excerpt,
            authorName: row.author_name,
            moderation: row.moderation_status,
          },
          openReports: Number(row.open_reports),
          reasons: row.reasons.map((r) => ({ reason: r.reason, count: Number(r.count) })),
          latestDetails: row.latest_details,
          firstReportedAt: iso(row.first_reported_at),
          lastReportedAt: iso(row.last_reported_at),
        })),
      };
    },
  );
}
