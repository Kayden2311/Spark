import type { FastifyInstance } from "fastify";

import { ADMINS, COMMUNITY_STAFF, type StaffGuard } from "./guard.js";

const count = { type: "integer", minimum: 0 } as const;
const daysQuery = {
  type: "object",
  properties: { days: { type: "integer", minimum: 7, maximum: 365, default: 30 } },
  additionalProperties: false,
} as const;

const dayPoint = {
  type: "object",
  properties: {
    day: { type: "string", format: "date" },
    signups: count, activeUsers: count, signIns: count, posts: count, comments: count, reportsOpened: count, reportsClosed: count,
  },
} as const;

const periodTotals = {
  type: "object",
  properties: { signups: count, signIns: count, posts: count, comments: count, reportsOpened: count, reportsClosed: count, avgActiveUsers: { type: "number" } },
} as const;

interface SeriesRow {
  day: string;
  signups: string;
  active_users: string;
  sign_ins: string;
  posts: string;
  comments: string;
  reports_opened: string;
  reports_closed: string;
}

type Point = { day: string; signups: number; activeUsers: number; signIns: number; posts: number; comments: number; reportsOpened: number; reportsClosed: number };

function toPoint(row: SeriesRow): Point {
  return {
    day: row.day,
    signups: Number(row.signups),
    activeUsers: Number(row.active_users),
    signIns: Number(row.sign_ins),
    posts: Number(row.posts),
    comments: Number(row.comments),
    reportsOpened: Number(row.reports_opened),
    reportsClosed: Number(row.reports_closed),
  };
}

function totals(points: Point[]) {
  const sum = (key: keyof Omit<Point, "day">) => points.reduce((total, point) => total + point[key], 0);
  return {
    signups: sum("signups"),
    signIns: sum("signIns"),
    posts: sum("posts"),
    comments: sum("comments"),
    reportsOpened: sum("reportsOpened"),
    reportsClosed: sum("reportsClosed"),
    avgActiveUsers: points.length ? Math.round((sum("activeUsers") / points.length) * 10) / 10 : 0,
  };
}

// node-postgres returns DATE columns as text with this query (see the ::text casts below).
const SERIES_SQL = "SELECT day::text AS day, signups, active_users, sign_ins, posts, comments, reports_opened, reports_closed FROM spark.staff_activity_series($1)";

