import type { FastifyInstance } from "fastify";

import { DEFAULT_PAGE_SIZE, encodeCursor } from "../pagination.js";
import { problem } from "../responses.js";
import { MUTATION_RATE_LIMIT, expectOutcome, pageQueryProperties, readCursor } from "../session-guard.js";
import type { MemberGuard } from "./guard.js";

// Notification inbox and email preferences (M7). Notifications belong to the signed-in user across all of their
// workspaces, so no workspace appears in these paths. Every read and write is a spark.ws_* definer function that
// derives the actor from the session and applies visibility itself (recipient is the actor and the workspace is one
// of the actor's active ones); an unknown id, another user's id and an id in a workspace the actor left all answer 404.
//
// created_at has microsecond precision. A JavaScript Date keeps only milliseconds, so the list returns it as text:
// the opaque cursor carries PostgreSQL's own text form and Notification.createdAt is ISO 8601 with microseconds,
// which the client sends back verbatim as `before`. Neither value is ever re-serialised through a Date.

// A cheap, idempotent call a client makes per row or per badge refresh.
const FREQUENT_RATE_LIMIT = { rateLimit: { max: 120, timeWindow: 60 * 1000 } } as const;
const PEEK_LIMIT = 100;

const nullableString = { type: ["string", "null"] } as const;
const uuid = { type: "string", format: "uuid" } as const;

const notificationResponse = {
  type: "object",
  properties: {
    id: { type: "string" },
    kind: { type: "string" },
    title: { type: "string" },
    body: nullableString,
    resourceType: { type: "string" },
    resourceId: { type: "string" },
    link: nullableString,
    workspace: { type: "object", properties: { id: { type: "string" }, slug: { type: "string" }, name: { type: "string" } } },
    createdAt: { type: "string" },
    readAt: nullableString,
  },
} as const;

const listResponse = {
  type: "object",
  properties: { items: { type: "array", items: notificationResponse }, nextCursor: nullableString },
} as const;

const preferencesResponse = {
  type: "object",
  properties: {
    email: { type: "object", properties: { taskAssigned: { type: "boolean" }, dueReminders: { type: "boolean" }, weeklyDigest: { type: "boolean" } } },
    timezone: { type: "string" },
  },
} as const;

// Fastify's validator strips unknown keys instead of failing (removeAdditional); propertyNames makes them a 400.
const listQuery = {
  type: "object",
  propertyNames: { enum: ["unread", "cursor", "limit"] },
  properties: { unread: { type: "boolean", default: false }, ...pageQueryProperties },
  additionalProperties: false,
} as const;

const notificationParams = { type: "object", required: ["notificationId"], properties: { notificationId: uuid }, additionalProperties: false } as const;

const markOneBody = {
  type: "object",
  required: ["read"],
  propertyNames: { enum: ["read"] },
  properties: { read: { const: true } },
  additionalProperties: false,
} as const;

const markAllBody = {
  type: "object",
  required: ["read", "before"],
  propertyNames: { enum: ["read", "before"] },
  properties: { read: { const: true }, before: { type: "string", format: "date-time", maxLength: 64 } },
  additionalProperties: false,
} as const;

const preferencesBody = {
  type: "object",
  required: ["email", "timezone"],
  propertyNames: { enum: ["email", "timezone"] },
  properties: {
    email: {
      type: "object",
      required: ["taskAssigned", "dueReminders", "weeklyDigest"],
      propertyNames: { enum: ["taskAssigned", "dueReminders", "weeklyDigest"] },
      properties: { taskAssigned: { type: "boolean" }, dueReminders: { type: "boolean" }, weeklyDigest: { type: "boolean" } },
      additionalProperties: false,
    },
    timezone: { type: "string", minLength: 1, maxLength: 64 },
  },
  additionalProperties: false,
} as const;

interface PreferencesBody {
  email: { taskAssigned: boolean; dueReminders: boolean; weeklyDigest: boolean };
  timezone: string;
}

interface NotificationRow {
  id: string;
  tenant_id: string;
  workspace_slug: string;
  workspace_name: string;
  kind: string;
  title: string;
  body: string | null;
  resource_type: string;
  resource_id: string;
  link: string | null;
  created_at_iso: string;
  cursor_ts: string;
  read_at: Date | null;
}

interface PreferencesRow {
  task_assigned: boolean;
  due_reminders: boolean;
  weekly_digest: boolean;
  timezone: string;
}

// Microsecond text in UTC with an explicit offset: a valid date-time that JavaScript also parses.
const LIST_SQL = `SELECT n.id, n.tenant_id, n.workspace_slug, n.workspace_name, n.kind, n.title, n.body, n.resource_type, n.resource_id, n.link,
  to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS created_at_iso,
  n.created_at::text AS cursor_ts, n.read_at
  FROM spark.ws_list_notifications($1::boolean, $2::timestamptz, $3::uuid, $4::integer) n`;

const toNotification = (row: NotificationRow) => ({
  id: row.id,
  kind: row.kind,
  title: row.title,
  body: row.body,
  resourceType: row.resource_type,
  resourceId: row.resource_id,
  link: row.link,
  workspace: { id: row.tenant_id, slug: row.workspace_slug, name: row.workspace_name },
  createdAt: row.created_at_iso,
  readAt: row.read_at ? row.read_at.toISOString() : null,
});

const toPreferences = (row: PreferencesRow) => ({
  email: { taskAssigned: row.task_assigned, dueReminders: row.due_reminders, weeklyDigest: row.weekly_digest },
  timezone: row.timezone,
});

