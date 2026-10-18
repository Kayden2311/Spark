"use client";

import { Suspense } from "react";

import { useAdmin } from "../_components/admin-context";
import { ChartCard, ChartLegend, DonutChart, TrendChart } from "../_components/charts";
import { AlertIcon, BillingIcon, ChartIcon, PulseIcon, TrendIcon } from "../_components/icons";
import { Badge, Card, EmptyState, ErrorBanner, KpiCards, LoadMore, NoAccess, PageHeader, Panel, Segmented, SkeletonRows, Tag } from "../_components/ui";
import { query } from "../_lib/api";
import { canAccess } from "../_lib/access";
import { INVOICE_STATUS, SUBSCRIPTION_STATUS, formatCount, formatDate, formatMoney, humanize, shortMonth } from "../_lib/format";
import { CATEGORICAL, SERIES } from "../_lib/palette";
import type { BillingOverview, Invoice, MrrResponse, Subscription } from "../_lib/types";
import { useAdminData } from "../_lib/use-admin-data";
import { usePagedList } from "../_lib/use-paged-list";
import { useQueryState, useQueryUpdater } from "../_lib/use-query-state";

type View = "subscriptions" | "invoices";
const SUB_FILTERS = ["any", "active", "trialing", "past_due", "cancelled"] as const;
const INVOICE_FILTERS = ["any", "paid", "open", "uncollectible"] as const;
const KINDS = ["paid", "free", "all"] as const;

