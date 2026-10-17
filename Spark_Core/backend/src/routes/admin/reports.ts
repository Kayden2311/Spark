import type { FastifyInstance } from "fastify";

import { pageSize, toPage, withoutCursor } from "../pagination.js";
import { problem } from "../responses.js";
import { CONTENT_STAFF, MUTATION_RATE_LIMIT, expectOutcome, idParams, pageQueryProperties, readCursor, reasonProperty, type StaffGuard } from "./guard.js";

const REPORT_STATUSES = ["open", "reviewing", "resolved", "dismissed"] as const;
type ReportStatus = (typeof REPORT_STATUSES)[number];

interface ReportRow {
  id: string;
  cursor_ts: string;
  community_id: string;
  community_name: string | null;
  community_slug: string | null;
  post_id: string | null;
  comment_id: string | null;
  reporter_user_id: string;
  reporter_name: string | null;
  reason_code: string;
  details: string | null;
  status: ReportStatus;
  created_at: Date;
  resolved_at: Date | null;
  post_title: string | null;
  post_body: string | null;
  post_moderation_status: string | null;
  comment_body: string | null;
  comment_moderation_status: string | null;
}

const reportSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    status: { type: "string", enum: REPORT_STATUSES },
    reasonCode: { type: "string" },
    details: { type: ["string", "null"] },
    createdAt: { type: "string", format: "date-time" },
    resolvedAt: { type: ["string", "null"], format: "date-time" },
    community: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, slug: { type: "string" } } },
    reporter: { type: "object", properties: { id: { type: "string" }, displayName: { type: "string" } } },
    target: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["post", "comment"] },
        id: { type: "string" },
        title: { type: ["string", "null"] },
        body: { type: "string" },
        moderationStatus: { type: "string", enum: ["visible", "hidden"] },
      },
    },
  },
} as const;

function toReport(row: ReportRow) {
  const isComment = row.comment_id !== null;
  return {
    id: row.id,
    cursorTs: row.cursor_ts,
    status: row.status,
    reasonCode: row.reason_code,
    details: row.details,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    community: { id: row.community_id, name: row.community_name ?? "Unknown community", slug: row.community_slug ?? "" },
    // Reporter identity is visible only to staff who hold a reports role (enforced by staff_list_reports).
    reporter: { id: row.reporter_user_id, displayName: row.reporter_name ?? "Unknown member" },
    target: {
      kind: isComment ? "comment" : "post",
      id: (isComment ? row.comment_id : row.post_id) ?? "",
      title: isComment ? null : row.post_title,
      body: (isComment ? row.comment_body : row.post_body) ?? "",
      moderationStatus: (isComment ? row.comment_moderation_status : row.post_moderation_status) ?? "visible",
    },
  };
}

const LIST_SQL = "SELECT *, created_at::text AS cursor_ts FROM spark.staff_list_reports($1, $2, $3::timestamptz, $4, $5)";