/** True for an instant the calendar and PostgreSQL both accept (not a leap second, not year 0000). */
function acceptableInstant(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime()) && !value.startsWith("0000");
}

export function registerNotificationRoutes(app: FastifyInstance, guard: MemberGuard): void {
  registerInboxRoutes(app, guard);
  registerPreferenceRoutes(app, guard);
}

function registerInboxRoutes(app: FastifyInstance, guard: MemberGuard): void {
  app.get<{ Querystring: { unread: boolean; cursor?: string; limit?: number } }>(
    "/api/v1/notifications",
    { schema: { querystring: listQuery, response: { 200: listResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const cursor = readCursor(request, reply, request.query.cursor);
      if (cursor === undefined) return reply;
      const limit = request.query.limit ?? DEFAULT_PAGE_SIZE;
      const page = await guard.run(request, reply, member, async (client) => {
        const before = [cursor?.createdAt ?? null, cursor?.id ?? null];
        // One extra row tells whether another page exists; the database caps a call at 100 rows, so a full
        // 100-row page asks for the next row separately.
        const fetched = await client.query<NotificationRow>(LIST_SQL, [request.query.unread, ...before, Math.min(limit + 1, PEEK_LIMIT)]);
        const rows = fetched.rows.slice(0, limit);
        const last = rows[rows.length - 1];
        let more = fetched.rows.length > limit;
        if (!more && limit === PEEK_LIMIT && fetched.rows.length === PEEK_LIMIT && last) {
          const next = await client.query<NotificationRow>(LIST_SQL, [request.query.unread, last.cursor_ts, last.id, 1]);
          more = next.rows.length > 0;
        }
        return { rows, nextCursor: more && last ? encodeCursor({ createdAt: last.cursor_ts, id: last.id }) : null };
      });
      if (reply.sent || !page) return reply;
      return { items: page.rows.map(toNotification), nextCursor: page.nextCursor };
    },
  );

  app.get(
    "/api/v1/notifications/unread-count",
    { config: FREQUENT_RATE_LIMIT, schema: { response: { 200: { type: "object", properties: { count: { type: "integer" } } } } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const result = await guard.run(request, reply, member, async (client) =>
        (await client.query<{ count: number }>("SELECT spark.ws_unread_notification_count() AS count")).rows[0]);
      if (reply.sent || !result) return reply;
      return { count: result.count };
    },
  );

  app.patch<{ Params: { notificationId: string }; Body: { read: true } }>(
    "/api/v1/notifications/:notificationId",
    { config: FREQUENT_RATE_LIMIT, schema: { params: notificationParams, body: markOneBody } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const outcome = await guard.run(request, reply, member, async (client) => {
        const marked = await client.query<{ outcome: string }>("SELECT outcome FROM spark.ws_mark_notification_read($1::uuid)", [request.params.notificationId]);
        expectOutcome(marked.rows[0]?.outcome, "ok", "not_found");
        return marked.rows[0]?.outcome;
      });
      if (reply.sent || !outcome) return reply;
      if (outcome === "not_found") return problem(request, reply, 404, "Not Found", "notification_not_found", "Notification does not exist.");
      return reply.code(204).send();
    },
  );

  app.patch<{ Body: { read: true; before: string } }>(
    "/api/v1/notifications",
    { config: MUTATION_RATE_LIMIT, schema: { body: markAllBody, response: { 200: { type: "object", properties: { updated: { type: "integer" } } } } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      // Passed to the database as the original text: a Date round trip would cut microseconds and leave the newest row unread.
      const { before } = request.body;
      if (!acceptableInstant(before)) {
        return problem(request, reply, 400, "Bad Request", "invalid_input", "before must be a valid ISO 8601 date-time with an offset.");
      }
      const result = await guard.run(request, reply, member, async (client) =>
        (await client.query<{ updated: number }>("SELECT updated FROM spark.ws_mark_notifications_read($1::timestamptz)", [before])).rows[0]);
      if (reply.sent || !result) return reply;
      return { updated: result.updated };
    },
  );
}

function registerPreferenceRoutes(app: FastifyInstance, guard: MemberGuard): void {
  const READ_SQL = "SELECT task_assigned, due_reminders, weekly_digest, timezone FROM spark.ws_get_notification_preferences()";

  app.get(
    "/api/v1/me/notification-preferences",
    { schema: { response: { 200: preferencesResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const row = await guard.run(request, reply, member, async (client) => (await client.query<PreferencesRow>(READ_SQL)).rows[0]);
      if (reply.sent) return reply;
      if (!row) throw new Error("Preferences are not readable");
      return toPreferences(row);
    },
  );

  app.put<{ Body: PreferencesBody }>(
    "/api/v1/me/notification-preferences",
    { config: MUTATION_RATE_LIMIT, schema: { body: preferencesBody, response: { 200: preferencesResponse } } },
    async (request, reply) => {
      const member = await guard.authenticate(request, reply);
      if (!member) return reply;
      const { email, timezone } = request.body;
      const row = await guard.run(request, reply, member, async (client) => {
        const stored = await client.query<{ outcome: string }>("SELECT outcome FROM spark.ws_set_notification_preferences($1, $2, $3, $4)", [
          email.taskAssigned, email.dueReminders, email.weeklyDigest, timezone,
        ]);
        expectOutcome(stored.rows[0]?.outcome, "ok");
        return (await client.query<PreferencesRow>(READ_SQL)).rows[0];
      });
      if (reply.sent) return reply;
      if (!row) throw new Error("Preferences are not readable");
      return toPreferences(row);
    },
  );
}