function Billing() {
  const { roles } = useAdmin();
  const allowed = canAccess(roles, "billing");
  const [view] = useQueryState<View>("view", "subscriptions", ["subscriptions", "invoices"]);
  const [subStatus, setSubStatus] = useQueryState<(typeof SUB_FILTERS)[number]>("status", "any", SUB_FILTERS);
  const [kind, setKind] = useQueryState<(typeof KINDS)[number]>("kind", "paid", KINDS);
  const [invoiceStatus, setInvoiceStatus] = useQueryState<(typeof INVOICE_FILTERS)[number]>("invoice", "any", INVOICE_FILTERS);
  const updateQuery = useQueryUpdater();

  const overview = useAdminData<BillingOverview>(allowed ? "/billing/overview" : null);
  const mrr = useAdminData<MrrResponse>(allowed ? "/billing/mrr?months=12" : null);
  const subscriptions = usePagedList<Subscription>(allowed && view === "subscriptions" ? `/billing/subscriptions${query({ status: subStatus === "any" ? undefined : subStatus, kind: kind === "all" ? undefined : kind })}` : null);
  const invoices = usePagedList<Invoice>(allowed && view === "invoices" ? `/billing/invoices${query({ status: invoiceStatus === "any" ? undefined : invoiceStatus })}` : null);

  if (!allowed) return <NoAccess />;

  const counts = overview.data?.counts;
  const currency = overview.data?.revenue[0]?.currency ?? "USD";
  const revenue = overview.data?.revenue.find((row) => row.currency === currency);
  const allMonths = (mrr.data?.series ?? []).filter((point) => point.currency === currency);
  // Start the charts at the first month with paid activity instead of a run of empty months.
  const firstActive = allMonths.findIndex((point) => point.mrrMinor > 0 || point.newPaid > 0 || point.churned > 0);
  const months = firstActive <= 0 ? allMonths : allMonths.slice(Math.max(0, firstActive - 1));
  const lastMonth = months[months.length - 2];
  // Plan mix has one row per plan and currency; amounts in different currencies are never added together.
  const paidPlans = (overview.data?.planMix ?? []).filter((plan) => plan.billingKind === "paid" && plan.subscriptions > 0 && plan.currency === currency);
  const freePlan = (overview.data?.planMix ?? []).find((plan) => plan.billingKind === "free");
  const paying = counts ? counts.paying + counts.pastDue : 0;
  const arpa = revenue && paying ? Math.round(revenue.mrrMinor / paying) : 0;
  const churnRate = counts && counts.paying + counts.cancelled30d > 0 ? counts.cancelled30d / (counts.paying + counts.cancelled30d) : 0;
  const list = view === "subscriptions" ? subscriptions : invoices;

  return (
    <>
      <PageHeader description="Recurring revenue, plan mix and payment problems across every workspace. Read-only." title="Billing" />

      <div className="admNotice" role="note">
        <AlertIcon />
        <div>
          <strong>No payment provider is connected yet.</strong>
          <p>These figures come from Spark&apos;s own subscription and invoice records. Rows marked &ldquo;demo&rdquo; are seeded sample data, and no real payments are taken.</p>
        </div>
      </div>

      {overview.error && <ErrorBanner message={overview.error} onRetry={overview.reload} />}
      <KpiCards
        items={[
          {
            label: "Monthly recurring revenue",
            value: revenue ? formatMoney(revenue.mrrMinor, currency) : overview.data ? formatMoney(0, currency) : undefined,
            change: revenue && lastMonth ? { current: revenue.mrrMinor, previous: lastMonth.mrrMinor } : undefined,
            hint: revenue ? `${formatMoney(revenue.arrMinor, currency)} annual run rate` : undefined,
            icon: <BillingIcon />,
            tone: "blue",
            trend: { values: months.map((point) => point.mrrMinor), color: SERIES.mrr.color },
          },
          { label: "Paying workspaces", value: counts ? formatCount(paying) : undefined, hint: counts ? `${formatCount(counts.trialing)} trialing · ${formatCount(counts.freeWorkspaces)} on Free` : undefined, icon: <TrendIcon />, tone: "green" },
          { label: "Average revenue per account", value: overview.data ? formatMoney(arpa, currency) : undefined, hint: "MRR ÷ paying workspaces", icon: <ChartIcon />, tone: "violet" },
          {
            label: "Cancelled, last 30 days",
            value: counts ? formatCount(counts.cancelled30d) : undefined,
            hint: counts ? `${(churnRate * 100).toFixed(1)}% of paid subscriptions · ${formatCount(counts.newPaid30d)} new paid` : undefined,
            icon: <PulseIcon />,
            tone: counts && counts.cancelled30d > counts.newPaid30d ? "red" : "amber",
          },
        ]}
        label="Revenue summary"
      />

      <div className="admGrid3">
        <ChartCard
          empty={mrr.data !== null && months.length === 0}
          emptyText="No paid subscriptions yet."
          error={mrr.error}
          loading={mrr.loading && !mrr.data}
          onRetry={mrr.reload}
          subtitle="Recurring revenue at the end of each month, at today's prices (yearly plans count as one twelfth)"
          table={{ columns: ["Month", "MRR", "New paid", "Cancelled"], rows: months.map((point) => [shortMonth(point.month), formatMoney(point.mrrMinor, currency), point.newPaid, point.churned]) }}
          title="Monthly recurring revenue"
        >
          <TrendChart
            data={months.map((point) => ({ ...point, mrr: point.mrrMinor }))}
            series={[{ key: "mrr", ...SERIES.mrr }]}
            valueFormat={(value) => formatMoney(value, currency, { compact: true })}
            xFormat={shortMonth}
            xKey="month"
          />
        </ChartCard>
        <ChartCard
          empty={overview.data !== null && paidPlans.length === 0}
          emptyText="No paid plans yet."
          error={overview.error}
          loading={overview.loading && !overview.data}
          onRetry={overview.reload}
          subtitle={freePlan ? `Share of MRR by paid plan · ${formatCount(freePlan.subscriptions)} workspaces on ${freePlan.name}` : "Share of MRR by paid plan"}
          table={{ columns: ["Plan", "Subscriptions", "MRR"], rows: (overview.data?.planMix ?? []).map((plan) => [plan.name, plan.subscriptions, formatMoney(plan.mrrMinor, plan.currency ?? currency)]) }}
          title="Plan mix"
        >
          <DonutChart
            centerLabel="paying"
            centerValue={formatCount(paidPlans.reduce((sum, plan) => sum + plan.subscriptions, 0))}
            data={paidPlans.map((plan, index) => ({ label: `${plan.name} · ${plan.subscriptions}`, value: plan.mrrMinor, color: CATEGORICAL[index % CATEGORICAL.length]! }))}
            height={180}
            valueFormat={(value) => formatMoney(value, currency, { compact: true })}
          />
        </ChartCard>
      </div>

      <div className="admGrid3">
        <ChartCard
          empty={mrr.data !== null && months.length === 0}
          error={mrr.error}
          height={220}
          legend={<ChartLegend series={[SERIES.newPaid, SERIES.churned]} />}
          loading={mrr.loading && !mrr.data}
          onRetry={mrr.reload}
          subtitle="Paid subscriptions started and cancelled each month"
          table={{ columns: ["Month", "New paid", "Cancelled"], rows: months.map((point) => [shortMonth(point.month), point.newPaid, point.churned]) }}
          title="Subscription movement"
        >
          <TrendChart data={months as unknown as Array<Record<string, unknown>>} height={220} kind="bar" series={[{ key: "newPaid", ...SERIES.newPaid }, { key: "churned", ...SERIES.churned }]} xFormat={shortMonth} xKey="month" />
        </ChartCard>
        <Card subtitle="Money owed and payment failures to follow up." title="Collections">
          {!overview.data && !overview.error && <div className="admCardInset"><SkeletonRows rows={4} /></div>}
          {overview.data && (
            <ul className="admStatList">
              <li><span>Collected, last 30 days</span><strong>{formatMoney(revenue?.collected30dMinor ?? 0, currency)}</strong></li>
              <li><span>Open invoices</span><strong>{formatMoney(revenue?.openMinor ?? 0, currency)}</strong></li>
              <li><span>Uncollectible</span>{(revenue?.uncollectibleMinor ?? 0) > 0 ? <Badge tone="red">{formatMoney(revenue?.uncollectibleMinor ?? 0, currency)}</Badge> : <strong>{formatMoney(0, currency)}</strong>}</li>
              <li><span>Past-due subscriptions</span>{counts && counts.pastDue > 0 ? <Badge tone="red">{counts.pastDue} past due</Badge> : <Badge tone="green">None</Badge>}</li>
              <li><span>Failed payments, 30 days</span>{counts && counts.failedPayments30d > 0 ? <Badge tone="amber">{counts.failedPayments30d} failed</Badge> : <Badge tone="green">None</Badge>}</li>
            </ul>
          )}
        </Card>
      </div>

      {list.error && <ErrorBanner message={list.error} onRetry={list.reload} />}
      <Panel
        footer={!list.loading && list.items.length > 0 ? <LoadMore hasMore={list.hasMore} loading={list.loadingMore} noun={view === "subscriptions" ? "subscription" : "invoice"} onClick={() => void list.loadMore()} shown={list.items.length} /> : undefined}
        label="Billing records"
        tabs={<Segmented label="Records" onChange={(next: View) => updateQuery({ view: next === "subscriptions" ? null : next, status: null, invoice: null, kind: null })} options={[{ value: "subscriptions", label: "Subscriptions" }, { value: "invoices", label: "Invoices" }]} value={view} />}
        tools={
          view === "subscriptions" ? (
            <>
            <Segmented label="Plan type" onChange={setKind} options={[{ value: "paid", label: "Paid" }, { value: "free", label: "Free" }, { value: "all", label: "All" }]} value={kind} />
            <label className="admSelect">
              <span className="admSrOnly">Subscription status</span>
              <select onChange={(event) => setSubStatus(event.target.value as (typeof SUB_FILTERS)[number])} value={subStatus}>
                {SUB_FILTERS.map((value) => <option key={value} value={value}>{value === "any" ? "All statuses" : SUBSCRIPTION_STATUS[value]?.label}</option>)}
              </select>
            </label>
            </>
          ) : (
            <label className="admSelect">
              <span className="admSrOnly">Invoice status</span>
              <select onChange={(event) => setInvoiceStatus(event.target.value as (typeof INVOICE_FILTERS)[number])} value={invoiceStatus}>
                {INVOICE_FILTERS.map((value) => <option key={value} value={value}>{value === "any" ? "All invoices" : INVOICE_STATUS[value]?.label}</option>)}
              </select>
            </label>
          )
        }
      >
        {list.loading ? (
          <SkeletonRows />
        ) : list.items.length === 0 && !list.error ? (
          <EmptyState title={view === "subscriptions" ? "No subscriptions match" : "No invoices match"}>Try a different status.</EmptyState>
        ) : view === "subscriptions" ? (
          <table className="admTable">
            <thead>
              <tr>
                <th scope="col">Workspace</th>
                <th scope="col">Plan</th>
                <th scope="col">Status</th>
                <th className="admNum" scope="col">MRR</th>
                <th scope="col">Renews or ends</th>
                <th scope="col">Started</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.items.map((item) => (
                <tr key={item.id}>
                  <td data-label="Workspace">
                    <div className="admCellMain">
                      <span className="admCellTitle">{item.workspace.name}</span>
                      <span className="admCellSub">/{item.workspace.slug}{item.provider ? ` · ${item.provider}` : ""}</span>
                    </div>
                  </td>
                  <td data-label="Plan">
                    <span className="admInline"><Tag>{item.plan.name}</Tag>{item.interval && <span className="admCellSub">{item.amountMinor !== null ? `${formatMoney(item.amountMinor, item.currency ?? currency)} / ${item.interval}` : humanize(item.interval)}</span>}</span>
                  </td>
                  <td data-label="Status">
                    <span className="admInline">
                      <Badge tone={SUBSCRIPTION_STATUS[item.status]?.tone ?? "neutral"}>{SUBSCRIPTION_STATUS[item.status]?.label ?? humanize(item.status)}</Badge>
                      {item.cancelAtPeriodEnd && <Tag>Cancels at period end</Tag>}
                    </span>
                  </td>
                  <td className="admNum" data-label="MRR">{item.mrrMinor > 0 ? formatMoney(item.mrrMinor, item.currency ?? currency) : <span className="admMutedCell">–</span>}</td>
                  <td className="admNowrap admMutedCell" data-label="Renews or ends">
                    {item.status === "cancelled" ? `Ended ${formatDate(item.cancelledAt)}` : item.status === "trialing" ? `Trial ends ${formatDate(item.trialEndsAt)}` : item.periodEnd ? formatDate(item.periodEnd) : "–"}
                  </td>
                  <td className="admNowrap admMutedCell" data-label="Started">{formatDate(item.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="admTable">
            <thead>
              <tr>
                <th scope="col">Issued</th>
                <th scope="col">Workspace</th>
                <th scope="col">Plan</th>
                <th scope="col">Status</th>
                <th className="admNum" scope="col">Total</th>
                <th scope="col">Due or paid</th>
              </tr>
            </thead>
            <tbody>
              {invoices.items.map((item) => (
                <tr key={item.id}>
                  <td className="admNowrap" data-label="Issued">{formatDate(item.issuedAt)}</td>
                  <td data-label="Workspace"><span className="admCellTitle">{item.workspace.name}</span></td>
                  <td data-label="Plan"><Tag>{item.planName}</Tag></td>
                  <td data-label="Status"><Badge tone={INVOICE_STATUS[item.status]?.tone ?? "neutral"}>{INVOICE_STATUS[item.status]?.label ?? humanize(item.status)}</Badge></td>
                  <td className="admNum" data-label="Total">{formatMoney(item.totalMinor, item.currency)}</td>
                  <td className="admNowrap admMutedCell" data-label="Due or paid">{item.paidAt ? `Paid ${formatDate(item.paidAt)}` : item.dueAt ? `Due ${formatDate(item.dueAt)}` : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

export default function BillingPage() {
  return (
    <Suspense fallback={<SkeletonRows />}>
      <Billing />
    </Suspense>
  );
}
