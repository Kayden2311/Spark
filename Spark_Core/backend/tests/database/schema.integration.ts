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

beforeAll(async () => {
  await owner.connect();
  const runtimeDatabase = await runtime.query("SELECT current_database() AS name,current_user AS role");
  const ownerDatabase = await owner.query("SELECT current_database() AS name,current_user AS role");
  if (runtimeDatabase.rows[0].name !== ownerDatabase.rows[0].name || runtimeDatabase.rows[0].role !== "spark_app" || ownerDatabase.rows[0].role !== "spark_migrator") throw new Error("Tests require matching local database and dedicated migration/runtime roles");
  folder = await mkdtemp(join(tmpdir(), "spark-migration-test-"));
  await mkdir(join(folder, "meta"));
  await writeFile(join(folder, "meta", "_journal.json"), await readFile(resolve("drizzle/meta/_journal.json")));
  for (const file of (await readdir(resolve("drizzle"))).filter((name) => name.endsWith(".sql"))) {
    const sql = (await readFile(resolve("drizzle", file), "utf8")).replace(/\bspark\b/gu, namespace)
      .replaceAll(`${namespace}.user_id`, "spark.user_id").replaceAll(`${namespace}.tenant_id`, "spark.tenant_id")
      .replaceAll(`${namespace}.session_token_hash`, "spark.session_token_hash");
    await writeFile(join(folder, file), sql);
  }
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
});

afterAll(async () => {
  await runtime.end();
  await authRuntime.end();
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
  it("migrates 61 tables with FORCE RLS and a non-login owner", async () => {
    const result = await owner.query("SELECT count(*)::integer AS count,bool_and(c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner)='spark_owner') AS secured FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r'", [namespace]);
    expect(result.rows[0]).toEqual({ count:61, secured:true });
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
    expect(result.rows[0].count).toBe(15);
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
      const sql=`INSERT INTO ${table("notifications")} (tenant_id,recipient_user_id,outbox_event_id,kind,title,resource_type,resource_id) VALUES ($1,$2,$3,'test','Test','workspace',$1)`;
      const values=[tenantA,userA,event.rows[0].id];
      await owner.query(sql,values); await expect(owner.query(sql,values)).rejects.toMatchObject({code:"23505"});
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
    for (const sensitive of ["password_credentials","auth_identities","sessions","account_tokens","content_reports","notifications","payment_events","promotion_orders","platform_role_assignments"]) {
      await expect(runtime.query(`SELECT * FROM ${table(sensitive)}`)).rejects.toMatchObject({code:"42501"});
    }
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
    for (const name of ["users","user_emails","posts","post_comments","communities","platform_role_assignments","sessions","content_reports","moderation_actions","promotion_campaigns","promotion_reviews","password_credentials","workspaces","workspace_memberships"]) {
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
      "is_coworker", "is_workspace_member", "session_workspace_ids", "staff_active_session_count", "staff_active_user_totals", "staff_activity_series", "staff_billing_counts", "staff_billing_mrr_series",
      "staff_billing_plan_mix", "staff_billing_revenue", "staff_community_health", "staff_community_series", "staff_engagement_heatmap", "staff_grant_role",
      "staff_list_invoices", "staff_list_reports", "staff_list_subscriptions", "staff_moderate_community", "staff_open_report_counts", "staff_overview",
      "staff_report_context", "staff_report_preview", "staff_report_stats", "staff_resolve_report", "staff_retention_cohorts", "staff_review_campaign", "staff_revoke_role",
      "staff_set_user_status", "staff_top_communities", "staff_user_activity", "staff_user_risk", "staff_user_roles", "staff_user_session_count",
      "staff_user_sessions",
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
});
