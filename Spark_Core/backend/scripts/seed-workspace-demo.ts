import { randomUUID } from "node:crypto";
import pg from "pg";

import { hashPassword } from "../src/infrastructure/database/password.js";
import { localConnection } from "./database-support.js";

/**
 * Demo workspace for the M5 insights: "Northstar Labs" with eight sign-in-able members and four projects whose
 * issue histories feed every insight chart. Atlas (Scrum: six completed sprints and an active one), Relay (Kanban:
 * 120 days of flow with a review bottleneck and aging work), Harbor (Waterfall: five baselined phases, Build
 * slipping six days, milestones in every state) and Beacon (Kanban for 60 days, then Scrum).
 *
 * Every issue version has its issue_events row (with the `after` snapshot exactly as ws_create_issue and
 * ws_update_issue build it) and a processed outbox row, back-dated so the history replay reads a realistic past.
 * Structure is deterministic (seeded PRNG); timestamps are relative to "now".
 *
 * Local development only. It runs once per database: when the workspace slug `northstar-labs` exists it does
 * nothing. To start over run `pnpm db:reset:local --yes`, then `pnpm db:migrate` and the seeds again.
 */

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed demo data: NODE_ENV is production.");
  process.exit(1);
}
// Demo data is never allowed on a shared database: the guard throws unless the URL is local
// and has no connection-parameter overrides. There is deliberately no opt-out.
const connectionString = localConnection("MIGRATION_DATABASE_URL");

const WORKSPACE_SLUG = "northstar-labs";
const PASSWORD = "NorthstarPassword123!";
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.now();
const TODAY = Math.floor(NOW / DAY) * DAY;
/** The latest instant any history event may carry: yesterday evening (UTC), so a run just after midnight still works. */
const HISTORY_END = TODAY - 6 * HOUR;

