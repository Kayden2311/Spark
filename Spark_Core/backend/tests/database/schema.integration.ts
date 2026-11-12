import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, localConnection } from "../../scripts/database-support.js";
import { hashPassword } from "../../src/infrastructure/database/password.js";
import { DETAIL_BY_SLUG_SQL } from "../../src/routes/communities/discovery.js";
import { DEADLINES_SQL } from "../../src/routes/workspace/schedule.js";

const namespace = `spark_test_${randomUUID().replaceAll("-", "")}`;
const journal = `${namespace}_journal`;
const owner = new pg.Client({ connectionString: localConnection("MIGRATION_DATABASE_URL"), connectionTimeoutMillis: 5000 });
const runtime = new pg.Pool({ connectionString: localConnection("DATABASE_URL"), max: 1, connectionTimeoutMillis: 5000 });
const authRuntime = new pg.Pool({ connectionString: localConnection("AUTH_DATABASE_URL"), max: 1, connectionTimeoutMillis: 5000 });
const workerRuntime = new pg.Pool({ connectionString: localConnection("WORKER_DATABASE_URL"), max: 2, connectionTimeoutMillis: 5000 });
let folder: string;
const userA = randomUUID(), userB = randomUUID(), visitor = randomUUID();
const tenantA = randomUUID(), tenantB = randomUUID(), projectA = randomUUID(), projectB = randomUUID(), projectOther = randomUUID();
const statusA = randomUUID(), statusB = randomUUID(), statusOther = randomUUID();
const communityA = randomUUID(), communityB = randomUUID(), publicCommunity = randomUUID(), publicPost = randomUUID(), privatePost = randomUUID();
const table = (name: string) => `"${namespace}"."${name}"`;
// Live sessions for the two workspace owners and the community-only visitor; row access is bound to these,
// not to spark.user_id/tenant_id.
const sessionA = randomBytes(32), sessionB = randomBytes(32), sessionVisitor = randomBytes(32);
// Communities written before 0030 with free-text stages and locations; 0030 normalizes them.
const legacyCommunities = [
  { id: randomUUID(), stage: "Seed", country: " vn ", city: "  Hanoi ", description: "  Founders in Hanoi  " },
  { id: randomUUID(), stage: "Pre-Seed", country: "Vietnam", city: "   ", description: `${"D".repeat(89)} and a tail past ninety characters` },
  { id: randomUUID(), stage: "Any", country: null, city: null, description: "Description" },
  { id: randomUUID(), stage: "Series A", country: "SG", city: "Singapore", description: "Description" },
  { id: randomUUID(), stage: "weird", country: null, city: null, description: "Description" },
  { id: randomUUID(), stage: null, country: null, city: null, description: "   " },
];

async function rollback(work: () => Promise<void>) {
  await owner.query("BEGIN");
  try { await work(); } finally { await owner.query("ROLLBACK"); }
}
async function reject(sql: string, values: unknown[], code: string) {
  await rollback(async () => { await expect(owner.query(sql, values)).rejects.toMatchObject({ code }); });
}

const fn = (name: string) => `"${namespace}".${name}`;
const future = () => new Date(Date.now() + 60 * 60 * 1000);
const newTokenHash = () => randomBytes(32);

// Runs one statement as spark_app inside a transaction bound to a session token hash.
async function asSession(tokenHash: Buffer | null, sql: string, values: unknown[] = []) {
  const client = await runtime.connect();
  try {
    await client.query("BEGIN");
    if (tokenHash) await client.query("SELECT set_config('spark.session_token_hash',$1,true)", [tokenHash.toString("hex")]);
    const result = await client.query(sql, values);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

// Runs one statement as spark_app with only the legacy spark.user_id/spark.tenant_id settings and no session.
async function asSpoofed(userId: string, tenantId: string, sql: string, values: unknown[] = []) {
  const client = await runtime.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('spark.user_id',$1,true), set_config('spark.tenant_id',$2,true)", [userId, tenantId]);
    const result = await client.query(sql, values);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

type Account = { id: string; token: Buffer; email: string };
// A user with a primary email and a live session, created directly by the table owner.
async function account(name: string, email = `${randomUUID()}@example.com`): Promise<Account> {
  const id = randomUUID(), token = newTokenHash();
  await owner.query("SET ROLE spark_owner");
  await owner.query(`INSERT INTO ${table("users")} (id,display_name) VALUES ($1,$2)`, [id, name]);
  await owner.query(`INSERT INTO ${table("user_emails")} (user_id,email,normalized_email,is_primary) VALUES ($1,$2,lower(btrim($2)),true)`, [id, email]);
  await owner.query(`INSERT INTO ${table("sessions")} (user_id,token_hash,auth_method,expires_at) VALUES ($1,$2,'password',$3)`, [id, token, future()]);
  return { id, token, email };
}
const inDays = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);
const uniqueSlug = () => `ws-${randomUUID().slice(0, 12)}`;
async function createWorkspace(who: Account, name = "Acme", slug = uniqueSlug()) {
  return (await asSession(who.token, `SELECT * FROM ${fn("ws_create_workspace")}($1,$2)`, [name, slug])).rows[0] as { outcome: string; workspace_id: string | null };
}
async function addMember(workspace: string, who: Account, role: string) {
  await owner.query("SET ROLE spark_owner");
  await owner.query(`INSERT INTO ${table("workspace_memberships")} (tenant_id,user_id,role) VALUES ($1,$2,$3)`, [workspace, who.id, role]);
}
async function invite(who: Account, workspace: string, email: string, role = "member", expiresAt = inDays(7)) {
  return (await asSession(who.token, `SELECT * FROM ${fn("ws_create_invitation")}($1,$2,$3,$4)`, [workspace, email, role, expiresAt])).rows[0] as { outcome: string; invitation_id: string | null };
}
// Only the worker role can give an invitation a usable token; returns the hash it stored, or null when refused.
async function issueToken(invitation: string): Promise<Buffer | null> {
  const tokenHash = newTokenHash();
  const issued = (await workerRuntime.query(`SELECT ${fn("worker_issue_invitation_token")}($1,$2) AS issued`, [invitation, tokenHash])).rows[0].issued as boolean;
  return issued ? tokenHash : null;
}
async function inviteWithToken(who: Account, workspace: string, email: string, role = "member") {
  const created = await invite(who, workspace, email, role);
  if (created.outcome !== "ok") throw new Error(`Invitation not created: ${created.outcome}`);
  const token = await issueToken(created.invitation_id!);
  if (!token) throw new Error("Token not issued");
  return { invitation: created.invitation_id!, token };
}
async function accept(who: Account, tokenHash: Buffer) {
  return (await asSession(who.token, `SELECT * FROM ${fn("ws_accept_invitation")}($1)`, [tokenHash])).rows[0];
}
const outcome = async (who: Account, call: string, values: unknown[]) => (await asSession(who.token, `SELECT ${fn(call)} AS outcome`, values)).rows[0].outcome as string;
type ProjectFixture = { workspace: string; project: string; todo: string; progress: string };
// A committed project with a board, a todo and an in-progress status and its open methodology period.
async function projectFixture(who: Account, workspace?: string): Promise<ProjectFixture> {
  const tenant = workspace ?? (await createWorkspace(who)).workspace_id!;
  const project = randomUUID(), todo = randomUUID(), progress = randomUUID();
  const key = `P${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
  await owner.query("SET ROLE spark_owner");
  await owner.query("BEGIN");
  try {
    await owner.query(`INSERT INTO ${table("projects")} (id,tenant_id,key,name) VALUES ($1,$2,$3,'Project')`, [project, tenant, key]);
    await owner.query(`INSERT INTO ${table("boards")} (tenant_id,project_id,name) VALUES ($1,$2,'Board')`, [tenant, project]);
    await owner.query(`INSERT INTO ${table("issue_statuses")} (id,tenant_id,project_id,name,category,position) VALUES ($1,$3,$4,'To do','todo',1),($2,$3,$4,'Doing','in_progress',2)`, [todo, progress, tenant, project]);
    await owner.query(`INSERT INTO ${table("project_methodology_periods")} (tenant_id,project_id,methodology,changed_by_user_id,reason) VALUES ($1,$2,'kanban',$3,'Created by test')`, [tenant, project, who.id]);
    await owner.query("COMMIT");
  } catch (error) { await owner.query("ROLLBACK"); throw error; }
  return { workspace: tenant, project, todo, progress };
}
// Inserts an issue with its creation event and outbox row inside the caller's transaction.
async function insertIssue(fixture: ProjectFixture, reporter: string, number: number) {
  const id = randomUUID();
  await owner.query(`INSERT INTO ${table("issues")} (id,tenant_id,project_id,number,title,status_id,reporter_user_id) VALUES ($1,$2,$3,$4,'Task',$5,$6)`, [id, fixture.workspace, fixture.project, number, fixture.todo, reporter]);
  await owner.query(`INSERT INTO ${table("issue_events")} (tenant_id,project_id,issue_id,actor_user_id,event_type,from_version,to_version,changes) VALUES ($1,$2,$3,$4,'created',0,1,'{}')`, [fixture.workspace, fixture.project, id, reporter]);
  await owner.query(`INSERT INTO ${table("outbox_events")} (tenant_id,event_type,aggregate_type,aggregate_id,aggregate_version,payload) VALUES ($1,'issue.created','issue',$2,1,'{}')`, [fixture.workspace, id]);
  return id;
}
// Moves an issue to a status as one complete change set (issue, event, outbox) and checks it at once.
async function moveIssue(fixture: ProjectFixture, issue: string, actor: string, status: string, toVersion: number) {
  await owner.query("SET CONSTRAINTS ALL DEFERRED");
  await owner.query(`UPDATE ${table("issues")} SET status_id=$2,version=$3 WHERE id=$1`, [issue, status, toVersion]);
  await owner.query(`INSERT INTO ${table("issue_events")} (tenant_id,project_id,issue_id,actor_user_id,event_type,from_version,to_version,changes) VALUES ($1,$2,$3,$4,'updated',$5,$6,'{}')`, [fixture.workspace, fixture.project, issue, actor, toVersion - 1, toVersion]);
  await owner.query(`INSERT INTO ${table("outbox_events")} (tenant_id,event_type,aggregate_type,aggregate_id,aggregate_version,payload) VALUES ($1,'issue.updated','issue',$2,$3,'{}')`, [fixture.workspace, issue, toVersion]);
  await owner.query("SET CONSTRAINTS ALL IMMEDIATE");
}
// Expects one statement to fail without aborting the surrounding transaction.
async function rejectInside(sql: string, values: unknown[], code: string) {
  await owner.query("SAVEPOINT probe");
  await expect(owner.query(sql, values)).rejects.toMatchObject({ code });
  await owner.query("ROLLBACK TO SAVEPOINT probe");
}
const auditRows = async (resource: string) => (await owner.query(`SELECT action,actor_user_id,resource_type,metadata FROM ${table("audit_events")} WHERE resource_id=$1 ORDER BY created_at,id`, [resource])).rows;
type StatusInput = { name: string; category: string; wipLimit: number | null };
const status = (name: string, category: string, wipLimit: number | null = null): StatusInput => ({ name, category, wipLimit });
const templateStatuses: Record<string, StatusInput[]> = {
  scrum: [status("Backlog", "backlog"), status("To do", "todo"), status("In progress", "in_progress"), status("In review", "in_progress"), status("Done", "done")],
  kanban: [status("Backlog", "backlog"), status("Ready", "todo", 8), status("In progress", "in_progress", 4), status("Review", "in_progress", 3), status("Done", "done")],
  waterfall: [status("Not started", "todo"), status("In progress", "in_progress"), status("In review", "in_progress"), status("Done", "done")],
};
const waterfallPhases = [
  { name: "Requirements", plannedStart: "2026-11-02", plannedEnd: "2026-11-09" },
  { name: "Design", plannedStart: "2026-11-10", plannedEnd: "2026-11-17" },
  { name: "Build", plannedStart: "2026-11-18", plannedEnd: "2026-11-27" },
  { name: "Test", plannedStart: "2026-11-28", plannedEnd: "2026-12-04" },
  { name: "Deploy", plannedStart: "2026-12-05", plannedEnd: "2026-12-11" },
];
type ProjectInput = { key: string; methodology: string; name?: string; description?: string | null; lead?: string | null; start?: string | null; target?: string | null; sprint?: number | null; statuses?: unknown; phases?: unknown };
const createProjectCall = `SELECT * FROM "${namespace}".ws_create_project($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`;
const projectArgs = (workspace: string, input: ProjectInput) => [workspace, input.key, input.name ?? "Project", input.description ?? null, input.methodology,
  input.lead ?? null, input.start ?? null, input.target ?? null, input.sprint ?? null,
  JSON.stringify(input.statuses === undefined ? templateStatuses[input.methodology] ?? templateStatuses.kanban : input.statuses),
  JSON.stringify(input.phases ?? (input.methodology === "waterfall" ? waterfallPhases : []))];
// Creates a project through the definer function as the given session (null: no session at all).
async function createProject(who: Account | null, workspace: string, input: ProjectInput) {
  return (await asSession(who?.token ?? null, createProjectCall, projectArgs(workspace, input))).rows[0] as { outcome: string; project_id: string | null; settings_version: number | null };
}
const waterfallInput = (key: string): ProjectInput => ({ key, methodology: "waterfall", start: "2026-11-02", target: "2026-12-11" });
async function updateProject(who: Account, project: string, version: number, patch: unknown) {
  return (await asSession(who.token, `SELECT * FROM ${fn("ws_update_project")}($1,$2,$3)`, [project, version, JSON.stringify(patch)])).rows[0] as { outcome: string; settings_version: number | null };
}
type IssueInput = { title?: string; description?: string | null; type?: string | null; priority?: string | null; status?: string | null; assignee?: string | null;
  points?: string | null; due?: string | null; phase?: string | null; key?: string | null; hash?: Buffer | null };
type IssueResult = { outcome: string; issue_id: string | null; issue_version: number | null };
const createIssueCall = `SELECT * FROM "${namespace}".ws_create_issue($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`;
const issueArgs = (project: string, input: IssueInput) => [project, input.title ?? "Task", input.description ?? null, input.type ?? null, input.priority ?? null,
  input.status ?? null, input.assignee ?? null, input.points ?? null, input.due ?? null, input.phase ?? null, input.key ?? null, input.hash ?? null];
// Creates an issue through the definer function as the given session (null: no session at all).
async function createIssue(who: Account | null, project: string, input: IssueInput = {}) {
  return (await asSession(who?.token ?? null, createIssueCall, issueArgs(project, input))).rows[0] as IssueResult;
}
const refusedIssue = (outcome: string): IssueResult => ({ outcome, issue_id: null, issue_version: null });
// A Kanban project with the M2 template statuses, created through ws_create_project.
async function kanbanProject(who: Account, workspace?: string) {
  const tenant = workspace ?? (await createWorkspace(who)).workspace_id!;
  const key = `K${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`;
  const created = await createProject(who, tenant, { key, methodology: "kanban" });
  if (created.outcome !== "ok") throw new Error(`Project not created: ${created.outcome}`);
  return { workspace: tenant, project: created.project_id!, key };
}
async function statusNamed(project: string, name: string) {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT id FROM ${table("issue_statuses")} WHERE project_id=$1 AND name=$2`, [project, name])).rows[0].id as string;
}
const countRows = async (sql: string, values: unknown[]) => {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT count(*)::integer AS total FROM ${sql}`, values)).rows[0].total as number;
};
type UpdateResult = { outcome: string; issue_version: number | null };
const updateIssueCall = `SELECT * FROM "${namespace}".ws_update_issue($1,$2,$3)`;
// Updates an issue through the definer function as the given session.
async function updateIssue(who: Account, issue: string, version: number, patch: unknown) {
  return (await asSession(who.token, updateIssueCall, [issue, version, JSON.stringify(patch)])).rows[0] as UpdateResult;
}
// The non-archived issues of a status in board order.
async function columnOrder(statusId: string) {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT id FROM ${table("issues")} WHERE status_id=$1 AND archived_at IS NULL ORDER BY position,id`, [statusId])).rows.map((row) => row.id as string);
}
async function issueVersion(issue: string) {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT version FROM ${table("issues")} WHERE id=$1`, [issue])).rows[0].version as number;
}
async function issueEvents(issue: string) {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT event_type,actor_user_id,from_version,to_version,changes FROM ${table("issue_events")} WHERE issue_id=$1 ORDER BY to_version`, [issue])).rows;
}
// A Scrum project with the M2 template statuses and an optional lead, created through ws_create_project.
async function scrumProject(who: Account, workspace?: string, lead: string | null = null) {
  const tenant = workspace ?? (await createWorkspace(who)).workspace_id!;
  const key = `S${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`;
  const created = await createProject(who, tenant, { key, name: "Rocket", methodology: "scrum", sprint: 14, lead });
  if (created.outcome !== "ok") throw new Error(`Project not created: ${created.outcome}`);
  return { workspace: tenant, project: created.project_id!, key };
}
type SprintCreated = { outcome: string; sprint_id: string | null; sprint_version: number | null };
type SprintResult = { outcome: string; sprint_version: number | null };
const createSprintCall = `SELECT * FROM "${namespace}".ws_create_sprint($1,$2,$3,$4,$5)`;
async function createSprint(who: Account, project: string, name: unknown = "Sprint", goal: string | null = null, starts: string | null = null, ends: string | null = null) {
  return (await asSession(who.token, createSprintCall, [project, name, goal, starts, ends])).rows[0] as SprintCreated;
}
async function updateSprint(who: Account, sprint: string, version: number, patch: unknown) {
  return (await asSession(who.token, `SELECT * FROM ${fn("ws_update_sprint")}($1,$2,$3)`, [sprint, version, JSON.stringify(patch)])).rows[0] as SprintResult;
}
const startSprintCall = `SELECT * FROM "${namespace}".ws_start_sprint($1,$2)`;
async function startSprint(who: Account, sprint: string, version: number) {
  return (await asSession(who.token, startSprintCall, [sprint, version])).rows[0] as SprintResult;
}
async function completeSprint(who: Account, sprint: string, version: number, carryTo: string | null) {
  return (await asSession(who.token, `SELECT * FROM ${fn("ws_complete_sprint")}($1,$2,$3)`, [sprint, version, carryTo])).rows[0] as SprintResult & { moved_issues: number | null };
}
async function sprintRow(sprint: string) {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT name,goal,status,version,(starts_at AT TIME ZONE 'UTC')::date::text AS starts_on,(ends_at AT TIME ZONE 'UTC')::date::text AS ends_on,
    started_at IS NOT NULL AS started,completed_at IS NOT NULL AS completed,committed_points::text AS committed_points,committed_count,
    completed_points::text AS completed_points,completed_count FROM ${table("sprints")} WHERE id=$1`, [sprint])).rows[0];
}
// Creates an issue and puts it into a sprint; returns the issue id (at version 2).
async function sprintIssue(who: Account, project: string, sprint: string, input: IssueInput = {}) {
  const issue = (await createIssue(who, project, input)).issue_id!;
  const moved = await updateIssue(who, issue, 1, { sprintId: sprint });
  if (moved.outcome !== "ok") throw new Error(`Issue not planned: ${moved.outcome}`);
  return issue;
}
// A Waterfall project (2026-11-02 to 2026-12-11, the five template phases with their sign-off milestones).
async function waterfallProject(who: Account, workspace?: string, lead: string | null = null) {
  const tenant = workspace ?? (await createWorkspace(who)).workspace_id!;
  const key = `W${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`;
  const created = await createProject(who, tenant, { ...waterfallInput(key), lead });
  if (created.outcome !== "ok") throw new Error(`Project not created: ${created.outcome}`);
  return { workspace: tenant, project: created.project_id!, key };
}
type PlanResult = { outcome: string; settings_version: number | null };
const savePhasesCall = `SELECT * FROM "${namespace}".ws_save_phases($1,$2,$3)`;
async function savePhases(who: Account, project: string, version: number, phases: unknown) {
  return (await asSession(who.token, savePhasesCall, [project, version, JSON.stringify(phases)])).rows[0] as PlanResult;
}
async function rebaseline(who: Account, project: string, version: number, reason: unknown) {
  return (await asSession(who.token, `SELECT * FROM ${fn("ws_rebaseline_project")}($1,$2,$3)`, [project, version, reason])).rows[0] as PlanResult;
}
type MilestoneCreated = { outcome: string; milestone_id: string | null; milestone_version: number | null };
type MilestoneResult = { outcome: string; milestone_version: number | null };
async function createMilestone(who: Account, project: string, name: unknown, due: string | null, phase: string | null = null) {
  return (await asSession(who.token, `SELECT * FROM ${fn("ws_create_milestone")}($1,$2,$3,$4)`, [project, name, due, phase])).rows[0] as MilestoneCreated;
}
async function updateMilestone(who: Account, milestone: string, version: number, patch: unknown) {
  return (await asSession(who.token, `SELECT * FROM ${fn("ws_update_milestone")}($1,$2,$3)`, [milestone, version, JSON.stringify(patch)])).rows[0] as MilestoneResult;
}
// The phase plan in order, with baselines and versions.
async function phasePlan(project: string) {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT id,name,position,planned_start::text AS planned_start,planned_end::text AS planned_end,baseline_start::text AS baseline_start,
    baseline_end::text AS baseline_end,version FROM ${table("project_phases")} WHERE project_id=$1 ORDER BY position`, [project])).rows;
}
async function milestoneRows(project: string) {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT id,name,phase_id,due_date::text AS due_date,baseline_due_date::text AS baseline_due_date,completed_at,version
    FROM ${table("project_milestones")} WHERE project_id=$1 ORDER BY due_date,name`, [project])).rows;
}
async function projectPlanState(project: string) {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT settings_version,baselined_at FROM ${table("projects")} WHERE id=$1`, [project])).rows[0] as { settings_version: number; baselined_at: Date | null };
}
// A phase plan entry as ws_save_phases accepts it.
const phaseEntry = (name: string, plannedStart: string, plannedEnd: string, id?: string) => (id ? { id, name, plannedStart, plannedEnd } : { name, plannedStart, plannedEnd });
type StatusResult = { outcome: string; settings_version: number | null };
async function updateStatus(who: Account, statusId: string, version: number, name: unknown, wipLimit: unknown = null, clearWip: boolean | null = false) {
  return (await asSession(who.token, `SELECT * FROM ${fn("ws_update_status")}($1,$2,$3,$4,$5)`, [statusId, version, name, wipLimit, clearWip])).rows[0] as StatusResult;
}
type SwitchResult = { outcome: string; settings_version: number | null; moved_issues: number | null };
type SwitchInput = { to: unknown; columns: unknown; mapping?: unknown; sprintLength?: number | null; start?: string | null; target?: string | null; phases?: unknown; reason?: unknown };
const switchCall = `SELECT * FROM "${namespace}".ws_switch_methodology($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;
const switchArgs = (project: string, version: number, input: SwitchInput) => [project, version, input.to, JSON.stringify(input.columns),
  JSON.stringify(input.mapping === undefined ? {} : input.mapping), input.sprintLength ?? null, input.start ?? null, input.target ?? null,
  input.phases === undefined ? null : JSON.stringify(input.phases), input.reason === undefined ? "Team decision" : input.reason];
async function switchMethodology(who: Account, project: string, version: number, input: SwitchInput) {
  return (await asSession(who.token, switchCall, switchArgs(project, version, input))).rows[0] as SwitchResult;
}
const refusedSwitch = (outcome: string): SwitchResult => ({ outcome, settings_version: null, moved_issues: null });
type ColumnRow = { id: string; name: string; category: string; position: number; wip_limit: number | null };
// The statuses of a project in board order.
async function boardColumns(project: string) {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT id,name,category,position::integer AS position,wip_limit FROM ${table("issue_statuses")} WHERE project_id=$1 ORDER BY position,id`, [project])).rows as ColumnRow[];
}
// A switch column that keeps an existing status, optionally renamed, recategorised or with another WIP limit.
const keepColumn = (row: ColumnRow, changes: { name?: string; category?: string; wipLimit?: number | null } = {}) =>
  ({ id: row.id, name: row.name, category: row.category, wipLimit: row.wip_limit, ...changes });
type IssueState = { id: string; status_id: string; sprint_id: string | null; phase_id: string | null; version: number; archived: boolean };
async function issueStates(project: string) {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT id,status_id,sprint_id,phase_id,version,archived_at IS NOT NULL AS archived FROM ${table("issues")} WHERE project_id=$1 ORDER BY id`, [project])).rows as IssueState[];
}
async function methodologyPeriods(project: string) {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT methodology,started_at,ended_at,changed_by_user_id,reason FROM ${table("project_methodology_periods")} WHERE project_id=$1 ORDER BY started_at,id`, [project])).rows;
}
async function projectSettings(project: string) {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT methodology,sprint_length_days,start_date::text AS start_date,target_date::text AS target_date,settings_version,baselined_at
    FROM ${table("projects")} WHERE id=$1`, [project])).rows[0] as { methodology: string; sprint_length_days: number | null; start_date: string | null; target_date: string | null; settings_version: number; baselined_at: Date | null };
}
// After a switch every issue sits on a status of the project and keeps its sprint and phase (except the open
// issues of planned sprints cancelled on leaving Scrum, listed in toBacklog, which lose their sprint), and the
// periods form one unbroken history (each closed period ends where the next starts) ending in one open period.
async function expectSwitchInvariants(project: string, before: IssueState[], methodology: string, toBacklog: string[] = []) {
  const statusIds = (await boardColumns(project)).map((row) => row.id);
  const after = await issueStates(project);
  for (const row of after) expect(statusIds).toContain(row.status_id);
  const history = (rows: IssueState[]) => rows.map(({ id, sprint_id, phase_id }) => ({ id, sprint_id, phase_id }));
  expect(history(after)).toEqual(history(before).map((row) => (toBacklog.includes(row.id) ? { ...row, sprint_id: null } : row)));
  const periods = await methodologyPeriods(project);
  expect(periods.filter((row) => row.ended_at === null)).toHaveLength(1);
  expect(periods.at(-1)).toMatchObject({ methodology, ended_at: null });
  for (const [index, row] of periods.slice(0, -1).entries()) expect(row.ended_at).toEqual(periods[index + 1]!.started_at);
  expect((await projectSettings(project)).methodology).toBe(methodology);
}
// Opens two runtime connections, each in a transaction bound to one session.
async function sessionPair(accounts: [Account, Account]) {
  const clients = [0, 1].map(() => new pg.Client({ connectionString: localConnection("DATABASE_URL"), connectionTimeoutMillis: 5000 })) as [pg.Client, pg.Client];
  await Promise.all(clients.map((client) => client.connect()));
  for (const [index, client] of clients.entries()) {
    await client.query("SET lock_timeout = '15s'");
    await client.query("BEGIN");
    await client.query("SELECT set_config('spark.session_token_hash',$1,true)", [accounts[index]!.token.toString("hex")]);
  }
  return clients;
}
async function closePair(clients: pg.Client[]) {
  await Promise.allSettled(clients.map((client) => client.query("ROLLBACK")));
  await Promise.allSettled(clients.map((client) => client.end()));
}
const backendPid = async (client: pg.Client) => (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
// Waits until the backend with this pid is blocked on a lock.
async function waitUntilBlocked(pid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await owner.query("SELECT count(*)::integer AS waiting FROM pg_locks WHERE pid=$1 AND NOT granted", [pid])).rows[0].waiting > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
type InsightFixture = { admin: Buffer; communityModerator: Buffer; contentModerator: Buffer; tenant: string; author: string; reporter: string };
// Sessions for the three insight audiences plus a workspace, an author and a reporter for community and report fixtures.
async function insightFixture(): Promise<InsightFixture> {
  const admin = randomUUID(), communityModerator = randomUUID(), contentModerator = randomUUID(), author = randomUUID(), reporter = randomUUID(), tenant = randomUUID();
  const tokens = [newTokenHash(), newTokenHash(), newTokenHash()] as const;
  await owner.query("SET ROLE spark_owner");
  await owner.query(`INSERT INTO ${table("users")} (id,display_name) VALUES ($1,'Insight admin'),($2,'Community moderator'),($3,'Content moderator'),($4,'Insight author'),($5,'Insight reporter')`, [admin, communityModerator, contentModerator, author, reporter]);
  await owner.query(`INSERT INTO ${table("platform_role_assignments")} (user_id,role,granted_by_user_id) VALUES ($1,'platform_admin',$1),($2,'community_moderator',$1),($3,'content_moderator',$1)`, [admin, communityModerator, contentModerator]);
  await owner.query(`INSERT INTO ${table("sessions")} (user_id,token_hash,auth_method,expires_at) VALUES ($1,$4,'password',$7),($2,$5,'password',$7),($3,$6,'password',$7)`, [admin, communityModerator, contentModerator, ...tokens, future()]);
  await owner.query("BEGIN");
  try {
    await owner.query(`INSERT INTO ${table("workspaces")} (id,slug,name,created_by_user_id) VALUES ($1::uuid,$1::text,'Insight workspace',$2)`, [tenant, author]);
    await owner.query(`INSERT INTO ${table("workspace_memberships")} (tenant_id,user_id,role) VALUES ($1,$2,'owner')`, [tenant, author]);
    await owner.query("COMMIT");
  } catch (error) { await owner.query("ROLLBACK"); throw error; }
  return { admin: tokens[0], communityModerator: tokens[1], contentModerator: tokens[2], tenant, author, reporter };
}
// Noon (or `hour`) UTC on the day `daysAgo` days before today (UTC).
function utcDay(daysAgo: number, hour = 12, minute = 0) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo, hour, minute));
}
// A community owned by the fixture author, created (and joined by its owner) at `createdAt`.
async function insightCommunity(fixture: InsightFixture, name: string, createdAt = new Date()) {
  const id = randomUUID();
  await owner.query("SET ROLE spark_owner");
  await owner.query("BEGIN");
  try {
    await owner.query(`INSERT INTO ${table("communities")} (id,tenant_id,slug,name,tagline,description,visibility,created_by_user_id,created_at) VALUES ($1::uuid,$2,$1::text,$3,'Tagline','Description','public',$4,$5)`, [id, fixture.tenant, name, fixture.author, createdAt]);
    await owner.query(`INSERT INTO ${table("community_memberships")} (tenant_id,community_id,user_id,role,joined_at) VALUES ($1,$2,$3,'owner',$4)`, [fixture.tenant, id, fixture.author, createdAt]);
    await owner.query("COMMIT");
  } catch (error) { await owner.query("ROLLBACK"); throw error; }
  return id;
}
// `count` visible posts at 01:00 UTC on the Monday `weeksAgo` weeks before the current UTC week.
async function weeklyPosts(fixture: InsightFixture, community: string, weeksAgo: number, count: number) {
  await owner.query(`INSERT INTO ${table("posts")} (tenant_id,community_id,author_user_id,title,body,created_at)
    SELECT $1,$2,$3,'Post','Body',(date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => $4) + interval '1 hour') AT TIME ZONE 'UTC'
    FROM generate_series(1,$5::integer)`, [fixture.tenant, community, fixture.author, weeksAgo, count]);
}
// A report on a new hidden post, so the fixture never adds visible community activity.
async function insightReport(fixture: InsightFixture, community: string, reason: string, status = "open", createdAt = new Date(), resolvedAt: Date | null = null) {
  const post = randomUUID();
  await owner.query(`INSERT INTO ${table("posts")} (id,tenant_id,community_id,author_user_id,title,body,moderation_status) VALUES ($1,$2,$3,$4,'Reported','Body','hidden')`, [post, fixture.tenant, community, fixture.author]);
  await owner.query(`INSERT INTO ${table("content_reports")} (tenant_id,community_id,reporter_user_id,post_id,reason_code,status,created_at,resolved_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [fixture.tenant, community, fixture.reporter, post, reason, status, createdAt, resolvedAt]);
}
/** One case of frontend/tests/fixtures/community-health.json (shared with the frontend healthOf test). */
interface HealthCase { name: string; recentPosts: number; earlierPosts: number; openReports: number; resolvedReports: number; archived: boolean; expected: string }
// Mirrors healthOf in frontend/src/app/admin/_components/community-actions.ts.
function badgeOf(archived: boolean, openReports: number, weeks: number[]) {
  if (archived) return "archived";
  if (openReports > 0) return "needs_review";
  const recent = weeks.slice(-4).reduce((sum, value) => sum + value, 0);
  const before = weeks.slice(0, -4).reduce((sum, value) => sum + value, 0);
  if (recent === 0) return "quiet";
  if (before === 0 || recent >= before * 1.25) return "growing";
  if (recent <= before * 0.6) return "slowing";
  return "steady";
}

beforeAll(async () => {
  await owner.connect();
  const runtimeDatabase = await runtime.query("SELECT current_database() AS name,current_user AS role");
  const ownerDatabase = await owner.query("SELECT current_database() AS name,current_user AS role");
  if (runtimeDatabase.rows[0].name !== ownerDatabase.rows[0].name || runtimeDatabase.rows[0].role !== "spark_app" || ownerDatabase.rows[0].role !== "spark_migrator") throw new Error("Tests require matching local database and dedicated migration/runtime roles");
  folder = await mkdtemp(join(tmpdir(), "spark-migration-test-"));
  await mkdir(join(folder, "meta"));
  const fullJournal = await readFile(resolve("drizzle/meta/_journal.json"), "utf8");
  for (const file of (await readdir(resolve("drizzle"))).filter((name) => name.endsWith(".sql"))) {
    const sql = (await readFile(resolve("drizzle", file), "utf8")).replace(/\bspark\b/gu, namespace)
      .replaceAll(`${namespace}.user_id`, "spark.user_id").replaceAll(`${namespace}.tenant_id`, "spark.tenant_id")
      .replaceAll(`${namespace}.session_token_hash`, "spark.session_token_hash");
    await writeFile(join(folder, file), sql);
  }
  // The fixtures are written at the pre-M2 schema (through 0016) so the later migrations run over existing data.
  const preM2 = JSON.parse(fullJournal) as { entries: { idx: number }[] };
  preM2.entries = preM2.entries.filter((entry) => entry.idx <= 16);
  await writeFile(join(folder, "meta", "_journal.json"), JSON.stringify(preM2));
  await applyMigrations(owner, folder, namespace, journal);
  await owner.query("SET ROLE spark_owner");
  await owner.query("BEGIN");
  try {
    for (const id of [userA, userB, visitor]) await owner.query(`INSERT INTO ${table("users")} (id,display_name) VALUES ($1,'Test user')`, [id]);
    for (const [id, user] of [[tenantA, userA], [tenantB, userB]]) {
      await owner.query(`INSERT INTO ${table("workspaces")} (id,slug,name,created_by_user_id) VALUES ($1::uuid,$1::text,'Test workspace',$2)`, [id,user]);
      await owner.query(`INSERT INTO ${table("workspace_memberships")} (tenant_id,user_id,role) VALUES ($1,$2,'owner')`, [id,user]);
    }
    for (const [id, tenant, status] of [[projectA,tenantA,statusA], [projectB,tenantB,statusB], [projectOther,tenantA,statusOther]]) {
      await owner.query(`INSERT INTO ${table("projects")} (id,tenant_id,key,name) VALUES ($1::uuid,$2,$1::text,'Project')`, [id,tenant]);
      await owner.query(`INSERT INTO ${table("boards")} (tenant_id,project_id,name) VALUES ($1,$2,'Board')`, [tenant,id]);
      await owner.query(`INSERT INTO ${table("issue_statuses")} (id,tenant_id,project_id,name,category) VALUES ($1,$2,$3,'To do','todo')`, [status,tenant,id]);
    }
    for (const [id,tenant,user,visibility] of [[communityA,tenantA,userA,"private"], [communityB,tenantB,userB,"hidden"], [publicCommunity,tenantB,userB,"public"]]) {
      await owner.query(`INSERT INTO ${table("communities")} (id,tenant_id,slug,name,description,visibility,created_by_user_id) VALUES ($1::uuid,$2,$1::text,'Community','Description',$3,$4)`, [id,tenant,visibility,user]);
      await owner.query(`INSERT INTO ${table("community_memberships")} (tenant_id,community_id,user_id,role) VALUES ($1,$2,$3,'owner')`, [tenant,id,user]);
    }
    for (const legacy of legacyCommunities) {
      await owner.query(`INSERT INTO ${table("communities")} (id,tenant_id,slug,name,description,visibility,stage,country_code,city,created_by_user_id) VALUES ($1::uuid,$2,$1::text,'Legacy community',$3,'private',$4,$5,$6,$7)`,
        [legacy.id, tenantA, legacy.description, legacy.stage, legacy.country, legacy.city, userA]);
      await owner.query(`INSERT INTO ${table("community_memberships")} (tenant_id,community_id,user_id,role) VALUES ($1,$2,$3,'owner')`, [tenantA, legacy.id, userA]);
    }
    await owner.query(`INSERT INTO ${table("community_memberships")} (tenant_id,community_id,user_id) VALUES ($1,$2,$3)`, [tenantA,communityA,visitor]);
    await owner.query(`INSERT INTO ${table("posts")} (id,tenant_id,community_id,author_user_id,title,body,visibility) VALUES ($1,$2,$3,$4,'Private','Private body','members'),($5,$6,$7,$8,'Public','Public body','public')`, [privatePost,tenantA,communityA,userA,publicPost,tenantB,publicCommunity,userB]);
    await owner.query(`INSERT INTO ${table("sessions")} (user_id,token_hash,auth_method,expires_at) VALUES ($1,$2,'password',$7),($3,$4,'password',$7),($5,$6,'password',$7)`, [userA,sessionA,userB,sessionB,visitor,sessionVisitor,new Date(Date.now()+60*60*1000)]);
    await owner.query("COMMIT");
  } catch (error) { await owner.query("ROLLBACK"); throw error; }
  await writeFile(join(folder, "meta", "_journal.json"), fullJournal);
  await applyMigrations(owner, folder, namespace, journal);
  await owner.query("SET ROLE spark_owner");
});

afterAll(async () => {
  await runtime.end();
  await authRuntime.end();
  await workerRuntime.end();
  try {
    await owner.query("ROLLBACK");
    await owner.query("SET ROLE spark_owner");
    // Only randomly generated test namespaces in the already-validated local DB.
    if (!/^spark_test_[a-f0-9]{32}$/u.test(namespace)) throw new Error("Unsafe test cleanup target");
    await owner.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await owner.query(`DROP SCHEMA IF EXISTS "${journal}" CASCADE`);
  } finally {
    await owner.end();
    if (folder && resolve(folder).startsWith(resolve(tmpdir()) + "\\") && folder.includes("spark-migration-test-")) await rm(folder, { recursive: true, force: true });
  }
});

describe("Local PostgreSQL schema", () => {
  it("migrates 66 tables with FORCE RLS and a non-login owner", async () => {
    const result = await owner.query("SELECT count(*)::integer AS count,bool_and(c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner)='spark_owner') AS secured FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r'", [namespace]);
    expect(result.rows[0]).toEqual({ count:66, secured:true });
    const roles = await owner.query("SELECT rolname,rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname IN ('spark_owner','spark_app') ORDER BY rolname");
    expect(roles.rows).toEqual([{rolname:"spark_app",rolsuper:false,rolbypassrls:false,rolcanlogin:true},{rolname:"spark_owner",rolsuper:false,rolbypassrls:false,rolcanlogin:false}]);
  });
  it("has no foreign key without a leading-column index", async () => {
    const missing = await owner.query(`SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND c.contype='f' AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=c.conrelid AND i.indisvalid AND i.indpred IS NULL AND (i.indkey::smallint[])[0:cardinality(c.conkey)-1] @> c.conkey)`, [namespace]);
    expect(missing.rows).toEqual([]);
  });
  it("replays migrations without changes and refuses edited applied files", async () => {
    await applyMigrations(owner, folder, namespace, journal);
    await owner.query("SET ROLE spark_owner");
    const result = await owner.query(`SELECT count(*)::integer AS count FROM "${journal}".__drizzle_migrations`);
    expect(result.rows[0].count).toBe(34);
    const file = join(folder,"0001_integrity.sql"), original = await readFile(file,"utf8");
    try {
      await writeFile(file,original+"\n-- changed\n");
      await expect(applyMigrations(owner,folder,namespace,journal)).rejects.toThrow("Migration history mismatch");
    } finally { await writeFile(file,original); await owner.query("SET ROLE spark_owner"); }
  });
  it("stores a real Argon2id hash and rejects plaintext", async () => {
    const encoded = await hashPassword("database-test-password");
    await rollback(async () => {
      await owner.query(`INSERT INTO ${table("password_credentials")} (user_id,password_hash) VALUES ($1,$2)`,[userA,encoded]);
      expect((await owner.query(`SELECT password_hash FROM ${table("password_credentials")} WHERE user_id=$1`,[userA])).rows[0].password_hash).toBe(encoded);
    });
    await reject(`INSERT INTO ${table("password_credentials")} (user_id,password_hash) VALUES ($1,'plaintext')`,[userA],"23514");
  });
  it("supports a Google-only user and rejects attaching the same provider subject twice", async () => {
    await rollback(async () => {
      await owner.query(`INSERT INTO ${table("auth_identities")} (user_id,provider,issuer,provider_subject) VALUES ($1,'google','https://accounts.google.com','test-subject')`,[visitor]);
      expect((await owner.query(`SELECT * FROM ${table("password_credentials")} WHERE user_id=$1`,[visitor])).rows).toHaveLength(0);
      await expect(owner.query(`INSERT INTO ${table("auth_identities")} (user_id,provider,issuer,provider_subject) VALUES ($1,'google','https://accounts.google.com','test-subject')`,[userA])).rejects.toMatchObject({code:"23505"});
    });
  });
  it("rejects cross-tenant and same-tenant wrong-project statuses", async () => {
    for (const badStatus of [statusB,statusOther]) await reject(`INSERT INTO ${table("issues")} (tenant_id,project_id,number,title,status_id,reporter_user_id) VALUES ($1,$2,1,'Task',$3,$4)`,[tenantA,projectA,badStatus,userA],"23503");
    await reject(`INSERT INTO ${table("issues")} (tenant_id,project_id,number,title,status_id,reporter_user_id,assignee_user_id) VALUES ($1,$2,1,'Task',$3,$4,$5)`,[tenantA,projectA,statusA,userA,userB],"23503");
  });
  it("preserves workspace and community ownership at transaction commit", async () => {
    await rollback(async () => {
      await owner.query(`UPDATE ${table("workspace_memberships")} SET role='member' WHERE tenant_id=$1`,[tenantA]);
      await expect(owner.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({code:"23514"});
    });
    await rollback(async () => {
      await owner.query(`UPDATE ${table("community_memberships")} SET role='member' WHERE tenant_id=$1 AND role='owner'`,[tenantA]);
      await expect(owner.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({code:"23514"});
    });
  });
  it("enforces issue version, hierarchy, WIP and append-only history", async () => {
    await rollback(async () => {
      await owner.query(`UPDATE ${table("issue_statuses")} SET wip_limit=1 WHERE id=$1`,[statusA]);
      const result = await owner.query(`INSERT INTO ${table("issues")} (tenant_id,project_id,number,title,status_id,reporter_user_id) VALUES ($1,$2,1,'Task',$3,$4) RETURNING id`,[tenantA,projectA,statusA,userA]);
      await owner.query(`INSERT INTO ${table("issue_events")} (tenant_id,project_id,issue_id,actor_user_id,event_type,from_version,to_version,changes) VALUES ($1,$2,$3,$4,'created',0,1,'{}')`,[tenantA,projectA,result.rows[0].id,userA]);
      await expect(owner.query(`UPDATE ${table("issues")} SET title='Stale edit' WHERE id=$1`,[result.rows[0].id])).rejects.toMatchObject({code:"23514"});
    });
    await rollback(async () => {
      await owner.query(`UPDATE ${table("issue_statuses")} SET wip_limit=1 WHERE id=$1`,[statusA]);
      await owner.query(`INSERT INTO ${table("issues")} (tenant_id,project_id,number,title,status_id,reporter_user_id) VALUES ($1,$2,1,'Task',$3,$4)`,[tenantA,projectA,statusA,userA]);
      await expect(owner.query(`INSERT INTO ${table("issues")} (tenant_id,project_id,number,title,status_id,reporter_user_id) VALUES ($1,$2,2,'Over capacity',$3,$4)`,[tenantA,projectA,statusA,userA])).rejects.toMatchObject({code:"23514"});
    });
    await reject(`INSERT INTO ${table("issues")} (tenant_id,project_id,number,title,status_id,reporter_user_id,type) VALUES ($1,$2,1,'Missing parent',$3,$4,'subtask')`,[tenantA,projectA,statusA,userA],"23514");
    await rollback(async () => {
      await owner.query(`INSERT INTO ${table("audit_events")} (tenant_id,actor_kind,action,resource_type,resource_id) VALUES ($1,'system','test','workspace',$1)`,[tenantA]);
      await expect(owner.query(`DELETE FROM ${table("audit_events")}`)).rejects.toMatchObject({code:"23514"});
    });
  });
  it("allows provider-free subscriptions only for explicitly free plans", async () => {
    await rollback(async () => {
      const freePlan=await owner.query(`INSERT INTO ${table("subscription_plans")} (code,name,billing_kind) VALUES ('free','Free','free') RETURNING id`);
      const paidPlan=await owner.query(`INSERT INTO ${table("subscription_plans")} (code,name,billing_kind) VALUES ('paid','Paid','paid') RETURNING id`);
      await owner.query(`INSERT INTO ${table("subscriptions")} (tenant_id,plan_id,billing_kind,status) VALUES ($1,$2,'free','active')`,[tenantA,freePlan.rows[0].id]);
      await expect(owner.query(`INSERT INTO ${table("subscriptions")} (tenant_id,plan_id,billing_kind,status) VALUES ($1,$2,'free','active')`,[tenantB,paidPlan.rows[0].id])).rejects.toMatchObject({code:"23503"});
    });
  });
  it("rejects invalid IANA timezones", async () => {
    await reject(`UPDATE ${table("users")} SET timezone='Definitely/Not_A_Zone' WHERE id=$1`,[userA],"23514");
  });
  it("requires issue versions to commit with matching history and outbox", async () => {
    await rollback(async () => {
      await owner.query(`INSERT INTO ${table("issues")} (tenant_id,project_id,number,title,status_id,reporter_user_id) VALUES ($1,$2,99,'Incomplete',$3,$4)`,[tenantA,projectA,statusA,userA]);
      await expect(owner.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({code:"23514"});
    });
  });
  it("rejects issue changes that reuse a completed version history set", async () => {
    await rollback(async () => {
      const issue=randomUUID();
      await owner.query(`INSERT INTO ${table("issues")} (id,tenant_id,project_id,number,title,status_id,reporter_user_id) VALUES ($1,$2,$3,199,'Complete',$4,$5)`,[issue,tenantA,projectA,statusA,userA]);
      await owner.query(`INSERT INTO ${table("issue_events")} (tenant_id,project_id,issue_id,actor_user_id,event_type,from_version,to_version,changes) VALUES ($1,$2,$3,$4,'created',0,1,'{}')`,[tenantA,projectA,issue,userA]);
      await owner.query(`INSERT INTO ${table("outbox_events")} (tenant_id,event_type,aggregate_type,aggregate_id,aggregate_version,payload) VALUES ($1,'issue.created','issue',$2,1,'{}')`,[tenantA,issue]);
      await owner.query("SET CONSTRAINTS ALL IMMEDIATE");
      await expect(owner.query(`UPDATE ${table("issues")} SET title='Unaudited' WHERE id=$1`,[issue])).rejects.toMatchObject({code:"23514"});
    });
  });
  it("rejects payment before approval and requires cancellation after refund", async () => {
    await rollback(async () => {
      const placement=await owner.query(`INSERT INTO ${table("promotion_placements")} (code,name,description) VALUES ('test-placement','Test','Test') RETURNING id`);
      const plan=await owner.query(`INSERT INTO ${table("promotion_plans")} (code,version,name,placement_id,duration_days,currency,amount_minor,provider,provider_price_id) VALUES ('test-plan',1,'Test',$1,7,'USD',1000,'test','price') RETURNING id`,[placement.rows[0].id]);
      const customer=await owner.query(`INSERT INTO ${table("billing_customers")} (tenant_id,provider,provider_customer_id) VALUES ($1,'test','customer') RETURNING id`,[tenantA]);
      const campaign=await owner.query(`INSERT INTO ${table("promotion_campaigns")} (tenant_id,community_id,name,headline,description,placement_id,submitted_by_user_id,requested_start_at) VALUES ($1,$2,'Test','Headline','Description',$3,$4,now()) RETURNING id`,[tenantA,communityA,placement.rows[0].id,userA]);
      await owner.query(`INSERT INTO ${table("promotion_orders")} (tenant_id,campaign_id,promotion_plan_id,billing_customer_id,provider,idempotency_key,currency,amount_minor,duration_days,status,terms_snapshot) VALUES ($1,$2,$3,$4,'test','key','USD',1000,7,'paid','{}')`,[tenantA,campaign.rows[0].id,plan.rows[0].id,customer.rows[0].id]);
      await expect(owner.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({code:"23514"});
    });
  });
  it("requires atomic campaign cancellation when a paid order is refunded", async () => {
    await rollback(async () => {
      const placement=await owner.query(`INSERT INTO ${table("promotion_placements")} (code,name,description) VALUES ('refund-placement','Test','Test') RETURNING id`);
      const plan=await owner.query(`INSERT INTO ${table("promotion_plans")} (code,version,name,placement_id,duration_days,currency,amount_minor,provider,provider_price_id) VALUES ('refund-plan',1,'Test',$1,7,'USD',1000,'refund-test','price') RETURNING id`,[placement.rows[0].id]);
      const customer=await owner.query(`INSERT INTO ${table("billing_customers")} (tenant_id,provider,provider_customer_id) VALUES ($1,'refund-test','customer') RETURNING id`,[tenantA]);
      const campaign=await owner.query(`INSERT INTO ${table("promotion_campaigns")} (tenant_id,community_id,name,headline,description,placement_id,submitted_by_user_id,requested_start_at) VALUES ($1,$2,'Refund','Headline','Description',$3,$4,now()) RETURNING id`,[tenantA,communityA,placement.rows[0].id,userA]);
      await owner.query(`INSERT INTO ${table("promotion_reviews")} (tenant_id,campaign_id,campaign_version,reviewer_user_id,decision,reason) VALUES ($1,$2,2,$3,'approve','Approved')`,[tenantA,campaign.rows[0].id,userB]);
      await owner.query(`UPDATE ${table("promotion_campaigns")} SET version=2,review_status='approved',approved_version=2 WHERE id=$1`,[campaign.rows[0].id]);
      const order=await owner.query(`INSERT INTO ${table("promotion_orders")} (tenant_id,campaign_id,promotion_plan_id,billing_customer_id,provider,idempotency_key,currency,amount_minor,duration_days,status,terms_snapshot) VALUES ($1,$2,$3,$4,'refund-test','refund-key','USD',1000,7,'paid','{}') RETURNING id`,[tenantA,campaign.rows[0].id,plan.rows[0].id,customer.rows[0].id]);
      await owner.query("SET CONSTRAINTS ALL IMMEDIATE"); await owner.query("SET CONSTRAINTS ALL DEFERRED"); await owner.query("SAVEPOINT before_refund");
      await owner.query(`UPDATE ${table("promotion_orders")} SET status='refunded' WHERE id=$1`,[order.rows[0].id]);
      await expect(owner.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({code:"23514"});
      await owner.query("ROLLBACK TO SAVEPOINT before_refund"); await owner.query("SET CONSTRAINTS ALL DEFERRED");
      await owner.query(`UPDATE ${table("promotion_orders")} SET status='refunded' WHERE id=$1`,[order.rows[0].id]);
      await owner.query(`UPDATE ${table("promotion_campaigns")} SET version=3,delivery_status='cancelled',review_status='pending',approved_version=NULL WHERE id=$1`,[campaign.rows[0].id]);
      await owner.query("SET CONSTRAINTS ALL IMMEDIATE");
    });
  });
  it("ignores non-issue outbox events even when IDs overlap an issue", async () => {
    await rollback(async () => {
      const issue=randomUUID();
      await owner.query(`INSERT INTO ${table("issues")} (id,tenant_id,project_id,number,title,status_id,reporter_user_id) VALUES ($1,$2,$3,299,'Complete',$4,$5)`,[issue,tenantA,projectA,statusA,userA]);
      await owner.query(`INSERT INTO ${table("issue_events")} (tenant_id,project_id,issue_id,actor_user_id,event_type,from_version,to_version,changes) VALUES ($1,$2,$3,$4,'created',0,1,'{}')`,[tenantA,projectA,issue,userA]);
      await owner.query(`INSERT INTO ${table("outbox_events")} (tenant_id,event_type,aggregate_type,aggregate_id,aggregate_version,payload) VALUES ($1,'issue.created','issue',$2,1,'{}'),($1,'workspace.changed','workspace',$2,1,'{}')`,[tenantA,issue]);
      await owner.query("SET CONSTRAINTS ALL IMMEDIATE");
    });
  });
  it("serializes concurrent WIP admission across two database sessions", async () => {
    const second = new pg.Client({ connectionString: localConnection("MIGRATION_DATABASE_URL"), connectionTimeoutMillis: 5000 });
    await second.connect();
    try {
      await owner.query("BEGIN"); await second.query("BEGIN"); await second.query("SET ROLE spark_owner");
      const firstIssue=randomUUID(), secondIssue=randomUUID();
      await owner.query(`UPDATE ${table("issue_statuses")} SET wip_limit=1 WHERE id=$1`,[statusA]);
      await owner.query(`INSERT INTO ${table("issues")} (id,tenant_id,project_id,number,title,status_id,reporter_user_id) VALUES ($1,$2,$3,501,'First',$4,$5)`,[firstIssue,tenantA,projectA,statusA,userA]);
      await owner.query(`INSERT INTO ${table("issue_events")} (tenant_id,project_id,issue_id,actor_user_id,event_type,from_version,to_version,changes) VALUES ($1,$2,$3,$4,'created',0,1,'{}')`,[tenantA,projectA,firstIssue,userA]);
      await owner.query(`INSERT INTO ${table("outbox_events")} (tenant_id,event_type,aggregate_type,aggregate_id,aggregate_version,payload) VALUES ($1,'issue.created','issue',$2,1,'{}')`,[tenantA,firstIssue]);
      const competing = second.query(`INSERT INTO ${table("issues")} (id,tenant_id,project_id,number,title,status_id,reporter_user_id) VALUES ($1,$2,$3,502,'Second',$4,$5)`,[secondIssue,tenantA,projectA,statusA,userA]);
      await new Promise(resolve=>setTimeout(resolve,50));
      await owner.query("COMMIT");
      await expect(competing).rejects.toMatchObject({code:"23514"});
      await second.query("ROLLBACK");

    } finally { try { await second.query("ROLLBACK"); } catch {} await second.end(); }
  });
  it("enforces notification recipient/event uniqueness and discount shape", async () => {
    await reject(`INSERT INTO ${table("promotions")} (code_normalized,name,discount_type,starts_at,ends_at) VALUES ('TEST','Test','percent',now(),now()+interval '1 day')`,[],"23514");
    await reject(`INSERT INTO ${table("calendar_events")} (tenant_id,organizer_user_id,title,starts_at,ends_at) VALUES ($1,$2,'Invalid',now(),now()-interval '1 hour')`,[tenantA,userA],"23514");
    await rollback(async () => {
      const event=await owner.query(`INSERT INTO ${table("outbox_events")} (tenant_id,event_type,aggregate_type,aggregate_id,aggregate_version,payload) VALUES ($1,'test','workspace',$1,1,'{}') RETURNING id`,[tenantA]);
      const sql=`INSERT INTO ${table("notifications")} (tenant_id,recipient_user_id,outbox_event_id,kind,title,resource_type,resource_id) VALUES ($1,$2,$3,'invitation_accepted','Test','workspace',$1)`;
      const values=[tenantA,userA,event.rows[0].id];
      await owner.query(sql,values); await expect(owner.query(sql,values)).rejects.toMatchObject({code:"23505"});
    });
    await rollback(async () => {
      const event=await owner.query(`INSERT INTO ${table("outbox_events")} (tenant_id,event_type,aggregate_type,aggregate_id,aggregate_version,payload) VALUES ($1,'test','workspace',$1,1,'{}') RETURNING id`,[tenantA]);
      await expect(owner.query(`INSERT INTO ${table("notifications")} (tenant_id,recipient_user_id,outbox_event_id,kind,title,resource_type,resource_id) VALUES ($1,$2,$3,'unknown_kind','Test','workspace',$1)`,[tenantA,userA,event.rows[0].id])).rejects.toMatchObject({code:"23514"});
    });
  });
  it("isolates tenants and clears pooled context after commit and rollback", async () => {
    const first = await asSession(sessionA, `SELECT id FROM ${table("projects")}`);
    expect(first.rows.map(row=>row.id).sort()).toEqual([projectA,projectOther].sort());
    const second = await asSession(sessionB, `SELECT id FROM ${table("projects")}`);
    expect(second.rows).toEqual([{id:projectB}]);
    expect((await runtime.query(`SELECT * FROM ${table("projects")}`)).rows).toEqual([]);
    await expect(asSession(sessionA, "SELECT 1/0")).rejects.toMatchObject({code:"22012"});
    expect((await runtime.query(`SELECT * FROM ${table("projects")}`)).rows).toEqual([]);
    expect((await asSession(newTokenHash(), `SELECT id FROM ${table("projects")}`)).rows).toEqual([]);
  });
  it("ignores spoofed tenant settings", async () => {
    const client = await runtime.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('spark.user_id',$1,true), set_config('spark.tenant_id',$2,true)", [userA, tenantA]);
      expect((await client.query(`SELECT id FROM ${table("workspaces")}`)).rows).toEqual([]);
      expect((await client.query(`SELECT id FROM ${table("projects")}`)).rows).toEqual([]);
      expect((await client.query(`SELECT id FROM ${table("workspace_memberships")}`)).rows).toEqual([]);
      expect((await client.query(`SELECT id FROM ${table("users")}`)).rows).toEqual([]);
      await client.query("COMMIT");
    } finally { await client.query("ROLLBACK").catch(() => undefined); client.release(); }
  });
  it("hides workspaces after leaving or suspension", async () => {
    const coOwner = randomUUID();
    const visible = async () => ({
      workspaces: (await asSession(sessionA, `SELECT id FROM ${table("workspaces")}`)).rows.length,
      memberships: (await asSession(sessionA, `SELECT id FROM ${table("workspace_memberships")}`)).rows.length,
      projects: (await asSession(sessionA, `SELECT id FROM ${table("projects")}`)).rows.length,
    });
    await owner.query("SET ROLE spark_owner");
    await owner.query(`INSERT INTO ${table("users")} (id,display_name) VALUES ($1,'Co-owner')`, [coOwner]);
    await owner.query(`INSERT INTO ${table("workspace_memberships")} (tenant_id,user_id,role) VALUES ($1,$2,'owner')`, [tenantA, coOwner]);
    expect(await visible()).toEqual({ workspaces: 1, memberships: 2, projects: 2 });
    try {
      await owner.query(`UPDATE ${table("workspace_memberships")} SET status='left',left_at=now() WHERE tenant_id=$1 AND user_id=$2`, [tenantA, userA]);
      expect(await visible()).toEqual({ workspaces: 0, memberships: 0, projects: 0 });
      await owner.query(`UPDATE ${table("workspace_memberships")} SET status='suspended',left_at=NULL WHERE tenant_id=$1 AND user_id=$2`, [tenantA, userA]);
      expect(await visible()).toEqual({ workspaces: 0, memberships: 0, projects: 0 });
      await owner.query(`UPDATE ${table("workspace_memberships")} SET status='active' WHERE tenant_id=$1 AND user_id=$2`, [tenantA, userA]);
      await owner.query(`UPDATE ${table("workspaces")} SET status='archived',archived_at=now(),version=version+1 WHERE id=$1`, [tenantA]);
      expect(await visible()).toEqual({ workspaces: 0, memberships: 0, projects: 0 });
      await owner.query(`UPDATE ${table("workspaces")} SET status='active',archived_at=NULL,version=version+1 WHERE id=$1`, [tenantA]);
      await owner.query(`UPDATE ${table("users")} SET status='suspended' WHERE id=$1`, [userA]);
      expect(await visible()).toEqual({ workspaces: 0, memberships: 0, projects: 0 });
    } finally {
      await owner.query(`UPDATE ${table("users")} SET status='active' WHERE id=$1`, [userA]);
      await owner.query(`UPDATE ${table("workspace_memberships")} SET status='active',left_at=NULL WHERE tenant_id=$1 AND user_id=$2`, [tenantA, userA]);
      await owner.query(`UPDATE ${table("workspaces")} SET status='active',archived_at=NULL,version=version+1 WHERE id=$1 AND status<>'active'`, [tenantA]);
      await owner.query(`DELETE FROM ${table("workspace_memberships")} WHERE tenant_id=$1 AND user_id=$2`, [tenantA, coOwner]);
    }
    expect(await visible()).toEqual({ workspaces: 1, memberships: 1, projects: 2 });
  });
  it("lets members read coworkers but not strangers", async () => {
    const coworker = randomUUID();
    await owner.query("SET ROLE spark_owner");
    await owner.query(`INSERT INTO ${table("users")} (id,display_name) VALUES ($1,'Coworker')`, [coworker]);
    await owner.query(`INSERT INTO ${table("workspace_memberships")} (tenant_id,user_id,role) VALUES ($1,$2,'member')`, [tenantA, coworker]);
    try {
      const readable = async (token: Buffer) => (await asSession(token, `SELECT id FROM ${table("users")}`)).rows.map((row) => row.id).sort();
      // visitor shares only a community with userA, which does not make them coworkers.
      expect(await readable(sessionA)).toEqual([userA, coworker].sort());
      expect(await readable(sessionB)).toEqual([userB]);
      await owner.query(`UPDATE ${table("workspace_memberships")} SET status='left',left_at=now() WHERE tenant_id=$1 AND user_id=$2`, [tenantA, coworker]);
      expect(await readable(sessionA)).toEqual([userA]);
    } finally {
      await owner.query(`DELETE FROM ${table("workspace_memberships")} WHERE tenant_id=$1 AND user_id=$2`, [tenantA, coworker]);
    }
  });
  it("registers without creating a workspace", async () => {
    const token = newTokenHash();
    const registered = await authRuntime.query(`SELECT * FROM ${fn("auth_register_password")}($1,$2,$3,$4,$5)`, ["Solo User", "solo.user@example.com", await hashPassword("solo user password"), token, future()]);
    const created = registered.rows[0];
    expect(created).toMatchObject({ workspace_id: null, workspace_name: null, workspace_slug: null });
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT count(*)::integer AS total FROM ${table("workspaces")} WHERE created_by_user_id=$1`, [created.user_id])).rows[0].total).toBe(0);
    expect((await owner.query(`SELECT count(*)::integer AS total FROM ${table("workspace_memberships")} WHERE user_id=$1`, [created.user_id])).rows[0].total).toBe(0);
    expect((await authRuntime.query(`SELECT workspaces FROM ${fn("auth_session_principal")}($1)`, [token])).rows[0].workspaces).toEqual([]);
  });
  it("binds workspace versions to the record trigger", async () => {
    await reject(`UPDATE ${table("workspaces")} SET name='Stale rename' WHERE id=$1`, [tenantA], "23514");
    await rollback(async () => {
      await owner.query(`UPDATE ${table("workspaces")} SET name='Renamed',version=version+1 WHERE id=$1`, [tenantA]);
    });
  });
  it("separates community-only membership from workspace access and public visibility", async () => {
    expect((await asSession(sessionVisitor, `SELECT * FROM ${table("projects")}`)).rows).toHaveLength(0);
    expect((await asSession(sessionVisitor, `SELECT id FROM ${table("posts")} WHERE id=$1`, [privatePost])).rows).toEqual([{id:privatePost}]);
    expect((await asSession(sessionA, `SELECT id FROM ${table("communities")} WHERE id=$1`, [communityB])).rows).toHaveLength(0);
    // Content of a public community is readable by everyone, signed out too (C2).
    expect((await asSession(sessionA, `SELECT id FROM ${table("posts")} WHERE id=$1`, [publicPost])).rows).toEqual([{id:publicPost}]);
    expect((await asSession(null, `SELECT id FROM ${table("posts")} WHERE id=$1`, [publicPost])).rows).toEqual([{id:publicPost}]);
    expect((await asSession(null, `SELECT id FROM ${table("posts")} WHERE id=$1`, [privatePost])).rows).toEqual([]);
  });
  it("denies runtime writes, role escalation and sensitive table reads", async () => {
    for (const sensitive of ["password_credentials","auth_identities","sessions","account_tokens","content_reports","payment_events","promotion_orders","platform_role_assignments"]) {
      await expect(runtime.query(`SELECT * FROM ${table(sensitive)}`)).rejects.toMatchObject({code:"42501"});
    }
    // Notifications are readable since 0019, but only the recipient's own rows (none without a session).
    expect((await runtime.query(`SELECT * FROM ${table("notifications")}`)).rows).toEqual([]);
    await expect(asSession(sessionA, `UPDATE ${table("workspace_memberships")} SET role='owner'`)).rejects.toMatchObject({code:"42501"});
    await expect(runtime.query("SET ROLE spark_owner")).rejects.toMatchObject({code:"42501"});
  });
  it("authenticates only through the login role", async () => {
    const password = await hashPassword("correct horse battery staple");
    const token = newTokenHash();
    const registered = await authRuntime.query(`SELECT * FROM ${fn("auth_register_password")}($1,$2,$3,$4,$5)`, ["Reg User", "Reg.User@Example.com", password, token, future()]);
    const newUser = registered.rows[0].user_id;
    expect(registered.rows[0].workspace_id).toBeNull();
    await expect(authRuntime.query(`SELECT * FROM ${fn("auth_register_password")}($1,$2,$3,$4,$5)`, ["Dup", "reg.user@example.com", password, newTokenHash(), future()])).rejects.toMatchObject({ code: "23505" });
    const login = await authRuntime.query(`SELECT * FROM ${fn("auth_password_login")}($1)`, ["  REG.USER@example.com "]);
    expect(login.rows).toEqual([{ user_id: newUser, password_hash: password, status: "active" }]);
    expect((await authRuntime.query(`SELECT * FROM ${fn("auth_password_login")}($1)`, ["nobody@example.com"])).rows).toEqual([]);
    const principal = await authRuntime.query(`SELECT * FROM ${fn("auth_session_principal")}($1)`, [token]);
    expect(principal.rows[0]).toMatchObject({ user_id: newUser, email: "Reg.User@Example.com", platform_roles: [] });
    expect(principal.rows[0].workspaces).toEqual([]);
    expect((await owner.query(`SELECT verified_at FROM ${table("user_emails")} WHERE user_id=$1`, [newUser])).rows).toEqual([{ verified_at: null }]);
    await authRuntime.query(`SELECT ${fn("auth_revoke_session")}($1)`, [token]);
    expect((await authRuntime.query(`SELECT * FROM ${fn("auth_session_principal")}($1)`, [token])).rows).toEqual([]);
    const second = newTokenHash();
    const started = await authRuntime.query(`SELECT * FROM ${fn("auth_start_session")}($1,$2,$3)`, [newUser, second, future()]);
    expect(started.rows).toHaveLength(1);
    expect(started.rows[0]).toMatchObject({ user_id: newUser, email: "Reg.User@Example.com" });
    const noPassword = newTokenHash();
    expect((await authRuntime.query(`SELECT * FROM ${fn("auth_start_session")}($1,$2,$3)`, [userA, noPassword, future()])).rows).toEqual([]);
    expect((await owner.query(`SELECT count(*)::integer AS total FROM ${table("sessions")} WHERE token_hash=$1`, [noPassword])).rows[0].total).toBe(0);
    await expect(authRuntime.query(`SELECT * FROM ${fn("auth_start_session")}($1,$2,$3)`, [newUser, newTokenHash(), new Date(Date.now() - 1000)])).rejects.toMatchObject({ code: "22023" });
    // The general runtime role cannot reach credentials or mint sessions; the login role cannot reach data.
    await expect(runtime.query(`SELECT * FROM ${fn("auth_password_login")}($1)`, ["reg.user@example.com"])).rejects.toMatchObject({ code: "42501" });
    await expect(runtime.query(`SELECT * FROM ${fn("auth_start_session")}($1,$2,$3)`, [newUser, newTokenHash(), future()])).rejects.toMatchObject({ code: "42501" });
    await expect(runtime.query(`SELECT * FROM ${fn("auth_register_password")}($1,$2,$3,$4,$5)`, ["X", "x@example.com", password, newTokenHash(), future()])).rejects.toMatchObject({ code: "42501" });
    expect((await runtime.query(`SELECT * FROM ${fn("auth_session_principal")}($1)`, [second])).rows).toHaveLength(1);
    await expect(authRuntime.query(`SELECT id FROM ${table("users")}`)).rejects.toMatchObject({ code: "42501" });
    await expect(authRuntime.query(`SELECT * FROM ${fn("staff_overview")}()`)).rejects.toMatchObject({ code: "42501" });
  });
  it("binds platform staff access to a live session holding the required role", async () => {
    const moderatorToken = newTokenHash(), memberToken = newTokenHash(), superToken = newTokenHash();
    await owner.query("SET ROLE spark_owner");
    await owner.query(`INSERT INTO ${table("sessions")} (user_id,token_hash,auth_method,expires_at) VALUES ($1,$2,'password',$4),($3,$5,'password',$4)`, [userA, moderatorToken, userB, future(), memberToken]);
    await owner.query(`INSERT INTO ${table("platform_role_assignments")} (user_id,role,granted_by_user_id) VALUES ($1,'content_moderator',$1)`, [userA]);
    const overview = `SELECT * FROM ${fn("staff_overview")}()`;
    expect((await asSession(moderatorToken, overview)).rows).toHaveLength(1);
    expect((await asSession(moderatorToken, `SELECT * FROM ${fn("staff_list_reports")}('open',NULL,NULL,NULL,10)`)).rows).toEqual([]);
    expect((await asSession(moderatorToken, `SELECT id FROM ${table("users")}`)).rows.length).toBeGreaterThanOrEqual(3);
    expect((await asSession(moderatorToken, `SELECT id FROM ${table("user_emails")}`)).rows).toEqual([]);
    await expect(asSession(moderatorToken, `SELECT * FROM ${fn("staff_user_roles")}($1::uuid[])`, [[userA]])).rejects.toMatchObject({ code: "42501" });
    await expect(asSession(moderatorToken, `SELECT ${fn("staff_grant_role")}($1,'super_admin','Needs access')`, [userA])).rejects.toMatchObject({ code: "42501" });
    await expect(asSession(memberToken, overview)).rejects.toMatchObject({ code: "42501" });
    for (const token of [newTokenHash(), null]) {
      await expect(asSession(token, overview)).rejects.toMatchObject({ code: "28000" });
    }
    await expect(asSpoofed(userA, tenantA, overview)).rejects.toMatchObject({ code: "28000" });
    await runtime.query(`SELECT ${fn("auth_revoke_session")}($1)`, [moderatorToken]);
    await expect(asSession(moderatorToken, overview)).rejects.toMatchObject({ code: "28000" });
    await owner.query(`INSERT INTO ${table("sessions")} (user_id,token_hash,auth_method,expires_at) VALUES ($1,$2,'password',$3)`, [visitor, superToken, future()]);
    await owner.query(`INSERT INTO ${table("platform_role_assignments")} (user_id,role,granted_by_user_id) VALUES ($1,'super_admin',$1)`, [visitor]);
    expect((await asSession(superToken, `SELECT ${fn("staff_set_user_status")}($1,'suspended','Self test') AS outcome`, [visitor])).rows[0].outcome).toBe("self");
    expect((await asSession(superToken, `SELECT ${fn("staff_revoke_role")}($1,'super_admin','Step down') AS outcome`, [visitor])).rows[0].outcome).toBe("last_super_admin");
    expect((await asSession(superToken, `SELECT ${fn("staff_grant_role")}($1,'platform_admin','Runs operations') AS outcome`, [userB])).rows[0].outcome).toBe("granted");
    expect((await asSession(superToken, `SELECT ${fn("staff_grant_role")}($1,'platform_admin','Runs operations') AS outcome`, [userB])).rows[0].outcome).toBe("exists");
    expect((await asSession(memberToken, overview)).rows).toHaveLength(1);
    expect((await asSession(memberToken, `SELECT ${fn("staff_set_user_status")}($1,'suspended','Abuse report') AS outcome`, [visitor])).rows[0].outcome).toBe("forbidden");
    expect((await asSession(superToken, `SELECT ${fn("staff_set_user_status")}($1,'suspended','Abuse report') AS outcome`, [userB])).rows[0].outcome).toBe("ok");
    await expect(asSession(memberToken, overview)).rejects.toMatchObject({ code: "28000" });
  });
  it("applies governance writes with version bumps, state guards and audit records", async () => {
    const adminUser = randomUUID(), contentUser = randomUUID(), suspendedUser = randomUUID();
    const adminToken = newTokenHash(), contentToken = newTokenHash(), expiredToken = newTokenHash(), suspendedToken = newTokenHash();
    const comment = randomUUID(), postReport = randomUUID(), commentReport = randomUUID();
    const placement = randomUUID(), approveCampaign = randomUUID(), rejectCampaign = randomUUID();
    await owner.query("SET ROLE spark_owner");
    await owner.query(`INSERT INTO ${table("users")} (id,display_name,status) VALUES ($1,'Gov admin','active'),($2,'Content staff','active'),($3,'Suspended staff','suspended')`, [adminUser, contentUser, suspendedUser]);
    await owner.query(`INSERT INTO ${table("user_emails")} (user_id,email,normalized_email,is_primary) VALUES ($1,'gov@example.com','gov@example.com',true)`, [adminUser]);
    await owner.query(`INSERT INTO ${table("platform_role_assignments")} (user_id,role,granted_by_user_id) VALUES ($1,'platform_admin',$1),($2,'content_moderator',$2),($3,'content_moderator',$3)`, [adminUser, contentUser, suspendedUser]);
    await owner.query(`INSERT INTO ${table("sessions")} (user_id,token_hash,auth_method,expires_at) VALUES ($1,$2,'password',$5),($3,$4,'password',$5),($6,$7,'password',$5)`, [adminUser, adminToken, contentUser, contentToken, future(), suspendedUser, suspendedToken]);
    await owner.query(`INSERT INTO ${table("sessions")} (user_id,token_hash,auth_method,created_at,expires_at) VALUES ($1,$2,'password',now()-interval '2 hours',now()-interval '1 hour')`, [adminUser, expiredToken]);
    await owner.query(`INSERT INTO ${table("post_comments")} (id,tenant_id,community_id,post_id,author_user_id,body) VALUES ($1,$2,$3,$4,$5,'Reported comment')`, [comment, tenantA, communityA, privatePost, userA]);
    await owner.query(`INSERT INTO ${table("content_reports")} (id,tenant_id,community_id,reporter_user_id,post_id,comment_id,reason_code) VALUES ($1,$3,$4,$5,$6,NULL,'spam'),($2,$3,$4,$5,NULL,$7,'abuse')`, [postReport, commentReport, tenantA, communityA, visitor, privatePost, comment]);
    await owner.query(`INSERT INTO ${table("promotion_placements")} (id,code,name,description) VALUES ($1,$2,'Placement','Test placement')`, [placement, `placement-${placement}`]);
    await owner.query(`INSERT INTO ${table("promotion_campaigns")} (id,tenant_id,community_id,name,headline,description,placement_id,submitted_by_user_id,review_status,requested_start_at) VALUES ($1,$3,$4,'Approve me','Headline','Body',$5,$6,'pending',$7),($2,$3,$4,'Reject me','Headline','Body',$5,$6,'pending',$7)`, [approveCampaign, rejectCampaign, tenantA, communityA, placement, userA, future()]);

    for (const token of [expiredToken, suspendedToken]) {
      await expect(asSession(token, `SELECT * FROM ${fn("staff_overview")}()`)).rejects.toMatchObject({ code: "28000" });
    }
    expect((await asSession(contentToken, `SELECT user_id FROM ${table("user_emails")}`)).rows).toEqual([]);
    expect((await asSession(adminToken, `SELECT user_id FROM ${table("user_emails")} WHERE user_id=$1`, [adminUser])).rows).toEqual([{ user_id: adminUser }]);
    expect((await asSession(adminToken, `SELECT role FROM ${fn("staff_user_roles")}($1::uuid[])`, [[adminUser]])).rows).toEqual([{ role: "platform_admin" }]);
    expect(Number((await asSession(adminToken, `SELECT ${fn("staff_active_session_count")}() AS total`)).rows[0].total)).toBeGreaterThanOrEqual(3);
    const counts = await asSession(contentToken, `SELECT * FROM ${fn("staff_open_report_counts")}($1::uuid[])`, [[communityA]]);
    expect(counts.rows).toEqual([{ community_id: communityA, open_reports: "2" }]);

    const resolve = `SELECT ${fn("staff_resolve_report")}($1,$2,'Policy violation') AS outcome`;
    expect((await asSession(contentToken, resolve, [postReport, "hide"])).rows[0].outcome).toBe("ok");
    expect((await asSession(contentToken, resolve, [postReport, "restore"])).rows[0].outcome).toBe("already_closed");
    expect((await asSession(contentToken, resolve, [commentReport, "hide"])).rows[0].outcome).toBe("ok");
    expect((await asSession(contentToken, resolve, [randomUUID(), "hide"])).rows[0].outcome).toBe("not_found");
    expect((await owner.query(`SELECT moderation_status,version FROM ${table("posts")} WHERE id=$1`, [privatePost])).rows[0]).toEqual({ moderation_status: "hidden", version: 2 });
    expect((await owner.query(`SELECT moderation_status,version FROM ${table("post_comments")} WHERE id=$1`, [comment])).rows[0]).toEqual({ moderation_status: "hidden", version: 2 });
    expect((await owner.query(`SELECT status FROM ${table("content_reports")} WHERE id = ANY($1::uuid[]) ORDER BY status`, [[postReport, commentReport]])).rows).toEqual([{ status: "resolved" }, { status: "resolved" }]);
    expect((await owner.query(`SELECT count(*)::integer AS total FROM ${table("moderation_actions")} WHERE actor_user_id=$1`, [contentUser])).rows[0].total).toBe(2);
    await owner.query(`UPDATE ${table("posts")} SET moderation_status='visible',version=version+1 WHERE id=$1`, [privatePost]);

    const review = `SELECT ${fn("staff_review_campaign")}($1,$2,'Meets placement policy') AS outcome`;
    await expect(asSession(contentToken, review, [approveCampaign, "approve"])).rejects.toMatchObject({ code: "42501" });
    expect((await asSession(adminToken, review, [approveCampaign, "approve"])).rows[0].outcome).toBe("ok");
    expect((await asSession(adminToken, review, [approveCampaign, "reject"])).rows[0].outcome).toBe("not_pending");
    expect((await asSession(adminToken, review, [rejectCampaign, "reject"])).rows[0].outcome).toBe("ok");
    const campaigns = await owner.query(`SELECT id,review_status,version,approved_version FROM ${table("promotion_campaigns")} WHERE id = ANY($1::uuid[])`, [[approveCampaign, rejectCampaign]]);
    expect(campaigns.rows).toEqual(expect.arrayContaining([
      { id: approveCampaign, review_status: "approved", version: 2, approved_version: 2 },
      { id: rejectCampaign, review_status: "rejected", version: 2, approved_version: null },
    ]));
    expect((await owner.query(`SELECT campaign_version,decision,reviewer_user_id FROM ${table("promotion_reviews")} WHERE campaign_id=$1`, [approveCampaign])).rows).toEqual([{ campaign_version: 2, decision: "approve", reviewer_user_id: adminUser }]);

    const moderate = `SELECT ${fn("staff_moderate_community")}($1,$2,'Community guidelines') AS outcome`;
    expect((await asSession(adminToken, moderate, [publicCommunity, "archive"])).rows[0].outcome).toBe("ok");
    expect((await owner.query(`SELECT archived_at IS NOT NULL AS archived FROM ${table("communities")} WHERE id=$1`, [publicCommunity])).rows[0].archived).toBe(true);
    expect((await asSession(adminToken, moderate, [publicCommunity, "restore"])).rows[0].outcome).toBe("ok");
    expect((await asSession(adminToken, moderate, [randomUUID(), "archive"])).rows[0].outcome).toBe("not_found");
    await expect(asSession(contentToken, moderate, [publicCommunity, "archive"])).rejects.toMatchObject({ code: "42501" });
    await expect(owner.query(`INSERT INTO ${table("moderation_actions")} (tenant_id,community_id,actor_user_id,action,reason) VALUES ($1,$2,$3,'hide','Not a moderator')`, [tenantA, communityA, visitor])).rejects.toMatchObject({ code: "23514" });
  });
  it("keeps the runtime role read-only and every definer function pinned", async () => {
    for (const name of ["users","user_emails","posts","post_comments","communities","platform_role_assignments","sessions","content_reports","moderation_actions","promotion_campaigns","promotion_reviews","password_credentials","workspaces","workspace_memberships","workspace_invitations","notifications","outbox_events","audit_events","projects","issues","sprints","project_phases","project_milestones","sprint_commitments","project_methodology_periods"]) {
      for (const privilege of ["INSERT","UPDATE","DELETE"]) {
        const result = await owner.query("SELECT has_table_privilege('spark_app',$1,$2) AS allowed", [`"${namespace}"."${name}"`, privilege]);
        expect({ name, privilege, allowed: result.rows[0].allowed }).toEqual({ name, privilege, allowed: false });
      }
    }
    const authTables = await owner.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind='r' AND (has_table_privilege('spark_auth',c.oid,'SELECT') OR has_table_privilege('spark_auth',c.oid,'INSERT')
        OR has_table_privilege('spark_auth',c.oid,'UPDATE') OR has_table_privilege('spark_auth',c.oid,'DELETE'))`, [namespace]);
    expect(authTables.rows).toEqual([]);
    const authFunctions = await owner.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=$1 AND has_function_privilege('spark_auth',p.oid,'EXECUTE') ORDER BY p.proname`, [namespace]);
    expect(authFunctions.rows.map((row) => row.proname)).toEqual(["auth_password_login","auth_register_password","auth_revoke_session","auth_session_principal","auth_start_session"]);
    const publicExecute = await owner.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      WHERE n.nspname=$1 AND acl.grantee=0 AND acl.privilege_type='EXECUTE'`, [namespace]);
    expect(publicExecute.rows).toEqual([]);
    const authRole = await owner.query(`SELECT rolsuper,rolbypassrls,rolinherit,rolcanlogin,rolcreaterole,rolcreatedb,
      (SELECT count(*)::integer FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS memberships,
      has_database_privilege('spark_auth',current_database(),'TEMPORARY') AS temp, has_schema_privilege('spark_auth',$1,'CREATE') AS create_in_schema
      FROM pg_roles r WHERE rolname='spark_auth'`, [namespace]);
    expect(authRole.rows).toEqual([{ rolsuper: false, rolbypassrls: false, rolinherit: false, rolcanlogin: true, rolcreaterole: false, rolcreatedb: false, memberships: 0, temp: false, create_in_schema: false }]);
    for (const signature of ["session_actor()", "require_platform_role(text[])"]) {
      const result = await owner.query("SELECT has_function_privilege('spark_app',$1,'EXECUTE') AS allowed", [`"${namespace}".${signature}`]);
      expect({ signature, allowed: result.rows[0].allowed }).toEqual({ signature, allowed: false });
    }
    const definers = await owner.query(`SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.prosecdef`, [namespace]);
    expect(definers.rows.length).toBeGreaterThan(20);
    for (const row of definers.rows) expect({ name: row.proname, config: row.proconfig }).toEqual({ name: row.proname, config: ['search_path=""'] });
  });
  it("serializes super-admin suspension with role revocation", async () => {
    const superA = randomUUID(), superB = randomUUID(), tokenA = newTokenHash(), tokenB = newTokenHash();
    await owner.query("SET ROLE spark_owner");
    await owner.query(`UPDATE ${table("platform_role_assignments")} SET revoked_at=now() WHERE role='super_admin' AND revoked_at IS NULL`);
    await owner.query(`INSERT INTO ${table("users")} (id,display_name) VALUES ($1,'Super A'),($2,'Super B')`, [superA, superB]);
    await owner.query(`INSERT INTO ${table("platform_role_assignments")} (user_id,role,granted_by_user_id) VALUES ($1,'super_admin',$1),($2,'super_admin',$2)`, [superA, superB]);
    await owner.query(`INSERT INTO ${table("sessions")} (user_id,token_hash,auth_method,expires_at) VALUES ($1,$2,'password',$5),($3,$4,'password',$5)`, [superA, tokenA, superB, tokenB, future()]);
    const first = new pg.Client({ connectionString: localConnection("DATABASE_URL"), connectionTimeoutMillis: 5000 });
    const second = new pg.Client({ connectionString: localConnection("DATABASE_URL"), connectionTimeoutMillis: 5000 });
    await Promise.all([first.connect(), second.connect()]);
    // Generous lock timeout so a slow host cannot turn the expected wait into a 55P03 failure.
    await second.query("SET lock_timeout = '15s'");
    try {
      // A revokes B's super_admin role and holds its locks while B tries to suspend A.
      await first.query("BEGIN");
      await first.query("SELECT set_config('spark.session_token_hash',$1,true)", [tokenA.toString("hex")]);
      expect((await first.query(`SELECT ${fn("staff_revoke_role")}($1,'super_admin','Rotation') AS outcome`, [superB])).rows[0].outcome).toBe("revoked");
      await second.query("BEGIN");
      await second.query("SELECT set_config('spark.session_token_hash',$1,true)", [tokenB.toString("hex")]);
      const secondPid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const suspension = second.query(`SELECT ${fn("staff_set_user_status")}($1,'suspended','Rotation') AS outcome`, [superA]);
      // Commit only once the suspension is provably blocked on the super-admin row locks.
      for (let attempt = 0; ; attempt++) {
        // pg_locks is readable by any role, unlike other sessions' wait state in pg_stat_activity.
        const waiting = await owner.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted", [secondPid]);
        if (waiting.rowCount) break;
        if (attempt > 200) throw new Error("Suspension never waited on the lock");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await first.query("COMMIT");
      // B first locks A's user row (0010). A's audit insert already key-share locked that row, so B
      // waits until A commits, and its admin-tier check then sees that B is no longer a super admin.
      expect((await suspension).rows[0].outcome).toBe("forbidden");
      await second.query("COMMIT");
    } finally {
      await Promise.allSettled([first.query("ROLLBACK"), second.query("ROLLBACK")]);
      await Promise.allSettled([first.end(), second.end()]);
    }
    const remaining = await owner.query(`SELECT u.id FROM ${table("platform_role_assignments")} r JOIN ${table("users")} u ON u.id=r.user_id WHERE r.role='super_admin' AND r.revoked_at IS NULL AND u.status='active'`);
    expect(remaining.rows).toEqual([{ id: superA }]);
  });
  it("records every governance action in an append-only audit log in the same transaction", async () => {
    const superUser = randomUUID(), adminUser = randomUUID(), communityStaff = randomUUID(), contentStaff = randomUUID(), member = randomUUID();
    const superToken = newTokenHash(), adminToken = newTokenHash(), communityToken = newTokenHash(), contentToken = newTokenHash();
    const community = randomUUID(), report = randomUUID(), placement = randomUUID(), campaign = randomUUID(), reportedPost = randomUUID();
    await owner.query("SET ROLE spark_owner");
    await owner.query(`INSERT INTO ${table("users")} (id,display_name) VALUES ($1,'Audit super'),($2,'Audit admin'),($3,'Community staff'),($4,'Content staff'),($5,'Audit member')`, [superUser, adminUser, communityStaff, contentStaff, member]);
    await owner.query(`INSERT INTO ${table("platform_role_assignments")} (user_id,role,granted_by_user_id) VALUES ($1,'super_admin',$1),($2,'platform_admin',$1),($3,'community_moderator',$1),($4,'content_moderator',$1)`, [superUser, adminUser, communityStaff, contentStaff]);
    await owner.query(`INSERT INTO ${table("sessions")} (user_id,token_hash,auth_method,expires_at) VALUES ($1,$2,'password',$9),($3,$4,'password',$9),($5,$6,'password',$9),($7,$8,'password',$9)`, [superUser, superToken, adminUser, adminToken, communityStaff, communityToken, contentStaff, contentToken, future()]);
    await owner.query("BEGIN");
    await owner.query(`INSERT INTO ${table("communities")} (id,tenant_id,slug,name,tagline,description,visibility,created_by_user_id) VALUES ($1::uuid,$2,$1::text,'Audit Circle','Tagline','Description','public',$3)`, [community, tenantA, userA]);
    await owner.query(`INSERT INTO ${table("community_memberships")} (tenant_id,community_id,user_id,role) VALUES ($1,$2,$3,'owner')`, [tenantA, community, userA]);
    await owner.query("COMMIT");
    await owner.query(`INSERT INTO ${table("posts")} (id,tenant_id,community_id,author_user_id,title,body) VALUES ($1,$2,$3,$4,'Reported','Body')`, [reportedPost, tenantA, community, userA]);
    await owner.query(`INSERT INTO ${table("content_reports")} (id,tenant_id,community_id,reporter_user_id,post_id,reason_code) VALUES ($1,$2,$3,$4,$5,'spam')`, [report, tenantA, community, visitor, reportedPost]);
    await owner.query(`INSERT INTO ${table("promotion_placements")} (id,code,name,description) VALUES ($1,$2,'Placement','Audit placement')`, [placement, `placement-${placement}`]);
    await owner.query(`INSERT INTO ${table("promotion_campaigns")} (id,tenant_id,community_id,name,headline,description,placement_id,submitted_by_user_id,review_status,requested_start_at) VALUES ($1,$2,$3,'Audit campaign','Headline','Body',$4,$5,'pending',$6)`, [campaign, tenantA, community, placement, userA, future()]);
    const audit = async (target: string) => (await owner.query(`SELECT action,actor_user_id,target_type,target_label,reason,metadata FROM ${table("platform_audit_events")} WHERE target_id=$1 ORDER BY created_at,id`, [target])).rows;
    const state = async () => (await owner.query(`SELECT featured_at IS NOT NULL AS featured, frozen_at IS NOT NULL AS frozen, archived_at IS NOT NULL AS archived FROM ${table("communities")} WHERE id=$1`, [community])).rows[0];
    const moderate = (action: string, reason = "  Community guidelines  ") =>
      asSession(communityToken, `SELECT ${fn("staff_moderate_community")}($1,$2,$3) AS outcome`, [community, action, reason]).then((r) => r.rows[0].outcome);

    // Transition matrix starting from an active community.
    for (const invalid of ["unfeature", "unfreeze", "restore"]) expect(await moderate(invalid)).toBe("invalid_transition");
    expect(await audit(community)).toEqual([]);
    expect(await moderate("feature")).toBe("ok");
    expect(await state()).toEqual({ featured: true, frozen: false, archived: false });
    expect(await moderate("feature")).toBe("invalid_transition");
    expect(await moderate("freeze")).toBe("ok");
    expect(await state()).toEqual({ featured: false, frozen: true, archived: false });
    expect(await moderate("feature")).toBe("invalid_transition");
    // Frozen communities reject new posts, whoever inserts them.
    await reject(`INSERT INTO ${table("posts")} (tenant_id,community_id,author_user_id,title,body) VALUES ($1,$2,$3,'Blocked','Body')`, [tenantA, community, userA], "23514");
    expect(await moderate("unfreeze")).toBe("ok");
    expect(await moderate("archive")).toBe("ok");
    expect(await state()).toEqual({ featured: false, frozen: false, archived: true });
    for (const invalid of ["feature", "freeze", "archive", "unfreeze"]) expect(await moderate(invalid)).toBe("invalid_transition");
    await reject(`INSERT INTO ${table("posts")} (tenant_id,community_id,author_user_id,title,body) VALUES ($1,$2,$3,'Blocked','Body')`, [tenantA, community, userA], "23514");
    expect(await moderate("restore")).toBe("ok");
    const post = randomUUID();
    await owner.query(`INSERT INTO ${table("posts")} (id,tenant_id,community_id,author_user_id,title,body) VALUES ($1,$2,$3,$4,'Open again','Body')`, [post, tenantA, community, userA]);
    await expect(moderate("freeze")).resolves.toBe("ok");
    await reject(`INSERT INTO ${table("post_comments")} (tenant_id,community_id,post_id,author_user_id,body) VALUES ($1,$2,$3,$4,'Blocked')`, [tenantA, community, post, userA], "23514");
    expect(await moderate("unfreeze")).toBe("ok");
    const communityAudit = await audit(community);
    expect(communityAudit.map((row) => row.action)).toEqual([
      "community.feature", "community.freeze", "community.unfreeze", "community.archive", "community.restore", "community.freeze", "community.unfreeze",
    ]);
    expect(communityAudit[0]).toEqual({ action: "community.feature", actor_user_id: communityStaff, target_type: "community", target_label: "Audit Circle", reason: "Community guidelines", metadata: { previousState: "active" } });
    expect(communityAudit[1].metadata).toEqual({ previousState: "featured" });

    // A reason is mandatory, and a rolled-back action leaves neither the change nor its audit row.
    for (const reason of ["ab", "   ", null]) {
      await expect(asSession(communityToken, `SELECT ${fn("staff_moderate_community")}($1,'feature',$2)`, [community, reason])).rejects.toMatchObject({ code: "22023" });
    }
    const client = await runtime.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('spark.session_token_hash',$1,true)", [communityToken.toString("hex")]);
      expect((await client.query(`SELECT ${fn("staff_moderate_community")}($1,'feature','Rolled back') AS outcome`, [community])).rows[0].outcome).toBe("ok");
      await client.query("ROLLBACK");
    } finally { client.release(); }
    expect((await audit(community)).length).toBe(7);
    expect(await state()).toEqual({ featured: false, frozen: false, archived: false });

    // Users, roles, reports and campaigns.
    const status = (token: Buffer, target: string, value: string) =>
      asSession(token, `SELECT ${fn("staff_set_user_status")}($1,$2,'Repeated spam') AS outcome`, [target, value]).then((r) => r.rows[0].outcome);
    expect(await status(adminToken, member, "suspended")).toBe("ok");
    expect(await status(adminToken, member, "suspended")).toBe("unchanged");
    expect(await status(adminToken, member, "active")).toBe("ok");
    await expect(asSession(communityToken, `SELECT ${fn("staff_set_user_status")}($1,'suspended','Repeated spam')`, [member])).rejects.toMatchObject({ code: "42501" });
    const grant = `SELECT ${fn("staff_grant_role")}($1,'campaign_moderator','Reviews promotions') AS outcome`;
    const revoke = `SELECT ${fn("staff_revoke_role")}($1,'campaign_moderator','Rotation ended') AS outcome`;
    await expect(asSession(adminToken, grant, [member])).rejects.toMatchObject({ code: "42501" });
    expect((await asSession(superToken, grant, [member])).rows[0].outcome).toBe("granted");
    expect((await asSession(superToken, grant, [member])).rows[0].outcome).toBe("exists");
    expect((await asSession(superToken, revoke, [member])).rows[0].outcome).toBe("revoked");
    expect((await asSession(superToken, revoke, [member])).rows[0].outcome).toBe("not_found");
    const memberAudit = await audit(member);
    expect(memberAudit.map((row) => [row.action, row.metadata])).toEqual([
      ["user.suspend", { previousStatus: "active" }], ["user.reactivate", { previousStatus: "suspended" }],
      ["role.grant", { role: "campaign_moderator" }], ["role.revoke", { role: "campaign_moderator" }],
    ]);
    expect(memberAudit.every((row) => row.target_type === "user" && row.target_label === "Audit member")).toBe(true);
    expect((await asSession(contentToken, `SELECT ${fn("staff_resolve_report")}($1,'dismiss_report','Not a violation') AS outcome`, [report])).rows[0].outcome).toBe("ok");
    expect(await audit(report)).toEqual([{ action: "report.dismiss", actor_user_id: contentStaff, target_type: "report", target_label: "Report in Audit Circle", reason: "Not a violation", metadata: { reasonCode: "spam", targetKind: "post" } }]);
    expect((await asSession(adminToken, `SELECT ${fn("staff_review_campaign")}($1,'approve','Meets policy') AS outcome`, [campaign])).rows[0].outcome).toBe("ok");
    expect((await audit(campaign)).map((row) => [row.action, row.target_label, row.metadata])).toEqual([["campaign.approve", "Audit campaign", { version: 2 }]]);

    // Append-only, never writable by the runtime role, and readable only by platform admins.
    await reject(`UPDATE ${table("platform_audit_events")} SET reason='Edited' WHERE target_id=$1`, [member], "23514");
    await reject(`DELETE FROM ${table("platform_audit_events")} WHERE target_id=$1`, [member], "23514");
    await expect(runtime.query(`INSERT INTO ${table("platform_audit_events")} (actor_user_id,action,target_type,target_id,target_label,reason) VALUES ($1,'user.suspend','user',$1,'Forged','Forged entry')`, [member])).rejects.toMatchObject({ code: "42501" });
    await expect(runtime.query(`SELECT ${fn("record_platform_audit")}($1,'user.suspend','user',$1,'Forged','Forged entry','{}')`, [member])).rejects.toMatchObject({ code: "42501" });
    const readAudit = `SELECT count(*)::integer AS total FROM ${table("platform_audit_events")} WHERE target_id=$1`;
    expect((await asSession(adminToken, readAudit, [member])).rows[0].total).toBe(4);
    expect((await asSession(superToken, readAudit, [member])).rows[0].total).toBe(4);
    for (const token of [communityToken, contentToken, null]) expect((await asSession(token, readAudit, [member])).rows[0].total).toBe(0);
    const overview = (await asSession(contentToken, `SELECT * FROM ${fn("staff_overview")}()`)).rows[0];
    expect(Number(overview.audit_events)).toBeGreaterThanOrEqual(13);
    expect((await asSession(adminToken, `SELECT ${fn("staff_user_session_count")}($1) AS total`, [adminUser])).rows[0].total).toBe("1");
    await expect(asSession(contentToken, `SELECT ${fn("staff_user_session_count")}($1)`, [adminUser])).rejects.toMatchObject({ code: "42501" });
    const holders = await asSession(adminToken, `SELECT user_id FROM ${fn("staff_user_roles")}(NULL) WHERE role='community_moderator'`);
    expect(holders.rows.map((row) => row.user_id)).toContain(communityStaff);
  });
  it("pages the report queue by keyset without gaps or duplicates", async () => {
    const staff = randomUUID(), token = newTokenHash(), community = randomUUID(), queuePost = randomUUID();
    await owner.query("SET ROLE spark_owner");
    await owner.query(`INSERT INTO ${table("users")} (id,display_name) VALUES ($1,'Queue staff')`, [staff]);
    await owner.query(`INSERT INTO ${table("platform_role_assignments")} (user_id,role,granted_by_user_id) VALUES ($1,'content_moderator',$1)`, [staff]);
    await owner.query(`INSERT INTO ${table("sessions")} (user_id,token_hash,auth_method,expires_at) VALUES ($1,$2,'password',$3)`, [staff, token, future()]);
    await owner.query("BEGIN");
    await owner.query(`INSERT INTO ${table("communities")} (id,tenant_id,slug,name,tagline,description,visibility,created_by_user_id) VALUES ($1::uuid,$2,$1::text,'Queue Circle','Tagline','Description','public',$3)`, [community, tenantA, userA]);
    await owner.query(`INSERT INTO ${table("community_memberships")} (tenant_id,community_id,user_id,role) VALUES ($1,$2,$3,'owner')`, [tenantA, community, userA]);
    await owner.query("COMMIT");
    await owner.query(`INSERT INTO ${table("posts")} (id,tenant_id,community_id,author_user_id,title,body) VALUES ($1,$2,$3,$4,'Queued','Body')`, [queuePost, tenantA, community, userA]);
    const reporters = [userB, visitor, staff, randomUUID(), randomUUID()];
    for (const reporter of reporters.slice(3)) await owner.query(`INSERT INTO ${table("users")} (id,display_name) VALUES ($1,'Reporter')`, [reporter]);
    // Two reports share a timestamp, so the id tie-breaker is exercised.
    const stamp = new Date(Date.now() - 60_000);
    for (const [index, reporter] of reporters.entries()) {
      await owner.query(`INSERT INTO ${table("content_reports")} (tenant_id,community_id,reporter_user_id,post_id,reason_code,status,created_at) VALUES ($1,$2,$3,$5,'spam','reviewing',$4)`,
        [tenantA, community, reporter, index < 2 ? stamp : new Date(stamp.getTime() + index * 1000), queuePost]);
    }
    const seen: string[] = [];
    let cursor: { created_at: Date; id: string } | null = null;
    for (let page = 0; page < 10; page++) {
      const rows: Array<{ created_at: Date; id: string }> = (await asSession(token, `SELECT id,created_at FROM ${fn("staff_list_reports")}('reviewing',NULL,$1,$2,2)`, [cursor?.created_at ?? null, cursor?.id ?? null])).rows;
      seen.push(...rows.map((row) => row.id));
      if (rows.length < 2) break;
      cursor = rows[rows.length - 1]!;
    }
    const expected = (await owner.query(`SELECT id FROM ${table("content_reports")} WHERE status='reviewing' ORDER BY created_at DESC, id DESC`)).rows.map((row) => row.id);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
    const single = await asSession(token, `SELECT id,status FROM ${fn("staff_list_reports")}(NULL,$1,NULL,NULL,1)`, [expected[0]]);
    expect(single.rows).toEqual([{ id: expected[0], status: "reviewing" }]);
    await expect(asSession(token, `SELECT * FROM ${fn("staff_list_reports")}('reviewing',NULL,now(),NULL,2)`)).rejects.toMatchObject({ code: "22023" });
    await expect(asSession(token, `SELECT * FROM ${fn("staff_list_reports")}('closed',NULL,NULL,NULL,2)`)).rejects.toMatchObject({ code: "22023" });
  });
  it("exposes exactly the intended functions to the runtime role", async () => {
    const runtimeFunctions = await owner.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=$1 AND has_function_privilege('spark_app',p.oid,'EXECUTE') ORDER BY p.proname`, [namespace]);
    expect(runtimeFunctions.rows.map((row) => row.proname)).toEqual([
      "auth_revoke_session", "auth_session_principal", "can_manage_community", "can_moderate_community", "can_read_community", "can_read_post", "community_by_slug", "community_comment",
      "community_feed", "community_filter_values", "community_post", "community_post_comments", "discover_communities",
      "has_platform_role", "insight_flow", "insight_issue_states", "insight_members", "insight_sprint_burndown", "insight_sprint_outcomes", "is_community_member", "is_coworker",
      "is_session_user", "is_workspace_member", "my_communities", "session_workspace_ids", "staff_active_session_count", "staff_active_user_totals", "staff_activity_series", "staff_billing_counts",
      "staff_billing_mrr_series", "staff_billing_plan_mix", "staff_billing_revenue", "staff_community_daily", "staff_community_health", "staff_community_health_counts", "staff_community_series", "staff_engagement_heatmap",
      "staff_grant_role", "staff_list_invoices", "staff_list_reports", "staff_list_subscriptions", "staff_moderate_community", "staff_open_report_counts", "staff_overview", "staff_report_context",
      "staff_report_daily", "staff_report_preview", "staff_report_reasons", "staff_report_stats", "staff_report_top_communities", "staff_resolve_report", "staff_retention_cohorts", "staff_review_campaign",
      "staff_revoke_role", "staff_set_user_status", "staff_top_communities", "staff_user_activity", "staff_user_risk", "staff_user_roles", "staff_user_session_count", "staff_user_sessions",
      "ws_accept_invitation", "ws_add_community_member", "ws_cancel_event", "ws_complete_sprint", "ws_create_comment", "ws_create_community", "ws_create_event", "ws_create_invitation", "ws_create_issue",
      "ws_create_milestone", "ws_create_post", "ws_create_project", "ws_create_sprint", "ws_create_workspace", "ws_decide_community_request", "ws_delete_comment", "ws_delete_post", "ws_get_notification_preferences", "ws_invitation_preview", "ws_join_community",
      "ws_leave_community", "ws_list_community_member_candidates", "ws_list_community_members", "ws_list_community_requests", "ws_list_members", "ws_list_my_community_requests", "ws_list_notifications", "ws_list_workspace_communities",
      "ws_mark_notification_read", "ws_mark_notifications_read", "ws_rebaseline_project", "ws_remove_community_member", "ws_remove_member", "ws_request_community_membership", "ws_resend_invitation", "ws_respond_event",
      "ws_revoke_invitation", "ws_save_phases", "ws_set_community_role", "ws_set_member_role", "ws_set_notification_preferences", "ws_start_sprint", "ws_switch_methodology", "ws_unread_notification_count",
      "ws_update_comment", "ws_update_community", "ws_update_event", "ws_update_issue", "ws_update_milestone", "ws_update_post", "ws_update_project", "ws_update_sprint", "ws_update_status", "ws_update_workspace",
      "ws_withdraw_community_request",
    ]);
  });
  it("protects admin-tier accounts, drops revoked roles at once and guards promotions of closed communities", async () => {
    const adminA = randomUUID(), adminB = randomUUID(), superUser = randomUUID(), moderator = randomUUID();
    const tokenA = newTokenHash(), superToken = newTokenHash(), moderatorToken = newTokenHash();
    const community = randomUUID(), placement = randomUUID(), approveMe = randomUUID(), rejectMe = randomUUID();
    await owner.query("SET ROLE spark_owner");
    await owner.query(`INSERT INTO ${table("users")} (id,display_name) VALUES ($1,'Admin A'),($2,'Admin B'),($3,'Super'),($4,'Moderator')`, [adminA, adminB, superUser, moderator]);
    await owner.query(`INSERT INTO ${table("platform_role_assignments")} (user_id,role,granted_by_user_id) VALUES ($1,'platform_admin',$3),($2,'platform_admin',$3),($3,'super_admin',$3),($4,'community_moderator',$3)`, [adminA, adminB, superUser, moderator]);
    await owner.query(`INSERT INTO ${table("sessions")} (user_id,token_hash,auth_method,expires_at) VALUES ($1,$2,'password',$7),($3,$4,'password',$7),($5,$6,'password',$7)`, [adminA, tokenA, superUser, superToken, moderator, moderatorToken, future()]);
    const status = (token: Buffer, target: string) => asSession(token, `SELECT ${fn("staff_set_user_status")}($1,'suspended','Tier check') AS outcome`, [target]).then((r) => r.rows[0].outcome);

    // A platform admin cannot change another admin-tier account; a super admin can.
    expect(await status(tokenA, adminB)).toBe("forbidden");
    expect(await status(tokenA, superUser)).toBe("forbidden");
    expect((await owner.query(`SELECT status FROM ${table("users")} WHERE id=$1`, [adminB])).rows[0].status).toBe("active");
    expect(await status(superToken, adminB)).toBe("ok");
    expect(await status(superToken, randomUUID())).toBe("not_found");

    // A revoked role stops working on the very next call of an already-open session.
    const overview = `SELECT * FROM ${fn("staff_moderate_community")}($1,'feature','Revocation check')`;
    await expect(asSession(moderatorToken, overview, [randomUUID()])).resolves.toBeDefined();
    expect((await asSession(superToken, `SELECT ${fn("staff_revoke_role")}($1,'community_moderator','Left the team') AS outcome`, [moderator])).rows[0].outcome).toBe("revoked");
    await expect(asSession(moderatorToken, overview, [randomUUID()])).rejects.toMatchObject({ code: "42501" });

    // Frozen or archived communities cannot be promoted, but pending campaigns can still be rejected.
    await owner.query("BEGIN");
    await owner.query(`INSERT INTO ${table("communities")} (id,tenant_id,slug,name,tagline,description,visibility,created_by_user_id,frozen_at) VALUES ($1::uuid,$2,$1::text,'Frozen Circle','Tagline','Description','public',$3,now())`, [community, tenantA, userA]);
    await owner.query(`INSERT INTO ${table("community_memberships")} (tenant_id,community_id,user_id,role) VALUES ($1,$2,$3,'owner')`, [tenantA, community, userA]);
    await owner.query("COMMIT");
    await owner.query(`INSERT INTO ${table("promotion_placements")} (id,code,name,description) VALUES ($1,$2,'Placement','Guard placement')`, [placement, `placement-${placement}`]);
    await owner.query(`INSERT INTO ${table("promotion_campaigns")} (id,tenant_id,community_id,name,headline,description,placement_id,submitted_by_user_id,review_status,requested_start_at) VALUES ($1,$3,$4,'Blocked','Headline','Body',$5,$6,'pending',$7),($2,$3,$4,'Rejectable','Headline','Body',$5,$6,'pending',$7)`, [approveMe, rejectMe, tenantA, community, placement, userA, future()]);
    const review = (campaign: string, decision: string) => asSession(superToken, `SELECT ${fn("staff_review_campaign")}($1,$2,'Placement policy') AS outcome`, [campaign, decision]).then((r) => r.rows[0].outcome);
    expect(await review(approveMe, "approve")).toBe("community_unavailable");
    expect((await owner.query(`SELECT review_status FROM ${table("promotion_campaigns")} WHERE id=$1`, [approveMe])).rows[0].review_status).toBe("pending");
    expect((await owner.query(`SELECT count(*)::integer AS total FROM ${table("platform_audit_events")} WHERE target_id=$1`, [approveMe])).rows[0].total).toBe(0);
    expect(await review(rejectMe, "reject")).toBe("ok");

    // The audit log cannot be truncated either.
    await reject(`TRUNCATE ${table("platform_audit_events")}`, [], "23514");
  });
  it("serializes campaign approval with a concurrent community freeze", async () => {
    const staff = randomUUID(), token = newTokenHash(), community = randomUUID(), placement = randomUUID(), campaign = randomUUID();
    await owner.query("SET ROLE spark_owner");
    await owner.query(`INSERT INTO ${table("users")} (id,display_name) VALUES ($1,'Race staff')`, [staff]);
    await owner.query(`INSERT INTO ${table("platform_role_assignments")} (user_id,role,granted_by_user_id) VALUES ($1,'platform_admin',$1)`, [staff]);
    await owner.query(`INSERT INTO ${table("sessions")} (user_id,token_hash,auth_method,expires_at) VALUES ($1,$2,'password',$3)`, [staff, token, future()]);
    await owner.query("BEGIN");
    await owner.query(`INSERT INTO ${table("communities")} (id,tenant_id,slug,name,tagline,description,visibility,created_by_user_id) VALUES ($1::uuid,$2,$1::text,'Race Circle','Tagline','Description','public',$3)`, [community, tenantA, userA]);
    await owner.query(`INSERT INTO ${table("community_memberships")} (tenant_id,community_id,user_id,role) VALUES ($1,$2,$3,'owner')`, [tenantA, community, userA]);
    await owner.query("COMMIT");
    await owner.query(`INSERT INTO ${table("promotion_placements")} (id,code,name,description) VALUES ($1,$2,'Placement','Race placement')`, [placement, `placement-${placement}`]);
    await owner.query(`INSERT INTO ${table("promotion_campaigns")} (id,tenant_id,community_id,name,headline,description,placement_id,submitted_by_user_id,review_status,requested_start_at) VALUES ($1,$2,$3,'Race campaign','Headline','Body',$4,$5,'pending',$6)`, [campaign, tenantA, community, placement, userA, future()]);
    const first = new pg.Client({ connectionString: localConnection("DATABASE_URL"), connectionTimeoutMillis: 5000 });
    const second = new pg.Client({ connectionString: localConnection("DATABASE_URL"), connectionTimeoutMillis: 5000 });
    await Promise.all([first.connect(), second.connect()]);
    await second.query("SET lock_timeout = '15s'");
    try {
      // The freeze holds the community row while the approval tries to read it.
      await first.query("BEGIN");
      await first.query("SELECT set_config('spark.session_token_hash',$1,true)", [token.toString("hex")]);
      expect((await first.query(`SELECT ${fn("staff_moderate_community")}($1,'freeze','Race check') AS outcome`, [community])).rows[0].outcome).toBe("ok");
      await second.query("BEGIN");
      await second.query("SELECT set_config('spark.session_token_hash',$1,true)", [token.toString("hex")]);
      const secondPid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const approval = second.query(`SELECT ${fn("staff_review_campaign")}($1,'approve','Race check') AS outcome`, [campaign]);
      for (let attempt = 0; ; attempt++) {
        if ((await owner.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted", [secondPid])).rowCount) break;
        if (attempt > 200) throw new Error("Approval never waited on the community lock");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await first.query("COMMIT");
      expect((await approval).rows[0].outcome).toBe("community_unavailable");
      await second.query("COMMIT");
    } finally {
      await Promise.allSettled([first.query("ROLLBACK"), second.query("ROLLBACK")]);
      await Promise.allSettled([first.end(), second.end()]);
    }
    expect((await owner.query(`SELECT review_status FROM ${table("promotion_campaigns")} WHERE id=$1`, [campaign])).rows[0].review_status).toBe("pending");
  });
  it("serves admin insights: activity, engagement, retention, communities, users, reports and billing", async () => {
    const admin = randomUUID(), moderator = randomUUID(), member = randomUUID(), adminToken = newTokenHash(), moderatorToken = newTokenHash();
    const tenant = randomUUID(), community = randomUUID(), post = randomUUID(), comment = randomUUID(), report = randomUUID();
    const freePlan = randomUUID(), proPlan = randomUUID(), monthly = randomUUID(), yearly = randomUUID(), customer = randomUUID();
    const tenantB = randomUUID(), customerB = randomUUID(), subA = randomUUID(), subB = randomUUID(), subFree = randomUUID(), tenantFree = randomUUID();
    const tenantPaused = randomUUID(), tenantTrial = randomUUID(), customerPaused = randomUUID(), customerTrial = randomUUID(), euro = randomUUID();
    await owner.query("SET ROLE spark_owner");
    await owner.query(`INSERT INTO ${table("users")} (id,display_name) VALUES ($1,'Insight admin'),($2,'Insight moderator'),($3,'Insight member')`, [admin, moderator, member]);
    await owner.query(`INSERT INTO ${table("platform_role_assignments")} (user_id,role,granted_by_user_id) VALUES ($1,'platform_admin',$1),($2,'content_moderator',$1)`, [admin, moderator]);
    await owner.query(`INSERT INTO ${table("sessions")} (user_id,token_hash,auth_method,expires_at) VALUES ($1,$2,'password',$5),($3,$4,'password',$5)`, [admin, adminToken, moderator, moderatorToken, future()]);
    // The member signed in today and twice three days ago; one session is revoked, one expired.
    await owner.query(`INSERT INTO ${table("sessions")} (user_id,token_hash,auth_method,created_at,expires_at,revoked_at) VALUES
      ($1,$2,'password',now(),now()+interval '1 day',NULL),
      ($1,$3,'password',now()-interval '3 days',now()+interval '1 day',now()-interval '2 days'),
      ($1,$4,'password',now()-interval '3 days',now()-interval '1 day',NULL)`, [member, newTokenHash(), newTokenHash(), newTokenHash()]);
    await owner.query("BEGIN");
    for (const [id, user] of [[tenant, member], [tenantB, member], [tenantFree, member], [tenantPaused, member], [tenantTrial, member]]) {
      await owner.query(`INSERT INTO ${table("workspaces")} (id,slug,name,created_by_user_id) VALUES ($1::uuid,$1::text,'Insight workspace',$2)`, [id, user]);
      await owner.query(`INSERT INTO ${table("workspace_memberships")} (tenant_id,user_id,role) VALUES ($1,$2,'owner')`, [id, user]);
    }
    await owner.query(`INSERT INTO ${table("communities")} (id,tenant_id,slug,name,tagline,description,visibility,created_by_user_id) VALUES ($1::uuid,$2,$1::text,'Insight Circle','Tagline','Description','public',$3)`, [community, tenant, member]);
    await owner.query(`INSERT INTO ${table("community_memberships")} (tenant_id,community_id,user_id,role) VALUES ($1,$2,$3,'owner')`, [tenant, community, member]);
    await owner.query("COMMIT");
    await owner.query(`INSERT INTO ${table("posts")} (id,tenant_id,community_id,author_user_id,title,body,moderation_status) VALUES ($1,$2,$3,$4,'Insight post','Body','hidden')`, [post, tenant, community, member]);
    await owner.query(`INSERT INTO ${table("post_comments")} (id,tenant_id,community_id,post_id,author_user_id,body) VALUES ($1,$2,$3,$4,$5,'Insight comment')`, [comment, tenant, community, post, member]);
    await owner.query(`INSERT INTO ${table("content_reports")} (id,tenant_id,community_id,reporter_user_id,post_id,reason_code,status,resolved_at,created_at) VALUES ($1,$2,$3,$4,$5,'spam','resolved',now(),now()-interval '2 hours')`, [report, tenant, community, admin, post]);
    // Billing: one monthly and one yearly paid subscription plus one free workspace.
    await owner.query(`INSERT INTO ${table("subscription_plans")} (id,code,name,billing_kind) VALUES ($1,$3,'Free','free'),($2,$4,'Pro','paid')`, [freePlan, proPlan, `free-${freePlan}`, `pro-${proPlan}`]);
    await owner.query(`INSERT INTO ${table("plan_prices")} (id,plan_id,currency,amount_minor,billing_interval,provider,provider_price_id) VALUES ($1,$3,'USD',2900,'month','demo',$4),($2,$3,'USD',120000,'year','demo',$5)`, [monthly, yearly, proPlan, `m-${monthly}`, `y-${yearly}`]);
    await owner.query(`INSERT INTO ${table("billing_customers")} (id,tenant_id,provider,provider_customer_id) VALUES ($1,$2,'demo',$3),($4,$5,'demo',$6)`, [customer, tenant, `c-${customer}`, customerB, tenantB, `c-${customerB}`]);
    await owner.query(`INSERT INTO ${table("subscriptions")} (id,tenant_id,billing_customer_id,plan_id,price_id,provider,provider_subscription_id,billing_kind,status,created_at) VALUES
      ($1,$2,$3,$4,$5,'demo',$6,'paid','active',now()-interval '40 days'),
      ($7,$8,$9,$4,$10,'demo',$11,'paid','active',now()-interval '10 days')`, [subA, tenant, customer, proPlan, monthly, `s-${subA}`, subB, tenantB, customerB, yearly, `s-${subB}`]);
    await owner.query(`INSERT INTO ${table("subscriptions")} (id,tenant_id,plan_id,billing_kind,status) VALUES ($1,$2,$3,'free','active')`, [subFree, tenantFree, freePlan]);
    // Not revenue: a paused subscription on a EUR price, and a trial cancelled before it ended.
    await owner.query(`INSERT INTO ${table("plan_prices")} (id,plan_id,currency,amount_minor,billing_interval,provider,provider_price_id) VALUES ($1,$2,'EUR',5000,'month','demo',$3)`, [euro, proPlan, `e-${euro}`]);
    await owner.query(`INSERT INTO ${table("billing_customers")} (id,tenant_id,provider,provider_customer_id) VALUES ($1,$2,'demo',$3),($4,$5,'demo',$6)`, [customerPaused, tenantPaused, `c-${customerPaused}`, customerTrial, tenantTrial, `c-${customerTrial}`]);
    await owner.query(`INSERT INTO ${table("subscriptions")} (tenant_id,billing_customer_id,plan_id,price_id,provider,provider_subscription_id,billing_kind,status,created_at,trial_ends_at,cancelled_at) VALUES
      ($1,$2,$3,$4,'demo',$5,'paid','paused',now()-interval '60 days',NULL,NULL),
      ($6,$7,$3,$8,'demo',$9,'paid','cancelled',now()-interval '9 days',now()+interval '5 days',now()-interval '5 days')`,
      [tenantPaused, customerPaused, proPlan, euro, `s-${tenantPaused}`, tenantTrial, customerTrial, monthly, `s-${tenantTrial}`]);
    await owner.query(`INSERT INTO ${table("invoices")} (tenant_id,subscription_id,provider,provider_invoice_id,currency,subtotal_minor,total_minor,status,issued_at,paid_at) VALUES
      ($1,$2,'demo',$3,'USD',2900,2900,'paid',now()-interval '5 days',now()-interval '5 days'),
      ($1,$2,'demo',$4,'USD',2900,2900,'open',now()-interval '1 day',NULL)`, [tenant, subA, `i1-${subA}`, `i2-${subA}`]);
    await owner.query(`INSERT INTO ${table("payment_events")} (provider,provider_event_id,tenant_id,payload,status) VALUES ('demo',$1,$2,'{}','failed')`, [`e-${subA}`, tenant]);

    const call = (token: Buffer | null, sql: string, values: unknown[] = []) => asSession(token, sql, values).then((r) => r.rows);

    // Activity series: one row per day, today last, with the member's sign-in, post and comment.
    const series = await call(adminToken, `SELECT * FROM ${fn("staff_activity_series")}(7)`);
    expect(series).toHaveLength(7);
    const today = series[6];
    expect(Number(today.sign_ins)).toBeGreaterThanOrEqual(1);
    expect(Number(today.posts)).toBeGreaterThanOrEqual(1);
    expect(Number(today.comments)).toBeGreaterThanOrEqual(1);
    expect(Number(today.reports_closed)).toBeGreaterThanOrEqual(1);
    expect(Number(series[3].sign_ins)).toBeGreaterThanOrEqual(2);
    const totals = (await call(adminToken, `SELECT * FROM ${fn("staff_active_user_totals")}()`))[0];
    expect(Number(totals.dau)).toBeGreaterThanOrEqual(1);
    expect(Number(totals.mau)).toBeGreaterThanOrEqual(Number(totals.wau));
    const heat = await call(adminToken, `SELECT * FROM ${fn("staff_engagement_heatmap")}(30)`);
    expect(heat.every((row) => row.dow >= 1 && row.dow <= 7 && row.hour >= 0 && row.hour <= 23)).toBe(true);
    const cohorts = await call(adminToken, `SELECT * FROM ${fn("staff_retention_cohorts")}(8)`);
    expect(cohorts.some((row) => row.week_offset === 0 && Number(row.active_users) >= 1)).toBe(true);

    // Bounds and roles.
    for (const bad of [6, 366]) await expect(call(adminToken, `SELECT * FROM ${fn("staff_activity_series")}($1)`, [bad])).rejects.toMatchObject({ code: "22023" });
    await expect(call(adminToken, `SELECT * FROM ${fn("staff_top_communities")}(30, 51)`)).rejects.toMatchObject({ code: "22023" });
    for (const sql of [`SELECT * FROM ${fn("staff_activity_series")}(7)`, `SELECT * FROM ${fn("staff_billing_counts")}()`, `SELECT * FROM ${fn("staff_user_sessions")}($1, 5)`]) {
      await expect(call(moderatorToken, sql, sql.includes("$1") ? [member] : [])).rejects.toMatchObject({ code: "42501" });
      await expect(call(null, sql, sql.includes("$1") ? [member] : [])).rejects.toMatchObject({ code: "28000" });
    }

    // Communities.
    const top = await call(adminToken, `SELECT * FROM ${fn("staff_top_communities")}(30, 50)`);
    // The post is hidden, so only the visible comment counts towards community activity.
    expect(top.find((row) => row.community_id === community)).toMatchObject({ posts: "0", comments: "1", contributors: "1" });
    const [health] = await call(adminToken, `SELECT * FROM ${fn("staff_community_health")}($1::uuid[])`, [[community]]);
    expect(health).toMatchObject({ members: "1", posts_30d: "0", comments_30d: "1", open_reports: "0" });
    expect(health.weekly_activity).toHaveLength(8);
    expect(Number(health.weekly_activity[7])).toBe(1);
    const communitySeries = await call(adminToken, `SELECT * FROM ${fn("staff_community_series")}($1, 7)`, [community]);
    expect(communitySeries).toHaveLength(7);
    expect(communitySeries[6]).toMatchObject({ posts: "0", comments: "1", reports_opened: "1" });

    // Users: activity, sessions without token hashes, and risk signals.
    const userDays = await call(adminToken, `SELECT * FROM ${fn("staff_user_activity")}($1, 7)`, [member]);
    expect(userDays[6]).toMatchObject({ sign_ins: "1", posts: "1", comments: "1" });
    expect(userDays[3]).toMatchObject({ sign_ins: "2" });
    const sessionRows = await asSession(adminToken, `SELECT * FROM ${fn("staff_user_sessions")}($1, 10)`, [member]);
    expect(sessionRows.fields.map((field) => field.name)).toEqual(["id", "created_at", "last_seen_at", "expires_at", "auth_method", "state"]);
    expect(sessionRows.rows.map((row) => row.state).sort()).toEqual(["active", "expired", "revoked"]);
    const [risk] = await call(adminToken, `SELECT * FROM ${fn("staff_user_risk")}($1::uuid[])`, [[member]]);
    expect(risk).toMatchObject({ hidden_posts: "1", hidden_comments: "0", reports_against: "1" });

    // Reports.
    const [context] = await call(moderatorToken, `SELECT * FROM ${fn("staff_report_context")}($1)`, [report]);
    expect(context).toMatchObject({ author_id: member, author_name: "Insight member", author_reports: "1", author_hidden: "1" });
    expect(await call(moderatorToken, `SELECT * FROM ${fn("staff_report_context")}($1)`, [randomUUID()])).toEqual([]);
    // Preview: a post report shows the post and its author; a comment report also shows the parent post.
    const [postPreview] = await call(moderatorToken, `SELECT * FROM ${fn("staff_report_preview")}($1)`, [report]);
    expect(postPreview).toMatchObject({ post_id: post, post_title: "Insight post", post_status: "hidden", post_author_name: "Insight member", post_comment_count: "1", comment_id: null });
    const commentReport = randomUUID();
    await owner.query("SET ROLE spark_owner");
    await owner.query(`INSERT INTO ${table("content_reports")} (id,tenant_id,community_id,reporter_user_id,comment_id,reason_code) VALUES ($1,$2,$3,$4,$5,'harassment')`, [commentReport, tenant, community, admin, comment]);
    const [commentPreview] = await call(moderatorToken, `SELECT * FROM ${fn("staff_report_preview")}($1)`, [commentReport]);
    expect(commentPreview).toMatchObject({ post_id: post, post_title: "Insight post", comment_id: comment, comment_body: "Insight comment", comment_author_name: "Insight member" });
    expect(await call(moderatorToken, `SELECT * FROM ${fn("staff_report_preview")}($1)`, [randomUUID()])).toEqual([]);
    await expect(call(adminToken, `SELECT * FROM ${fn("staff_report_preview")}($1)`, [report])).resolves.toHaveLength(1);
    await expect(call(null, `SELECT * FROM ${fn("staff_report_preview")}($1)`, [report])).rejects.toMatchObject({ code: "28000" });
    const [stats] = await call(moderatorToken, `SELECT * FROM ${fn("staff_report_stats")}(30)`);
    expect(Number(stats.closed)).toBeGreaterThanOrEqual(1);
    expect(stats.median_hours_to_close).not.toBeNull();

    // Billing: the yearly price counts as 120000 / 12 = 10000 per month.
    const [counts] = await call(adminToken, `SELECT * FROM ${fn("staff_billing_counts")}()`);
    // The trial cancelled before it ended never paid, so it is not a cancellation of a paying customer.
    expect(counts).toMatchObject({ free_workspaces: "1", paying: "2", trialing: "0", past_due: "0", cancelled_30d: "0", new_paid_30d: "1", failed_payments_30d: "1" });
    const revenue = await call(adminToken, `SELECT * FROM ${fn("staff_billing_revenue")}()`);
    expect(revenue).toEqual([{ currency: "USD", mrr_minor: "12900", collected_30d_minor: "2900", open_minor: "2900", uncollectible_minor: "0" }]);
    const mrrSeries = await call(adminToken, `SELECT * FROM ${fn("staff_billing_mrr_series")}(3)`);
    // The chart counts the same subscriptions as the headline MRR: no paused EUR row, no trial churn.
    expect(mrrSeries).toHaveLength(3);
    expect(mrrSeries.every((row) => row.currency === "USD" && row.churned === "0")).toBe(true);
    expect(mrrSeries[2]).toMatchObject({ currency: "USD", mrr_minor: "12900" });
    const mix = await call(adminToken, `SELECT * FROM ${fn("staff_billing_plan_mix")}()`);
    // One row per plan and currency, so amounts in different currencies are never added together.
    expect(mix.find((row) => row.plan_code === `pro-${proPlan}` && row.currency === "USD")).toMatchObject({ subscriptions: "2", mrr_minor: "12900" });
    expect(mix.find((row) => row.plan_code === `pro-${proPlan}` && row.currency === "EUR")).toMatchObject({ subscriptions: "1", mrr_minor: "0" });
    expect(mix.find((row) => row.plan_code === `free-${freePlan}`)).toMatchObject({ subscriptions: "1", mrr_minor: "0" });
    const subs = await call(adminToken, `SELECT * FROM ${fn("staff_list_subscriptions")}(NULL,NULL,NULL,NULL,2)`);
    expect(subs).toHaveLength(2);
    const nextSubs = await call(adminToken, `SELECT * FROM ${fn("staff_list_subscriptions")}(NULL,NULL,$1,$2,10)`, [subs[1].created_at, subs[1].id]);
    expect(nextSubs.map((row) => row.id)).not.toContain(subs[0].id);
    expect((await call(adminToken, `SELECT * FROM ${fn("staff_list_subscriptions")}('active',NULL,NULL,NULL,10)`)).every((row) => row.status === "active")).toBe(true);
    expect((await call(adminToken, `SELECT * FROM ${fn("staff_list_subscriptions")}(NULL,'free',NULL,NULL,10)`)).every((row) => row.billing_kind === "free")).toBe(true);
    await expect(call(adminToken, `SELECT * FROM ${fn("staff_list_subscriptions")}(NULL,'gold',NULL,NULL,10)`)).rejects.toMatchObject({ code: "22023" });
    await expect(call(adminToken, `SELECT * FROM ${fn("staff_list_subscriptions")}('gone',NULL,NULL,NULL,10)`)).rejects.toMatchObject({ code: "22023" });
    const invoices = await call(adminToken, `SELECT * FROM ${fn("staff_list_invoices")}('open',NULL,NULL,10)`);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ plan_name: "Pro", total_minor: "2900", status: "open" });
  });
  it("classifies community health like the admin badges", async () => {
    const fixture = await insightFixture();
    const counts = async () => {
      const rows = (await asSession(fixture.communityModerator, `SELECT * FROM ${fn("staff_community_health_counts")}()`)).rows;
      expect(rows).toHaveLength(1);
      return Object.fromEntries(Object.entries(rows[0] as Record<string, string>).map(([key, value]) => [key, Number(value)]));
    };
    const before = await counts();
    // Shared with the frontend healthOf test, so the SQL counts and the table badges agree on the same cases.
    const { cases } = JSON.parse(await readFile(resolve("../frontend/tests/fixtures/community-health.json"), "utf8")) as { cases: HealthCase[] };
    const ids: string[] = [];
    for (const { name, recentPosts, earlierPosts, openReports, resolvedReports, archived } of cases) {
      const community = await insightCommunity(fixture, name);
      if (recentPosts) await weeklyPosts(fixture, community, 2, recentPosts);
      if (earlierPosts) await weeklyPosts(fixture, community, 5, earlierPosts);
      for (let index = 0; index < openReports; index++) await insightReport(fixture, community, "spam");
      // A resolved report does not make a community need review.
      for (let index = 0; index < resolvedReports; index++) await insightReport(fixture, community, "spam", "resolved", new Date(), new Date());
      if (archived) await owner.query(`UPDATE ${table("communities")} SET archived_at=now() WHERE id=$1`, [community]);
      ids.push(community);
    }
    const after = await counts();
    const expected = Object.fromEntries(Object.keys(after).map((key) => [key, cases.filter((entry) => entry.expected === key).length]));
    expect(expected).toEqual({ growing: 2, steady: 1, slowing: 1, quiet: 1, needs_review: 1, archived: 1 });
    expect(Object.fromEntries(Object.keys(after).map((key) => [key, after[key]! - before[key]!]))).toEqual(expected);
    // The per-community health read feeds the table badges; classifying its output gives the same answers.
    const health = (await asSession(fixture.communityModerator, `SELECT community_id,weekly_activity,open_reports FROM ${fn("staff_community_health")}($1::uuid[])`, [ids])).rows;
    const archivedIds = new Set(ids.filter((_, index) => cases[index]!.archived));
    const badges = new Map(health.map((row) => [row.community_id as string, badgeOf(archivedIds.has(row.community_id), Number(row.open_reports), (row.weekly_activity as string[]).map(Number))]));
    expect(ids.map((id) => badges.get(id))).toEqual(cases.map((entry) => entry.expected));
  });
  it("returns one community row per day including empty days", async () => {
    const fixture = await insightFixture();
    const daily = async () => (await asSession(fixture.communityModerator, `SELECT day::text AS day,new_members,new_communities,live_communities FROM ${fn("staff_community_daily")}(7)`)).rows;
    const before = await daily();
    const community = await insightCommunity(fixture, "Daily Circle", utcDay(3));
    const joiners = [randomUUID(), randomUUID()];
    await owner.query(`INSERT INTO ${table("users")} (id,display_name) VALUES ($1,'Joiner one'),($2,'Joiner two')`, joiners);
    for (const joiner of joiners) {
      await owner.query(`INSERT INTO ${table("community_memberships")} (tenant_id,community_id,user_id,joined_at) VALUES ($1,$2,$3,$4)`, [fixture.tenant, community, joiner, utcDay(1)]);
    }
    const after = await daily();
    expect(after).toHaveLength(7);
    expect(after.map((row) => row.day)).toEqual(Array.from({ length: 7 }, (_, index) => utcDay(6 - index).toISOString().slice(0, 10)));
    // Archive times are overwritten on restore, so the live count cannot be rebuilt exactly and is never guessed.
    expect(after.every((row) => row.live_communities === null)).toBe(true);
    const delta = after.map((row, index) => [Number(row.new_members) - Number(before[index]!.new_members), Number(row.new_communities) - Number(before[index]!.new_communities)]);
    expect(delta).toEqual([[0, 0], [0, 0], [0, 0], [1, 1], [0, 0], [2, 0], [0, 0]]);
    expect(after.every((row) => row.new_members !== null && row.new_communities !== null)).toBe(true);
  });
  it("rebuilds the report backlog per day", async () => {
    const fixture = await insightFixture();
    const community = await insightCommunity(fixture, "Backlog Circle");
    const daily = async () => (await asSession(fixture.contentModerator, `SELECT day::text AS day,opened,closed,backlog,median_hours_to_close FROM ${fn("staff_report_daily")}(30)`)).rows;
    const before = await daily();
    // Index i of the 30-day series is the day 29 - i days ago; no other fixture closes reports on these days.
    const at = (daysAgo: number) => 29 - daysAgo;
    expect([before[at(18)]!.closed, before[at(17)]!.closed]).toEqual(["0", "0"]);
    await insightReport(fixture, community, "spam", "resolved", utcDay(20, 10), utcDay(18, 10));
    await insightReport(fixture, community, "spam", "dismissed", utcDay(20, 12), utcDay(18, 16));
    await insightReport(fixture, community, "abuse", "open", utcDay(19, 8));
    await insightReport(fixture, community, "abuse", "resolved", utcDay(19, 9), utcDay(17, 9));
    // Opened before the range, closed inside it: part of the backlog from the first day.
    await insightReport(fixture, community, "abuse", "resolved", utcDay(40, 9), utcDay(17, 10));
    const after = await daily();
    expect(after).toHaveLength(30);
    expect(after[29]!.day).toBe(utcDay(0).toISOString().slice(0, 10));
    const delta = (key: string) => after.map((row, index) => Number(row[key]) - Number(before[index]![key]));
    const expectedOpened = Array(30).fill(0), expectedClosed = Array(30).fill(0), expectedBacklog = Array(30).fill(1);
    expectedOpened[at(20)] = 2; expectedOpened[at(19)] = 2;
    expectedClosed[at(18)] = 2; expectedClosed[at(17)] = 2;
    expectedBacklog[at(20)] = 3; expectedBacklog[at(19)] = 5; expectedBacklog[at(18)] = 3;
    expect(delta("opened")).toEqual(expectedOpened);
    expect(delta("closed")).toEqual(expectedClosed);
    expect(delta("backlog")).toEqual(expectedBacklog);
    // 48 h and 52 h on one day; 48 h and 553 h on the next.
    expect([after[at(18)]!.median_hours_to_close, after[at(17)]!.median_hours_to_close]).toEqual(["50.0", "300.5"]);
    // Today's end-of-day backlog is the live queue.
    const [stats] = (await asSession(fixture.contentModerator, `SELECT backlog FROM ${fn("staff_report_stats")}(30)`)).rows;
    expect(after[29]!.backlog).toBe(stats.backlog);
  });
  it("groups open reports by reason and community", async () => {
    const fixture = await insightFixture();
    const busy = await insightCommunity(fixture, "Busy Reports"), calm = await insightCommunity(fixture, "Calm Reports");
    const reasonA = `reason-${randomUUID()}`, reasonB = `reason-${randomUUID()}`;
    for (let index = 0; index < 3; index++) await insightReport(fixture, busy, reasonA);
    await insightReport(fixture, busy, reasonB, "reviewing");
    await insightReport(fixture, calm, reasonB);
    // Closed reports are not part of the queue.
    await insightReport(fixture, calm, reasonA, "dismissed", new Date(), new Date());
    await insightReport(fixture, calm, reasonA, "resolved", new Date(), new Date());
    const reasons = (await asSession(fixture.contentModerator, `SELECT * FROM ${fn("staff_report_reasons")}()`)).rows;
    expect(reasons.find((row) => row.reason === reasonA)).toEqual({ reason: reasonA, open_count: "3" });
    expect(reasons.find((row) => row.reason === reasonB)).toEqual({ reason: reasonB, open_count: "2" });
    const reasonCounts = reasons.map((row) => Number(row.open_count));
    expect(reasonCounts).toEqual([...reasonCounts].sort((a, b) => b - a));
    const top = (await asSession(fixture.contentModerator, `SELECT * FROM ${fn("staff_report_top_communities")}(20)`)).rows;
    expect(top.length).toBeLessThanOrEqual(20);
    expect(top.find((row) => row.community_id === busy)).toEqual({ community_id: busy, name: "Busy Reports", slug: busy, open_count: "4" });
    expect(top.find((row) => row.community_id === calm)).toMatchObject({ open_count: "1" });
    const topCounts = top.map((row) => Number(row.open_count));
    expect(topCounts).toEqual([...topCounts].sort((a, b) => b - a));
    expect((await asSession(fixture.contentModerator, `SELECT * FROM ${fn("staff_report_top_communities")}(1)`)).rows).toHaveLength(1);
  });
  it("refuses report insights to a community moderator and community stats to a content moderator", async () => {
    const fixture = await insightFixture();
    const reportReads = [`SELECT * FROM ${fn("staff_report_reasons")}()`, `SELECT * FROM ${fn("staff_report_top_communities")}(5)`, `SELECT * FROM ${fn("staff_report_daily")}(7)`];
    const communityReads = [`SELECT * FROM ${fn("staff_community_health_counts")}()`, `SELECT * FROM ${fn("staff_community_daily")}(7)`];
    for (const sql of reportReads) await expect(asSession(fixture.communityModerator, sql)).rejects.toMatchObject({ code: "42501" });
    for (const sql of communityReads) await expect(asSession(fixture.contentModerator, sql)).rejects.toMatchObject({ code: "42501" });
    for (const sql of [...reportReads, ...communityReads]) {
      await expect(asSession(null, sql)).rejects.toMatchObject({ code: "28000" });
      await expect(asSession(fixture.admin, sql)).resolves.toBeDefined();
    }
    await expect(asSession(fixture.contentModerator, reportReads[2]!)).resolves.toBeDefined();
    await expect(asSession(fixture.communityModerator, communityReads[1]!)).resolves.toBeDefined();
  });
  it("rejects ranges outside 7–365", async () => {
    const fixture = await insightFixture();
    for (const days of [6, 366, null]) {
      await expect(asSession(fixture.admin, `SELECT * FROM ${fn("staff_community_daily")}($1)`, [days])).rejects.toMatchObject({ code: "22023", message: "Invalid range" });
      await expect(asSession(fixture.admin, `SELECT * FROM ${fn("staff_report_daily")}($1)`, [days])).rejects.toMatchObject({ code: "22023", message: "Invalid range" });
    }
    for (const days of [7, 365]) {
      expect((await asSession(fixture.admin, `SELECT * FROM ${fn("staff_community_daily")}($1)`, [days])).rows).toHaveLength(days);
      expect((await asSession(fixture.admin, `SELECT * FROM ${fn("staff_report_daily")}($1)`, [days])).rows).toHaveLength(days);
    }
    for (const limit of [0, 21, null]) {
      await expect(asSession(fixture.admin, `SELECT * FROM ${fn("staff_report_top_communities")}($1)`, [limit])).rejects.toMatchObject({ code: "22023", message: "Invalid limit" });
    }
  });
  it("creates a workspace with its owner atomically", async () => {
    const alice = await account("Alice Owner");
    const created = await createWorkspace(alice, "  Acme Labs  ", "acme-" + randomUUID().slice(0, 8));
    expect(created.outcome).toBe("ok");
    const workspace = created.workspace_id!;
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT name,created_by_user_id,version FROM ${table("workspaces")} WHERE id=$1`, [workspace])).rows).toEqual([{ name: "Acme Labs", created_by_user_id: alice.id, version: 1 }]);
    expect((await owner.query(`SELECT user_id,role,status FROM ${table("workspace_memberships")} WHERE tenant_id=$1`, [workspace])).rows).toEqual([{ user_id: alice.id, role: "owner", status: "active" }]);
    expect(await auditRows(workspace)).toEqual([expect.objectContaining({ action: "workspace.created", actor_user_id: alice.id, resource_type: "workspace" })]);
    expect((await asSession(alice.token, `SELECT id FROM ${table("workspaces")} WHERE id=$1`, [workspace])).rows).toHaveLength(1);
    const slug = (await owner.query(`SELECT slug FROM ${table("workspaces")} WHERE id=$1`, [workspace])).rows[0].slug;
    const other = await account("Other Founder");
    expect(await createWorkspace(other, "Copy", slug)).toEqual({ outcome: "slug_taken", workspace_id: null });
    expect(await createWorkspace(alice, "Copy", slug)).toEqual({ outcome: "slug_taken", workspace_id: null });
    for (let index = 1; index < 20; index++) expect((await createWorkspace(alice, `Workspace ${index}`)).outcome).toBe("ok");
    expect(await createWorkspace(alice, "One too many")).toEqual({ outcome: "too_many_workspaces", workspace_id: null });
    // Archived workspaces do not count toward the cap.
    await owner.query("SET ROLE spark_owner");
    await owner.query(`UPDATE ${table("workspaces")} SET archived_at=now(),version=version+1 WHERE id=$1`, [workspace]);
    expect((await createWorkspace(alice, "After archive")).outcome).toBe("ok");
    const call = `SELECT * FROM ${fn("ws_create_workspace")}($1,$2)`;
    for (const bad of ["-ab", "ab", "Upper-case", "trailing-", "a".repeat(41), "has space"]) {
      await expect(asSession(other.token, call, ["Valid", bad])).rejects.toMatchObject({ code: "22023", message: "Invalid workspace slug" });
    }
    for (const bad of ["   ", "x".repeat(81)]) {
      await expect(asSession(other.token, call, [bad, uniqueSlug()])).rejects.toMatchObject({ code: "22023", message: "Invalid workspace name" });
    }
    for (const token of [null, newTokenHash()]) {
      await expect(asSession(token, call, ["No session", uniqueSlug()])).rejects.toMatchObject({ code: "28000" });
    }
  });
  it("renames with optimistic version", async () => {
    const alice = await account("Rename Owner"), bob = await account("Rename Member"), carol = await account("Rename Stranger");
    const workspace = (await createWorkspace(alice, "Acme")).workspace_id!;
    await addMember(workspace, bob, "member");
    const rename = (who: Account, target: string, version: number, name: string) =>
      asSession(who.token, `SELECT * FROM ${fn("ws_update_workspace")}($1,$2,$3)`, [target, version, name]).then((r) => r.rows[0]);
    expect(await rename(alice, workspace, 1, "  Renamed  ")).toEqual({ outcome: "ok", version: 2 });
    expect(await rename(alice, workspace, 1, "Stale")).toEqual({ outcome: "version_mismatch", version: 2 });
    expect(await rename(bob, workspace, 2, "Member rename")).toEqual({ outcome: "forbidden", version: null });
    expect(await rename(carol, workspace, 2, "Stranger rename")).toEqual({ outcome: "not_found", version: null });
    expect(await rename(alice, randomUUID(), 1, "Missing")).toEqual({ outcome: "not_found", version: null });
    await expect(rename(alice, workspace, 2, " ")).rejects.toMatchObject({ code: "22023", message: "Invalid workspace name" });
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT name,version FROM ${table("workspaces")} WHERE id=$1`, [workspace])).rows[0]).toEqual({ name: "Renamed", version: 2 });
    const renamed = (await auditRows(workspace)).filter((row) => row.action === "workspace.renamed");
    expect(renamed).toEqual([{ action: "workspace.renamed", actor_user_id: alice.id, resource_type: "workspace", metadata: { from: "Acme", to: "Renamed" } }]);
  });
  it("invites, previews, revokes and expires invitations", async () => {
    const alice = await account("Invite Owner"), dave = await account("Invite Admin"), bob = await account("Invite Member", `Invite.Member.${randomUUID()}@Example.com`);
    const carol = await account("Invite Stranger");
    const workspace = (await createWorkspace(alice, "Invite Co")).workspace_id!;
    await addMember(workspace, dave, "admin");
    await addMember(workspace, bob, "member");
    const erin = `erin.${randomUUID()}@example.com`;
    expect((await invite(dave, workspace, erin, "admin")).outcome).toBe("forbidden");
    expect((await invite(bob, workspace, erin)).outcome).toBe("forbidden");
    expect((await invite(carol, workspace, erin)).outcome).toBe("not_found");
    expect((await invite(alice, randomUUID(), erin)).outcome).toBe("not_found");
    expect((await invite(alice, workspace, `  ${bob.email.toUpperCase()} `)).outcome).toBe("already_member");
    const created = await invite(alice, workspace, `  ${erin.toUpperCase()}  `, "member");
    expect(created.outcome).toBe("ok");
    const invitation = created.invitation_id!;
    expect((await invite(dave, workspace, erin)).outcome).toBe("invitation_pending");
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT email_normalized,role,status,invited_by_user_id FROM ${table("workspace_invitations")} WHERE id=$1`, [invitation])).rows[0])
      .toEqual({ email_normalized: erin, role: "member", status: "pending", invited_by_user_id: alice.id });
    const outbox = async () => (await owner.query(`SELECT event_type,aggregate_type,aggregate_version,payload,processed_at FROM ${table("outbox_events")} WHERE aggregate_id=$1 ORDER BY aggregate_version`, [invitation])).rows;
    expect(await outbox()).toEqual([{ event_type: "invitation.created", aggregate_type: "workspace_invitation", aggregate_version: 1, payload: { invitationId: invitation }, processed_at: null }]);
    expect(await auditRows(invitation)).toEqual([{ action: "invitation.created", actor_user_id: alice.id, resource_type: "invitation", metadata: { role: "member" } }]);
    const token = (await issueToken(invitation))!;
    expect(token).not.toBeNull();

    const call = `SELECT * FROM ${fn("ws_create_invitation")}($1,$2,$3,$4)`;
    for (const [email, role, expires, message] of [
      ["not-an-email", "member", inDays(7), "Invalid invitation email"], ["a b@example.com", "member", inDays(7), "Invalid invitation email"],
      [`${"x".repeat(250)}@example.com`, "member", inDays(7), "Invalid invitation email"], [erin, "owner", inDays(7), "Invalid invitation role"],
      [erin, "member", inDays(9), "Invalid invitation expiry"], [erin, "member", new Date(Date.now() - 1000), "Invalid invitation expiry"],
    ] as const) {
      await expect(asSession(alice.token, call, [workspace, email, role, expires])).rejects.toMatchObject({ code: "22023", message });
    }
    await expect(asSession(null, call, [workspace, erin, "member", inDays(7)])).rejects.toMatchObject({ code: "28000" });

    // Previews need no session; the token hash itself is never readable by the runtime role.
    const preview = async (hash: Buffer) => (await runtime.query(`SELECT * FROM ${fn("ws_invitation_preview")}($1)`, [hash])).rows;
    expect(await preview(token)).toEqual([expect.objectContaining({ status: "pending", workspace_name: "Invite Co", inviter_name: "Invite Owner", role: "member", email_hint: "e***@example.com" })]);
    expect(await preview(newTokenHash())).toEqual([]);
    expect((await owner.query(`SELECT has_column_privilege('spark_app',$1,'token_hash','SELECT') AS allowed`, [table("workspace_invitations")])).rows[0].allowed).toBe(false);
    await expect(asSession(alice.token, `SELECT token_hash FROM ${table("workspace_invitations")}`)).rejects.toMatchObject({ code: "42501" });
    const listed = (who: Account) => asSession(who.token, `SELECT id FROM ${table("workspace_invitations")} WHERE tenant_id=$1`, [workspace]).then((r) => r.rows.map((row) => row.id));
    expect(await listed(alice)).toEqual([invitation]);
    expect(await listed(dave)).toEqual([invitation]);
    expect(await listed(bob)).toEqual([]);
    expect(await listed(carol)).toEqual([]);

    expect(await outcome(bob, "ws_resend_invitation($1)", [invitation])).toBe("forbidden");
    expect(await outcome(carol, "ws_resend_invitation($1)", [invitation])).toBe("not_found");
    expect(await outcome(dave, "ws_resend_invitation($1)", [invitation])).toBe("ok");
    expect((await outbox()).map((row) => [row.event_type, row.aggregate_version])).toEqual([["invitation.created", 1], ["invitation.resent", 2]]);
    expect(await outcome(carol, "ws_revoke_invitation($1)", [invitation])).toBe("not_found");
    expect(await outcome(bob, "ws_revoke_invitation($1)", [invitation])).toBe("forbidden");
    expect(await outcome(alice, "ws_revoke_invitation($1)", [randomUUID()])).toBe("not_found");
    expect(await outcome(alice, "ws_revoke_invitation($1)", [invitation])).toBe("ok");
    expect(await outcome(alice, "ws_revoke_invitation($1)", [invitation])).toBe("not_pending");
    expect(await outcome(alice, "ws_resend_invitation($1)", [invitation])).toBe("not_pending");
    // A settled invitation previews its status only.
    expect(await preview(token)).toEqual([{ status: "revoked", workspace_name: null, inviter_name: null, role: null, email_hint: null, expires_at: null }]);
    expect(await issueToken(invitation)).toBeNull();
    expect((await auditRows(invitation)).map((row) => row.action)).toEqual(["invitation.created", "invitation.resent", "invitation.revoked"]);
    expect(await accept(await account("Erin", erin), token)).toMatchObject({ outcome: "invitation_revoked", workspace_id: null });

    // An admin manages member invitations only.
    const adminInvite = await invite(alice, workspace, `admin.${randomUUID()}@example.com`, "admin");
    expect(adminInvite.outcome).toBe("ok");
    expect(await outcome(dave, "ws_revoke_invitation($1)", [adminInvite.invitation_id])).toBe("forbidden");
    expect(await outcome(dave, "ws_resend_invitation($1)", [adminInvite.invitation_id])).toBe("forbidden");

    // A pending invitation past its expiry previews as expired, cannot be accepted, and is retired by a new invite.
    const frank = `frank.${randomUUID()}@example.com`, staleToken = newTokenHash(), stale = randomUUID();
    await owner.query("SET ROLE spark_owner");
    await owner.query(`INSERT INTO ${table("workspace_invitations")} (id,tenant_id,email_normalized,role,token_hash,invited_by_user_id,created_at,expires_at) VALUES ($1,$2,$3,'member',$4,$5,now()-interval '9 days',now()-interval '1 day')`, [stale, workspace, frank, staleToken, alice.id]);
    expect(await preview(staleToken)).toEqual([{ status: "expired", workspace_name: null, inviter_name: null, role: null, email_hint: null, expires_at: null }]);
    expect(await issueToken(stale)).toBeNull();
    expect((await accept(await account("Frank", frank), staleToken)).outcome).toBe("invitation_expired");
    expect((await invite(alice, workspace, frank)).outcome).toBe("ok");
    expect((await owner.query(`SELECT status FROM ${table("workspace_invitations")} WHERE id=$1`, [stale])).rows[0].status).toBe("expired");

    // A resend revives an expired invitation (by status or by date) unless a newer one for the address is pending.
    expect(await outcome(alice, "ws_resend_invitation($1)", [stale])).toBe("not_pending");
    const lapsed = randomUUID(), overdue = randomUUID();
    await owner.query("SET ROLE spark_owner");
    await owner.query(`INSERT INTO ${table("workspace_invitations")} (id,tenant_id,email_normalized,role,token_hash,invited_by_user_id,created_at,expires_at,status) VALUES
      ($1,$3,$4,'member',$5,$7,now()-interval '9 days',now()-interval '2 days','expired'),($2,$3,$6,'member',$8,$7,now()-interval '9 days',now()-interval '2 days','pending')`,
      [lapsed, overdue, workspace, `lapsed.${randomUUID()}@example.com`, newTokenHash(), `overdue.${randomUUID()}@example.com`, alice.id, newTokenHash()]);
    for (const id of [lapsed, overdue]) {
      expect(await outcome(dave, "ws_resend_invitation($1)", [id])).toBe("ok");
      await owner.query("SET ROLE spark_owner");
      expect((await owner.query(`SELECT status,expires_at > now()+interval '6 days 23 hours' AS renewed FROM ${table("workspace_invitations")} WHERE id=$1`, [id])).rows[0]).toEqual({ status: "pending", renewed: true });
      expect(await issueToken(id)).not.toBeNull();
    }
  });
  it("accepts only for the invited account", async () => {
    const alice = await account("Accept Owner"), bobEmail = `bob.${randomUUID()}@example.com`;
    const bob = await account("Bob", bobEmail), mallory = await account("Mallory");
    const workspace = (await createWorkspace(alice, "Accept Co")).workspace_id!;
    await owner.query("SET ROLE spark_owner");
    const slug = (await owner.query(`SELECT slug FROM ${table("workspaces")} WHERE id=$1`, [workspace])).rows[0].slug;
    const { invitation, token: firstToken } = await inviteWithToken(alice, workspace, `  ${bobEmail.toUpperCase()} `);
    // Re-issuing rotates the token: the earlier link stops working.
    const token = (await issueToken(invitation))!;
    expect(await accept(bob, firstToken)).toMatchObject({ outcome: "invalid_invitation", workspace_id: null });
    expect(await accept(mallory, token)).toEqual({ outcome: "recipient_mismatch", workspace_id: null, workspace_slug: null, role: null });
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT status FROM ${table("workspace_invitations")} WHERE id=$1`, [invitation])).rows[0].status).toBe("pending");
    expect(await accept(bob, newTokenHash())).toMatchObject({ outcome: "invalid_invitation", workspace_id: null });
    await expect(asSession(null, `SELECT * FROM ${fn("ws_accept_invitation")}($1)`, [token])).rejects.toMatchObject({ code: "28000" });

    expect(await accept(bob, token)).toEqual({ outcome: "ok", workspace_id: workspace, workspace_slug: slug, role: "member" });
    expect((await owner.query(`SELECT role,status FROM ${table("workspace_memberships")} WHERE tenant_id=$1 AND user_id=$2`, [workspace, bob.id])).rows).toEqual([{ role: "member", status: "active" }]);
    expect((await owner.query(`SELECT status,accepted_by_user_id FROM ${table("workspace_invitations")} WHERE id=$1`, [invitation])).rows[0]).toEqual({ status: "accepted", accepted_by_user_id: bob.id });
    expect((await owner.query(`SELECT kind,title,resource_type,resource_id FROM ${table("notifications")} WHERE recipient_user_id=$1`, [alice.id])).rows)
      .toEqual([{ kind: "invitation_accepted", title: "Bob joined Accept Co", resource_type: "workspace", resource_id: workspace }]);
    expect((await owner.query(`SELECT event_type,payload,processed_at IS NOT NULL AS processed FROM ${table("outbox_events")} WHERE aggregate_id=$1 AND event_type='invitation.accepted'`, [invitation])).rows)
      .toEqual([{ event_type: "invitation.accepted", payload: { workspaceId: workspace, userId: bob.id }, processed: true }]);
    expect((await auditRows(invitation)).map((row) => [row.action, row.actor_user_id])).toEqual([["invitation.created", alice.id], ["invitation.accepted", bob.id]]);
    expect(await accept(bob, token)).toEqual({ outcome: "already_member", workspace_id: workspace, workspace_slug: slug, role: "member" });
    expect((await accept(mallory, token)).outcome).toBe("invitation_used");

    // Member list: active members only, explicit columns, email visible to owners and admins only.
    const members = (who: Account) => asSession(who.token, `SELECT * FROM ${fn("ws_list_members")}($1)`, [workspace]);
    const ownerView = await members(alice);
    expect(ownerView.fields.map((field) => field.name)).toEqual(["user_id", "display_name", "avatar_url", "email", "role", "status", "joined_at"]);
    expect(ownerView.rows.map((row) => [row.user_id, row.role, row.email])).toEqual(expect.arrayContaining([[alice.id, "owner", alice.email], [bob.id, "member", bobEmail]]));
    expect(ownerView.rows).toHaveLength(2);
    expect((await members(bob)).rows.every((row) => row.email === null)).toBe(true);
    expect((await members(mallory)).rows).toEqual([]);

    // A member who left is re-activated by a new invitation instead of getting a second row.
    expect(await outcome(bob, "ws_remove_member($1,$2)", [workspace, bob.id])).toBe("ok");
    expect((await members(alice)).rows.map((row) => row.user_id)).toEqual([alice.id]);
    const { token: again } = await inviteWithToken(alice, workspace, bobEmail, "admin");
    expect(await accept(bob, again)).toEqual({ outcome: "ok", workspace_id: workspace, workspace_slug: slug, role: "admin" });
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT role,status,left_at FROM ${table("workspace_memberships")} WHERE tenant_id=$1 AND user_id=$2`, [workspace, bob.id])).rows).toEqual([{ role: "admin", status: "active", left_at: null }]);

    // A suspended membership is not silently re-activated.
    await owner.query(`UPDATE ${table("workspace_memberships")} SET status='suspended' WHERE tenant_id=$1 AND user_id=$2`, [workspace, bob.id]);
    const { token: third } = await inviteWithToken(alice, workspace, bobEmail, "member");
    expect((await accept(bob, third)).outcome).toBe("membership_suspended");
    expect((await owner.query(`SELECT status FROM ${table("workspace_memberships")} WHERE tenant_id=$1 AND user_id=$2`, [workspace, bob.id])).rows[0].status).toBe("suspended");
  });
  it("accepts once under concurrency", async () => {
    const alice = await account("Race Owner"), bobEmail = `race.${randomUUID()}@example.com`, bob = await account("Racer", bobEmail);
    const workspace = (await createWorkspace(alice, "Race Co")).workspace_id!;
    const { token } = await inviteWithToken(alice, workspace, bobEmail);
    const clients = [0, 1].map(() => new pg.Client({ connectionString: localConnection("DATABASE_URL"), connectionTimeoutMillis: 5000 }));
    await Promise.all(clients.map((client) => client.connect()));
    try {
      await Promise.all(clients.map((client) => client.query("SET lock_timeout = '15s'")));
      const attempt = async (client: pg.Client) => {
        await client.query("BEGIN");
        await client.query("SELECT set_config('spark.session_token_hash',$1,true)", [bob.token.toString("hex")]);
        const result = await client.query(`SELECT * FROM ${fn("ws_accept_invitation")}($1)`, [token]);
        await client.query("COMMIT");
        return result.rows[0].outcome as string;
      };
      expect((await Promise.all(clients.map(attempt))).sort()).toEqual(["already_member", "ok"]);
    } finally {
      await Promise.allSettled(clients.map((client) => client.query("ROLLBACK")));
      await Promise.allSettled(clients.map((client) => client.end()));
    }
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT count(*)::integer AS total FROM ${table("workspace_memberships")} WHERE tenant_id=$1 AND user_id=$2 AND status='active'`, [workspace, bob.id])).rows[0].total).toBe(1);
    expect((await owner.query(`SELECT count(*)::integer AS total FROM ${table("notifications")} WHERE tenant_id=$1`, [workspace])).rows[0].total).toBe(1);
  });
  it("protects the last owner", async () => {
    const alice = await account("Sole Owner"), bob = await account("Promoted"), carol = await account("Admin C"), dave = await account("Admin D");
    const eve = await account("Member E"), frank = await account("Member F"), stranger = await account("Outsider");
    const workspace = (await createWorkspace(alice, "Owner Co")).workspace_id!;
    for (const [who, role] of [[bob, "member"], [carol, "admin"], [dave, "admin"], [eve, "member"], [frank, "member"]] as const) await addMember(workspace, who, role);
    const setRole = (who: Account, target: string, role: string) => outcome(who, "ws_set_member_role($1,$2,$3)", [workspace, target, role]);
    const remove = (who: Account, target: string) => outcome(who, "ws_remove_member($1,$2)", [workspace, target]);
    const membershipId = async (who: Account) => {
      await owner.query("SET ROLE spark_owner");
      return (await owner.query(`SELECT id FROM ${table("workspace_memberships")} WHERE tenant_id=$1 AND user_id=$2`, [workspace, who.id])).rows[0].id as string;
    };

    expect(await setRole(alice, alice.id, "admin")).toBe("last_owner");
    expect(await remove(alice, alice.id)).toBe("last_owner");
    expect(await setRole(carol, eve.id, "admin")).toBe("forbidden");
    expect(await setRole(stranger, eve.id, "admin")).toBe("not_found");
    expect(await setRole(alice, stranger.id, "admin")).toBe("not_found");
    await expect(setRole(alice, eve.id, "boss")).rejects.toMatchObject({ code: "22023", message: "Invalid member role" });
    expect(await setRole(alice, bob.id, "owner")).toBe("ok");
    expect(await setRole(alice, alice.id, "admin")).toBe("ok");
    expect((await auditRows(await membershipId(bob))).map((row) => [row.action, row.metadata.from, row.metadata.to])).toEqual([["member.role_changed", "member", "owner"]]);
    expect(await setRole(bob, bob.id, "member")).toBe("last_owner");

    expect(await remove(carol, dave.id)).toBe("forbidden");
    expect(await remove(carol, bob.id)).toBe("forbidden");
    expect(await remove(eve, frank.id)).toBe("forbidden");
    expect(await remove(stranger, eve.id)).toBe("not_found");
    expect(await remove(carol, stranger.id)).toBe("not_found");
    expect(await remove(carol, eve.id)).toBe("ok");
    expect(await remove(carol, eve.id)).toBe("not_found");
    expect(await remove(frank, frank.id)).toBe("ok");
    expect(await remove(bob, alice.id)).toBe("ok");
    expect((await auditRows(await membershipId(eve))).map((row) => [row.action, row.actor_user_id])).toEqual([["member.removed", carol.id]]);
    expect((await auditRows(await membershipId(frank))).map((row) => [row.action, row.actor_user_id])).toEqual([["member.left", frank.id]]);
    expect((await owner.query(`SELECT status,left_at IS NOT NULL AS left FROM ${table("workspace_memberships")} WHERE tenant_id=$1 AND user_id=$2`, [workspace, frank.id])).rows[0]).toEqual({ status: "left", left: true });
    // Removed members see nothing of the workspace any more, not even its member list.
    expect((await asSession(eve.token, `SELECT id FROM ${table("workspaces")} WHERE id=$1`, [workspace])).rows).toEqual([]);
    expect((await asSession(alice.token, `SELECT * FROM ${fn("ws_list_members")}($1)`, [workspace])).rows).toEqual([]);
    expect(await remove(alice, bob.id)).toBe("not_found");
  });
  it("lets an owner leave while another owner remains", async () => {
    const alice = await account("Co-owner A"), bob = await account("Co-owner B");
    const workspace = (await createWorkspace(alice, "Co-owned")).workspace_id!;
    await addMember(workspace, bob, "owner");
    expect(await outcome(alice, "ws_remove_member($1,$2)", [workspace, alice.id])).toBe("ok");
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT user_id,status FROM ${table("workspace_memberships")} WHERE tenant_id=$1 AND role='owner' ORDER BY status`, [workspace])).rows)
      .toEqual([{ user_id: bob.id, status: "active" }, { user_id: alice.id, status: "left" }]);
    expect(await outcome(bob, "ws_remove_member($1,$2)", [workspace, bob.id])).toBe("last_owner");
  });
  it("skips the accepted notification when the inviter has left", async () => {
    const alice = await account("Stay Owner"), dave = await account("Leaving Admin"), bobEmail = `late.${randomUUID()}@example.com`, bob = await account("Late Bob", bobEmail);
    const workspace = (await createWorkspace(alice, "Left Co")).workspace_id!;
    await addMember(workspace, dave, "admin");
    const { invitation, token } = await inviteWithToken(dave, workspace, bobEmail);
    expect(await outcome(dave, "ws_remove_member($1,$2)", [workspace, dave.id])).toBe("ok");
    expect((await accept(bob, token)).outcome).toBe("ok");
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT count(*)::integer AS total FROM ${table("notifications")} WHERE tenant_id=$1`, [workspace])).rows[0].total).toBe(0);
    expect((await owner.query(`SELECT count(*)::integer AS total FROM ${table("outbox_events")} WHERE aggregate_id=$1 AND event_type='invitation.accepted'`, [invitation])).rows[0].total).toBe(1);
    expect((await auditRows(invitation)).map((row) => row.action)).toEqual(["invitation.created", "invitation.accepted"]);
  });
  it("caps pending invitations per workspace", async () => {
    const alice = await account("Busy Owner");
    const workspace = (await createWorkspace(alice, "Busy Co")).workspace_id!;
    const first = await invite(alice, workspace, `cap.0.${randomUUID()}@example.com`);
    expect(first.outcome).toBe("ok");
    // Exactly one invitation.created event per created invitation.
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT event_type FROM ${table("outbox_events")} WHERE aggregate_id=$1`, [first.invitation_id])).rows).toEqual([{ event_type: "invitation.created" }]);
    for (let index = 1; index < 100; index++) expect((await invite(alice, workspace, `cap.${index}.${randomUUID()}@example.com`)).outcome).toBe("ok");
    expect(await invite(alice, workspace, `cap.over.${randomUUID()}@example.com`)).toEqual({ outcome: "too_many_invitations", invitation_id: null });
    // Pending invitations past their expiry no longer count.
    await owner.query("SET ROLE spark_owner");
    await owner.query(`UPDATE ${table("workspace_invitations")} SET expires_at=created_at+interval '1 millisecond' WHERE id=$1`, [first.invitation_id]);
    expect((await invite(alice, workspace, `cap.again.${randomUUID()}@example.com`)).outcome).toBe("ok");
  });
  it("hides platform-suspended and deleted coworkers", async () => {
    const alice = await account("Viewer"), bob = await account("Coworker B");
    const workspace = (await createWorkspace(alice, "Coworker Co")).workspace_id!;
    await addMember(workspace, bob, "member");
    const readable = async () => (await asSession(alice.token, `SELECT id FROM ${table("users")}`)).rows.map((row) => row.id).sort();
    expect(await readable()).toEqual([alice.id, bob.id].sort());
    try {
      await owner.query(`UPDATE ${table("users")} SET status='suspended' WHERE id=$1`, [bob.id]);
      expect(await readable()).toEqual([alice.id]);
      await owner.query(`UPDATE ${table("users")} SET status='active',deleted_at=now() WHERE id=$1`, [bob.id]);
      expect(await readable()).toEqual([alice.id]);
      expect((await asSession(alice.token, `SELECT ${fn("is_coworker")}($1) AS visible`, [bob.id])).rows[0].visible).toBe(false);
    } finally {
      await owner.query(`UPDATE ${table("users")} SET status='active',deleted_at=NULL WHERE id=$1`, [bob.id]);
    }
    expect(await readable()).toEqual([alice.id, bob.id].sort());
  });
  it("gives revoked and expired sessions no workspace rows", async () => {
    const revoked = newTokenHash(), expired = newTokenHash();
    await owner.query("SET ROLE spark_owner");
    await owner.query(`INSERT INTO ${table("sessions")} (user_id,token_hash,auth_method,expires_at,revoked_at) VALUES ($1,$2,'password',$3,now())`, [userA, revoked, future()]);
    await owner.query(`INSERT INTO ${table("sessions")} (user_id,token_hash,auth_method,created_at,expires_at) VALUES ($1,$2,'password',now()-interval '2 hours',now()-interval '1 hour')`, [userA, expired]);
    expect((await asSession(sessionA, `SELECT id FROM ${table("workspaces")} WHERE id=$1`, [tenantA])).rows).toHaveLength(1);
    for (const token of [revoked, expired]) {
      expect((await asSession(token, `SELECT id FROM ${table("workspaces")}`)).rows).toEqual([]);
      expect((await asSession(token, `SELECT id FROM ${table("projects")}`)).rows).toEqual([]);
      expect((await asSession(token, `SELECT id FROM ${table("workspace_memberships")}`)).rows).toEqual([]);
    }
  });
  it("keeps an exact inventory of workspace and community row policies", async () => {
    const tenantTables = ["startup_profiles","teams","team_memberships","projects","boards","issue_statuses","workflow_transitions","sprints","issues","issue_labels","issue_label_links","issue_comments","issue_links","issue_events","calendar_events","event_attendees","project_phases","project_milestones","sprint_commitments","project_methodology_periods"];
    const ownerPolicy = ["owner_maintenance", "ALL", ["spark_owner"], "PERMISSIVE"];
    const appRead = (name: string) => [name, "SELECT", ["spark_app"], "PERMISSIVE"];
    const expected: Record<string, unknown[][]> = {
      users: [ownerPolicy, appRead("self_and_coworker_read"), appRead("staff_read")],
      workspaces: [ownerPolicy, appRead("workspace_read")],
      workspace_memberships: [ownerPolicy, appRead("staff_read"), appRead("workspace_members_read")],
      workspace_invitations: [appRead("invitation_admin_read"), ownerPolicy],
      notifications: [ownerPolicy, appRead("recipient_read")],
      communities: [appRead("community_read"), ownerPolicy, appRead("staff_read")],
      community_memberships: [appRead("community_members_read"), ownerPolicy, appRead("staff_read")],
      community_topics: [appRead("community_topics_read"), ownerPolicy],
      community_join_requests: [appRead("join_requests_read"), ownerPolicy],
      topics: [ownerPolicy, appRead("topics_read")],
      posts: [ownerPolicy, appRead("post_read")],
      post_comments: [appRead("comment_read"), ownerPolicy],
      ...Object.fromEntries(tenantTables.map((name) => [name, [ownerPolicy, appRead("workspace_read")]])),
    };
    const policies = await owner.query(`SELECT tablename,policyname,cmd,roles::text[] AS roles,permissive FROM pg_policies WHERE schemaname=$1 AND tablename = ANY($2::text[]) ORDER BY tablename,policyname`, [namespace, Object.keys(expected)]);
    const actual: Record<string, unknown[][]> = {};
    for (const row of policies.rows) (actual[row.tablename] ??= []).push([row.policyname, row.cmd, row.roles, row.permissive]);
    expect(actual).toEqual(expected);
  });
  it("confines the worker role to the worker functions", async () => {
    const workerRole = await owner.query(`SELECT rolsuper,rolbypassrls,rolinherit,rolcanlogin,rolcreaterole,rolcreatedb,
      (SELECT count(*)::integer FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS memberships,
      has_database_privilege('spark_worker',current_database(),'TEMPORARY') AS temp, has_schema_privilege('spark_worker',$1,'CREATE') AS create_in_schema
      FROM pg_roles r WHERE rolname='spark_worker'`, [namespace]);
    expect(workerRole.rows).toEqual([{ rolsuper: false, rolbypassrls: false, rolinherit: false, rolcanlogin: true, rolcreaterole: false, rolcreatedb: false, memberships: 0, temp: false, create_in_schema: false }]);
    const workerTables = await owner.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind IN ('r','v','m') AND (has_table_privilege('spark_worker',c.oid,'SELECT') OR has_table_privilege('spark_worker',c.oid,'INSERT')
        OR has_table_privilege('spark_worker',c.oid,'UPDATE') OR has_table_privilege('spark_worker',c.oid,'DELETE'))`, [namespace]);
    expect(workerTables.rows).toEqual([]);
    const workerFunctions = await owner.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=$1 AND has_function_privilege('spark_worker',p.oid,'EXECUTE') ORDER BY p.proname`, [namespace]);
    const expected = ["worker_claim_outbox", "worker_complete_outbox", "worker_fail_outbox", "worker_invitation_email", "worker_issue_invitation_token",
      "worker_record_email_delivery", "worker_task_assigned_email"];
    expected.push("worker_claim_scheduled_emails", "worker_due_reminder_email", "worker_settle_scheduled_email", "worker_weekly_digest_email");
    expected.sort();
    expect(workerFunctions.rows.map((row) => row.proname)).toEqual(expected);
    for (const role of ["spark_app", "spark_auth"]) {
      const reachable = await owner.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=$1 AND p.proname = ANY($3::text[]) AND has_function_privilege($2,p.oid,'EXECUTE')`, [namespace, role, expected]);
      expect({ role, reachable: reachable.rows }).toEqual({ role, reachable: [] });
    }
    for (const name of ["users", "outbox_events", "workspace_invitations", "sessions"]) {
      await expect(workerRuntime.query(`SELECT 1 FROM ${table(name)} LIMIT 1`)).rejects.toMatchObject({ code: "42501" });
    }
    await expect(runtime.query(`SELECT * FROM ${fn("worker_claim_outbox")}($1,1,60)`, [randomUUID()])).rejects.toMatchObject({ code: "42501" });
    await expect(runtime.query(`SELECT ${fn("worker_issue_invitation_token")}($1,$2)`, [randomUUID(), newTokenHash()])).rejects.toMatchObject({ code: "42501" });
    await expect(authRuntime.query(`SELECT * FROM ${fn("worker_invitation_email")}($1)`, [randomUUID()])).rejects.toMatchObject({ code: "42501" });
    await expect(workerRuntime.query(`SELECT * FROM ${fn("ws_invitation_preview")}($1)`, [newTokenHash()])).rejects.toMatchObject({ code: "42501" });
    await expect(workerRuntime.query(`SELECT * FROM ${fn("auth_password_login")}($1)`, ["a@example.com"])).rejects.toMatchObject({ code: "42501" });
  });
  // Worker tests seed rows a year in the past so they are claimed before any other pending event.
  async function seedOutbox(count: number, attempts = 0) {
    await owner.query("SET ROLE spark_owner");
    const rows = await owner.query(`INSERT INTO ${table("outbox_events")} (tenant_id,event_type,aggregate_type,aggregate_id,aggregate_version,payload,available_at,attempts)
      SELECT $1,'test.event','test',gen_random_uuid(),1,'{}',now()-interval '1 year'+make_interval(secs => g),$3 FROM generate_series(1,$2::integer) g RETURNING id`, [tenantA, count, attempts]);
    return rows.rows.map((row) => row.id as string);
  }
  const claim = (db: pg.Pool | pg.Client, lock: string, limit: number, lease = 600) =>
    db.query(`SELECT * FROM ${fn("worker_claim_outbox")}($1,$2,$3)`, [lock, limit, lease]).then((r) => r.rows);
  const complete = (id: string, lock: string) =>
    workerRuntime.query(`SELECT ${fn("worker_complete_outbox")}($1,$2) AS done`, [id, lock]).then((r) => r.rows[0].done as boolean);
  const fail = (id: string, lock: string, code: string, retryAt: Date) =>
    workerRuntime.query(`SELECT ${fn("worker_fail_outbox")}($1,$2,$3,$4) AS done`, [id, lock, code, retryAt]).then((r) => r.rows[0].done as boolean);
  const outboxRow = async (id: string) => {
    await owner.query("SET ROLE spark_owner");
    return (await owner.query(`SELECT attempts,lock_token,locked_until,processed_at,last_error_code,available_at FROM ${table("outbox_events")} WHERE id=$1`, [id])).rows[0];
  };
  it("claims each outbox row once across concurrent workers", async () => {
    const seeded = await seedOutbox(6);
    const clients = [0, 1].map(() => new pg.Client({ connectionString: localConnection("WORKER_DATABASE_URL"), connectionTimeoutMillis: 5000 }));
    await Promise.all(clients.map((client) => client.connect()));
    const locks = [randomUUID(), randomUUID()];
    let claimed: Array<Array<{ id: string; attempts: number; event_type: string }>>;
    try {
      await Promise.all(clients.map((client) => client.query("BEGIN")));
      // The first transaction still holds its row locks while the second claims.
      const first = await claim(clients[0]!, locks[0]!, 3);
      const second = await claim(clients[1]!, locks[1]!, 3);
      await Promise.all(clients.map((client) => client.query("COMMIT")));
      claimed = [first, second];
    } finally {
      await Promise.allSettled(clients.map((client) => client.end()));
    }
    const ids = claimed.flat().map((row) => row.id);
    expect(new Set(ids).size).toBe(6);
    expect([...ids].sort()).toEqual([...seeded].sort());
    expect(claimed.flat().every((row) => row.attempts === 1 && row.event_type === "test.event")).toBe(true);
    const leased = claimed[0]![0]!.id;
    expect((await outboxRow(leased)).lock_token).toBe(locks[0]);
    expect(await complete(leased, locks[1]!)).toBe(false);
    expect(await complete(leased, locks[0]!)).toBe(true);
    expect(await outboxRow(leased)).toMatchObject({ lock_token: null, locked_until: null, attempts: 1 });
    expect((await outboxRow(leased)).processed_at).not.toBeNull();
    expect(await complete(leased, locks[0]!)).toBe(false);
    for (const [index, rows] of claimed.entries()) for (const row of rows) if (row.id !== leased) expect(await complete(row.id, locks[index]!)).toBe(true);
    for (const [limit, lease] of [[0, 60], [101, 60], [1, 9], [1, 601]] as const) {
      await expect(claim(workerRuntime, randomUUID(), limit, lease)).rejects.toMatchObject({ code: "22023" });
    }
  });
  it("retries failed deliveries and dead-letters after eight attempts", async () => {
    const [fresh] = await seedOutbox(1), [worn] = await seedOutbox(1, 7);
    const lock = randomUUID();
    const rows = await claim(workerRuntime, lock, 2);
    expect(rows.map((row) => row.id).sort()).toEqual([fresh, worn].sort());
    const retryAt = new Date(Date.now() + 60 * 60 * 1000);
    expect(await fail(fresh!, randomUUID(), "smtp_error", retryAt)).toBe(false);
    await expect(fail(fresh!, lock, "x".repeat(65), retryAt)).rejects.toMatchObject({ code: "22023" });
    expect(await fail(fresh!, lock, "smtp_error", retryAt)).toBe(true);
    expect(await outboxRow(fresh!)).toMatchObject({ attempts: 1, lock_token: null, locked_until: null, processed_at: null, last_error_code: "smtp_error", available_at: retryAt });
    expect(await complete(fresh!, lock)).toBe(false);
    expect(await fail(worn!, lock, "template_error", retryAt)).toBe(true);
    const dead = await outboxRow(worn!);
    expect(dead).toMatchObject({ attempts: 8, lock_token: null, last_error_code: "template_error" });
    expect(dead.processed_at).not.toBeNull();
    // Retire the retry row so later claims do not see it.
    await owner.query(`UPDATE ${table("outbox_events")} SET processed_at=now() WHERE id=$1`, [fresh]);
  });
  it("reads invitation emails and issues tokens only for pending invitations", async () => {
    const alice = await account("Mail Owner"), email = `mail.${randomUUID()}@example.com`;
    const workspace = (await createWorkspace(alice, "Mail Co")).workspace_id!;
    const invitation = (await invite(alice, workspace, email, "member")).invitation_id!;
    const view = async (id: string) => (await workerRuntime.query(`SELECT * FROM ${fn("worker_invitation_email")}($1)`, [id])).rows;
    expect(await view(invitation)).toEqual([{ status: "pending", email, workspace_name: "Mail Co", inviter_name: "Mail Owner", role: "member", expires_at: expect.any(Date) }]);
    expect(await view(randomUUID())).toEqual([]);
    await expect(workerRuntime.query(`SELECT ${fn("worker_issue_invitation_token")}($1,$2)`, [invitation, randomBytes(16)])).rejects.toMatchObject({ code: "22023" });
    expect((await workerRuntime.query(`SELECT ${fn("worker_issue_invitation_token")}($1,$2) AS issued`, [randomUUID(), newTokenHash()])).rows[0].issued).toBe(false);
    const token = (await issueToken(invitation))!;
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT token_hash FROM ${table("workspace_invitations")} WHERE id=$1`, [invitation])).rows[0].token_hash).toEqual(token);
    expect(await outcome(alice, "ws_revoke_invitation($1)", [invitation])).toBe("ok");
    expect(await issueToken(invitation)).toBeNull();
    expect((await view(invitation))[0].status).toBe("revoked");
    await owner.query("SET ROLE spark_owner");
    await owner.query(`UPDATE ${table("workspaces")} SET archived_at=now(),version=version+1 WHERE id=$1`, [workspace]);
    expect((await view(invitation))[0].status).toBe("unavailable");
  });
  it("lets the worker update stale issue outbox rows", async () => {
    await rollback(async () => {
      const issue = randomUUID();
      await owner.query(`INSERT INTO ${table("issues")} (id,tenant_id,project_id,number,title,status_id,reporter_user_id) VALUES ($1,$2,$3,399,'Moving',$4,$5)`, [issue, tenantB, projectB, statusB, userB]);
      await owner.query(`INSERT INTO ${table("issue_events")} (tenant_id,project_id,issue_id,actor_user_id,event_type,from_version,to_version,changes) VALUES ($1,$2,$3,$4,'created',0,1,'{}')`, [tenantB, projectB, issue, userB]);
      await owner.query(`INSERT INTO ${table("outbox_events")} (tenant_id,event_type,aggregate_type,aggregate_id,aggregate_version,payload) VALUES ($1,'issue.created','issue',$2,1,'{}')`, [tenantB, issue]);
      await owner.query("SET CONSTRAINTS ALL IMMEDIATE"); await owner.query("SET CONSTRAINTS ALL DEFERRED");
      await owner.query(`UPDATE ${table("issues")} SET title='Moved',version=2 WHERE id=$1`, [issue]);
      await owner.query(`INSERT INTO ${table("issue_events")} (tenant_id,project_id,issue_id,actor_user_id,event_type,from_version,to_version,changes) VALUES ($1,$2,$3,$4,'updated',1,2,'{}')`, [tenantB, projectB, issue, userB]);
      await owner.query(`INSERT INTO ${table("outbox_events")} (tenant_id,event_type,aggregate_type,aggregate_id,aggregate_version,payload) VALUES ($1,'issue.updated','issue',$2,2,'{}')`, [tenantB, issue]);
      await owner.query("SET CONSTRAINTS ALL IMMEDIATE"); await owner.query("SET CONSTRAINTS ALL DEFERRED");
      // Lease and delivery bookkeeping on the version-1 event must not trip the issue change-set check.
      await owner.query(`UPDATE ${table("outbox_events")} SET attempts=attempts+1,locked_until=now()+interval '1 minute',lock_token=gen_random_uuid() WHERE aggregate_id=$1 AND aggregate_version=1`, [issue]);
      await owner.query(`UPDATE ${table("outbox_events")} SET locked_until=NULL,lock_token=NULL,processed_at=now() WHERE aggregate_id=$1 AND aggregate_version=1`, [issue]);
      await owner.query("SET CONSTRAINTS ALL IMMEDIATE");
      await expect(owner.query(`UPDATE ${table("outbox_events")} SET aggregate_version=3 WHERE aggregate_id=$1 AND aggregate_version=1`, [issue])).rejects.toMatchObject({ code: "23514" });
    });
  });
  it("seeds methodology defaults on existing projects", async () => {
    await owner.query("SET ROLE spark_owner");
    // projectA, projectB and projectOther were created before 0017 ran.
    const projects = await owner.query(`SELECT id,methodology,settings_version,sprint_length_days,start_date,target_date,baselined_at FROM ${table("projects")} WHERE id = ANY($1::uuid[]) ORDER BY id`, [[projectA, projectB, projectOther]]);
    expect(projects.rows).toEqual([projectA, projectB, projectOther].sort().map((id) => ({ id, methodology: "kanban", settings_version: 1, sprint_length_days: null, start_date: null, target_date: null, baselined_at: null })));
    for (const [project, tenant, creator] of [[projectA, tenantA, userA], [projectB, tenantB, userB], [projectOther, tenantA, userA]]) {
      const periods = await owner.query(`SELECT tenant_id,methodology,ended_at,changed_by_user_id,reason FROM ${table("project_methodology_periods")} WHERE project_id=$1`, [project]);
      expect(periods.rows).toEqual([{ tenant_id: tenant, methodology: "kanban", ended_at: null, changed_by_user_id: creator, reason: "Backfilled at migration 0017" }]);
    }
  });
  it("isolates the new project tables by session", async () => {
    const alice = await account("Phase Owner A"), bob = await account("Phase Owner B");
    const fixtures = [await projectFixture(alice), await projectFixture(bob)];
    for (const [fixture, who] of [[fixtures[0], alice], [fixtures[1], bob]] as const) {
      await owner.query("SET ROLE spark_owner");
      await owner.query("BEGIN");
      try {
        const phase = (await owner.query(`INSERT INTO ${table("project_phases")} (tenant_id,project_id,name,position,planned_start,planned_end) VALUES ($1,$2,'Design',1,'2026-11-01','2026-11-30') RETURNING id`, [fixture.workspace, fixture.project])).rows[0].id;
        await owner.query(`INSERT INTO ${table("project_milestones")} (tenant_id,project_id,phase_id,name,due_date) VALUES ($1,$2,$3,'Design sign-off','2026-11-30')`, [fixture.workspace, fixture.project, phase]);
        const sprint = (await owner.query(`INSERT INTO ${table("sprints")} (tenant_id,project_id,name) VALUES ($1,$2,'Sprint 1') RETURNING id`, [fixture.workspace, fixture.project])).rows[0].id;
        const issue = await insertIssue(fixture, who.id, 1);
        await owner.query(`INSERT INTO ${table("sprint_commitments")} (tenant_id,sprint_id,issue_id,story_points) VALUES ($1,$2,$3,3)`, [fixture.workspace, sprint, issue]);
        await owner.query("COMMIT");
      } catch (error) { await owner.query("ROLLBACK"); throw error; }
    }
    for (const name of ["project_phases", "project_milestones", "sprint_commitments", "project_methodology_periods"]) {
      const tenants = async (token: Buffer | null) => [...new Set((await asSession(token, `SELECT tenant_id FROM ${table(name)}`)).rows.map((row) => row.tenant_id))];
      expect({ name, tenants: await tenants(alice.token) }).toEqual({ name, tenants: [fixtures[0].workspace] });
      expect({ name, tenants: await tenants(bob.token) }).toEqual({ name, tenants: [fixtures[1].workspace] });
      expect({ name, tenants: await tenants(null) }).toEqual({ name, tenants: [] });
      expect({ name, tenants: await tenants(newTokenHash()) }).toEqual({ name, tenants: [] });
    }
    await expect(asSession(alice.token, `INSERT INTO ${table("project_phases")} (tenant_id,project_id,name,position,planned_start,planned_end) VALUES ($1,$2,'Sneaky',2,'2026-12-01','2026-12-02')`, [fixtures[0].workspace, fixtures[0].project])).rejects.toMatchObject({ code: "42501" });
  });
  it("rejects cross-project phase links", async () => {
    const alice = await account("Phase Linker");
    const first = await projectFixture(alice);
    const second = await projectFixture(alice, first.workspace);
    await rollback(async () => {
      const phase = (await owner.query(`INSERT INTO ${table("project_phases")} (tenant_id,project_id,name,position,planned_start,planned_end) VALUES ($1,$2,'Build',1,'2026-11-01','2026-11-30') RETURNING id`, [second.workspace, second.project])).rows[0].id;
      await rejectInside(`INSERT INTO ${table("issues")} (tenant_id,project_id,number,title,status_id,reporter_user_id,phase_id) VALUES ($1,$2,1,'Task',$3,$4,$5)`, [first.workspace, first.project, first.todo, alice.id, phase], "23503");
      await rejectInside(`INSERT INTO ${table("project_milestones")} (tenant_id,project_id,phase_id,name,due_date) VALUES ($1,$2,$3,'Launch','2026-11-30')`, [first.workspace, first.project, phase], "23503");
    });
  });
  it("keeps commitments and periods append-only", async () => {
    const alice = await account("Commitment Owner");
    const fixture = await projectFixture(alice);
    await rollback(async () => {
      const sprint = (await owner.query(`INSERT INTO ${table("sprints")} (tenant_id,project_id,name) VALUES ($1,$2,'Sprint 1') RETURNING id`, [fixture.workspace, fixture.project])).rows[0].id;
      const issue = await insertIssue(fixture, alice.id, 1);
      await owner.query(`INSERT INTO ${table("sprint_commitments")} (tenant_id,sprint_id,issue_id,story_points) VALUES ($1,$2,$3,5)`, [fixture.workspace, sprint, issue]);
      await rejectInside(`UPDATE ${table("sprint_commitments")} SET story_points=8 WHERE sprint_id=$1`, [sprint], "23514");
      await rejectInside(`DELETE FROM ${table("sprint_commitments")} WHERE sprint_id=$1`, [sprint], "23514");
      const periods = table("project_methodology_periods");
      const open = (await owner.query(`SELECT id FROM ${periods} WHERE project_id=$1`, [fixture.project])).rows[0].id;
      await rejectInside(`UPDATE ${periods} SET methodology='scrum' WHERE id=$1`, [open], "23514");
      await rejectInside(`UPDATE ${periods} SET reason='Rewritten' WHERE id=$1`, [open], "23514");
      await rejectInside(`DELETE FROM ${periods} WHERE id=$1`, [open], "23514");
      await rejectInside(`INSERT INTO ${periods} (tenant_id,project_id,methodology,changed_by_user_id,reason) VALUES ($1,$2,'scrum',$3,'Second open period')`, [fixture.workspace, fixture.project, alice.id], "23505");
      await owner.query(`UPDATE ${periods} SET ended_at=clock_timestamp() WHERE id=$1`, [open]);
      await rejectInside(`UPDATE ${periods} SET ended_at=clock_timestamp() WHERE id=$1`, [open], "23514");
      await rejectInside(`UPDATE ${periods} SET ended_at=NULL WHERE id=$1`, [open], "23514");
      await owner.query(`INSERT INTO ${periods} (tenant_id,project_id,methodology,changed_by_user_id,reason,started_at) VALUES ($1,$2,'scrum',$3,'Switched to Scrum',clock_timestamp())`, [fixture.workspace, fixture.project, alice.id]);
      await rejectInside(`INSERT INTO ${periods} (tenant_id,project_id,methodology,changed_by_user_id,reason) VALUES ($1,$2,'waterfall',$3,'Third open period')`, [fixture.workspace, fixture.project, alice.id], "23505");
    });
  });
  it("stamps started_at on first in-progress move", async () => {
    const alice = await account("Starter");
    const fixture = await projectFixture(alice);
    await rollback(async () => {
      const issue = await insertIssue(fixture, alice.id, 1);
      await owner.query("SET CONSTRAINTS ALL IMMEDIATE");
      const startedAt = async () => (await owner.query(`SELECT started_at FROM ${table("issues")} WHERE id=$1`, [issue])).rows[0].started_at as Date | null;
      expect(await startedAt()).toBeNull();
      await moveIssue(fixture, issue, alice.id, fixture.progress, 2);
      const first = await startedAt();
      expect(first).toBeInstanceOf(Date);
      await moveIssue(fixture, issue, alice.id, fixture.todo, 3);
      expect(await startedAt()).toEqual(first);
      await moveIssue(fixture, issue, alice.id, fixture.progress, 4);
      expect(await startedAt()).toEqual(first);
    });
  });
  it("enforces methodology-specific project fields", async () => {
    const projects = table("projects");
    await reject(`UPDATE ${projects} SET sprint_length_days=14 WHERE id=$1`, [projectA], "23514");
    await reject(`UPDATE ${projects} SET methodology='scrum',sprint_length_days=30 WHERE id=$1`, [projectA], "23514");
    await reject(`UPDATE ${projects} SET methodology='scrum',sprint_length_days=6 WHERE id=$1`, [projectA], "23514");
    await reject(`UPDATE ${projects} SET methodology='agile' WHERE id=$1`, [projectA], "23514");
    await reject(`UPDATE ${projects} SET start_date='2026-12-01',target_date='2026-11-01' WHERE id=$1`, [projectA], "23514");
    await reject(`UPDATE ${projects} SET settings_version=0 WHERE id=$1`, [projectA], "23514");
    await rollback(async () => {
      await owner.query(`UPDATE ${projects} SET methodology='scrum',sprint_length_days=14 WHERE id=$1`, [projectA]);
      await owner.query(`UPDATE ${projects} SET methodology='waterfall',sprint_length_days=NULL,start_date='2026-11-01',target_date='2026-11-01',settings_version=settings_version+1 WHERE id=$1`, [projectA]);
    });
  });
  it("validates phase, milestone and sprint metric shapes", async () => {
    const alice = await account("Shape Owner");
    const fixture = await projectFixture(alice);
    const phases = table("project_phases"), milestones = table("project_milestones");
    const insertPhase = `INSERT INTO ${phases} (tenant_id,project_id,name,position,planned_start,planned_end,baseline_start,baseline_end) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;
    const phaseRow = (name: string, position: number, start: string, end: string, baselineStart: string | null = null, baselineEnd: string | null = null) => [fixture.workspace, fixture.project, name, position, start, end, baselineStart, baselineEnd];
    await rollback(async () => {
      await owner.query(insertPhase, phaseRow("Design", 1, "2026-11-01", "2026-11-10", "2026-11-01", "2026-11-10"));
      await rejectInside(insertPhase, phaseRow("Duplicate position", 1, "2026-11-11", "2026-11-20"), "23505");
      await rejectInside(insertPhase, phaseRow("Backwards", 2, "2026-11-20", "2026-11-11"), "23514");
      await rejectInside(insertPhase, phaseRow("Half baseline", 2, "2026-11-11", "2026-11-20", "2026-11-11"), "23514");
      await rejectInside(insertPhase, phaseRow("Zero", 0, "2026-11-11", "2026-11-20"), "23514");
      await rejectInside(insertPhase, phaseRow("   ", 2, "2026-11-11", "2026-11-20"), "23514");
      await rejectInside(insertPhase, phaseRow(" Padded ", 2, "2026-11-11", "2026-11-20"), "23514");
      await rejectInside(insertPhase, phaseRow("x".repeat(61), 2, "2026-11-11", "2026-11-20"), "23514");
      await rejectInside(`UPDATE ${phases} SET status='done' WHERE project_id=$1`, [fixture.project], "23514");
      // maintain_record: every phase and milestone update advances the version by exactly one.
      await rejectInside(`UPDATE ${phases} SET name='Stale' WHERE project_id=$1`, [fixture.project], "23514");
      await owner.query(`UPDATE ${phases} SET name='Design v2',version=version+1 WHERE project_id=$1`, [fixture.project]);
      await owner.query(`INSERT INTO ${milestones} (tenant_id,project_id,name,due_date) VALUES ($1,$2,'Kickoff','2026-11-01')`, [fixture.workspace, fixture.project]);
      await rejectInside(`UPDATE ${milestones} SET name='Stale' WHERE project_id=$1`, [fixture.project], "23514");
      await rejectInside(`INSERT INTO ${milestones} (tenant_id,project_id,name,due_date) VALUES ($1,$2,$3,'2026-11-01')`, [fixture.workspace, fixture.project, "x".repeat(81)], "23514");
      const sprints = table("sprints");
      await rejectInside(`INSERT INTO ${sprints} (tenant_id,project_id,name,committed_points) VALUES ($1,$2,'Negative',-1)`, [fixture.workspace, fixture.project], "23514");
      await rejectInside(`INSERT INTO ${sprints} (tenant_id,project_id,name,completed_count) VALUES ($1,$2,'Negative',-1)`, [fixture.workspace, fixture.project], "23514");
      const sprint = (await owner.query(`INSERT INTO ${sprints} (tenant_id,project_id,name) VALUES ($1,$2,'Sprint') RETURNING id`, [fixture.workspace, fixture.project])).rows[0].id;
      await rejectInside(`UPDATE ${sprints} SET goal='Stale' WHERE id=$1`, [sprint], "23514");
      await owner.query(`UPDATE ${sprints} SET goal='Ship',version=version+1 WHERE id=$1`, [sprint]);
    });
  });
  it("creates projects with their methodology structure", async () => {
    const alice = await account("Project Creator");
    const workspace = (await createWorkspace(alice)).workspace_id!;
    const statusesOf = async (project: string) => (await owner.query(`SELECT name,category,position::integer AS position,wip_limit FROM ${table("issue_statuses")} WHERE project_id=$1 ORDER BY position`, [project])).rows;
    const projectRow = async (project: string) => (await owner.query(`SELECT tenant_id,key,name,description,methodology,lead_user_id,start_date::text AS start_date,target_date::text AS target_date,sprint_length_days,settings_version,baselined_at FROM ${table("projects")} WHERE id=$1`, [project])).rows[0];
    const periodsOf = async (project: string) => (await owner.query(`SELECT methodology,ended_at,changed_by_user_id,reason FROM ${table("project_methodology_periods")} WHERE project_id=$1`, [project])).rows;
    const phasesOf = async (project: string) => (await owner.query(`SELECT name,position,planned_start::text AS planned_start,planned_end::text AS planned_end,baseline_start::text AS baseline_start,baseline_end::text AS baseline_end,status FROM ${table("project_phases")} WHERE project_id=$1 ORDER BY position`, [project])).rows;

    const scrum = await createProject(alice, workspace, { key: "SCRUM", name: "  Sprint team  ", description: "  Ships in sprints  ", methodology: "scrum", lead: alice.id, sprint: 14 });
    expect(scrum).toEqual({ outcome: "ok", project_id: expect.any(String), settings_version: 1 });
    await owner.query("SET ROLE spark_owner");
    expect(await projectRow(scrum.project_id!)).toEqual({ tenant_id: workspace, key: "SCRUM", name: "Sprint team", description: "Ships in sprints", methodology: "scrum", lead_user_id: alice.id, start_date: null, target_date: null, sprint_length_days: 14, settings_version: 1, baselined_at: null });
    expect((await owner.query(`SELECT name FROM ${table("boards")} WHERE project_id=$1`, [scrum.project_id])).rows).toEqual([{ name: "Sprint team" }]);
    expect(await statusesOf(scrum.project_id!)).toEqual(templateStatuses.scrum.map((s, index) => ({ name: s.name, category: s.category, position: 1024 * (index + 1), wip_limit: null })));
    expect(await phasesOf(scrum.project_id!)).toEqual([]);

    const kanban = await createProject(alice, workspace, { key: "FLOW", methodology: "kanban" });
    expect(kanban.outcome).toBe("ok");
    await owner.query("SET ROLE spark_owner");
    expect(await statusesOf(kanban.project_id!)).toEqual([
      { name: "Backlog", category: "backlog", position: 1024, wip_limit: null }, { name: "Ready", category: "todo", position: 2048, wip_limit: 8 },
      { name: "In progress", category: "in_progress", position: 3072, wip_limit: 4 }, { name: "Review", category: "in_progress", position: 4096, wip_limit: 3 },
      { name: "Done", category: "done", position: 5120, wip_limit: null },
    ]);
    expect(await projectRow(kanban.project_id!)).toMatchObject({ methodology: "kanban", sprint_length_days: null, lead_user_id: null, description: null });

    const waterfall = await createProject(alice, workspace, waterfallInput("PLAN"));
    expect(waterfall.outcome).toBe("ok");
    await owner.query("SET ROLE spark_owner");
    const plan = await projectRow(waterfall.project_id!);
    expect(plan).toMatchObject({ methodology: "waterfall", start_date: "2026-11-02", target_date: "2026-12-11", sprint_length_days: null });
    expect(plan.baselined_at).toBeInstanceOf(Date);
    expect((await statusesOf(waterfall.project_id!)).map((row) => row.name)).toEqual(["Not started", "In progress", "In review", "Done"]);
    expect(await phasesOf(waterfall.project_id!)).toEqual(waterfallPhases.map((phase, index) => ({ name: phase.name, position: index + 1, planned_start: phase.plannedStart, planned_end: phase.plannedEnd, baseline_start: phase.plannedStart, baseline_end: phase.plannedEnd, status: "planned" })));
    const milestones = await owner.query(`SELECT m.name,ph.name AS phase,m.due_date::text AS due_date,m.baseline_due_date::text AS baseline_due_date FROM ${table("project_milestones")} m JOIN ${table("project_phases")} ph ON ph.id=m.phase_id WHERE m.project_id=$1 ORDER BY ph.position`, [waterfall.project_id]);
    expect(milestones.rows).toEqual(waterfallPhases.map((phase) => ({ name: `${phase.name} sign-off`, phase: phase.name, due_date: phase.plannedEnd, baseline_due_date: phase.plannedEnd })));
    expect(milestones.rows.map((row) => row.name)).toEqual(["Requirements sign-off", "Design sign-off", "Build sign-off", "Test sign-off", "Deploy sign-off"]);

    for (const [created, methodology, key] of [[scrum, "scrum", "SCRUM"], [kanban, "kanban", "FLOW"], [waterfall, "waterfall", "PLAN"]] as const) {
      expect(await periodsOf(created.project_id!)).toEqual([{ methodology, ended_at: null, changed_by_user_id: alice.id, reason: "Project created" }]);
      expect(await auditRows(created.project_id!)).toEqual([{ action: "project.created", actor_user_id: alice.id, resource_type: "project", metadata: { methodology, key } }]);
    }
    expect((await asSession(alice.token, `SELECT key FROM ${table("projects")} WHERE tenant_id=$1 ORDER BY key`, [workspace])).rows.map((row) => row.key)).toEqual(["FLOW", "PLAN", "SCRUM"]);
  });
  it("guards project creation", async () => {
    const alice = await account("Guard Owner"), bob = await account("Guard Member"), carol = await account("Guard Stranger");
    const workspace = (await createWorkspace(alice)).workspace_id!, other = (await createWorkspace(carol)).workspace_id!;
    await addMember(workspace, bob, "member");
    const refused = (outcome: string) => ({ outcome, project_id: null, settings_version: null });
    expect(await createProject(bob, workspace, { key: "MEMBER", methodology: "kanban" })).toEqual(refused("forbidden"));
    expect(await createProject(carol, workspace, { key: "STRANGE", methodology: "kanban" })).toEqual(refused("not_found"));
    expect(await createProject(alice, randomUUID(), { key: "MISSING", methodology: "kanban" })).toEqual(refused("not_found"));
    expect((await createProject(alice, workspace, { key: "CORE", methodology: "kanban" })).outcome).toBe("ok");
    expect(await createProject(alice, workspace, { key: "CORE", methodology: "scrum", sprint: 14 })).toEqual(refused("key_taken"));
    expect((await createProject(carol, other, { key: "CORE", methodology: "kanban" })).outcome).toBe("ok");
    expect(await createProject(alice, workspace, { key: "LEAD", methodology: "kanban", lead: carol.id })).toEqual(refused("invalid_lead"));
    expect(await createProject(alice, workspace, { key: "LEAD", methodology: "kanban", lead: randomUUID() })).toEqual(refused("invalid_lead"));
    expect((await createProject(alice, workspace, { key: "LEAD", methodology: "kanban", lead: bob.id })).outcome).toBe("ok");

    const rejects = async (input: ProjectInput, message: string) =>
      expect(createProject(alice, workspace, input)).rejects.toMatchObject({ code: "22023", message });
    for (const key of ["ab", "A", "1ABC", "ABCDEFGHIJK", "AB-C", " ABC"]) await rejects({ key, methodology: "kanban" }, "Invalid project key");
    for (const name of ["   ", "x".repeat(81)]) await rejects({ key: "NAME", name, methodology: "kanban" }, "Invalid project name");
    await rejects({ key: "DESC", description: "x".repeat(2001), methodology: "kanban" }, "Invalid project description");
    await rejects({ key: "AGILE", methodology: "agile" }, "Invalid methodology");
    await rejects({ ...waterfallInput("NODATE"), start: null, target: null }, "Invalid project dates");
    await rejects({ ...waterfallInput("NOEND"), target: null }, "Invalid project dates");
    await rejects({ key: "BACK", methodology: "kanban", start: "2026-12-01", target: "2026-11-01" }, "Invalid project dates");
    await rejects({ key: "SPRINT", methodology: "scrum", sprint: 6 }, "Invalid sprint length");
    await rejects({ key: "SPRINT", methodology: "scrum", sprint: 29 }, "Invalid sprint length");
    await rejects({ key: "SPRINT", methodology: "kanban", sprint: 14 }, "Invalid sprint length");
    const done = status("Done", "done"), todo = status("To do", "todo");
    for (const statuses of [
      [todo, status("Doing", "in_progress")], [done, status("Shipped", "done")], [done], Array.from({ length: 13 }, (_, i) => status(`S${i}`, i ? "todo" : "done")),
      [todo, status(" to DO ", "in_progress"), done], [todo, status("   ", "todo"), done], [todo, status("x".repeat(41), "todo"), done],
      [todo, status("Odd", "blocked"), done], [todo, status("Zero", "todo", 0), done], [todo, status("Many", "todo", 100), done], [todo, status("Half", "todo", 1.5), done],
      [todo, { ...done, extra: true }], [todo, "Done"], { todo, done }, null,
    ]) await rejects({ key: "STATUS", methodology: "kanban", statuses }, "Invalid project statuses");
    const phase = (name: string, plannedStart: string, plannedEnd: string) => ({ name, plannedStart, plannedEnd });
    await rejects({ key: "PHASE", methodology: "kanban", phases: [phase("Build", "2026-11-02", "2026-11-09")] }, "Invalid project phases");
    for (const phases of [
      [], Array.from({ length: 13 }, (_, i) => phase(`P${i}`, `2026-11-${String(i + 2).padStart(2, "0")}`, `2026-11-${String(i + 2).padStart(2, "0")}`)),
      [phase("Early", "2026-11-01", "2026-11-09")], [phase("Late", "2026-12-01", "2026-12-12")], [phase("Backwards", "2026-11-09", "2026-11-02")],
      [phase("First", "2026-11-02", "2026-11-10"), phase("Overlap", "2026-11-10", "2026-11-20")],
      [phase("Second", "2026-11-11", "2026-11-20"), phase("First", "2026-11-02", "2026-11-10")],
      [phase("   ", "2026-11-02", "2026-11-09")], [phase("x".repeat(61), "2026-11-02", "2026-11-09")],
      [phase("Bad date", "2026-11-31", "2026-12-01")], [phase("Words", "today", "2026-12-01")], [{ ...phase("Extra", "2026-11-02", "2026-11-09"), owner: "me" }],
    ]) await rejects({ ...waterfallInput("PHASE"), phases }, "Invalid project phases");
    await expect(createProject(null, workspace, { key: "ANON", methodology: "kanban" })).rejects.toMatchObject({ code: "28000" });
    await expect(asSession(newTokenHash(), createProjectCall, projectArgs(workspace, { key: "ANON", methodology: "kanban" }))).rejects.toMatchObject({ code: "28000" });

    // The cap counts the workspace's non-archived projects only.
    const busy = (await createWorkspace(alice)).workspace_id!;
    await owner.query("SET ROLE spark_owner");
    await owner.query(`INSERT INTO ${table("projects")} (tenant_id,key,name) SELECT $1,'BULK'||g,'Bulk' FROM generate_series(1,50) g`, [busy]);
    expect(await createProject(alice, busy, { key: "EXTRA", methodology: "kanban" })).toEqual(refused("too_many_projects"));
    await owner.query("SET ROLE spark_owner");
    await owner.query(`UPDATE ${table("projects")} SET archived_at=now() WHERE tenant_id=$1 AND key='BULK1'`, [busy]);
    expect((await createProject(alice, busy, { key: "EXTRA", methodology: "kanban" })).outcome).toBe("ok");
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT count(*)::integer AS count FROM ${table("projects")} WHERE tenant_id=$1 AND key IN ('MEMBER','STRANGE','NAME','STATUS','PHASE','ANON')`, [workspace])).rows[0].count).toBe(0);
  });
  it("updates project settings with optimistic version", async () => {
    const alice = await account("Settings Owner"), bob = await account("Settings Lead"), carol = await account("Settings Member"), dave = await account("Settings Stranger");
    const workspace = (await createWorkspace(alice)).workspace_id!;
    await addMember(workspace, bob, "member");
    await addMember(workspace, carol, "member");
    const project = (await createProject(alice, workspace, { key: "TEAM", methodology: "scrum", sprint: 14, lead: bob.id })).project_id!;
    expect(await updateProject(bob, project, 1, { name: "  Lead rename  " })).toEqual({ outcome: "ok", settings_version: 2 });
    expect(await updateProject(bob, project, 1, { name: "Stale" })).toEqual({ outcome: "version_mismatch", settings_version: 2 });
    expect(await updateProject(carol, project, 2, { name: "Member rename" })).toEqual({ outcome: "forbidden", settings_version: null });
    expect(await updateProject(dave, project, 2, { name: "Stranger rename" })).toEqual({ outcome: "not_found", settings_version: null });
    expect(await updateProject(alice, randomUUID(), 1, { name: "Missing" })).toEqual({ outcome: "not_found", settings_version: null });
    expect(await updateProject(alice, project, 2, { leadUserId: dave.id })).toEqual({ outcome: "invalid_lead", settings_version: null });
    expect(await updateProject(alice, project, 2, { leadUserId: "not-a-uuid" })).toEqual({ outcome: "invalid_lead", settings_version: null });
    expect(await updateProject(alice, project, 2, { description: "  Ships weekly  ", leadUserId: carol.id, sprintLengthDays: 21, startDate: "2026-11-02", targetDate: null })).toEqual({ outcome: "ok", settings_version: 3 });
    // bob is no longer the lead.
    expect(await updateProject(bob, project, 3, { name: "Former lead" })).toEqual({ outcome: "forbidden", settings_version: null });
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT name,description,lead_user_id,sprint_length_days,start_date::text AS start_date,target_date,settings_version FROM ${table("projects")} WHERE id=$1`, [project])).rows[0])
      .toEqual({ name: "Lead rename", description: "Ships weekly", lead_user_id: carol.id, sprint_length_days: 21, start_date: "2026-11-02", target_date: null, settings_version: 3 });
    expect((await auditRows(project)).filter((row) => row.action === "project.updated")).toEqual([
      { action: "project.updated", actor_user_id: bob.id, resource_type: "project", metadata: { changed: ["name"] } },
      { action: "project.updated", actor_user_id: alice.id, resource_type: "project", metadata: { changed: ["description", "leadUserId", "sprintLengthDays", "startDate", "targetDate"] } },
    ]);
    const rejects = async (target: string, version: number, patch: unknown, message: string) =>
      expect(updateProject(alice, target, version, patch)).rejects.toMatchObject({ code: "22023", message });
    await rejects(project, 3, { methodology: "kanban" }, "Invalid project name");
    await rejects(project, 3, ["name"], "Invalid project name");
    await rejects(project, 3, { name: " " }, "Invalid project name");
    await rejects(project, 3, { name: 42 }, "Invalid project name");
    await rejects(project, 3, { description: "x".repeat(2001) }, "Invalid project description");
    await rejects(project, 3, { startDate: "2026-02-30" }, "Invalid project dates");
    await rejects(project, 3, { targetDate: "2026-11-01" }, "Invalid project dates");
    await rejects(project, 3, { sprintLengthDays: 30 }, "Invalid sprint length");
    await rejects(project, 3, { sprintLengthDays: null }, "Invalid sprint length");

    const plan = (await createProject(alice, workspace, waterfallInput("WATER"))).project_id!;
    await rejects(plan, 1, { targetDate: "2026-12-10" }, "Invalid project dates");
    await rejects(plan, 1, { startDate: "2026-11-03" }, "Invalid project dates");
    await rejects(plan, 1, { targetDate: null }, "Invalid project dates");
    await rejects(plan, 1, { sprintLengthDays: 14 }, "Invalid sprint length");
    expect(await updateProject(alice, plan, 1, { startDate: "2026-11-01", targetDate: "2026-12-20" })).toEqual({ outcome: "ok", settings_version: 2 });

    // Issue number allocation never touches the settings version.
    await owner.query("SET ROLE spark_owner");
    for (let index = 0; index < 5; index++) await owner.query(`UPDATE ${table("projects")} SET next_issue_number=next_issue_number+1 WHERE id=$1`, [plan]);
    expect((await owner.query(`SELECT settings_version,next_issue_number::integer AS next FROM ${table("projects")} WHERE id=$1`, [plan])).rows[0]).toEqual({ settings_version: 2, next: 6 });
  });
  it("creates issues with numbers, positions and history", async () => {
    const alice = await account("Issue Author");
    const { project } = await kanbanProject(alice);
    const first = await createIssue(alice, project, { title: "  First task  ", description: "   " });
    expect(first).toEqual({ outcome: "ok", issue_id: expect.any(String), issue_version: 1 });
    const second = await createIssue(alice, project, { title: "Second task", description: "  Steps  ", type: "bug", priority: "high", points: "3.5", due: "2026-12-01" });
    expect(second).toEqual({ outcome: "ok", issue_id: expect.any(String), issue_version: 1 });
    const backlog = await statusNamed(project, "Backlog");
    const rows = (await owner.query(`SELECT id,number::integer AS number,title,description,type,priority,status_id,position::text AS position,version,reporter_user_id,assignee_user_id,
      story_points::text AS story_points,due_date::text AS due_date,phase_id,started_at,completed_at FROM ${table("issues")} WHERE project_id=$1 ORDER BY number`, [project])).rows;
    const common = { status_id: backlog, version: 1, reporter_user_id: alice.id, assignee_user_id: null, phase_id: null, started_at: null, completed_at: null };
    expect(rows).toEqual([
      { ...common, id: first.issue_id, number: 1, title: "First task", description: null, type: "task", priority: "medium", position: "1024.000000", story_points: null, due_date: null },
      { ...common, id: second.issue_id, number: 2, title: "Second task", description: "Steps", type: "bug", priority: "high", position: "2048.000000", story_points: "3.50", due_date: "2026-12-01" },
    ]);
    for (const issue of [first, second]) {
      const events = (await owner.query(`SELECT event_type,actor_user_id,from_version,to_version,changes FROM ${table("issue_events")} WHERE issue_id=$1`, [issue.issue_id])).rows;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ event_type: "issue.created", actor_user_id: alice.id, from_version: 0, to_version: 1 });
      expect(events[0].changes.after).toEqual({ statusId: backlog, category: "backlog", assigneeUserId: null, storyPoints: issue === first ? null : 3.5, phaseId: null, sprintId: null, archived: false });
      expect(JSON.stringify(events[0].changes)).not.toContain("task");
      const outbox = (await owner.query(`SELECT event_type,aggregate_version,processed_at IS NOT NULL AS processed FROM ${table("outbox_events")} WHERE aggregate_type='issue' AND aggregate_id=$1`, [issue.issue_id])).rows;
      expect(outbox).toEqual([{ event_type: "issue.created", aggregate_version: 1, processed: true }]);
    }
    expect((await owner.query(`SELECT next_issue_number::integer AS next,settings_version FROM ${table("projects")} WHERE id=$1`, [project])).rows[0]).toEqual({ next: 3, settings_version: 1 });
    expect((await asSession(alice.token, `SELECT number::integer AS number FROM ${table("issues")} WHERE project_id=$1 ORDER BY number`, [project])).rows).toEqual([{ number: 1 }, { number: 2 }]);
    const index = await owner.query(`SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename='issue_events' AND indexname='issue_events_tenant_id_project_id_created_at_issue_id_read'`, [namespace]);
    expect(index.rows[0].indexdef).toContain("(tenant_id, project_id, created_at, issue_id)");
  });
  it("notifies the assignee but not a self-assignment", async () => {
    const alice = await account("Assigning Owner"), bob = await account("Assigned Member");
    const { workspace, project, key } = await kanbanProject(alice);
    await addMember(workspace, bob, "member");
    const assigned = await createIssue(alice, project, { title: "Review the deck", assignee: bob.id });
    expect(assigned.outcome).toBe("ok");
    const self = await createIssue(alice, project, { title: "My own task", assignee: alice.id });
    expect(self.outcome).toBe("ok");
    await owner.query("SET ROLE spark_owner");
    const outboxId = (await owner.query(`SELECT id FROM ${table("outbox_events")} WHERE aggregate_type='issue' AND aggregate_id=$1 AND aggregate_version=1`, [assigned.issue_id])).rows[0].id;
    const notices = (await owner.query(`SELECT recipient_user_id,outbox_event_id,kind,title,resource_type,resource_id,read_at FROM ${table("notifications")} WHERE tenant_id=$1`, [workspace])).rows;
    expect(notices).toEqual([{ recipient_user_id: bob.id, outbox_event_id: outboxId, kind: "issue_assigned", title: `Assigning Owner assigned you ${key}-1: Review the deck`,
      resource_type: "issue", resource_id: assigned.issue_id, read_at: null }]);
    expect(notices[0].title.startsWith("Assigning Owner")).toBe(true);
    expect((await owner.query(`SELECT assignee_user_id FROM ${table("issues")} WHERE id=$1`, [self.issue_id])).rows[0].assignee_user_id).toBe(alice.id);
    // A member may create and assign too; a maximum-length title fits the notification in full.
    const long = await createIssue(bob, project, { title: "x".repeat(200), assignee: alice.id });
    expect(long.outcome).toBe("ok");
    await owner.query("SET ROLE spark_owner");
    const longTitle = (await owner.query(`SELECT title FROM ${table("notifications")} WHERE resource_id=$1`, [long.issue_id])).rows[0].title as string;
    expect(longTitle).toBe(`Assigned Member assigned you ${key}-3: ${"x".repeat(200)}`);
  });
  it("guards issue creation", async () => {
    const alice = await account("Issue Guard Owner"), bob = await account("Issue Guard Member"), carol = await account("Issue Guard Stranger");
    const { workspace, project } = await kanbanProject(alice);
    await addMember(workspace, bob, "member");
    const other = await kanbanProject(carol);
    expect(await createIssue(carol, project)).toEqual(refusedIssue("not_found"));
    expect(await createIssue(alice, randomUUID())).toEqual(refusedIssue("not_found"));
    expect(await createIssue(alice, other.project)).toEqual(refusedIssue("not_found"));
    expect(await createIssue(alice, project, { assignee: carol.id })).toEqual(refusedIssue("invalid_assignee"));
    expect(await createIssue(alice, project, { assignee: randomUUID() })).toEqual(refusedIssue("invalid_assignee"));
    expect((await createIssue(bob, project, { title: "Member task" })).outcome).toBe("ok");

    const rejects = async (input: IssueInput, message: string) =>
      expect(createIssue(alice, project, input)).rejects.toMatchObject({ code: "22023", message });
    await rejects({ status: await statusNamed(other.project, "Backlog") }, "Invalid issue status");
    await rejects({ status: randomUUID() }, "Invalid issue status");
    for (const title of ["x".repeat(201), "   ", ""]) await rejects({ title }, "Invalid issue title");
    await rejects({ description: "x".repeat(10001) }, "Invalid issue description");
    for (const type of ["epic", "subtask", "Task"]) await rejects({ type }, "Invalid issue type");
    await rejects({ priority: "urgent" }, "Invalid issue priority");
    for (const points of ["100.001", "-1", "100.01", "0.005"]) await rejects({ points }, "Invalid story points");
    for (const due of ["1999-12-31", "2101-01-01", "infinity"]) await rejects({ due }, "Invalid due date");
    await rejects({ phase: randomUUID() }, "Invalid issue phase");
    await rejects({ key: "bad key", hash: randomBytes(32) }, "Invalid idempotency key");
    await rejects({ key: "x".repeat(101), hash: randomBytes(32) }, "Invalid idempotency key");
    await rejects({ key: "good-key", hash: randomBytes(31) }, "Invalid idempotency key");
    await rejects({ key: "good-key" }, "Invalid idempotency key");
    expect((await createIssue(alice, project, { points: "100", due: "2100-12-31" })).outcome).toBe("ok");
    expect((await createIssue(alice, project, { points: "0", due: "2000-01-01", type: "story", priority: "lowest" })).outcome).toBe("ok");

    // A project without statuses has no board to place the issue on.
    const bare = randomUUID();
    await owner.query("SET ROLE spark_owner");
    await owner.query(`INSERT INTO ${table("projects")} (id,tenant_id,key,name) VALUES ($1,$2,'BARE','Bare')`, [bare, workspace]);
    await owner.query(`INSERT INTO ${table("boards")} (tenant_id,project_id,name) VALUES ($1,$2,'Bare')`, [workspace, bare]);
    expect(await createIssue(alice, bare)).toEqual(refusedIssue("no_board"));

    // WIP: one slot in Ready, then full.
    const ready = await statusNamed(project, "Ready");
    await owner.query(`UPDATE ${table("issue_statuses")} SET wip_limit=1 WHERE id=$1`, [ready]);
    expect((await createIssue(alice, project, { status: ready })).outcome).toBe("ok");
    expect(await createIssue(alice, project, { status: ready })).toEqual(refusedIssue("wip_limit_reached"));

    // Archived projects are invisible.
    const archived = await kanbanProject(alice, workspace);
    await owner.query("SET ROLE spark_owner");
    await owner.query(`UPDATE ${table("projects")} SET archived_at=now() WHERE id=$1`, [archived.project]);
    expect(await createIssue(alice, archived.project)).toEqual(refusedIssue("not_found"));

    await expect(createIssue(null, project)).rejects.toMatchObject({ code: "28000" });
    await expect(asSession(newTokenHash(), createIssueCall, issueArgs(project, {}))).rejects.toMatchObject({ code: "28000" });
    expect(await countRows(`${table("issues")} WHERE project_id=$1`, [project])).toBe(4);
    expect(await countRows(`${table("issues")} WHERE project_id=ANY($1::uuid[])`, [[bare, archived.project, other.project]])).toBe(0);
  });
  it("replays idempotent creates", async () => {
    const alice = await account("Retry Owner"), bob = await account("Retry Member");
    const { workspace, project } = await kanbanProject(alice);
    await addMember(workspace, bob, "member");
    const key = `quick-add:${randomUUID()}`, hash = randomBytes(32);
    const first = await createIssue(alice, project, { title: "Once", key, hash });
    expect(first).toEqual({ outcome: "ok", issue_id: expect.any(String), issue_version: 1 });
    expect(await createIssue(alice, project, { title: "Once", key, hash })).toEqual({ outcome: "replayed", issue_id: first.issue_id, issue_version: 1 });
    expect(await createIssue(alice, project, { title: "Changed", key, hash: randomBytes(32) })).toEqual(refusedIssue("idempotency_conflict"));
    // The same key in another project of the workspace is a conflict, never a replay of a foreign issue.
    const sibling = await kanbanProject(alice, workspace);
    expect(await createIssue(alice, sibling.project, { title: "Once", key, hash })).toEqual(refusedIssue("idempotency_conflict"));
    // Keys are scoped to the actor.
    expect((await createIssue(bob, project, { title: "Once", key, hash })).outcome).toBe("ok");
    expect(await countRows(`${table("issues")} WHERE project_id=$1 AND title='Once'`, [project])).toBe(2);
    const stored = async () => (await owner.query(`SELECT operation,state,resource_id,response_status,request_hash,expires_at > now() + interval '23 hours' AS fresh
      FROM ${table("idempotency_requests")} WHERE actor_user_id=$1 AND key=$2`, [alice.id, key])).rows;
    await owner.query("SET ROLE spark_owner");
    expect(await stored()).toEqual([{ operation: "issue.create", state: "completed", resource_id: first.issue_id, response_status: 201, request_hash: hash, fresh: true }]);

    // An expired row is replaced and creates a new issue.
    await owner.query(`UPDATE ${table("idempotency_requests")} SET expires_at=created_at+interval '1 millisecond' WHERE actor_user_id=$1 AND key=$2`, [alice.id, key]);
    const renewed = await createIssue(alice, project, { title: "Once", key, hash });
    expect(renewed.outcome).toBe("ok");
    expect(renewed.issue_id).not.toBe(first.issue_id);
    await owner.query("SET ROLE spark_owner");
    expect(await stored()).toEqual([{ operation: "issue.create", state: "completed", resource_id: renewed.issue_id, response_status: 201, request_hash: hash, fresh: true }]);

    // A refused create keeps no idempotency row, so a later retry can still succeed.
    const ready = await statusNamed(project, "Ready");
    await owner.query(`UPDATE ${table("issue_statuses")} SET wip_limit=1 WHERE id=$1`, [ready]);
    expect((await createIssue(alice, project, { status: ready })).outcome).toBe("ok");
    const fullKey = `full:${randomUUID()}`;
    expect(await createIssue(alice, project, { status: ready, key: fullKey, hash })).toEqual(refusedIssue("wip_limit_reached"));
    expect(await countRows(`${table("idempotency_requests")} WHERE key=$1`, [fullKey])).toBe(0);
  });
  it("admits WIP concurrently", async () => {
    const alice = await account("WIP Racer A"), bob = await account("WIP Racer B");
    const { workspace, project } = await kanbanProject(alice);
    await addMember(workspace, bob, "member");
    const ready = await statusNamed(project, "Ready");
    await owner.query(`UPDATE ${table("issue_statuses")} SET wip_limit=2 WHERE id=$1`, [ready]);
    expect((await createIssue(alice, project, { status: ready })).outcome).toBe("ok");
    const clients = [0, 1].map(() => new pg.Client({ connectionString: localConnection("DATABASE_URL"), connectionTimeoutMillis: 5000 }));
    await Promise.all(clients.map((client) => client.connect()));
    try {
      const [first, second] = clients as [pg.Client, pg.Client];
      for (const [client, who] of [[first, alice], [second, bob]] as const) {
        await client.query("SET lock_timeout = '15s'");
        await client.query("BEGIN");
        await client.query("SELECT set_config('spark.session_token_hash',$1,true)", [who.token.toString("hex")]);
      }
      const winner = (await first.query(createIssueCall, issueArgs(project, { title: "First in", status: ready }))).rows[0] as IssueResult;
      expect(winner.outcome).toBe("ok");
      const secondPid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
      const competing = second.query(createIssueCall, issueArgs(project, { title: "Second in", status: ready }));
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        blocked = (await owner.query("SELECT count(*)::integer AS waiting FROM pg_locks WHERE pid=$1 AND NOT granted", [secondPid])).rows[0].waiting > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(blocked).toBe(true);
      await first.query("COMMIT");
      expect(((await competing).rows[0] as IssueResult)).toEqual(refusedIssue("wip_limit_reached"));
      await second.query("COMMIT");
    } finally {
      await Promise.allSettled(clients.map((client) => client.query("ROLLBACK")));
      await Promise.allSettled(clients.map((client) => client.end()));
    }
    expect(await countRows(`${table("issues")} WHERE status_id=$1`, [ready])).toBe(2);
  });
  it("rolls back notifications with the transaction", async () => {
    const alice = await account("Rollback Owner"), bob = await account("Rollback Member");
    const { workspace, project } = await kanbanProject(alice);
    await addMember(workspace, bob, "member");
    const client = await runtime.connect();
    let created: IssueResult;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('spark.session_token_hash',$1,true)", [alice.token.toString("hex")]);
      created = (await client.query(createIssueCall, issueArgs(project, { title: "Never kept", assignee: bob.id }))).rows[0] as IssueResult;
      expect(created.outcome).toBe("ok");
      await client.query("ROLLBACK");
    } finally { client.release(); }
    expect(await countRows(`${table("issues")} WHERE id=$1`, [created.issue_id])).toBe(0);
    expect(await countRows(`${table("issue_events")} WHERE issue_id=$1`, [created.issue_id])).toBe(0);
    expect(await countRows(`${table("outbox_events")} WHERE aggregate_id=$1`, [created.issue_id])).toBe(0);
    expect(await countRows(`${table("notifications")} WHERE tenant_id=$1`, [workspace])).toBe(0);
    expect((await owner.query(`SELECT next_issue_number::integer AS next FROM ${table("projects")} WHERE id=$1`, [project])).rows[0].next).toBe(1);
  });
  it("lets recipients read only their notifications", async () => {
    const alice = await account("Notice Owner"), bob = await account("Notice Recipient"), carol = await account("Notice Bystander");
    const { workspace, project } = await kanbanProject(alice);
    await addMember(workspace, bob, "member");
    await addMember(workspace, carol, "member");
    const assigned = await createIssue(alice, project, { title: "Read me", assignee: bob.id });
    expect(assigned.outcome).toBe("ok");
    const read = async (who: Account | null) => (await asSession(who?.token ?? null, `SELECT kind,resource_id FROM ${table("notifications")}`)).rows;
    expect(await read(bob)).toEqual([{ kind: "issue_assigned", resource_id: assigned.issue_id }]);
    expect(await read(carol)).toEqual([]);
    expect(await read(alice)).toEqual([]);
    expect(await read(null)).toEqual([]);
    expect(await outcome(bob, "ws_remove_member($1,$2)", [workspace, bob.id])).toBe("ok");
    expect(await read(bob)).toEqual([]);
  });
  it("clears the project lead when the lead is removed", async () => {
    const alice = await account("Lead Owner"), bob = await account("Lead Member");
    const workspace = (await createWorkspace(alice)).workspace_id!, elsewhere = (await createWorkspace(alice)).workspace_id!;
    await addMember(workspace, bob, "member");
    await addMember(elsewhere, bob, "member");
    const led = (await createProject(alice, workspace, { key: "LEDA", methodology: "kanban", lead: bob.id })).project_id!;
    const kept = (await createProject(alice, workspace, { key: "LEDB", methodology: "kanban", lead: alice.id })).project_id!;
    const foreign = (await createProject(alice, elsewhere, { key: "LEDC", methodology: "kanban", lead: bob.id })).project_id!;
    expect(await outcome(alice, "ws_remove_member($1,$2)", [workspace, bob.id])).toBe("ok");
    await owner.query("SET ROLE spark_owner");
    const leads = async (project: string) => (await owner.query(`SELECT lead_user_id,settings_version FROM ${table("projects")} WHERE id=$1`, [project])).rows[0];
    expect(await leads(led)).toEqual({ lead_user_id: null, settings_version: 2 });
    expect(await leads(kept)).toEqual({ lead_user_id: alice.id, settings_version: 1 });
    expect(await leads(foreign)).toEqual({ lead_user_id: bob.id, settings_version: 1 });
    const membership = (await owner.query(`SELECT id,status FROM ${table("workspace_memberships")} WHERE tenant_id=$1 AND user_id=$2`, [workspace, bob.id])).rows[0];
    expect(membership.status).toBe("left");
    expect((await auditRows(membership.id)).map((row) => row.action)).toEqual(["member.removed"]);
  });
  it("replays a create with the issue's current version", async () => {
    const alice = await account("Replay After Edit");
    const { project } = await kanbanProject(alice);
    const key = `quick-add:${randomUUID()}`, hash = randomBytes(32);
    const first = await createIssue(alice, project, { title: "Edited later", key, hash });
    expect(first.outcome).toBe("ok");
    expect(await updateIssue(alice, first.issue_id!, 1, { title: "Edited" })).toEqual({ outcome: "ok", issue_version: 2 });
    expect(await createIssue(alice, project, { title: "Edited later", key, hash })).toEqual({ outcome: "replayed", issue_id: first.issue_id, issue_version: 2 });
  });
  it("moves and reorders issues", async () => {
    const alice = await account("Board Mover");
    const { project } = await kanbanProject(alice);
    const progress = await statusNamed(project, "In progress");
    const ids: string[] = [];
    for (const title of ["A", "B", "C", "D"]) ids.push((await createIssue(alice, project, { title })).issue_id!);
    const [a, b, c, d] = ids as [string, string, string, string];
    expect(await updateIssue(alice, a, 1, { statusId: progress })).toEqual({ outcome: "ok", issue_version: 2 });
    await owner.query("SET ROLE spark_owner");
    const moved = (await owner.query(`SELECT status_id,position::text AS position,started_at,version FROM ${table("issues")} WHERE id=$1`, [a])).rows[0];
    expect(moved).toEqual({ status_id: progress, position: "1024.000000", started_at: expect.any(Date), version: 2 });
    const events = await issueEvents(a);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ event_type: "issue.updated", actor_user_id: alice.id, from_version: 1, to_version: 2 });
    expect(events[1].changes).toEqual({ fields: ["statusId"], after: { statusId: progress, category: "in_progress", assigneeUserId: null, storyPoints: null, phaseId: null, sprintId: null, archived: false } });
    expect((await owner.query(`SELECT event_type,processed_at IS NOT NULL AS processed FROM ${table("outbox_events")} WHERE aggregate_type='issue' AND aggregate_id=$1 AND aggregate_version=2`, [a])).rows)
      .toEqual([{ event_type: "issue.updated", processed: true }]);

    // Moves without a position go to the end of the target column.
    expect((await updateIssue(alice, b, 1, { statusId: progress })).outcome).toBe("ok");
    expect((await updateIssue(alice, c, 1, { statusId: progress })).outcome).toBe("ok");
    expect(await columnOrder(progress)).toEqual([a, b, c]);
    // afterIssueId null puts the issue first; afterIssueId X right after X.
    expect(await updateIssue(alice, c, 2, { afterIssueId: null })).toEqual({ outcome: "ok", issue_version: 3 });
    expect(await columnOrder(progress)).toEqual([c, a, b]);
    expect((await issueEvents(c))[2].changes.fields).toEqual(["position"]);
    expect(await updateIssue(alice, c, 3, { afterIssueId: a })).toEqual({ outcome: "ok", issue_version: 4 });
    expect(await columnOrder(progress)).toEqual([a, c, b]);
    expect(await updateIssue(alice, d, 1, { statusId: progress, afterIssueId: a })).toEqual({ outcome: "ok", issue_version: 2 });
    expect(await columnOrder(progress)).toEqual([a, d, c, b]);
    expect((await issueEvents(d))[1].changes.fields).toEqual(["position", "statusId"]);
    // Dropping an issue where it already is changes nothing.
    expect(await updateIssue(alice, d, 2, { afterIssueId: a })).toEqual({ outcome: "ok", issue_version: 2 });
    expect(await issueEvents(d)).toHaveLength(2);
    await owner.query("SET ROLE spark_owner");
    const positions = (await owner.query(`SELECT position::numeric AS position FROM ${table("issues")} WHERE status_id=$1 ORDER BY position,id`, [progress])).rows.map((row) => Number(row.position));
    for (let index = 1; index < positions.length; index++) expect(positions[index]!).toBeGreaterThan(positions[index - 1]!);
    // Other issues were never touched.
    for (const issue of [a, b]) expect(await issueVersion(issue)).toBe(2);
  });
  it("rebalances a crowded column", async () => {
    const alice = await account("Crowded Column");
    const { project } = await kanbanProject(alice);
    const backlog = await statusNamed(project, "Backlog");
    const ids: string[] = [];
    for (const title of ["F", "P", "Q", "R"]) ids.push((await createIssue(alice, project, { title })).issue_id!);
    const [f, p, q, r] = ids as [string, string, string, string];
    const intended = [f, p, q, r];
    for (let move = 0; move < 25; move++) {
      const mover = move % 2 === 0 ? q : p;
      const result = await updateIssue(alice, mover, await issueVersion(mover), { afterIssueId: f });
      expect({ move, outcome: result.outcome }).toEqual({ move, outcome: "ok" });
      intended.splice(intended.indexOf(mover), 1);
      intended.splice(1, 0, mover);
      expect(await columnOrder(backlog)).toEqual(intended);
    }
    expect(intended).toEqual([f, q, p, r]);
    await owner.query("SET ROLE spark_owner");
    const reranked = (await owner.query(`SELECT issue_id,to_version,actor_user_id,changes FROM ${table("issue_events")} WHERE project_id=$1 AND event_type='issue.reranked'`, [project])).rows;
    expect(reranked.length).toBeGreaterThan(0);
    for (const event of reranked) {
      expect(event.actor_user_id).toBe(alice.id);
      expect(event.changes.fields).toEqual(["position"]);
      expect(event.changes.after).toMatchObject({ statusId: backlog, category: "backlog", archived: false });
      expect((await owner.query(`SELECT event_type,processed_at IS NOT NULL AS processed FROM ${table("outbox_events")} WHERE aggregate_type='issue' AND aggregate_id=$1 AND aggregate_version=$2`,
        [event.issue_id, event.to_version])).rows).toEqual([{ event_type: "issue.reranked", processed: true }]);
    }
    for (const issue of ids) {
      const version = await issueVersion(issue);
      const history = await issueEvents(issue);
      expect(history.map((row) => row.to_version)).toEqual(Array.from({ length: version }, (_, index) => index + 1));
      expect(await countRows(`${table("outbox_events")} WHERE aggregate_type='issue' AND aggregate_id=$1`, [issue])).toBe(version);
    }
    // After a rebalance the gaps are wide again.
    const positions = (await owner.query(`SELECT position::numeric AS position FROM ${table("issues")} WHERE status_id=$1 ORDER BY position,id`, [backlog])).rows.map((row) => Number(row.position));
    for (let index = 1; index < positions.length; index++) expect(positions[index]! - positions[index - 1]!).toBeGreaterThanOrEqual(0.001);
  });
  it("applies a rebalancing reorder that keeps the mover's position", async () => {
    const alice = await account("Rebalance Keeper");
    const { project } = await kanbanProject(alice);
    const backlog = await statusNamed(project, "Backlog");
    const x = (await createIssue(alice, project, { title: "X" })).issue_id!;
    const m = (await createIssue(alice, project, { title: "M" })).issue_id!;
    const inserted: string[] = [];
    for (let index = 0; index < 19; index++) {
      const issue = (await createIssue(alice, project, { title: `I${index}` })).issue_id!;
      expect(await updateIssue(alice, issue, 1, { afterIssueId: x })).toEqual({ outcome: "ok", issue_version: 2 });
      inserted.unshift(issue);
    }
    expect(await countRows(`${table("issue_events")} WHERE project_id=$1 AND event_type='issue.reranked'`, [project])).toBe(0);
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT position::text AS position FROM ${table("issues")} WHERE id=$1`, [m])).rows[0].position).toBe("2048.000000");
    // M lands at slot 2 of the renumbered column, i.e. 2048 again, but the move and the rebalance still apply.
    expect(await updateIssue(alice, m, 1, { afterIssueId: x })).toEqual({ outcome: "ok", issue_version: 2 });
    expect(await columnOrder(backlog)).toEqual([x, m, ...inserted]);
    expect((await issueEvents(m))[1].changes.fields).toEqual(["position"]);
    expect(await countRows(`${table("issue_events")} WHERE project_id=$1 AND event_type='issue.reranked'`, [project])).toBeGreaterThan(0);
  });
  it("rebalances only a bounded window of a long column", async () => {
    const alice = await account("Long Column");
    const { project } = await kanbanProject(alice);
    const backlog = await statusNamed(project, "Backlog");
    const ids: string[] = [];
    for (let index = 0; index < 200; index++) ids.push((await createIssue(alice, project, { title: `L${index}` })).issue_id!);
    const anchor = ids[100]!, movers = [ids[198]!, ids[199]!];
    const intended = [...ids];
    const events = () => countRows(`${table("issue_events")} WHERE project_id=$1`, [project]);
    let rebalanced = 0;
    for (let move = 0; move < 26; move++) {
      const mover = movers[move % 2]!;
      const before = await events();
      expect((await updateIssue(alice, mover, await issueVersion(mover), { afterIssueId: anchor })).outcome).toBe("ok");
      const written = (await events()) - before;
      expect(written).toBeLessThanOrEqual(50);
      if (written > 1) rebalanced++;
      intended.splice(intended.indexOf(mover), 1);
      intended.splice(intended.indexOf(anchor) + 1, 0, mover);
    }
    expect(rebalanced).toBeGreaterThan(0);
    expect(await columnOrder(backlog)).toEqual(intended);
    // Issues far from the drop point were never renumbered.
    for (const issue of [...ids.slice(0, 50), ...ids.slice(160, 198)]) expect(await issueVersion(issue)).toBe(1);
  });
  it("falls back to renumbering the column when the local span is too dense", async () => {
    const alice = await account("Dense Column");
    const { workspace, project } = await kanbanProject(alice);
    const backlog = await statusNamed(project, "Backlog");
    const ids: string[] = [];
    for (let index = 0; index < 60; index++) ids.push((await createIssue(alice, project, { title: `D${index}` })).issue_id!);
    await owner.query("SET ROLE spark_owner");
    await owner.query("BEGIN");
    try {
      for (const [index, issue] of ids.entries()) {
        await owner.query(`UPDATE ${table("issues")} SET position=$2,version=2 WHERE id=$1`, [issue, 1024 + index * 0.0005]);
        await owner.query(`INSERT INTO ${table("issue_events")} (tenant_id,project_id,issue_id,actor_user_id,event_type,from_version,to_version,changes) VALUES ($1,$2,$3,$4,'issue.reranked',1,2,'{}')`, [workspace, project, issue, alice.id]);
        await owner.query(`INSERT INTO ${table("outbox_events")} (tenant_id,event_type,aggregate_type,aggregate_id,aggregate_version,payload,processed_at) VALUES ($1,'issue.reranked','issue',$2,2,'{}',now())`, [workspace, issue]);
      }
      await owner.query("COMMIT");
    } catch (error) { await owner.query("ROLLBACK"); throw error; }
    const mover = ids[59]!;
    expect(await updateIssue(alice, mover, 2, { afterIssueId: ids[30] })).toEqual({ outcome: "ok", issue_version: 3 });
    const intended = [...ids.slice(0, 31), mover, ...ids.slice(31, 59)];
    expect(await columnOrder(backlog)).toEqual(intended);
    await owner.query("SET ROLE spark_owner");
    const positions = (await owner.query(`SELECT i.position::text AS position FROM ${table("issues")} i WHERE i.status_id=$1 ORDER BY i.position,i.id`, [backlog])).rows;
    expect(positions.map((row) => row.position)).toEqual(intended.map((_, index) => `${1024 * (index + 1)}.000000`));
  });
  it("rejects a stale version once under concurrency", async () => {
    const alice = await account("Edit Racer A"), bob = await account("Edit Racer B");
    const { workspace, project } = await kanbanProject(alice);
    await addMember(workspace, bob, "member");
    const issue = (await createIssue(alice, project, { title: "Contested" })).issue_id!;
    const clients = await sessionPair([alice, bob]);
    try {
      const [first, second] = clients;
      expect((await first.query(updateIssueCall, [issue, 1, JSON.stringify({ title: "Alice wins" })])).rows[0]).toEqual({ outcome: "ok", issue_version: 2 });
      const secondPid = await backendPid(second);
      const competing = second.query(updateIssueCall, [issue, 1, JSON.stringify({ title: "Bob loses" })]);
      expect(await waitUntilBlocked(secondPid)).toBe(true);
      await first.query("COMMIT");
      expect((await competing).rows[0]).toEqual({ outcome: "version_mismatch", issue_version: 2 });
      await second.query("COMMIT");
    } finally { await closePair(clients); }
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT title,version FROM ${table("issues")} WHERE id=$1`, [issue])).rows[0]).toEqual({ title: "Alice wins", version: 2 });
  });
  it("enforces WIP on moves but not on reorders", async () => {
    const alice = await account("WIP Mover A"), bob = await account("WIP Mover B");
    const { workspace, project } = await kanbanProject(alice);
    await addMember(workspace, bob, "member");
    const review = await statusNamed(project, "Review");
    const ids: string[] = [];
    for (const title of ["One", "Two", "Three", "Four", "Five"]) ids.push((await createIssue(alice, project, { title })).issue_id!);
    for (const issue of ids.slice(0, 3)) expect(await updateIssue(alice, issue, 1, { statusId: review })).toEqual({ outcome: "ok", issue_version: 2 });
    expect(await updateIssue(alice, ids[3]!, 1, { statusId: review })).toEqual({ outcome: "wip_limit_reached", issue_version: null });
    expect(await updateIssue(alice, ids[3]!, 1, { statusId: review, afterIssueId: ids[0] })).toEqual({ outcome: "wip_limit_reached", issue_version: null });
    expect(await issueVersion(ids[3]!)).toBe(1);
    // Reordering and editing inside the full column are never blocked.
    expect(await updateIssue(alice, ids[2]!, 2, { afterIssueId: null })).toEqual({ outcome: "ok", issue_version: 3 });
    expect(await updateIssue(alice, ids[2]!, 3, { title: "Three, edited", statusId: review })).toEqual({ outcome: "ok", issue_version: 4 });
    expect(await columnOrder(review)).toEqual([ids[2], ids[0], ids[1]]);

    // Two concurrent moves into the last free slot: one wins.
    await owner.query("SET ROLE spark_owner");
    await owner.query(`UPDATE ${table("issue_statuses")} SET wip_limit=4 WHERE id=$1`, [review]);
    const clients = await sessionPair([alice, bob]);
    try {
      const [first, second] = clients;
      expect((await first.query(updateIssueCall, [ids[3], 1, JSON.stringify({ statusId: review })])).rows[0]).toEqual({ outcome: "ok", issue_version: 2 });
      const secondPid = await backendPid(second);
      const competing = second.query(updateIssueCall, [ids[4], 1, JSON.stringify({ statusId: review })]);
      expect(await waitUntilBlocked(secondPid)).toBe(true);
      await first.query("COMMIT");
      expect((await competing).rows[0]).toEqual({ outcome: "wip_limit_reached", issue_version: null });
      await second.query("COMMIT");
    } finally { await closePair(clients); }
    expect(await countRows(`${table("issues")} WHERE status_id=$1 AND archived_at IS NULL`, [review])).toBe(4);
  });
  it("guards issue updates", async () => {
    const alice = await account("Guard Owner"), bob = await account("Guard Member"), carol = await account("Guard Stranger"), dave = await account("Guard Leaver");
    const { workspace, project, key } = await kanbanProject(alice);
    await addMember(workspace, bob, "member");
    await addMember(workspace, dave, "member");
    expect(await outcome(dave, "ws_remove_member($1,$2)", [workspace, dave.id])).toBe("ok");
    const issue = (await createIssue(alice, project, { title: "Guarded" })).issue_id!;
    const other = (await createIssue(alice, project, { title: "Elsewhere", status: await statusNamed(project, "Ready") })).issue_id!;
    const foreign = await kanbanProject(carol);
    const plan = (await createProject(alice, workspace, waterfallInput(`W${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`))).project_id!;
    await owner.query("SET ROLE spark_owner");
    const foreignPhase = (await owner.query(`SELECT id FROM ${table("project_phases")} WHERE project_id=$1 ORDER BY position LIMIT 1`, [plan])).rows[0].id as string;

    expect(await updateIssue(carol, issue, 1, { title: "Stranger" })).toEqual({ outcome: "not_found", issue_version: null });
    expect(await updateIssue(dave, issue, 1, { title: "Leaver" })).toEqual({ outcome: "not_found", issue_version: null });
    expect(await updateIssue(alice, randomUUID(), 1, { title: "Missing" })).toEqual({ outcome: "not_found", issue_version: null });
    expect(await updateIssue(alice, issue, 7, { title: "Stale" })).toEqual({ outcome: "version_mismatch", issue_version: 1 });
    expect(await updateIssue(alice, issue, 1, { assigneeUserId: dave.id })).toEqual({ outcome: "invalid_assignee", issue_version: null });
    expect(await updateIssue(alice, issue, 1, { assigneeUserId: carol.id })).toEqual({ outcome: "invalid_assignee", issue_version: null });
    expect(await updateIssue(alice, issue, 1, { assigneeUserId: "not-a-uuid" })).toEqual({ outcome: "invalid_assignee", issue_version: null });

    const rejects = async (patch: unknown, message: string) =>
      expect(updateIssue(alice, issue, 1, patch)).rejects.toMatchObject({ code: "22023", message });
    await rejects({}, "Invalid issue patch");
    await rejects({ methodology: "x" }, "Invalid issue patch");
    await rejects({ title: "Fine", sprint: null }, "Invalid issue patch");
    // Sprints belong to Scrum projects only.
    for (const sprintId of [null, randomUUID()]) await rejects({ sprintId }, "Invalid sprint");
    await rejects(["title"], "Invalid issue patch");
    await rejects({ archived: "yes" }, "Invalid issue patch");
    for (const title of ["   ", "x".repeat(201), 42]) await rejects({ title }, "Invalid issue title");
    await rejects({ description: "x".repeat(10001) }, "Invalid issue description");
    for (const type of ["epic", "subtask", null]) await rejects({ type }, "Invalid issue type");
    for (const priority of ["urgent", null]) await rejects({ priority }, "Invalid issue priority");
    for (const storyPoints of [100.01, -1, 0.005, "3"]) await rejects({ storyPoints }, "Invalid story points");
    for (const dueDate of ["1999-12-31", "2101-01-01", "2026-02-30", "infinity", 20261201]) await rejects({ dueDate }, "Invalid due date");
    for (const statusId of [null, randomUUID(), "nope", await statusNamed(foreign.project, "Backlog")]) await rejects({ statusId }, "Invalid issue status");
    for (const phaseId of [foreignPhase, randomUUID(), "nope"]) await rejects({ phaseId }, "Invalid issue phase");
    for (const afterIssueId of [issue, other, randomUUID(), "nope", 5]) await rejects({ afterIssueId }, "Invalid issue position");
    // A position is valid when the anchor is in the target status.
    expect(await updateIssue(alice, issue, 1, { statusId: await statusNamed(project, "Ready"), afterIssueId: other })).toEqual({ outcome: "ok", issue_version: 2 });

    // Reassigning notifies the new assignee once; assigning yourself notifies nobody.
    expect(await updateIssue(alice, issue, 2, { assigneeUserId: bob.id, title: "  Guarded, assigned  " })).toEqual({ outcome: "ok", issue_version: 3 });
    expect(await updateIssue(alice, issue, 3, { assigneeUserId: alice.id })).toEqual({ outcome: "ok", issue_version: 4 });
    expect(await updateIssue(bob, issue, 4, { assigneeUserId: null, storyPoints: 2.5, dueDate: "2026-12-01", priority: "high", type: "bug", description: "  Steps  " }))
      .toEqual({ outcome: "ok", issue_version: 5 });
    await owner.query("SET ROLE spark_owner");
    const outboxId = (await owner.query(`SELECT id FROM ${table("outbox_events")} WHERE aggregate_type='issue' AND aggregate_id=$1 AND aggregate_version=3`, [issue])).rows[0].id;
    expect((await owner.query(`SELECT recipient_user_id,outbox_event_id,kind,title,resource_type,resource_id FROM ${table("notifications")} WHERE tenant_id=$1`, [workspace])).rows)
      .toEqual([{ recipient_user_id: bob.id, outbox_event_id: outboxId, kind: "issue_assigned", title: `Guard Owner assigned you ${key}-1: Guarded, assigned`, resource_type: "issue", resource_id: issue }]);
    expect((await owner.query(`SELECT title,description,type,priority,assignee_user_id,story_points::text AS points,due_date::text AS due FROM ${table("issues")} WHERE id=$1`, [issue])).rows[0])
      .toEqual({ title: "Guarded, assigned", description: "Steps", type: "bug", priority: "high", assignee_user_id: null, points: "2.50", due: "2026-12-01" });
    const history = await issueEvents(issue);
    expect(history.map((row) => row.changes.fields)).toEqual([expect.any(Array), ["position", "statusId"], ["assigneeUserId", "title"], ["assigneeUserId"],
      ["assigneeUserId", "description", "dueDate", "priority", "storyPoints", "type"]]);
    expect(history[4].changes.after).toMatchObject({ assigneeUserId: null, storyPoints: 2.5 });
    expect(JSON.stringify(history.map((row) => row.changes))).not.toContain("Guarded");

    // A patch that changes no value writes nothing.
    expect(await updateIssue(alice, issue, 5, { title: "Guarded, assigned", description: "Steps", storyPoints: 2.50 })).toEqual({ outcome: "ok", issue_version: 5 });
    expect(await issueEvents(issue)).toHaveLength(5);
    expect(await countRows(`${table("outbox_events")} WHERE aggregate_type='issue' AND aggregate_id=$1`, [issue])).toBe(5);

    // Clearing and setting a phase of the same project.
    const ownPhaseProject = (await createProject(alice, workspace, waterfallInput(`V${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`))).project_id!;
    await owner.query("SET ROLE spark_owner");
    const ownPhase = (await owner.query(`SELECT id FROM ${table("project_phases")} WHERE project_id=$1 ORDER BY position LIMIT 1`, [ownPhaseProject])).rows[0].id as string;
    const planned = (await createIssue(alice, ownPhaseProject, { title: "Planned" })).issue_id!;
    expect(await updateIssue(alice, planned, 1, { phaseId: ownPhase })).toEqual({ outcome: "ok", issue_version: 2 });
    expect((await issueEvents(planned))[1].changes.after.phaseId).toBe(ownPhase);
    expect(await updateIssue(alice, planned, 2, { phaseId: null })).toEqual({ outcome: "ok", issue_version: 3 });

    // Archived projects are invisible.
    await owner.query("SET ROLE spark_owner");
    await owner.query(`UPDATE ${table("projects")} SET archived_at=now() WHERE id=$1`, [project]);
    expect(await updateIssue(alice, issue, 5, { title: "Archived project" })).toEqual({ outcome: "not_found", issue_version: null });
    await expect(asSession(newTokenHash(), updateIssueCall, [issue, 5, JSON.stringify({ title: "No session" })])).rejects.toMatchObject({ code: "28000" });
  });
  it("archives and restores issues", async () => {
    const alice = await account("Archiver");
    const { project } = await kanbanProject(alice);
    const review = await statusNamed(project, "Review");
    const ids: string[] = [];
    for (const title of ["One", "Two", "Three"]) ids.push((await createIssue(alice, project, { title, status: review })).issue_id!);
    expect(await updateIssue(alice, ids[0]!, 1, { archived: true })).toEqual({ outcome: "ok", issue_version: 2 });
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT archived_at IS NOT NULL AS archived FROM ${table("issues")} WHERE id=$1`, [ids[0]])).rows[0].archived).toBe(true);
    expect((await issueEvents(ids[0]!))[1].changes).toMatchObject({ fields: ["archived"], after: { archived: true, statusId: review } });
    // The archived issue no longer counts against the WIP limit.
    const replacement = await createIssue(alice, project, { title: "Replacement", status: review });
    expect(replacement.outcome).toBe("ok");
    expect(await updateIssue(alice, ids[0]!, 2, { archived: false })).toEqual({ outcome: "wip_limit_reached", issue_version: null });
    for (const patch of [{ title: "Edited while archived" }, { archived: false, title: "Edited" }, { archived: true }, { afterIssueId: null }]) {
      await expect(updateIssue(alice, ids[0]!, 2, patch)).rejects.toMatchObject({ code: "22023", message: "Invalid issue patch" });
    }
    // Once a slot frees up the issue is restored at the end of its column.
    expect(await updateIssue(alice, ids[1]!, 1, { archived: true })).toEqual({ outcome: "ok", issue_version: 2 });
    expect(await updateIssue(alice, ids[0]!, 2, { archived: false })).toEqual({ outcome: "ok", issue_version: 3 });
    expect(await columnOrder(review)).toEqual([ids[2], replacement.issue_id, ids[0]]);
    expect((await issueEvents(ids[0]!))[2].changes).toMatchObject({ fields: ["archived"], after: { archived: false } });
    // Restoring an issue that is not archived changes nothing.
    expect(await updateIssue(alice, ids[0]!, 3, { archived: false })).toEqual({ outcome: "ok", issue_version: 3 });
  });
  it("skips no-op project settings updates", async () => {
    const alice = await account("Quiet Owner");
    const workspace = (await createWorkspace(alice)).workspace_id!;
    const project = (await createProject(alice, workspace, { key: "QUIET", methodology: "scrum", name: "Quiet", sprint: 14, lead: alice.id })).project_id!;
    expect(await updateProject(alice, project, 1, { name: "  Quiet  ", sprintLengthDays: 14, leadUserId: alice.id, description: "" })).toEqual({ outcome: "ok", settings_version: 1 });
    expect((await auditRows(project)).filter((row) => row.action === "project.updated")).toEqual([]);
    expect(await updateProject(alice, project, 1, { name: "Loud" })).toEqual({ outcome: "ok", settings_version: 2 });
    expect((await auditRows(project)).filter((row) => row.action === "project.updated")).toHaveLength(1);
    // Validation and the version check still run first.
    expect(await updateProject(alice, project, 1, { name: "Loud" })).toEqual({ outcome: "version_mismatch", settings_version: 2 });
    await expect(updateProject(alice, project, 2, { name: " " })).rejects.toMatchObject({ code: "22023", message: "Invalid project name" });
  });
  it("queues one assignment email per notification", async () => {
    const alice = await account("Mail Assigner"), bob = await account("Mail Assignee"), carol = await account("Mail Other");
    const { workspace, project, key } = await kanbanProject(alice);
    await addMember(workspace, bob, "member");
    await addMember(workspace, carol, "member");
    const slug = (await owner.query(`SELECT slug FROM ${table("workspaces")} WHERE id=$1`, [workspace])).rows[0].slug as string;
    const outboxOf = async (issue: string, version: number) => {
      await owner.query("SET ROLE spark_owner");
      return (await owner.query(`SELECT payload,processed_at IS NULL AS pending FROM ${table("outbox_events")} WHERE aggregate_type='issue' AND aggregate_id=$1 AND aggregate_version=$2`,
        [issue, version])).rows[0] as { payload: Record<string, unknown>; pending: boolean };
    };
    const noticeOf = async (issue: string, recipient: string) => {
      await owner.query("SET ROLE spark_owner");
      return (await owner.query(`SELECT n.id,o.aggregate_version FROM ${table("notifications")} n JOIN ${table("outbox_events")} o ON o.id=n.outbox_event_id
        WHERE n.resource_id=$1 AND n.recipient_user_id=$2 ORDER BY o.aggregate_version DESC LIMIT 1`, [issue, recipient])).rows[0].id as string;
    };
    const view = async (id: string) => (await workerRuntime.query(`SELECT * FROM ${fn("worker_task_assigned_email")}($1)`, [id])).rows;
    const statusOf = async (id: string) => (await view(id))[0]?.status as string | undefined;
    const record = async (id: string, status: string) =>
      (await workerRuntime.query(`SELECT ${fn("worker_record_email_delivery")}($1,$2) AS recorded`, [id, status])).rows[0].recorded as boolean;

    // Creating with another member as assignee leaves exactly that outbox row for the worker.
    const assigned = (await createIssue(alice, project, { title: "Ship the <b>deck</b>", assignee: bob.id })).issue_id!;
    const notice = await noticeOf(assigned, bob.id);
    expect(await outboxOf(assigned, 1)).toEqual({ pending: true,
      payload: { issueId: assigned, projectId: project, actorUserId: alice.id, assigneeUserId: bob.id, version: 1, notificationId: notice } });
    const self = (await createIssue(alice, project, { title: "Mine", assignee: alice.id })).issue_id!;
    expect(await outboxOf(self, 1)).toEqual({ pending: false, payload: { issueId: self, projectId: project, actorUserId: alice.id, assigneeUserId: alice.id } });
    const unassigned = (await createIssue(alice, project, { title: "Nobody" })).issue_id!;
    expect((await outboxOf(unassigned, 1)).pending).toBe(false);

    const details = { email: bob.email.toLowerCase(), recipient_name: "Mail Assignee", actor_name: "Mail Assigner", workspace_name: "Acme", workspace_slug: slug,
      project_key: key, project_name: "Project", issue_number: "1", issue_title: "Ship the <b>deck</b>" };
    expect(await view(notice)).toEqual([{ status: "pending", ...details }]);
    expect(await view(randomUUID())).toEqual([]);
    await expect(record(notice, "failed")).rejects.toMatchObject({ code: "22023" });
    expect(await record(randomUUID(), "sent")).toBe(false);
    expect(await record(notice, "sent")).toBe(true);
    expect(await record(notice, "sent")).toBe(false);
    expect(await record(notice, "suppressed")).toBe(false);
    expect(await view(notice)).toEqual([{ status: "skipped", ...Object.fromEntries(Object.keys(details).map((name) => [name, null])) }]);
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT channel,status,delivered_at IS NOT NULL AS delivered FROM ${table("notification_deliveries")} WHERE notification_id=$1`, [notice])).rows)
      .toEqual([{ channel: "email", status: "sent", delivered: true }]);

    // Updates: a new assignee gets a pending row; self-assignment and other edits stay processed.
    expect((await updateIssue(alice, unassigned, 1, { assigneeUserId: carol.id })).outcome).toBe("ok");
    const carolNotice = await noticeOf(unassigned, carol.id);
    expect(await outboxOf(unassigned, 2)).toEqual({ pending: true,
      payload: { issueId: unassigned, projectId: project, actorUserId: alice.id, assigneeUserId: carol.id, version: 2, notificationId: carolNotice } });
    expect((await updateIssue(alice, self, 1, { title: "Still mine" })).outcome).toBe("ok");
    expect((await outboxOf(self, 2)).pending).toBe(false);
    expect((await updateIssue(carol, self, 2, { assigneeUserId: carol.id })).outcome).toBe("ok");
    expect(await outboxOf(self, 3)).toEqual({ pending: false, payload: { issueId: self, projectId: project, actorUserId: carol.id, assigneeUserId: carol.id } });

    // A disabled preference suppresses the email; no row or an enabled row means enabled.
    expect(await statusOf(carolNotice)).toBe("pending");
    await owner.query("SET ROLE spark_owner");
    await owner.query(`INSERT INTO ${table("notification_preferences")} (user_id,kind,channel,enabled) VALUES ($1,'task_assigned','email',false)`, [carol.id]);
    expect(await statusOf(carolNotice)).toBe("skipped");
    await owner.query(`UPDATE ${table("notification_preferences")} SET enabled=true WHERE user_id=$1`, [carol.id]);
    expect(await statusOf(carolNotice)).toBe("pending");

    // Reassigned or archived in the meantime: nothing to send.
    const moving = (await createIssue(alice, project, { title: "Moving target", assignee: bob.id })).issue_id!;
    const movingNotice = await noticeOf(moving, bob.id);
    expect(await statusOf(movingNotice)).toBe("pending");
    expect((await updateIssue(alice, moving, 1, { assigneeUserId: carol.id })).outcome).toBe("ok");
    expect(await statusOf(movingNotice)).toBe("skipped");
    expect((await updateIssue(alice, unassigned, 2, { archived: true })).outcome).toBe("ok");
    expect(await statusOf(carolNotice)).toBe("skipped");

    // A recipient who left the workspace gets nothing.
    const leaving = (await createIssue(alice, project, { title: "Before leaving", assignee: bob.id })).issue_id!;
    const leavingNotice = await noticeOf(leaving, bob.id);
    expect(await statusOf(leavingNotice)).toBe("pending");
    expect(await outcome(alice, "ws_remove_member($1,$2)", [workspace, bob.id])).toBe("ok");
    expect(await statusOf(leavingNotice)).toBe("skipped");

    for (const role of [runtime, authRuntime]) {
      await expect(role.query(`SELECT * FROM ${fn("worker_task_assigned_email")}($1)`, [notice])).rejects.toMatchObject({ code: "42501" });
      await expect(role.query(`SELECT ${fn("worker_record_email_delivery")}($1,'sent')`, [notice])).rejects.toMatchObject({ code: "42501" });
    }
  });
  it("bounds assignment emails per recipient", async () => {
    const alice = await account("Limit Assigner"), bob = await account("Limit Assignee"), carol = await account("Limit Other"), dave = await account("Limit Busy");
    const { workspace, project } = await kanbanProject(alice);
    for (const who of [bob, carol, dave]) await addMember(workspace, who, "member");
    const noticesOf = async (issue: string, recipient: string) => {
      await owner.query("SET ROLE spark_owner");
      return (await owner.query(`SELECT n.id FROM ${table("notifications")} n JOIN ${table("outbox_events")} o ON o.id=n.outbox_event_id
        WHERE n.resource_id=$1 AND n.recipient_user_id=$2 ORDER BY o.aggregate_version`, [issue, recipient])).rows.map((row) => row.id as string);
    };
    const statusOf = async (id: string) => (await workerRuntime.query(`SELECT status FROM ${fn("worker_task_assigned_email")}($1)`, [id])).rows[0]?.status as string | undefined;
    const send = async (id: string) =>
      (await workerRuntime.query(`SELECT ${fn("worker_record_email_delivery")}($1,'sent') AS recorded`, [id])).rows[0].recorded as boolean;
    const deliveredAgo = async (id: string, minutes: number) => {
      await owner.query("SET ROLE spark_owner");
      await owner.query(`UPDATE ${table("notification_deliveries")} SET delivered_at=now()-make_interval(mins => $2) WHERE notification_id=$1`, [id, minutes]);
    };

    // Latest only: assigned B, then C, then B again before the worker ran: only the last notice to B is emailed.
    const issue = (await createIssue(alice, project, { title: "Bounced", assignee: bob.id })).issue_id!;
    expect((await updateIssue(alice, issue, 1, { assigneeUserId: carol.id })).outcome).toBe("ok");
    expect((await updateIssue(alice, issue, 2, { assigneeUserId: bob.id })).outcome).toBe("ok");
    const [firstToBob, latestToBob] = await noticesOf(issue, bob.id) as [string, string];
    expect(await statusOf(firstToBob)).toBe("skipped");
    expect(await statusOf(latestToBob)).toBe("pending");

    // Same issue window: a second email for the same issue within 10 minutes is skipped.
    expect(await send(latestToBob)).toBe(true);
    expect((await updateIssue(alice, issue, 3, { assigneeUserId: carol.id })).outcome).toBe("ok");
    expect((await updateIssue(alice, issue, 4, { assigneeUserId: bob.id })).outcome).toBe("ok");
    const againToBob = (await noticesOf(issue, bob.id))[2]!;
    expect(await statusOf(againToBob)).toBe("skipped");
    await deliveredAgo(latestToBob, 9);
    expect(await statusOf(againToBob)).toBe("skipped");
    await deliveredAgo(latestToBob, 11);
    expect(await statusOf(againToBob)).toBe("pending");
    // A different issue is not affected by the per-issue window.
    const other = (await createIssue(alice, project, { title: "Other issue", assignee: bob.id })).issue_id!;
    expect(await statusOf((await noticesOf(other, bob.id))[0]!)).toBe("pending");

    // Recipient window: at most 20 sent task-assigned emails per hour, across issues and workspaces.
    const second = await kanbanProject(alice);
    await addMember(second.workspace, dave, "member");
    const daveNotices: string[] = [];
    for (let index = 0; index < 21; index++) {
      const target = index % 2 === 0 ? project : second.project;
      const created = (await createIssue(alice, target, { title: `Busy ${index}`, assignee: dave.id })).issue_id!;
      daveNotices.push((await noticesOf(created, dave.id))[0]!);
    }
    for (const notice of daveNotices.slice(0, 20)) {
      expect(await statusOf(notice)).toBe("pending");
      expect(await send(notice)).toBe(true);
    }
    const last = daveNotices[20]!;
    expect(await statusOf(last)).toBe("skipped");
    // Suppressed deliveries and deliveries older than an hour do not count.
    await deliveredAgo(daveNotices[0]!, 59);
    expect(await statusOf(last)).toBe("skipped");
    await deliveredAgo(daveNotices[0]!, 61);
    expect(await statusOf(last)).toBe("pending");
    expect(await statusOf((await noticesOf(other, bob.id))[0]!)).toBe("pending");
  });
  it("creates and edits sprints", async () => {
    const alice = await account("Sprint Owner"), bob = await account("Sprint Lead"), carol = await account("Sprint Member"), dave = await account("Sprint Stranger");
    const workspace = (await createWorkspace(alice)).workspace_id!;
    await addMember(workspace, bob, "member");
    await addMember(workspace, carol, "member");
    const { project } = await scrumProject(alice, workspace, bob.id);
    // The project lead may plan although a plain member.
    const created = await createSprint(bob, project, "  Sprint 1  ", "  Ship sign-in  ", "2026-11-02", "2026-11-16");
    expect(created).toEqual({ outcome: "ok", sprint_id: expect.any(String), sprint_version: 1 });
    const sprint = created.sprint_id!;
    expect(await sprintRow(sprint)).toEqual({ name: "Sprint 1", goal: "Ship sign-in", status: "planned", version: 1, starts_on: "2026-11-02", ends_on: "2026-11-16",
      started: false, completed: false, committed_points: null, committed_count: null, completed_points: null, completed_count: null });
    const refused = (outcome: string): SprintCreated => ({ outcome, sprint_id: null, sprint_version: null });
    expect(await createSprint(carol, project, "Member sprint")).toEqual(refused("forbidden"));
    expect(await createSprint(dave, project, "Stranger sprint")).toEqual(refused("not_found"));
    expect(await createSprint(alice, randomUUID(), "Missing project")).toEqual(refused("not_found"));
    // Strangers learn nothing from invalid input or the methodology either.
    expect(await createSprint(dave, project, " ")).toEqual(refused("not_found"));
    const kanban = await kanbanProject(alice, workspace);
    expect(await createSprint(dave, kanban.project, "Kanban sprint")).toEqual(refused("not_found"));
    expect(await createSprint(carol, kanban.project, "Kanban sprint")).toEqual(refused("forbidden"));
    await expect(createSprint(alice, kanban.project, "Kanban sprint")).rejects.toMatchObject({ code: "22023", message: "Invalid methodology" });
    const createRejects = async (args: [unknown, string | null, string | null, string | null], message: string) =>
      expect(createSprint(alice, project, ...args)).rejects.toMatchObject({ code: "22023", message });
    for (const name of ["   ", "x".repeat(81), null]) await createRejects([name, null, null, null], "Invalid sprint name");
    await createRejects(["Sprint", "x".repeat(501), null, null], "Invalid sprint goal");
    const badDates: [string | null, string | null][] = [["2026-11-02", null], [null, "2026-11-16"], ["2026-11-02", "2026-11-02"], ["2026-11-02", "2026-11-01"],
      ["2026-11-02", "2026-12-01"], ["1999-12-30", "2000-01-02"], ["2100-12-30", "2101-01-02"], ["infinity", "infinity"]];
    for (const [starts, ends] of badDates) await createRejects(["Sprint", null, starts, ends], "Invalid sprint dates");
    // Limits: an 80-character name, a 500-character goal and 28 days.
    expect(await createSprint(alice, project, "x".repeat(80), "x".repeat(500), "2026-11-02", "2026-11-30")).toMatchObject({ outcome: "ok", sprint_version: 1 });
    const undated = (await createSprint(alice, project, "Later", "   ")).sprint_id!;
    expect(await sprintRow(undated)).toMatchObject({ goal: null, starts_on: null, ends_on: null, status: "planned" });

    expect(await updateSprint(bob, sprint, 1, { name: "  Sprint One  " })).toEqual({ outcome: "ok", sprint_version: 2 });
    expect(await updateSprint(bob, sprint, 1, { name: "Stale" })).toEqual({ outcome: "version_mismatch", sprint_version: 2 });
    expect(await updateSprint(carol, sprint, 2, { name: "Member" })).toEqual({ outcome: "forbidden", sprint_version: null });
    expect(await updateSprint(dave, sprint, 2, { name: "Stranger" })).toEqual({ outcome: "not_found", sprint_version: null });
    expect(await updateSprint(dave, sprint, 2, { bogus: true })).toEqual({ outcome: "not_found", sprint_version: null });
    expect(await updateSprint(alice, randomUUID(), 1, { name: "Missing" })).toEqual({ outcome: "not_found", sprint_version: null });
    expect(await updateSprint(alice, sprint, 2, { goal: null, startsOn: "2026-11-03", endsOn: "2026-11-17" })).toEqual({ outcome: "ok", sprint_version: 3 });
    expect(await updateSprint(alice, sprint, 3, { endsOn: "2026-11-30" })).toEqual({ outcome: "ok", sprint_version: 4 });
    // A patch that changes nothing writes nothing.
    expect(await updateSprint(alice, sprint, 4, { name: "Sprint One", goal: null, startsOn: "2026-11-03" })).toEqual({ outcome: "ok", sprint_version: 4 });
    expect(await sprintRow(sprint)).toMatchObject({ name: "Sprint One", goal: null, starts_on: "2026-11-03", ends_on: "2026-11-30", version: 4 });
    const updateRejects = async (patch: unknown, message: string) =>
      expect(updateSprint(alice, sprint, 4, patch)).rejects.toMatchObject({ code: "22023", message });
    for (const patch of [{}, ["name"], "name", { status: "active" }, { name: "Fine", startsAt: "2026-11-03" }]) await updateRejects(patch, "Invalid sprint");
    for (const name of [" ", "x".repeat(81), 5, null]) await updateRejects({ name }, "Invalid sprint name");
    for (const goal of ["x".repeat(501), 5]) await updateRejects({ goal }, "Invalid sprint goal");
    for (const patch of [{ startsOn: "2026-02-30" }, { startsOn: 20261103 }, { startsOn: "infinity" }, { startsOn: null }, { endsOn: "2026-12-02" }, { startsOn: "2026-11-30" }])
      await updateRejects(patch, "Invalid sprint dates");
    expect(await updateSprint(alice, sprint, 4, { startsOn: null, endsOn: null })).toEqual({ outcome: "ok", sprint_version: 5 });
    expect(await updateSprint(alice, sprint, 5, { startsOn: "2026-11-02", endsOn: "2026-11-16" })).toEqual({ outcome: "ok", sprint_version: 6 });

    // Name and goal stay editable while active; dates only while planned; history is closed.
    expect(await startSprint(bob, sprint, 6)).toEqual({ outcome: "ok", sprint_version: 7 });
    expect(await updateSprint(bob, sprint, 7, { name: "Sprint 1", goal: "Ship sign-in" })).toEqual({ outcome: "ok", sprint_version: 8 });
    expect(await updateSprint(bob, sprint, 8, { endsOn: "2026-11-20" })).toEqual({ outcome: "not_editable", sprint_version: null });
    expect(await completeSprint(bob, sprint, 8, null)).toEqual({ outcome: "ok", sprint_version: 9, moved_issues: 0 });
    expect(await updateSprint(bob, sprint, 9, { name: "History" })).toEqual({ outcome: "not_editable", sprint_version: null });
    expect(await sprintRow(sprint)).toMatchObject({ name: "Sprint 1", goal: "Ship sign-in", status: "completed", version: 9, completed_points: "0.00", completed_count: 0 });

    // Once the project leaves Scrum its sprints are history only.
    await owner.query("SET ROLE spark_owner");
    await owner.query(`UPDATE ${table("projects")} SET methodology='kanban',sprint_length_days=NULL WHERE id=$1`, [project]);
    await expect(updateSprint(alice, undated, 1, { name: "Kanban now" })).rejects.toMatchObject({ code: "22023", message: "Invalid methodology" });
    await expect(startSprint(alice, undated, 1)).rejects.toMatchObject({ code: "22023", message: "Invalid methodology" });
    expect(await updateSprint(dave, undated, 1, { name: "Kanban now" })).toEqual({ outcome: "not_found", sprint_version: null });
    await expect(asSession(newTokenHash(), createSprintCall, [project, "No session", null, null, null])).rejects.toMatchObject({ code: "28000" });
  });
  it("starts one sprint at a time", async () => {
    const alice = await account("Start Owner"), bob = await account("Start Admin"), carol = await account("Start Member"), dave = await account("Start Stranger");
    const { workspace, project } = await scrumProject(alice);
    await addMember(workspace, bob, "admin");
    await addMember(workspace, carol, "member");
    const first = (await createSprint(alice, project, "First", null, "2026-11-02", "2026-11-16")).sprint_id!;
    const second = (await createSprint(bob, project, "Second", null, "2026-11-16", "2026-11-30")).sprint_id!;
    const undated = (await createSprint(alice, project, "Undated")).sprint_id!;
    expect(await startSprint(carol, first, 1)).toEqual({ outcome: "forbidden", sprint_version: null });
    expect(await startSprint(dave, first, 1)).toEqual({ outcome: "not_found", sprint_version: null });
    expect(await startSprint(alice, randomUUID(), 1)).toEqual({ outcome: "not_found", sprint_version: null });
    expect(await startSprint(alice, first, 2)).toEqual({ outcome: "version_mismatch", sprint_version: 1 });
    expect(await startSprint(alice, undated, 1)).toEqual({ outcome: "missing_dates", sprint_version: null });
    const clients = await sessionPair([alice, bob]);
    try {
      const [one, two] = clients;
      expect((await one.query(startSprintCall, [first, 1])).rows[0]).toEqual({ outcome: "ok", sprint_version: 2 });
      const pid = await backendPid(two);
      const competing = two.query(startSprintCall, [second, 1]);
      expect(await waitUntilBlocked(pid)).toBe(true);
      await one.query("COMMIT");
      expect((await competing).rows[0]).toEqual({ outcome: "already_active", sprint_version: null });
      await two.query("COMMIT");
    } finally { await closePair(clients); }
    expect(await countRows(`${table("sprints")} WHERE project_id=$1 AND status='active'`, [project])).toBe(1);
    expect(await sprintRow(first)).toMatchObject({ status: "active", version: 2, started: true, committed_points: "0.00", committed_count: 0 });
    expect(await sprintRow(second)).toMatchObject({ status: "planned", version: 1, started: false });
    // Starting the active sprint again, or a finished one.
    expect(await startSprint(bob, first, 2)).toEqual({ outcome: "already_active", sprint_version: null });
    expect(await completeSprint(bob, first, 2, null)).toEqual({ outcome: "ok", sprint_version: 3, moved_issues: 0 });
    expect(await startSprint(bob, first, 3)).toEqual({ outcome: "not_planned", sprint_version: null });
    expect(await startSprint(bob, second, 1)).toEqual({ outcome: "ok", sprint_version: 2 });
  });
  it("snapshots commitments on start", async () => {
    const alice = await account("Commit Owner");
    const { project } = await scrumProject(alice);
    const sprint = (await createSprint(alice, project, "Committed", null, "2026-11-02", "2026-11-16")).sprint_id!;
    const five = await sprintIssue(alice, project, sprint, { points: "5" });
    const half = await sprintIssue(alice, project, sprint, { points: "2.5" });
    const unestimated = await sprintIssue(alice, project, sprint);
    const shelved = await sprintIssue(alice, project, sprint, { points: "8" });
    expect(await updateIssue(alice, shelved, 2, { archived: true })).toMatchObject({ outcome: "ok" });
    const backlogIssue = (await createIssue(alice, project, { points: "13" })).issue_id!;
    expect(await startSprint(alice, sprint, 1)).toEqual({ outcome: "ok", sprint_version: 2 });
    const commitments = async () => {
      await owner.query("SET ROLE spark_owner");
      return (await owner.query(`SELECT issue_id,story_points::text AS points FROM ${table("sprint_commitments")} WHERE sprint_id=$1 ORDER BY issue_id`, [sprint])).rows;
    };
    const expected = [{ issue_id: five, points: "5.00" }, { issue_id: half, points: "2.50" }, { issue_id: unestimated, points: null }]
      .sort((left, right) => (left.issue_id < right.issue_id ? -1 : 1));
    expect(await commitments()).toEqual(expected);
    expect(await sprintRow(sprint)).toMatchObject({ committed_points: "7.50", committed_count: 3 });
    // Later estimates and scope changes leave the snapshot alone.
    expect(await updateIssue(alice, five, 2, { storyPoints: 8 })).toMatchObject({ outcome: "ok" });
    expect(await updateIssue(alice, backlogIssue, 1, { sprintId: sprint })).toMatchObject({ outcome: "ok" });
    expect(await updateIssue(alice, half, 2, { sprintId: null })).toMatchObject({ outcome: "ok" });
    expect(await commitments()).toEqual(expected);
    expect(await sprintRow(sprint)).toMatchObject({ committed_points: "7.50", committed_count: 3 });
    await rollback(async () => {
      await rejectInside(`UPDATE ${table("sprint_commitments")} SET story_points=1 WHERE sprint_id=$1`, [sprint], "23514");
      await rejectInside(`DELETE FROM ${table("sprint_commitments")} WHERE sprint_id=$1`, [sprint], "23514");
    });
    expect((await asSession(alice.token, `SELECT count(*)::integer AS total FROM ${table("sprint_commitments")} WHERE sprint_id=$1`, [sprint])).rows[0].total).toBe(3);
  });
  it("notifies assignees when a sprint starts", async () => {
    const alice = await account("Notify Owner"), bob = await account("Notify Bob"), carol = await account("Notify Carol"), dave = await account("Notify Leaver"), erin = await account("Notify Outsider");
    const { workspace, project } = await scrumProject(alice);
    for (const who of [bob, carol, dave, erin]) await addMember(workspace, who, "member");
    const sprint = (await createSprint(alice, project, "Launch", null, "2026-11-02", "2026-11-16")).sprint_id!;
    for (const assignee of [bob.id, bob.id, carol.id, alice.id, dave.id, null]) await sprintIssue(alice, project, sprint, { assignee });
    // Not in the sprint: no notification.
    await createIssue(alice, project, { assignee: erin.id });
    expect(await outcome(dave, "ws_remove_member($1,$2)", [workspace, dave.id])).toBe("ok");
    expect(await startSprint(alice, sprint, 1)).toEqual({ outcome: "ok", sprint_version: 2 });
    await owner.query("SET ROLE spark_owner");
    const outbox = (await owner.query(`SELECT id,event_type,aggregate_version,processed_at IS NOT NULL AS processed,payload FROM ${table("outbox_events")} WHERE aggregate_type='sprint' AND aggregate_id=$1`, [sprint])).rows;
    expect(outbox).toEqual([{ id: expect.any(String), event_type: "sprint.started", aggregate_version: 2, processed: true, payload: { sprintId: sprint, projectId: project, actorUserId: alice.id } }]);
    const byRecipient = (left: { recipient_user_id: string }, right: { recipient_user_id: string }) => (left.recipient_user_id < right.recipient_user_id ? -1 : 1);
    const notices = (await owner.query(`SELECT recipient_user_id,outbox_event_id,kind,title,resource_type,resource_id,read_at FROM ${table("notifications")} WHERE tenant_id=$1 AND kind='sprint_started'`, [workspace])).rows;
    const expected = (who: Account) => ({ recipient_user_id: who.id, outbox_event_id: outbox[0].id, kind: "sprint_started", title: "Rocket: Launch started", resource_type: "sprint", resource_id: sprint, read_at: null });
    expect(notices.sort(byRecipient)).toEqual([expected(bob), expected(carol)].sort(byRecipient));
    // Recipients read their own notification.
    expect((await asSession(bob.token, `SELECT kind,title FROM ${table("notifications")} WHERE resource_id=$1`, [sprint])).rows).toEqual([{ kind: "sprint_started", title: "Rocket: Launch started" }]);
  });
  it("completes and carries over open work", async () => {
    const alice = await account("Complete Owner"), carol = await account("Complete Member"), dave = await account("Complete Stranger");
    const { workspace, project } = await scrumProject(alice);
    await addMember(workspace, carol, "member");
    const done = await statusNamed(project, "Done"), progress = await statusNamed(project, "In progress");
    const current = (await createSprint(alice, project, "Current", null, "2026-11-02", "2026-11-16")).sprint_id!;
    const next = (await createSprint(alice, project, "Next", null, "2026-11-16", "2026-11-30")).sprint_id!;
    const finished = await sprintIssue(alice, project, current, { points: "3" });
    const finishedToo = await sprintIssue(alice, project, current, { points: "2" });
    const open = await sprintIssue(alice, project, current, { points: "5" });
    const started = await sprintIssue(alice, project, current, { status: progress });
    const shelved = await sprintIssue(alice, project, current);
    expect(await updateIssue(alice, shelved, 2, { archived: true })).toMatchObject({ outcome: "ok" });
    expect(await startSprint(alice, current, 1)).toEqual({ outcome: "ok", sprint_version: 2 });
    for (const issue of [finished, finishedToo]) expect(await updateIssue(alice, issue, 2, { statusId: done })).toMatchObject({ outcome: "ok", issue_version: 3 });

    const refused = (outcome: string) => ({ outcome, sprint_version: null, moved_issues: null });
    expect(await completeSprint(carol, current, 2, next)).toEqual(refused("forbidden"));
    expect(await completeSprint(dave, current, 2, next)).toEqual(refused("not_found"));
    expect(await completeSprint(alice, randomUUID(), 2, next)).toEqual(refused("not_found"));
    expect(await completeSprint(alice, current, 1, next)).toEqual({ outcome: "version_mismatch", sprint_version: 2, moved_issues: null });
    expect(await completeSprint(alice, next, 1, null)).toEqual(refused("not_active"));
    const other = await scrumProject(alice, workspace);
    const foreign = (await createSprint(alice, other.project, "Foreign")).sprint_id!;
    for (const target of [current, foreign, randomUUID()]) expect(await completeSprint(alice, current, 2, target)).toEqual(refused("invalid_carry_target"));

    expect(await completeSprint(alice, current, 2, next)).toEqual({ outcome: "ok", sprint_version: 3, moved_issues: 2 });
    expect(await sprintRow(current)).toMatchObject({ status: "completed", version: 3, completed: true, committed_points: "10.00", committed_count: 4, completed_points: "5.00", completed_count: 2 });
    await owner.query("SET ROLE spark_owner");
    const placement = async () => (await owner.query(`SELECT id,sprint_id,version FROM ${table("issues")} WHERE project_id=$1 ORDER BY number`, [project])).rows;
    expect(await placement()).toEqual([
      { id: finished, sprint_id: current, version: 3 }, { id: finishedToo, sprint_id: current, version: 3 },
      { id: open, sprint_id: next, version: 3 }, { id: started, sprint_id: next, version: 3 }, { id: shelved, sprint_id: current, version: 3 },
    ]);
    for (const [issue, category] of [[open, "backlog"], [started, "in_progress"]] as const) {
      const events = await issueEvents(issue);
      expect(events).toHaveLength(3);
      expect(events[2]).toMatchObject({ event_type: "issue.updated", actor_user_id: alice.id, from_version: 2, to_version: 3 });
      expect(events[2].changes).toEqual({ fields: ["sprintId"], after: { statusId: expect.any(String), category, assigneeUserId: null, storyPoints: issue === open ? 5 : null, phaseId: null, sprintId: next, archived: false } });
      const outbox = (await owner.query(`SELECT event_type,processed_at IS NOT NULL AS processed FROM ${table("outbox_events")} WHERE aggregate_type='issue' AND aggregate_id=$1 AND aggregate_version=3`, [issue])).rows;
      expect(outbox).toEqual([{ event_type: "issue.updated", processed: true }]);
    }
    // The totals are frozen: later edits to finished work leave them alone.
    expect(await updateIssue(alice, finished, 3, { storyPoints: 13 })).toMatchObject({ outcome: "ok" });
    expect(await updateIssue(alice, finishedToo, 3, { statusId: progress })).toMatchObject({ outcome: "ok" });
    expect(await sprintRow(current)).toMatchObject({ completed_points: "5.00", completed_count: 2 });
    expect(await completeSprint(alice, current, 3, null)).toEqual(refused("not_active"));

    // Without a target, open work returns to the backlog; a finished sprint is no target.
    expect(await startSprint(alice, next, 1)).toEqual({ outcome: "ok", sprint_version: 2 });
    expect(await completeSprint(alice, next, 2, current)).toEqual(refused("invalid_carry_target"));
    expect(await completeSprint(alice, next, 2, null)).toEqual({ outcome: "ok", sprint_version: 3, moved_issues: 2 });
    await owner.query("SET ROLE spark_owner");
    expect((await placement()).filter((row) => row.id === open || row.id === started)).toEqual([{ id: open, sprint_id: null, version: 4 }, { id: started, sprint_id: null, version: 4 }]);
    expect((await issueEvents(open))[3].changes).toMatchObject({ fields: ["sprintId"], after: { sprintId: null } });
    expect(await sprintRow(next)).toMatchObject({ status: "completed", committed_points: "5.00", committed_count: 2, completed_points: "0.00", completed_count: 0 });
  });
  it("assigns issues to sprints through ws_update_issue", async () => {
    const alice = await account("Planner Owner"), carol = await account("Planner Member"), dave = await account("Planner Stranger");
    const { workspace, project } = await scrumProject(alice);
    await addMember(workspace, carol, "member");
    const planned = (await createSprint(alice, project, "Planned", null, "2026-11-02", "2026-11-16")).sprint_id!;
    const active = (await createSprint(alice, project, "Active", null, "2026-10-19", "2026-11-02")).sprint_id!;
    const finished = (await createSprint(alice, project, "Finished", null, "2026-10-05", "2026-10-19")).sprint_id!;
    expect(await startSprint(alice, finished, 1)).toMatchObject({ outcome: "ok" });
    expect(await completeSprint(alice, finished, 2, null)).toMatchObject({ outcome: "ok" });
    expect(await startSprint(alice, active, 1)).toMatchObject({ outcome: "ok" });
    const other = await scrumProject(alice, workspace);
    const foreign = (await createSprint(alice, other.project, "Foreign")).sprint_id!;
    const issue = (await createIssue(carol, project, { title: "Plan me" })).issue_id!;
    // Any member may plan an issue; strangers get not_found even for an invalid sprint.
    expect(await updateIssue(dave, issue, 1, { sprintId: "nope" })).toEqual({ outcome: "not_found", issue_version: null });
    expect(await updateIssue(carol, issue, 1, { sprintId: planned })).toEqual({ outcome: "ok", issue_version: 2 });
    expect(await updateIssue(carol, issue, 2, { sprintId: active, title: "Plan me now" })).toEqual({ outcome: "ok", issue_version: 3 });
    expect(await updateIssue(carol, issue, 3, { sprintId: active })).toEqual({ outcome: "ok", issue_version: 3 });
    expect(await updateIssue(carol, issue, 3, { sprintId: null })).toEqual({ outcome: "ok", issue_version: 4 });
    const history = await issueEvents(issue);
    expect(history.slice(1).map((row) => [row.changes.fields, row.changes.after.sprintId])).toEqual([[["sprintId"], planned], [["sprintId", "title"], active], [["sprintId"], null]]);
    const rejects = (patch: unknown) => expect(updateIssue(carol, issue, 4, patch)).rejects.toMatchObject({ code: "22023", message: "Invalid sprint" });
    for (const sprintId of [finished, foreign, randomUUID(), "nope", 5, issue]) await rejects({ sprintId });
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT sprint_id,version FROM ${table("issues")} WHERE id=$1`, [issue])).rows[0]).toEqual({ sprint_id: null, version: 4 });
  });
  it("saves a phase plan without touching baselines", async () => {
    const alice = await account("Plan Owner"), bob = await account("Plan Lead"), carol = await account("Plan Member"), dave = await account("Plan Stranger");
    const workspace = (await createWorkspace(alice)).workspace_id!;
    await addMember(workspace, bob, "member");
    await addMember(workspace, carol, "member");
    const { project } = await waterfallProject(alice, workspace, bob.id);
    const [requirements, design, build, test, deploy] = (await phasePlan(project)).map((row) => row.id as string);
    const baselinedAt = (await projectPlanState(project)).baselined_at;
    // The Test phase carries its sign-off milestone; once unlinked the phase can be dropped.
    const testSignOff = (await milestoneRows(project)).find((row) => row.name === "Test sign-off")!;
    expect(await updateMilestone(bob, testSignOff.id, 1, { phaseId: null })).toEqual({ outcome: "ok", milestone_version: 2 });
    // The lead (a plain member) renames and shortens one phase, inserts one, moves an end and drops Test.
    const plan = [phaseEntry("  Discovery  ", "2026-11-02", "2026-11-06", requirements), phaseEntry("Prototype", "2026-11-07", "2026-11-09"),
      phaseEntry("Design", "2026-11-10", "2026-11-17", design), phaseEntry("Build", "2026-11-18", "2026-12-01", build), phaseEntry("Deploy", "2026-12-05", "2026-12-11", deploy)];
    expect(await savePhases(bob, project, 1, plan)).toEqual({ outcome: "ok", settings_version: 2 });
    const saved = await phasePlan(project);
    expect(saved).toEqual([
      { id: requirements, name: "Discovery", position: 1, planned_start: "2026-11-02", planned_end: "2026-11-06", baseline_start: "2026-11-02", baseline_end: "2026-11-09", version: 2 },
      { id: expect.any(String), name: "Prototype", position: 2, planned_start: "2026-11-07", planned_end: "2026-11-09", baseline_start: null, baseline_end: null, version: 1 },
      { id: design, name: "Design", position: 3, planned_start: "2026-11-10", planned_end: "2026-11-17", baseline_start: "2026-11-10", baseline_end: "2026-11-17", version: 2 },
      { id: build, name: "Build", position: 4, planned_start: "2026-11-18", planned_end: "2026-12-01", baseline_start: "2026-11-18", baseline_end: "2026-11-27", version: 2 },
      { id: deploy, name: "Deploy", position: 5, planned_start: "2026-12-05", planned_end: "2026-12-11", baseline_start: "2026-12-05", baseline_end: "2026-12-11", version: 1 },
    ]);
    expect(saved.map((row) => row.id)).not.toContain(test);
    expect(await projectPlanState(project)).toEqual({ settings_version: 2, baselined_at: baselinedAt });
    // The same plan again changes no phase but still advances the settings version.
    const same = saved.map((row) => phaseEntry(row.name, row.planned_start, row.planned_end, row.id));
    expect(await savePhases(bob, project, 2, same)).toEqual({ outcome: "ok", settings_version: 3 });
    expect(await phasePlan(project)).toEqual(saved);
    // A phase inserted first shifts every position by one in a single save.
    const shifted = [phaseEntry("Kickoff", "2026-11-02", "2026-11-02"), { ...same[0]!, plannedStart: "2026-11-03" }, ...same.slice(1)];
    expect(await savePhases(alice, project, 3, shifted)).toEqual({ outcome: "ok", settings_version: 4 });
    expect((await phasePlan(project)).map((row) => [row.name, row.position, row.version])).toEqual([
      ["Kickoff", 1, 1], ["Discovery", 2, 3], ["Prototype", 3, 2], ["Design", 4, 3], ["Build", 5, 3], ["Deploy", 6, 2]]);

    const refused = (outcome: string): PlanResult => ({ outcome, settings_version: null });
    expect(await savePhases(carol, project, 4, shifted)).toEqual(refused("forbidden"));
    expect(await savePhases(dave, project, 4, shifted)).toEqual(refused("not_found"));
    // Strangers learn nothing from an invalid plan or the methodology either.
    expect(await savePhases(dave, project, 4, "plan")).toEqual(refused("not_found"));
    expect(await savePhases(alice, randomUUID(), 1, shifted)).toEqual(refused("not_found"));
    expect(await savePhases(bob, project, 3, shifted)).toEqual({ outcome: "version_mismatch", settings_version: 4 });
    const kanban = await kanbanProject(alice, workspace);
    expect(await savePhases(dave, kanban.project, 1, waterfallPhases)).toEqual(refused("not_found"));
    expect(await savePhases(carol, kanban.project, 1, waterfallPhases)).toEqual(refused("forbidden"));
    await expect(savePhases(alice, kanban.project, 1, waterfallPhases)).rejects.toMatchObject({ code: "22023", message: "Invalid methodology" });
    const archived = await waterfallProject(alice, workspace);
    await owner.query("SET ROLE spark_owner");
    await owner.query(`UPDATE ${table("projects")} SET archived_at=now() WHERE id=$1`, [archived.project]);
    expect(await savePhases(alice, archived.project, 1, waterfallPhases)).toEqual(refused("not_found"));
    await expect(asSession(newTokenHash(), savePhasesCall, [project, 4, JSON.stringify(shifted)])).rejects.toMatchObject({ code: "28000" });
    expect((await projectPlanState(project)).settings_version).toBe(4);
  });
  it("refuses overlapping, out-of-range and referenced-delete phase plans", async () => {
    const alice = await account("Plan Checker");
    const { workspace, project } = await waterfallProject(alice);
    const other = await waterfallProject(alice, workspace);
    const before = await phasePlan(project);
    const ids = before.map((row) => row.id as string);
    const current = before.map((row) => phaseEntry(row.name, row.planned_start, row.planned_end, row.id));
    const rejects = (phases: unknown, message: string) => expect(savePhases(alice, project, 1, phases)).rejects.toMatchObject({ code: "22023", message });
    const thirteen = Array.from({ length: 13 }, (_, index) => { const day = `2026-11-${String(index + 2).padStart(2, "0")}`; return phaseEntry(`Phase ${index + 1}`, day, day); });
    const shapes: unknown[] = [null, "plan", {}, [], thirteen, ["Build"], [{ ...phaseEntry("Build", "2026-11-02", "2026-11-09"), color: "red" }],
      [phaseEntry("   ", "2026-11-02", "2026-11-09")], [phaseEntry("x".repeat(61), "2026-11-02", "2026-11-09")], [{ name: 5, plannedStart: "2026-11-02", plannedEnd: "2026-11-09" }],
      [{ name: "Build", plannedStart: "2026-11-02" }], [{ name: "Build", plannedStart: 20261102, plannedEnd: "2026-11-09" }],
      [phaseEntry("Build", "2026-02-30", "2026-11-09")], [phaseEntry("Build", "infinity", "2026-11-09")],
      // Backwards, outside the project dates, overlapping on a shared day, out of order.
      [phaseEntry("Build", "2026-11-09", "2026-11-02")], [phaseEntry("Build", "2026-11-01", "2026-11-09")], [phaseEntry("Build", "2026-11-02", "2026-12-12")],
      [phaseEntry("Build", "2026-11-02", "2026-11-09"), phaseEntry("Test", "2026-11-09", "2026-11-16")],
      [phaseEntry("Test", "2026-11-10", "2026-11-16"), phaseEntry("Build", "2026-11-02", "2026-11-09")],
      // The rules apply to kept phases too.
      current.map((entry, index) => (index === 1 ? { ...entry, plannedStart: "2026-11-09" } : entry))];
    for (const phases of shapes) await rejects(phases, "Invalid project phases");
    const otherPhase = (await phasePlan(other.project))[0]!.id as string;
    const withId = (index: number, id: unknown) => current.map((entry, position) => (position === index ? { ...entry, id } : entry));
    for (const id of ["nope", 5, null, otherPhase, randomUUID()]) await rejects(withId(0, id), "Invalid phase");
    await rejects(withId(1, ids[0]), "Invalid phase");
    // Every template phase is referenced by its sign-off milestone, so none can be dropped yet.
    await rejects(current.slice(0, 4), "Invalid phase");
    const signOffs = await milestoneRows(project);
    for (const name of ["Test sign-off", "Deploy sign-off"])
      expect(await updateMilestone(alice, signOffs.find((row) => row.name === name)!.id, 1, { phaseId: null })).toMatchObject({ outcome: "ok" });
    // An issue in a phase, even an archived one, keeps the phase too.
    const issue = (await createIssue(alice, project, { title: "Test plan", phase: ids[3]! })).issue_id!;
    expect(await updateIssue(alice, issue, 1, { archived: true })).toMatchObject({ outcome: "ok" });
    await rejects([...current.slice(0, 3), current[4]], "Invalid phase");
    expect(await phasePlan(project)).toEqual(before);
    expect((await projectPlanState(project)).settings_version).toBe(1);

    expect(await savePhases(alice, project, 1, current.slice(0, 4))).toEqual({ outcome: "ok", settings_version: 2 });
    expect((await phasePlan(project)).map((row) => row.name)).toEqual(["Requirements", "Design", "Build", "Test"]);
    // Twelve phases are the maximum.
    const twelve = [...current.slice(0, 3), phaseEntry("Test", "2026-11-28", "2026-11-30", ids[3]),
      ...Array.from({ length: 8 }, (_, index) => phaseEntry(`Release ${index + 1}`, `2026-12-0${index + 1}`, `2026-12-0${index + 1}`))];
    expect(await savePhases(alice, project, 2, twelve)).toEqual({ outcome: "ok", settings_version: 3 });
    expect((await phasePlan(project)).map((row) => row.position)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
  });
  it("creates, moves and completes milestones", async () => {
    const alice = await account("Milestone Owner"), bob = await account("Milestone Lead"), carol = await account("Milestone Member"), dave = await account("Milestone Stranger");
    const workspace = (await createWorkspace(alice)).workspace_id!;
    await addMember(workspace, bob, "member");
    await addMember(workspace, carol, "member");
    // Milestones work in every methodology: a Kanban project without dates.
    const flow = await createProject(alice, workspace, { key: `M${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`, methodology: "kanban", lead: bob.id });
    const kanban = flow.project_id!;
    const created = await createMilestone(bob, kanban, "  Beta launch  ", "2027-03-01");
    expect(created).toEqual({ outcome: "ok", milestone_id: expect.any(String), milestone_version: 1 });
    const milestone = created.milestone_id!;
    expect(await milestoneRows(kanban)).toEqual([{ id: milestone, name: "Beta launch", phase_id: null, due_date: "2027-03-01", baseline_due_date: null, completed_at: null, version: 1 }]);
    const refused = (outcome: string): MilestoneCreated => ({ outcome, milestone_id: null, milestone_version: null });
    expect(await createMilestone(carol, kanban, "Member", "2027-03-01")).toEqual(refused("forbidden"));
    expect(await createMilestone(dave, kanban, "Stranger", "2027-03-01")).toEqual(refused("not_found"));
    expect(await createMilestone(dave, kanban, " ", null)).toEqual(refused("not_found"));
    expect(await createMilestone(alice, randomUUID(), "Missing", "2027-03-01")).toEqual(refused("not_found"));
    const createRejects = (args: [unknown, string | null, string | null], message: string, target = kanban) =>
      expect(createMilestone(alice, target, ...args)).rejects.toMatchObject({ code: "22023", message });
    for (const name of ["   ", "x".repeat(81), null]) await createRejects([name, "2027-03-01", null], "Invalid milestone");
    for (const due of [null, "infinity"]) await createRejects(["Launch", due, null], "Invalid milestone");
    expect(await createMilestone(alice, kanban, "x".repeat(80), "2027-03-02")).toMatchObject({ outcome: "ok", milestone_version: 1 });
    const plan = await waterfallProject(alice, workspace);
    const [first, second] = (await phasePlan(plan.project)).map((row) => row.id as string);
    // A phase link must name a phase of the same project; a Waterfall due date stays inside the project dates.
    for (const phase of [first!, randomUUID()]) await createRejects(["Launch", "2027-03-01", phase], "Invalid phase");
    for (const due of ["2026-11-01", "2026-12-12"]) await createRejects(["Launch", due, null], "Invalid milestone", plan.project);
    const linked = await createMilestone(alice, plan.project, "Demo", "2026-11-20", second!);
    expect(linked).toMatchObject({ outcome: "ok", milestone_version: 1 });

    expect(await updateMilestone(bob, milestone, 1, { name: "  Public beta  ", dueDate: "2027-03-15" })).toEqual({ outcome: "ok", milestone_version: 2 });
    expect(await updateMilestone(bob, milestone, 1, { name: "Stale" })).toEqual({ outcome: "version_mismatch", milestone_version: 2 });
    const notFound: MilestoneResult = { outcome: "not_found", milestone_version: null };
    expect(await updateMilestone(carol, milestone, 2, { completed: true })).toEqual({ outcome: "forbidden", milestone_version: null });
    expect(await updateMilestone(dave, milestone, 2, { completed: true })).toEqual(notFound);
    expect(await updateMilestone(dave, milestone, 2, { bogus: 1 })).toEqual(notFound);
    expect(await updateMilestone(alice, randomUUID(), 1, { completed: true })).toEqual(notFound);
    expect(await updateMilestone(bob, milestone, 2, { completed: true })).toEqual({ outcome: "ok", milestone_version: 3 });
    const completedAt = (await milestoneRows(kanban)).find((row) => row.id === milestone)!.completed_at;
    expect(completedAt).toBeInstanceOf(Date);
    // Completing again keeps the first completion and writes nothing.
    expect(await updateMilestone(bob, milestone, 3, { completed: true, name: "Public beta" })).toEqual({ outcome: "ok", milestone_version: 3 });
    expect((await milestoneRows(kanban)).find((row) => row.id === milestone)!.completed_at).toEqual(completedAt);
    expect(await updateMilestone(bob, milestone, 3, { completed: false })).toEqual({ outcome: "ok", milestone_version: 4 });
    expect((await milestoneRows(kanban)).find((row) => row.id === milestone)).toEqual({ id: milestone, name: "Public beta", phase_id: null, due_date: "2027-03-15",
      baseline_due_date: null, completed_at: null, version: 4 });
    const updateRejects = (patch: unknown, message: string, target = milestone, version = 4) =>
      expect(updateMilestone(alice, target, version, patch)).rejects.toMatchObject({ code: "22023", message });
    for (const patch of [{}, ["name"], "name", { due: "2027-03-01" }, { name: " " }, { name: "x".repeat(81) }, { name: null }, { dueDate: null },
      { dueDate: "2027-02-30" }, { dueDate: 20270301 }, { dueDate: "infinity" }, { completed: "yes" }, { completed: null }]) await updateRejects(patch, "Invalid milestone");
    for (const phaseId of [first, randomUUID(), "nope", 5]) await updateRejects({ phaseId }, "Invalid phase");

    const demo = linked.milestone_id!;
    expect(await updateMilestone(alice, demo, 1, { phaseId: first, dueDate: "2026-11-09" })).toEqual({ outcome: "ok", milestone_version: 2 });
    for (const dueDate of ["2026-11-01", "2026-12-12"]) await updateRejects({ dueDate }, "Invalid milestone", demo, 2);
    const otherPlan = await waterfallProject(alice, workspace);
    await updateRejects({ phaseId: (await phasePlan(otherPlan.project))[0]!.id }, "Invalid phase", demo, 2);
    expect(await updateMilestone(alice, demo, 2, { phaseId: null })).toEqual({ outcome: "ok", milestone_version: 3 });
    expect((await milestoneRows(plan.project)).find((row) => row.id === demo)).toMatchObject({ phase_id: null, due_date: "2026-11-09", baseline_due_date: null, version: 3 });
    await expect(asSession(newTokenHash(), `SELECT * FROM ${fn("ws_create_milestone")}($1,$2,$3,$4)`, [kanban, "No session", "2027-01-01", null])).rejects.toMatchObject({ code: "28000" });
  });
  it("keeps baselines immutable", async () => {
    const alice = await account("Baseline Keeper");
    const { workspace, project } = await waterfallProject(alice);
    const dayBefore = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const before = await phasePlan(project), milestonesBefore = await milestoneRows(project);
    expect(await savePhases(alice, project, 1, before.map((row) => phaseEntry(row.name, row.planned_start, dayBefore(row.planned_end), row.id))))
      .toEqual({ outcome: "ok", settings_version: 2 });
    const after = await phasePlan(project);
    expect(after.map((row) => row.planned_end)).toEqual(before.map((row) => dayBefore(row.planned_end)));
    expect(after.map((row) => [row.baseline_start, row.baseline_end])).toEqual(before.map((row) => [row.baseline_start, row.baseline_end]));
    for (const row of milestonesBefore) expect(await updateMilestone(alice, row.id, 1, { dueDate: "2026-11-20", completed: true })).toEqual({ outcome: "ok", milestone_version: 2 });
    const baselineOf = (rows: { id: string; baseline_due_date: string | null }[]) => Object.fromEntries(rows.map((row) => [row.id, row.baseline_due_date]));
    const milestonesAfter = await milestoneRows(project);
    expect(milestonesAfter.map((row) => row.due_date)).toEqual(milestonesBefore.map(() => "2026-11-20"));
    expect(baselineOf(milestonesAfter)).toEqual(baselineOf(milestonesBefore));
    // The runtime role cannot write baselines directly, and the internal helpers are not callable.
    await expect(asSession(alice.token, `UPDATE ${table("project_phases")} SET baseline_end=planned_end,version=version+1 WHERE project_id=$1`, [project])).rejects.toMatchObject({ code: "42501" });
    await expect(asSession(alice.token, `UPDATE ${table("project_milestones")} SET baseline_due_date=due_date,version=version+1 WHERE project_id=$1`, [project])).rejects.toMatchObject({ code: "42501" });
    await expect(asSession(alice.token, `SELECT ${fn("apply_phase_plan")}($1,$2,'2026-11-02','2026-12-11',$3,true)`, [workspace, project, JSON.stringify(waterfallPhases)]))
      .rejects.toMatchObject({ code: "42501" });
    await expect(asSession(alice.token, `SELECT ${fn("check_milestone_due")}('2026-11-20','2026-11-02','2026-12-11')`)).rejects.toMatchObject({ code: "42501" });
    expect(await phasePlan(project)).toEqual(after);
  });
  it("rebaselines with a reason and an audit row", async () => {
    const alice = await account("Rebaseline Owner"), bob = await account("Rebaseline Lead"), carol = await account("Rebaseline Member"), dave = await account("Rebaseline Stranger");
    const workspace = (await createWorkspace(alice)).workspace_id!;
    await addMember(workspace, bob, "member");
    await addMember(workspace, carol, "member");
    const { project } = await waterfallProject(alice, workspace, bob.id);
    const before = await phasePlan(project);
    const ids = before.map((row) => row.id as string);
    // Build ends later, Test and Deploy move, and Hypercare is new (no baseline yet).
    const plan = [...before.slice(0, 2).map((row) => phaseEntry(row.name, row.planned_start, row.planned_end, row.id)), phaseEntry("Build", "2026-11-18", "2026-11-30", ids[2]),
      phaseEntry("Test", "2026-12-01", "2026-12-04", ids[3]), phaseEntry("Deploy", "2026-12-05", "2026-12-08", ids[4]), phaseEntry("Hypercare", "2026-12-09", "2026-12-11")];
    expect(await savePhases(bob, project, 1, plan)).toEqual({ outcome: "ok", settings_version: 2 });
    expect((await createMilestone(bob, project, "Go live", "2026-12-08")).outcome).toBe("ok");
    const buildSignOff = (await milestoneRows(project)).find((row) => row.name === "Build sign-off")!;
    expect(await updateMilestone(bob, buildSignOff.id, 1, { dueDate: "2026-11-30" })).toEqual({ outcome: "ok", milestone_version: 2 });
    const baselinedAt = (await projectPlanState(project)).baselined_at!;

    const refused = (outcome: string): PlanResult => ({ outcome, settings_version: null });
    expect(await rebaseline(carol, project, 2, "Member")).toEqual(refused("forbidden"));
    expect(await rebaseline(dave, project, 2, "Stranger")).toEqual(refused("not_found"));
    expect(await rebaseline(dave, project, 2, " ")).toEqual(refused("not_found"));
    expect(await rebaseline(alice, randomUUID(), 1, "Missing")).toEqual(refused("not_found"));
    for (const reason of ["   ", "x".repeat(201), null])
      await expect(rebaseline(bob, project, 2, reason)).rejects.toMatchObject({ code: "22023", message: "Invalid baseline reason" });
    expect(await rebaseline(bob, project, 1, "Stale")).toEqual({ outcome: "version_mismatch", settings_version: 2 });
    const kanban = await kanbanProject(alice, workspace);
    expect(await rebaseline(dave, kanban.project, 1, "Kanban")).toEqual(refused("not_found"));
    await expect(rebaseline(alice, kanban.project, 1, "Kanban")).rejects.toMatchObject({ code: "22023", message: "Invalid methodology" });
    expect((await auditRows(project)).map((row) => row.action)).toEqual(["project.created"]);

    expect(await rebaseline(bob, project, 2, "  Scope grew after review  ")).toEqual({ outcome: "ok", settings_version: 3 });
    // Every baseline equals the plan; only rows whose baseline changed advanced their version.
    expect((await phasePlan(project)).map((row) => [row.name, row.planned_start, row.planned_end, row.baseline_start, row.baseline_end, row.version])).toEqual([
      ["Requirements", "2026-11-02", "2026-11-09", "2026-11-02", "2026-11-09", 1],
      ["Design", "2026-11-10", "2026-11-17", "2026-11-10", "2026-11-17", 1],
      ["Build", "2026-11-18", "2026-11-30", "2026-11-18", "2026-11-30", 3],
      ["Test", "2026-12-01", "2026-12-04", "2026-12-01", "2026-12-04", 3],
      ["Deploy", "2026-12-05", "2026-12-08", "2026-12-05", "2026-12-08", 3],
      ["Hypercare", "2026-12-09", "2026-12-11", "2026-12-09", "2026-12-11", 2],
    ]);
    expect((await milestoneRows(project)).map((row) => [row.name, row.due_date, row.baseline_due_date, row.version])).toEqual([
      ["Requirements sign-off", "2026-11-09", "2026-11-09", 1], ["Design sign-off", "2026-11-17", "2026-11-17", 1], ["Build sign-off", "2026-11-30", "2026-11-30", 3],
      ["Test sign-off", "2026-12-04", "2026-12-04", 1], ["Go live", "2026-12-08", "2026-12-08", 2], ["Deploy sign-off", "2026-12-11", "2026-12-11", 1],
    ]);
    const state = await projectPlanState(project);
    expect(state.settings_version).toBe(3);
    expect(state.baselined_at!.getTime()).toBeGreaterThan(baselinedAt.getTime());
    expect((await auditRows(project)).slice(1)).toEqual([{ action: "project.rebaselined", actor_user_id: bob.id, resource_type: "project", metadata: { reason: "Scope grew after review" } }]);
    expect(await rebaseline(alice, project, 3, "x".repeat(200))).toEqual({ outcome: "ok", settings_version: 4 });
    await expect(asSession(newTokenHash(), `SELECT * FROM ${fn("ws_rebaseline_project")}($1,$2,$3)`, [project, 4, "No session"])).rejects.toMatchObject({ code: "28000" });
  });
  it("edits column names and WIP limits", async () => {
    const alice = await account("Column Owner"), bob = await account("Column Lead"), carol = await account("Column Member"), dave = await account("Column Stranger");
    const workspace = (await createWorkspace(alice)).workspace_id!;
    await addMember(workspace, bob, "member");
    await addMember(workspace, carol, "member");
    const project = (await createProject(alice, workspace, { key: `C${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`, methodology: "kanban", lead: bob.id })).project_id!;
    const progress = await statusNamed(project, "In progress");
    const cards: string[] = [];
    for (const title of ["One", "Two", "Three"]) cards.push((await createIssue(alice, project, { title, status: progress })).issue_id!);
    const issuesBefore = await issueStates(project);
    const others = (await boardColumns(project)).filter((row) => row.id !== progress);
    const column = async () => (await boardColumns(project)).find((row) => row.id === progress)!;

    expect(await updateStatus(bob, progress, 1, "  Doing  ", 3)).toEqual({ outcome: "ok", settings_version: 2 });
    expect(await column()).toMatchObject({ name: "Doing", category: "in_progress", wip_limit: 3 });
    // Below the three cards in the column: refused, and nothing changes.
    expect(await updateStatus(bob, progress, 2, "Busy", 2)).toEqual({ outcome: "wip_below_occupancy", settings_version: null });
    expect(await column()).toMatchObject({ name: "Doing", wip_limit: 3 });
    expect((await projectSettings(project)).settings_version).toBe(2);
    // Names are unique in the project ignoring case; changing the case of the column's own name is fine.
    expect(await updateStatus(alice, progress, 2, " dONE ", null)).toEqual({ outcome: "name_taken", settings_version: null });
    expect(await updateStatus(alice, progress, 2, "DOING", null)).toEqual({ outcome: "ok", settings_version: 3 });
    // A call that changes nothing writes nothing.
    expect(await updateStatus(alice, progress, 3, "DOING", 3)).toEqual({ outcome: "ok", settings_version: 3 });
    expect(await updateStatus(alice, progress, 3, null, null)).toEqual({ outcome: "ok", settings_version: 3 });
    // Archived cards do not occupy the column.
    expect(await updateIssue(alice, cards[0]!, 1, { archived: true })).toMatchObject({ outcome: "ok" });
    expect(await updateStatus(alice, progress, 3, null, 2)).toEqual({ outcome: "ok", settings_version: 4 });
    expect(await updateStatus(alice, progress, 4, null, null, true)).toEqual({ outcome: "ok", settings_version: 5 });
    expect(await column()).toMatchObject({ name: "DOING", wip_limit: null, position: 3072 });

    const refused = (outcome: string): StatusResult => ({ outcome, settings_version: null });
    expect(await updateStatus(carol, progress, 5, "Member")).toEqual(refused("forbidden"));
    expect(await updateStatus(dave, progress, 5, "Stranger")).toEqual(refused("not_found"));
    expect(await updateStatus(dave, progress, 5, " ", 0)).toEqual(refused("not_found"));
    expect(await updateStatus(alice, randomUUID(), 5, "Missing")).toEqual(refused("not_found"));
    expect(await updateStatus(alice, progress, 4, "Stale")).toEqual({ outcome: "version_mismatch", settings_version: 5 });
    for (const name of ["   ", "x".repeat(41)])
      await expect(updateStatus(alice, progress, 5, name)).rejects.toMatchObject({ code: "22023", message: "Invalid status name" });
    for (const [wip, clear] of [[0, false], [100, false], [5, true]] as const)
      await expect(updateStatus(alice, progress, 5, null, wip, clear)).rejects.toMatchObject({ code: "22023", message: "Invalid WIP limit" });
    expect(await updateStatus(alice, progress, 5, "x".repeat(40), 99)).toEqual({ outcome: "ok", settings_version: 6 });
    expect((await boardColumns(project)).filter((row) => row.id !== progress)).toEqual(others);
    expect((await issueStates(project)).map((row) => row.version)).toEqual(issuesBefore.map((row) => (row.id === cards[0] ? 2 : 1)));
    // No audit row: column edits are plain settings changes (audited are membership, methodology and baselines).
    expect((await auditRows(project)).map((row) => row.action)).toEqual(["project.created"]);
    await owner.query(`UPDATE ${table("projects")} SET archived_at=now() WHERE id=$1`, [project]);
    expect(await updateStatus(alice, progress, 6, "Archived")).toEqual(refused("not_found"));
    await expect(asSession(newTokenHash(), `SELECT * FROM ${fn("ws_update_status")}($1,$2,$3,$4,$5)`, [progress, 6, "No session", null, false])).rejects.toMatchObject({ code: "28000" });
  });
  it("switches Kanban to Scrum", async () => {
    const alice = await account("Kanban Leaver");
    const { project } = await kanbanProject(alice);
    const [backlog, ready, progress, review, done] = await boardColumns(project);
    for (const row of [backlog!, ready!, progress!, done!]) await createIssue(alice, project, { status: row.id });
    const before = await issueStates(project);
    const result = await switchMethodology(alice, project, 1, { to: "scrum", sprintLength: 10, reason: "  Fixed release cadence  ",
      columns: [keepColumn(backlog!), keepColumn(ready!, { name: "To do", wipLimit: null }), keepColumn(progress!, { wipLimit: null }),
        keepColumn(review!, { name: "In review", wipLimit: null }), keepColumn(done!)] });
    expect(result).toEqual({ outcome: "ok", settings_version: 2, moved_issues: 0 });
    expect((await boardColumns(project)).map((row) => [row.id, row.name, row.category, row.position, row.wip_limit])).toEqual([
      [backlog!.id, "Backlog", "backlog", 1024, null], [ready!.id, "To do", "todo", 2048, null], [progress!.id, "In progress", "in_progress", 3072, null],
      [review!.id, "In review", "in_progress", 4096, null], [done!.id, "Done", "done", 5120, null]]);
    expect(await projectSettings(project)).toMatchObject({ methodology: "scrum", sprint_length_days: 10, settings_version: 2, baselined_at: null });
    // No issue moved, so none got a new version.
    expect(await issueStates(project)).toEqual(before);
    const periods = await methodologyPeriods(project);
    expect(periods).toEqual([
      { methodology: "kanban", started_at: expect.any(Date), ended_at: periods[1]!.started_at, changed_by_user_id: alice.id, reason: "Project created" },
      { methodology: "scrum", started_at: expect.any(Date), ended_at: null, changed_by_user_id: alice.id, reason: "Fixed release cadence" }]);
    expect((await auditRows(project)).slice(1)).toEqual([{ action: "project.methodology_switched", actor_user_id: alice.id, resource_type: "project", metadata: { from: "kanban", to: "scrum" } }]);
    await expectSwitchInvariants(project, before, "scrum");
    expect((await createSprint(alice, project, "Sprint 1")).outcome).toBe("ok");
  });
  it("refuses to leave Scrum with an active sprint", async () => {
    const alice = await account("Sprint Holder");
    const { project } = await scrumProject(alice);
    const sprint = (await createSprint(alice, project, "Current", null, "2026-11-02", "2026-11-16")).sprint_id!;
    await sprintIssue(alice, project, sprint);
    expect(await startSprint(alice, sprint, 1)).toMatchObject({ outcome: "ok" });
    const columns = (await boardColumns(project)).map((row) => keepColumn(row));
    const toKanban: SwitchInput = { to: "kanban", columns };
    expect(await switchMethodology(alice, project, 1, toKanban)).toEqual(refusedSwitch("active_sprint"));
    expect(await switchMethodology(alice, project, 1, { to: "waterfall", columns, start: "2026-11-02", target: "2026-12-11", phases: waterfallPhases }))
      .toEqual(refusedSwitch("active_sprint"));
    expect(await projectSettings(project)).toMatchObject({ methodology: "scrum", sprint_length_days: 14, settings_version: 1 });
    expect(await methodologyPeriods(project)).toHaveLength(1);
    expect(await phasePlan(project)).toEqual([]);
    // "Complete sprint now", then switch.
    expect(await completeSprint(alice, sprint, 2, null)).toMatchObject({ outcome: "ok", moved_issues: 1 });
    const before = await issueStates(project);
    expect(await switchMethodology(alice, project, 1, toKanban)).toEqual({ outcome: "ok", settings_version: 2, moved_issues: 0 });
    expect(await projectSettings(project)).toMatchObject({ methodology: "kanban", sprint_length_days: null });
    // The sprint stays as read-only history.
    expect(await sprintRow(sprint)).toMatchObject({ status: "completed", version: 3, committed_count: 1 });
    await expect(createSprint(alice, project, "Next")).rejects.toMatchObject({ code: "22023", message: "Invalid methodology" });
    await expectSwitchInvariants(project, before, "kanban");
  });
  it("switches Scrum to Waterfall with a phase plan", async () => {
    const alice = await account("Waterfall Enterer");
    const { project } = await scrumProject(alice);
    const [backlog, todo, progress, review, done] = await boardColumns(project);
    const finished = (await createSprint(alice, project, "Finished", null, "2026-10-01", "2026-10-15")).sprint_id!;
    const planned = (await createSprint(alice, project, "Planned", null, "2026-11-02", "2026-11-16")).sprint_id!;
    await sprintIssue(alice, project, finished, { status: done!.id });
    expect(await startSprint(alice, finished, 1)).toMatchObject({ outcome: "ok" });
    expect(await completeSprint(alice, finished, 2, null)).toMatchObject({ outcome: "ok", moved_issues: 0 });
    const plannedIssue = await sprintIssue(alice, project, planned, { status: backlog!.id });
    for (const title of ["Idea", "Wish"]) await createIssue(alice, project, { title, status: backlog!.id });
    await createIssue(alice, project, { title: "Started", status: progress!.id });
    const sprintsBefore = [await sprintRow(finished), await sprintRow(planned)];
    const before = await issueStates(project);
    const toWaterfall: SwitchInput = { to: "waterfall", start: "2026-11-02", target: "2026-12-11", phases: waterfallPhases, mapping: { [backlog!.id]: 0 },
      columns: [keepColumn(todo!, { name: "Not started" }), keepColumn(progress!), keepColumn(review!), keepColumn(done!)] };
    const rejects = (input: Partial<SwitchInput>, message: string) =>
      expect(switchMethodology(alice, project, 1, { ...toWaterfall, ...input })).rejects.toMatchObject({ code: "22023", message });
    // Dates and a phase plan are required; reversed dates are refused by the phase-plan helper itself.
    await rejects({ start: null }, "Invalid project dates");
    await rejects({ target: null }, "Invalid project dates");
    await rejects({ start: "2026-12-12" }, "Invalid project dates");
    for (const phases of [undefined, null, [], [phaseEntry("Build", "2026-11-01", "2026-11-09")],
      [phaseEntry("Build", "2026-11-02", "2026-11-09"), phaseEntry("Test", "2026-11-09", "2026-11-16")]]) await rejects({ phases }, "Invalid project phases");
    await rejects({ sprintLength: 14 }, "Invalid sprint length");
    expect(await projectSettings(project)).toMatchObject({ methodology: "scrum", settings_version: 1, start_date: null });
    expect(await phasePlan(project)).toEqual([]);

    // The Backlog column is removed and its three cards move to Not started; the one in the planned sprint also
    // returns to the backlog, in the same single change set.
    expect(await switchMethodology(alice, project, 1, toWaterfall)).toEqual({ outcome: "ok", settings_version: 2, moved_issues: 3 });
    const settings = await projectSettings(project);
    expect(settings).toMatchObject({ methodology: "waterfall", sprint_length_days: null, start_date: "2026-11-02", target_date: "2026-12-11", settings_version: 2 });
    expect(settings.baselined_at).toBeInstanceOf(Date);
    // New phases start with baseline = plan.
    expect((await phasePlan(project)).map((row) => [row.name, row.position, row.planned_start, row.planned_end, row.baseline_start, row.baseline_end, row.version]))
      .toEqual(waterfallPhases.map((phase, index) => [phase.name, index + 1, phase.plannedStart, phase.plannedEnd, phase.plannedStart, phase.plannedEnd, 1]));
    expect((await boardColumns(project)).map((row) => [row.id, row.name, row.position])).toEqual([
      [todo!.id, "Not started", 1024], [progress!.id, "In progress", 2048], [review!.id, "In review", 3072], [done!.id, "Done", 4096]]);
    // The completed sprint is kept as history; the planned one is cancelled. Every issue is unphased until someone plans it.
    expect(await sprintRow(finished)).toEqual(sprintsBefore[0]);
    expect(await sprintRow(planned)).toEqual({ ...sprintsBefore[1], status: "cancelled", version: 2 });
    expect((await issueStates(project)).every((row) => row.phase_id === null)).toBe(true);
    expect(await issueVersion(plannedIssue)).toBe(3);
    expect((await issueEvents(plannedIssue)).at(-1)).toMatchObject({ from_version: 2, to_version: 3, changes: { fields: ["statusId", "sprintId"],
      after: { statusId: todo!.id, category: "todo", sprintId: null, archived: false } } });
    await expectSwitchInvariants(project, before, "waterfall", [plannedIssue]);
    expect((await auditRows(project)).slice(1)).toEqual([{ action: "project.methodology_switched", actor_user_id: alice.id, resource_type: "project", metadata: { from: "scrum", to: "waterfall" } }]);
  });
  it("switches Waterfall to Kanban keeping phases and milestones read-only", async () => {
    const alice = await account("Waterfall Leaver");
    const { project } = await waterfallProject(alice);
    const [notStarted, progress, review, done] = await boardColumns(project);
    const phases = await phasePlan(project);
    for (let index = 0; index < 5; index++) await createIssue(alice, project, { title: `Build ${index}`, status: progress!.id, phase: phases[2]!.id });
    await createIssue(alice, project, { title: "Unphased", status: notStarted!.id });
    const milestones = await milestoneRows(project);
    const before = await issueStates(project);
    const toKanban = (wipLimit: number): SwitchInput => ({ to: "kanban", columns: [{ name: "Backlog", category: "backlog", wipLimit: null },
      keepColumn(notStarted!, { name: "Ready", wipLimit: 8 }), keepColumn(progress!, { wipLimit }), keepColumn(review!, { name: "Review", wipLimit: 3 }), keepColumn(done!)] });
    // The template proposes 4 in progress, but five cards are there.
    expect(await switchMethodology(alice, project, 1, toKanban(4))).toEqual(refusedSwitch("wip_below_occupancy"));
    expect(await boardColumns(project)).toEqual([notStarted, progress, review, done]);
    expect(await projectSettings(project)).toMatchObject({ methodology: "waterfall", settings_version: 1 });
    expect(await switchMethodology(alice, project, 1, toKanban(5))).toEqual({ outcome: "ok", settings_version: 2, moved_issues: 0 });
    expect((await boardColumns(project)).map((row) => [row.name, row.category, row.position, row.wip_limit])).toEqual([
      ["Backlog", "backlog", 1024, null], ["Ready", "todo", 2048, 8], ["In progress", "in_progress", 3072, 5], ["Review", "in_progress", 4096, 3], ["Done", "done", 5120, null]]);
    expect(await phasePlan(project)).toEqual(phases);
    expect(await milestoneRows(project)).toEqual(milestones);
    const settings = await projectSettings(project);
    expect(settings).toMatchObject({ methodology: "kanban", start_date: "2026-11-02", target_date: "2026-12-11", sprint_length_days: null });
    await expectSwitchInvariants(project, before, "kanban");
    // Phases are read-only history now; milestones keep working.
    await expect(savePhases(alice, project, 2, phases.map((row) => phaseEntry(row.name, row.planned_start, row.planned_end, row.id))))
      .rejects.toMatchObject({ code: "22023", message: "Invalid methodology" });
    expect(await updateMilestone(alice, milestones[0]!.id, 1, { completed: true })).toEqual({ outcome: "ok", milestone_version: 2 });
    expect((await createMilestone(alice, project, "Kanban release", "2026-12-01", phases[4]!.id)).outcome).toBe("ok");

    // Kanban to Waterfall again: the old phases are kept by id (baselines untouched), a new one gets baseline = plan.
    const kanbanColumns = await boardColumns(project);
    const beforeReturn = await issueStates(project);
    const plan = [...phases.map((row) => phaseEntry(row.name, row.planned_start, row.planned_end, row.id)), phaseEntry("Hypercare", "2026-12-12", "2026-12-18")];
    expect(await switchMethodology(alice, project, 2, { to: "waterfall", start: "2026-11-02", target: "2026-12-18", phases: plan, mapping: { [kanbanColumns[0]!.id]: 0 },
      columns: [keepColumn(kanbanColumns[1]!, { name: "Not started", wipLimit: null }), keepColumn(kanbanColumns[2]!, { wipLimit: null }),
        keepColumn(kanbanColumns[3]!, { name: "In review", wipLimit: null }), keepColumn(kanbanColumns[4]!)] })).toEqual({ outcome: "ok", settings_version: 3, moved_issues: 0 });
    const replanned = await phasePlan(project);
    expect(replanned.slice(0, 5)).toEqual(phases);
    expect(replanned[5]).toMatchObject({ name: "Hypercare", position: 6, planned_start: "2026-12-12", planned_end: "2026-12-18", baseline_start: "2026-12-12", baseline_end: "2026-12-18", version: 1 });
    expect(await projectSettings(project)).toMatchObject({ methodology: "waterfall", target_date: "2026-12-18", settings_version: 3, baselined_at: settings.baselined_at });
    expect(await countRows(`${table("issue_statuses")} WHERE id=$1`, [kanbanColumns[0]!.id])).toBe(0);
    await expectSwitchInvariants(project, beforeReturn, "waterfall");
    expect((await methodologyPeriods(project)).map((row) => row.methodology)).toEqual(["waterfall", "kanban", "waterfall"]);
    expect((await savePhases(alice, project, 3, plan.slice(0, 5))).outcome).toBe("ok");
  });
  it("switches Scrum to Kanban and Waterfall to Scrum", async () => {
    const alice = await account("Reverse Switcher");
    const scrum = await scrumProject(alice);
    const [backlog, todo, progress, review, done] = await boardColumns(scrum.project);
    const sprint = (await createSprint(alice, scrum.project, "Planned", null, "2026-11-02", "2026-11-16")).sprint_id!;
    const planned = await sprintIssue(alice, scrum.project, sprint, { status: todo!.id });
    const reviewed = (await createIssue(alice, scrum.project, { status: review!.id })).issue_id!;
    const scrumBefore = await issueStates(scrum.project);
    // In review is replaced by a new Review column with the Kanban template limit.
    expect(await switchMethodology(alice, scrum.project, 1, { to: "kanban", mapping: { [review!.id]: 3 },
      columns: [keepColumn(backlog!), keepColumn(todo!, { name: "Ready", wipLimit: 8 }), keepColumn(progress!, { wipLimit: 4 }),
        { name: "Review", category: "in_progress", wipLimit: 3 }, keepColumn(done!)] })).toEqual({ outcome: "ok", settings_version: 2, moved_issues: 2 });
    const kanbanColumns = await boardColumns(scrum.project);
    expect(kanbanColumns.map((row) => [row.name, row.wip_limit])).toEqual([["Backlog", null], ["Ready", 8], ["In progress", 4], ["Review", 3], ["Done", null]]);
    expect((await issueStates(scrum.project)).find((row) => row.id === reviewed)).toMatchObject({ status_id: kanbanColumns[3]!.id, version: 2 });
    expect(await projectSettings(scrum.project)).toMatchObject({ methodology: "kanban", sprint_length_days: null });
    // Leaving Scrum cancels the planned sprint and returns its open issue to the backlog.
    expect(await sprintRow(sprint)).toMatchObject({ status: "cancelled", version: 2 });
    expect((await issueStates(scrum.project)).find((row) => row.id === planned)).toMatchObject({ status_id: todo!.id, sprint_id: null, version: 3 });
    await expectSwitchInvariants(scrum.project, scrumBefore, "kanban", [planned]);

    const waterfall = await waterfallProject(alice);
    const [notStarted, building, reviewing, finished] = await boardColumns(waterfall.project);
    const phases = await phasePlan(waterfall.project);
    await createIssue(alice, waterfall.project, { status: building!.id, phase: phases[2]!.id });
    await createIssue(alice, waterfall.project, { status: notStarted!.id, phase: phases[0]!.id });
    const waterfallBefore = await issueStates(waterfall.project);
    // Without a sprint length the project gets the default of 14 days; open issues stay in the backlog.
    expect(await switchMethodology(alice, waterfall.project, 1, { to: "scrum",
      columns: [{ name: "Backlog", category: "backlog", wipLimit: null }, keepColumn(notStarted!, { name: "To do" }), keepColumn(building!), keepColumn(reviewing!), keepColumn(finished!)] }))
      .toEqual({ outcome: "ok", settings_version: 2, moved_issues: 0 });
    expect(await projectSettings(waterfall.project)).toMatchObject({ methodology: "scrum", sprint_length_days: 14 });
    expect((await issueStates(waterfall.project)).every((row) => row.sprint_id === null)).toBe(true);
    expect(await phasePlan(waterfall.project)).toEqual(phases);
    await expectSwitchInvariants(waterfall.project, waterfallBefore, "scrum");
  });
  it("cancels planned sprints when leaving Scrum, so re-entering Scrum starts from the backlog", async () => {
    const alice = await account("Scrum Returner");
    const { project } = await scrumProject(alice);
    const columns = await boardColumns(project);
    const [, todo, progress, , done] = columns;
    // A completed sprint with a finished issue and one reopened afterwards: history, untouched by the switch.
    const completed = (await createSprint(alice, project, "Shipped", null, "2026-10-01", "2026-10-15")).sprint_id!;
    const shipped = await sprintIssue(alice, project, completed, { title: "Shipped", status: done!.id });
    const reopened = await sprintIssue(alice, project, completed, { title: "Reopened", status: done!.id });
    expect(await startSprint(alice, completed, 1)).toMatchObject({ outcome: "ok" });
    expect(await completeSprint(alice, completed, 2, null)).toMatchObject({ outcome: "ok", moved_issues: 0 });
    expect(await updateIssue(alice, reopened, 2, { statusId: todo!.id })).toMatchObject({ outcome: "ok", issue_version: 3 });
    // Two planned sprints: their open issues return to the backlog; done and archived ones keep their sprint.
    const next = (await createSprint(alice, project, "Next", null, "2026-11-02", "2026-11-16")).sprint_id!;
    const later = (await createSprint(alice, project, "Later")).sprint_id!;
    const nextOpen = [await sprintIssue(alice, project, next, { title: "Plan A", status: todo!.id, points: "5" }),
      await sprintIssue(alice, project, next, { title: "Plan B", status: progress!.id })];
    const nextDone = await sprintIssue(alice, project, next, { title: "Plan done", status: done!.id });
    const nextArchived = await sprintIssue(alice, project, next, { title: "Plan shelved", status: todo!.id });
    expect(await updateIssue(alice, nextArchived, 2, { archived: true })).toMatchObject({ outcome: "ok", issue_version: 3 });
    const laterOpen = await sprintIssue(alice, project, later, { title: "Plan C", status: todo!.id });
    const completedBefore = await sprintRow(completed);
    const before = await issueStates(project);
    const moved = [...nextOpen, laterOpen];

    expect(await switchMethodology(alice, project, 1, { to: "kanban", columns: columns.map((row) => keepColumn(row)) }))
      .toEqual({ outcome: "ok", settings_version: 2, moved_issues: 3 });
    expect(await sprintRow(completed)).toEqual(completedBefore);
    expect(await sprintRow(next)).toMatchObject({ status: "cancelled", version: 2, started: false, completed: false });
    expect(await sprintRow(later)).toMatchObject({ status: "cancelled", version: 2 });
    const versions = new Map(before.map((row) => [row.id, row.version]));
    for (const issue of moved) {
      const from = versions.get(issue)!;
      const state = (await issueStates(project)).find((row) => row.id === issue)!;
      expect(state).toMatchObject({ sprint_id: null, version: from + 1 });
      expect((await issueEvents(issue)).at(-1)).toEqual({ event_type: "issue.updated", actor_user_id: alice.id, from_version: from, to_version: from + 1, changes: {
        fields: ["sprintId"], after: { statusId: state.status_id, category: state.status_id === todo!.id ? "todo" : "in_progress", assigneeUserId: null,
          storyPoints: issue === nextOpen[0] ? 5 : null, phaseId: null, sprintId: null, archived: false } } });
      expect(await countRows(`${table("outbox_events")} WHERE aggregate_type='issue' AND aggregate_id=$1 AND aggregate_version=$2 AND event_type='issue.updated' AND processed_at IS NOT NULL`, [issue, from + 1])).toBe(1);
    }
    // Done and archived issues of the cancelled sprint, and every issue of the completed sprint, are untouched.
    for (const issue of [shipped, reopened, nextDone, nextArchived])
      expect((await issueStates(project)).find((row) => row.id === issue)).toEqual(before.find((row) => row.id === issue));
    await expectSwitchInvariants(project, before, "kanban", moved);

    // Back to Scrum: no planned sprint comes back, and the open issues are in the backlog.
    const kanbanBefore = await issueStates(project);
    expect(await switchMethodology(alice, project, 2, { to: "scrum", columns: (await boardColumns(project)).map((row) => keepColumn(row)) }))
      .toEqual({ outcome: "ok", settings_version: 3, moved_issues: 0 });
    expect(await countRows(`${table("sprints")} WHERE project_id=$1 AND status IN ('planned','active')`, [project])).toBe(0);
    expect(await issueStates(project)).toEqual(kanbanBefore);
    await expectSwitchInvariants(project, kanbanBefore, "scrum");
    expect((await createSprint(alice, project, "Fresh start")).outcome).toBe("ok");
  });
  it("maps removed columns and moves every issue", async () => {
    const alice = await account("Column Mapper");
    const { project } = await kanbanProject(alice);
    const [backlog, ready, progress, review, done] = await boardColumns(project);
    const resting = (await createIssue(alice, project, { title: "Resting", status: backlog!.id })).issue_id!;
    const started = (await createIssue(alice, project, { title: "Started", status: progress!.id })).issue_id!;
    const fromReady = [(await createIssue(alice, project, { title: "Ready 1", status: ready!.id })).issue_id!, (await createIssue(alice, project, { title: "Ready 2", status: ready!.id })).issue_id!];
    const reviewOpen = (await createIssue(alice, project, { title: "In review", status: review!.id, points: "3" })).issue_id!;
    const reviewArchived = (await createIssue(alice, project, { title: "Shelved", status: review!.id })).issue_id!;
    expect(await updateIssue(alice, reviewArchived, 1, { archived: true })).toMatchObject({ outcome: "ok", issue_version: 2 });
    const before = await issueStates(project);
    const columns = (progressLimit: number | null, todoLimit: number | null = null) => [keepColumn(backlog!), { name: "To do", category: "todo", wipLimit: todoLimit },
      keepColumn(progress!, { wipLimit: progressLimit }), keepColumn(done!)];
    const mapping = { [ready!.id]: 1, [review!.id]: 2 };
    // Occupancy after the remap counts the cards that would arrive, but not archived ones.
    expect(await switchMethodology(alice, project, 1, { to: "scrum", columns: columns(1), mapping })).toEqual(refusedSwitch("wip_below_occupancy"));
    expect(await switchMethodology(alice, project, 1, { to: "scrum", columns: columns(2, 1), mapping })).toEqual(refusedSwitch("wip_below_occupancy"));
    expect(await issueStates(project)).toEqual(before);
    expect(await boardColumns(project)).toEqual([backlog, ready, progress, review, done]);

    expect(await switchMethodology(alice, project, 1, { to: "scrum", columns: columns(2, 2), mapping })).toEqual({ outcome: "ok", settings_version: 2, moved_issues: 4 });
    const after = await boardColumns(project);
    expect(after.map((row) => [row.name, row.category, row.position, row.wip_limit])).toEqual([
      ["Backlog", "backlog", 1024, null], ["To do", "todo", 2048, 2], ["In progress", "in_progress", 3072, 2], ["Done", "done", 4096, null]]);
    const todo = after[1]!.id;
    expect(await countRows(`${table("issue_statuses")} WHERE id = ANY($1::uuid[])`, [[ready!.id, review!.id]])).toBe(0);
    expect(await countRows(`${table("issues")} i WHERE i.project_id=$1 AND NOT EXISTS (SELECT 1 FROM ${table("issue_statuses")} s WHERE s.id=i.status_id AND s.project_id=i.project_id)`, [project])).toBe(0);
    // Each moved issue is one change set: version + 1, one issue.updated event and one processed outbox row.
    const targets = new Map([[fromReady[0]!, [todo, "todo"]], [fromReady[1]!, [todo, "todo"]], [reviewOpen, [progress!.id, "in_progress"]], [reviewArchived, [progress!.id, "in_progress"]]]);
    const versions = new Map(before.map((row) => [row.id, row.version]));
    for (const [issue, [statusId, category]] of targets) {
      const from = versions.get(issue)!;
      expect(await issueVersion(issue)).toBe(from + 1);
      expect((await issueEvents(issue)).at(-1)).toEqual({ event_type: "issue.updated", actor_user_id: alice.id, from_version: from, to_version: from + 1, changes: {
        fields: ["statusId"], after: { statusId, category, assigneeUserId: null, storyPoints: issue === reviewOpen ? 3 : null, phaseId: null, sprintId: null, archived: issue === reviewArchived } } });
      expect(await countRows(`${table("outbox_events")} WHERE aggregate_type='issue' AND aggregate_id=$1 AND aggregate_version=$2 AND event_type='issue.updated' AND processed_at IS NOT NULL`, [issue, from + 1])).toBe(1);
    }
    for (const issue of [resting, started]) expect(await issueVersion(issue)).toBe(1);
    // Moved cards land after the cards already in the target column, in their old order; archived ones stay off the board.
    expect(await columnOrder(todo)).toEqual(fromReady);
    expect(await columnOrder(progress!.id)).toEqual([started, reviewOpen]);
    expect((await issueStates(project)).find((row) => row.id === reviewArchived)).toMatchObject({ status_id: progress!.id, archived: true });
    await expectSwitchInvariants(project, before, "scrum");
  });
  it("rejects incomplete mappings and category changes of referenced columns", async () => {
    const alice = await account("Mapping Checker");
    const { workspace, project } = await kanbanProject(alice);
    const other = await kanbanProject(alice, workspace);
    const foreign = (await boardColumns(other.project))[0]!.id;
    const [backlog, ready, progress, review, done] = await boardColumns(project);
    await createIssue(alice, project, { status: ready!.id });
    const archived = (await createIssue(alice, project, { status: progress!.id })).issue_id!;
    expect(await updateIssue(alice, archived, 1, { archived: true })).toMatchObject({ outcome: "ok" });
    const columns = [keepColumn(backlog!), keepColumn(ready!), keepColumn(progress!), keepColumn(done!)];
    const valid: SwitchInput = { to: "scrum", columns, mapping: { [review!.id]: 2 } };
    const rejects = (input: Partial<SwitchInput>, message: string) =>
      expect(switchMethodology(alice, project, 1, { ...valid, ...input })).rejects.toMatchObject({ code: "22023", message });
    // Every removed status needs exactly one mapping to an existing index of the column list.
    for (const mapping of [undefined, null, "map", [2], { [review!.id]: 4 }, { [review!.id]: -1 }, { [review!.id]: 1.5 }, { [review!.id]: "2" }, { [review!.id]: null },
      { [review!.id]: 2, [ready!.id]: 1 }, { [review!.id]: 2, [randomUUID()]: 1 }, { [review!.id]: 2, [foreign]: 1 }, { [review!.id]: 2, nope: 1 }]) await rejects({ mapping }, "Invalid status mapping");
    await rejects({ columns: [columns[0]!, ...columns.slice(2)], mapping: { [review!.id]: 1 } }, "Invalid status mapping");
    // Kept ids must be distinct statuses of this project.
    for (const id of [foreign, randomUUID(), "nope", 5, null])
      await rejects({ columns: [{ ...columns[0]!, id }, ...columns.slice(1)], mapping: { [review!.id]: 2, [backlog!.id]: 0 } }, "Invalid status mapping");
    await rejects({ columns: [...columns, keepColumn(backlog!, { name: "Again" })] }, "Invalid status mapping");
    // A referenced column (archived cards count) keeps its category: add a new column and map to it instead.
    await rejects({ columns: [columns[0]!, keepColumn(ready!, { category: "in_progress" }), ...columns.slice(2)] }, "Invalid status mapping");
    await rejects({ columns: [...columns.slice(0, 2), keepColumn(progress!, { category: "todo" }), columns[3]!] }, "Invalid status mapping");
    // The column list follows the M2 status rules.
    const thirteen = Array.from({ length: 13 }, (_, index) => ({ name: `Column ${index}`, category: index === 12 ? "done" : "todo", wipLimit: null }));
    for (const shape of [null, "columns", [], [columns[3]], thirteen, [{ ...columns[0]!, color: "red" }, ...columns.slice(1)],
      [keepColumn(backlog!, { name: "  " }), ...columns.slice(1)], [keepColumn(backlog!, { name: "x".repeat(41) }), ...columns.slice(1)],
      [keepColumn(backlog!, { category: "blocked" }), ...columns.slice(1)], [{ name: 5, category: "todo", wipLimit: null }, ...columns],
      ...[0, 100, 1.5, "3"].map((wipLimit) => [keepColumn(backlog!, { wipLimit: wipLimit as number }), ...columns.slice(1)]),
      [...columns, { name: " in PROGRESS ", category: "in_progress", wipLimit: null }],
      columns.slice(0, 3), [keepColumn(backlog!, { category: "done" }), keepColumn(ready!, { category: "done" }), keepColumn(progress!, { category: "done" }), columns[3]]])
      await rejects({ columns: shape }, "Invalid project statuses");
    expect(await boardColumns(project)).toEqual([backlog, ready, progress, review, done]);
    expect((await projectSettings(project)).settings_version).toBe(1);
    // An unreferenced kept column may change its category; kept columns may swap names, and a new column may
    // take the name of a removed one.
    expect(await switchMethodology(alice, project, 1, { ...valid, mapping: { [review!.id]: 3 }, columns: [keepColumn(backlog!, { name: "Inbox", category: "todo" }),
      keepColumn(ready!, { name: "In progress" }), keepColumn(progress!, { name: "Ready" }), { name: "Review", category: "in_progress", wipLimit: null }, columns[3]!] }))
      .toEqual({ outcome: "ok", settings_version: 2, moved_issues: 0 });
    const after = await boardColumns(project);
    expect(after.map((row) => [row.name, row.category])).toEqual([["Inbox", "todo"], ["In progress", "todo"], ["Ready", "in_progress"], ["Review", "in_progress"], ["Done", "done"]]);
    expect(after.slice(0, 3).map((row) => row.id)).toEqual([backlog!.id, ready!.id, progress!.id]);
    expect(after[3]!.id).not.toBe(review!.id);
  });
  it("guards the methodology switch", async () => {
    const alice = await account("Switch Owner"), bob = await account("Switch Lead"), carol = await account("Switch Member"), dave = await account("Switch Stranger");
    const workspace = (await createWorkspace(alice)).workspace_id!;
    await addMember(workspace, bob, "member");
    await addMember(workspace, carol, "member");
    const project = (await createProject(alice, workspace, { key: `G${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`, methodology: "kanban", lead: bob.id })).project_id!;
    const toScrum: SwitchInput = { to: "scrum", columns: (await boardColumns(project)).map((row) => keepColumn(row, { wipLimit: null })) };
    expect(await switchMethodology(carol, project, 1, toScrum)).toEqual(refusedSwitch("forbidden"));
    expect(await switchMethodology(dave, project, 1, toScrum)).toEqual(refusedSwitch("not_found"));
    // Strangers learn nothing from invalid input either.
    expect(await switchMethodology(dave, project, 1, { to: "agile", columns: "x", reason: " " })).toEqual(refusedSwitch("not_found"));
    expect(await switchMethodology(alice, randomUUID(), 1, toScrum)).toEqual(refusedSwitch("not_found"));
    expect(await switchMethodology(bob, project, 2, toScrum)).toEqual({ outcome: "version_mismatch", settings_version: 1, moved_issues: null });
    expect(await switchMethodology(bob, project, 1, { ...toScrum, to: "kanban" })).toEqual(refusedSwitch("same_methodology"));
    const rejects = (input: Partial<SwitchInput>, message: string) =>
      expect(switchMethodology(bob, project, 1, { ...toScrum, ...input })).rejects.toMatchObject({ code: "22023", message });
    for (const to of ["agile", null, "Scrum"]) await rejects({ to }, "Invalid methodology");
    for (const reason of ["   ", "x".repeat(201), null]) await rejects({ reason }, "Invalid switch reason");
    for (const sprintLength of [6, 29]) await rejects({ sprintLength }, "Invalid sprint length");
    // Dates and phases belong to a switch into Waterfall only.
    await rejects({ start: "2026-11-02", target: "2026-12-11" }, "Invalid project dates");
    await rejects({ phases: waterfallPhases }, "Invalid project phases");
    expect(await projectSettings(project)).toMatchObject({ methodology: "kanban", settings_version: 1 });
    expect(await methodologyPeriods(project)).toHaveLength(1);
    expect(await switchMethodology(bob, project, 1, { ...toScrum, sprintLength: 28, reason: "x".repeat(200) })).toEqual({ outcome: "ok", settings_version: 2, moved_issues: 0 });
    expect((await auditRows(project)).at(-1)).toMatchObject({ action: "project.methodology_switched", actor_user_id: bob.id });
    await owner.query(`UPDATE ${table("projects")} SET archived_at=now() WHERE id=$1`, [project]);
    expect(await switchMethodology(alice, project, 2, { ...toScrum, to: "kanban" })).toEqual(refusedSwitch("not_found"));
    await expect(asSession(newTokenHash(), switchCall, switchArgs(project, 2, { ...toScrum, to: "kanban" }))).rejects.toMatchObject({ code: "28000" });
    // The runtime role cannot write statuses or periods directly.
    await expect(asSession(alice.token, `UPDATE ${table("issue_statuses")} SET wip_limit=1 WHERE project_id=$1`, [project])).rejects.toMatchObject({ code: "42501" });
    await expect(asSession(alice.token, `UPDATE ${table("project_methodology_periods")} SET reason='x' WHERE project_id=$1`, [project])).rejects.toMatchObject({ code: "42501" });
  });
  it("serializes a methodology switch and an issue move on the project lock", async () => {
    const alice = await account("Switch Racer"), bob = await account("Move Racer");
    const { workspace, project } = await kanbanProject(alice);
    await addMember(workspace, bob, "member");
    const [backlog, ready, progress, review, done] = await boardColumns(project);
    const onReview = (await createIssue(alice, project, { title: "Reviewing", status: review!.id })).issue_id!;
    const onBacklog = (await createIssue(alice, project, { title: "Waiting", status: backlog!.id })).issue_id!;
    // The switch holds the project lock; the move waits, then finds its card already moved by the switch.
    let clients = await sessionPair([alice, bob]);
    try {
      const [one, two] = clients;
      const args = switchArgs(project, 1, { to: "scrum", columns: [keepColumn(backlog!), keepColumn(ready!), keepColumn(progress!), keepColumn(done!)], mapping: { [review!.id]: 2 } });
      expect((await one.query(switchCall, args)).rows[0]).toEqual({ outcome: "ok", settings_version: 2, moved_issues: 1 });
      const pid = await backendPid(two);
      const move = two.query(updateIssueCall, [onReview, 1, JSON.stringify({ statusId: done!.id })]);
      expect(await waitUntilBlocked(pid)).toBe(true);
      await one.query("COMMIT");
      expect((await move).rows[0]).toEqual({ outcome: "version_mismatch", issue_version: 2 });
      await two.query("COMMIT");
    } finally { await closePair(clients); }
    expect((await issueStates(project)).find((row) => row.id === onReview)).toMatchObject({ status_id: progress!.id, version: 2 });
    // The other way round: a move into Ready commits first, and the waiting switch moves that card on as well.
    clients = await sessionPair([bob, alice]);
    try {
      const [one, two] = clients;
      expect((await one.query(updateIssueCall, [onBacklog, 1, JSON.stringify({ statusId: ready!.id })])).rows[0]).toEqual({ outcome: "ok", issue_version: 2 });
      const pid = await backendPid(two);
      const args = switchArgs(project, 2, { to: "kanban", columns: [keepColumn(backlog!), keepColumn(progress!), keepColumn(done!)], mapping: { [ready!.id]: 0 } });
      const switched = two.query(switchCall, args);
      expect(await waitUntilBlocked(pid)).toBe(true);
      await one.query("COMMIT");
      expect((await switched).rows[0]).toEqual({ outcome: "ok", settings_version: 3, moved_issues: 1 });
      await two.query("COMMIT");
    } finally { await closePair(clients); }
    expect((await issueStates(project)).find((row) => row.id === onBacklog)).toMatchObject({ status_id: backlog!.id, version: 3 });
    expect((await issueEvents(onBacklog)).map((row) => row.to_version)).toEqual([1, 2, 3]);
    expect((await boardColumns(project)).map((row) => row.name)).toEqual(["Backlog", "In progress", "Done"]);
    expect((await methodologyPeriods(project)).map((row) => row.methodology)).toEqual(["kanban", "scrum", "kanban"]);
  });
});

// M5 insight reads (0026). Fixtures are written by the table owner after the full migration: every issue
// version is one change set (issue row, issue_events row with a back-dated created_at, processed outbox row),
// so the deferred check_issue_change_set trigger accepts the history.
const DAY_MS = 24 * 60 * 60 * 1000;
const dayFromToday = (offset = 0) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const utcAt = (day: string, time = "00:00:00") => `${day}T${time}Z`;
const iso = (value: string | Date | null) => (value === null ? null : new Date(value).toISOString());
type Category = "backlog" | "todo" | "in_progress" | "done";
type InsightProject = { owner: Account; workspace: string; project: string; statuses: Record<Category, string>; next: number };
type Snapshot = { category: Category; sprint?: string | null; assignee?: string | null; points?: number | null; archived?: boolean };
// after: null writes an event without a snapshot (the replay ignores it; the issue row keeps its state).
type HistoryStep = { at: string; after: Snapshot | null };
type IssueCurrent = { due?: string | null; startedAt?: string | null; completedAt?: string | null };
// A project with one status per category (no WIP limits) and its open methodology period.
async function insightProject(who: Account, workspace?: string): Promise<InsightProject> {
  const tenant = workspace ?? (await createWorkspace(who)).workspace_id!;
  const project = randomUUID();
  const statuses: Record<Category, string> = { backlog: randomUUID(), todo: randomUUID(), in_progress: randomUUID(), done: randomUUID() };
  const key = `I${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
  await owner.query("SET ROLE spark_owner");
  await owner.query("BEGIN");
  try {
    await owner.query(`INSERT INTO ${table("projects")} (id,tenant_id,key,name) VALUES ($1,$2,$3,'Insights')`, [project, tenant, key]);
    await owner.query(`INSERT INTO ${table("boards")} (tenant_id,project_id,name) VALUES ($1,$2,'Board')`, [tenant, project]);
    await owner.query(`INSERT INTO ${table("issue_statuses")} (id,tenant_id,project_id,name,category,position) VALUES
      ($3,$1,$2,'Backlog','backlog',1),($4,$1,$2,'To do','todo',2),($5,$1,$2,'Doing','in_progress',3),($6,$1,$2,'Done','done',4)`,
      [tenant, project, statuses.backlog, statuses.todo, statuses.in_progress, statuses.done]);
    await owner.query(`INSERT INTO ${table("project_methodology_periods")} (tenant_id,project_id,methodology,changed_by_user_id,reason) VALUES ($1,$2,'kanban',$3,'Created by test')`, [tenant, project, who.id]);
    await owner.query("COMMIT");
  } catch (error) { await owner.query("ROLLBACK"); throw error; }
  return { owner: who, workspace: tenant, project, statuses, next: 0 };
}
// Writes one issue with a back-dated history, one change set per step: the issue row at version n, its
// issue_events row (created_at = step.at, the M3/M4 change shape) and a processed outbox row. completed_at
// follows the guard (set while done: current.completedAt or the time it became done); archived_at is set while
// archived. Returns the issue id.
async function issueHistory(fx: InsightProject, steps: HistoryStep[], current: IssueCurrent = {}) {
  const id = randomUUID(), number = ++fx.next;
  await owner.query("SET ROLE spark_owner");
  await owner.query("BEGIN");
  try {
    let state: Snapshot | null = null, doneSince: string | null = null, archivedSince: string | null = null;
    for (const [index, step] of steps.entries()) {
      state = step.after ?? state;
      if (!state) throw new Error("The first step needs a snapshot");
      doneSince = state.category === "done" ? doneSince ?? step.at : null;
      archivedSince = state.archived ? archivedSince ?? step.at : null;
      const completedAt = state.category === "done" ? current.completedAt ?? doneSince : null;
      const values = [id, fx.workspace, fx.project, fx.statuses[state.category], state.assignee ?? null, state.sprint ?? null, state.points ?? null, archivedSince, completedAt, index + 1];
      await owner.query("SET CONSTRAINTS ALL DEFERRED");
      if (index === 0) {
        await owner.query(`INSERT INTO ${table("issues")} (id,tenant_id,project_id,status_id,assignee_user_id,sprint_id,story_points,archived_at,completed_at,version,
          number,title,reporter_user_id,created_at,due_date,started_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Insight',$12,$13,$14,$15)`,
          [...values, number, fx.owner.id, step.at, current.due ?? null, current.startedAt ?? null]);
      } else {
        await owner.query(`UPDATE ${table("issues")} SET status_id=$4,assignee_user_id=$5,sprint_id=$6,story_points=$7,archived_at=$8,completed_at=$9,version=$10
          WHERE id=$1 AND tenant_id=$2 AND project_id=$3`, values);
      }
      const changes = step.after
        ? { fields: [], after: { statusId: fx.statuses[state.category], category: state.category, assigneeUserId: state.assignee ?? null, storyPoints: state.points ?? null,
          phaseId: null, sprintId: state.sprint ?? null, archived: state.archived ?? false } }
        : { fields: ["title"] };
      const eventType = index === 0 ? "issue.created" : "issue.updated";
      await owner.query(`INSERT INTO ${table("issue_events")} (tenant_id,project_id,issue_id,actor_user_id,event_type,from_version,to_version,changes,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [fx.workspace, fx.project, id, fx.owner.id, eventType, index, index + 1, JSON.stringify(changes), step.at]);
      await owner.query(`INSERT INTO ${table("outbox_events")} (tenant_id,event_type,aggregate_type,aggregate_id,aggregate_version,payload,created_at,available_at,processed_at)
        VALUES ($1,$2,'issue',$3,$4,'{}',$5,$5,$5)`, [fx.workspace, eventType, id, index + 1, step.at]);
      await owner.query("SET CONSTRAINTS ALL IMMEDIATE");
    }
    await owner.query("COMMIT");
  } catch (error) { await owner.query("ROLLBACK"); throw error; }
  return id;
}
const flowCall = `SELECT day::text AS day,backlog,todo,in_progress,done,completed,completed_points::float8 AS completed_points FROM "${namespace}".insight_flow($1,$2,$3,$4) ORDER BY day`;
const burndownCall = `SELECT day::text AS day,scope_count,scope_points::float8 AS scope_points,remaining_count,remaining_points::float8 AS remaining_points
  FROM "${namespace}".insight_sprint_burndown($1,$2) ORDER BY day`;
const outcomesCall = `SELECT sprint_id,name,completed_at,committed_points::float8 AS committed_points,completed_points::float8 AS completed_points,committed_count,completed_count,
  base_count,base_points::float8 AS base_points,base_estimated,base_done_count,base_done_points::float8 AS base_done_points,already_done_count,added_count,
  added_points::float8 AS added_points,removed_count FROM "${namespace}".insight_sprint_outcomes($1,$2,$3,$4,$5)`;
const membersCall = `SELECT user_id,completed,completed_points::float8 AS completed_points,with_due,on_time,open,overdue,median_cycle_days::float8 AS median_cycle_days
  FROM "${namespace}".insight_members($1,$2,$3,$4,$5)`;
const statesCall = `SELECT issue_id,valid_from,valid_to,category,status_id,sprint_id,phase_id,assignee_user_id,story_points::float8 AS story_points,archived
  FROM "${namespace}".insight_issue_states($1,$2,$3) ORDER BY issue_id,valid_from`;
type SprintSetup = InsightProject & { sprint: string; older: string; firstDay: string; today: string; olderCompletedAt: string; completedAt: string };
// The Review Focus 2 sprint: 10 committed issues, 2 of them already done at the start; 1 issue added on day 2;
// 6 of the 8 open committed issues finish; at completion (today 00:00:01 UTC) the 2 open committed issues and the
// added one go back to the backlog in change sets sharing completed_at. The window runs from 5 days ago to 2 days
// ahead. One of the two carried-over committed issues is unestimated. An older completed sprint has no commitments.
async function sprintFixture(): Promise<SprintSetup> {
  const who = await account("Sprint Insights");
  const fx = await insightProject(who);
  const today = dayFromToday(), firstDay = shiftDay(today, -5);
  const sprint = randomUUID(), older = randomUUID();
  const startedAt = utcAt(firstDay, "09:00:00"), completedAt = utcAt(today, "00:00:01"), olderCompletedAt = utcAt(shiftDay(firstDay, -1), "10:00:00");
  await owner.query("SET ROLE spark_owner");
  await owner.query(`INSERT INTO ${table("sprints")} (id,tenant_id,project_id,name,starts_at,ends_at,status,started_at,completed_at,committed_points,committed_count,completed_points,completed_count)
    VALUES ($1,$3,$4,'Sprint 2',$5,$6,'completed',$7,$8,16,10,14,8),($2,$3,$4,'Sprint 1',$9,$10,'completed',$11,$12,0,0,0,0)`,
    [sprint, older, fx.workspace, fx.project, utcAt(firstDay), utcAt(shiftDay(firstDay, 7)), startedAt, completedAt,
      utcAt(shiftDay(firstDay, -14)), utcAt(shiftDay(firstDay, -1)), utcAt(shiftDay(firstDay, -14), "09:00:00"), olderCompletedAt]);
  const created = utcAt(shiftDay(firstDay, -3), "10:00:00"), planned = utcAt(shiftDay(firstDay, -1), "12:00:00");
  const committed: { id: string; points: number | null }[] = [];
  for (let index = 0; index < 2; index++) {
    committed.push({ id: await issueHistory(fx, [
      { at: created, after: { category: "todo", points: 1 } },
      { at: utcAt(shiftDay(firstDay, -2), "10:00:00"), after: { category: "done", points: 1 } },
      { at: planned, after: { category: "done", points: 1, sprint } },
    ]), points: 1 });
  }
  const finishedOn = [1, 1, 2, 3, 4, 4];
  for (let index = 0; index < 8; index++) {
    const points = index === 7 ? null : 2;
    const steps: HistoryStep[] = [{ at: created, after: { category: "todo", points } }, { at: planned, after: { category: "todo", points, sprint } }];
    steps.push(index < 6
      ? { at: utcAt(shiftDay(firstDay, finishedOn[index]!), "15:00:00"), after: { category: "done", points, sprint } }
      : { at: completedAt, after: { category: "todo", points, sprint: null } });
    committed.push({ id: await issueHistory(fx, steps), points });
  }
  await issueHistory(fx, [
    { at: created, after: { category: "todo", points: 3 } },
    { at: utcAt(shiftDay(firstDay, 2), "12:00:00"), after: { category: "todo", points: 3, sprint } },
    { at: completedAt, after: { category: "todo", points: 3, sprint: null } },
  ]);
  for (const item of committed) {
    await owner.query(`INSERT INTO ${table("sprint_commitments")} (tenant_id,sprint_id,issue_id,story_points,created_at) VALUES ($1,$2,$3,$4,$5)`,
      [fx.workspace, sprint, item.id, item.points, startedAt]);
  }
  return { ...fx, sprint, older, firstDay, today, olderCompletedAt, completedAt };
}
let sprintSetup: Promise<SprintSetup> | undefined;
const sharedSprint = () => (sprintSetup ??= sprintFixture());

const topicCodes = ["b2b-saas", "climate-tech", "ai-data", "product", "fintech", "founders"];
type Host = { owner: Account; workspace: string };
// A user with a session who owns a fresh active workspace.
async function hostWorkspace(name: string): Promise<Host> {
  const who = await account(`${name} owner`);
  const created = await createWorkspace(who, name);
  if (created.outcome !== "ok") throw new Error(`Workspace not created: ${created.outcome}`);
  return { owner: who, workspace: created.workspace_id! };
}
type CommunityInput = { name: string; tagline?: string; visibility?: "public" | "private" | "hidden"; stage?: string; country?: string | null; city?: string | null;
  topics?: string[]; frozen?: boolean; archived?: boolean };
const communitySlug = (community: string) => `c-${community}`;
// A community hosted by the workspace and owned by its owner (slug c-<id>), with its topics, written by the table owner.
async function communityFixture(host: Host, input: CommunityInput) {
  const id = randomUUID();
  await owner.query("SET ROLE spark_owner");
  await owner.query("BEGIN");
  try {
    await owner.query(`INSERT INTO ${table("communities")} (id,tenant_id,slug,name,tagline,description,visibility,stage,country_code,city,created_by_user_id,frozen_at,archived_at)
      VALUES ($1,$2,$3,$4,$5,'Description',$6,$7,$8,$9,$10,CASE WHEN $11::boolean THEN now() END,CASE WHEN $12::boolean THEN now() END)`,
      [id, host.workspace, communitySlug(id), input.name, input.tagline ?? "A tagline", input.visibility ?? "public", input.stage ?? "any", input.country ?? null, input.city ?? null,
        host.owner.id, input.frozen ?? false, input.archived ?? false]);
    await owner.query(`INSERT INTO ${table("community_memberships")} (tenant_id,community_id,user_id,role) VALUES ($1,$2,$3,'owner')`, [host.workspace, id, host.owner.id]);
    await owner.query(`INSERT INTO ${table("community_topics")} (tenant_id,community_id,topic_id) SELECT $1,$2,t.id FROM ${table("topics")} t WHERE t.slug = ANY($3::text[])`,
      [host.workspace, id, input.topics ?? []]);
    await owner.query("COMMIT");
  } catch (error) { await owner.query("ROLLBACK"); throw error; }
  return id;
}
async function joinCommunity(host: Host, community: string, who: Account, role = "member") {
  await owner.query("SET ROLE spark_owner");
  await owner.query(`INSERT INTO ${table("community_memberships")} (tenant_id,community_id,user_id,role) VALUES ($1,$2,$3,$4)`, [host.workspace, community, who.id, role]);
}
type Card = { id: string; slug: string; name: string; tagline: string; visibility: string; country_code: string | null; city: string | null; stage: string; topics: string[];
  member_count: string; weekly_posts: string; featured: boolean; frozen: boolean; host_workspace_name: string; viewer_status: string | null };
type DiscoverInput = { query?: string | null; topic?: string | null; country?: string | null; stage?: string | null; afterName?: string | null; afterId?: string | null; limit?: number | null };
const discoverCall = `SELECT * FROM "${namespace}".discover_communities($1,$2,$3,$4,$5,$6,$7)`;
async function discover(token: Buffer | null, input: DiscoverInput = {}) {
  return (await asSession(token, discoverCall, [input.query ?? null, input.topic ?? null, input.country ?? null, input.stage ?? null,
    input.afterName ?? null, input.afterId ?? null, input.limit === undefined ? 50 : input.limit])).rows as Card[];
}
const cardIds = (cards: Card[]) => cards.map((card) => card.id);
const searchTag = () => `q${randomUUID().replaceAll("-", "").slice(0, 10)}`;
type CommunityPage = Card & { description: string; created_at: Date; settings_version: number; can_manage: boolean };
async function bySlug(token: Buffer | null, slug: string) {
  return (await asSession(token, `SELECT * FROM ${fn("community_by_slug")}($1)`, [slug])).rows as CommunityPage[];
}

describe("Community access and discovery", () => {
  it("reads host workspace admin standing for the detail route (canGovern)", async () => {
    const host = await hostWorkspace("Govern host");
    const hostAdmin = await account("Govern admin"), moderator = await account("Govern moderator"), stranger = await account("Govern stranger");
    await addMember(host.workspace, hostAdmin, "admin");
    const community = await communityFixture(host, { name: "Govern Circle", visibility: "private" });
    await joinCommunity(host, community, hostAdmin, "moderator");
    await joinCommunity(host, community, moderator, "moderator");
    const sql = DETAIL_BY_SLUG_SQL.replace(/\bspark\./gu, `"${namespace}".`);
    const standing = async (token: Buffer | null) => {
      const [row] = (await asSession(token, sql, [communitySlug(community)])).rows as Array<{ viewer_status: string | null; can_manage: boolean; host_admin: boolean }>;
      return row ? { viewer_status: row.viewer_status, can_manage: row.can_manage, host_admin: row.host_admin } : null;
    };
    expect(await standing(host.owner.token)).toEqual({ viewer_status: "owner", can_manage: true, host_admin: true });
    expect(await standing(hostAdmin.token)).toEqual({ viewer_status: "moderator", can_manage: true, host_admin: true });
    expect(await standing(moderator.token)).toEqual({ viewer_status: "moderator", can_manage: true, host_admin: false });
    expect(await standing(stranger.token)).toEqual({ viewer_status: "none", can_manage: false, host_admin: false });
    expect(await standing(null)).toEqual({ viewer_status: null, can_manage: false, host_admin: false });
  });

  it("binds community reads to the live session", async () => {
    const host = await hostWorkspace("Session host");
    const member = await account("Session member"), requester = await account("Session requester"), admin = await account("Session admin");
    await addMember(host.workspace, admin, "admin");
    const community = await communityFixture(host, { name: "Session Circle", visibility: "private" });
    await joinCommunity(host, community, member);
    const post = randomUUID();
    await owner.query(`INSERT INTO ${table("posts")} (id,tenant_id,community_id,author_user_id,title,body,visibility) VALUES ($1,$2,$3,$4,'Members only','Body','members')`, [post, host.workspace, community, host.owner.id]);
    await owner.query(`INSERT INTO ${table("community_join_requests")} (tenant_id,community_id,user_id,message) VALUES ($1,$2,$3,'Let me in')`, [host.workspace, community, requester.id]);
    const posts = `SELECT id FROM ${table("posts")} WHERE community_id=$1`;
    const members = `SELECT user_id FROM ${table("community_memberships")} WHERE community_id=$1 ORDER BY user_id`;
    const requests = `SELECT user_id FROM ${table("community_join_requests")} WHERE community_id=$1`;
    const users = (rows: { user_id: string }[]) => rows.map((row) => row.user_id);
    // The settings the pre-0030 helpers trusted grant nothing on their own.
    expect((await asSpoofed(member.id, host.workspace, posts, [community])).rows).toEqual([]);
    expect((await asSpoofed(member.id, host.workspace, members, [community])).rows).toEqual([]);
    expect((await asSpoofed(host.owner.id, host.workspace, requests, [community])).rows).toEqual([]);
    // The member's live session reads posts and the member list.
    expect((await asSession(member.token, posts, [community])).rows).toEqual([{ id: post }]);
    expect(users((await asSession(member.token, members, [community])).rows)).toEqual([host.owner.id, member.id].sort());
    // A signed-in non-member sees the private community's row but neither members nor posts.
    expect((await asSession(requester.token, `SELECT id FROM ${table("communities")} WHERE id=$1`, [community])).rows).toEqual([{ id: community }]);
    expect((await asSession(requester.token, posts, [community])).rows).toEqual([]);
    expect((await asSession(requester.token, members, [community])).rows).toEqual([]);
    // Join requests: the requester's own row, and every row for managers (community owner or host workspace admin).
    expect(users((await asSession(requester.token, requests, [community])).rows)).toEqual([requester.id]);
    expect((await asSession(member.token, requests, [community])).rows).toEqual([]);
    expect(users((await asSession(host.owner.token, requests, [community])).rows)).toEqual([requester.id]);
    expect(users((await asSession(admin.token, requests, [community])).rows)).toEqual([requester.id]);
    expect((await asSession(null, requests, [community])).rows).toEqual([]);
    // A host workspace admin manages members without joining; posts stay with members (unchanged by 0030).
    expect(users((await asSession(admin.token, members, [community])).rows)).toEqual([host.owner.id, member.id].sort());
    expect((await asSession(admin.token, posts, [community])).rows).toEqual([]);
    // Topics are public reference data.
    expect((await asSession(null, `SELECT slug,name FROM ${table("topics")} WHERE slug = ANY($1::text[]) ORDER BY slug`, [topicCodes])).rows).toEqual([
      { slug: "ai-data", name: "AI & Data" }, { slug: "b2b-saas", name: "B2B SaaS" }, { slug: "climate-tech", name: "Climate Tech" },
      { slug: "fintech", name: "FinTech" }, { slug: "founders", name: "Founders Circle" }, { slug: "product", name: "Product" }]);
    // Leaving revokes access at once.
    await owner.query(`UPDATE ${table("community_memberships")} SET status='left',left_at=now() WHERE community_id=$1 AND user_id=$2`, [community, member.id]);
    expect((await asSession(member.token, posts, [community])).rows).toEqual([]);
    expect((await asSession(member.token, members, [community])).rows).toEqual([]);
  });
  it("discovers communities by audience", async () => {
    const tag = searchTag();
    const host = await hostWorkspace("Audience host");
    const member = await account("Audience member"), stranger = await account("Audience stranger");
    const pub = await communityFixture(host, { name: `${tag} Public`, tagline: "Founders shipping AI", topics: ["ai-data", "b2b-saas"], country: "VN", city: "Hanoi", stage: "seed" });
    const priv = await communityFixture(host, { name: `${tag} Private`, visibility: "private" });
    const hid = await communityFixture(host, { name: `${tag} Hidden`, visibility: "hidden" });
    await communityFixture(host, { name: `${tag} Archived`, archived: true });
    const froz = await communityFixture(host, { name: `${tag} Frozen`, frozen: true });
    await joinCommunity(host, hid, member);
    // A topic outside the fixed set (as in older demo data) is kept but never shown.
    await owner.query(`INSERT INTO ${table("topics")} (slug,name) VALUES ($1,'Legacy topic')`, [`legacy-${tag}`]);
    await owner.query(`INSERT INTO ${table("community_topics")} (tenant_id,community_id,topic_id) SELECT $1,$2,id FROM ${table("topics")} WHERE slug=$3`, [host.workspace, pub, `legacy-${tag}`]);
    // Two visible posts and a comment this week count; an older, a moderated and a deleted post do not.
    const recent = randomUUID();
    await owner.query(`INSERT INTO ${table("posts")} (id,tenant_id,community_id,author_user_id,title,body) VALUES ($1,$2,$3,$4,'Recent','Body')`, [recent, host.workspace, pub, host.owner.id]);
    await owner.query(`INSERT INTO ${table("posts")} (tenant_id,community_id,author_user_id,title,body,created_at,moderation_status,deleted_at) VALUES
      ($1,$2,$3,'Also recent','Body',now(),'visible',NULL),($1,$2,$3,'Old','Body',now()-interval '8 days','visible',NULL),
      ($1,$2,$3,'Moderated','Body',now(),'hidden',NULL),($1,$2,$3,'Deleted','Body',now(),'visible',now())`, [host.workspace, pub, host.owner.id]);
    await owner.query(`INSERT INTO ${table("post_comments")} (tenant_id,community_id,post_id,author_user_id,body) VALUES ($1,$2,$3,$4,'Reply')`, [host.workspace, pub, recent, host.owner.id]);
    await owner.query(`INSERT INTO ${table("community_join_requests")} (tenant_id,community_id,user_id) VALUES ($1,$2,$3)`, [host.workspace, priv, stranger.id]);
    // Signed out: public only, archived never, frozen listed and flagged.
    const anonymous = await discover(null, { query: tag });
    expect(cardIds(anonymous)).toEqual([froz, pub]);
    expect(anonymous[0]).toMatchObject({ frozen: true, featured: false, viewer_status: null });
    expect(anonymous[1]).toEqual({ id: pub, slug: communitySlug(pub), name: `${tag} Public`, tagline: "Founders shipping AI", visibility: "public", country_code: "VN", city: "Hanoi",
      stage: "seed", topics: ["b2b-saas", "ai-data"], member_count: "1", weekly_posts: "3", featured: false, frozen: false, host_workspace_name: "Audience host", viewer_status: null });
    // Signed in: private too, with the viewer's status.
    const strangerView = await discover(stranger.token, { query: tag });
    expect(cardIds(strangerView)).toEqual([froz, priv, pub]);
    expect(strangerView.map((card) => card.viewer_status)).toEqual(["none", "pending", "none"]);
    // Hidden communities only for their members.
    const memberView = await discover(member.token, { query: tag });
    expect(cardIds(memberView)).toEqual([froz, hid, priv, pub]);
    expect(memberView[1]).toMatchObject({ visibility: "hidden", member_count: "2", viewer_status: "member" });
    expect((await discover(host.owner.token, { query: tag })).map((card) => card.viewer_status)).toEqual(["owner", "owner", "owner", "owner"]);
    // A revoked session is treated as signed out.
    await runtime.query(`SELECT ${fn("auth_revoke_session")}($1)`, [stranger.token]);
    expect(cardIds(await discover(stranger.token, { query: tag }))).toEqual([froz, pub]);
    // An archived host workspace takes its communities out of discovery.
    await owner.query("SET ROLE spark_owner");
    await owner.query(`UPDATE ${table("workspaces")} SET status='archived',archived_at=now(),version=version+1 WHERE id=$1`, [host.workspace]);
    expect(await discover(member.token, { query: tag })).toEqual([]);
  });
  it("pages discovery without gaps or duplicates", async () => {
    const tag = searchTag();
    const host = await hostWorkspace("Paging host");
    const created: string[] = [];
    // The two Alphas straddle the first page boundary, so the id tie-break decides where page two starts.
    for (const name of ["Aardvark", "abacus", "Alpha", "Alpha", "beta", "Gamma", "zeta"]) created.push(await communityFixture(host, { name: `${tag} ${name}` }));
    await owner.query("SET ROLE spark_owner");
    const expected = (await owner.query(`SELECT id FROM ${table("communities")} WHERE id = ANY($1::uuid[]) ORDER BY lower(name), id`, [created])).rows.map((row) => row.id as string);
    const seen: string[] = [];
    let after: Card | undefined;
    let pages = 0;
    for (;;) {
      const page = await discover(null, { query: tag, limit: 3, afterName: after?.name ?? null, afterId: after?.id ?? null });
      pages++;
      expect(page.length).toBeLessThanOrEqual(4);
      seen.push(...cardIds(page.slice(0, 3)));
      if (page.length <= 3 || pages > 5) break;
      after = page[2];
    }
    expect(seen).toEqual(expected);
    expect(pages).toBe(3);
  });
  it("filters with AND semantics and escapes wildcards", async () => {
    const tag = searchTag();
    const host = await hostWorkspace("Filter host");
    const match = await communityFixture(host, { name: `${tag} Match`, topics: ["product", "fintech"], stage: "seed", country: "VN" });
    const elsewhere = await communityFixture(host, { name: `${tag} Elsewhere`, topics: ["product"], stage: "seed", country: "SG" });
    const topic = await communityFixture(host, { name: `${tag} Topic`, topics: ["fintech"], stage: "seed", country: "VN" });
    const stage = await communityFixture(host, { name: `${tag} Stage`, topics: ["product"], stage: "idea", country: "VN" });
    expect(cardIds(await discover(null, { query: tag, topic: "product", country: "VN", stage: "seed" }))).toEqual([match]);
    expect(cardIds(await discover(null, { query: tag, topic: "product", stage: "seed" }))).toEqual([elsewhere, match]);
    expect(cardIds(await discover(null, { query: tag, country: "VN" }))).toEqual([match, stage, topic]);
    expect(cardIds(await discover(null, { query: tag, topic: "founders" }))).toEqual([]);
    // The query also matches taglines and topic names, case-insensitively and trimmed.
    const byTagline = await communityFixture(host, { name: "Unrelated name", tagline: `Notes from ${tag}TL readers` });
    expect(cardIds(await discover(null, { query: `  ${tag.toUpperCase()}tl ` }))).toEqual([byTagline]);
    const climate = await communityFixture(host, { name: `${tag} Weather`, topics: ["climate-tech"] });
    expect(cardIds(await discover(null, { query: "cLiMaTe TeCh" }))).toEqual([climate]);
    // LIKE wildcards and the escape character are literal.
    const percent = await communityFixture(host, { name: `${tag} 50% off` });
    await communityFixture(host, { name: `${tag} 50 club` });
    await communityFixture(host, { name: `${tag} 500x` });
    const underscore = await communityFixture(host, { name: `${tag} a_b` });
    await communityFixture(host, { name: `${tag} axb` });
    const backslash = await communityFixture(host, { name: `${tag} back\\slash` });
    expect(cardIds(await discover(null, { query: "50%" }))).toEqual([percent]);
    expect(cardIds(await discover(null, { query: `${tag} a_b` }))).toEqual([underscore]);
    expect(cardIds(await discover(null, { query: "k\\s" }))).toEqual([backslash]);
    // 100 characters after trimming is the longest query.
    expect(await discover(null, { query: ` ${"x".repeat(100)} ` })).toEqual([]);
    for (const input of [{ query: "x".repeat(101) }, { topic: "nope" }, { topic: "Product" }, { stage: "Seed" }, { country: "vn" }, { country: "VNM" },
      { limit: 0 }, { limit: 51 }, { limit: null }, { afterName: "Alpha" }, { afterId: randomUUID() }] as DiscoverInput[]) {
      await expect(discover(null, input)).rejects.toMatchObject({ code: "22023" });
    }
  });
  it("hides hidden communities by slug", async () => {
    const host = await hostWorkspace("Slug host");
    const member = await account("Slug member"), stranger = await account("Slug stranger"), admin = await account("Slug admin");
    await addMember(host.workspace, admin, "admin");
    const hidden = await communityFixture(host, { name: "Slug Hidden", visibility: "hidden" });
    const privateOne = await communityFixture(host, { name: "Slug Private", visibility: "private" });
    const archived = await communityFixture(host, { name: "Slug Archived", archived: true });
    await joinCommunity(host, hidden, member);
    // Indistinguishable from an unknown slug for everyone who may not see it.
    expect(await bySlug(stranger.token, communitySlug(hidden))).toEqual([]);
    expect(await bySlug(null, communitySlug(hidden))).toEqual([]);
    expect(await bySlug(host.owner.token, "no-such-community")).toEqual([]);
    expect(await bySlug(host.owner.token, communitySlug(archived))).toEqual([]);
    const seen = await bySlug(member.token, communitySlug(hidden));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: hidden, slug: communitySlug(hidden), name: "Slug Hidden", visibility: "hidden", description: "Description", settings_version: 1,
      member_count: "2", viewer_status: "member", can_manage: false, host_workspace_name: "Slug host" });
    expect(seen[0]!.created_at).toBeInstanceOf(Date);
    // Managers see it without joining.
    expect(await bySlug(admin.token, communitySlug(hidden))).toMatchObject([{ id: hidden, viewer_status: "none", can_manage: true }]);
    expect(await bySlug(host.owner.token, communitySlug(hidden))).toMatchObject([{ id: hidden, viewer_status: "owner", can_manage: true }]);
    // Private communities open by slug for anyone.
    expect(await bySlug(null, communitySlug(privateOne))).toMatchObject([{ id: privateOne, viewer_status: null, can_manage: false }]);
    expect(await bySlug(stranger.token, communitySlug(privateOne))).toMatchObject([{ id: privateOne, viewer_status: "none", can_manage: false }]);
  });
  it("lists filter values over the communities the caller can discover", async () => {
    const host = await hostWorkspace("Values host");
    const member = await account("Values member");
    type FilterValue = { kind: string; value: string; label: string; count: string };
    const values = async (token: Buffer | null) => (await asSession(token, `SELECT * FROM ${fn("community_filter_values")}()`)).rows as FilterValue[];
    const count = (rows: FilterValue[], kind: string, value: string) => Number(rows.find((row) => row.kind === kind && row.value === value)?.count ?? 0);
    const before = await values(null);
    await communityFixture(host, { name: "Values Public", topics: ["founders"], stage: "growth", country: "QQ" });
    const hidden = await communityFixture(host, { name: "Values Hidden", visibility: "hidden", topics: ["founders"], stage: "growth", country: "ZZ" });
    await joinCommunity(host, hidden, member);
    const anonymous = await values(null);
    expect(anonymous.filter((row) => row.kind === "topic").map((row) => [row.value, row.label])).toEqual([["b2b-saas", "B2B SaaS"], ["climate-tech", "Climate Tech"],
      ["ai-data", "AI & Data"], ["product", "Product"], ["fintech", "FinTech"], ["founders", "Founders Circle"]]);
    expect(anonymous.filter((row) => row.kind === "stage").map((row) => [row.value, row.label])).toEqual([["idea", "Idea"], ["pre_seed", "Pre-seed"], ["seed", "Seed"],
      ["series_a", "Series A"], ["growth", "Growth"], ["any", "Any stage"]]);
    expect(anonymous.map((row) => row.kind)).toEqual([...Array(6).fill("topic"), ...Array(6).fill("stage"), ...Array(anonymous.length - 12).fill("country")]);
    expect(count(anonymous, "topic", "founders") - count(before, "topic", "founders")).toBe(1);
    expect(count(anonymous, "stage", "growth") - count(before, "stage", "growth")).toBe(1);
    expect(anonymous.find((row) => row.value === "QQ")).toEqual({ kind: "country", value: "QQ", label: "QQ", count: "1" });
    expect(anonymous.find((row) => row.value === "ZZ")).toBeUndefined();
    const countries = anonymous.filter((row) => row.kind === "country").map((row) => row.value);
    expect(countries).toEqual([...countries].sort());
    const memberValues = await values(member.token);
    expect(memberValues.find((row) => row.value === "ZZ")).toEqual({ kind: "country", value: "ZZ", label: "ZZ", count: "1" });
    expect(count(memberValues, "topic", "founders") - count(anonymous, "topic", "founders")).toBeGreaterThanOrEqual(1);
  });
  it("normalizes stages, locations and taglines of existing communities", async () => {
    await owner.query("SET ROLE spark_owner");
    const rows = (await owner.query(`SELECT id,stage,tagline,country_code,city,settings_version FROM ${table("communities")} WHERE id = ANY($1::uuid[])`, [legacyCommunities.map((row) => row.id)])).rows;
    const byId = new Map(rows.map((row) => [row.id as string, row]));
    expect(legacyCommunities.map((legacy) => byId.get(legacy.id))).toEqual([
      { id: legacyCommunities[0]!.id, stage: "seed", tagline: "Founders in Hanoi", country_code: "VN", city: "Hanoi", settings_version: 1 },
      { id: legacyCommunities[1]!.id, stage: "pre_seed", tagline: "D".repeat(89), country_code: null, city: null, settings_version: 1 },
      { id: legacyCommunities[2]!.id, stage: "any", tagline: "Description", country_code: null, city: null, settings_version: 1 },
      { id: legacyCommunities[3]!.id, stage: "series_a", tagline: "Description", country_code: "SG", city: "Singapore", settings_version: 1 },
      { id: legacyCommunities[4]!.id, stage: "any", tagline: "Description", country_code: null, city: null, settings_version: 1 },
      { id: legacyCommunities[5]!.id, stage: "any", tagline: "Legacy community", country_code: null, city: null, settings_version: 1 },
    ]);
    // New rows must already be normalized.
    const insert = `INSERT INTO ${table("communities")} (tenant_id,slug,name,tagline,description,stage,country_code,city,settings_version,created_by_user_id) VALUES ($1,$2,'Checked',$3,'Description',$4,$5,$6,$7,$8)`;
    type Row = { tagline: string | null; stage: string; country: string; city: string; version: number };
    const attempt = (changes: Partial<Row>) => {
      const row: Row = { tagline: "Tagline", stage: "seed", country: "VN", city: "Hanoi", version: 1, ...changes };
      return [tenantA, `checked-${randomUUID()}`, row.tagline, row.stage, row.country, row.city, row.version, userA];
    };
    for (const changes of [{ stage: "Seed" }, { stage: "pre-seed" }, { country: "vn" }, { country: "VNM" }, { city: " Hanoi" }, { city: "" }, { city: "x".repeat(81) },
      { tagline: "" }, { tagline: " Padded" }, { tagline: "x".repeat(91) }, { version: 0 }] as Partial<Row>[]) {
      await reject(insert, attempt(changes), "23514");
    }
    await reject(insert, attempt({ tagline: null }), "23502");
    await rollback(async () => {
      await owner.query(insert, attempt({ tagline: "x".repeat(90), city: "x".repeat(80) }));
      const defaults = (await owner.query(`INSERT INTO ${table("communities")} (tenant_id,slug,name,tagline,description,created_by_user_id) VALUES ($1,$2,'Defaults','Tagline','Description',$3) RETURNING stage,settings_version`,
        [tenantA, `defaults-${randomUUID()}`, userA])).rows[0];
      expect(defaults).toEqual({ stage: "any", settings_version: 1 });
    });
  });
  it("keeps the community read functions definers with an empty search_path and the helpers internal", async () => {
    await owner.query("SET ROLE spark_owner");
    const rows = (await owner.query(`SELECT p.proname, p.prosecdef, p.provolatile, p.proconfig, has_function_privilege('spark_app',p.oid,'EXECUTE') AS runtime,
      has_function_privilege('spark_worker',p.oid,'EXECUTE') AS worker, has_function_privilege('spark_auth',p.oid,'EXECUTE') AS auth
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname = ANY($2) ORDER BY p.proname`,
      [namespace, ["can_manage_community", "community_by_slug", "community_cards", "community_filter_values", "community_topic_codes", "discover_communities", "discoverable_communities"]])).rows;
    expect(rows.map((row) => [row.proname, row.prosecdef, row.provolatile, row.proconfig, row.runtime, row.worker, row.auth])).toEqual([
      ["can_manage_community", true, "s", ['search_path=""'], true, false, false],
      ["community_by_slug", true, "s", ['search_path=""'], true, false, false],
      ["community_cards", false, "s", ['search_path=""'], false, false, false],
      ["community_filter_values", true, "s", ['search_path=""'], true, false, false],
      ["community_topic_codes", false, "i", ['search_path=""'], false, false, false],
      ["discover_communities", true, "s", ['search_path=""'], true, false, false],
      ["discoverable_communities", false, "s", ['search_path=""'], false, false, false],
    ]);
    // No function reads the spoofable settings any more.
    const legacy = await owner.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=$1 AND (p.prosrc LIKE '%spark.user\\_id%' OR p.prosrc LIKE '%spark.tenant\\_id%') ORDER BY p.proname`, [namespace]);
    expect(legacy.rows).toEqual([]);
  });
});

describe("Insight reads", () => {
  it("replays issue states", async () => {
    const fx = await insightProject(await account("States"));
    const base = dayFromToday(-12), t1 = utcAt(base, "10:00:00"), t2 = utcAt(base, "11:00:00"), t3 = utcAt(shiftDay(base, 1), "09:00:00"), t4 = utcAt(shiftDay(base, 2), "09:00:00");
    const tracked = await issueHistory(fx, [
      { at: t1, after: { category: "todo", points: 1 } },
      { at: t2, after: null },
      { at: t3, after: { category: "in_progress", points: 2, assignee: fx.owner.id } },
      { at: t4, after: { category: "done", points: 2, assignee: fx.owner.id, archived: true } },
    ]);
    const late = await issueHistory(fx, [{ at: t3, after: { category: "backlog" } }]);
    const read = async (until: string) => (await asSession(fx.owner.token, statesCall, [fx.workspace, fx.project, until])).rows
      .map((row) => ({ ...row, valid_from: iso(row.valid_from), valid_to: iso(row.valid_to) }));
    const row = (issue: string, from: string, to: string | null, category: Category, extra: Record<string, unknown> = {}) => ({
      issue_id: issue, valid_from: iso(from), valid_to: iso(to), category, status_id: fx.statuses[category], sprint_id: null, phase_id: null,
      assignee_user_id: null, story_points: null, archived: false, ...extra });
    // Before the first event the issue did not exist; an event without a snapshot is ignored.
    expect(await read(t1)).toEqual([]);
    expect(await read(t3)).toEqual([row(tracked, t1, null, "todo", { story_points: 1 })]);
    const all = await read(utcAt(dayFromToday(1)));
    expect(all.filter((item) => item.issue_id === tracked)).toEqual([
      row(tracked, t1, t3, "todo", { story_points: 1 }),
      row(tracked, t3, t4, "in_progress", { story_points: 2, assignee_user_id: fx.owner.id }),
      row(tracked, t4, null, "done", { story_points: 2, assignee_user_id: fx.owner.id, archived: true }),
    ]);
    expect(all.filter((item) => item.issue_id === late)).toEqual([row(late, t3, null, "backlog")]);
  });
  it("counts the CFD per UTC day", async () => {
    const fx = await insightProject(await account("Flow"));
    const first = dayFromToday(-20), day = (offset: number, time = "00:00:00") => utcAt(shiftDay(first, offset), time);
    await issueHistory(fx, [
      { at: day(-2, "10:00:00"), after: { category: "backlog", points: 3 } },
      { at: day(1, "23:59:59"), after: { category: "todo", points: 3 } },
      { at: day(3, "12:00:00"), after: { category: "in_progress", points: 3 } },
      { at: day(5, "09:00:00"), after: { category: "done", points: 3 } },
    ]);
    await issueHistory(fx, [{ at: day(0, "08:00:00"), after: { category: "todo", points: 2 } }, { at: day(2), after: { category: "done", points: 2 } }]);
    await issueHistory(fx, [
      { at: day(1, "12:00:00"), after: { category: "in_progress" } },
      { at: day(2, "10:00:00"), after: { category: "done" } },
      { at: day(3, "10:00:00"), after: { category: "in_progress" } },
      { at: day(4, "10:00:00"), after: { category: "done" } },
    ]);
    await issueHistory(fx, [{ at: day(-1, "10:00:00"), after: { category: "todo" } }, { at: day(3, "15:00:00"), after: { category: "todo", archived: true } }]);
    await issueHistory(fx, [{ at: day(4), after: { category: "backlog", points: 5 } }, { at: day(6, "23:59:59"), after: { category: "in_progress", points: 5 } }]);
    const flow = (await asSession(fx.owner.token, flowCall, [fx.workspace, fx.project, first, shiftDay(first, 6)])).rows;
    const counts = (offset: number, backlog: number, todo: number, in_progress: number, done: number, completed: number, completed_points: number) =>
      ({ day: shiftDay(first, offset), backlog, todo, in_progress, done, completed, completed_points });
    expect(flow).toEqual([
      counts(0, 1, 2, 0, 0, 0, 0),
      counts(1, 0, 3, 1, 0, 0, 0),
      counts(2, 0, 2, 0, 2, 2, 2),
      counts(3, 0, 0, 2, 1, 0, 0),
      counts(4, 1, 0, 1, 2, 1, 0),
      counts(5, 1, 0, 0, 3, 1, 3),
      counts(6, 0, 0, 1, 3, 0, 0),
    ]);
    await expect(asSession(fx.owner.token, flowCall, [fx.workspace, fx.project, first, shiftDay(first, -1)])).rejects.toMatchObject({ code: "22023" });
    await expect(asSession(fx.owner.token, flowCall, [fx.workspace, fx.project, first, shiftDay(first, 400)])).rejects.toMatchObject({ code: "22023" });
  });
  it("counts done transitions including reopen", async () => {
    const fx = await insightProject(await account("Throughput"));
    const first = dayFromToday(-40), day = (offset: number, time: string) => utcAt(shiftDay(first, offset), time);
    // Done, done again with new points (no transition), reopened and done again (counts twice).
    await issueHistory(fx, [
      { at: day(0, "10:00:00"), after: { category: "todo", points: 1 } },
      { at: day(0, "11:00:00"), after: { category: "done", points: 1 } },
      { at: day(0, "12:00:00"), after: { category: "done", points: 2 } },
      { at: day(1, "10:00:00"), after: { category: "todo", points: 2 } },
      { at: day(1, "11:00:00"), after: { category: "done", points: 2 } },
    ]);
    // Created directly in a done status: no previous snapshot, counts.
    await issueHistory(fx, [{ at: day(0, "09:00:00"), after: { category: "done", points: 2 } }]);
    // Done and archived in the same change set: excluded.
    await issueHistory(fx, [{ at: day(0, "08:00:00"), after: { category: "todo" } }, { at: day(1, "08:00:00"), after: { category: "done", archived: true } }]);
    const flow = (await asSession(fx.owner.token, flowCall, [fx.workspace, fx.project, first, shiftDay(first, 2)])).rows;
    expect(flow).toEqual([
      { day: first, backlog: 0, todo: 1, in_progress: 0, done: 2, completed: 2, completed_points: 3 },
      { day: shiftDay(first, 1), backlog: 0, todo: 0, in_progress: 0, done: 2, completed: 1, completed_points: 2 },
      { day: shiftDay(first, 2), backlog: 0, todo: 0, in_progress: 0, done: 2, completed: 0, completed_points: 0 },
    ]);
  });
  it("computes the sprint burndown", async () => {
    const fx = await sharedSprint();
    const rows = (await asSession(fx.owner.token, burndownCall, [fx.workspace, fx.sprint])).rows;
    const point = (offset: number, scope_count: number | null, scope_points: number | null, remaining_count: number | null, remaining_points: number | null) =>
      ({ day: shiftDay(fx.firstDay, offset), scope_count, scope_points, remaining_count, remaining_points });
    expect(rows).toEqual([
      point(0, 10, 16, 8, 14),
      point(1, 10, 16, 6, 10),
      point(2, 11, 19, 6, 11),
      point(3, 11, 19, 5, 9),
      point(4, 11, 19, 3, 5),
      // Today: read just before completion, so the carry-over at completed_at does not count as burn.
      point(5, 11, 19, 3, 5),
      point(6, null, null, null, null),
      point(7, null, null, null, null),
    ]);
    expect((await asSession(fx.owner.token, burndownCall, [fx.workspace, randomUUID()])).rows).toEqual([]);
  });
  it("computes sprint outcomes with already-done commitments", async () => {
    const fx = await sharedSprint();
    const from = utcAt(shiftDay(fx.firstDay, -30)), to = utcAt(dayFromToday(1));
    const outcomes = async (start: string, end: string, limit: number) =>
      (await asSession(fx.owner.token, outcomesCall, [fx.workspace, fx.project, start, end, limit])).rows.map((row) => ({ ...row, completed_at: iso(row.completed_at) }));
    const current = {
      sprint_id: fx.sprint, name: "Sprint 2", completed_at: iso(fx.completedAt), committed_points: 16, completed_points: 14, committed_count: 10, completed_count: 8,
      base_count: 8, base_points: 14, base_estimated: 7, base_done_count: 6, base_done_points: 12, already_done_count: 2, added_count: 1, added_points: 3, removed_count: 0,
    };
    const previous = {
      sprint_id: fx.older, name: "Sprint 1", completed_at: iso(fx.olderCompletedAt), committed_points: 0, completed_points: 0, committed_count: 0, completed_count: 0,
      base_count: 0, base_points: 0, base_estimated: 0, base_done_count: 0, base_done_points: 0, already_done_count: 0, added_count: 0, added_points: 0, removed_count: 0,
    };
    // Oldest first; the limit keeps the newest; the range is [from, to).
    expect(await outcomes(from, to, 6)).toEqual([previous, current]);
    expect(await outcomes(from, to, 1)).toEqual([current]);
    expect(await outcomes(from, fx.completedAt, 6)).toEqual([previous]);
    expect(await outcomes(new Date(Date.parse(fx.olderCompletedAt) + 1000).toISOString(), to, 6)).toEqual([current]);
    for (const limit of [0, 7]) await expect(outcomes(from, to, limit)).rejects.toMatchObject({ code: "22023" });
  });
  it("computes member stats", async () => {
    const alice = await account("Alice Insight"), bob = await account("Bob Insight");
    const fx = await insightProject(alice);
    await addMember(fx.workspace, bob, "member");
    const second = await insightProject(alice, fx.workspace), excluded = await insightProject(alice, fx.workspace);
    const first = dayFromToday(-30), day = (offset: number, time = "00:00:00") => utcAt(shiftDay(first, offset), time);
    const created = day(-5, "08:00:00");
    const done = (project: InsightProject, assignee: string | null, completedAt: string, points: number | null, current: IssueCurrent = {}, archived = false) =>
      issueHistory(project, [
        { at: created, after: { category: "todo", assignee, points } },
        { at: completedAt, after: { category: "done", assignee, points, archived } },
      ], { completedAt, ...current });
    const open = (category: Category, assignee: string | null, due: string | null, archived = false) =>
      issueHistory(fx, [{ at: created, after: { category, assignee, archived } }], { due });
    // Alice: on time on the due day (cycle 1.5), late (3.0), at the last instant of the range (0.5); out of range
    // on both sides; archived; one overdue open issue and one due on p_today; work in a project outside p_projects.
    await done(fx, alice.id, day(2, "12:00:00"), 3, { due: shiftDay(first, 2), startedAt: day(1) });
    await done(fx, alice.id, day(5), 2, { due: shiftDay(first, 4), startedAt: day(2) });
    await done(fx, alice.id, day(9, "23:59:59"), null, { startedAt: day(9, "11:59:59") });
    await done(fx, alice.id, day(10), 5, { startedAt: day(9) });
    await done(fx, alice.id, day(-1, "23:59:59"), 5, { startedAt: day(-2) });
    await done(fx, alice.id, day(3), 8, { startedAt: day(1) }, true);
    await open("todo", alice.id, shiftDay(first, 9));
    await open("in_progress", alice.id, shiftDay(first, 10));
    await open("todo", alice.id, shiftDay(first, 1), true);
    await done(excluded, alice.id, day(3), 13, { startedAt: day(1) });
    // Bob: on time (cycle 2.0) and one without a start (no cycle) in the second project.
    await done(fx, bob.id, day(3), 1, { due: shiftDay(first, 3), startedAt: day(1) });
    await done(second, bob.id, day(4, "08:00:00"), null);
    // Unassigned: an overdue open issue and a completed one without a start.
    await open("backlog", null, shiftDay(first, 5));
    await done(fx, null, day(6), null);
    const rows = (await asSession(alice.token, membersCall, [fx.workspace, [fx.project, second.project], first, shiftDay(first, 9), shiftDay(first, 10)])).rows;
    expect(rows).toEqual([
      ...[
        { user_id: alice.id, completed: 3, completed_points: 5, with_due: 2, on_time: 1, open: 2, overdue: 1, median_cycle_days: 1.5 },
        { user_id: bob.id, completed: 2, completed_points: 1, with_due: 1, on_time: 1, open: 0, overdue: 0, median_cycle_days: 2 },
      ].sort((a, b) => (a.user_id < b.user_id ? -1 : 1)),
      { user_id: null, completed: 1, completed_points: 0, with_due: 0, on_time: 0, open: 1, overdue: 1, median_cycle_days: null },
    ]);
    await expect(asSession(alice.token, membersCall, [fx.workspace, [fx.project], first, shiftDay(first, -1), first])).rejects.toMatchObject({ code: "22023" });
  });
  it("isolates tenants", async () => {
    const fx = await sharedSprint();
    const stranger = await account("Insight Stranger");
    const strangerWorkspace = (await createWorkspace(stranger)).workspace_id!;
    const from = shiftDay(fx.firstDay, -30), to = dayFromToday();
    const calls: [string, (tenant: string) => unknown[]][] = [
      [statesCall, (tenant) => [tenant, fx.project, utcAt(dayFromToday(1))]],
      [flowCall, (tenant) => [tenant, fx.project, from, to]],
      [burndownCall, (tenant) => [tenant, fx.sprint]],
      [outcomesCall, (tenant) => [tenant, fx.project, utcAt(from), utcAt(dayFromToday(1)), 6]],
      [membersCall, (tenant) => [tenant, [fx.project], from, to, to]],
    ];
    for (const [sql, args] of calls) {
      // The member sees the rows; another workspace's session sees none (the functions run as the caller, under RLS).
      expect((await asSession(fx.owner.token, sql, args(fx.workspace))).rows.length).toBeGreaterThan(0);
      expect((await asSession(stranger.token, sql, args(fx.workspace))).rows).toEqual([]);
      expect((await asSession(null, sql, args(fx.workspace))).rows).toEqual([]);
      // The explicit tenant filter holds even for a role that bypasses the workspace policies.
      await owner.query("SET ROLE spark_owner");
      expect((await owner.query(sql, args(strangerWorkspace))).rows).toEqual([]);
    }
  });
  it("functions are invokers with an empty search_path and not executable by PUBLIC", async () => {
    const rows = await owner.query(`SELECT p.proname, p.prosecdef, p.provolatile, p.proconfig, has_function_privilege('spark_app',p.oid,'EXECUTE') AS runtime,
      EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname LIKE 'insight\\_%' ORDER BY p.proname`, [namespace]);
    expect(rows.rows).toEqual(["insight_flow", "insight_issue_states", "insight_members", "insight_sprint_burndown", "insight_sprint_outcomes"].map((proname) =>
      ({ proname, prosecdef: false, provolatile: "s", proconfig: ['search_path=""'], runtime: true, public: false })));
  });
});

type EventInput = { title?: unknown; description?: string | null; location?: string | null; starts?: string; ends?: string; timezone?: string; project?: string | null; issue?: string | null; attendees?: (string | null)[] | null };
type EventCreated = { outcome: string; event_id: string | null; event_version: number | null };
type EventResult = { outcome: string; event_version: number | null };
const createEventCall = `SELECT * FROM "${namespace}".ws_create_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;
const updateEventCall = `SELECT * FROM "${namespace}".ws_update_event($1,$2,$3)`;
const cancelEventCall = `SELECT * FROM "${namespace}".ws_cancel_event($1,$2)`;
const respondEventCall = `SELECT * FROM "${namespace}".ws_respond_event($1,$2)`;
const eventArgs = (workspace: string, input: EventInput) => [workspace, "title" in input ? input.title : "Standup", input.description ?? null, input.location ?? null,
  input.starts ?? "2026-12-01T09:00:00Z", input.ends ?? "2026-12-01T10:00:00Z", input.timezone ?? "Europe/Berlin", input.project ?? null, input.issue ?? null, input.attendees ?? []];
async function createEvent(who: Account, workspace: string, input: EventInput = {}) {
  return (await asSession(who.token, createEventCall, eventArgs(workspace, input))).rows[0] as EventCreated;
}
async function updateEvent(who: Account, event: string, version: number, patch: unknown) {
  return (await asSession(who.token, updateEventCall, [event, version, JSON.stringify(patch)])).rows[0] as EventResult;
}
async function cancelEvent(who: Account, event: string, version: number) {
  return (await asSession(who.token, cancelEventCall, [event, version])).rows[0] as EventResult;
}
async function respondEvent(who: Account, event: string, response: string) {
  return (await asSession(who.token, respondEventCall, [event, response])).rows[0] as { outcome: string };
}
async function eventRow(event: string) {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT * FROM ${table("calendar_events")} WHERE id=$1`, [event])).rows[0];
}
async function attendeeStates(event: string) {
  await owner.query("SET ROLE spark_owner");
  const rows = (await owner.query(`SELECT user_id,response,responded_at IS NOT NULL AS answered FROM ${table("event_attendees")} WHERE event_id=$1`, [event])).rows;
  return Object.fromEntries(rows.map((row) => [row.user_id as string, { response: row.response as string, answered: row.answered as boolean }]));
}
type EventNotice = { recipient_user_id: string; title: string; resource_type: string; outbox_event_id: string };
async function eventNotices(event: string, kind: string) {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT recipient_user_id,title,resource_type,outbox_event_id FROM ${table("notifications")} WHERE resource_id=$1 AND kind=$2`, [event, kind])).rows
    .sort((left, right) => (left.recipient_user_id < right.recipient_user_id ? -1 : 1)) as EventNotice[];
}
const sortedIds = (...accounts: Account[]) => accounts.map((who) => who.id).sort();
const noticeRecipients = async (event: string, kind: string) => (await eventNotices(event, kind)).map((row) => row.recipient_user_id);
const eventOutbox = async (event: string) => {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT event_type,aggregate_version,processed_at IS NOT NULL AS processed FROM ${table("outbox_events")} WHERE aggregate_type='calendar_event' AND aggregate_id=$1 ORDER BY aggregate_version`, [event])).rows;
};
// Alice owns the workspace; Bob, Carol and Dave are members; Erin owns another workspace.
async function scheduleFixture() {
  const [alice, bob, carol, dave, erin] = await Promise.all(["Sched Alice", "Sched Bob", "Sched Carol", "Sched Dave", "Sched Erin"].map((name) => account(name)));
  const workspace = (await createWorkspace(alice!)).workspace_id!;
  for (const who of [bob!, carol!, dave!]) await addMember(workspace, who, "member");
  const elsewhere = (await createWorkspace(erin!)).workspace_id!;
  return { alice: alice!, bob: bob!, carol: carol!, dave: dave!, erin: erin!, workspace, elsewhere };
}
async function expectInvalidEvent(who: Account, workspace: string, input: EventInput, message: string) {
  await expect(asSession(who.token, createEventCall, eventArgs(workspace, input))).rejects.toMatchObject({ code: "22023", message });
}
async function expectInvalidPatch(who: Account, event: string, version: number, patch: unknown, message: string) {
  await expect(asSession(who.token, updateEventCall, [event, version, JSON.stringify(patch)])).rejects.toMatchObject({ code: "22023", message });
}

describe("Schedule writes", () => {
  it("creates an event with attendees", async () => {
    const { alice, bob, carol, dave, workspace } = await scheduleFixture();
    const created = await createEvent(bob, workspace, { title: "  Sprint review  ", description: "   ", location: "  Room 4  ", attendees: [carol.id, alice.id, bob.id] });
    expect(created).toEqual({ outcome: "ok", event_id: expect.any(String), event_version: 1 });
    const event = created.event_id!;
    expect(await eventRow(event)).toMatchObject({ tenant_id: workspace, organizer_user_id: bob.id, title: "Sprint review", description: null, location: "Room 4",
      timezone: "Europe/Berlin", status: "scheduled", version: 1, project_id: null, issue_id: null });
    expect(await attendeeStates(event)).toEqual({ [bob.id]: { response: "accepted", answered: true }, [carol.id]: { response: "pending", answered: false }, [alice.id]: { response: "pending", answered: false } });
    // One invitation per invitee, none for the organizer who is also the actor.
    const notices = await eventNotices(event, "event_invited");
    expect(notices.map((row) => row.recipient_user_id)).toEqual(sortedIds(alice, carol));
    expect(notices.every((row) => row.title === "Sched Bob invited you to Sprint review" && row.resource_type === "calendar_event")).toBe(true);
    expect(await noticeRecipients(event, "event_invited")).not.toContain(dave.id);
    await owner.query("SET ROLE spark_owner");
    const outbox = (await owner.query(`SELECT id,event_type,aggregate_version,processed_at IS NOT NULL AS processed,payload FROM ${table("outbox_events")} WHERE aggregate_type='calendar_event' AND aggregate_id=$1`, [event])).rows;
    expect(outbox).toEqual([{ id: expect.any(String), event_type: "calendar_event.created", aggregate_version: 1, processed: true, payload: { eventId: event, actorUserId: bob.id } }]);
    expect(notices.every((row) => row.outbox_event_id === outbox[0].id)).toBe(true);
    // Recipients read their own invitation.
    expect((await asSession(carol.token, `SELECT kind FROM ${table("notifications")} WHERE resource_id=$1`, [event])).rows).toEqual([{ kind: "event_invited" }]);
    // No attendees given: the organizer alone, accepted, and no notification.
    const solo = (await createEvent(dave, workspace, { attendees: null })).event_id!;
    expect(await attendeeStates(solo)).toEqual({ [dave.id]: { response: "accepted", answered: true } });
    expect(await noticeRecipients(solo, "event_invited")).toEqual([]);
    // Project and issue links; the duration limits are inclusive.
    const { project } = await scrumProject(alice, workspace);
    const issue = (await createIssue(alice, project)).issue_id!;
    const linked = await createEvent(carol, workspace, { project, issue, ends: "2026-12-01T09:05:00Z" });
    expect(linked.outcome).toBe("ok");
    expect(await eventRow(linked.event_id!)).toMatchObject({ project_id: project, issue_id: issue });
    expect((await createEvent(carol, workspace, { ends: "2026-12-15T09:00:00Z" })).outcome).toBe("ok");
  });
  it("validates event input", async () => {
    const { alice, bob, dave, erin, workspace, elsewhere } = await scheduleFixture();
    const mine = await scrumProject(alice, workspace), sibling = await scrumProject(alice, workspace), foreign = await scrumProject(erin, elsewhere);
    const issue = (await createIssue(alice, mine.project)).issue_id!;
    const foreignIssue = (await createIssue(erin, foreign.project)).issue_id!;
    expect(sibling.project).not.toBe(mine.project);
    const invalid: [EventInput, string][] = [
      [{ title: "" }, "Invalid event title"], [{ title: "   " }, "Invalid event title"], [{ title: null }, "Invalid event title"], [{ title: "x".repeat(201) }, "Invalid event title"],
      [{ description: "x".repeat(2001) }, "Invalid event description"], [{ location: "x".repeat(201) }, "Invalid event location"],
      [{ ends: "2026-12-01T09:04:00Z" }, "Invalid event time"], [{ ends: "2026-12-15T09:00:01Z" }, "Invalid event time"],
      [{ ends: "2026-12-01T09:00:00Z" }, "Invalid event time"], [{ ends: "2026-12-01T08:00:00Z" }, "Invalid event time"],
      [{ starts: "1999-12-31T23:00:00Z", ends: "2000-01-01T00:30:00Z" }, "Invalid event time"], [{ starts: "2101-01-01T00:00:00Z", ends: "2101-01-01T01:00:00Z" }, "Invalid event time"],
      [{ starts: "2026-12-01T09:00:00Z", ends: "infinity" }, "Invalid event time"],
      [{ timezone: "Mars/Base" }, "Invalid event timezone"], [{ timezone: "" }, "Invalid event timezone"],
      [{ project: foreign.project }, "Invalid event project"], [{ project: randomUUID() }, "Invalid event project"],
      [{ issue }, "Invalid event issue"], [{ project: sibling.project, issue }, "Invalid event issue"], [{ project: mine.project, issue: foreignIssue }, "Invalid event issue"],
      [{ attendees: [erin.id] }, "Invalid event attendees"], [{ attendees: [bob.id, bob.id] }, "Invalid event attendees"], [{ attendees: [null] }, "Invalid event attendees"],
      [{ attendees: Array.from({ length: 51 }, () => randomUUID()) }, "Invalid event attendees"],
    ];
    for (const [input, message] of invalid) await expectInvalidEvent(alice, workspace, input, message);
    // A member who left is not attendable.
    expect(await outcome(alice, "ws_remove_member($1,$2)", [workspace, dave.id])).toBe("ok");
    await expectInvalidEvent(alice, workspace, { attendees: [dave.id] }, "Invalid event attendees");
    // Nothing was written by the refused calls.
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT count(*)::integer AS total FROM ${table("calendar_events")} WHERE tenant_id=$1`, [workspace])).rows[0].total).toBe(0);
    // A stranger gets not_found before any validation, with valid and invalid input alike; a missing session is refused.
    expect(await createEvent(erin, workspace, { title: "" })).toEqual({ outcome: "not_found", event_id: null, event_version: null });
    expect(await createEvent(erin, workspace, { attendees: [bob.id] })).toEqual({ outcome: "not_found", event_id: null, event_version: null });
    expect(await createEvent(erin, randomUUID())).toEqual({ outcome: "not_found", event_id: null, event_version: null });
    await expect(asSession(null, createEventCall, eventArgs(workspace, {}))).rejects.toMatchObject({ code: "28000" });
    // The same limits hold for updates, judged on the resulting event.
    const event = await createEvent(bob, workspace, { attendees: [alice.id] });
    const patches: [unknown, string][] = [
      [{ title: " " }, "Invalid event title"], [{ title: null }, "Invalid event title"], [{ description: "x".repeat(2001) }, "Invalid event description"], [{ location: "x".repeat(201) }, "Invalid event location"],
      [{ startsAt: "2026-12-01T10:00:00Z" }, "Invalid event time"], [{ endsAt: "2026-12-01T09:04:00Z" }, "Invalid event time"], [{ startsAt: "not a time" }, "Invalid event time"],
      [{ startsAt: "now" }, "Invalid event time"], [{ startsAt: 5 }, "Invalid event time"], [{ startsAt: null }, "Invalid event time"],
      [{ timezone: "Mars/Base" }, "Invalid event timezone"], [{ timezone: null }, "Invalid event timezone"],
      [{ projectId: foreign.project }, "Invalid event project"], [{ issueId: issue }, "Invalid event issue"], [{ projectId: mine.project, issueId: foreignIssue }, "Invalid event issue"],
      [{ attendeeUserIds: [erin.id] }, "Invalid event attendees"], [{ attendeeUserIds: [alice.id, alice.id] }, "Invalid event attendees"], [{ attendeeUserIds: ["not-a-uuid"] }, "Invalid event attendees"],
      [{ attendeeUserIds: "x" }, "Invalid event attendees"], [{ attendeeUserIds: Array.from({ length: 51 }, () => randomUUID()) }, "Invalid event attendees"],
      [{ colour: "red" }, "Invalid event patch"], [{ title: "Ok", colour: "red" }, "Invalid event patch"], [[], "Invalid event patch"], ["x", "Invalid event patch"], [null, "Invalid event patch"],
    ];
    for (const [patch, message] of patches) await expectInvalidPatch(bob, event.event_id!, 1, patch, message);
    expect(await eventRow(event.event_id!)).toMatchObject({ version: 1, title: "Standup" });
    // A stranger still gets not_found before validation; so does an unknown event.
    expect(await updateEvent(erin, event.event_id!, 1, { colour: "red" })).toEqual({ outcome: "not_found", event_version: null });
    expect(await updateEvent(bob, randomUUID(), 1, { title: "" })).toEqual({ outcome: "not_found", event_version: null });
  });
  it("edits an event with optimistic concurrency", async () => {
    const { alice, bob, carol, dave, workspace } = await scheduleFixture();
    const admin = await account("Sched Admin");
    await addMember(workspace, admin, "admin");
    const event = (await createEvent(bob, workspace, { attendees: [carol.id] })).event_id!;
    expect(await updateEvent(bob, event, 1, { title: "Retro", description: "Notes", location: " Lab ", timezone: "Asia/Ho_Chi_Minh" })).toEqual({ outcome: "ok", event_version: 2 });
    expect(await eventRow(event)).toMatchObject({ title: "Retro", description: "Notes", location: "Lab", timezone: "Asia/Ho_Chi_Minh", version: 2 });
    expect(await updateEvent(admin, event, 2, { description: null, location: "" })).toEqual({ outcome: "ok", event_version: 3 });
    expect(await eventRow(event)).toMatchObject({ description: null, location: null, version: 3 });
    expect(await updateEvent(alice, event, 3, { title: "Owner edit" })).toEqual({ outcome: "ok", event_version: 4 });
    // A plain member, even an invited one, cannot edit.
    expect(await updateEvent(carol, event, 4, { title: "Mine now" })).toEqual({ outcome: "forbidden", event_version: null });
    expect(await updateEvent(dave, event, 4, { title: "Mine now" })).toEqual({ outcome: "forbidden", event_version: null });
    expect(await updateEvent(bob, event, 3, { title: "Stale" })).toEqual({ outcome: "version_mismatch", event_version: 4 });
    expect(await updateEvent(bob, event, 99, { title: "Stale" })).toEqual({ outcome: "version_mismatch", event_version: 4 });
    // No-op patches keep the version and write nothing.
    const outboxBefore = (await eventOutbox(event)).length;
    for (const patch of [{}, { title: "Owner edit" }, { timezone: "Asia/Ho_Chi_Minh", startsAt: "2026-12-01T09:00:00Z", attendeeUserIds: [carol.id] }, { projectId: null, description: null }]) {
      expect(await updateEvent(bob, event, 4, patch)).toEqual({ outcome: "ok", event_version: 4 });
    }
    expect((await eventRow(event)).version).toBe(4);
    expect((await eventOutbox(event)).length).toBe(outboxBefore);
    // Links can be added and cleared; clearing the project clears the issue it held.
    const { project } = await scrumProject(alice, workspace);
    const issue = (await createIssue(alice, project)).issue_id!;
    expect(await updateEvent(bob, event, 4, { projectId: project, issueId: issue })).toEqual({ outcome: "ok", event_version: 5 });
    expect(await eventRow(event)).toMatchObject({ project_id: project, issue_id: issue });
    expect(await updateEvent(bob, event, 5, { projectId: null, issueId: null })).toEqual({ outcome: "ok", event_version: 6 });
    expect(await eventRow(event)).toMatchObject({ project_id: null, issue_id: null });
  });
  it("lets only one of two concurrent edits win", async () => {
    const { alice, bob, workspace } = await scheduleFixture();
    const event = (await createEvent(bob, workspace)).event_id!;
    const clients = await sessionPair([bob, alice]);
    try {
      const [one, two] = clients;
      expect((await one.query(updateEventCall, [event, 1, JSON.stringify({ title: "First" })])).rows[0]).toEqual({ outcome: "ok", event_version: 2 });
      const pid = await backendPid(two);
      const second = two.query(updateEventCall, [event, 1, JSON.stringify({ title: "Second" })]);
      expect(await waitUntilBlocked(pid)).toBe(true);
      await one.query("COMMIT");
      expect((await second).rows[0]).toEqual({ outcome: "version_mismatch", event_version: 2 });
      await two.query("COMMIT");
    } finally { await closePair(clients); }
    expect(await eventRow(event)).toMatchObject({ title: "First", version: 2 });
    // A cancel that commits first turns the waiting edit into "cancelled".
    const racers = await sessionPair([alice, bob]);
    try {
      const [one, two] = racers;
      expect((await one.query(cancelEventCall, [event, 2])).rows[0]).toEqual({ outcome: "ok", event_version: 3 });
      const pid = await backendPid(two);
      const edit = two.query(updateEventCall, [event, 2, JSON.stringify({ title: "Late" })]);
      expect(await waitUntilBlocked(pid)).toBe(true);
      await one.query("COMMIT");
      expect((await edit).rows[0]).toEqual({ outcome: "cancelled", event_version: null });
      await two.query("COMMIT");
    } finally { await closePair(racers); }
    expect(await eventRow(event)).toMatchObject({ title: "First", status: "cancelled", version: 3 });
  });
  it("rescheduling resets responses and notifies", async () => {
    const { alice, bob, carol, dave, workspace } = await scheduleFixture();
    const event = (await createEvent(bob, workspace, { attendees: [alice.id, carol.id, dave.id] })).event_id!;
    expect(await respondEvent(alice, event, "accepted")).toEqual({ outcome: "ok" });
    expect(await respondEvent(carol, event, "tentative")).toEqual({ outcome: "ok" });
    expect(await respondEvent(dave, event, "declined")).toEqual({ outcome: "ok" });
    // A title-only edit leaves answers alone and sends nothing.
    expect(await updateEvent(alice, event, 1, { title: "Sync" })).toEqual({ outcome: "ok", event_version: 2 });
    expect(await attendeeStates(event)).toMatchObject({ [alice.id]: { response: "accepted" }, [carol.id]: { response: "tentative" }, [dave.id]: { response: "declined" } });
    expect(await noticeRecipients(event, "event_rescheduled")).toEqual([]);
    // Alice (an owner, not the organizer) moves it: everyone but the organizer goes back to pending.
    expect(await updateEvent(alice, event, 2, { startsAt: "2026-12-02T09:00:00Z", endsAt: "2026-12-02T10:30:00Z" })).toEqual({ outcome: "ok", event_version: 3 });
    expect(await attendeeStates(event)).toEqual({ [bob.id]: { response: "accepted", answered: true }, [alice.id]: { response: "pending", answered: false },
      [carol.id]: { response: "pending", answered: false }, [dave.id]: { response: "pending", answered: false } });
    expect(await eventRow(event)).toMatchObject({ starts_at: new Date("2026-12-02T09:00:00Z"), ends_at: new Date("2026-12-02T10:30:00Z"), version: 3 });
    const notices = await eventNotices(event, "event_rescheduled");
    expect(notices.map((row) => row.recipient_user_id)).toEqual(sortedIds(bob, carol, dave));
    expect(notices.every((row) => row.title === "Sync moved to 2026-12-02 10:00 (Europe/Berlin)" && row.resource_type === "calendar_event")).toBe(true);
    expect(await eventOutbox(event)).toEqual([{ event_type: "calendar_event.created", aggregate_version: 1, processed: true }, { event_type: "calendar_event.updated", aggregate_version: 2, processed: true },
      { event_type: "calendar_event.updated", aggregate_version: 3, processed: true }]);
    // Ending later alone also counts as a move; the organizer moving it notifies the others but not themself.
    expect(await respondEvent(carol, event, "accepted")).toEqual({ outcome: "ok" });
    expect(await updateEvent(bob, event, 3, { endsAt: "2026-12-02T11:00:00Z" })).toEqual({ outcome: "ok", event_version: 4 });
    expect((await attendeeStates(event))[carol.id]).toEqual({ response: "pending", answered: false });
    expect((await eventNotices(event, "event_rescheduled")).length).toBe(6);
    // Only members who are still active are notified.
    expect(await outcome(alice, "ws_remove_member($1,$2)", [workspace, dave.id])).toBe("ok");
    expect(await updateEvent(bob, event, 4, { startsAt: "2026-12-03T09:00:00Z", endsAt: "2026-12-03T10:00:00Z" })).toEqual({ outcome: "ok", event_version: 5 });
    expect((await eventNotices(event, "event_rescheduled")).length).toBe(8);
  });
  it("replaces attendees", async () => {
    const { alice, bob, carol, dave, workspace } = await scheduleFixture();
    const event = (await createEvent(bob, workspace, { attendees: [carol.id, dave.id] })).event_id!;
    expect(await respondEvent(carol, event, "accepted")).toEqual({ outcome: "ok" });
    expect(await updateEvent(bob, event, 1, { attendeeUserIds: [carol.id, alice.id] })).toEqual({ outcome: "ok", event_version: 2 });
    // Carol keeps her answer, Alice is new and pending, Dave is gone, the organizer stays accepted.
    expect(await attendeeStates(event)).toEqual({ [bob.id]: { response: "accepted", answered: true }, [carol.id]: { response: "accepted", answered: true }, [alice.id]: { response: "pending", answered: false } });
    expect(await noticeRecipients(event, "event_invited")).toEqual(sortedIds(alice, carol, dave));
    expect(await noticeRecipients(event, "event_rescheduled")).toEqual([]);
    // The actor adding themself gets no invitation; a re-added member is invited again.
    expect(await updateEvent(alice, event, 2, { attendeeUserIds: [carol.id, alice.id, dave.id] })).toEqual({ outcome: "ok", event_version: 3 });
    expect((await eventNotices(event, "event_invited")).length).toBe(4);
    expect((await eventNotices(event, "event_invited")).filter((row) => row.recipient_user_id === alice.id)).toHaveLength(1);
    // An empty list removes everyone but the organizer; listing the organizer is harmless.
    expect(await updateEvent(bob, event, 3, { attendeeUserIds: [] })).toEqual({ outcome: "ok", event_version: 4 });
    expect(await attendeeStates(event)).toEqual({ [bob.id]: { response: "accepted", answered: true } });
    expect(await updateEvent(alice, event, 4, { attendeeUserIds: [bob.id] })).toEqual({ outcome: "ok", event_version: 4 });
    // A member who left is dropped when the list is replaced.
    expect(await updateEvent(bob, event, 4, { attendeeUserIds: [carol.id] })).toEqual({ outcome: "ok", event_version: 5 });
    expect(await outcome(alice, "ws_remove_member($1,$2)", [workspace, carol.id])).toBe("ok");
    expect(await updateEvent(bob, event, 5, { attendeeUserIds: [] })).toEqual({ outcome: "ok", event_version: 6 });
    expect(Object.keys(await attendeeStates(event))).toEqual([bob.id]);
  });
  it("cancels an event", async () => {
    const { alice, bob, carol, dave, workspace } = await scheduleFixture();
    const event = (await createEvent(bob, workspace, { attendees: [alice.id, carol.id] })).event_id!;
    expect(await cancelEvent(dave, event, 1)).toEqual({ outcome: "forbidden", event_version: null });
    expect(await cancelEvent(carol, event, 1)).toEqual({ outcome: "forbidden", event_version: null });
    expect(await cancelEvent(bob, event, 7)).toEqual({ outcome: "version_mismatch", event_version: 1 });
    expect(await cancelEvent(alice, event, 1)).toEqual({ outcome: "ok", event_version: 2 });
    expect(await eventRow(event)).toMatchObject({ status: "cancelled", version: 2 });
    // Everyone but the actor is told, including the organizer.
    const notices = await eventNotices(event, "event_cancelled");
    expect(notices.map((row) => row.recipient_user_id)).toEqual(sortedIds(bob, carol));
    expect(notices.every((row) => row.title === "Standup was cancelled" && row.resource_type === "calendar_event")).toBe(true);
    expect((await eventOutbox(event)).at(-1)).toEqual({ event_type: "calendar_event.cancelled", aggregate_version: 2, processed: true });
    // Terminal: nothing changes it any more.
    expect(await cancelEvent(alice, event, 2)).toEqual({ outcome: "already_cancelled", event_version: null });
    expect(await cancelEvent(bob, event, 1)).toEqual({ outcome: "already_cancelled", event_version: null });
    expect(await updateEvent(bob, event, 2, { title: "Revived" })).toEqual({ outcome: "cancelled", event_version: null });
    expect(await updateEvent(bob, event, 2, {})).toEqual({ outcome: "cancelled", event_version: null });
    expect(await respondEvent(carol, event, "accepted")).toEqual({ outcome: "cancelled" });
    expect(await eventRow(event)).toMatchObject({ title: "Standup", status: "cancelled", version: 2 });
    expect((await attendeeStates(event))[carol.id]).toEqual({ response: "pending", answered: false });
    // Without authority the answer is still forbidden rather than the state.
    expect(await cancelEvent(dave, event, 2)).toEqual({ outcome: "forbidden", event_version: null });
    // The organizer cancelling notifies the invited attendees but not themself.
    const second = (await createEvent(bob, workspace, { attendees: [carol.id] })).event_id!;
    expect(await cancelEvent(bob, second, 1)).toEqual({ outcome: "ok", event_version: 2 });
    expect(await noticeRecipients(second, "event_cancelled")).toEqual([carol.id]);
  });
  it("responds to an invitation", async () => {
    const { alice, bob, carol, dave, erin, workspace } = await scheduleFixture();
    const event = (await createEvent(bob, workspace, { attendees: [carol.id] })).event_id!;
    expect(await respondEvent(carol, event, "accepted")).toEqual({ outcome: "ok" });
    expect(await attendeeStates(event)).toMatchObject({ [carol.id]: { response: "accepted", answered: true } });
    expect(await respondEvent(carol, event, "declined")).toEqual({ outcome: "ok" });
    expect(await attendeeStates(event)).toMatchObject({ [carol.id]: { response: "declined", answered: true } });
    expect(await respondEvent(carol, event, "tentative")).toEqual({ outcome: "ok" });
    // The organizer may decline their own event; answers do not bump the event version.
    expect(await respondEvent(bob, event, "declined")).toEqual({ outcome: "ok" });
    expect(await attendeeStates(event)).toMatchObject({ [bob.id]: { response: "declined", answered: true }, [carol.id]: { response: "tentative", answered: true } });
    expect((await eventRow(event)).version).toBe(1);
    // A member who is not invited (even an owner) cannot answer, and does not become an attendee.
    expect(await respondEvent(dave, event, "accepted")).toEqual({ outcome: "not_invited" });
    expect(await respondEvent(alice, event, "accepted")).toEqual({ outcome: "not_invited" });
    expect(Object.keys(await attendeeStates(event)).sort()).toEqual(sortedIds(bob, carol));
    // A stranger gets not_found, before the value is validated; so do unknown events.
    expect(await respondEvent(erin, event, "accepted")).toEqual({ outcome: "not_found" });
    expect(await respondEvent(erin, event, "bogus")).toEqual({ outcome: "not_found" });
    expect(await respondEvent(carol, randomUUID(), "accepted")).toEqual({ outcome: "not_found" });
    for (const value of ["pending", "maybe", "", "ACCEPTED"]) {
      await expect(asSession(carol.token, respondEventCall, [event, value])).rejects.toMatchObject({ code: "22023", message: "Invalid event response" });
    }
    await expect(asSession(carol.token, respondEventCall, [event, null])).rejects.toMatchObject({ code: "22023", message: "Invalid event response" });
    await expect(asSession(null, respondEventCall, [event, "accepted"])).rejects.toMatchObject({ code: "28000" });
    // A member who left can no longer answer.
    expect(await outcome(alice, "ws_remove_member($1,$2)", [workspace, carol.id])).toBe("ok");
    expect(await respondEvent(carol, event, "accepted")).toEqual({ outcome: "not_found" });
  });
  it("isolates tenants", async () => {
    const { alice, bob, carol, erin, workspace, elsewhere } = await scheduleFixture();
    const event = (await createEvent(bob, workspace, { attendees: [carol.id] })).event_id!;
    const before = await eventRow(event);
    const attendeesBefore = await attendeeStates(event);
    expect(await updateEvent(erin, event, 1, { title: "Hijack" })).toEqual({ outcome: "not_found", event_version: null });
    expect(await cancelEvent(erin, event, 1)).toEqual({ outcome: "not_found", event_version: null });
    expect(await respondEvent(erin, event, "accepted")).toEqual({ outcome: "not_found" });
    expect(await createEvent(erin, workspace)).toEqual({ outcome: "not_found", event_id: null, event_version: null });
    // Erin's own workspace cannot take Alice's members, projects or events as references.
    await expectInvalidEvent(erin, elsewhere, { attendees: [alice.id] }, "Invalid event attendees");
    const foreign = await scrumProject(alice, workspace);
    await expectInvalidEvent(erin, elsewhere, { project: foreign.project }, "Invalid event project");
    await expectInvalidPatch(erin, (await createEvent(erin, elsewhere)).event_id!, 1, { attendeeUserIds: [bob.id] }, "Invalid event attendees");
    expect(await eventRow(event)).toEqual(before);
    expect(await attendeeStates(event)).toEqual(attendeesBefore);
    // Each session sees only its own workspace's events through the table.
    expect((await asSession(erin.token, `SELECT id FROM ${table("calendar_events")} WHERE id=$1`, [event])).rows).toEqual([]);
    expect((await asSession(carol.token, `SELECT id FROM ${table("calendar_events")} WHERE id=$1`, [event])).rows).toEqual([{ id: event }]);
    // Runtime roles cannot write the calendar tables directly.
    for (const name of ["calendar_events", "event_attendees"]) {
      for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
        expect((await owner.query("SELECT has_table_privilege('spark_app',$1,$2) AS allowed", [`"${namespace}"."${name}"`, privilege])).rows[0].allowed).toBe(false);
      }
    }
  });
  it("keeps the event functions pinned and the helpers internal", async () => {
    await owner.query("SET ROLE spark_owner");
    const granted = ["ws_cancel_event", "ws_create_event", "ws_respond_event", "ws_update_event"], internal = ["check_event_fields", "maintain_calendar_event", "valid_timezone"];
    const rows = (await owner.query(`SELECT p.proname, p.prosecdef, p.proconfig, has_function_privilege('spark_app',p.oid,'EXECUTE') AS runtime,
      EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname = ANY($2) ORDER BY p.proname`, [namespace, [...granted, ...internal]])).rows;
    expect(rows.map((row) => row.proname)).toEqual([...granted, ...internal].sort());
    for (const row of rows) {
      const isGranted = granted.includes(row.proname);
      expect({ name: row.proname, definer: row.prosecdef, config: row.proconfig, runtime: row.runtime, public: row.public })
        .toEqual({ name: row.proname, definer: isGranted, config: ['search_path=""'], runtime: isGranted, public: false });
    }
    // The notification kinds are a closed set.
    const kinds = (await owner.query(`SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c WHERE c.conname='notifications_kind_allowed' AND c.connamespace=$1::regnamespace`, [namespace])).rows[0].definition as string;
    for (const kind of ["invitation_accepted", "issue_assigned", "sprint_started", "event_invited", "event_rescheduled", "event_cancelled"]) expect(kinds).toContain(`'${kind}'`);
    // Timezone names must exist in the server's zone list.
    expect((await owner.query(`SELECT ${fn("valid_timezone")}('Europe/Berlin') AS ok, ${fn("valid_timezone")}('Mars/Base') AS bad, ${fn("valid_timezone")}(NULL) AS missing, ${fn("valid_timezone")}('') AS blank`)).rows[0])
      .toEqual({ ok: true, bad: false, missing: false, blank: false });
  });
});

describe("Calendar deadlines", () => {
  // The route's own deadline query, with its schema rewritten to the throwaway one.
  const deadlineSql = DEADLINES_SQL.replace(/\bspark\./gu, `"${namespace}".`);
  async function deadlinesIn(workspace: string, from: string, to: string, tz: string) {
    await owner.query("SET ROLE spark_owner");
    return (await owner.query(deadlineSql, [workspace, from, to, tz])).rows.map((row) => `${row.deadline_kind}:${row.due}:${row.title}`);
  }
  it("selects task, sprint and milestone dates by calendar date in the viewer's zone", async () => {
    const fx = await insightProject(await account("Deadlines"));
    const at = "2026-10-20T10:00:00Z";
    const task = (due: string, category: Category) => issueHistory(fx, [{ at, after: { category } }], { due });
    await task("2026-11-08", "todo");
    await task("2026-11-09", "todo");
    await task("2026-11-02", "in_progress");
    await task("2026-11-01", "todo");
    await task("2026-11-04", "done");
    await owner.query("SET ROLE spark_owner");
    // Sprint days are stored as midnight UTC.
    await owner.query(`INSERT INTO ${table("sprints")} (tenant_id,project_id,name,starts_at,ends_at,status) VALUES ($1,$2,'Sprint ends',$3,$4,'planned')`,
      [fx.workspace, fx.project, "2026-10-26T00:00:00Z", "2026-11-05T00:00:00Z"]);
    await owner.query(`INSERT INTO ${table("project_milestones")} (tenant_id,project_id,name,due_date) VALUES ($1,$2,'Beta',$3)`, [fx.workspace, fx.project, "2026-11-04"]);
    const expected = [
      "task_due:2026-11-02:Insight",
      "milestone_due:2026-11-04:Beta",
      "sprint_end:2026-11-05:Sprint ends",
      "task_due:2026-11-08:Insight",
    ];
    // The viewer's local week of Mon Nov 2 to Sun Nov 8 in each zone; every deadline keeps its stored date.
    expect(await deadlinesIn(fx.workspace, "2026-11-02T05:00:00.000Z", "2026-11-09T05:00:00.000Z", "America/New_York")).toEqual(expected);
    expect(await deadlinesIn(fx.workspace, "2026-11-01T17:00:00.000Z", "2026-11-08T17:00:00.000Z", "Asia/Ho_Chi_Minh")).toEqual(expected);
    expect(await deadlinesIn(fx.workspace, "2026-11-02T00:00:00.000Z", "2026-11-09T00:00:00.000Z", "UTC")).toEqual(expected);
    // The next local week starts at the next day.
    expect(await deadlinesIn(fx.workspace, "2026-11-09T05:00:00.000Z", "2026-11-16T05:00:00.000Z", "America/New_York")).toEqual(["task_due:2026-11-09:Insight"]);
  });
});

type InboxRow = { id: string; tenant_id: string; workspace_slug: string; workspace_name: string; kind: string; title: string; body: string | null;
  resource_type: string; resource_id: string; link: string | null; created_at: Date; read_at: Date | null };
const inboxBase = Date.parse("2026-10-01T10:00:00Z");
const inboxAt = (minutes: number) => new Date(inboxBase + minutes * 60_000);
// Plants one notification (with the outbox row it references) as the table owner and returns its id.
async function plantNotice(workspace: string, recipient: Account, kind: string, resourceType: string, resource: string, minutes: number, title = "Notice") {
  await owner.query("SET ROLE spark_owner");
  const event = (await owner.query(`INSERT INTO ${table("outbox_events")} (tenant_id,event_type,aggregate_type,aggregate_id,aggregate_version,payload,processed_at)
    VALUES ($1,'test','workspace',$2,1,'{}',now()) RETURNING id`, [workspace, randomUUID()])).rows[0].id as string;
  return (await owner.query(`INSERT INTO ${table("notifications")} (tenant_id,recipient_user_id,outbox_event_id,kind,title,body,resource_type,resource_id,created_at)
    VALUES ($1,$2,$3,$4,$5,'Body',$6,$7,$8) RETURNING id`, [workspace, recipient.id, event, kind, title, resourceType, resource, inboxAt(minutes)])).rows[0].id as string;
}
const listCall = `SELECT * FROM ${fn("ws_list_notifications")}($1,$2,$3,$4)`;
async function listNotices(who: Account | null, unread = false, before: [Date, string] | null = null, limit = 100) {
  return (await asSession(who?.token ?? null, listCall, [unread, before?.[0] ?? null, before?.[1] ?? null, limit])).rows as InboxRow[];
}
const unreadCount = async (who: Account) => (await asSession(who.token, `SELECT ${fn("ws_unread_notification_count")}() AS total`)).rows[0].total as number;
const markOne = async (who: Account, id: string | null) => (await asSession(who.token, `SELECT * FROM ${fn("ws_mark_notification_read")}($1)`, [id])).rows[0].outcome as string;
const markAll = async (who: Account, before: Date | null) => (await asSession(who.token, `SELECT * FROM ${fn("ws_mark_notifications_read")}($1)`, [before])).rows[0].updated as number;
const readAtOf = async (id: string) => {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT read_at FROM ${table("notifications")} WHERE id=$1`, [id])).rows[0].read_at as Date | null;
};
const preferences = async (who: Account) => (await asSession(who.token, `SELECT * FROM ${fn("ws_get_notification_preferences")}()`)).rows[0];
const setPreferences = async (token: Buffer | null, assigned: boolean | null, reminders: boolean | null, digest: boolean | null, zone: string | null) =>
  (await asSession(token, `SELECT * FROM ${fn("ws_set_notification_preferences")}($1,$2,$3,$4)`, [assigned, reminders, digest, zone])).rows[0].outcome as string;
const slugOf = async (workspace: string) => {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT slug FROM ${table("workspaces")} WHERE id=$1`, [workspace])).rows[0].slug as string;
};

describe("Notification inbox", () => {
  it("lists only the actor's visible notifications", async () => {
    const alice = await account("Inbox Alice"), bob = await account("Inbox Bob"), carol = await account("Inbox Carol");
    const kanban = await kanbanProject(alice), workspace = kanban.workspace;
    await addMember(workspace, bob, "member");
    const elsewhere = (await createWorkspace(carol)).workspace_id!;
    await addMember(elsewhere, bob, "member");
    const slug = await slugOf(workspace), otherSlug = await slugOf(elsewhere);
    const scrum = await scrumProject(alice, workspace);
    const issue = (await createIssue(alice, kanban.project, { title: "Linked" })).issue_id!;
    const sprint = (await createSprint(alice, scrum.project, "Launch")).sprint_id!;
    const event = (await createEvent(alice, workspace, { starts: "2026-12-06T23:30:00Z", ends: "2026-12-07T00:30:00Z" })).event_id!;
    const forIssue = await plantNotice(workspace, bob, "issue_assigned", "issue", issue, 1, "Issue");
    const forSprint = await plantNotice(workspace, bob, "sprint_started", "sprint", sprint, 2, "Sprint");
    const forEvent = await plantNotice(workspace, bob, "event_invited", "calendar_event", event, 3, "Event");
    const forWorkspace = await plantNotice(workspace, bob, "invitation_accepted", "workspace", workspace, 4, "Workspace");
    const foreign = await plantNotice(elsewhere, bob, "invitation_accepted", "workspace", elsewhere, 5, "Elsewhere");
    await plantNotice(workspace, alice, "invitation_accepted", "workspace", workspace, 6, "Alice only");
    await plantNotice(elsewhere, carol, "invitation_accepted", "workspace", elsewhere, 7, "Carol only");

    const rows = await listNotices(bob);
    expect(rows.map((row) => row.id)).toEqual([foreign, forWorkspace, forEvent, forSprint, forIssue]);
    expect(rows[0]).toEqual({ id: foreign, tenant_id: elsewhere, workspace_slug: otherSlug, workspace_name: "Acme", kind: "invitation_accepted", title: "Elsewhere", body: "Body",
      resource_type: "workspace", resource_id: elsewhere, link: `/w/${otherSlug}/members`, created_at: inboxAt(5), read_at: null });
    expect(Object.fromEntries(rows.map((row) => [row.id, row.link]))).toEqual({
      [foreign]: `/w/${otherSlug}/members`, [forWorkspace]: `/w/${slug}/members`,
      [forEvent]: `/w/${slug}/schedule?week=2026-11-30`, [forSprint]: `/w/${slug}/p/${scrum.key}/backlog`, [forIssue]: `/w/${slug}/p/${kanban.key}?issue=${kanban.key}-1` });
    expect((await listNotices(alice)).map((row) => row.title)).toEqual(["Alice only"]);
    await expect(listNotices(null)).rejects.toMatchObject({ code: "28000" });

    // Keyset pages of two cover every row once, newest first.
    const first = await listNotices(bob, false, null, 2);
    const second = await listNotices(bob, false, [first[1]!.created_at, first[1]!.id], 2);
    const third = await listNotices(bob, false, [second[1]!.created_at, second[1]!.id], 2);
    expect([first, second, third].map((page) => page.length)).toEqual([2, 2, 1]);
    expect([...first, ...second, ...third].map((row) => row.id)).toEqual(rows.map((row) => row.id));
    expect(await listNotices(bob, false, [third[0]!.created_at, third[0]!.id], 2)).toEqual([]);
    // Equal timestamps are ordered and paged by id.
    const tieA = await plantNotice(workspace, bob, "invitation_accepted", "workspace", workspace, 9, "Tie");
    const tieB = await plantNotice(workspace, bob, "invitation_accepted", "workspace", workspace, 9, "Tie");
    const [tieFirst, tieSecond] = [tieA, tieB].sort().reverse() as [string, string];
    const tied = await listNotices(bob, false, null, 2);
    expect(tied.map((row) => row.id)).toEqual([tieFirst, tieSecond]);
    expect((await listNotices(bob, false, [tied[0]!.created_at, tied[0]!.id], 1)).map((row) => row.id)).toEqual([tieSecond]);

    // Unread filter.
    expect(await markOne(bob, forEvent)).toBe("ok");
    expect((await listNotices(bob, true)).map((row) => row.id)).not.toContain(forEvent);
    expect((await listNotices(bob, false)).find((row) => row.id === forEvent)!.read_at).toBeInstanceOf(Date);

    // An archived issue and an archived project have no link.
    expect(await updateIssue(alice, issue, 1, { archived: true })).toMatchObject({ outcome: "ok" });
    expect((await listNotices(bob)).find((row) => row.id === forIssue)!.link).toBeNull();
    await owner.query("SET ROLE spark_owner");
    await owner.query(`UPDATE ${table("projects")} SET archived_at=now() WHERE id=$1`, [scrum.project]);
    expect((await listNotices(bob)).find((row) => row.id === forSprint)!.link).toBeNull();

    // Leaving hides that workspace's rows; rejoining shows them again.
    expect(await outcome(bob, "ws_remove_member($1,$2)", [workspace, bob.id])).toBe("ok");
    expect((await listNotices(bob)).map((row) => row.id)).toEqual([foreign]);
    const { token } = await inviteWithToken(alice, workspace, bob.email, "member");
    expect(await accept(bob, token)).toMatchObject({ outcome: "ok" });
    expect((await listNotices(bob)).map((row) => row.id)).toEqual([tieFirst, tieSecond, foreign, forWorkspace, forEvent, forSprint, forIssue]);
  });

  it("validates the cursor and the limit", async () => {
    const bob = await account("Inbox Validation");
    const at = new Date(), id = randomUUID();
    for (const [created, before] of [[at, null], [null, id]] as const) {
      await expect(asSession(bob.token, listCall, [false, created, before, 10])).rejects.toMatchObject({ code: "22023", message: "Invalid notification cursor" });
    }
    for (const limit of [0, 101, -1, null]) {
      await expect(asSession(bob.token, listCall, [false, null, null, limit])).rejects.toMatchObject({ code: "22023", message: "Invalid notification limit" });
    }
    expect(await listNotices(bob, false, null, 1)).toEqual([]);
    expect(await listNotices(bob, false, null, 100)).toEqual([]);
    expect(await listNotices(bob, false, [at, id], 100)).toEqual([]);
  });

  it("counts unread up to 100", async () => {
    const alice = await account("Count Alice"), bob = await account("Count Bob");
    const workspace = (await createWorkspace(alice)).workspace_id!;
    await addMember(workspace, bob, "member");
    expect(await unreadCount(bob)).toBe(0);
    await owner.query("SET ROLE spark_owner");
    await owner.query(`WITH ev AS (INSERT INTO ${table("outbox_events")} (tenant_id,event_type,aggregate_type,aggregate_id,aggregate_version,payload,processed_at)
        SELECT $1,'test','workspace',gen_random_uuid(),1,'{}',now() FROM generate_series(1,101) RETURNING id)
      INSERT INTO ${table("notifications")} (tenant_id,recipient_user_id,outbox_event_id,kind,title,resource_type,resource_id)
        SELECT $1,$2,id,'invitation_accepted','Bulk','workspace',$1 FROM ev`, [workspace, bob.id]);
    expect(await unreadCount(bob)).toBe(100);
    expect(await unreadCount(alice)).toBe(0);
    expect(await listNotices(bob, true, null, 100)).toHaveLength(100);
    expect(await markAll(bob, new Date(Date.now() + 60_000))).toBe(101);
    expect(await unreadCount(bob)).toBe(0);
    await plantNotice(workspace, bob, "invitation_accepted", "workspace", workspace, 1);
    expect(await unreadCount(bob)).toBe(1);
    await expect(asSession(null, `SELECT ${fn("ws_unread_notification_count")}()`)).rejects.toMatchObject({ code: "28000" });
  });

  it("marks one read idempotently", async () => {
    const alice = await account("Mark Alice"), bob = await account("Mark Bob"), carol = await account("Mark Carol");
    const workspace = (await createWorkspace(alice)).workspace_id!;
    await addMember(workspace, bob, "member");
    await addMember(workspace, carol, "member");
    const mine = await plantNotice(workspace, bob, "invitation_accepted", "workspace", workspace, 1);
    const hers = await plantNotice(workspace, carol, "invitation_accepted", "workspace", workspace, 2);
    expect(await readAtOf(mine)).toBeNull();
    expect(await markOne(bob, mine)).toBe("ok");
    const firstRead = await readAtOf(mine);
    expect(firstRead).toBeInstanceOf(Date);
    expect(await markOne(bob, mine)).toBe("ok");
    expect(await readAtOf(mine)).toEqual(firstRead);
    // Another user's id, an unknown id and a missing id are the same not_found and change nothing.
    expect(await markOne(bob, hers)).toBe("not_found");
    expect(await markOne(bob, randomUUID())).toBe("not_found");
    expect(await markOne(bob, null)).toBe("not_found");
    expect(await readAtOf(hers)).toBeNull();
    // A workspace the actor left is indistinguishable from an unknown id until they rejoin.
    expect(await outcome(carol, "ws_remove_member($1,$2)", [workspace, carol.id])).toBe("ok");
    expect(await markOne(carol, hers)).toBe("not_found");
    expect(await readAtOf(hers)).toBeNull();
    const { token } = await inviteWithToken(alice, workspace, carol.email, "member");
    expect(await accept(carol, token)).toMatchObject({ outcome: "ok" });
    expect(await markOne(carol, hers)).toBe("ok");
    expect(await readAtOf(hers)).toBeInstanceOf(Date);
    await expect(asSession(null, `SELECT * FROM ${fn("ws_mark_notification_read")}($1)`, [mine])).rejects.toMatchObject({ code: "28000" });
  });

  it("marks all read before an instant", async () => {
    const alice = await account("All Alice"), bob = await account("All Bob");
    const workspace = (await createWorkspace(alice)).workspace_id!;
    await addMember(workspace, bob, "member");
    const elsewhere = (await createWorkspace(await account("All Carol"))).workspace_id!;
    await addMember(elsewhere, bob, "member");
    const old = await plantNotice(workspace, bob, "invitation_accepted", "workspace", workspace, 1);
    const edge = await plantNotice(workspace, bob, "invitation_accepted", "workspace", workspace, 2);
    const later = await plantNotice(workspace, bob, "invitation_accepted", "workspace", workspace, 3);
    const others = await plantNotice(workspace, alice, "invitation_accepted", "workspace", workspace, 1);
    const hidden = await plantNotice(elsewhere, bob, "invitation_accepted", "workspace", elsewhere, 1);
    expect(await outcome(bob, "ws_remove_member($1,$2)", [elsewhere, bob.id])).toBe("ok");
    // Already read rows are not counted and keep their time.
    expect(await markOne(bob, old)).toBe("ok");
    const oldRead = await readAtOf(old);
    expect(await markAll(bob, inboxAt(2))).toBe(1);
    expect(await readAtOf(old)).toEqual(oldRead);
    expect(await readAtOf(edge)).toBeInstanceOf(Date);
    expect(await readAtOf(later)).toBeNull();
    expect(await readAtOf(others)).toBeNull();
    expect(await readAtOf(hidden)).toBeNull();
    expect(await unreadCount(bob)).toBe(1);
    expect(await markAll(bob, inboxAt(2))).toBe(0);
    expect(await markAll(bob, inboxAt(10))).toBe(1);
    expect(await readAtOf(hidden)).toBeNull();
    await expect(markAll(bob, null)).rejects.toMatchObject({ code: "22023", message: "Invalid notification before" });
    await expect(asSession(null, `SELECT * FROM ${fn("ws_mark_notifications_read")}($1)`, [inboxAt(1)])).rejects.toMatchObject({ code: "28000" });
  });

  it("stores preferences and time zone", async () => {
    const alice = await account("Pref Alice"), bob = await account("Pref Bob");
    const { workspace, project } = await kanbanProject(alice);
    await addMember(workspace, bob, "member");
    expect(await preferences(alice)).toEqual({ task_assigned: true, due_reminders: true, weekly_digest: true, timezone: "UTC" });
    expect(await setPreferences(alice.token, false, true, false, "Asia/Ho_Chi_Minh")).toBe("ok");
    expect(await preferences(alice)).toEqual({ task_assigned: false, due_reminders: true, weekly_digest: false, timezone: "Asia/Ho_Chi_Minh" });
    expect(await setPreferences(alice.token, false, false, true, "Asia/Ho_Chi_Minh")).toBe("ok");
    expect(await preferences(alice)).toEqual({ task_assigned: false, due_reminders: false, weekly_digest: true, timezone: "Asia/Ho_Chi_Minh" });
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT kind,channel,enabled FROM ${table("notification_preferences")} WHERE user_id=$1 ORDER BY kind`, [alice.id])).rows)
      .toEqual([{ kind: "due_reminders", channel: "email", enabled: false }, { kind: "task_assigned", channel: "email", enabled: false }, { kind: "weekly_digest", channel: "email", enabled: true }]);
    // Another user is untouched.
    expect(await preferences(bob)).toEqual({ task_assigned: true, due_reminders: true, weekly_digest: true, timezone: "UTC" });
    expect((await owner.query(`SELECT count(*)::integer AS total FROM ${table("notification_preferences")} WHERE user_id=$1`, [bob.id])).rows[0].total).toBe(0);
    // Invalid input changes nothing.
    for (const zone of ["Mars/Base", "", "utc-ish"]) {
      await expect(setPreferences(alice.token, true, true, true, zone)).rejects.toMatchObject({ code: "22023", message: "Invalid timezone" });
    }
    for (const args of [[null, true, true, "UTC"], [true, null, true, "UTC"], [true, true, null, "UTC"], [true, true, true, null]] as const) {
      await expect(setPreferences(alice.token, ...args)).rejects.toMatchObject({ code: "22023", message: "Invalid notification preferences" });
    }
    expect(await preferences(alice)).toEqual({ task_assigned: false, due_reminders: false, weekly_digest: true, timezone: "Asia/Ho_Chi_Minh" });
    await expect(asSession(null, `SELECT * FROM ${fn("ws_get_notification_preferences")}()`)).rejects.toMatchObject({ code: "28000" });
    await expect(setPreferences(null, true, true, true, "UTC")).rejects.toMatchObject({ code: "28000" });

    // The assignment email honours the switch.
    const view = async (id: string) => (await workerRuntime.query(`SELECT status FROM ${fn("worker_task_assigned_email")}($1)`, [id])).rows[0]?.status as string;
    const assigned = (await createIssue(alice, project, { title: "Mail me", assignee: bob.id })).issue_id!;
    await owner.query("SET ROLE spark_owner");
    const notice = (await owner.query(`SELECT id FROM ${table("notifications")} WHERE resource_id=$1 AND recipient_user_id=$2`, [assigned, bob.id])).rows[0].id as string;
    expect(await view(notice)).toBe("pending");
    expect(await setPreferences(bob.token, false, true, true, "UTC")).toBe("ok");
    expect(await view(notice)).toBe("skipped");
    expect(await setPreferences(bob.token, true, false, false, "UTC")).toBe("ok");
    expect(await view(notice)).toBe("pending");
  });

  it("keeps the inbox functions definers with an empty search_path, granted to the runtime role only", async () => {
    await owner.query("SET ROLE spark_owner");
    const names = ["ws_get_notification_preferences", "ws_list_notifications", "ws_mark_notification_read", "ws_mark_notifications_read", "ws_set_notification_preferences", "ws_unread_notification_count"];
    const rows = (await owner.query(`SELECT p.proname, p.prosecdef, p.proconfig, has_function_privilege('spark_app',p.oid,'EXECUTE') AS runtime,
      has_function_privilege('spark_worker',p.oid,'EXECUTE') AS worker, has_function_privilege('spark_auth',p.oid,'EXECUTE') AS auth,
      EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname = ANY($2) ORDER BY p.proname`, [namespace, names])).rows;
    expect(rows.map((row) => row.proname)).toEqual(names);
    for (const row of rows) {
      expect({ name: row.proname, definer: row.prosecdef, config: row.proconfig, runtime: row.runtime, worker: row.worker, auth: row.auth, public: row.public })
        .toEqual({ name: row.proname, definer: true, config: ['search_path=""'], runtime: true, worker: false, auth: false, public: false });
    }
    // The runtime role has no write access to either table.
    for (const name of ["notifications", "notification_preferences"]) {
      for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
        expect((await owner.query("SELECT has_table_privilege('spark_app',$1,$2) AS allowed", [`"${namespace}"."${name}"`, privilege])).rows[0].allowed).toBe(false);
      }
    }
  });
});

// ---------- Scheduled reminder and digest ledger (0029) ----------
type Claimed = { id: string; user_id: string; tenant_id: string | null; period: string; token?: string };
const claimSql = `SELECT id,user_id,tenant_id,period::text AS period FROM ${fn("scheduled_emails_claim_at")}($1,$2,$3,$4,$5)`;
const wrapperSql = `SELECT id,user_id,tenant_id,period::text AS period FROM ${fn("worker_claim_scheduled_emails")}($1,$2,$3,$4)`;
// The instant-taking claim is owner-only (the worker's wrapper uses the database clock), so fixed times run as the owner.
const ownerRows = async (sql: string, args: unknown[]) => {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(sql, args)).rows;
};
const settleSql = `SELECT ${fn("worker_settle_scheduled_email")}($1,$2,$3,$4,$5) AS settled`;
const settle = async (id: string, token: string | null, status: string, code: string | null = null, retryAt: string | null = null) =>
  (await workerRuntime.query(settleSql, [id, token, status, code, retryAt])).rows[0].settled as boolean;
// Claims every due row of the job at `now` (leases of 60 s) and returns the ones that belong to `who`. By default the
// returned rows are settled as sent, so a later claim at another instant starts from a clean ledger.
async function claimFor(job: string, now: string, who: Account[], settled = true) {
  const mine = new Set(who.map((person) => person.id)), found: Claimed[] = [], token = randomUUID();
  for (let round = 0; round < 40; round++) {
    const rows = (await ownerRows(claimSql, [job, now, token, 50, 60])) as Claimed[];
    found.push(...rows.filter((row) => mine.has(row.user_id)).map((row) => ({ ...row, token })));
    if (rows.length < 50) break;
  }
  if (settled) for (const row of found) expect(await settle(row.id, token, "sent")).toBe(true);
  return found.sort((a, b) => (a.user_id + (a.tenant_id ?? "")).localeCompare(b.user_id + (b.tenant_id ?? "")));
}
const idsOf = (rows: Claimed[]) => rows.map((row) => row.user_id).sort();
async function ledger(who: Account[], job: string) {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT id,user_id,tenant_id,period::text AS period,status,attempts,locked_until,lock_token,last_error_code,sent_at
    FROM ${table("scheduled_emails")} WHERE user_id = ANY($1) AND job=$2 ORDER BY period,user_id,tenant_id`, [who.map((person) => person.id), job])).rows;
}
async function setZone(who: Account, zone: string) {
  await owner.query("SET ROLE spark_owner");
  await owner.query(`UPDATE ${table("users")} SET timezone=$2 WHERE id=$1`, [who.id, zone]);
}
const task = async (who: Account, project: string, assignee: Account | null, due: string | null, title = "Task") =>
  (await createIssue(who, project, { title, assignee: assignee?.id ?? null, due })).issue_id!;
const reminderCall = `SELECT status,email,recipient_name,total,task_workspace,task_workspace_slug,task_key,task_title,task_due::text AS task_due,task_overdue FROM ${fn("worker_due_reminder_email")}($1,$2)`;
const digestCall = `SELECT status,email,recipient_name,workspace_name,workspace_slug,section,project_key,project_name,methodology,label,value::float8 AS value,extra FROM ${fn("worker_weekly_digest_email")}($1,$2)`;
const reminderOf = async (id: string, token: string | null) => (await workerRuntime.query(reminderCall, [id, token])).rows;
const digestOf = async (id: string, token: string | null) => (await workerRuntime.query(digestCall, [id, token])).rows;
const finishIssue = async (who: Account, project: string, issue: string, version = 1) =>
  expect(await updateIssue(who, issue, version, { statusId: await statusNamed(project, "Done") })).toMatchObject({ outcome: "ok" });
const leave = async (workspace: string, who: Account) => {
  await owner.query("SET ROLE spark_owner");
  await owner.query(`UPDATE ${table("workspace_memberships")} SET status='left',left_at=now() WHERE tenant_id=$1 AND user_id=$2`, [workspace, who.id]);
};
const skippedReminder = { status: "skipped", email: null, recipient_name: null, total: null, task_workspace: null, task_workspace_slug: null, task_key: null, task_title: null, task_due: null, task_overdue: null };

describe("Scheduled emails", () => {
  it("enumerates due reminders in each user's local morning", async () => {
    const boss = await account("Sched Boss"), { workspace, project } = await kanbanProject(boss);
    const names = ["vn", "la", "utc", "late", "far", "done", "archived", "left", "off", "none"] as const;
    const p = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await account(`Sched ${name}`)]))) as Record<(typeof names)[number], Account>;
    for (const person of Object.values(p)) await addMember(workspace, person, "member");
    await setZone(p.vn, "Asia/Ho_Chi_Minh"); await setZone(p.la, "America/Los_Angeles");
    for (const name of ["vn", "la", "utc"] as const) await task(boss, project, p[name], "2026-11-04");
    await task(boss, project, p.late, "2026-10-01");
    await task(boss, project, p.far, "2026-11-05");
    await finishIssue(boss, project, await task(boss, project, p.done, "2026-11-03"));
    expect(await updateIssue(boss, await task(boss, project, p.archived, "2026-11-03"), 1, { archived: true })).toMatchObject({ outcome: "ok" });
    await task(boss, project, p.left, "2026-11-03");
    await leave(workspace, p.left);
    await task(boss, project, p.off, "2026-11-03");
    expect(await setPreferences(p.off.token, true, false, true, "UTC")).toBe("ok");
    await task(boss, project, null, "2026-11-03");
    const everyone = Object.values(p);

    // 07:59 local in Ho Chi Minh, 07:59 in UTC and the Los Angeles day before: nobody is due yet.
    expect(await claimFor("due_reminders", "2026-11-03T00:59:00Z", everyone)).toEqual([]);
    expect(idsOf(await claimFor("due_reminders", "2026-11-03T01:00:00Z", everyone))).toEqual([p.vn.id]);
    expect(await claimFor("due_reminders", "2026-11-03T07:59:00Z", everyone)).toEqual([]);
    const morning = await claimFor("due_reminders", "2026-11-03T08:00:00Z", everyone);
    expect(idsOf(morning)).toEqual([p.utc.id, p.late.id].sort());
    expect(morning.every((row) => row.tenant_id === null && row.period === "2026-11-03")).toBe(true);
    expect(await claimFor("due_reminders", "2026-11-03T15:59:00Z", everyone)).toEqual([]);
    expect(idsOf(await claimFor("due_reminders", "2026-11-03T16:00:00Z", everyone))).toEqual([p.la.id]);
    // A second run (and a late one the same day) never repeats a user's row.
    expect(await claimFor("due_reminders", "2026-11-03T16:00:00Z", everyone)).toEqual([]);
    expect(await claimFor("due_reminders", "2026-11-03T23:00:00Z", everyone)).toEqual([]);
    const rows = await ledger(everyone, "due_reminders");
    expect(rows.map((row) => [row.user_id, row.period, row.status]).sort()).toEqual(
      [p.vn, p.la, p.utc, p.late].map((person) => [person.id, "2026-11-03", "sent"]).sort());
    // These jobs only email: nothing is written to the inbox.
    expect(await countRows(`${table("notifications")} WHERE recipient_user_id = ANY($1) AND kind <> 'issue_assigned'`, [everyone.map((person) => person.id)])).toBe(0);
    // The next local morning in Ho Chi Minh is a new period.
    expect(idsOf(await claimFor("due_reminders", "2026-11-04T01:00:00Z", everyone))).toEqual([p.vn.id]);
    expect(await ledger([p.vn], "due_reminders")).toHaveLength(2);
  });

  it("catches up later the same local day and never sends for a past day", async () => {
    const boss = await account("Catch Boss"), { workspace, project } = await kanbanProject(boss);
    const user = await account("Catch User");
    await addMember(workspace, user, "member");
    await task(boss, project, user, "2026-11-03");
    // The first run of the day happens at 20:00 UTC.
    const [late] = await claimFor("due_reminders", "2026-11-03T20:00:00Z", [user], false);
    expect(late).toMatchObject({ user_id: user.id, period: "2026-11-03" });
    // Unsettled, the lease runs out and the next local day arrives: the old period is suppressed, not sent.
    expect(await claimFor("due_reminders", "2026-11-04T07:00:00Z", [user])).toEqual([]);
    expect((await ledger([user], "due_reminders")).map((row) => [row.period, row.status, row.last_error_code])).toEqual([["2026-11-03", "suppressed", "expired"]]);
    expect(idsOf(await claimFor("due_reminders", "2026-11-04T08:00:00Z", [user]))).toEqual([user.id]);
    expect((await ledger([user], "due_reminders")).map((row) => [row.period, row.status])).toEqual([["2026-11-03", "suppressed"], ["2026-11-04", "sent"]]);
  });

  it("enumerates the weekly digest on local Monday only", async () => {
    const boss = await account("Digest Boss");
    const one = await kanbanProject(boss), two = await kanbanProject(boss);
    const empty = (await createWorkspace(boss, "Empty")).workspace_id!;
    const archivedWorkspace = await kanbanProject(boss);
    const names = ["utc", "vn", "off", "left", "outsider"] as const;
    const p = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await account(`Digest ${name}`)]))) as Record<(typeof names)[number], Account>;
    for (const person of [p.utc, p.vn, p.off, p.left]) for (const space of [one.workspace, two.workspace, empty, archivedWorkspace.workspace]) await addMember(space, person, "member");
    await setZone(p.vn, "Asia/Ho_Chi_Minh");
    expect(await setPreferences(p.off.token, true, true, false, "UTC")).toBe("ok");
    await leave(one.workspace, p.left);
    await owner.query("SET ROLE spark_owner");
    await owner.query(`UPDATE ${table("workspaces")} SET archived_at=now(),version=version+1 WHERE id=$1`, [archivedWorkspace.workspace]);
    const everyone = Object.values(p);

    // Sunday 23:00 UTC is Monday 06:00 in Ho Chi Minh: not yet. Monday 01:00 UTC is 08:00 there.
    expect(await claimFor("weekly_digest", "2026-11-01T23:00:00Z", everyone)).toEqual([]);
    const vn = await claimFor("weekly_digest", "2026-11-02T01:00:00Z", everyone);
    expect(vn.map((row) => [row.user_id, row.tenant_id, row.period]).sort()).toEqual(
      [one.workspace, two.workspace].map((space) => [p.vn.id, space, "2026-11-02"]).sort());
    expect(await claimFor("weekly_digest", "2026-11-02T07:59:00Z", everyone)).toEqual([]);
    const monday = await claimFor("weekly_digest", "2026-11-02T08:00:00Z", everyone);
    expect(monday.map((row) => [row.user_id, row.tenant_id]).sort()).toEqual(
      [[p.utc.id, one.workspace], [p.utc.id, two.workspace], [p.left.id, two.workspace]].sort());
    // Later the same day and the next day: no repeat, and Tuesday is not a digest day.
    expect(await claimFor("weekly_digest", "2026-11-02T20:00:00Z", everyone)).toEqual([]);
    expect(await claimFor("weekly_digest", "2026-11-03T08:00:00Z", everyone)).toEqual([]);
    expect(await ledger(everyone, "weekly_digest")).toHaveLength(5);
    expect(await countRows(`${table("scheduled_emails")} WHERE tenant_id = ANY($1)`, [[empty, archivedWorkspace.workspace]])).toBe(0);
    // The next Monday is a new period.
    expect((await claimFor("weekly_digest", "2026-11-09T08:00:00Z", [p.utc])).map((row) => row.period)).toEqual(["2026-11-09", "2026-11-09"]);
  });

  it("lets only one enumerator hold the job lock but still claims pending rows", async () => {
    const boss = await account("Lock Boss"), { workspace, project } = await kanbanProject(boss);
    const a = await account("Lock A"), b = await account("Lock B"), c = await account("Lock C");
    for (const person of [a, b, c]) { await addMember(workspace, person, "member"); await task(boss, project, person, "2026-11-03"); }
    // C already has a pending row; A and B have none yet.
    await owner.query("SET ROLE spark_owner");
    await owner.query(`INSERT INTO ${table("scheduled_emails")} (user_id,job,period) VALUES ($1,'due_reminders','2026-11-03')`, [c.id]);
    const connect = async () => {
      const client = new pg.Client({ connectionString: localConnection("MIGRATION_DATABASE_URL"), connectionTimeoutMillis: 5000 });
      await client.connect();
      await client.query("SET ROLE spark_owner");
      return client;
    };
    const first = await connect(), second = await connect();
    try {
      await first.query("BEGIN");
      expect((await first.query("SELECT pg_try_advisory_xact_lock(7301, hashtext('due_reminders')) AS held")).rows[0].held).toBe(true);
      // The lock is held elsewhere: no enumeration (A and B get no row), but the pending row is still claimed.
      const during = (await second.query(claimSql, ["due_reminders", "2026-11-03T08:00:00Z", randomUUID(), 50, 60])).rows as Claimed[];
      expect(during.filter((row) => [a.id, b.id, c.id].includes(row.user_id)).map((row) => row.user_id)).toEqual([c.id]);
      expect(await ledger([a, b], "due_reminders")).toEqual([]);
      // Another job is not blocked by this lock.
      expect((await second.query("SELECT pg_try_advisory_xact_lock(7301, hashtext('weekly_digest')) AS free")).rows[0].free).toBe(true);
      await first.query("ROLLBACK");
      // Released with the transaction: the next claim enumerates.
      const after = (await second.query(claimSql, ["due_reminders", "2026-11-03T08:00:10Z", randomUUID(), 50, 60])).rows as Claimed[];
      expect(after.filter((row) => [a.id, b.id, c.id].includes(row.user_id)).map((row) => row.user_id).sort()).toEqual([a.id, b.id].sort());
    } finally { await first.end(); await second.end(); }
    expect(await ledger([a, b, c], "due_reminders")).toHaveLength(3);
  });

  it("claims with the database clock through the worker entry point", async () => {
    const boss = await account("Clock Boss"), { workspace, project } = await kanbanProject(boss);
    const user = await account("Clock User");
    await addMember(workspace, user, "member");
    // A zone where it is 08:00 or later right now (at least one of these always is).
    await owner.query("SET ROLE spark_owner");
    const zones = ["UTC", "Asia/Ho_Chi_Minh", "America/Los_Angeles", "Pacific/Kiritimati", "Etc/GMT+12", "Pacific/Auckland"];
    const pick = (await owner.query(`SELECT z, (now() AT TIME ZONE z)::date::text AS local_date FROM unnest($1::text[]) AS z WHERE (now() AT TIME ZONE z)::time >= time '08:00' LIMIT 1`, [zones])).rows[0];
    expect(pick).toBeDefined();
    await setZone(user, pick.z);
    await task(boss, project, user, pick.local_date);
    const token = randomUUID(), claimed: Claimed[] = [];
    for (let round = 0; round < 40; round++) {
      const rows = (await workerRuntime.query(wrapperSql, ["due_reminders", token, 50, 60])).rows as Claimed[];
      claimed.push(...rows.filter((row) => row.user_id === user.id));
      if (rows.length < 50) break;
    }
    expect(claimed.map((row) => [row.tenant_id, row.period])).toEqual([[null, pick.local_date]]);
    expect(await settle(claimed[0]!.id, token, "sent")).toBe(true);
    // The worker cannot choose the instant: the internal function is out of its reach, and so is the helper.
    await expect(workerRuntime.query(claimSql, ["due_reminders", "2030-01-07T08:00:00Z", randomUUID(), 5, 60])).rejects.toMatchObject({ code: "42501" });
    await expect(workerRuntime.query(`SELECT * FROM ${fn("scheduled_open_tasks")}($1,$2)`, [user.id, "2030-01-07"])).rejects.toMatchObject({ code: "42501" });
    await expect(workerRuntime.query(wrapperSql, ["nope", randomUUID(), 5, 60])).rejects.toMatchObject({ code: "22023" });
  });

  it("claims a lease and settles", async () => {
    const boss = await account("Lease Boss"), { workspace, project } = await kanbanProject(boss);
    const user = await account("Lease User");
    await addMember(workspace, user, "member");
    await task(boss, project, user, "2026-11-03");
    const at = (seconds: number) => new Date(Date.parse("2026-11-03T08:00:00Z") + seconds * 1000).toISOString();
    const claim = async (seconds: number, token: string, lease = 30) =>
      ((await ownerRows(claimSql, ["due_reminders", at(seconds), token, 50, lease])) as Claimed[]).filter((row) => row.user_id === user.id);
    const t1 = randomUUID(), t2 = randomUUID(), t3 = randomUUID();
    const [row] = await claim(0, t1);
    expect(row).toBeDefined();
    let state = (await ledger([user], "due_reminders"))[0];
    expect(state).toMatchObject({ status: "pending", attempts: 1, lock_token: t1, sent_at: null });
    expect(new Date(state.locked_until).toISOString()).toBe(at(30));
    expect(await claim(10, t2)).toEqual([]);
    // Lease expired: the row is claimed again, the first holder lost it.
    expect((await claim(31, t2)).map((claimed) => claimed.id)).toEqual([row!.id]);
    expect((await ledger([user], "due_reminders"))[0]).toMatchObject({ attempts: 2, lock_token: t2 });
    expect(await settle(row!.id, t1, "sent")).toBe(false);
    expect(await settle(row!.id, null, "sent")).toBe(false);
    expect(await settle(randomUUID(), t2, "sent")).toBe(false);
    // A retry keeps the row pending, clears the token and holds it back until the retry time.
    // The retry time is clamped to between now() and one day ahead (a time further out is capped).
    const before = Date.now();
    expect(await settle(row!.id, t2, "retry", "smtp_error", at(120))).toBe(true);
    state = (await ledger([user], "due_reminders"))[0];
    expect(state).toMatchObject({ status: "pending", lock_token: null, last_error_code: "smtp_error", attempts: 2 });
    expect(new Date(state.locked_until).getTime()).toBeGreaterThanOrEqual(before - 2000);
    expect(new Date(state.locked_until).getTime()).toBeLessThanOrEqual(Date.now() + 24 * 3600 * 1000 + 2000);
    // Pin the hold-back for the fixed test clock, then it is honoured.
    const hold = async (instant: string | null) => { await owner.query("SET ROLE spark_owner"); await owner.query(`UPDATE ${table("scheduled_emails")} SET locked_until=$2 WHERE id=$1`, [row!.id, instant]); };
    await hold(at(120));
    expect(await claim(100, t3)).toEqual([]);
    expect((await claim(120, t3)).map((claimed) => claimed.id)).toEqual([row!.id]);
    // A far-future retry is capped at one day from now.
    expect(await settle(row!.id, t3, "retry", "smtp_error", "2099-01-01T00:00:00Z")).toBe(true);
    state = (await ledger([user], "due_reminders"))[0];
    expect(new Date(state.locked_until).getTime()).toBeLessThanOrEqual(Date.now() + 24 * 3600 * 1000 + 2000);
    expect(new Date(state.locked_until).getTime()).toBeGreaterThan(Date.now() + 23 * 3600 * 1000);
    await hold(null);
    const t4 = randomUUID();
    expect((await claim(130, t4)).map((claimed) => claimed.id)).toEqual([row!.id]);
    expect(await settle(row!.id, t4, "sent")).toBe(true);
    state = (await ledger([user], "due_reminders"))[0];
    expect(state).toMatchObject({ status: "sent", attempts: 4, lock_token: null });
    expect(state.sent_at).toBeInstanceOf(Date);
    expect(await settle(row!.id, t3, "sent")).toBe(false);
    expect(await claim(1000, randomUUID())).toEqual([]);
    // Suppressed with a reason closes a claimed row too.
    const other = await account("Lease Other");
    await addMember(workspace, other, "member");
    await task(boss, project, other, "2026-11-03");
    const [second] = await claimFor("due_reminders", "2026-11-03T09:00:00Z", [other], false);
    const token = (await ledger([other], "due_reminders"))[0].lock_token as string;
    expect(await settle(second!.id, token, "suppressed", "nothing_due")).toBe(true);
    expect((await ledger([other], "due_reminders"))[0]).toMatchObject({ status: "suppressed", last_error_code: "nothing_due", sent_at: null });
  });

  it("gives up after five attempts and bounds crashed claims", async () => {
    const boss = await account("Give Boss"), { workspace, project } = await kanbanProject(boss);
    const user = await account("Give User"), crashed = await account("Give Crash");
    for (const person of [user, crashed]) { await addMember(workspace, person, "member"); await task(boss, project, person, "2026-11-03"); }
    const at = (minutes: number) => new Date(Date.parse("2026-11-03T08:00:00Z") + minutes * 60_000).toISOString();
    let id = "";
    for (let attempt = 1; attempt <= 5; attempt++) {
      const token = randomUUID();
      const rows = ((await ownerRows(claimSql, ["due_reminders", at(attempt * 10), token, 50, 30])) as Claimed[]).filter((row) => row.user_id === user.id);
      expect(rows).toHaveLength(1);
      id = rows[0]!.id;
      expect(await settle(id, token, "retry", "smtp_error", at(attempt * 10 + 5))).toBe(true);
      await owner.query("SET ROLE spark_owner");
      await owner.query(`UPDATE ${table("scheduled_emails")} SET locked_until=NULL WHERE id=$1`, [id]);
      expect((await ledger([user], "due_reminders"))[0]).toMatchObject({ status: attempt < 5 ? "pending" : "failed", attempts: attempt, last_error_code: "smtp_error" });
    }
    // The same five claims reached the other user's row without ever settling it (a worker that keeps dying mid-send):
    // the next claim marks it failed instead of leasing it again.
    expect((await ledger([crashed], "due_reminders"))[0]).toMatchObject({ status: "pending", attempts: 5 });
    expect(await claimFor("due_reminders", at(200), [user])).toEqual([]);
    expect(await claimFor("due_reminders", at(100), [crashed], false)).toEqual([]);
    expect((await ledger([crashed], "due_reminders"))[0]).toMatchObject({ status: "failed", attempts: 5, last_error_code: "lease_expired" });
    // Input checks.
    await expect(settle(id, randomUUID(), "bogus")).rejects.toMatchObject({ code: "22023" });
    await expect(settle(id, randomUUID(), "retry", "Bad Code!", at(1))).rejects.toMatchObject({ code: "22023" });
    await expect(settle(id, randomUUID(), "retry", "unlisted_code", at(1))).rejects.toMatchObject({ code: "22023" });
    await expect(settle(id, randomUUID(), "retry", "smtp_error", null)).rejects.toMatchObject({ code: "22023" });
    const now = "2026-11-03T08:00:00Z";
    for (const args of [["nope", now, randomUUID(), 5, 60], ["due_reminders", now, randomUUID(), 0, 60], ["due_reminders", now, randomUUID(), 51, 60],
      ["due_reminders", now, randomUUID(), 5, 9], ["due_reminders", now, null, 5, 60], ["due_reminders", null, randomUUID(), 5, 60]]) {
      await expect(ownerRows(claimSql, args)).rejects.toMatchObject({ code: "22023" });
    }
  });

  it("re-reads the work at send time", async () => {
    const boss = await account("Reread Boss");
    const one = await kanbanProject(boss), two = await kanbanProject(boss);
    await owner.query("SET ROLE spark_owner");
    await owner.query(`UPDATE ${table("workspaces")} SET name='Beta',version=version+1 WHERE id=$1`, [two.workspace]);
    const user = await account("Reread User", `reread-${randomUUID()}@example.com`);
    await addMember(one.workspace, user, "member"); await addMember(two.workspace, user, "member");
    const first = await task(boss, one.project, user, "2026-11-02", "Overdue one");
    const second = await task(boss, two.project, user, "2026-11-04", "Tomorrow two");
    await task(boss, one.project, user, "2026-11-03", "Today one");
    await task(boss, one.project, user, "2026-11-05", "Too far");
    const [claimed] = await claimFor("due_reminders", "2026-11-03T08:00:00Z", [user], false);
    const common = { status: "pending", email: user.email.toLowerCase(), recipient_name: "Reread User", total: 3 };
    expect(await reminderOf(claimed!.id, claimed!.token!)).toEqual([
      { ...common, task_workspace: "Acme", task_workspace_slug: await slugOf(one.workspace), task_key: `${one.key}-1`, task_title: "Overdue one", task_due: "2026-11-02", task_overdue: true },
      { ...common, task_workspace: "Acme", task_workspace_slug: await slugOf(one.workspace), task_key: `${one.key}-2`, task_title: "Today one", task_due: "2026-11-03", task_overdue: false },
      { ...common, task_workspace: "Beta", task_workspace_slug: await slugOf(two.workspace), task_key: `${two.key}-1`, task_title: "Tomorrow two", task_due: "2026-11-04", task_overdue: false },
    ]);
    // A task finished after the claim drops out; the total follows.
    await finishIssue(boss, one.project, first);
    expect((await reminderOf(claimed!.id, claimed!.token!)).map((row) => [row.task_title, row.total])).toEqual([["Today one", 2], ["Tomorrow two", 2]]);
    // Reassigned, project archived: each removes the task; nothing left means a skipped row with no details.
    expect(await updateIssue(boss, second, 1, { assigneeUserId: boss.id })).toMatchObject({ outcome: "ok" });
    expect((await reminderOf(claimed!.id, claimed!.token!)).map((row) => row.task_title)).toEqual(["Today one"]);
    await owner.query("SET ROLE spark_owner");
    await owner.query(`UPDATE ${table("projects")} SET archived_at=now() WHERE id=$1`, [one.project]);
    expect(await reminderOf(claimed!.id, claimed!.token!)).toEqual([skippedReminder]);
    await owner.query(`UPDATE ${table("projects")} SET archived_at=NULL WHERE id=$1`, [one.project]);
    expect((await reminderOf(claimed!.id, claimed!.token!)).map((row) => row.status)).toEqual(["pending"]);
    // Only the lease holder may read the details: a wrong, missing or lost token gets a skipped row.
    expect(await reminderOf(claimed!.id, randomUUID())).toEqual([skippedReminder]);
    expect(await reminderOf(claimed!.id, null)).toEqual([skippedReminder]);
    // Preference off, then on again.
    expect(await setPreferences(user.token, true, false, true, "UTC")).toBe("ok");
    expect(await reminderOf(claimed!.id, claimed!.token!)).toEqual([skippedReminder]);
    expect(await setPreferences(user.token, true, true, true, "UTC")).toBe("ok");
    expect((await reminderOf(claimed!.id, claimed!.token!)).map((row) => row.status)).toEqual(["pending"]);
    // A user who left the workspace, a suspended user, an archived workspace.
    await leave(one.workspace, user);
    expect(await reminderOf(claimed!.id, claimed!.token!)).toEqual([skippedReminder]);
    await owner.query(`UPDATE ${table("workspace_memberships")} SET status='active',left_at=NULL WHERE tenant_id=$1 AND user_id=$2`, [one.workspace, user.id]);
    await owner.query(`UPDATE ${table("users")} SET status='suspended' WHERE id=$1`, [user.id]);
    expect(await reminderOf(claimed!.id, claimed!.token!)).toEqual([skippedReminder]);
    await owner.query(`UPDATE ${table("users")} SET status='active' WHERE id=$1`, [user.id]);
    await owner.query(`UPDATE ${table("workspaces")} SET archived_at=now(),version=version+1 WHERE id=$1`, [one.workspace]);
    expect(await reminderOf(claimed!.id, claimed!.token!)).toEqual([skippedReminder]);
    await owner.query(`UPDATE ${table("workspaces")} SET archived_at=NULL,version=version+1 WHERE id=$1`, [one.workspace]);
    // A settled row sends nothing more (its token is gone); unknown ids and a digest row are skipped too.
    expect(await settle(claimed!.id, (await ledger([user], "due_reminders"))[0].lock_token, "sent")).toBe(true);
    expect(await reminderOf(claimed!.id, claimed!.token!)).toEqual([skippedReminder]);
    expect(await reminderOf(randomUUID(), randomUUID())).toEqual([skippedReminder]);
    const digestUser = await account("Reread Digest");
    await addMember(one.workspace, digestUser, "member");
    const [digest] = await claimFor("weekly_digest", "2026-11-02T08:00:00Z", [digestUser], false);
    expect(await reminderOf(digest!.id, digest!.token!)).toEqual([skippedReminder]);
    expect((await digestOf(claimed!.id, claimed!.token!)).map((row) => row.status)).toEqual(["skipped"]);
  });

  it("caps the reminder list at 20 rows and reports the full count", async () => {
    const boss = await account("Cap Boss"), { workspace, project } = await kanbanProject(boss);
    const user = await account("Cap User");
    await addMember(workspace, user, "member");
    for (let index = 0; index < 23; index++) await task(boss, project, user, index % 2 === 0 ? "2026-11-03" : "2026-11-02", `Cap ${index}`);
    const [claimed] = await claimFor("due_reminders", "2026-11-03T08:00:00Z", [user], false);
    const rows = await reminderOf(claimed!.id, claimed!.token!);
    expect(rows).toHaveLength(20);
    expect(new Set(rows.map((row) => row.total))).toEqual(new Set([23]));
    // Due date first, then the issue number within the project: the 11 early ones, then the first 9 of the 12 later ones.
    const number = (row: { task_key: string }) => Number(row.task_key.split("-")[1]);
    expect(rows.slice(0, 11).every((row) => row.task_due === "2026-11-02")).toBe(true);
    expect(rows.slice(11).every((row) => row.task_due === "2026-11-03")).toBe(true);
    expect(rows.slice(0, 11).map(number)).toEqual(rows.slice(0, 11).map(number).sort((x, y) => x - y));
    expect(rows.slice(11).map(number)).toEqual(rows.slice(11).map(number).sort((x, y) => x - y));
  });

  it("does not repeat a period when the time zone changes", async () => {
    const boss = await account("Zone Boss"), { workspace, project } = await kanbanProject(boss);
    const user = await account("Zone User");
    await addMember(workspace, user, "member");
    await task(boss, project, user, "2026-11-03");
    await setZone(user, "Asia/Ho_Chi_Minh");
    // 16:30 UTC is 23:30 on 3 November in Ho Chi Minh (a catch-up run), and 08:30 on 3 November in Los Angeles.
    expect((await claimFor("due_reminders", "2026-11-03T16:30:00Z", [user])).map((row) => row.period)).toEqual(["2026-11-03"]);
    await setZone(user, "America/Los_Angeles");
    expect(await claimFor("due_reminders", "2026-11-03T16:30:00Z", [user])).toEqual([]);
    expect(await claimFor("due_reminders", "2026-11-03T20:00:00Z", [user])).toEqual([]);
    expect((await ledger([user], "due_reminders")).map((row) => [row.period, row.status])).toEqual([["2026-11-03", "sent"]]);
    // A zone where the same instant is already the next date is a different local day and gets its own row, once.
    await setZone(user, "Pacific/Kiritimati");
    expect(await claimFor("due_reminders", "2026-11-03T17:59:00Z", [user])).toEqual([]);
    expect((await claimFor("due_reminders", "2026-11-03T18:00:00Z", [user])).map((row) => row.period)).toEqual(["2026-11-04"]);
    // Back in Los Angeles at 07:00 on 4 November: 3 November is over and 4 November has not started there.
    await setZone(user, "America/Los_Angeles");
    expect(await claimFor("due_reminders", "2026-11-04T15:00:00Z", [user])).toEqual([]);
    expect(await ledger([user], "due_reminders")).toHaveLength(2);

    // The digest has the same guard: sent on Monday in Ho Chi Minh, the user moves to Los Angeles where it is still Monday.
    await setZone(user, "Asia/Ho_Chi_Minh");
    expect(await claimFor("weekly_digest", "2026-11-02T16:30:00Z", [user])).toHaveLength(1);
    await setZone(user, "America/Los_Angeles");
    expect(await claimFor("weekly_digest", "2026-11-02T16:30:00Z", [user])).toEqual([]);
    expect(await ledger([user], "weekly_digest")).toHaveLength(1);
  });

  it("builds the digest content", async () => {
    const boss = await account("Content Boss"), reader = await account("Content Reader", `reader-${randomUUID()}@example.com`);
    const ada = await account("Ada Member"), ben = await account("Ben Member"), cy = await account("Cy Gone");
    const scrum = await scrumProject(boss), workspace = scrum.workspace;
    for (const person of [reader, ada, ben, cy]) await addMember(workspace, person, "member");
    const waterfall = await waterfallProject(boss, workspace), kanban = await kanbanProject(boss, workspace);
    const archived = await kanbanProject(boss, workspace);
    // Scrum scores the active sprint only; the issue outside the sprint is ignored.
    const created = await createSprint(boss, scrum.project, "Launch", null, "2026-11-02", "2026-11-15");
    const inSprintDone = await sprintIssue(boss, scrum.project, created.sprint_id!, { title: "S1" });
    await sprintIssue(boss, scrum.project, created.sprint_id!, { title: "S2" });
    await task(boss, scrum.project, null, null, "Outside");
    expect(await startSprint(boss, created.sprint_id!, created.sprint_version!)).toMatchObject({ outcome: "ok" });
    await finishIssue(boss, scrum.project, inSprintDone, 2);
    // Waterfall uses the project window; points are the unit when at least 80% of the issues are estimated.
    for (const points of ["3", "5"]) expect((await createIssue(boss, waterfall.project, { title: "W", points })).outcome).toBe("ok");
    await finishIssue(boss, waterfall.project, (await createIssue(boss, waterfall.project, { title: "W done", points: "2" })).issue_id!);
    // Kanban without dates has no window; an archived project is left out.
    await task(boss, kanban.project, null, null, "K1");
    await task(boss, archived.project, null, null, "Gone");
    await owner.query("SET ROLE spark_owner");
    await owner.query(`UPDATE ${table("projects")} SET archived_at=now() WHERE id=$1`, [archived.project]);

    // Done transitions per assignee around the week 26 October to 1 November (the user's zone is UTC).
    const fx = await insightProject(boss, workspace);
    const done = (assignee: Account | null) => ({ category: "done" as Category, assignee: assignee?.id ?? null });
    await issueHistory(fx, [{ at: "2026-10-27T10:00:00Z", after: { category: "todo", assignee: ada.id } }, { at: "2026-10-28T10:00:00Z", after: done(ada) }]);
    await issueHistory(fx, [{ at: "2026-10-26T00:00:00Z", after: done(ada) }]);
    await issueHistory(fx, [{ at: "2026-10-29T10:00:00Z", after: done(ada) }, { at: "2026-10-30T10:00:00Z", after: { category: "todo", assignee: ada.id } }, { at: "2026-10-31T10:00:00Z", after: done(ada) }]);
    await issueHistory(fx, [{ at: "2026-11-01T23:59:59Z", after: done(ben) }]);
    await issueHistory(fx, [{ at: "2026-10-25T23:59:59Z", after: done(ben) }]);
    await issueHistory(fx, [{ at: "2026-11-02T00:00:00Z", after: done(ben) }]);
    await issueHistory(fx, [{ at: "2026-10-28T10:00:00Z", after: { category: "done", assignee: ben.id, archived: true } }]);
    await issueHistory(fx, [{ at: "2026-10-28T11:00:00Z", after: done(null) }]);
    await issueHistory(fx, [{ at: "2026-10-29T11:00:00Z", after: done(cy) }]);
    await leave(workspace, cy);

    // Open work across the workspace: 12 overdue (cap 10), at-risk from the Monday through three days on.
    for (let index = 0; index < 12; index++) await task(boss, kanban.project, ada, shiftDay("2026-10-20", index), `Late ${index}`);
    await task(boss, kanban.project, null, "2026-11-02", "Today");
    await task(boss, kanban.project, ben, "2026-11-05", "Third day");
    await task(boss, kanban.project, ben, "2026-11-06", "Fourth day");
    await finishIssue(boss, kanban.project, await task(boss, kanban.project, null, "2026-11-03", "Finished risk"));

    const [claimed] = await claimFor("weekly_digest", "2026-11-02T08:00:00Z", [reader], false);
    const rows = await digestOf(claimed!.id, claimed!.token!);
    expect(new Set(rows.map((row) => `${row.status}|${row.email}|${row.recipient_name}|${row.workspace_name}|${row.workspace_slug}`)))
      .toEqual(new Set([`pending|${reader.email.toLowerCase()}|Content Reader|Acme|${await slugOf(workspace)}`]));
    const projects = Object.fromEntries(rows.filter((row) => row.section === "project").map((row) => [row.project_key, row]));
    expect(Object.keys(projects)).toHaveLength(4);
    expect(projects[archived.key]).toBeUndefined();
    expect(projects[scrum.key]).toMatchObject({ project_name: "Rocket", methodology: "scrum", extra: { done: 1, total: 2, unit: "count", windowStart: "2026-11-02", windowEnd: "2026-11-15", activeSprintName: "Launch" } });
    expect(projects[waterfall.key]).toMatchObject({ methodology: "waterfall", extra: { done: 2, total: 10, unit: "points", windowStart: "2026-11-02", windowEnd: "2026-12-11", activeSprintName: null } });
    expect(projects[kanban.key]!.extra).toMatchObject({ unit: "count", windowStart: null, windowEnd: null, activeSprintName: null });
    // Members: the seven days before the Monday, by the snapshot's assignee; a re-completion counts again; archived, unassigned and departed members do not.
    expect(rows.filter((row) => row.section === "member").map((row) => [row.label, row.value])).toEqual([["Ada Member", 4], ["Ben Member", 1]]);
    const overdue = rows.filter((row) => row.section === "overdue");
    expect(overdue.map((row) => row.label)).toEqual(Array.from({ length: 10 }, (_, index) => `${kanban.key}-${index + 2} Late ${index}`));
    expect(overdue[0]!.extra).toEqual({ due: "2026-10-20", total: 12 });
    expect(overdue.every((row) => row.extra.total === 12)).toBe(true);
    const atRisk = rows.filter((row) => row.section === "at_risk");
    expect(atRisk.map((row) => [row.label.replace(/^\S+ /, ""), row.extra])).toEqual([["Today", { due: "2026-11-02", total: 2 }], ["Third day", { due: "2026-11-05", total: 2 }]]);
    // Preference off, no project left, or no membership: a single skipped row.
    expect(await setPreferences(reader.token, true, true, false, "UTC")).toBe("ok");
    expect(await digestOf(claimed!.id, claimed!.token!)).toEqual([expect.objectContaining({ status: "skipped", email: null, workspace_name: null, section: null, extra: null })]);
    expect(await setPreferences(reader.token, true, true, true, "UTC")).toBe("ok");
    expect((await digestOf(claimed!.id, claimed!.token!)).length).toBeGreaterThan(1);
    await owner.query("SET ROLE spark_owner");
    await owner.query(`UPDATE ${table("projects")} SET archived_at=now() WHERE tenant_id=$1`, [workspace]);
    expect((await digestOf(claimed!.id, claimed!.token!)).map((row) => row.status)).toEqual(["skipped"]);
    await owner.query(`UPDATE ${table("projects")} SET archived_at=NULL WHERE tenant_id=$1 AND id<>$2`, [workspace, archived.project]);
    expect((await digestOf(claimed!.id, claimed!.token!)).length).toBeGreaterThan(1);
    await leave(workspace, reader);
    expect((await digestOf(claimed!.id, claimed!.token!)).map((row) => row.status)).toEqual(["skipped"]);
  });

  it("keeps the ledger closed and the functions granted to the worker only", async () => {
    await owner.query("SET ROLE spark_owner");
    const names = ["worker_claim_scheduled_emails", "worker_due_reminder_email", "worker_settle_scheduled_email", "worker_weekly_digest_email"];
    const grants = `SELECT p.proname, p.prosecdef, p.proconfig, has_function_privilege('spark_worker',p.oid,'EXECUTE') AS worker, has_function_privilege('spark_app',p.oid,'EXECUTE') AS runtime,
      has_function_privilege('spark_auth',p.oid,'EXECUTE') AS auth,
      EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname = ANY($2) ORDER BY p.proname`;
    const rows = (await owner.query(grants, [namespace, names])).rows;
    expect(rows.map((row) => row.proname)).toEqual(names);
    for (const row of rows) {
      expect({ name: row.proname, definer: row.prosecdef, config: row.proconfig, worker: row.worker, runtime: row.runtime, auth: row.auth, public: row.public })
        .toEqual({ name: row.proname, definer: true, config: ['search_path=""'], worker: true, runtime: false, auth: false, public: false });
    }
    // The shared open-task query and the instant-taking claim are internal: nobody but the owner can call them.
    const internal = (await owner.query(grants, [namespace, ["scheduled_emails_claim_at", "scheduled_open_tasks"]])).rows;
    expect(internal.map((row) => row.proname)).toEqual(["scheduled_emails_claim_at", "scheduled_open_tasks"]);
    for (const row of internal) expect(row).toMatchObject({ proconfig: ['search_path=""'], worker: false, runtime: false, auth: false, public: false });
    // The table: forced row security, owner-only policy, no runtime or worker grants.
    const security = (await owner.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass", [table("scheduled_emails")])).rows[0];
    expect(security).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect((await owner.query("SELECT roles::text AS roles FROM pg_policies WHERE schemaname=$1 AND tablename='scheduled_emails'", [namespace])).rows).toEqual([{ roles: "{spark_owner}" }]);
    for (const role of ["spark_app", "spark_worker", "spark_auth"]) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect((await owner.query("SELECT has_table_privilege($1,$2,$3) AS allowed", [role, table("scheduled_emails"), privilege])).rows[0].allowed).toBe(false);
      }
    }
    await expect(workerRuntime.query(`SELECT * FROM ${table("scheduled_emails")}`)).rejects.toMatchObject({ code: "42501" });
    await expect(runtime.query(`SELECT * FROM ${fn("worker_due_reminder_email")}($1,$2)`, [randomUUID(), randomUUID()])).rejects.toMatchObject({ code: "42501" });

    // Shape rules: a reminder has no workspace, a digest needs one, one row per user, job, workspace and period.
    const boss = await account("Shape Boss"), { workspace } = await kanbanProject(boss);
    const insert = (job: string, tenant: string | null, period = "2026-11-03", status = "pending") =>
      `INSERT INTO ${table("scheduled_emails")} (user_id,tenant_id,job,period,status) VALUES ('${boss.id}',${tenant ? `'${tenant}'` : "NULL"},'${job}','${period}','${status}')`;
    await reject(insert("due_reminders", workspace), [], "23514");
    await reject(insert("weekly_digest", null), [], "23514");
    await reject(insert("other", null), [], "23514");
    await reject(`${insert("due_reminders", null)}`.replace("status)", "status,last_error_code)").replace("'pending')", "'pending','weird')"), [], "23514");
    await reject(insert("due_reminders", null, "2026-11-03", "queued"), [], "23514");
    await rollback(async () => {
      await owner.query(insert("due_reminders", null));
      await expect(owner.query(insert("due_reminders", null))).rejects.toMatchObject({ code: "23505" });
    });
    await rollback(async () => {
      await owner.query(insert("weekly_digest", workspace));
      await owner.query(insert("weekly_digest", workspace, "2026-11-09"));
      await expect(owner.query(insert("weekly_digest", workspace))).rejects.toMatchObject({ code: "23505" });
    });
  });
});

type CommunityWrite = { slug?: string; name?: string; tagline?: string; description?: string; visibility?: string; country?: string | null; city?: string | null; stage?: string | null; topics?: unknown };
const newCommunitySlug = () => `c-${randomUUID().slice(0, 12)}`;
const createCommunityCall = `SELECT * FROM ${fn("ws_create_community")}($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;
async function createCommunity(who: Account | null, workspace: string, input: CommunityWrite = {}) {
  return (await asSession(who?.token ?? null, createCommunityCall, [workspace, input.slug ?? newCommunitySlug(), input.name ?? "Founders", input.tagline ?? "A tagline",
    input.description ?? "Description", input.visibility ?? "public", input.country ?? null, input.city ?? null, input.stage === undefined ? "any" : input.stage,
    input.topics === undefined ? ["founders"] : input.topics])).rows[0] as { outcome: string; community_id: string | null };
}
const updateCommunityCall = `SELECT * FROM ${fn("ws_update_community")}($1,$2,$3)`;
const updateCommunity = async (who: Account, community: string, version: number, patch: unknown) =>
  (await asSession(who.token, updateCommunityCall, [community, version, JSON.stringify(patch)])).rows[0] as { outcome: string; settings_version: number | null };
const joinCall = `SELECT * FROM ${fn("ws_join_community")}($1)`;
const joinAs = async (who: Account, community: string) => (await asSession(who.token, joinCall, [community])).rows[0] as { outcome: string; status: string | null };
const requestCall = `SELECT * FROM ${fn("ws_request_community_membership")}($1,$2)`;
const requestAccess = async (who: Account, community: string, message: string | null = null) =>
  (await asSession(who.token, requestCall, [community, message])).rows[0] as { outcome: string; request_id: string | null; retry_after: Date | null };
const decideCall = `SELECT * FROM ${fn("ws_decide_community_request")}($1,$2)`;
const decide = async (who: Account, request: string, decision: string) =>
  (await asSession(who.token, decideCall, [request, decision])).rows[0] as { outcome: string; membership_status: string | null };
// Runs the same statement on two sessions: the second must block on the first's locks until it commits.
async function contend(accounts: [Account, Account], sql: string, values: [unknown[], unknown[]]) {
  const clients = await sessionPair(accounts);
  try {
    const [first, second] = clients;
    const winner = (await first.query(sql, values[0])).rows[0];
    const pid = await backendPid(second);
    const pending = second.query(sql, values[1]);
    const blocked = await waitUntilBlocked(pid);
    await first.query("COMMIT");
    const loser = (await pending).rows[0];
    await second.query("COMMIT");
    return { winner, loser, blocked };
  } finally { await closePair(clients); }
}
async function memberships(community: string) {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT user_id,role,status FROM ${table("community_memberships")} WHERE community_id=$1 ORDER BY user_id`, [community])).rows as { user_id: string; role: string; status: string }[];
}
async function requestRows(community: string) {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT id,user_id,status,message,reviewed_by_user_id,reviewed_at FROM ${table("community_join_requests")} WHERE community_id=$1 ORDER BY created_at,id`, [community])).rows;
}
async function communityNotices(community: string) {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT n.tenant_id,n.recipient_user_id,n.kind,n.title,n.resource_type,o.aggregate_type,o.processed_at IS NOT NULL AS processed
    FROM ${table("notifications")} n JOIN ${table("outbox_events")} o ON o.id=n.outbox_event_id WHERE n.resource_id=$1 ORDER BY n.created_at,n.kind,n.recipient_user_id`, [community])).rows;
}
async function auditOf(resource: string) {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT tenant_id,actor_user_id,action,resource_type,metadata FROM ${table("audit_events")} WHERE resource_id=$1 ORDER BY created_at,id`, [resource])).rows;
}
const readAs = async (who: Account | null, call: string, values: unknown[] = []) =>
  (await asSession(who?.token ?? null, `SELECT * FROM ${fn(call)}`, values)).rows as Record<string, unknown>[];
const notFound = { code: "P0002", message: "Community not found" };
const denied = { code: "42501", message: "Community access denied" };

describe("Community membership writes", () => {
  it("creates communities hosted by a workspace", async () => {
    const host = await hostWorkspace("Create host");
    const admin = await account("Create admin"), member = await account("Create member"), stranger = await account("Create stranger");
    await addMember(host.workspace, admin, "admin");
    await addMember(host.workspace, member, "member");
    const slug = newCommunitySlug();
    const created = await createCommunity(host.owner, host.workspace, { slug, name: "  Hanoi Founders ", tagline: " Builders ", description: " About us ", visibility: "private",
      country: "VN", city: " Hanoi ", stage: "seed", topics: ["fintech", "ai-data"] });
    expect(created.outcome).toBe("ok");
    const community = created.community_id!;
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT tenant_id,slug,name,tagline,description,visibility,country_code,city,stage,settings_version,created_by_user_id FROM ${table("communities")} WHERE id=$1`, [community])).rows[0])
      .toEqual({ tenant_id: host.workspace, slug, name: "Hanoi Founders", tagline: "Builders", description: "About us", visibility: "private", country_code: "VN", city: "Hanoi",
        stage: "seed", settings_version: 1, created_by_user_id: host.owner.id });
    expect(await memberships(community)).toEqual([{ user_id: host.owner.id, role: "owner", status: "active" }]);
    expect((await owner.query(`SELECT t.slug FROM ${table("community_topics")} ct JOIN ${table("topics")} t ON t.id=ct.topic_id WHERE ct.community_id=$1 ORDER BY t.slug`, [community])).rows)
      .toEqual([{ slug: "ai-data" }, { slug: "fintech" }]);
    expect(await auditOf(community)).toEqual([{ tenant_id: host.workspace, actor_user_id: host.owner.id, action: "community.created", resource_type: "community",
      metadata: { slug, name: "Hanoi Founders", visibility: "private" } }]);
    // A blank city is stored as NULL.
    const blankCity = (await createCommunity(admin, host.workspace, { city: "   " })).community_id!;
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT city FROM ${table("communities")} WHERE id=$1`, [blankCity])).rows[0].city).toBeNull();
    expect(await createCommunity(member, host.workspace)).toEqual({ outcome: "forbidden", community_id: null });
    expect(await createCommunity(stranger, host.workspace)).toEqual({ outcome: "not_found", community_id: null });
    expect(await createCommunity(admin, randomUUID())).toEqual({ outcome: "not_found", community_id: null });
    expect(await createCommunity(admin, host.workspace, { slug })).toEqual({ outcome: "slug_taken", community_id: null });
    await expect(createCommunity(null, host.workspace)).rejects.toMatchObject({ code: "28000" });
    const invalid: [CommunityWrite, string][] = [
      [{ topics: topicCodes.slice(0, 5) }, "Invalid community topics"], [{ topics: [] }, "Invalid community topics"], [{ topics: ["founders", "founders"] }, "Invalid community topics"],
      [{ topics: ["legacy"] }, "Invalid community topics"], [{ topics: null }, "Invalid community topics"],
      [{ slug: "A-b" }, "Invalid community slug"], [{ slug: "-ab" }, "Invalid community slug"], [{ name: " " }, "Invalid community name"], [{ name: "x".repeat(81) }, "Invalid community name"],
      [{ tagline: "" }, "Invalid community tagline"], [{ tagline: "x".repeat(91) }, "Invalid community tagline"],
      [{ description: "  " }, "Invalid community description"], [{ description: "x".repeat(2001) }, "Invalid community description"],
      [{ visibility: "secret" }, "Invalid community visibility"], [{ country: "vn" }, "Invalid community location"], [{ city: "x".repeat(81) }, "Invalid community location"],
      [{ stage: "Seed" }, "Invalid community stage"], [{ stage: null }, "Invalid community stage"],
    ];
    for (const [input, message] of invalid) await expect(createCommunity(host.owner, host.workspace, input)).rejects.toMatchObject({ code: "22023", message });
    // Ten non-archived communities per host workspace; archived ones do not count.
    for (let index = 0; index < 8; index++) expect((await createCommunity(host.owner, host.workspace)).outcome).toBe("ok");
    expect(await createCommunity(admin, host.workspace)).toEqual({ outcome: "too_many_communities", community_id: null });
    await owner.query("SET ROLE spark_owner");
    await owner.query(`UPDATE ${table("communities")} SET archived_at=now() WHERE id=$1`, [blankCity]);
    expect((await createCommunity(admin, host.workspace)).outcome).toBe("ok");
  });

  it("updates community settings with an optimistic version", async () => {
    const host = await hostWorkspace("Settings host");
    const admin = await account("Settings admin"), moderator = await account("Settings moderator"), stranger = await account("Settings stranger");
    await addMember(host.workspace, admin, "admin");
    const community = (await createCommunity(host.owner, host.workspace, { name: "Settings", topics: ["founders", "product"] })).community_id!;
    await joinCommunity(host, community, moderator, "moderator");
    expect(await updateCommunity(host.owner, community, 1, { name: " Renamed ", topics: ["product", "fintech"], countryCode: "SG", city: "Singapore", stage: "growth" }))
      .toEqual({ outcome: "ok", settings_version: 2 });
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT name,country_code,city,stage,settings_version FROM ${table("communities")} WHERE id=$1`, [community])).rows[0])
      .toEqual({ name: "Renamed", country_code: "SG", city: "Singapore", stage: "growth", settings_version: 2 });
    expect((await owner.query(`SELECT t.slug FROM ${table("community_topics")} ct JOIN ${table("topics")} t ON t.id=ct.topic_id WHERE ct.community_id=$1 ORDER BY t.slug`, [community])).rows)
      .toEqual([{ slug: "fintech" }, { slug: "product" }]);
    expect((await auditOf(community)).at(-1)).toMatchObject({ action: "community.updated", tenant_id: host.workspace, actor_user_id: host.owner.id,
      metadata: { changed: ["city", "countryCode", "name", "stage", "topics"] } });
    // A host workspace admin may change settings and visibility; nullable fields clear with null.
    expect(await updateCommunity(admin, community, 2, { visibility: "hidden", countryCode: null, city: null, tagline: "New", description: "New description" }))
      .toEqual({ outcome: "ok", settings_version: 3 });
    // A patch that changes nothing keeps the version and writes no audit row.
    const audits = (await auditOf(community)).length;
    expect(await updateCommunity(admin, community, 3, { visibility: "hidden", topics: ["fintech", "product"] })).toEqual({ outcome: "ok", settings_version: 3 });
    expect((await auditOf(community)).length).toBe(audits);
    expect(await updateCommunity(host.owner, community, 2, { name: "Stale" })).toEqual({ outcome: "version_mismatch", settings_version: 3 });
    expect(await updateCommunity(moderator, community, 3, { name: "Moderator" })).toEqual({ outcome: "forbidden", settings_version: null });
    // The community is now hidden: a stranger cannot tell it exists.
    expect(await updateCommunity(stranger, community, 3, { name: "Stranger" })).toEqual({ outcome: "not_found", settings_version: null });
    expect(await updateCommunity(host.owner, randomUUID(), 1, { name: "Unknown" })).toEqual({ outcome: "not_found", settings_version: null });
    const invalid: [unknown, string][] = [
      [{ unknown: 1 }, "Invalid community patch"], [[], "Invalid community patch"], [{ name: "" }, "Invalid community name"], [{ name: 5 }, "Invalid community name"],
      [{ tagline: null }, "Invalid community tagline"], [{ description: "" }, "Invalid community description"], [{ visibility: "open" }, "Invalid community visibility"],
      [{ countryCode: "sg" }, "Invalid community location"], [{ city: "x".repeat(81) }, "Invalid community location"], [{ stage: "Seed" }, "Invalid community stage"],
      [{ topics: [] }, "Invalid community topics"], [{ topics: "founders" }, "Invalid community topics"],
    ];
    for (const [patch, message] of invalid) await expect(updateCommunity(host.owner, community, 3, patch)).rejects.toMatchObject({ code: "22023", message });
  });

  it("joins public communities once", async () => {
    const host = await hostWorkspace("Join host");
    const joiner = await account("Joiner"), suspended = await account("Join suspended");
    const pub = await communityFixture(host, { name: "Join Public" });
    const { winner, loser, blocked } = await contend([joiner, joiner], joinCall, [[pub], [pub]]);
    expect(blocked).toBe(true);
    expect([winner, loser]).toEqual([{ outcome: "joined", status: "active" }, { outcome: "already_member", status: "active" }]);
    expect((await memberships(pub)).filter((row) => row.user_id === joiner.id)).toEqual([{ user_id: joiner.id, role: "member", status: "active" }]);
    // Leaving and joining again re-activates the same row.
    await owner.query("SET ROLE spark_owner");
    const rowId = (await owner.query(`SELECT id FROM ${table("community_memberships")} WHERE community_id=$1 AND user_id=$2`, [pub, joiner.id])).rows[0].id;
    expect(await outcome(joiner, "ws_leave_community($1)", [pub])).toBe("ok");
    expect((await memberships(pub)).find((row) => row.user_id === joiner.id)!.status).toBe("left");
    expect(await joinAs(joiner, pub)).toEqual({ outcome: "joined", status: "active" });
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT id,status,left_at FROM ${table("community_memberships")} WHERE community_id=$1 AND user_id=$2`, [pub, joiner.id])).rows).toEqual([{ id: rowId, status: "active", left_at: null }]);
    // A suspended member stays suspended.
    await joinCommunity(host, pub, suspended);
    await owner.query(`UPDATE ${table("community_memberships")} SET status='suspended' WHERE community_id=$1 AND user_id=$2`, [pub, suspended.id]);
    expect(await joinAs(suspended, pub)).toEqual({ outcome: "membership_suspended", status: "suspended" });
    // Private and hidden communities, frozen, archived and unknown ones.
    const priv = await communityFixture(host, { name: "Join Private", visibility: "private" });
    const hid = await communityFixture(host, { name: "Join Hidden", visibility: "hidden" });
    const frozen = await communityFixture(host, { name: "Join Frozen", frozen: true });
    const archived = await communityFixture(host, { name: "Join Archived", archived: true });
    expect(await joinAs(joiner, priv)).toEqual({ outcome: "request_required", status: null });
    expect(await joinAs(joiner, hid)).toEqual({ outcome: "not_found", status: null });
    expect(await joinAs(host.owner, hid)).toEqual({ outcome: "already_member", status: "active" });
    expect(await joinAs(joiner, frozen)).toEqual({ outcome: "community_frozen", status: null });
    expect(await joinAs(joiner, archived)).toEqual({ outcome: "not_found", status: null });
    expect(await joinAs(joiner, randomUUID())).toEqual({ outcome: "not_found", status: null });
    // A pending request is closed when the community turns public and the requester joins.
    expect((await requestAccess(joiner, priv)).outcome).toBe("requested");
    await owner.query("SET ROLE spark_owner");
    await owner.query(`UPDATE ${table("communities")} SET visibility='public' WHERE id=$1`, [priv]);
    expect(await joinAs(joiner, priv)).toEqual({ outcome: "joined", status: "active" });
    expect((await requestRows(priv)).map((row) => row.status)).toEqual(["withdrawn"]);
  });

  it("requests access to private communities once", async () => {
    const host = await hostWorkspace("Request host");
    const moderator = await account("Request moderator"), requester = await account("Request requester"), member = await account("Request member");
    const priv = await communityFixture(host, { name: "Request Private", visibility: "private" });
    await joinCommunity(host, priv, moderator, "moderator");
    await joinCommunity(host, priv, member);
    const { winner, loser, blocked } = await contend([requester, requester], requestCall, [[priv, "  Hello  "], [priv, "Again"]]);
    expect(blocked).toBe(true);
    expect(winner).toMatchObject({ outcome: "requested", retry_after: null });
    expect(loser).toEqual({ outcome: "already_pending", request_id: winner.request_id, retry_after: null });
    expect(await requestRows(priv)).toEqual([{ id: winner.request_id, user_id: requester.id, status: "pending", message: "Hello", reviewed_by_user_id: null, reviewed_at: null }]);
    // One notification per community owner and moderator, each backed by a processed (in-app only) outbox row.
    const expectedNotice = (recipient: string) => ({ tenant_id: host.workspace, recipient_user_id: recipient, kind: "community_request_received",
      title: "Request requester asked to join Request Private", resource_type: "community", aggregate_type: "community_join_request", processed: true });
    expect(await communityNotices(priv)).toEqual([host.owner.id, moderator.id].sort().map(expectedNotice));
    // Public communities are joined, hidden ones do not exist for non-members, members are already in.
    const pub = await communityFixture(host, { name: "Request Public" });
    const hid = await communityFixture(host, { name: "Request Hidden", visibility: "hidden" });
    const frozen = await communityFixture(host, { name: "Request Frozen", visibility: "private", frozen: true });
    expect(await requestAccess(requester, pub)).toEqual({ outcome: "join_instead", request_id: null, retry_after: null });
    expect(await requestAccess(requester, hid)).toEqual({ outcome: "not_found", request_id: null, retry_after: null });
    expect(await requestAccess(member, priv)).toEqual({ outcome: "already_member", request_id: null, retry_after: null });
    expect(await requestAccess(requester, frozen)).toEqual({ outcome: "community_frozen", request_id: null, retry_after: null });
    expect(await requestAccess(requester, randomUUID())).toEqual({ outcome: "not_found", request_id: null, retry_after: null });
    await expect(requestAccess(requester, priv, "x".repeat(501))).rejects.toMatchObject({ code: "22023", message: "Invalid request message" });
    // Withdraw: own pending requests only.
    const request = winner.request_id as string;
    expect(await outcome(member, "ws_withdraw_community_request($1)", [request])).toBe("not_found");
    expect(await outcome(requester, "ws_withdraw_community_request($1)", [randomUUID()])).toBe("not_found");
    expect(await outcome(requester, "ws_withdraw_community_request($1)", [request])).toBe("ok");
    expect(await outcome(requester, "ws_withdraw_community_request($1)", [request])).toBe("not_pending");
    // A blank message is stored as NULL; a withdrawn request does not block a new one.
    const again = await requestAccess(requester, priv, "   ");
    expect(again.outcome).toBe("requested");
    expect((await requestRows(priv)).map((row) => [row.status, row.message])).toEqual([["withdrawn", "Hello"], ["pending", null]]);
  });

  it("decides each request exactly once", async () => {
    const host = await hostWorkspace("Decide host");
    const admin = await account("Decide admin"), moderator = await account("Decide moderator"), member = await account("Decide member");
    const requester = await account("Decide requester"), second = await account("Decide second"), stranger = await account("Decide stranger");
    await addMember(host.workspace, admin, "admin");
    const priv = await communityFixture(host, { name: "Decide Private", visibility: "private" });
    await joinCommunity(host, priv, moderator, "moderator");
    await joinCommunity(host, priv, member);
    const request = (await requestAccess(requester, priv, "Please")).request_id!;
    expect(await decide(member, request, "approve")).toEqual({ outcome: "forbidden", membership_status: null });
    expect(await decide(stranger, request, "approve")).toEqual({ outcome: "forbidden", membership_status: null });
    expect(await decide(moderator, randomUUID(), "approve")).toEqual({ outcome: "not_found", membership_status: null });
    for (const decision of ["accept", "", "APPROVE"]) await expect(decide(moderator, request, decision)).rejects.toMatchObject({ code: "22023", message: "Invalid decision" });
    // The approval and the membership commit together: a rolled-back approval leaves neither.
    const client = await runtime.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('spark.session_token_hash',$1,true)", [moderator.token.toString("hex")]);
      expect((await client.query(decideCall, [request, "approve"])).rows[0]).toEqual({ outcome: "approved", membership_status: "active" });
      expect((await client.query(`SELECT count(*)::integer AS total FROM ${table("community_memberships")} WHERE community_id=$1 AND user_id=$2 AND status='active'`, [priv, requester.id])).rows[0].total).toBe(1);
      await client.query("ROLLBACK");
    } finally { client.release(); }
    expect((await requestRows(priv)).map((row) => row.status)).toEqual(["pending"]);
    expect((await memberships(priv)).map((row) => row.user_id)).not.toContain(requester.id);
    // Two managers at once: one decision wins, the other changes nothing.
    const { winner, loser, blocked } = await contend([moderator, admin], decideCall, [[request, "approve"], [request, "reject"]]);
    expect(blocked).toBe(true);
    expect([winner, loser]).toEqual([{ outcome: "approved", membership_status: "active" }, { outcome: "already_decided", membership_status: null }]);
    expect((await memberships(priv)).find((row) => row.user_id === requester.id)).toEqual({ user_id: requester.id, role: "member", status: "active" });
    const [decided] = await requestRows(priv);
    expect(decided).toMatchObject({ status: "approved", reviewed_by_user_id: moderator.id });
    expect(decided.reviewed_at).toBeInstanceOf(Date);
    expect((await communityNotices(priv)).filter((row) => row.recipient_user_id === requester.id)).toEqual([{ tenant_id: host.workspace, recipient_user_id: requester.id,
      kind: "community_request_approved", title: "Your request to join Decide Private was approved", resource_type: "community", aggregate_type: "community_join_request", processed: true }]);
    expect(await auditOf(request)).toEqual([{ tenant_id: host.workspace, actor_user_id: moderator.id, action: "community.request_approved", resource_type: "community_join_request",
      metadata: { communityId: priv, userId: requester.id } }]);
    // A rejection creates no membership.
    const rejected = (await requestAccess(second, priv)).request_id!;
    expect(await decide(host.owner, rejected, "reject")).toEqual({ outcome: "rejected", membership_status: null });
    expect((await memberships(priv)).map((row) => row.user_id)).not.toContain(second.id);
    expect((await communityNotices(priv)).filter((row) => row.recipient_user_id === second.id).map((row) => [row.kind, row.title]))
      .toEqual([["community_request_rejected", "Your request to join Decide Private was declined"]]);
    expect((await auditOf(rejected)).map((row) => row.action)).toEqual(["community.request_rejected"]);
    // Approval re-activates a membership the requester had left.
    expect(await outcome(requester, "ws_leave_community($1)", [priv])).toBe("ok");
    const rejoin = (await requestAccess(requester, priv)).request_id!;
    expect(await decide(admin, rejoin, "approve")).toEqual({ outcome: "approved", membership_status: "active" });
    expect((await memberships(priv)).filter((row) => row.user_id === requester.id)).toEqual([{ user_id: requester.id, role: "member", status: "active" }]);
    // Frozen communities refuse decisions.
    const third = await account("Decide third");
    const frozenRequest = (await requestAccess(third, priv)).request_id!;
    await owner.query("SET ROLE spark_owner");
    await owner.query(`UPDATE ${table("communities")} SET frozen_at=now() WHERE id=$1`, [priv]);
    expect(await decide(moderator, frozenRequest, "approve")).toEqual({ outcome: "community_frozen", membership_status: null });
    // Hidden communities: a stranger cannot tell the request exists.
    await owner.query(`UPDATE ${table("communities")} SET frozen_at=NULL,visibility='hidden' WHERE id=$1`, [priv]);
    expect(await decide(stranger, frozenRequest, "approve")).toEqual({ outcome: "not_found", membership_status: null });
  });

  it("enforces the rejection cooldown", async () => {
    const host = await hostWorkspace("Cooldown host");
    const requester = await account("Cooldown requester");
    const priv = await communityFixture(host, { name: "Cooldown Private", visibility: "private" });
    const first = (await requestAccess(requester, priv)).request_id!;
    expect((await decide(host.owner, first, "reject")).outcome).toBe("rejected");
    expect((await requestAccess(requester, priv)).outcome).toBe("request_cooldown");
    await owner.query("SET ROLE spark_owner");
    const reviewedAt = (await owner.query(`UPDATE ${table("community_join_requests")} SET reviewed_at=now()-interval '13 days' WHERE id=$1 RETURNING reviewed_at`, [first])).rows[0].reviewed_at as Date;
    expect(await requestAccess(requester, priv)).toEqual({ outcome: "request_cooldown", request_id: null, retry_after: new Date(reviewedAt.getTime() + 14 * 24 * 60 * 60 * 1000) });
    await owner.query("SET ROLE spark_owner");
    await owner.query(`UPDATE ${table("community_join_requests")} SET reviewed_at=now()-interval '15 days' WHERE id=$1`, [first]);
    expect(await requestAccess(requester, priv)).toMatchObject({ outcome: "requested", retry_after: null });
  });

  it("shows community notifications outside the host workspace", async () => {
    const host = await hostWorkspace("Inbox host");
    const requester = await account("Inbox requester");
    // The requester belonged to another workspace and left it; that workspace's notification stays hidden.
    const former = (await createWorkspace(await account("Former owner"))).workspace_id!;
    await addMember(former, requester, "member");
    const hiddenNotice = await plantNotice(former, requester, "invitation_accepted", "workspace", former, 1, "Former workspace");
    await leave(former, requester);
    const priv = await communityFixture(host, { name: "Inbox Private", visibility: "private" });
    const request = (await requestAccess(requester, priv)).request_id!;
    const hostSlug = await slugOf(host.workspace);
    // The owner's inbox links to the manage page.
    const received = (await listNotices(host.owner)).filter((row) => row.kind === "community_request_received");
    expect(received).toMatchObject([{ tenant_id: host.workspace, workspace_slug: hostSlug, workspace_name: "Inbox host", resource_type: "community", resource_id: priv,
      link: `/communities/${communitySlug(priv)}/manage`, title: "Inbox requester asked to join Inbox Private" }]);
    expect((await decide(host.owner, request, "approve")).outcome).toBe("approved");
    const inbox = await listNotices(requester);
    expect(inbox.map((row) => row.id)).not.toContain(hiddenNotice);
    expect(inbox).toEqual([{ id: inbox[0]!.id, tenant_id: host.workspace, workspace_slug: hostSlug, workspace_name: "Inbox host", kind: "community_request_approved",
      title: "Your request to join Inbox Private was approved", body: null, resource_type: "community", resource_id: priv, link: `/communities/${communitySlug(priv)}`,
      created_at: inbox[0]!.created_at, read_at: null }]);
    expect(await unreadCount(requester)).toBe(1);
    expect(await markOne(requester, hiddenNotice)).toBe("not_found");
    expect(await markOne(requester, inbox[0]!.id)).toBe("ok");
    expect(await unreadCount(requester)).toBe(0);
    expect(await readAtOf(hiddenNotice)).toBeNull();
    // Mark-all covers community rows but not the hidden workspace row.
    const other = await communityFixture(host, { name: "Inbox Second", visibility: "private" });
    const declined = (await requestAccess(requester, other)).request_id!;
    expect((await decide(host.owner, declined, "reject")).outcome).toBe("rejected");
    expect(await unreadCount(requester)).toBe(1);
    expect(await markAll(requester, new Date(Date.now() + 60_000))).toBe(1);
    expect(await readAtOf(hiddenNotice)).toBeNull();
    // An archived community keeps the notification but drops its link.
    await owner.query("SET ROLE spark_owner");
    await owner.query(`UPDATE ${table("communities")} SET archived_at=now() WHERE id=$1`, [other]);
    expect((await listNotices(requester)).find((row) => row.kind === "community_request_rejected")!.link).toBeNull();
  });

  it("protects the last community owner", async () => {
    const host = await hostWorkspace("Owner host");
    const admin = await account("Owner admin"), modA = await account("Owner modA"), modB = await account("Owner modB"), member = await account("Owner member"), stranger = await account("Owner stranger");
    await addMember(host.workspace, admin, "admin");
    const community = await communityFixture(host, { name: "Owner Public" });
    await joinCommunity(host, community, modA, "moderator");
    await joinCommunity(host, community, modB, "moderator");
    await joinCommunity(host, community, member);
    const ownerId = host.owner.id;
    expect(await outcome(host.owner, "ws_leave_community($1)", [community])).toBe("last_owner");
    expect(await outcome(host.owner, "ws_set_community_role($1,$2,$3)", [community, ownerId, "member"])).toBe("last_owner");
    expect(await outcome(admin, "ws_remove_community_member($1,$2)", [community, ownerId])).toBe("last_owner");
    // Moderators remove members only and never change roles.
    expect(await outcome(modA, "ws_remove_community_member($1,$2)", [community, modB.id])).toBe("forbidden");
    expect(await outcome(modA, "ws_set_community_role($1,$2,$3)", [community, member.id, "moderator"])).toBe("forbidden");
    expect(await outcome(member, "ws_remove_community_member($1,$2)", [community, modB.id])).toBe("forbidden");
    expect(await outcome(stranger, "ws_set_community_role($1,$2,$3)", [community, member.id, "owner"])).toBe("forbidden");
    expect(await outcome(modA, "ws_remove_community_member($1,$2)", [community, member.id])).toBe("ok");
    expect(await outcome(modA, "ws_remove_community_member($1,$2)", [community, member.id])).toBe("not_found");
    expect(await outcome(host.owner, "ws_set_community_role($1,$2,$3)", [community, stranger.id, "member"])).toBe("not_found");
    expect(await outcome(host.owner, "ws_set_community_role($1,$2,$3)", [randomUUID(), modA.id, "owner"])).toBe("not_found");
    await expect(outcome(host.owner, "ws_set_community_role($1,$2,$3)", [community, modA.id, "admin"])).rejects.toMatchObject({ code: "22023", message: "Invalid community role" });
    // With a second owner the first may leave.
    expect(await outcome(admin, "ws_set_community_role($1,$2,$3)", [community, modA.id, "owner"])).toBe("ok");
    expect(await outcome(host.owner, "ws_leave_community($1)", [community])).toBe("ok");
    expect(await outcome(host.owner, "ws_leave_community($1)", [community])).toBe("not_found");
    expect(await outcome(modA, "ws_set_community_role($1,$2,$3)", [community, modA.id, "member"])).toBe("last_owner");
    expect(await memberships(community)).toEqual([
      { user_id: ownerId, role: "owner", status: "left" }, { user_id: modA.id, role: "owner", status: "active" },
      { user_id: modB.id, role: "moderator", status: "active" }, { user_id: member.id, role: "member", status: "left" }].sort((a, b) => (a.user_id < b.user_id ? -1 : 1)));
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT action,actor_user_id,metadata FROM ${table("audit_events")} WHERE resource_type='community_membership' AND tenant_id=$1 ORDER BY created_at,id`, [host.workspace])).rows).toEqual([
      { action: "community.member_removed", actor_user_id: modA.id, metadata: { communityId: community, userId: member.id, role: "member" } },
      { action: "community.role_changed", actor_user_id: admin.id, metadata: { communityId: community, userId: modA.id, from: "moderator", to: "owner" } },
    ]);
    // A hidden community does not exist for strangers.
    await owner.query(`UPDATE ${table("communities")} SET visibility='hidden' WHERE id=$1`, [community]);
    expect(await outcome(stranger, "ws_remove_community_member($1,$2)", [community, modB.id])).toBe("not_found");
    expect(await outcome(stranger, "ws_leave_community($1)", [community])).toBe("not_found");
  });

  it("adds hidden-community members from the host workspace only", async () => {
    const host = await hostWorkspace("Add host");
    const coworker = await account("Add coworker"), colleague = await account("Add colleague"), outsider = await account("Add outsider"), moderator = await account("Add moderator");
    await addMember(host.workspace, coworker, "member");
    await addMember(host.workspace, colleague, "member");
    const hid = await communityFixture(host, { name: "Add Hidden", visibility: "hidden" });
    await joinCommunity(host, hid, moderator, "moderator");
    // Candidates: active host members without a community membership, by name.
    expect(await readAs(moderator, "ws_list_community_member_candidates($1)", [hid])).toEqual([
      { user_id: colleague.id, display_name: "Add colleague", avatar_url: null }, { user_id: coworker.id, display_name: "Add coworker", avatar_url: null }]);
    expect(await outcome(host.owner, "ws_add_community_member($1,$2)", [hid, coworker.id])).toBe("ok");
    expect(await outcome(host.owner, "ws_add_community_member($1,$2)", [hid, coworker.id])).toBe("already_member");
    expect(await outcome(host.owner, "ws_add_community_member($1,$2)", [hid, outsider.id])).toBe("not_in_workspace");
    expect(await outcome(host.owner, "ws_add_community_member($1,$2)", [hid, randomUUID()])).toBe("not_in_workspace");
    expect(await outcome(outsider, "ws_add_community_member($1,$2)", [hid, colleague.id])).toBe("not_found");
    expect(await outcome(coworker, "ws_add_community_member($1,$2)", [hid, colleague.id])).toBe("forbidden");
    // A moderator outside the host workspace may still add host members.
    expect(await outcome(moderator, "ws_add_community_member($1,$2)", [hid, colleague.id])).toBe("ok");
    expect(await readAs(moderator, "ws_list_community_member_candidates($1)", [hid])).toEqual([]);
    // A member who left is re-activated; someone who left the host workspace cannot be added.
    expect(await outcome(coworker, "ws_leave_community($1)", [hid])).toBe("ok");
    expect(await outcome(moderator, "ws_add_community_member($1,$2)", [hid, coworker.id])).toBe("ok");
    expect((await memberships(hid)).find((row) => row.user_id === coworker.id)).toEqual({ user_id: coworker.id, role: "member", status: "active" });
    expect(await outcome(colleague, "ws_leave_community($1)", [hid])).toBe("ok");
    await leave(host.workspace, colleague);
    expect(await outcome(host.owner, "ws_add_community_member($1,$2)", [hid, colleague.id])).toBe("not_in_workspace");
    // Frozen communities take no new members and leave a pending request untouched; existing members stay already_member.
    const frozenTarget = await account("Add frozen target");
    await addMember(host.workspace, frozenTarget, "member");
    await owner.query("SET ROLE spark_owner");
    await owner.query(`INSERT INTO ${table("community_join_requests")} (tenant_id,community_id,user_id) VALUES ($1,$2,$3)`, [host.workspace, hid, frozenTarget.id]);
    await owner.query(`UPDATE ${table("communities")} SET frozen_at=now() WHERE id=$1`, [hid]);
    expect(await outcome(moderator, "ws_add_community_member($1,$2)", [hid, frozenTarget.id])).toBe("community_frozen");
    expect(await outcome(host.owner, "ws_add_community_member($1,$2)", [hid, frozenTarget.id])).toBe("community_frozen");
    expect(await outcome(host.owner, "ws_add_community_member($1,$2)", [hid, coworker.id])).toBe("already_member");
    expect((await memberships(hid)).map((row) => row.user_id)).not.toContain(frozenTarget.id);
    expect((await requestRows(hid)).filter((row) => row.user_id === frozenTarget.id)).toEqual([{ id: expect.any(String), user_id: frozenTarget.id, status: "pending", message: null,
      reviewed_by_user_id: null, reviewed_at: null }]);
    await owner.query("SET ROLE spark_owner");
    await owner.query(`UPDATE ${table("communities")} SET frozen_at=NULL WHERE id=$1`, [hid]);
    expect((await owner.query(`SELECT action FROM ${table("audit_events")} WHERE resource_type='community_membership' AND tenant_id=$1 ORDER BY created_at,id`, [host.workspace])).rows.map((row) => row.action))
      .toEqual(["community.member_added", "community.member_added", "community.member_added"]);
    // Candidates are for managers only.
    await expect(readAs(coworker, "ws_list_community_member_candidates($1)", [hid])).rejects.toMatchObject(denied);
    await expect(readAs(outsider, "ws_list_community_member_candidates($1)", [hid])).rejects.toMatchObject(notFound);
    await expect(readAs(null, "ws_list_community_member_candidates($1)", [hid])).rejects.toMatchObject({ code: "28000" });
  });

  it("lists members, requests and communities without emails", async () => {
    const host = await hostWorkspace("List host");
    const admin = await account("List admin"), member = await account("List member"), requester = await account("List requester"), stranger = await account("List stranger");
    const coworker = await account("List coworker"), gone = await account("List gone");
    await addMember(host.workspace, admin, "admin");
    await addMember(host.workspace, coworker, "member");
    const priv = await communityFixture(host, { name: "List Private", visibility: "private" });
    const hid = await communityFixture(host, { name: "List Hidden", visibility: "hidden" });
    const pub = await communityFixture(host, { name: "List Public", topics: ["product"] });
    await communityFixture(host, { name: "List Archived", archived: true });
    await joinCommunity(host, priv, member);
    await joinCommunity(host, priv, gone);
    await owner.query(`UPDATE ${table("community_memberships")} SET status='left',left_at=now() WHERE community_id=$1 AND user_id=$2`, [priv, gone.id]);
    // Members: active rows only, for members and managers; never an email.
    const members = await readAs(member, "ws_list_community_members($1)", [priv]);
    expect(members.map((row) => Object.keys(row).sort())).toEqual([["avatar_url", "display_name", "joined_at", "role", "user_id"], ["avatar_url", "display_name", "joined_at", "role", "user_id"]]);
    expect(members.map((row) => [row.user_id, row.role])).toEqual([[host.owner.id, "owner"], [member.id, "member"]]);
    expect((await readAs(admin, "ws_list_community_members($1)", [priv])).length).toBe(2);
    await expect(readAs(stranger, "ws_list_community_members($1)", [priv])).rejects.toMatchObject(denied);
    await expect(readAs(stranger, "ws_list_community_members($1)", [hid])).rejects.toMatchObject(notFound);
    await expect(readAs(stranger, "ws_list_community_members($1)", [randomUUID()])).rejects.toMatchObject(notFound);
    // Requests: managers only; requester name and message, no email and no reviewer.
    const request = (await requestAccess(requester, priv, "Hi")).request_id!;
    const rejectedRequest = (await requestAccess(stranger, priv)).request_id!;
    expect((await decide(admin, rejectedRequest, "reject")).outcome).toBe("rejected");
    const pending = await readAs(admin, "ws_list_community_requests($1,$2)", [priv, "pending"]);
    expect(pending).toEqual([{ id: request, user_id: requester.id, display_name: "List requester", avatar_url: null, message: "Hi", status: "pending",
      created_at: pending[0]!.created_at, reviewed_at: null }]);
    expect((await readAs(host.owner, "ws_list_community_requests($1,$2)", [priv, null])).map((row) => row.id)).toEqual([request, rejectedRequest]);
    expect((await readAs(host.owner, "ws_list_community_requests($1,$2)", [priv, "rejected"])).map((row) => row.id)).toEqual([rejectedRequest]);
    await expect(readAs(member, "ws_list_community_requests($1,$2)", [priv, "pending"])).rejects.toMatchObject(denied);
    await expect(readAs(stranger, "ws_list_community_requests($1,$2)", [hid, "pending"])).rejects.toMatchObject(notFound);
    await expect(readAs(admin, "ws_list_community_requests($1,$2)", [priv, "open"])).rejects.toMatchObject({ code: "22023", message: "Invalid request status" });
    // The requester's own requests, newest first, without the reviewer.
    const mine = await readAs(stranger, "ws_list_my_community_requests()");
    expect(mine).toEqual([{ id: rejectedRequest, community_id: priv, community_slug: communitySlug(priv), community_name: "List Private", status: "rejected", message: null,
      created_at: mine[0]!.created_at, reviewed_at: mine[0]!.reviewed_at }]);
    expect(mine[0]!.reviewed_at).toBeInstanceOf(Date);
    // A community that became hidden drops out of the list of someone outside it.
    await owner.query("SET ROLE spark_owner");
    await owner.query(`UPDATE ${table("communities")} SET visibility='hidden' WHERE id=$1`, [priv]);
    expect(await readAs(stranger, "ws_list_my_community_requests()")).toEqual([]);
    await owner.query(`UPDATE ${table("communities")} SET visibility='private' WHERE id=$1`, [priv]);
    // Workspace communities: hidden ones only for their members and managers; archived never.
    const names = (rows: Record<string, unknown>[]) => rows.map((row) => row.name);
    expect(names(await readAs(coworker, "ws_list_workspace_communities($1)", [host.workspace]))).toEqual(["List Private", "List Public"]);
    expect(names(await readAs(admin, "ws_list_workspace_communities($1)", [host.workspace]))).toEqual(["List Hidden", "List Private", "List Public"]);
    const cards = await readAs(host.owner, "ws_list_workspace_communities($1)", [host.workspace]);
    expect(cards.find((card) => card.id === pub)).toMatchObject({ slug: communitySlug(pub), topics: ["product"], viewer_status: "owner", host_workspace_name: "List host", member_count: "1" });
    await expect(readAs(stranger, "ws_list_workspace_communities($1)", [host.workspace])).rejects.toMatchObject({ code: "P0002", message: "Workspace not found" });
    // My communities: active memberships, by name; archived communities and inactive hosts excluded.
    expect(names(await readAs(member, "my_communities()"))).toEqual(["List Private"]);
    expect(names(await readAs(host.owner, "my_communities()"))).toEqual(["List Hidden", "List Private", "List Public"]);
    expect(await readAs(gone, "my_communities()")).toEqual([]);
    expect((await readAs(member, "my_communities()"))[0]).toMatchObject({ id: priv, viewer_status: "member", visibility: "private" });
    await expect(readAs(null, "my_communities()")).rejects.toMatchObject({ code: "28000" });
    await owner.query("SET ROLE spark_owner");
    await owner.query(`UPDATE ${table("workspaces")} SET status='archived',archived_at=now(),version=version+1 WHERE id=$1`, [host.workspace]);
    expect(await readAs(member, "my_communities()")).toEqual([]);
  });

  it("keeps the community write functions definers with an empty search_path and the helpers internal", async () => {
    await owner.query("SET ROLE spark_owner");
    const exposed = ["my_communities", "ws_add_community_member", "ws_create_community", "ws_decide_community_request", "ws_join_community", "ws_leave_community",
      "ws_list_community_member_candidates", "ws_list_community_members", "ws_list_community_requests", "ws_list_my_community_requests", "ws_list_workspace_communities",
      "ws_remove_community_member", "ws_request_community_membership", "ws_set_community_role", "ws_update_community", "ws_withdraw_community_request"];
    const internal = ["check_community_field", "check_community_topics", "community_actor_access", "lock_community"];
    const rows = (await owner.query(`SELECT p.proname, p.prosecdef, p.proconfig, has_function_privilege('spark_app',p.oid,'EXECUTE') AS runtime,
      has_function_privilege('spark_worker',p.oid,'EXECUTE') AS worker, has_function_privilege('spark_auth',p.oid,'EXECUTE') AS auth
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname = ANY($2) ORDER BY p.proname COLLATE "C"`, [namespace, [...exposed, ...internal]])).rows;
    expect(rows.map((row) => [row.proname, row.prosecdef, row.proconfig, row.runtime, row.worker, row.auth])).toEqual([...exposed, ...internal].sort().map((name) =>
      [name, !internal.includes(name), ['search_path=""'], !internal.includes(name), false, false]));
    const kinds = (await owner.query(`SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND c.conname='notifications_kind_allowed'`, [namespace])).rows[0].def as string;
    for (const kind of ["community_request_received", "community_request_approved", "community_request_rejected", "event_cancelled"]) expect(kinds).toContain(kind);
  });
});

type PostInput = { title?: string; body?: string; createdAt?: string; moderation?: "visible" | "hidden"; deleted?: boolean; visibility?: "public" | "members" | "hidden" };
// A post written by the table owner; createdAt is a timestamptz literal so tests control microseconds.
async function plantPost(host: Host, community: string, author: string, input: PostInput = {}) {
  const id = randomUUID();
  await owner.query("SET ROLE spark_owner");
  await owner.query(`INSERT INTO ${table("posts")} (id,tenant_id,community_id,author_user_id,title,body,visibility,moderation_status,created_at,deleted_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9::timestamptz,now()),CASE WHEN $10::boolean THEN now() END)`,
    [id, host.workspace, community, author, input.title ?? "A post", input.body ?? "Post body", input.visibility ?? "members", input.moderation ?? "visible",
      input.createdAt ?? null, input.deleted ?? false]);
  return id;
}
type CommentInput = { body?: string; createdAt?: string; moderation?: "visible" | "hidden"; deleted?: boolean };
async function plantComment(host: Host, community: string, post: string, author: string, input: CommentInput = {}) {
  const id = randomUUID();
  await owner.query("SET ROLE spark_owner");
  await owner.query(`INSERT INTO ${table("post_comments")} (id,tenant_id,community_id,post_id,author_user_id,body,moderation_status,created_at,deleted_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,coalesce($8::timestamptz,now()),CASE WHEN $9::boolean THEN now() END)`,
    [id, host.workspace, community, post, author, input.body ?? "Comment body", input.moderation ?? "visible", input.createdAt ?? null, input.deleted ?? false]);
  return id;
}
async function plantReport(host: Host, community: string, reporter: string, target: { post?: string; comment?: string }, status = "open") {
  await owner.query("SET ROLE spark_owner");
  await owner.query(`INSERT INTO ${table("content_reports")} (tenant_id,community_id,reporter_user_id,post_id,comment_id,reason_code,status,resolved_at)
    VALUES ($1,$2,$3,$4,$5,'spam',$6::text,CASE WHEN $6::text IN ('resolved','dismissed') THEN now() END)`, [host.workspace, community, reporter, target.post ?? null, target.comment ?? null, status]);
}
type FeedRow = { id: string; community_id: string; author_id: string; author_name: string; author_avatar_url: string | null; title: string; excerpt: string; truncated: boolean;
  created_at: Date; edited_at: Date | null; comment_count: string; moderation_status: string; version: number; viewer_is_author: boolean; viewer_reported: boolean; cursor_ts: string };
const feedCall = `SELECT *, created_at::text AS cursor_ts FROM ${fn("community_feed")}($1,$2::timestamptz,$3,$4)`;
const feed = async (who: Account | null, community: string, before: [string, string] | null = null, limit: unknown = 50) =>
  (await asSession(who?.token ?? null, feedCall, [community, before?.[0] ?? null, before?.[1] ?? null, limit])).rows as FeedRow[];
const feedIds = async (who: Account | null, community: string) => (await feed(who, community)).map((row) => row.id);
const postDetail = async (who: Account | null, post: string) =>
  (await asSession(who?.token ?? null, `SELECT * FROM ${fn("community_post")}($1)`, [post])).rows as Record<string, unknown>[];
type CommentRow = { id: string; post_id: string; author_id: string; author_name: string; author_avatar_url: string | null; body: string; created_at: Date; edited_at: Date | null;
  moderation_status: string; version: number; viewer_is_author: boolean; viewer_reported: boolean; cursor_ts: string };
const commentsCall = `SELECT *, created_at::text AS cursor_ts FROM ${fn("community_post_comments")}($1,$2::timestamptz,$3,$4)`;
const comments = async (who: Account | null, post: string, after: [string, string] | null = null, limit: unknown = 50) =>
  (await asSession(who?.token ?? null, commentsCall, [post, after?.[0] ?? null, after?.[1] ?? null, limit])).rows as CommentRow[];
const commentDetail = async (who: Account | null, comment: string) =>
  (await asSession(who?.token ?? null, `SELECT * FROM ${fn("community_comment")}($1)`, [comment])).rows as Record<string, unknown>[];
const canModerate = async (who: Account | null, community: string) =>
  (await asSession(who?.token ?? null, `SELECT ${fn("can_moderate_community")}($1) AS allowed`, [community])).rows[0].allowed as boolean;
const communityGone = { code: "P0002", message: "Community not found" };
const membersOnly = { code: "42501", message: "Community members only" };
const postGone = { code: "P0002", message: "Post not found" };

describe("Community content reads", () => {
  it("reads public community content without a session", async () => {
    const host = await hostWorkspace("Open content host");
    const stranger = await account("Open content stranger");
    const pub = await communityFixture(host, { name: "Open Circle" });
    const priv = await communityFixture(host, { name: "Closed Circle", visibility: "private" });
    const hid = await communityFixture(host, { name: "Secret Circle", visibility: "hidden" });
    const archived = await communityFixture(host, { name: "Old Circle" });
    const post = await plantPost(host, pub, host.owner.id, { title: "Hello", body: "Public body" });
    const comment = await plantComment(host, pub, post, host.owner.id, { body: "First" });
    await plantPost(host, priv, host.owner.id);
    await plantPost(host, hid, host.owner.id);
    await plantPost(host, archived, host.owner.id);
    await owner.query(`UPDATE ${table("communities")} SET archived_at=now() WHERE id=$1`, [archived]);
    for (const who of [null, stranger]) {
      const rows = await feed(who, pub);
      expect(rows.map((row) => [row.id, row.title, row.excerpt, row.truncated, row.viewer_is_author, row.viewer_reported])).toEqual([[post, "Hello", "Public body", false, false, false]]);
      expect((await postDetail(who, post)).map((row) => [row.id, row.community_slug, row.body, row.viewer_is_member, row.viewer_can_moderate, row.community_frozen]))
        .toEqual([[post, communitySlug(pub), "Public body", false, false, false]]);
      expect((await comments(who, post)).map((row) => [row.id, row.body])).toEqual([[comment, "First"]]);
      expect((await commentDetail(who, comment)).map((row) => [row.id, row.post_id, row.community_id])).toEqual([[comment, post, pub]]);
      await expect(feed(who, priv)).rejects.toMatchObject(membersOnly);
      await expect(feed(who, hid)).rejects.toMatchObject(communityGone);
      await expect(feed(who, archived)).rejects.toMatchObject(communityGone);
      await expect(feed(who, randomUUID())).rejects.toMatchObject(communityGone);
    }
    // Row access follows the same rule for the runtime role.
    expect((await asSession(null, `SELECT id FROM ${table("posts")} WHERE id=$1`, [post])).rows).toEqual([{ id: post }]);
    expect((await asSession(null, `SELECT id FROM ${table("post_comments")} WHERE id=$1`, [comment])).rows).toEqual([{ id: comment }]);
  });

  it("reads private content as a member only", async () => {
    const host = await hostWorkspace("Private content host");
    const member = await account("Private member"), stranger = await account("Private stranger"), admin = await account("Private host admin");
    await addMember(host.workspace, admin, "admin");
    const priv = await communityFixture(host, { name: "Members Circle", visibility: "private" });
    const hid = await communityFixture(host, { name: "Hidden Members Circle", visibility: "hidden" });
    await joinCommunity(host, priv, member);
    await joinCommunity(host, hid, member);
    const post = await plantPost(host, priv, member.id, { title: "Inside" });
    const comment = await plantComment(host, priv, post, host.owner.id);
    const hiddenPost = await plantPost(host, hid, host.owner.id);
    expect((await feed(member, priv)).map((row) => [row.id, row.viewer_is_author])).toEqual([[post, true]]);
    expect(await feedIds(member, hid)).toEqual([hiddenPost]);
    expect((await postDetail(member, post)).map((row) => [row.viewer_is_author, row.viewer_is_member, row.viewer_can_moderate])).toEqual([[true, true, false]]);
    expect((await postDetail(host.owner, post)).map((row) => [row.viewer_is_author, row.viewer_is_member, row.viewer_can_moderate])).toEqual([[false, true, true]]);
    // A signed-in non-member and a host workspace admin who is not a member get nothing.
    for (const who of [stranger, admin]) {
      await expect(feed(who, priv)).rejects.toMatchObject(membersOnly);
      expect(await postDetail(who, post)).toEqual([]);
      await expect(comments(who, post)).rejects.toMatchObject(postGone);
      expect(await commentDetail(who, comment)).toEqual([]);
      expect((await asSession(who.token, `SELECT id FROM ${table("posts")} WHERE id=$1`, [post])).rows).toEqual([]);
    }
    // The host admin sees that the hidden community exists (C1) but not its content; a stranger does not see it.
    await expect(feed(admin, hid)).rejects.toMatchObject(membersOnly);
    await expect(feed(stranger, hid)).rejects.toMatchObject(communityGone);
    expect(await postDetail(admin, hiddenPost)).toEqual([]);
    // Leaving revokes access at once.
    await owner.query(`UPDATE ${table("community_memberships")} SET status='left',left_at=now() WHERE community_id=$1 AND user_id=$2`, [priv, member.id]);
    await expect(feed(member, priv)).rejects.toMatchObject(membersOnly);
    expect(await postDetail(member, post)).toEqual([]);
  });

  it("shows moderated content to community moderators only", async () => {
    const host = await hostWorkspace("Moderated host");
    const member = await account("Moderated member"), moderator = await account("Community moderator"), admin = await account("Moderated host admin");
    await addMember(host.workspace, admin, "admin");
    const community = await communityFixture(host, { name: "Moderated Circle" });
    await joinCommunity(host, community, member);
    await joinCommunity(host, community, moderator, "moderator");
    await joinCommunity(host, community, admin);
    const visible = await plantPost(host, community, member.id, { title: "Visible" });
    const hidden = await plantPost(host, community, member.id, { title: "Hidden", moderation: "hidden" });
    const deleted = await plantPost(host, community, member.id, { title: "Deleted", deleted: true });
    const legacy = await plantPost(host, community, member.id, { title: "Legacy hidden", visibility: "hidden" });
    const hiddenComment = await plantComment(host, community, visible, member.id, { moderation: "hidden" });
    const shownComment = await plantComment(host, community, visible, member.id);
    const deletedComment = await plantComment(host, community, visible, member.id, { deleted: true });
    const onHiddenPost = await plantComment(host, community, hidden, member.id);
    for (const who of [null, member, admin]) {
      expect(await feedIds(who, community)).toEqual([visible]);
      expect(await postDetail(who, hidden)).toEqual([]);
      expect((await comments(who, visible)).map((row) => row.id)).toEqual([shownComment]);
      expect(await commentDetail(who, hiddenComment)).toEqual([]);
      await expect(comments(who, hidden)).rejects.toMatchObject(postGone);
      expect(await commentDetail(who, onHiddenPost)).toEqual([]);
    }
    for (const who of [moderator, host.owner]) {
      const rows = await feed(who, community);
      expect(rows.map((row) => [row.id, row.moderation_status]).sort()).toEqual([[hidden, "hidden"], [visible, "visible"]].sort());
      expect((await postDetail(who, hidden)).map((row) => [row.moderation_status, row.viewer_can_moderate])).toEqual([["hidden", true]]);
      expect((await comments(who, visible)).map((row) => [row.id, row.moderation_status]).sort()).toEqual([[hiddenComment, "hidden"], [shownComment, "visible"]].sort());
      expect((await comments(who, hidden)).map((row) => row.id)).toEqual([onHiddenPost]);
      expect((await commentDetail(who, hiddenComment)).map((row) => row.moderation_status)).toEqual(["hidden"]);
    }
    for (const who of [null, member, moderator, host.owner]) {
      for (const gone of [deleted, legacy]) {
        expect(await postDetail(who, gone)).toEqual([]);
        await expect(comments(who, gone)).rejects.toMatchObject(postGone);
      }
      expect(await commentDetail(who, deletedComment)).toEqual([]);
    }
    // A host workspace admin gets no moderation from that role; frozen communities stay readable.
    expect(await canModerate(admin, community)).toBe(false);
    expect(await canModerate(member, community)).toBe(false);
    expect(await canModerate(null, community)).toBe(false);
    expect(await canModerate(moderator, community)).toBe(true);
    expect(await canModerate(host.owner, community)).toBe(true);
    await owner.query(`UPDATE ${table("communities")} SET frozen_at=now() WHERE id=$1`, [community]);
    expect((await postDetail(member, visible)).map((row) => row.community_frozen)).toEqual([true]);
    expect(await feedIds(member, community)).toEqual([visible]);
    expect(await canModerate(moderator, community)).toBe(true);
    await owner.query(`UPDATE ${table("communities")} SET frozen_at=NULL,archived_at=now() WHERE id=$1`, [community]);
    expect(await canModerate(moderator, community)).toBe(false);
    expect(await postDetail(moderator, visible)).toEqual([]);
  });

  it("pages the feed without gaps or duplicates", async () => {
    const host = await hostWorkspace("Feed paging host");
    const community = await communityFixture(host, { name: "Paging Circle" });
    const times = ["2026-01-01 10:00:00.000001+00", "2026-01-01 10:00:00.000002+00", "2026-01-01 10:00:00.000002+00", "2026-01-01 10:00:00.000003+00",
      "2026-01-02 09:00:00+00", "2026-01-03 09:00:00+00", "2026-01-04 09:00:00+00"];
    for (const at of times) await plantPost(host, community, host.owner.id, { createdAt: at });
    const expected = (await owner.query(`SELECT id FROM ${table("posts")} WHERE community_id=$1 ORDER BY created_at DESC, id DESC`, [community])).rows.map((row) => row.id);
    expect(expected).toHaveLength(7);
    const seen: string[] = [];
    let cursor: [string, string] | null = null;
    for (let page = 0; page < 5; page++) {
      const rows: FeedRow[] = await feed(null, community, cursor, 3);
      const shown = rows.slice(0, 3);
      seen.push(...shown.map((row) => row.id));
      if (rows.length <= 3) break;
      expect(rows).toHaveLength(4);
      cursor = [shown.at(-1)!.cursor_ts, shown.at(-1)!.id];
    }
    expect(seen).toEqual(expected);
    for (const limit of [0, 51, null]) await expect(feed(null, community, null, limit)).rejects.toMatchObject({ code: "22023", message: "Invalid post limit" });
    await expect(asSession(null, feedCall, [community, "2026-01-01 00:00:00+00", null, 3])).rejects.toMatchObject({ code: "22023", message: "Invalid post cursor" });
    await expect(asSession(null, feedCall, [community, null, randomUUID(), 3])).rejects.toMatchObject({ code: "22023", message: "Invalid post cursor" });
    // The excerpt is the first 400 characters.
    const long = await plantPost(host, community, host.owner.id, { body: `${"x".repeat(400)}tail` });
    const [first] = await feed(null, community, null, 1);
    expect([first!.id, first!.excerpt, first!.truncated]).toEqual([long, "x".repeat(400), true]);
  });

  it("pages comments oldest first", async () => {
    const host = await hostWorkspace("Comment paging host");
    const member = await account("Comment paging member");
    const community = await communityFixture(host, { name: "Comment Circle", visibility: "private" });
    await joinCommunity(host, community, member);
    const post = await plantPost(host, community, host.owner.id);
    const times = ["2026-02-01 10:00:00.000001+00", "2026-02-01 10:00:00.000002+00", "2026-02-01 10:00:00.000002+00", "2026-02-01 10:00:00.000003+00",
      "2026-02-02 09:00:00+00", "2026-02-03 09:00:00+00", "2026-02-04 09:00:00+00"];
    for (const at of times) await plantComment(host, community, post, member.id, { createdAt: at });
    const expected = (await owner.query(`SELECT id FROM ${table("post_comments")} WHERE post_id=$1 ORDER BY created_at, id`, [post])).rows.map((row) => row.id);
    expect(expected).toHaveLength(7);
    const seen: string[] = [];
    let cursor: [string, string] | null = null;
    for (let page = 0; page < 5; page++) {
      const rows: CommentRow[] = await comments(member, post, cursor, 3);
      const shown = rows.slice(0, 3);
      seen.push(...shown.map((row) => row.id));
      if (rows.length <= 3) break;
      expect(rows).toHaveLength(4);
      cursor = [shown.at(-1)!.cursor_ts, shown.at(-1)!.id];
    }
    expect(seen).toEqual(expected);
    for (const limit of [0, 51, null]) await expect(comments(member, post, null, limit)).rejects.toMatchObject({ code: "22023", message: "Invalid comment limit" });
    await expect(asSession(member.token, commentsCall, [post, "2026-01-01 00:00:00+00", null, 3])).rejects.toMatchObject({ code: "22023", message: "Invalid comment cursor" });
    await expect(asSession(member.token, commentsCall, [post, null, randomUUID(), 3])).rejects.toMatchObject({ code: "22023", message: "Invalid comment cursor" });
    await expect(comments(member, randomUUID())).rejects.toMatchObject(postGone);
    // Comments of a post hidden by moderation are unreadable for members.
    const hiddenPost = await plantPost(host, community, member.id, { moderation: "hidden" });
    await plantComment(host, community, hiddenPost, member.id);
    await expect(comments(member, hiddenPost)).rejects.toMatchObject(postGone);
    expect(await comments(host.owner, hiddenPost)).toHaveLength(1);
  });

  it("counts and flags for the viewer", async () => {
    const host = await hostWorkspace("Flags host");
    const member = await account("Flags member"), reporter = await account("Flags reporter"), gone = await account("Flags leaver");
    const community = await communityFixture(host, { name: "Flags Circle" });
    for (const who of [member, reporter, gone]) await joinCommunity(host, community, who);
    const post = await plantPost(host, community, gone.id, { title: "By a former member" });
    await plantComment(host, community, post, member.id, { createdAt: "2026-03-01 10:00:00+00" });
    await plantComment(host, community, post, member.id, { createdAt: "2026-03-01 10:01:00+00" });
    await plantComment(host, community, post, member.id, { moderation: "hidden" });
    await plantComment(host, community, post, member.id, { deleted: true });
    const reported = await plantComment(host, community, post, gone.id, { createdAt: "2026-03-01 10:02:00+00" });
    await plantReport(host, community, reporter.id, { post });
    await plantReport(host, community, member.id, { post }, "dismissed");
    await plantReport(host, community, reporter.id, { comment: reported }, "reviewing");
    await owner.query(`UPDATE ${table("users")} SET avatar_url='https://example.com/a.png', status='deleted', deleted_at=now() WHERE id=$1`, [gone.id]);
    const counts = async (who: Account | null) => (await feed(who, community)).map((row) => [row.comment_count, row.viewer_reported, row.author_name, row.author_avatar_url]);
    expect(await counts(reporter)).toEqual([["3", true, "Former member", null]]);
    expect(await counts(member)).toEqual([["3", false, "Former member", null]]);
    expect(await counts(host.owner)).toEqual([["3", false, "Former member", null]]);
    expect(await counts(null)).toEqual([["3", false, "Former member", null]]);
    expect((await postDetail(reporter, post)).map((row) => [row.comment_count, row.viewer_reported, row.author_name, row.author_avatar_url])).toEqual([["3", true, "Former member", null]]);
    expect((await postDetail(member, post)).map((row) => row.viewer_reported)).toEqual([false]);
    const flagged = (await comments(reporter, post)).map((row) => [row.id === reported, row.viewer_reported, row.author_name]);
    expect(flagged).toEqual([[false, false, "Flags member"], [false, false, "Flags member"], [true, true, "Former member"]]);
    expect((await commentDetail(reporter, reported)).map((row) => [row.viewer_reported, row.author_name, row.author_avatar_url])).toEqual([[true, "Former member", null]]);
    expect((await commentDetail(member, reported)).map((row) => row.viewer_reported)).toEqual([false]);
    // Projections never carry an email or a reporter column.
    for (const row of [...await feed(reporter, community), ...await postDetail(reporter, post), ...await comments(reporter, post), ...await commentDetail(reporter, reported)]) {
      expect(Object.keys(row).some((key) => key.includes("email") || key.includes("reporter"))).toBe(false);
    }
  });

  it("adds edited_at and body length checks", async () => {
    const columns = (await owner.query(`SELECT table_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND column_name='edited_at' AND table_name IN ('posts','post_comments') ORDER BY table_name`, [namespace])).rows;
    expect(columns).toEqual([{ table_name: "post_comments", data_type: "timestamp with time zone", is_nullable: "YES" }, { table_name: "posts", data_type: "timestamp with time zone", is_nullable: "YES" }]);
    const checks = (await owner.query(`SELECT conname,convalidated FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND conname IN ('posts_body_length','post_comments_body_length') ORDER BY conname`, [namespace])).rows;
    expect(checks).toEqual([{ conname: "post_comments_body_length", convalidated: false }, { conname: "posts_body_length", convalidated: false }]);
    const host = await hostWorkspace("Length host");
    const community = await communityFixture(host, { name: "Length Circle" });
    const post = await plantPost(host, community, host.owner.id);
    for (const body of ["   ", "x".repeat(10001)]) {
      await reject(`INSERT INTO ${table("posts")} (tenant_id,community_id,author_user_id,title,body) VALUES ($1,$2,$3,'Title',$4)`, [host.workspace, community, host.owner.id, body], "23514");
    }
    for (const body of ["   ", "x".repeat(2001)]) {
      await reject(`INSERT INTO ${table("post_comments")} (tenant_id,community_id,post_id,author_user_id,body) VALUES ($1,$2,$3,$4,$5)`, [host.workspace, community, post, host.owner.id, body], "23514");
    }
    await plantPost(host, community, host.owner.id, { body: "x".repeat(10000) });
    await plantComment(host, community, post, host.owner.id, { body: "x".repeat(2000) });
  });

  it("keeps the content read functions definers with an empty search_path", async () => {
    const exposed = ["can_moderate_community", "can_read_post", "community_comment", "community_feed", "community_post", "community_post_comments"];
    const rows = (await owner.query(`SELECT p.proname, p.prosecdef, p.provolatile, p.proconfig, has_function_privilege('spark_app',p.oid,'EXECUTE') AS runtime,
      has_function_privilege('spark_worker',p.oid,'EXECUTE') AS worker, has_function_privilege('spark_auth',p.oid,'EXECUTE') AS auth
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname = ANY($2) ORDER BY p.proname COLLATE "C"`, [namespace, exposed])).rows;
    expect(rows.map((row) => [row.proname, row.prosecdef, row.provolatile, row.proconfig, row.runtime, row.worker, row.auth]))
      .toEqual(exposed.map((name) => [name, true, "s", ['search_path=""'], true, false, false]));
  });
});

type PostWrite = { title?: string | null; body?: string | null; key?: string | null; hash?: Buffer | null };
type PostCreated = { outcome: string; post_id: string | null };
type CommentCreated = { outcome: string; comment_id: string | null };
type ContentUpdated = { outcome: string; version: number | null };
const createPostCall = `SELECT * FROM ${fn("ws_create_post")}($1,$2,$3,$4,$5)`;
const postArgs = (community: string, input: PostWrite) => [community, input.title === undefined ? "A post" : input.title, input.body === undefined ? "Post body" : input.body,
  input.key ?? null, input.hash ?? null];
const createPost = async (who: Account, community: string, input: PostWrite = {}) => (await asSession(who.token, createPostCall, postArgs(community, input))).rows[0] as PostCreated;
const createCommentCall = `SELECT * FROM ${fn("ws_create_comment")}($1,$2,$3,$4)`;
const commentArgs = (post: string, input: PostWrite) => [post, input.body === undefined ? "A comment" : input.body, input.key ?? null, input.hash ?? null];
const createComment = async (who: Account, post: string, input: PostWrite = {}) => (await asSession(who.token, createCommentCall, commentArgs(post, input))).rows[0] as CommentCreated;
const updatePost = async (who: Account, post: string, version: number, title: string | null, body: string | null) =>
  (await asSession(who.token, `SELECT * FROM ${fn("ws_update_post")}($1,$2,$3,$4)`, [post, version, title, body])).rows[0] as ContentUpdated;
const updateComment = async (who: Account, comment: string, version: number, body: string | null) =>
  (await asSession(who.token, `SELECT * FROM ${fn("ws_update_comment")}($1,$2,$3)`, [comment, version, body])).rows[0] as ContentUpdated;
const deletePost = (who: Account, post: string) => outcome(who, "ws_delete_post($1)", [post]);
const deleteComment = (who: Account, comment: string) => outcome(who, "ws_delete_comment($1)", [comment]);
const refusedPost = (result: string): PostCreated => ({ outcome: result, post_id: null });
const refusedComment = (result: string): CommentCreated => ({ outcome: result, comment_id: null });
const refusedUpdate = (result: string): ContentUpdated => ({ outcome: result, version: null });
const invalid = (message: string) => ({ code: "22023", message });
async function postRow(post: string) {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT tenant_id,community_id,author_user_id,title,body,visibility,moderation_status,version,edited_at IS NOT NULL AS edited,deleted_at IS NOT NULL AS deleted
    FROM ${table("posts")} WHERE id=$1`, [post])).rows[0];
}
async function commentRow(comment: string) {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT post_id,author_user_id,body,moderation_status,version,edited_at IS NOT NULL AS edited,deleted_at IS NOT NULL AS deleted
    FROM ${table("post_comments")} WHERE id=$1`, [comment])).rows[0];
}
async function postNotices(post: string) {
  await owner.query("SET ROLE spark_owner");
  return (await owner.query(`SELECT n.tenant_id,n.recipient_user_id,n.kind,n.title,n.body,n.resource_type,o.tenant_id AS outbox_tenant,o.processed_at IS NOT NULL AS processed
    FROM ${table("notifications")} n JOIN ${table("outbox_events")} o ON o.id=n.outbox_event_id WHERE n.resource_id=$1 ORDER BY n.created_at,n.id`, [post])).rows;
}
async function setCommunity(community: string, assignments: string) {
  await owner.query("SET ROLE spark_owner");
  await owner.query(`UPDATE ${table("communities")} SET ${assignments} WHERE id=$1`, [community]);
}
async function hideContent(kind: "posts" | "post_comments", id: string) {
  await owner.query("SET ROLE spark_owner");
  await owner.query(`UPDATE ${table(kind)} SET moderation_status='hidden',version=version+1 WHERE id=$1`, [id]);
}
const postLink = (community: string, post: string) => `/communities/${communitySlug(community)}/posts/${post}`;
const commentedNotices = async (who: Account) => (await listNotices(who)).filter((row) => row.kind === "post_commented");

describe("Community content writes", () => {
  it("creates posts for active members only", async () => {
    const host = await hostWorkspace("Post create host");
    const member = await account("Post member"), stranger = await account("Post stranger"), suspended = await account("Post suspended");
    const pub = await communityFixture(host, { name: "Post Open" });
    const priv = await communityFixture(host, { name: "Post Private", visibility: "private" });
    const hid = await communityFixture(host, { name: "Post Hidden", visibility: "hidden" });
    const frozen = await communityFixture(host, { name: "Post Frozen", frozen: true });
    const archived = await communityFixture(host, { name: "Post Archived" });
    for (const community of [pub, priv, hid, frozen, archived]) await joinCommunity(host, community, member);
    await joinCommunity(host, pub, suspended);
    await owner.query(`UPDATE ${table("community_memberships")} SET status='suspended' WHERE community_id=$1 AND user_id=$2`, [pub, suspended.id]);
    await setCommunity(archived, "archived_at=now()");

    const created = await createPost(member, pub, { title: "  Hello  ", body: "  Body text  " });
    expect(created).toEqual({ outcome: "created", post_id: expect.any(String) });
    expect(await postRow(created.post_id!)).toEqual({ tenant_id: host.workspace, community_id: pub, author_user_id: member.id, title: "Hello", body: "Body text",
      visibility: "members", moderation_status: "visible", version: 1, edited: false, deleted: false });
    expect(await feedIds(member, pub)).toEqual([created.post_id]);
    expect((await createPost(member, priv)).outcome).toBe("created");
    expect((await createPost(member, hid)).outcome).toBe("created");
    // Readable without an active membership: not_a_member (the private summary is public); unreadable: not_found.
    expect(await createPost(stranger, pub)).toEqual(refusedPost("not_a_member"));
    expect(await createPost(stranger, priv)).toEqual(refusedPost("not_a_member"));
    expect(await createPost(suspended, pub)).toEqual(refusedPost("not_a_member"));
    expect(await createPost(stranger, hid)).toEqual(refusedPost("not_found"));
    expect(await createPost(member, archived)).toEqual(refusedPost("not_found"));
    expect(await createPost(member, randomUUID())).toEqual(refusedPost("not_found"));
    expect(await createPost(member, frozen)).toEqual(refusedPost("community_frozen"));
    // Trimmed limits: title 1-150, body 1-10,000.
    for (const title of ["x".repeat(151), "   ", null]) await expect(createPost(member, pub, { title })).rejects.toMatchObject(invalid("Invalid post title"));
    for (const body of ["x".repeat(10001), "   ", null]) await expect(createPost(member, pub, { body })).rejects.toMatchObject(invalid("Invalid post body"));
    expect((await createPost(member, pub, { title: `  ${"x".repeat(150)}  `, body: "y".repeat(10000) })).outcome).toBe("created");
    await expect(createPost(member, pub, { key: "bad key", hash: randomBytes(32) })).rejects.toMatchObject(invalid("Invalid idempotency key"));
    await expect(createPost(member, pub, { key: "good-key", hash: randomBytes(31) })).rejects.toMatchObject(invalid("Invalid idempotency key"));
    expect(await countRows(`${table("posts")} WHERE community_id=$1`, [pub])).toBe(2);
  });

  it("replays posts by idempotency key", async () => {
    const host = await hostWorkspace("Post retry host");
    const member = await account("Post retry member"), other = await account("Post retry other");
    const pub = await communityFixture(host, { name: "Retry Circle" });
    const sibling = await communityFixture(host, { name: "Retry Sibling" });
    const frozen = await communityFixture(host, { name: "Retry Frozen", frozen: true });
    for (const community of [pub, sibling, frozen]) for (const who of [member, other]) await joinCommunity(host, community, who);
    const key = `post:${randomUUID()}`, hash = randomBytes(32);
    const args = postArgs(pub, { title: "Once", key, hash });
    const { winner, loser, blocked } = await contend([member, member], createPostCall, [args, args]);
    expect(blocked).toBe(true);
    expect([winner.outcome, loser.outcome]).toEqual(["created", "replayed"]);
    expect(loser.post_id).toBe(winner.post_id);
    expect(await countRows(`${table("posts")} WHERE community_id=$1`, [pub])).toBe(1);
    expect(await createPost(member, pub, { title: "Once", key, hash })).toEqual({ outcome: "replayed", post_id: winner.post_id });
    expect(await createPost(member, pub, { title: "Changed", key, hash: randomBytes(32) })).toEqual(refusedPost("idempotency_conflict"));
    // The same key in another community of the host workspace never replays a foreign post.
    expect(await createPost(member, sibling, { title: "Once", key, hash })).toEqual(refusedPost("idempotency_conflict"));
    // Keys are scoped to the actor.
    const theirs = await createPost(other, pub, { title: "Once", key, hash });
    expect(theirs.outcome).toBe("created");
    expect(theirs.post_id).not.toBe(winner.post_id);
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT tenant_id,operation,state,resource_id,response_status FROM ${table("idempotency_requests")} WHERE actor_user_id=$1 AND key=$2`, [member.id, key])).rows)
      .toEqual([{ tenant_id: host.workspace, operation: "community.post.create", state: "completed", resource_id: winner.post_id, response_status: 201 }]);
    // A refused create keeps no idempotency row.
    const frozenKey = `frozen:${randomUUID()}`;
    expect(await createPost(member, frozen, { key: frozenKey, hash })).toEqual(refusedPost("community_frozen"));
    expect(await countRows(`${table("idempotency_requests")} WHERE key=$1`, [frozenKey])).toBe(0);
    // Ruling R2: a replay still answers replayed with the original id after the post is gone; the API maps it to 404.
    expect(await deletePost(member, winner.post_id!)).toBe("ok");
    expect(await createPost(member, pub, { title: "Once", key, hash })).toEqual({ outcome: "replayed", post_id: winner.post_id });
  });

  it("edits own content with versions", async () => {
    const host = await hostWorkspace("Edit host");
    const author = await account("Edit author"), other = await account("Edit other"), modAuthor = await account("Edit moderator");
    const pub = await communityFixture(host, { name: "Edit Circle" });
    await joinCommunity(host, pub, author);
    await joinCommunity(host, pub, other);
    await joinCommunity(host, pub, modAuthor, "moderator");
    const post = (await createPost(author, pub)).post_id!;
    expect(await updatePost(author, post, 1, "  New title  ", null)).toEqual({ outcome: "ok", version: 2 });
    expect(await postRow(post)).toMatchObject({ title: "New title", body: "Post body", version: 2, edited: true });
    expect(await updatePost(author, post, 2, null, "  New body  ")).toEqual({ outcome: "ok", version: 3 });
    expect(await postRow(post)).toMatchObject({ title: "New title", body: "New body", version: 3 });
    expect((await postDetail(author, post)).map((row) => row.edited_at === null)).toEqual([false]);
    expect(await updatePost(other, post, 3, "Mine", null)).toEqual(refusedUpdate("not_author"));
    expect(await updatePost(author, post, 2, "Stale", null)).toEqual({ outcome: "version_mismatch", version: 3 });
    expect(await updatePost(author, randomUUID(), 1, "Nobody", null)).toEqual(refusedUpdate("not_found"));
    await expect(updatePost(author, post, 3, null, null)).rejects.toMatchObject(invalid("Invalid post patch"));
    await expect(updatePost(author, post, 3, "x".repeat(151), null)).rejects.toMatchObject(invalid("Invalid post title"));
    await expect(updatePost(author, post, 3, null, "   ")).rejects.toMatchObject(invalid("Invalid post body"));

    const comment = (await createComment(other, post)).comment_id!;
    expect(await updateComment(other, comment, 1, "  Edited  ")).toEqual({ outcome: "ok", version: 2 });
    expect(await commentRow(comment)).toMatchObject({ body: "Edited", version: 2, edited: true });
    expect(await updateComment(author, comment, 2, "Mine")).toEqual(refusedUpdate("not_author"));
    expect(await updateComment(other, comment, 1, "Stale")).toEqual({ outcome: "version_mismatch", version: 2 });
    expect(await updateComment(other, randomUUID(), 1, "Nobody")).toEqual(refusedUpdate("not_found"));
    for (const body of [null, "   ", "x".repeat(2001)]) await expect(updateComment(other, comment, 2, body)).rejects.toMatchObject(invalid("Invalid comment body"));

    await setCommunity(pub, "frozen_at=now()");
    expect(await updatePost(author, post, 3, "Frozen", null)).toEqual(refusedUpdate("community_frozen"));
    expect(await updateComment(other, comment, 2, "Frozen")).toEqual(refusedUpdate("community_frozen"));
    await setCommunity(pub, "frozen_at=NULL");

    // Hidden by moderation: a moderator author still reads it and gets content_hidden; other authors cannot read it.
    const modPost = (await createPost(modAuthor, pub)).post_id!;
    const modComment = (await createComment(modAuthor, post)).comment_id!;
    await hideContent("posts", modPost);
    await hideContent("post_comments", modComment);
    expect(await updatePost(modAuthor, modPost, 2, "Again", null)).toEqual(refusedUpdate("content_hidden"));
    expect(await updateComment(modAuthor, modComment, 2, "Again")).toEqual(refusedUpdate("content_hidden"));
    const otherPost = (await createPost(other, pub)).post_id!;
    await hideContent("posts", otherPost);
    expect(await updatePost(other, otherPost, 2, "Again", null)).toEqual(refusedUpdate("not_found"));

    // After leaving a public community the content is still readable but no longer editable.
    const leaverPost = (await createPost(other, pub)).post_id!;
    expect(await outcome(other, "ws_leave_community($1)", [pub])).toBe("ok");
    expect(await updatePost(other, leaverPost, 1, "Left", null)).toEqual(refusedUpdate("not_a_member"));
    expect(await updateComment(other, comment, 2, "Left")).toEqual(refusedUpdate("not_a_member"));
    expect(await postRow(leaverPost)).toMatchObject({ title: "A post", version: 1, edited: false });
  });

  it("deletes own content and keeps records", async () => {
    const host = await hostWorkspace("Delete host");
    const author = await account("Delete author"), other = await account("Delete other"), reporter = await account("Delete reporter");
    const pub = await communityFixture(host, { name: "Delete Circle" });
    for (const who of [author, other, reporter]) await joinCommunity(host, pub, who);
    const post = (await createPost(author, pub)).post_id!;
    const comment = (await createComment(other, post)).comment_id!;
    const own = (await createComment(author, post)).comment_id!;
    await plantReport(host, pub, reporter.id, { post });
    await owner.query(`INSERT INTO ${table("moderation_actions")} (tenant_id,community_id,post_id,actor_user_id,action,reason) VALUES ($1,$2,$3,$4,'restore','Looks fine')`,
      [host.workspace, pub, post, host.owner.id]);

    expect(await deleteComment(author, comment)).toBe("not_author");
    expect(await deleteComment(other, comment)).toBe("ok");
    expect(await deleteComment(other, comment)).toBe("ok");
    expect(await commentRow(comment)).toMatchObject({ version: 2, deleted: true });
    expect(await commentDetail(other, comment)).toEqual([]);
    expect(await deleteComment(author, comment)).toBe("not_found");

    expect(await deletePost(other, post)).toBe("not_author");
    expect(await deletePost(author, post)).toBe("ok");
    expect(await deletePost(author, post)).toBe("ok");
    expect(await postRow(post)).toMatchObject({ version: 2, deleted: true });
    expect(await feedIds(author, pub)).toEqual([]);
    expect(await postDetail(author, post)).toEqual([]);
    await expect(comments(author, post)).rejects.toMatchObject(postGone);
    expect(await commentDetail(author, own)).toEqual([]);
    expect(await deletePost(other, post)).toBe("not_found");
    expect(await deletePost(author, randomUUID())).toBe("not_found");
    expect(await countRows(`${table("content_reports")} WHERE post_id=$1`, [post])).toBe(1);
    expect(await countRows(`${table("moderation_actions")} WHERE post_id=$1`, [post])).toBe(1);

    // The author takes content back after leaving, in a frozen community and while it is hidden.
    const later = (await createPost(other, pub)).post_id!;
    const hidden = (await createPost(other, pub)).post_id!;
    const laterComment = (await createComment(other, later)).comment_id!;
    await hideContent("posts", hidden);
    expect(await outcome(other, "ws_leave_community($1)", [pub])).toBe("ok");
    await setCommunity(pub, "frozen_at=now()");
    expect(await deleteComment(other, laterComment)).toBe("ok");
    expect(await deletePost(other, later)).toBe("ok");
    expect(await deletePost(other, hidden)).toBe("ok");
    expect(await postRow(hidden)).toMatchObject({ version: 3, deleted: true });
    // An archived community answers not_found, even to the author.
    await setCommunity(pub, "frozen_at=NULL");
    const last = (await createPost(author, pub)).post_id!;
    await setCommunity(pub, "archived_at=now()");
    expect(await deletePost(author, last)).toBe("not_found");
    expect(await postRow(last)).toMatchObject({ deleted: false });
  });

  it("comments and notifies the post author", async () => {
    const host = await hostWorkspace("Comment host");
    const author = await account("Comment author"), commenter = await account("Comment writer"), moderator = await account("Comment moderator");
    const stranger = await account("Comment stranger"), gone = await account("Comment gone");
    const pub = await communityFixture(host, { name: "Comment Circle" });
    const priv = await communityFixture(host, { name: "Comment Private", visibility: "private" });
    for (const who of [author, commenter, gone]) await joinCommunity(host, pub, who);
    await joinCommunity(host, pub, moderator, "moderator");
    await joinCommunity(host, priv, author);
    const post = (await createPost(author, pub)).post_id!;
    const first = await createComment(commenter, post, { body: "  Nice post  " });
    expect(first).toEqual({ outcome: "created", comment_id: expect.any(String) });
    expect(await commentRow(first.comment_id!)).toEqual({ post_id: post, author_user_id: commenter.id, body: "Nice post", moderation_status: "visible", version: 1,
      edited: false, deleted: false });
    const notice = { tenant_id: host.workspace, recipient_user_id: author.id, kind: "post_commented", title: "Comment writer commented on your post in Comment Circle",
      body: null, resource_type: "post", outbox_tenant: host.workspace, processed: true };
    expect(await postNotices(post)).toEqual([notice]);
    expect((await commentedNotices(author)).map((row) => [row.resource_id, row.link, row.body])).toEqual([[post, postLink(pub, post), null]]);
    // The author's own comment notifies nobody.
    expect((await createComment(author, post)).outcome).toBe("created");
    expect(await postNotices(post)).toHaveLength(1);
    // Membership and readability.
    expect(await createComment(stranger, post)).toEqual(refusedComment("not_a_member"));
    const privPost = (await createPost(author, priv)).post_id!;
    expect(await createComment(stranger, privPost)).toEqual(refusedComment("not_found"));
    expect(await createComment(commenter, randomUUID())).toEqual(refusedComment("not_found"));
    for (const body of ["   ", null, "x".repeat(2001)]) await expect(createComment(commenter, post, { body })).rejects.toMatchObject(invalid("Invalid comment body"));
    expect((await createComment(commenter, post, { body: "x".repeat(2000) })).outcome).toBe("created");
    // Idempotent replay as for posts: one comment, one notification.
    const key = `comment:${randomUUID()}`, hash = randomBytes(32);
    const args = commentArgs(post, { body: "Once", key, hash });
    const { winner, loser, blocked } = await contend([commenter, commenter], createCommentCall, [args, args]);
    expect(blocked).toBe(true);
    expect([winner.outcome, loser.outcome, loser.comment_id]).toEqual(["created", "replayed", winner.comment_id]);
    expect(await createComment(commenter, post, { body: "Once", key, hash })).toEqual({ outcome: "replayed", comment_id: winner.comment_id });
    expect(await createComment(commenter, post, { body: "Twice", key, hash: randomBytes(32) })).toEqual(refusedComment("idempotency_conflict"));
    await owner.query("SET ROLE spark_owner");
    expect((await owner.query(`SELECT tenant_id,operation,state,resource_id FROM ${table("idempotency_requests")} WHERE actor_user_id=$1 AND key=$2`, [commenter.id, key])).rows)
      .toEqual([{ tenant_id: host.workspace, operation: "community.comment.create", state: "completed", resource_id: winner.comment_id }]);
    expect(await countRows(`${table("post_comments")} WHERE post_id=$1 AND body='Once'`, [post])).toBe(1);
    expect(await postNotices(post)).toEqual([notice, notice, notice]);
    // No notification for a deleted post author.
    const orphan = (await createPost(gone, pub)).post_id!;
    await owner.query(`UPDATE ${table("users")} SET status='deleted', deleted_at=now() WHERE id=$1`, [gone.id]);
    expect((await createComment(commenter, orphan)).outcome).toBe("created");
    expect(await postNotices(orphan)).toEqual([]);
    // Frozen communities refuse comments.
    await setCommunity(pub, "frozen_at=now()");
    expect(await createComment(commenter, post)).toEqual(refusedComment("community_frozen"));
    await setCommunity(pub, "frozen_at=NULL");
    // A post hidden by moderation: moderators read it and get content_hidden; members cannot read it.
    await hideContent("posts", post);
    expect(await createComment(moderator, post)).toEqual(refusedComment("content_hidden"));
    expect(await createComment(commenter, post)).toEqual(refusedComment("not_found"));
    expect(await postNotices(post)).toHaveLength(3);
  });

  it("revokes content access when membership ends", async () => {
    const host = await hostWorkspace("Revoke host");
    const author = await account("Revoke author"), commenter = await account("Revoke commenter");
    const priv = await communityFixture(host, { name: "Revoke Circle", visibility: "private" });
    await joinCommunity(host, priv, author);
    await joinCommunity(host, priv, commenter);
    const post = (await createPost(author, priv)).post_id!;
    const comment = (await createComment(commenter, post)).comment_id!;
    expect((await commentedNotices(author)).map((row) => row.link)).toEqual([postLink(priv, post)]);
    expect(await outcome(author, "ws_leave_community($1)", [priv])).toBe("ok");
    expect(await postDetail(author, post)).toEqual([]);
    await expect(comments(author, post)).rejects.toMatchObject(postGone);
    expect(await commentDetail(author, comment)).toEqual([]);
    expect((await commentedNotices(author)).map((row) => [row.resource_id, row.link, row.title])).toEqual([[post, null, "Revoke commenter commented on your post in Revoke Circle"]]);
    // A later comment still reaches the author who left, without a link; deletion still works.
    expect((await createComment(commenter, post)).outcome).toBe("created");
    expect((await commentedNotices(author)).map((row) => row.link)).toEqual([null, null]);
    expect(await deletePost(author, post)).toBe("ok");
  });

  it("shows post notifications outside the host workspace", async () => {
    const host = await hostWorkspace("Outside host");
    const author = await account("Outside author"), commenter = await account("Outside commenter");
    const pub = await communityFixture(host, { name: "Outside Circle" });
    await joinCommunity(host, pub, author);
    await joinCommunity(host, pub, commenter);
    const post = (await createPost(author, pub)).post_id!;
    expect((await createComment(commenter, post)).outcome).toBe("created");
    const inbox = await listNotices(author);
    expect(inbox).toEqual([{ id: inbox[0]!.id, tenant_id: host.workspace, workspace_slug: await slugOf(host.workspace), workspace_name: "Outside host", kind: "post_commented",
      title: "Outside commenter commented on your post in Outside Circle", body: null, resource_type: "post", resource_id: post, link: postLink(pub, post),
      created_at: inbox[0]!.created_at, read_at: null }]);
    expect(await unreadCount(author)).toBe(1);
    expect(await markOne(commenter, inbox[0]!.id)).toBe("not_found");
    expect(await markOne(author, inbox[0]!.id)).toBe("ok");
    expect(await unreadCount(author)).toBe(0);
    expect((await createComment(commenter, post)).outcome).toBe("created");
    expect(await unreadCount(author)).toBe(1);
    expect(await markAll(author, new Date(Date.now() + 60_000))).toBe(1);
    expect(await unreadCount(author)).toBe(0);
    // An archived community keeps the notification but drops its link.
    await setCommunity(pub, "archived_at=now()");
    expect((await listNotices(author)).map((row) => row.link)).toEqual([null, null]);
  });

  it("keeps the content write functions definers with an empty search_path", async () => {
    const exposed = ["ws_create_comment", "ws_create_post", "ws_delete_comment", "ws_delete_post", "ws_list_notifications", "ws_mark_notification_read",
      "ws_mark_notifications_read", "ws_unread_notification_count", "ws_update_comment", "ws_update_post"];
    await owner.query("SET ROLE spark_owner");
    const rows = (await owner.query(`SELECT p.proname, p.prosecdef, p.proconfig, has_function_privilege('spark_app',p.oid,'EXECUTE') AS runtime,
      has_function_privilege('spark_worker',p.oid,'EXECUTE') AS worker, has_function_privilege('spark_auth',p.oid,'EXECUTE') AS auth
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname = ANY($2) ORDER BY p.proname COLLATE "C"`, [namespace, exposed])).rows;
    expect(rows.map((row) => [row.proname, row.prosecdef, row.proconfig, row.runtime, row.worker, row.auth])).toEqual(exposed.map((name) => [name, true, ['search_path=""'], true, false, false]));
    const kinds = (await owner.query(`SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND c.conname='notifications_kind_allowed'`, [namespace])).rows[0].def as string;
    for (const kind of ["post_commented", "community_request_rejected", "event_cancelled", "issue_assigned"]) expect(kinds).toContain(kind);
  });
});