export function registerReportRoutes(app: FastifyInstance, guard: StaffGuard): void {
  app.get<{ Querystring: { status?: ReportStatus; cursor?: string; limit?: number } }>(
    "/api/v1/admin/reports",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { status: { type: "string", enum: REPORT_STATUSES }, ...pageQueryProperties },
          additionalProperties: false,
        },
        response: {
          200: { type: "object", required: ["items", "nextCursor"], properties: { items: { type: "array", items: reportSchema }, nextCursor: { type: ["string", "null"] } } },
        },
      },
    },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, CONTENT_STAFF);
      if (!staff) return reply;
      const cursor = readCursor(request, reply, request.query.cursor);
      if (cursor === undefined) return reply;
      const limit = pageSize(request.query.limit);
      const rows = await guard.run(request, reply, staff, async (client) =>
        (await client.query<ReportRow>(LIST_SQL, [request.query.status ?? "open", null, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1])).rows);
      if (reply.sent || !rows) return reply;
      return toPage(rows.map(toReport), limit);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/admin/reports/:id",
    { schema: { params: idParams, response: { 200: reportSchema } } },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, CONTENT_STAFF);
      if (!staff) return reply;
      const rows = await guard.run(request, reply, staff, async (client) =>
        (await client.query<ReportRow>(LIST_SQL, [null, request.params.id, null, null, 1])).rows);
      if (reply.sent) return reply;
      const row = rows?.[0];
      if (!row) return problem(request, reply, 404, "Not Found", "report_not_found", "Report does not exist.");
      return withoutCursor(toReport(row));
    },
  );

  // Queue health for the range: flow in and out, current backlog and median time to a decision.
  app.get<{ Querystring: { days: number } }>(
    "/api/v1/admin/reports/stats",
    {
      schema: {
        querystring: { type: "object", properties: { days: { type: "integer", minimum: 7, maximum: 365, default: 30 } }, additionalProperties: false },
        response: {
          200: {
            type: "object",
            properties: { days: { type: "integer" }, opened: { type: "integer" }, closed: { type: "integer" }, backlog: { type: "integer" }, medianHoursToClose: { type: ["number", "null"] } },
          },
        },
      },
    },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, CONTENT_STAFF);
      if (!staff) return reply;
      const row = await guard.run(request, reply, staff, async (client) =>
        (await client.query<{ opened: string; closed: string; backlog: string; median_hours_to_close: string | null }>("SELECT * FROM spark.staff_report_stats($1)", [request.query.days])).rows[0]);
      if (reply.sent) return reply;
      return {
        days: request.query.days,
        opened: Number(row?.opened ?? 0),
        closed: Number(row?.closed ?? 0),
        backlog: Number(row?.backlog ?? 0),
        medianHoursToClose: row?.median_hours_to_close === null || row?.median_hours_to_close === undefined ? null : Number(row.median_hours_to_close),
      };
    },
  );

  // Who wrote the reported content and how often their content has been reported or hidden before.
  app.get<{ Params: { id: string } }>(
    "/api/v1/admin/reports/:id/context",
    {
      schema: {
        params: idParams,
        response: {
          200: {
            type: "object",
            properties: {
              author: {
                anyOf: [
                  {
                    type: "object",
                    properties: { id: { type: "string" }, displayName: { type: "string" }, status: { type: "string" }, joinedAt: { type: "string", format: "date-time" }, reportsAgainst: { type: "integer" }, hiddenContent: { type: "integer" } },
                  },
                  { type: "null" },
                ],
              },
              communityOpenReports: { type: "integer" },
              reporterReportsFiled: { type: "integer" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, CONTENT_STAFF);
      if (!staff) return reply;
      const rows = await guard.run(request, reply, staff, async (client) =>
        (await client.query<{ author_id: string | null; author_name: string; author_status: string; author_joined: Date; author_reports: string; author_hidden: string; community_open_reports: string; reporter_reports: string }>(
          "SELECT * FROM spark.staff_report_context($1)",
          [request.params.id],
        )).rows);
      if (reply.sent || !rows) return reply;
      const row = rows[0];
      if (!row) return problem(request, reply, 404, "Not Found", "report_not_found", "Report does not exist.");
      return {
        author: row.author_id
          ? { id: row.author_id, displayName: row.author_name, status: row.author_status, joinedAt: row.author_joined.toISOString(), reportsAgainst: Number(row.author_reports), hiddenContent: Number(row.author_hidden) }
          : null,
        communityOpenReports: Number(row.community_open_reports),
        reporterReportsFiled: Number(row.reporter_reports),
      };
    },
  );

  app.post<{ Params: { id: string }; Body: { action: "hide" | "restore" | "dismiss"; reason: string } }>(
    "/api/v1/admin/reports/:id/actions",
    {
      config: MUTATION_RATE_LIMIT,
      schema: {
        params: idParams,
        body: {
          type: "object",
          required: ["action", "reason"],
          properties: { action: { type: "string", enum: ["hide", "restore", "dismiss"] }, reason: reasonProperty },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, CONTENT_STAFF);
      if (!staff) return reply;
      const { action, reason } = request.body;
      const outcome = await guard.run(request, reply, staff, async (client) =>
        (await client.query<{ outcome: string }>("SELECT spark.staff_resolve_report($1, $2, $3) AS outcome", [
          request.params.id,
          action === "dismiss" ? "dismiss_report" : action,
          reason,
        ])).rows[0]?.outcome);
      if (reply.sent) return reply;
      if (outcome === "not_found") return problem(request, reply, 404, "Not Found", "report_not_found", "Report does not exist.");
      if (outcome === "already_closed") return problem(request, reply, 409, "Conflict", "report_already_closed", "This report has already been resolved or dismissed.");
      expectOutcome(outcome, "ok");
      return { id: request.params.id, status: action === "dismiss" ? "dismissed" : "resolved" };
    },
  );
}