// ---------- deterministic randomness ----------
let state = 0x0b5e2026;
function random(): number {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (min: number, max: number) => Math.floor(random() * (max - min + 1)) + min;
const between = (min: number, max: number) => min + random() * (max - min);
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const chance = (p: number) => random() < p;
function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/** An instant on the UTC day `offset` days from today, at the given hour and minute. */
const dayAt = (offset: number, hour = 9, minute = 0) => TODAY + offset * DAY + hour * HOUR + minute * MINUTE;
/** A working-hours moment on the UTC day `offset` days from today. */
const workMoment = (offset: number) => dayAt(offset, int(8, 17), int(0, 59));
const dateOf = (offset: number) => new Date(TODAY + offset * DAY).toISOString().slice(0, 10);
const iso = (ms: number) => new Date(ms).toISOString();
const roundMinute = (ms: number) => Math.floor(ms / MINUTE) * MINUTE + int(0, 59) * 1000;
const POINTS = [1, 2, 3, 3, 5, 5, 8] as const;

// ---------- people ----------
type Role = "owner" | "admin" | "member";
interface Member { id: string; name: string; email: string; role: Role; timezone: string }
const ACCOUNTS: Omit<Member, "id">[] = [
  { name: "Maya Chen", email: "maya.chen@northstar.test", role: "owner", timezone: "America/Los_Angeles" },
  { name: "Daniel Okafor", email: "daniel.okafor@northstar.test", role: "admin", timezone: "Europe/London" },
  { name: "Priya Raman", email: "priya.raman@northstar.test", role: "member", timezone: "Asia/Kolkata" },
  { name: "Lucas Silva", email: "lucas.silva@northstar.test", role: "member", timezone: "America/Sao_Paulo" },
  { name: "Linh Tran", email: "linh.tran@northstar.test", role: "member", timezone: "Asia/Ho_Chi_Minh" },
  { name: "Sofia Rossi", email: "sofia.rossi@northstar.test", role: "member", timezone: "Europe/Rome" },
  { name: "Kenji Watanabe", email: "kenji.watanabe@northstar.test", role: "member", timezone: "Asia/Tokyo" },
  { name: "Nora Lindqvist", email: "nora.lindqvist@northstar.test", role: "member", timezone: "Europe/Stockholm" },
];

// ---------- the in-memory model ----------
type Category = "backlog" | "todo" | "in_progress" | "done";
interface Status { id: string; name: string; category: Category; wip: number | null }
interface Project {
  id: string; key: string; name: string; description: string; methodology: "scrum" | "kanban" | "waterfall";
  lead: Member; createdAt: number; startDate: string | null; targetDate: string | null; sprintLength: number | null;
  baselinedAt: number | null; statuses: Status[]; team: Member[];
}
interface Snapshot {
  at: number; type: "issue.created" | "issue.updated"; fields: string[]; actor: Member;
  status: Status; assignee: Member | null; points: number | null; phase: string | null; sprint: string | null; archived: boolean;
}
type Patch = Partial<Pick<Snapshot, "status" | "assignee" | "points" | "phase" | "sprint" | "archived">>;

class Issue {
  readonly snaps: Snapshot[] = [];
  constructor(
    readonly project: Project, readonly title: string, readonly type: "story" | "task" | "bug",
    readonly priority: "lowest" | "low" | "medium" | "high" | "highest", readonly reporter: Member, readonly due: string | null,
  ) {}

  get last(): Snapshot { return this.snaps[this.snaps.length - 1]!; }

  /** ws_create_issue: fields are the keys the caller sent (title always), sorted; sprintId is always null. */
  create(at: number, init: { status: Status; assignee?: Member | null; points?: number | null; phase?: string | null }): this {
    const fields = ["title", "type", "priority", "statusId"];
    if (init.assignee) fields.push("assigneeUserId");
    if (init.points != null) fields.push("storyPoints");
    if (this.due) fields.push("dueDate");
    if (init.phase) fields.push("phaseId");
    this.snaps.push({
      at, type: "issue.created", fields: fields.sort(), actor: this.reporter, status: init.status, assignee: init.assignee ?? null,
      points: init.points ?? null, phase: init.phase ?? null, sprint: null, archived: false,
    });
    return this;
  }

  /** ws_update_issue / ws_complete_sprint: one change set listing the changed fields only; no-op patches write nothing. */
  change(at: number, patch: Patch, actor?: Member): this {
    const prev = this.last;
    const next: Snapshot = { ...prev, ...patch, at, type: "issue.updated", fields: [], actor: actor ?? prev.assignee ?? this.project.lead };
    const fields: string[] = [];
    if (next.status.id !== prev.status.id) fields.push("statusId");
    if (next.assignee?.id !== prev.assignee?.id) fields.push("assigneeUserId");
    if (next.points !== prev.points) fields.push("storyPoints");
    if (next.phase !== prev.phase) fields.push("phaseId");
    if (next.sprint !== prev.sprint) fields.push("sprintId");
    if (next.archived !== prev.archived) fields.push("archived");
    if (fields.length === 0) return this;
    next.fields = fields.sort();
    this.snaps.push(next);
    return this;
  }

  /** The state the history replay sees at instant t (latest snapshot strictly before t). */
  stateAt(t: number): Snapshot | undefined {
    let found: Snapshot | undefined;
    for (const snap of this.snaps) if (snap.at < t) found = snap;
    return found;
  }
}

function status(name: string, category: Category, wip: number | null = null): Status {
  return { id: randomUUID(), name, category, wip };
}
const byCategory = (project: Project, name: string) => project.statuses.find((s) => s.name === name)!;

// ---------- titles ----------
const ATLAS_TITLES = [
  "Saved payment methods on checkout", "Order history filters", "Push notification preferences", "Dark mode for account settings",
  "Two-factor sign-in with authenticator apps", "Refund status timeline", "Invoice PDF download", "Address autocomplete",
  "Loyalty points balance widget", "Guest checkout", "Product review moderation queue", "Wishlist sharing links",
  "Delivery slot picker", "Accessibility audit fixes on the cart", "Faster product search results", "Promo code validation errors",
  "Subscription pause and resume", "Customer support chat entry point", "Reorder from past orders", "Localized currency display",
  "Session timeout warning", "Email receipt redesign", "Gift card redemption", "Shipping cost estimate on product page",
  "Error tracking for the checkout flow", "Profile photo upload", "Return label generation", "Inventory badge on listings",
  "Onboarding tour for new customers", "Recently viewed products", "Cart abandonment reminder", "Split payments",
  "Password strength meter", "Order cancellation window", "Store locator map", "Analytics events for the funnel",
  "Account deletion request flow", "Coupon stacking rules", "Size guide modal", "Bulk add to cart",
  "Back-in-stock alerts", "Mobile navigation cleanup", "Rate limiting on sign-in", "Checkout copy review",
  "Fix flaky cart totals test", "Upgrade payment SDK", "Image lazy loading", "Cache product catalogue responses",
  "Delivery tracking page", "Referral programme landing page", "Tax breakdown on receipts", "Saved searches",
];
const RELAY_TITLES = [
  "Customer cannot reset password", "Webhook retries flood the queue", "Rotate the staging TLS certificate", "Export of usage report times out",
  "Billing email shows wrong currency", "SSO login loop for Okta tenants", "Increase API gateway timeout", "Restore deleted project for customer",
  "CSV import rejects UTF-8 BOM", "Slow dashboard for large workspaces", "Audit log missing IP address", "Patch base image vulnerabilities",
  "Customer asks for data residency letter", "Bounce handling for transactional email", "Fix broken link in onboarding email", "Scale worker pool for month end",
  "Duplicate invoices after plan change", "Clean up orphaned storage buckets", "Alert fatigue on disk usage", "Update status page component names",
  "Customer webhook signature mismatch", "Rate limit tuning for public API", "Mobile app crash on Android 15", "Backfill missing analytics events",
  "Renew domain and DNS records", "Postgres vacuum alerts", "Missing translation strings in German", "Remove legacy feature flag",
  "Investigate p95 latency spike", "Support macro for refund requests", "Enable MFA for all staff accounts", "Upgrade Redis minor version",
];
const CUSTOMERS = ["Acme Freight", "Brightline", "Copperleaf", "Driftwood Labs", "Evergreen Health", "Fieldstone", "Granite Bank", "Harborview"];
const HARBOR_TITLES: Record<string, string[]> = {
  Requirements: ["Stakeholder interviews", "Current-state process map", "Regulatory requirements matrix", "Integration inventory", "Acceptance criteria workshop", "Requirements sign-off pack"],
  Design: ["Solution architecture", "Data model for the warehouse feed", "Network and firewall design", "Operator console wireframes", "Security design review", "Cutover strategy", "Design sign-off pack"],
  Build: ["Provision production environment", "ERP connector", "Barcode scanner integration", "Operator console screens", "Shipment label service", "Inventory sync job",
    "Role-based access control", "Audit trail", "Reporting views", "Data migration scripts", "Monitoring and alerting", "Backup and restore runbook", "Load test harness", "Build sign-off pack"],
  Test: ["System test plan", "Integration test cycle 1", "Integration test cycle 2", "Performance test", "Security penetration test", "User acceptance testing", "Defect triage", "Test sign-off pack"],
  Deploy: ["Training sessions for operators", "Go-live checklist", "Production data migration", "Hypercare rota", "Project closure report"],
};
const BEACON_TITLES = [
  "Event tracking SDK for web", "Ingest pipeline back-pressure", "Dashboard sharing permissions", "Retention cohort chart", "Funnel builder drag and drop",
  "Segment by device type", "CSV export for charts", "Anomaly detection alerts", "Query cache warming", "Data retention settings",
  "Schema registry for events", "Session replay sampling", "Self-serve workspace onboarding", "Billing usage meter", "Public API for metrics",
  "SQL editor autocomplete", "Chart annotations", "Scheduled email reports", "Team spaces for dashboards", "Mobile SDK beta",
  "GDPR deletion requests", "Embed dashboards in apps", "Alert routing to Slack", "Saved filters", "Dark mode for dashboards",
  "Attribution model comparison", "Funnel conversion windows", "Time zone aware reports", "Query performance profiler", "Usage-based pricing page",
  "Event volume forecast", "Heatmap prototype", "Onboarding checklist", "Data quality monitors", "Workspace audit log",
  "Annotation API", "Custom metrics", "Dashboard templates", "Warehouse sync to BigQuery", "Experiment results view",
];

async function main() {
  const passwordHashes = await Promise.all(ACCOUNTS.map(() => hashPassword(PASSWORD)));
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query("SET ROLE spark_owner");
    if ((await client.query("SELECT 1 FROM spark.workspaces WHERE slug = $1", [WORKSPACE_SLUG])).rowCount) {
      console.log(`The workspace '${WORKSPACE_SLUG}' already exists; nothing to do. To start over: pnpm db:reset:local --yes, then db:migrate and the seeds.`);
      return;
    }

    await client.query("BEGIN");

    // ---------- accounts (an existing account with the same email is reused and gets the published password) ----------
    const workspaceCreated = dayAt(-190, 15);
    const members: Member[] = [];
    let reused = 0;
    for (const [index, account] of ACCOUNTS.entries()) {
      const email = account.email.toLowerCase();
      const existing = (await client.query<{ user_id: string }>("SELECT user_id FROM spark.user_emails WHERE normalized_email = $1", [email])).rows[0];
      let id: string;
      if (existing) {
        id = existing.user_id;
        reused += 1;
        await client.query("UPDATE spark.users SET status = 'active', timezone = $2 WHERE id = $1", [id, account.timezone]);
        await client.query(
          `INSERT INTO spark.password_credentials (user_id, password_hash, password_changed_at) VALUES ($1, $2, now())
           ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, password_changed_at = now()`,
          [id, passwordHashes[index]],
        );
      } else {
        const created = iso(workspaceCreated - int(2, 30) * DAY - int(0, 600) * MINUTE);
        id = (await client.query<{ id: string }>(
          "INSERT INTO spark.users (display_name, status, locale, timezone, created_at, updated_at) VALUES ($1, 'active', 'en', $2, $3, $3) RETURNING id",
          [account.name, account.timezone, created],
        )).rows[0]!.id;
        await client.query(
          "INSERT INTO spark.user_emails (user_id, email, normalized_email, is_primary, verified_at, created_at) VALUES ($1, $2, $3, true, $4, $4)",
          [id, account.email, email, created],
        );
        await client.query(
          "INSERT INTO spark.password_credentials (user_id, password_hash, password_changed_at, created_at) VALUES ($1, $2, $3, $3)",
          [id, passwordHashes[index], created],
        );
      }
      members.push({ id, ...account });
    }
    const [maya, daniel, priya, lucas, linh, sofia, kenji, nora] = members as [Member, Member, Member, Member, Member, Member, Member, Member];

    // ---------- workspace and memberships ----------
    const workspace = (await client.query<{ id: string }>(
      "INSERT INTO spark.workspaces (slug, name, status, created_by_user_id, created_at, updated_at) VALUES ($1, 'Northstar Labs', 'active', $2, $3, $3) RETURNING id",
      [WORKSPACE_SLUG, maya.id, iso(workspaceCreated)],
    )).rows[0]!.id;
    for (const [index, member] of members.entries()) {
      const joined = iso(workspaceCreated + (index === 0 ? 0 : int(1, 20) * DAY + int(0, 480) * MINUTE));
      await client.query(
        "INSERT INTO spark.workspace_memberships (tenant_id, user_id, role, status, joined_at, created_at, updated_at) VALUES ($1, $2, $3, 'active', $4, $4, $4)",
        [workspace, member.id, member.role, joined],
      );
    }

    const issues: Issue[] = [];
    type SprintRow = {
      id: string; project: Project; name: string; goal: string; startDay: number; endDay: number; createdAt: number;
      status: "planned" | "active" | "completed"; startedAt: number; completedAt: number | null;
      committedPoints: number; committedCount: number; completedPoints: number | null; completedCount: number | null;
      commitments: { issue: Issue; points: number | null }[];
    };
    const sprints: SprintRow[] = [];
    const phases: { id: string; project: Project; name: string; position: number; plannedStart: number; plannedEnd: number;
      baselineStart: number; baselineEnd: number; status: "planned" | "active" | "completed"; completedAt: number | null }[] = [];
    const milestones: { project: Project; phase: string | null; name: string; due: number; baselineDue: number; completedAt: number | null }[] = [];
    const periods: { project: Project; methodology: string; startedAt: number; endedAt: number | null; reason: string; by: Member }[] = [];

    const newProject = (p: Omit<Project, "id">): Project => ({ id: randomUUID(), ...p });

    // ---------- Scrum sprint simulation (shared by Atlas and Beacon) ----------
    // planned: new issues refined into the sprint; commitTotal (instead) tops the carry-over up to that many committed issues.
    interface SprintPlan {
      name: string; goal: string; startDay: number; planned?: number; commitTotal?: number; doneShare: number; added: number; addedDone: number;
      removed: number; active?: boolean; alreadyDone?: number;
    }
    function runSprints(project: Project, plans: SprintPlan[], titles: string[], startingCarry: Issue[]): Issue[] {
      const s = { backlog: byCategory(project, "Backlog"), todo: byCategory(project, "To do"), progress: byCategory(project, "In progress"),
        review: byCategory(project, "In review"), done: byCategory(project, "Done") };
      let carry = startingCarry;
      let titleIndex = 0;
      const nextTitle = () => {
        const title = titles[titleIndex % titles.length]!;
        return titleIndex++ >= titles.length ? `${title}: follow-up` : title;
      };
      const sprintIds = plans.map(() => randomUUID());
      for (const [k, plan] of plans.entries()) {
        const sprintId = sprintIds[k]!;
        const startedAt = dayAt(plan.startDay, 10, int(0, 20));
        const endsDay = plan.startDay + project.sprintLength!;
        const completedAt = plan.active ? null : dayAt(endsDay, 9, int(5, 40));
        const windowEnd = plan.active ? Math.min(HISTORY_END, dayAt(endsDay, 0)) : completedAt! - 30 * MINUTE;
        const planningAt = dayAt(plan.startDay - 1, 15, int(0, 30));
        const sprintIssues: Issue[] = [...carry];
        // Leftover work that is not in the sprint yet (e.g. open cards at a methodology switch) is planned in too.
        carry.forEach((issue, i) => {
          if (issue.last.sprint !== sprintId) issue.change(planningAt - (carry.length - i) * MINUTE, { sprint: sprintId, status: s.todo }, project.lead);
        });
        const planned = plan.planned ?? (plan.commitTotal ?? 0) - (plan.alreadyDone ?? 0) - carry.length;
        if (planned < 0) throw new Error(`${plan.name}: too much carry-over for the commitment`);

        // New work refined from the backlog and planned into the sprint the day before it starts.
        for (let i = 0; i < planned; i++) {
          const assignee = chance(0.9) ? pick(project.team) : null;
          const due = chance(0.3) ? dateOf(endsDay - int(0, 3)) : null;
          const issue = new Issue(project, nextTitle(), pick(["story", "story", "task", "bug"] as const), pick(["low", "medium", "medium", "high"] as const), project.lead, due)
            .create(workMoment(plan.startDay - int(3, 10)), { status: s.backlog, assignee, points: chance(0.95) ? pick(POINTS) : null });
          issue.change(planningAt + i * MINUTE, { sprint: sprintId, status: s.todo }, project.lead);
          issues.push(issue);
          sprintIssues.push(issue);
        }
        // Committed issues finished before the sprint even started (picked up early while it was planned).
        for (let i = 0; i < (plan.alreadyDone ?? 0); i++) {
          const worker = pick(project.team);
          const issue = new Issue(project, nextTitle(), "task", "medium", project.lead, null)
            .create(workMoment(plan.startDay - 9), { status: s.backlog, assignee: worker, points: pick([1, 2, 3]) });
          issue.change(dayAt(plan.startDay - 3, 11, i * 7), { sprint: sprintId, status: s.todo }, project.lead);
          issue.change(dayAt(plan.startDay - 3, 14, i * 11), { status: s.progress });
          issue.change(dayAt(plan.startDay - 1, 16, i * 13), { status: s.done });
          issues.push(issue);
          sprintIssues.push(issue);
        }

        // The commitment snapshot: the sprint's non-archived issues as they stand at start.
        const commitments = sprintIssues
          .map((issue) => ({ issue, state: issue.stateAt(startedAt) }))
          .filter((c) => c.state?.sprint === sprintId && !c.state.archived)
          .map((c) => ({ issue: c.issue, points: c.state!.points }));
        if (commitments.length !== sprintIssues.length) throw new Error(`${plan.name}: every sprint issue must be in the sprint at start`);

        // Fates: done, still open (started or not), or taken out of the sprint again.
        const open = shuffle(sprintIssues.filter((issue) => issue.stateAt(startedAt)!.status.category !== "done"));
        const doneTarget = Math.round(open.length * plan.doneShare);
        const removed = open.slice(doneTarget, doneTarget + plan.removed);
        const W = windowEnd - startedAt;
        const work = (issue: Issue, finish: boolean, from: number) => {
          const current = issue.last.status;
          let at = from;
          if (current.category !== "in_progress") {
            at = roundMinute(between(from + HOUR, from + (windowEnd - from) * 0.55));
            issue.change(at, { status: s.progress, assignee: issue.last.assignee ?? pick(project.team) });
          }
          if (!finish) {
            if (chance(0.4)) issue.change(roundMinute(between(at + HOUR, windowEnd - HOUR)), { status: s.review });
            return;
          }
          const span = windowEnd - HOUR - at;
          let reviewAt = at;
          if (chance(0.6)) {
            reviewAt = roundMinute(at + span * between(0.2, 0.5));
            issue.change(reviewAt, { status: s.review });
          }
          issue.change(roundMinute(reviewAt + (windowEnd - HOUR - reviewAt) * between(0.3, 0.9)), { status: s.done });
        };
        for (const [index, issue] of open.entries()) {
          if (index < doneTarget) work(issue, true, startedAt);
          else if (removed.includes(issue)) issue.change(roundMinute(startedAt + W * between(0.15, 0.5)), { sprint: null, status: s.backlog }, project.lead);
          else if (chance(0.55)) work(issue, false, startedAt);
        }
        // Scope added after the start.
        for (let i = 0; i < plan.added; i++) {
          const addedAt = roundMinute(startedAt + W * between(0.1, 0.45));
          const issue = new Issue(project, nextTitle(), pick(["bug", "task"] as const), pick(["high", "highest"] as const), project.lead, null)
            .create(addedAt, { status: s.todo, assignee: pick(project.team), points: chance(0.85) ? pick([1, 2, 3, 5]) : null });
          issue.change(addedAt + 20 * MINUTE, { sprint: sprintId }, project.lead);
          if (i < plan.addedDone) work(issue, true, addedAt + 20 * MINUTE);
          else work(issue, false, addedAt + 20 * MINUTE);
          issues.push(issue);
          sprintIssues.push(issue);
        }

        // Completion: totals frozen from the state just before completion, open work carried to the next sprint.
        let completedPoints: number | null = null, completedCount: number | null = null;
        carry = [];
        if (completedAt !== null) {
          const inSprint = sprintIssues.filter((issue) => { const st = issue.stateAt(completedAt); return st?.sprint === sprintId && !st.archived; });
          const finished = inSprint.filter((issue) => issue.stateAt(completedAt)!.status.category === "done");
          completedPoints = finished.reduce((sum, issue) => sum + (issue.stateAt(completedAt)!.points ?? 0), 0);
          completedCount = finished.length;
          const nextSprint = sprintIds[k + 1] ?? null;
          for (const issue of inSprint.filter((i) => !finished.includes(i)).sort((a, b) => (a.title < b.title ? -1 : 1))) {
            issue.change(completedAt, { sprint: nextSprint }, project.lead);
            if (nextSprint) carry.push(issue);
          }
        }
        sprints.push({
          id: sprintId, project, name: plan.name, goal: plan.goal, startDay: plan.startDay, endDay: endsDay, createdAt: planningAt - 2 * DAY,
          status: plan.active ? "active" : "completed", startedAt, completedAt,
          committedPoints: commitments.reduce((sum, c) => sum + (c.points ?? 0), 0), committedCount: commitments.length,
          completedPoints, completedCount, commitments,
        });
      }
      return carry;
    }

    // ---------- Atlas (Scrum) ----------
    const atlas = newProject({
      key: "ATL", name: "Atlas", description: "Customer web and mobile storefront, delivered in two-week sprints.", methodology: "scrum",
      lead: priya, createdAt: dayAt(-100, 10), startDate: null, targetDate: null, sprintLength: 14, baselinedAt: null,
      statuses: [status("Backlog", "backlog"), status("To do", "todo"), status("In progress", "in_progress"), status("In review", "in_progress"), status("Done", "done")],
      team: [priya, sofia, kenji, linh, maya],
    });
    periods.push({ project: atlas, methodology: "scrum", startedAt: atlas.createdAt, endedAt: null, reason: "Project created", by: maya });
    const atlasGoals = ["Ship saved payment methods", "Order history and refunds", "Account security hardening", "Checkout performance",
      "Subscriptions and gift cards", "Delivery tracking", "Search and discovery refresh"];
    runSprints(atlas, [
      { name: "Atlas Sprint 1", goal: atlasGoals[0]!, startDay: -88, planned: 7, doneShare: 0.86, added: 1, addedDone: 1, removed: 0 },
      { name: "Atlas Sprint 2", goal: atlasGoals[1]!, startDay: -74, planned: 6, doneShare: 0.7, added: 2, addedDone: 1, removed: 1 },
      { name: "Atlas Sprint 3", goal: atlasGoals[2]!, startDay: -60, planned: 7, doneShare: 0.9, added: 0, addedDone: 0, removed: 0 },
      { name: "Atlas Sprint 4", goal: atlasGoals[3]!, startDay: -46, planned: 6, doneShare: 0.75, added: 1, addedDone: 0, removed: 1 },
      { name: "Atlas Sprint 5", goal: atlasGoals[4]!, startDay: -32, planned: 7, doneShare: 0.8, added: 2, addedDone: 2, removed: 0 },
      { name: "Atlas Sprint 6", goal: atlasGoals[5]!, startDay: -18, planned: 6, doneShare: 0.7, added: 1, addedDone: 0, removed: 0 },
      // The active sprint: 10 committed issues (Sprint 6 carry-over, newly planned work and 2 already done at start),
      // 3 of the 8 open ones finished so far and 1 issue added after the start.
      { name: "Atlas Sprint 7", goal: atlasGoals[6]!, startDay: -4, commitTotal: 10, alreadyDone: 2, doneShare: 3 / 8, added: 1, addedDone: 0, removed: 0, active: true },
    ], ATLAS_TITLES, []);
    // Backlog: refined and unrefined ideas, a few without an estimate, two overdue.
    for (let i = 0; i < 14; i++) {
      const due = i < 2 ? dateOf(-int(3, 12)) : chance(0.2) ? dateOf(int(5, 40)) : null;
      issues.push(new Issue(atlas, ATLAS_TITLES[(i * 7 + 3) % ATLAS_TITLES.length]!, pick(["story", "task", "bug"] as const), pick(["low", "medium", "high"] as const), pick(atlas.team), due)
        .create(workMoment(-int(5, 95)), { status: byCategory(atlas, "Backlog"), assignee: chance(0.4) ? pick(atlas.team) : null, points: i % 5 === 4 ? null : pick(POINTS) }));
    }

    // ---------- Relay (Kanban) ----------
    const relay = newProject({
      key: "RLY", name: "Relay", description: "Platform operations and customer escalations, run as a continuous flow.", methodology: "kanban",
      lead: lucas, createdAt: dayAt(-125, 9), startDate: null, targetDate: null, sprintLength: null, baselinedAt: null,
      statuses: [status("Backlog", "backlog"), status("Ready", "todo", 8), status("In progress", "in_progress", 4), status("Review", "in_progress", 3), status("Done", "done")],
      team: [lucas, linh, nora, daniel, kenji],
    });
    periods.push({ project: relay, methodology: "kanban", startedAt: relay.createdAt, endedAt: null, reason: "Project created", by: daniel });
    {
      const r = { backlog: byCategory(relay, "Backlog"), ready: byCategory(relay, "Ready"), progress: byCategory(relay, "In progress"),
        review: byCategory(relay, "Review"), done: byCategory(relay, "Done") };
      const relayIssue = (createdAt: number, dueAfter: number | null) => {
        const createdDay = Math.floor((createdAt - TODAY) / DAY);
        const due = dueAfter === null ? null : dateOf(createdDay + dueAfter);
        const title = chance(0.5) ? `${pick(RELAY_TITLES)} (${pick(CUSTOMERS)})` : pick(RELAY_TITLES);
        return new Issue(relay, title, pick(["task", "task", "bug", "bug", "story"] as const), pick(["low", "medium", "medium", "high", "highest"] as const), pick(relay.team), due)
          .create(createdAt, { status: r.backlog, points: chance(0.4) ? pick([1, 2, 3, 5]) : null });
      };
      // Finished work: about one card a day for 120 days; review waits grow over the last month (the bottleneck).
      let reopened = 0;
      for (let day = -120; day <= -6; day++) {
        const weekend = [0, 6].includes(new Date(TODAY + day * DAY).getUTCDay());
        const arrivals = weekend ? (chance(0.2) ? 1 : 0) : int(0, 2);
        for (let a = 0; a < arrivals; a++) {
          const createdAt = workMoment(day);
          const issue = relayIssue(createdAt, chance(0.35) ? int(4, 14) : null);
          const recent = day > -35;
          const steps = [between(0.3, 4), between(0.3, 3), between(0.5, 3.5), recent ? between(3, 7) : between(0.5, 2.5)].map((d) => d * DAY);
          const budget = HISTORY_END - HOUR - createdAt;
          const total = steps.reduce((sum, d) => sum + d, 0);
          const scale = total > budget * 0.95 ? (budget * 0.95) / total : 1;
          let at = createdAt;
          const next = (index: number) => (at = roundMinute(at + steps[index]! * scale));
          issue.change(next(0), { status: r.ready }, relay.lead);
          issue.change(next(1), { status: r.progress, assignee: pick(relay.team) });
          issue.change(next(2), { status: r.review });
          issue.change(next(3), { status: r.done });
          if (reopened < 2 && day < -40 && chance(0.15)) {
            reopened += 1;
            issue.change(roundMinute(at + between(1, 2) * DAY), { status: r.progress });
            issue.change(roundMinute(at + between(3, 4) * DAY), { status: r.done });
          }
          issues.push(issue);
        }
      }
      // Open work within the WIP limits: Review full (3/3) with aging cards, In progress at its limit (4/4).
      const openPlan: { column: "review" | "progress" | "ready" | "backlog"; created: number; started?: number; reviewed?: number; due?: number }[] = [
        { column: "review", created: -26, started: -20, reviewed: -12, due: -6 },
        { column: "review", created: -19, started: -14, reviewed: -8 },
        { column: "review", created: -13, started: -9, reviewed: -5, due: -2 },
        { column: "progress", created: -30, started: -22, due: -10 },
        { column: "progress", created: -9, started: -6 },
        { column: "progress", created: -6, started: -3, due: 4 },
        { column: "progress", created: -3, started: -1 },
        ...[-15, -11, -8, -5, -4, -2].map((created) => ({ column: "ready" as const, created })),
        ...[-40, -33, -27, -21, -16, -12, -9, -7, -3, -2].map((created) => ({ column: "backlog" as const, created })),
      ];
      for (const item of openPlan) {
        const issue = relayIssue(workMoment(item.created), item.due === undefined ? null : item.due - item.created);
        if (item.column !== "backlog") issue.change(workMoment(item.started !== undefined ? item.started - 1 : item.created + 1), { status: r.ready }, relay.lead);
        if (item.started !== undefined) issue.change(workMoment(item.started), { status: r.progress, assignee: pick(relay.team) });
        if (item.reviewed !== undefined) issue.change(workMoment(item.reviewed), { status: r.review });
        issues.push(issue);
      }
      // One duplicate ticket archived from the backlog.
      issues.push(relayIssue(workMoment(-50), null).change(workMoment(-48), { archived: true }, relay.lead));
    }

    // ---------- Harbor (Waterfall) ----------
    const harbor = newProject({
      key: "HBR", name: "Harbor", description: "Warehouse management system rollout for the Rotterdam distribution centre.", methodology: "waterfall",
      lead: daniel, createdAt: dayAt(-72, 9), startDate: dateOf(-70), targetDate: dateOf(50), sprintLength: null, baselinedAt: dayAt(-72, 9, 30),
      statuses: [status("Not started", "todo"), status("In progress", "in_progress"), status("In review", "in_progress"), status("Done", "done")],
      team: [daniel, nora, sofia, lucas],
    });
    periods.push({ project: harbor, methodology: "waterfall", startedAt: harbor.createdAt, endedAt: null, reason: "Project created", by: maya });
    {
      const h = { todo: byCategory(harbor, "Not started"), progress: byCategory(harbor, "In progress"), review: byCategory(harbor, "In review"), done: byCategory(harbor, "Done") };
      // [name, baseline start, baseline end, planned start, planned end, status, completed day] in days from today.
      const plan: [string, number, number, number, number, "planned" | "active" | "completed", number | null][] = [
        ["Requirements", -70, -56, -70, -56, "completed", -56],
        ["Design", -55, -36, -55, -36, "completed", -33],
        ["Build", -35, 5, -35, 11, "active", null],
        ["Test", 6, 30, 12, 36, "planned", null],
        ["Deploy", 31, 44, 37, 50, "planned", null],
      ];
      const phaseIds = new Map<string, string>();
      for (const [index, [name, bStart, bEnd, pStart, pEnd, phaseStatus, completedDay]] of plan.entries()) {
        const id = randomUUID();
        phaseIds.set(name, id);
        phases.push({ id, project: harbor, name, position: index + 1, plannedStart: pStart, plannedEnd: pEnd, baselineStart: bStart, baselineEnd: bEnd,
          status: phaseStatus, completedAt: completedDay === null ? null : dayAt(completedDay, 16) });
        // Done share and work window per phase: finished phases are fully done, Build is a little over half way.
        const titles = HARBOR_TITLES[name]!;
        const doneCount = phaseStatus === "completed" ? titles.length : name === "Build" ? 8 : 0;
        const inFlight = name === "Build" ? 4 : name === "Test" ? 1 : 0;
        for (const [t, title] of titles.entries()) {
          const due = dateOf(t === titles.length - 1 ? pEnd : Math.min(pEnd, pStart + Math.round(((t + 1) * (pEnd - pStart)) / titles.length)));
          const issue = new Issue(harbor, title, "task", pick(["medium", "medium", "high"] as const), daniel, due)
            .create(workMoment(-71 + (index === 0 ? 0 : 1)), { status: h.todo, assignee: pick(harbor.team), phase: id });
          const activeFrom = Math.max(pStart, -70);
          if (t < doneCount) {
            const finishBy = name === "Build" ? -2 : (completedDay ?? pEnd) - 1;
            const startDay = Math.min(finishBy - 1, activeFrom + Math.floor(((finishBy - activeFrom) * t) / titles.length));
            const doneDay = Math.min(finishBy, startDay + int(1, 6));
            issue.change(workMoment(startDay), { status: h.progress });
            if (chance(0.5)) issue.change(dayAt(doneDay, 8, int(0, 30)), { status: h.review });
            issue.change(dayAt(doneDay, int(12, 18), int(0, 59)), { status: h.done });
          } else if (t < doneCount + inFlight) {
            issue.change(workMoment(name === "Test" ? -6 : -int(4, 14)), { status: h.progress });
            if (name === "Build" && t === doneCount) issue.change(workMoment(-2), { status: h.review });
          }
          issues.push(issue);
        }
      }
      // Milestones: hit, missed (late and still open), at risk (due within a week) and upcoming.
      milestones.push(
        { project: harbor, phase: phaseIds.get("Requirements")!, name: "Requirements sign-off", due: -56, baselineDue: -56, completedAt: dayAt(-57, 15) },
        { project: harbor, phase: phaseIds.get("Design")!, name: "Design sign-off", due: -36, baselineDue: -36, completedAt: dayAt(-33, 11) },
        { project: harbor, phase: phaseIds.get("Build")!, name: "Vendor contract signed", due: -10, baselineDue: -10, completedAt: null },
        { project: harbor, phase: phaseIds.get("Build")!, name: "Beta build handed to QA", due: 4, baselineDue: 2, completedAt: null },
        { project: harbor, phase: phaseIds.get("Build")!, name: "Build sign-off", due: 11, baselineDue: 5, completedAt: null },
        { project: harbor, phase: phaseIds.get("Test")!, name: "Test sign-off", due: 36, baselineDue: 30, completedAt: null },
        { project: harbor, phase: phaseIds.get("Deploy")!, name: "Go-live", due: 50, baselineDue: 44, completedAt: null },
      );
    }

    // ---------- Beacon (Kanban for 60 days, then Scrum) ----------
    const switchAt = dayAt(-50, 11, 20);
    const beacon = newProject({
      key: "BCN", name: "Beacon", description: "Product analytics platform. Moved from Kanban to Scrum sprints once the roadmap firmed up.", methodology: "scrum",
      lead: kenji, createdAt: dayAt(-110, 9), startDate: null, targetDate: null, sprintLength: 14, baselinedAt: null,
      statuses: [status("Backlog", "backlog"), status("To do", "todo"), status("In progress", "in_progress"), status("In review", "in_progress"), status("Done", "done")],
      team: [kenji, priya, linh, sofia],
    });
    periods.push(
      { project: beacon, methodology: "kanban", startedAt: beacon.createdAt, endedAt: switchAt, reason: "Project created", by: daniel },
      { project: beacon, methodology: "scrum", startedAt: switchAt, endedAt: null, reason: "Roadmap is stable enough to plan in two-week sprints", by: kenji },
    );
    {
      const b = { backlog: byCategory(beacon, "Backlog"), todo: byCategory(beacon, "To do"), progress: byCategory(beacon, "In progress"),
        review: byCategory(beacon, "In review"), done: byCategory(beacon, "Done") };
      // Kanban era: cards flow continuously; the last few are still open at the switch and get planned into sprints later.
      let title = 0;
      for (let n = 0; n < 32; n++) {
        const createdAt = workMoment(-108 + Math.floor(n * 1.7));
        const issue = new Issue(beacon, BEACON_TITLES[title++ % BEACON_TITLES.length]!, pick(["story", "task", "bug"] as const), pick(["medium", "medium", "high"] as const), kenji,
          chance(0.25) ? dateOf(-108 + Math.floor(n * 1.7) + int(7, 20)) : null)
          .create(createdAt, { status: b.backlog, points: chance(0.9) ? pick(POINTS) : null });
        if (n >= 28) { issues.push(issue); continue; }
        let at = createdAt;
        const limit = switchAt - 2 * HOUR;
        const step = (days: number) => (at = Math.min(roundMinute(at + days * DAY), limit - (4 - ++stepIndex) * HOUR));
        let stepIndex = 0;
        issue.change(step(between(0.5, 3)), { status: b.todo }, kenji);
        issue.change(step(between(0.5, 3)), { status: b.progress, assignee: pick(beacon.team) });
        issue.change(step(between(1, 4)), { status: b.review });
        issue.change(step(between(0.5, 2)), { status: b.done });
        issues.push(issue);
      }
      const leftover = issues.filter((issue) => issue.project === beacon && issue.last.status.category !== "done");
      // Plan the leftover Kanban cards into the first sprint.
      runSprints(beacon, [
        { name: "Beacon Sprint 1", goal: "Retention and funnels", startDay: -40, planned: 4, doneShare: 0.75, added: 1, addedDone: 1, removed: 0 },
        { name: "Beacon Sprint 2", goal: "Self-serve onboarding", startDay: -26, planned: 6, doneShare: 0.7, added: 1, addedDone: 0, removed: 1 },
        { name: "Beacon Sprint 3", goal: "Public metrics API", startDay: -12, planned: 6, doneShare: 0.55, added: 1, addedDone: 1, removed: 0, active: true },
      ], BEACON_TITLES.slice(12), leftover);
    }

    // ---------- invariants ----------
    for (const issue of issues) {
      issue.snaps.forEach((snap, index) => {
        if (snap.at >= NOW - MINUTE) throw new Error(`Event in the future: ${issue.project.key} ${issue.title}`);
        if (index > 0 && snap.at <= issue.snaps[index - 1]!.at) throw new Error(`Events out of order: ${issue.project.key} ${issue.title}`);
        if (index > 0 && snap.at < issue.project.createdAt) throw new Error(`Event before project: ${issue.project.key} ${issue.title}`);
      });
    }
    for (const project of [atlas, relay, harbor, beacon]) {
      const current = issues.filter((issue) => issue.project === project && !issue.last.archived);
      for (const st of project.statuses) {
        if (st.wip !== null && current.filter((issue) => issue.last.status.id === st.id).length > st.wip) throw new Error(`${project.key}: WIP limit exceeded in ${st.name}`);
      }
    }

    // ---------- projects, boards, statuses, periods ----------
    for (const project of [atlas, relay, harbor, beacon]) {
      const projectIssues = issues.filter((issue) => issue.project === project).sort((a, b) => a.snaps[0]!.at - b.snaps[0]!.at);
      await client.query(
        `INSERT INTO spark.projects (id, tenant_id, key, name, description, lead_user_id, next_issue_number, methodology, start_date, target_date,
           sprint_length_days, baselined_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
        [project.id, workspace, project.key, project.name, project.description, project.lead.id, projectIssues.length + 1, project.methodology,
          project.startDate, project.targetDate, project.sprintLength, project.baselinedAt === null ? null : iso(project.baselinedAt), iso(project.createdAt)],
      );
      await client.query("INSERT INTO spark.boards (tenant_id, project_id, name, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)",
        [workspace, project.id, project.name, iso(project.createdAt)]);
      for (const [index, st] of project.statuses.entries()) {
        await client.query(
          "INSERT INTO spark.issue_statuses (id, tenant_id, project_id, name, category, position, wip_limit, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)",
          [st.id, workspace, project.id, st.name, st.category, 1024 * (index + 1), null, iso(project.createdAt)],
        );
      }
    }
    for (const period of periods) {
      await client.query(
        `INSERT INTO spark.project_methodology_periods (tenant_id, project_id, methodology, started_at, ended_at, changed_by_user_id, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [workspace, period.project.id, period.methodology, iso(period.startedAt), period.endedAt === null ? null : iso(period.endedAt), period.by.id, period.reason],
      );
    }
    for (const phase of phases) {
      await client.query(
        `INSERT INTO spark.project_phases (id, tenant_id, project_id, name, position, planned_start, planned_end, baseline_start, baseline_end, status, completed_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
        [phase.id, workspace, phase.project.id, phase.name, phase.position, dateOf(phase.plannedStart), dateOf(phase.plannedEnd), dateOf(phase.baselineStart),
          dateOf(phase.baselineEnd), phase.status, phase.completedAt === null ? null : iso(phase.completedAt), iso(phase.project.createdAt)],
      );
    }
    for (const milestone of milestones) {
      await client.query(
        `INSERT INTO spark.project_milestones (tenant_id, project_id, phase_id, name, due_date, baseline_due_date, completed_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [workspace, milestone.project.id, milestone.phase, milestone.name, dateOf(milestone.due), dateOf(milestone.baselineDue),
          milestone.completedAt === null ? null : iso(milestone.completedAt), iso(milestone.project.createdAt)],
      );
    }
    for (const sprint of sprints) {
      const version = sprint.status === "completed" ? 3 : 2;
      await client.query(
        `INSERT INTO spark.sprints (id, tenant_id, project_id, name, goal, starts_at, ends_at, status, version, started_at, completed_at,
           committed_points, committed_count, completed_points, completed_count, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [sprint.id, workspace, sprint.project.id, sprint.name, sprint.goal, iso(TODAY + sprint.startDay * DAY), iso(TODAY + sprint.endDay * DAY), sprint.status, version,
          iso(sprint.startedAt), sprint.completedAt === null ? null : iso(sprint.completedAt), sprint.committedPoints, sprint.committedCount,
          sprint.completedPoints, sprint.completedCount, iso(sprint.createdAt), iso(sprint.completedAt ?? sprint.startedAt)],
      );
    }

    // ---------- issues, replayed version by version ----------
    // check_issue_change_set (deferred) requires the event and outbox row of an issue version to exist while the issue
    // is at that version, so the history is written one version level at a time: every issue with a v-th snapshot moves
    // to version v (insert for v = 1) together with its event and processed outbox row, and the constraint is checked
    // immediately before the next level. guard_issue keeps the explicit started_at (first move to an in_progress
    // status) and completed_at (start of the current done streak), so both carry the back-dated instants.
    const issueIds = new Map<Issue, string>();
    const issueNumbers = new Map<Issue, number>();
    const positions = new Map<Issue, number>();
    for (const project of [atlas, relay, harbor, beacon]) {
      const projectIssues = issues.filter((issue) => issue.project === project).sort((a, b) => a.snaps[0]!.at - b.snaps[0]!.at);
      const columnTops = new Map<string, number>();
      projectIssues.forEach((issue, index) => {
        issueIds.set(issue, randomUUID());
        issueNumbers.set(issue, index + 1);
        const top = (columnTops.get(issue.last.status.id) ?? 0) + 1024;
        columnTops.set(issue.last.status.id, top);
        positions.set(issue, top);
      });
    }
    const timeOrNull = (ms: number | null | undefined) => (ms == null ? null : iso(ms));
    const derived = (issue: Issue, v: number) => {
      const upTo = issue.snaps.slice(0, v + 1);
      const snap = upTo[v]!;
      const startedAt = upTo.find((s) => s.status.category === "in_progress")?.at ?? null;
      let completedAt: number | null = null;
      if (snap.status.category === "done") {
        for (let i = v; i >= 0 && upTo[i]!.status.category === "done"; i--) completedAt = upTo[i]!.at;
      }
      const archivedAt = snap.archived ? upTo.find((s) => s.archived)!.at : null;
      return { snap, startedAt, completedAt, archivedAt };
    };
    const levels = Math.max(...issues.map((issue) => issue.snaps.length));
    let eventCount = 0;
    for (let v = 0; v < levels; v++) {
      const level = issues.filter((issue) => issue.snaps.length > v);
      await client.query("SET CONSTRAINTS spark.issue_change_set DEFERRED");
      for (let offset = 0; offset < level.length; offset += 200) {
        const chunk = level.slice(offset, offset + 200);
        const state = chunk.map((issue) => ({ issue, ...derived(issue, v) }));
        if (v === 0) {
          await client.query(
            `INSERT INTO spark.issues (id, tenant_id, project_id, number, type, title, status_id, priority, reporter_user_id, assignee_user_id,
               position, story_points, due_date, phase_id, started_at, completed_at, created_at, updated_at)
             SELECT id, $1, p, n, ty, ti, st, pr, r, a, pos, sp, d, ph, sa, ca, c, c
             FROM unnest($2::uuid[], $3::uuid[], $4::bigint[], $5::text[], $6::text[], $7::uuid[], $8::text[], $9::uuid[], $10::uuid[], $11::numeric[],
               $12::numeric[], $13::date[], $14::uuid[], $15::timestamptz[], $16::timestamptz[], $17::timestamptz[])
               AS x(id, p, n, ty, ti, st, pr, r, a, pos, sp, d, ph, sa, ca, c)`,
            [workspace, state.map((s) => issueIds.get(s.issue)), state.map((s) => s.issue.project.id), state.map((s) => issueNumbers.get(s.issue)),
              state.map((s) => s.issue.type), state.map((s) => s.issue.title), state.map((s) => s.snap.status.id), state.map((s) => s.issue.priority),
              state.map((s) => s.issue.reporter.id), state.map((s) => s.snap.assignee?.id ?? null), state.map((s) => positions.get(s.issue)),
              state.map((s) => s.snap.points), state.map((s) => s.issue.due), state.map((s) => s.snap.phase), state.map((s) => timeOrNull(s.startedAt)),
              state.map((s) => timeOrNull(s.completedAt)), state.map((s) => iso(s.snap.at))],
          );
        } else {
          await client.query(
            `UPDATE spark.issues i SET status_id = x.st, assignee_user_id = x.a, story_points = x.sp, phase_id = x.ph, sprint_id = x.sid,
               archived_at = x.aa, started_at = x.sa, completed_at = x.ca, version = i.version + 1
             FROM unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::numeric[], $6::uuid[], $7::uuid[], $8::timestamptz[], $9::timestamptz[], $10::timestamptz[])
               AS x(id, st, a, sp, ph, sid, aa, sa, ca)
             WHERE i.tenant_id = $1 AND i.id = x.id`,
            [workspace, state.map((s) => issueIds.get(s.issue)), state.map((s) => s.snap.status.id), state.map((s) => s.snap.assignee?.id ?? null),
              state.map((s) => s.snap.points), state.map((s) => s.snap.phase), state.map((s) => s.snap.sprint), state.map((s) => timeOrNull(s.archivedAt)),
              state.map((s) => timeOrNull(s.startedAt)), state.map((s) => timeOrNull(s.completedAt))],
          );
        }
        // The event's `after` snapshot is built exactly as ws_create_issue / ws_update_issue build it.
        const rows = state.map(({ issue, snap }) => {
          const id = issueIds.get(issue)!;
          const after = { statusId: snap.status.id, category: snap.status.category, assigneeUserId: snap.assignee?.id ?? null, storyPoints: snap.points,
            phaseId: snap.phase, sprintId: snap.sprint, archived: snap.archived };
          const payload = { issueId: id, projectId: issue.project.id, actorUserId: snap.actor.id, assigneeUserId: snap.assignee?.id ?? null };
          return [issue.project.id, id, snap.actor.id, snap.type, JSON.stringify({ fields: snap.fields, after }), JSON.stringify(payload), iso(snap.at)];
        });
        const columns = [workspace, v, ...Array.from({ length: 7 }, (_, column) => rows.map((row) => row[column]))];
        await client.query(
          `INSERT INTO spark.issue_events (tenant_id, project_id, issue_id, actor_user_id, event_type, from_version, to_version, changes, created_at)
           SELECT $1, p, i, a, e, $2::integer, $2::integer + 1, c, at
           FROM unnest($3::uuid[], $4::uuid[], $5::uuid[], $6::text[], $7::jsonb[], $8::jsonb[], $9::timestamptz[]) AS x(p, i, a, e, c, o, at)`,
          columns,
        );
        await client.query(
          `INSERT INTO spark.outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, created_at, available_at, processed_at)
           SELECT $1, e, 'issue', i, $2::integer + 1, o, at, at, at
           FROM unnest($3::uuid[], $4::uuid[], $5::uuid[], $6::text[], $7::jsonb[], $8::jsonb[], $9::timestamptz[]) AS x(p, i, a, e, c, o, at)`,
          columns,
        );
        eventCount += rows.length;
      }
      await client.query("SET CONSTRAINTS spark.issue_change_set IMMEDIATE");
    }
    await client.query("SET CONSTRAINTS spark.issue_change_set DEFERRED");
    // WIP limits are configured on the board now; historical occupancy was not bound by them. guard_status checks the
    // current occupancy against each limit.
    for (const project of [atlas, relay, harbor, beacon]) {
      for (const st of project.statuses.filter((s) => s.wip !== null)) {
        await client.query("UPDATE spark.issue_statuses SET wip_limit = $2 WHERE tenant_id = $1 AND id = $3", [workspace, st.wip, st.id]);
      }
    }

    // ---------- sprint commitments (the snapshot taken at start) ----------
    for (const sprint of sprints) {
      for (const commitment of sprint.commitments) {
        await client.query(
          "INSERT INTO spark.sprint_commitments (tenant_id, sprint_id, issue_id, story_points, created_at) VALUES ($1, $2, $3, $4, $5)",
          [workspace, sprint.id, issueIds.get(commitment.issue), commitment.points, iso(sprint.startedAt)],
        );
      }
    }

    await client.query("COMMIT");
    const count = (project: Project) => issues.filter((issue) => issue.project === project).length;
    console.log(
      `Workspace 'Northstar Labs' created: ${members.length} members (${reused} existing accounts reused), Atlas ${count(atlas)} issues, Relay ${count(relay)}, ` +
        `Harbor ${count(harbor)}, Beacon ${count(beacon)}; ${sprints.length} sprints, ${eventCount} issue events.`,
    );
    console.log(`Sign in as any member, e.g. maya.chen@northstar.test (owner), with the password ${PASSWORD}. Roster: Documents/admin-test-accounts.md`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error("Workspace demo seeding failed:", error);
  process.exitCode = 1;
});
