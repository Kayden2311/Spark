import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, localConnection } from "../../scripts/database-support.js";
import { withDatabaseContext } from "../../src/infrastructure/database/context.js";
import { hashPassword } from "../../src/infrastructure/database/password.js";

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
const actorA = { userId: userA, tenantId: tenantA };
// Live sessions for the two workspace owners; workspace RLS is bound to these, not to spark.user_id/tenant_id.
const sessionA = randomBytes(32), sessionB = randomBytes(32);

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
    await owner.query(`INSERT INTO ${table("community_memberships")} (tenant_id,community_id,user_id) VALUES ($1,$2,$3)`, [tenantA,communityA,visitor]);
    await owner.query(`INSERT INTO ${table("posts")} (id,tenant_id,community_id,author_user_id,title,body,visibility) VALUES ($1,$2,$3,$4,'Private','Private body','members'),($5,$6,$7,$8,'Public','Public body','public')`, [privatePost,tenantA,communityA,userA,publicPost,tenantB,publicCommunity,userB]);
    await owner.query(`INSERT INTO ${table("sessions")} (user_id,token_hash,auth_method,expires_at) VALUES ($1,$2,'password',$5),($3,$4,'password',$5)`, [userA,sessionA,userB,sessionB,new Date(Date.now()+60*60*1000)]);
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
  it("migrates 65 tables with FORCE RLS and a non-login owner", async () => {
    const result = await owner.query("SELECT count(*)::integer AS count,bool_and(c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner)='spark_owner') AS secured FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r'", [namespace]);
    expect(result.rows[0]).toEqual({ count:65, secured:true });
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
    expect(result.rows[0].count).toBe(22);
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
    await withDatabaseContext(runtime,{userId:visitor,tenantId:tenantA},async client=>{
      expect((await client.query(`SELECT * FROM ${table("projects")}`)).rows).toHaveLength(0);
      expect((await client.query(`SELECT id FROM ${table("posts")} WHERE id=$1`,[privatePost])).rows).toEqual([{id:privatePost}]);
    });
    await withDatabaseContext(runtime,actorA,async client=>{
      expect((await client.query(`SELECT id FROM ${table("communities")} WHERE id=$1`,[communityB])).rows).toHaveLength(0);
      expect((await client.query(`SELECT id FROM ${table("posts")} WHERE id=$1`,[publicPost])).rows).toEqual([]);
    });
  });
  it("denies runtime writes, role escalation and sensitive table reads", async () => {
    for (const sensitive of ["password_credentials","auth_identities","sessions","account_tokens","content_reports","payment_events","promotion_orders","platform_role_assignments"]) {
      await expect(runtime.query(`SELECT * FROM ${table(sensitive)}`)).rejects.toMatchObject({code:"42501"});
    }
    // Notifications are readable since 0019, but only the recipient's own rows (none without a session).
    expect((await runtime.query(`SELECT * FROM ${table("notifications")}`)).rows).toEqual([]);
    await expect(withDatabaseContext(runtime,actorA,c=>c.query(`UPDATE ${table("workspace_memberships")} SET role='owner'`))).rejects.toMatchObject({code:"42501"});
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
    await expect(withDatabaseContext(runtime, actorA, (client) => client.query(overview))).rejects.toMatchObject({ code: "28000" });
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
    await owner.query(`INSERT INTO ${table("communities")} (id,tenant_id,slug,name,description,visibility,created_by_user_id) VALUES ($1::uuid,$2,$1::text,'Audit Circle','Description','public',$3)`, [community, tenantA, userA]);
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
    await owner.query(`INSERT INTO ${table("communities")} (id,tenant_id,slug,name,description,visibility,created_by_user_id) VALUES ($1::uuid,$2,$1::text,'Queue Circle','Description','public',$3)`, [community, tenantA, userA]);
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
      "auth_revoke_session", "auth_session_principal", "can_read_community", "can_read_post", "has_platform_role", "is_community_member",
      "is_coworker", "is_session_user", "is_workspace_member", "session_workspace_ids", "staff_active_session_count", "staff_active_user_totals", "staff_activity_series", "staff_billing_counts", "staff_billing_mrr_series",
      "staff_billing_plan_mix", "staff_billing_revenue", "staff_community_health", "staff_community_series", "staff_engagement_heatmap", "staff_grant_role",
      "staff_list_invoices", "staff_list_reports", "staff_list_subscriptions", "staff_moderate_community", "staff_open_report_counts", "staff_overview",
      "staff_report_context", "staff_report_preview", "staff_report_stats", "staff_resolve_report", "staff_retention_cohorts", "staff_review_campaign", "staff_revoke_role",
      "staff_set_user_status", "staff_top_communities", "staff_user_activity", "staff_user_risk", "staff_user_roles", "staff_user_session_count",
      "staff_user_sessions", "ws_accept_invitation", "ws_create_invitation", "ws_create_issue", "ws_create_project", "ws_create_workspace", "ws_invitation_preview",
      "ws_list_members", "ws_remove_member", "ws_resend_invitation", "ws_revoke_invitation", "ws_set_member_role", "ws_update_issue", "ws_update_project",
      "ws_update_workspace",
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
    await owner.query(`INSERT INTO ${table("communities")} (id,tenant_id,slug,name,description,visibility,created_by_user_id,frozen_at) VALUES ($1::uuid,$2,$1::text,'Frozen Circle','Description','public',$3,now())`, [community, tenantA, userA]);
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
    await owner.query(`INSERT INTO ${table("communities")} (id,tenant_id,slug,name,description,visibility,created_by_user_id) VALUES ($1::uuid,$2,$1::text,'Race Circle','Description','public',$3)`, [community, tenantA, userA]);
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
    await owner.query(`INSERT INTO ${table("communities")} (id,tenant_id,slug,name,description,visibility,created_by_user_id) VALUES ($1::uuid,$2,$1::text,'Insight Circle','Description','public',$3)`, [community, tenant, member]);
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
  it("keeps an exact inventory of workspace row policies", async () => {
    const tenantTables = ["startup_profiles","teams","team_memberships","projects","boards","issue_statuses","workflow_transitions","sprints","issues","issue_labels","issue_label_links","issue_comments","issue_links","issue_events","calendar_events","event_attendees","project_phases","project_milestones","sprint_commitments","project_methodology_periods"];
    const ownerPolicy = ["owner_maintenance", "ALL", ["spark_owner"], "PERMISSIVE"];
    const appRead = (name: string) => [name, "SELECT", ["spark_app"], "PERMISSIVE"];
    const expected: Record<string, unknown[][]> = {
      users: [ownerPolicy, appRead("self_and_coworker_read"), appRead("staff_read")],
      workspaces: [ownerPolicy, appRead("workspace_read")],
      workspace_memberships: [ownerPolicy, appRead("staff_read"), appRead("workspace_members_read")],
      workspace_invitations: [appRead("invitation_admin_read"), ownerPolicy],
      notifications: [ownerPolicy, appRead("recipient_read")],
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
    await rejects({ title: "Fine", sprintId: null }, "Invalid issue patch");
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
});
