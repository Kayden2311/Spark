import { weeklyDigestEmail } from "../email/templates/weekly-digest.js";
import type { DigestItem, DigestProject } from "../email/templates/weekly-digest.js";
import { DeliveryError } from "../outbox/dispatcher.js";
import { completion, planWindow } from "../work/domain/metrics.js";
import type { ScopeAggregate } from "../work/domain/metrics.js";
import { createScheduledJob } from "./runner.js";

interface DigestRow {
  status: string;
  email: string | null;
  recipient_name: string | null;
  workspace_name: string | null;
  workspace_slug: string | null;
  section: string | null;
  project_key: string | null;
  project_name: string | null;
  methodology: string | null;
  label: string | null;
  value: string | number | null;
  extra: Record<string, unknown> | null;
}

/** One project line: the database summed the scope in the unit it chose; the shared maths scores it against the plan. */
function projectLine(row: DigestRow, day: string): DigestProject {
  const extra = row.extra;
  if (!row.project_key || !row.project_name || !row.methodology || !extra) throw new DeliveryError("invalid_payload");
  const done = Number(extra.done);
  const total = Number(extra.total);
  if (!Number.isFinite(done) || !Number.isFinite(total)) throw new DeliveryError("invalid_payload");
  // A scope that makes completion() pick the unit the database already chose.
  const scope: ScopeAggregate = extra.unit === "points"
    ? { total_count: "1", done_count: "0", estimated_count: "1", total_points: String(total), done_points: String(done) }
    : { total_count: String(total), done_count: String(done), estimated_count: "0", total_points: "0", done_points: "0" };
  const start = typeof extra.windowStart === "string" ? extra.windowStart : null;
  const end = typeof extra.windowEnd === "string" ? extra.windowEnd : null;
  const sprintName = typeof extra.activeSprintName === "string" ? extra.activeSprintName : "";
  const planned = planWindow(
    { methodology: row.methodology, start_date: start, target_date: end },
    { name: sprintName, starts_on: start, ends_on: end },
  );
  const progress = completion(scope, planned.window, day);
  return {
    key: row.project_key,
    name: row.project_name,
    methodology: row.methodology,
    donePercent: progress.donePercent,
    planPercent: progress.planPercent,
    status: progress.status,
    label: planned.label,
  };
}

function itemLine(row: DigestRow, workspaceUrl: string): DigestItem {
  const extra = row.extra;
  const space = row.label?.indexOf(" ") ?? -1;
  if (!row.label || !row.project_key || space <= 0 || !extra || typeof extra.due !== "string") throw new DeliveryError("invalid_payload");
  const key = row.label.slice(0, space);
  return {
    key,
    title: row.label.slice(space + 1),
    due: extra.due,
    url: `${workspaceUrl}/p/${encodeURIComponent(row.project_key)}?issue=${encodeURIComponent(key)}`,
  };
}

function totalOf(row: DigestRow | undefined, fallback: number): number {
  const total = Number(row?.extra?.total);
  return Number.isFinite(total) ? total : fallback;
}

/**
 * The Monday digest: one email per user and workspace. The database re-reads every section at send time and
 * answers "skipped" when the email is no longer wanted, which closes the row as suppressed.
 */
export const weeklyDigestJob = createScheduledJob("weekly_digest", async (row, lockToken, { pool, appBaseUrl }) => {
  const found = await pool.query<DigestRow>(
    `SELECT status, email, recipient_name, workspace_name, workspace_slug, section, project_key, project_name, methodology, label, value, extra
     FROM spark.worker_weekly_digest_email($1, $2)`,
    [row.id, lockToken],
  );
  const first = found.rows[0];
  if (!first || first.status !== "pending") return { outcome: "skip" };
  if (first.email === null || first.recipient_name === null || first.workspace_name === null || first.workspace_slug === null) {
    throw new DeliveryError("invalid_payload");
  }

  try {
    const workspaceUrl = `${appBaseUrl}/w/${encodeURIComponent(first.workspace_slug)}`;
    const section = (name: string) => found.rows.filter((line) => line.section === name);
    const atRiskRows = section("at_risk");
    const overdueRows = section("overdue");
    const members = section("member")
      .map((line) => ({ name: line.label ?? "", completed: Number(line.value) }))
      .filter((member) => member.name !== "" && Number.isFinite(member.completed))
      .sort((a, b) => b.completed - a.completed || a.name.localeCompare(b.name));
    const message = weeklyDigestEmail({
      recipientName: first.recipient_name,
      workspaceName: first.workspace_name,
      workspaceUrl,
      weekOf: row.period,
      projects: section("project").map((line) => projectLine(line, row.period)),
      members,
      atRisk: atRiskRows.map((line) => itemLine(line, workspaceUrl)),
      overdue: overdueRows.map((line) => itemLine(line, workspaceUrl)),
      atRiskTotal: totalOf(atRiskRows[0], atRiskRows.length),
      overdueTotal: totalOf(overdueRows[0], overdueRows.length),
      preferencesUrl: `${appBaseUrl}/settings/notifications`,
    });
    return { outcome: "send", message: { to: first.email, ...message } };
  } catch (error) {
    throw error instanceof DeliveryError ? error : new DeliveryError("template_error");
  }
});
