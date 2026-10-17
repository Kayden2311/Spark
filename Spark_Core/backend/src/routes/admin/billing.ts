import type { FastifyInstance } from "fastify";

import { pageSize, toPage } from "../pagination.js";
import { ADMINS, pageQueryProperties, readCursor, type StaffGuard } from "./guard.js";

const count = { type: "integer", minimum: 0 } as const;
const money = { type: "integer" } as const;
const SUBSCRIPTION_STATUSES = ["incomplete", "trialing", "active", "past_due", "paused", "cancelled", "expired"] as const;
const INVOICE_STATUSES = ["draft", "open", "paid", "void", "uncollectible"] as const;

const n = (value: string | number | null | undefined) => Number(value ?? 0);
const iso = (value: Date | null) => value?.toISOString() ?? null;

/**
 * Billing insights read from Spark's own subscription, invoice and payment-event records.
 * No payment provider is connected yet, so these routes are read-only.
 */
export function registerBillingRoutes(app: FastifyInstance, guard: StaffGuard): void {
  app.get(
    "/api/v1/admin/billing/overview",
    {
      schema: {
        response: {
          200: {
            type: "object",
            required: ["counts", "revenue", "planMix"],
            properties: {
              counts: {
                type: "object",
                properties: { freeWorkspaces: count, trialing: count, paying: count, pastDue: count, cancelled30d: count, newPaid30d: count, failedPayments30d: count },
              },
              revenue: {
                type: "array",
                items: { type: "object", properties: { currency: { type: "string" }, mrrMinor: money, arrMinor: money, collected30dMinor: money, openMinor: money, uncollectibleMinor: money } },
              },
              planMix: {
                type: "array",
                items: {
                  type: "object",
                  properties: { code: { type: "string" }, name: { type: "string" }, billingKind: { type: "string" }, subscriptions: count, currency: { type: ["string", "null"] }, mrrMinor: money },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, ADMINS);
      if (!staff) return reply;
      const data = await guard.run(request, reply, staff, async (client) => {
        const counts = await client.query<Record<string, string>>("SELECT * FROM spark.staff_billing_counts()");
        const revenue = await client.query<Record<string, string>>("SELECT * FROM spark.staff_billing_revenue()");
        const mix = await client.query<Record<string, string>>("SELECT * FROM spark.staff_billing_plan_mix()");
        return { counts: counts.rows[0] ?? {}, revenue: revenue.rows, mix: mix.rows };
      });
      if (reply.sent || !data) return reply;
      const c = data.counts;
      return {
        counts: {
          freeWorkspaces: n(c.free_workspaces),
          trialing: n(c.trialing),
          paying: n(c.paying),
          pastDue: n(c.past_due),
          cancelled30d: n(c.cancelled_30d),
          newPaid30d: n(c.new_paid_30d),
          failedPayments30d: n(c.failed_payments_30d),
        },
        revenue: data.revenue.map((row) => ({
          currency: row.currency,
          mrrMinor: n(row.mrr_minor),
          arrMinor: n(row.mrr_minor) * 12,
          collected30dMinor: n(row.collected_30d_minor),
          openMinor: n(row.open_minor),
          uncollectibleMinor: n(row.uncollectible_minor),
        })),
        planMix: data.mix.map((row) => ({
          code: row.plan_code,
          name: row.plan_name,
          billingKind: row.billing_kind,
          subscriptions: n(row.subscriptions),
          currency: row.currency ?? null,
          mrrMinor: n(row.mrr_minor),
        })),
      };
    },
  );

  app.get<{ Querystring: { months: number } }>(
    "/api/v1/admin/billing/mrr",
    {
      schema: {
        querystring: { type: "object", properties: { months: { type: "integer", minimum: 3, maximum: 24, default: 12 } }, additionalProperties: false },
        response: {
          200: {
            type: "object",
            properties: {
              months: count,
              series: {
                type: "array",
                items: { type: "object", properties: { month: { type: "string", format: "date" }, currency: { type: "string" }, mrrMinor: money, newPaid: count, churned: count } },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, ADMINS);
      if (!staff) return reply;
      const rows = await guard.run(request, reply, staff, async (client) =>
        (await client.query<Record<string, string>>(
          "SELECT month::text AS month, currency, mrr_minor, new_paid, churned FROM spark.staff_billing_mrr_series($1)",
          [request.query.months],
        )).rows);
      if (reply.sent || !rows) return reply;
      return {
        months: request.query.months,
        series: rows.map((row) => ({ month: row.month, currency: row.currency, mrrMinor: n(row.mrr_minor), newPaid: n(row.new_paid), churned: n(row.churned) })),
      };
    },
  );

  app.get<{ Querystring: { status?: (typeof SUBSCRIPTION_STATUSES)[number]; kind?: "free" | "paid"; cursor?: string; limit?: number } }>(
    "/api/v1/admin/billing/subscriptions",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { status: { type: "string", enum: SUBSCRIPTION_STATUSES }, kind: { type: "string", enum: ["free", "paid"] }, ...pageQueryProperties },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            required: ["items", "nextCursor"],
            properties: {
              nextCursor: { type: ["string", "null"] },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    createdAt: { type: "string", format: "date-time" },
                    workspace: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, slug: { type: "string" } } },
                    plan: { type: "object", properties: { code: { type: "string" }, name: { type: "string" }, billingKind: { type: "string" } } },
                    status: { type: "string", enum: SUBSCRIPTION_STATUSES },
                    interval: { type: ["string", "null"] },
                    amountMinor: { type: ["integer", "null"] },
                    currency: { type: ["string", "null"] },
                    mrrMinor: money,
                    periodEnd: { type: ["string", "null"], format: "date-time" },
                    trialEndsAt: { type: ["string", "null"], format: "date-time" },
                    cancelAtPeriodEnd: { type: "boolean" },
                    cancelledAt: { type: ["string", "null"], format: "date-time" },
                    provider: { type: ["string", "null"] },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, ADMINS);
      if (!staff) return reply;
      const cursor = readCursor(request, reply, request.query.cursor);
      if (cursor === undefined) return reply;
      const limit = pageSize(request.query.limit);
      const rows = await guard.run(request, reply, staff, async (client) =>
        (await client.query<Record<string, never>>(
          "SELECT *, created_at::text AS cursor_ts FROM spark.staff_list_subscriptions($1, $2, $3::timestamptz, $4, $5)",
          [request.query.status ?? null, request.query.kind ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
        )).rows as Array<Record<string, unknown>>);
      if (reply.sent || !rows) return reply;
      return toPage(
        rows.map((row) => ({
          id: row.id as string,
          cursorTs: row.cursor_ts as string,
          createdAt: (row.created_at as Date).toISOString(),
          workspace: { id: row.workspace_id as string, name: row.workspace_name as string, slug: row.workspace_slug as string },
          plan: { code: row.plan_code as string, name: row.plan_name as string, billingKind: row.billing_kind as string },
          status: row.status as string,
          interval: (row.billing_interval as string | null) ?? null,
          amountMinor: row.amount_minor === null ? null : n(row.amount_minor as string),
          currency: (row.currency as string | null) ?? null,
          mrrMinor: n(row.mrr_minor as string),
          periodEnd: iso(row.period_end as Date | null),
          trialEndsAt: iso(row.trial_ends_at as Date | null),
          cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
          cancelledAt: iso(row.cancelled_at as Date | null),
          provider: (row.provider as string | null) ?? null,
        })),
        limit,
      );
    },
  );

  app.get<{ Querystring: { status?: (typeof INVOICE_STATUSES)[number]; cursor?: string; limit?: number } }>(
    "/api/v1/admin/billing/invoices",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { status: { type: "string", enum: INVOICE_STATUSES }, ...pageQueryProperties },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            required: ["items", "nextCursor"],
            properties: {
              nextCursor: { type: ["string", "null"] },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    issuedAt: { type: "string", format: "date-time" },
                    workspace: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
                    planName: { type: "string" },
                    status: { type: "string", enum: INVOICE_STATUSES },
                    currency: { type: "string" },
                    subtotalMinor: money,
                    discountMinor: money,
                    taxMinor: money,
                    totalMinor: money,
                    dueAt: { type: ["string", "null"], format: "date-time" },
                    paidAt: { type: ["string", "null"], format: "date-time" },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const staff = await guard.authorize(request, reply, ADMINS);
      if (!staff) return reply;
      const cursor = readCursor(request, reply, request.query.cursor);
      if (cursor === undefined) return reply;
      const limit = pageSize(request.query.limit);
      const rows = await guard.run(request, reply, staff, async (client) =>
        (await client.query(
          "SELECT *, issued_at::text AS cursor_ts FROM spark.staff_list_invoices($1, $2::timestamptz, $3, $4)",
          [request.query.status ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
        )).rows as Array<Record<string, unknown>>);
      if (reply.sent || !rows) return reply;
      return toPage(
        rows.map((row) => ({
          id: row.id as string,
          cursorTs: row.cursor_ts as string,
          issuedAt: (row.issued_at as Date).toISOString(),
          workspace: { id: row.workspace_id as string, name: row.workspace_name as string },
          planName: row.plan_name as string,
          status: row.status as string,
          currency: row.currency as string,
          subtotalMinor: n(row.subtotal_minor as string),
          discountMinor: n(row.discount_minor as string),
          taxMinor: n(row.tax_minor as string),
          totalMinor: n(row.total_minor as string),
          dueAt: iso(row.due_at as Date | null),
          paidAt: iso(row.paid_at as Date | null),
        })),
        limit,
      );
    },
  );
}