export function registerAnalyticsRoutes(app: FastifyInstance, guard: StaffGuard): void {
  // Daily activity for the range plus totals for the same-length period before it (when it fits in a year).
  app.get<{ Querystring: { days: number } }>(
    "/api/v1/admin/analytics/activity",
    {
      schema: {
        querystring: daysQuery,
        response: {
          200: {
            type: "object",
            required: ["days", "series", "current", "previous", "audience"],
            properties: {
              days: count,
              series: { type: "array", items: dayPoint },
              current: periodTotals,
              previous: { anyOf: [periodTotals, { type: "null" }] },
              audience: { type: "object", properties: { dau: count, wau: count, mau: count, totalUsers: count } },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, ADMINS);
      if (!staff) return reply;
      const { days } = request.query;
      const span = days * 2 <= 365 ? days * 2 : days;
      const data = await guard.run(request, reply, staff, async (client) => {
        // One transaction client runs one query at a time, so these run in sequence.
        const series = await client.query<SeriesRow>(SERIES_SQL, [span]);
        const audience = await client.query<Record<string, string>>("SELECT * FROM spark.staff_active_user_totals()");
        return { points: series.rows.map(toPoint), audience: audience.rows[0] };
      });
      if (reply.sent || !data) return reply;
      const current = data.points.slice(-days);
      const previous = span > days ? data.points.slice(0, data.points.length - days) : null;
      return {
        days,
        series: current,
        current: totals(current),
        previous: previous ? totals(previous) : null,
        audience: {
          dau: Number(data.audience?.dau ?? 0),
          wau: Number(data.audience?.wau ?? 0),
          mau: Number(data.audience?.mau ?? 0),
          totalUsers: Number(data.audience?.total_users ?? 0),
        },
      };
    },
  );

  app.get<{ Querystring: { days: number } }>(
    "/api/v1/admin/analytics/engagement",
    {
      schema: {
        querystring: daysQuery,
        response: {
          200: {
            type: "object",
            properties: { days: count, cells: { type: "array", items: { type: "object", properties: { dow: count, hour: count, events: count } } } },
          },
        },
      },
    },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, ADMINS);
      if (!staff) return reply;
      const rows = await guard.run(request, reply, staff, async (client) =>
        (await client.query<{ dow: number; hour: number; events: string }>("SELECT * FROM spark.staff_engagement_heatmap($1)", [request.query.days])).rows);
      if (reply.sent || !rows) return reply;
      return { days: request.query.days, cells: rows.map((row) => ({ dow: row.dow, hour: row.hour, events: Number(row.events) })) };
    },
  );

  app.get<{ Querystring: { weeks: number } }>(
    "/api/v1/admin/analytics/retention",
    {
      schema: {
        querystring: { type: "object", properties: { weeks: { type: "integer", minimum: 4, maximum: 26, default: 8 } }, additionalProperties: false },
        response: {
          200: {
            type: "object",
            properties: {
              weeks: count,
              cohorts: {
                type: "array",
                items: { type: "object", properties: { week: { type: "string", format: "date" }, size: count, retained: { type: "array", items: count } } },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, ADMINS);
      if (!staff) return reply;
      const { weeks } = request.query;
      const rows = await guard.run(request, reply, staff, async (client) =>
        (await client.query<{ cohort_week: string; cohort_size: string; week_offset: number; active_users: string }>(
          "SELECT cohort_week::text AS cohort_week, cohort_size, week_offset, active_users FROM spark.staff_retention_cohorts($1)",
          [weeks],
        )).rows);
      if (reply.sent || !rows) return reply;
      const cohorts = new Map<string, { week: string; size: number; retained: number[] }>();
      for (const row of rows) {
        const cohort = cohorts.get(row.cohort_week) ?? { week: row.cohort_week, size: Number(row.cohort_size), retained: [] };
        cohort.retained[row.week_offset] = Number(row.active_users);
        cohorts.set(row.cohort_week, cohort);
      }
      // Weeks a cohort has lived through but showed no activity are zero, not missing.
      const thisWeek = new Date();
      return {
        weeks,
        cohorts: [...cohorts.values()].map((cohort) => {
          const elapsed = Math.min(weeks, Math.floor((thisWeek.getTime() - Date.parse(`${cohort.week}T00:00:00Z`)) / (7 * 86_400_000)) + 1);
          return { ...cohort, retained: Array.from({ length: Math.max(elapsed, 1) }, (_, index) => cohort.retained[index] ?? 0) };
        }),
      };
    },
  );

  app.get<{ Querystring: { days: number; limit: number } }>(
    "/api/v1/admin/analytics/top-communities",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { days: { type: "integer", minimum: 7, maximum: 365, default: 30 }, limit: { type: "integer", minimum: 1, maximum: 50, default: 8 } },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: { id: { type: "string" }, name: { type: "string" }, slug: { type: "string" }, posts: count, comments: count, newMembers: count, contributors: count },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, COMMUNITY_STAFF);
      if (!staff) return reply;
      const rows = await guard.run(request, reply, staff, async (client) =>
        (await client.query<Record<string, string>>("SELECT * FROM spark.staff_top_communities($1, $2)", [request.query.days, request.query.limit])).rows);
      if (reply.sent || !rows) return reply;
      return {
        items: rows.map((row) => ({
          id: row.community_id,
          name: row.name,
          slug: row.slug,
          posts: Number(row.posts),
          comments: Number(row.comments),
          newMembers: Number(row.new_members),
          contributors: Number(row.contributors),
        })),
      };
    },
  );
}
