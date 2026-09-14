import { randomUUID } from "node:crypto";
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
let folder: string;
const userA = randomUUID(), userB = randomUUID(), visitor = randomUUID();
const tenantA = randomUUID(), tenantB = randomUUID(), projectA = randomUUID(), projectB = randomUUID(), projectOther = randomUUID();
const statusA = randomUUID(), statusB = randomUUID(), statusOther = randomUUID();
const communityA = randomUUID(), communityB = randomUUID(), publicCommunity = randomUUID(), publicPost = randomUUID(), privatePost = randomUUID();
const table = (name: string) => `"${namespace}"."${name}"`;
const actorA = { userId: userA, tenantId: tenantA };
const actorB = { userId: userB, tenantId: tenantB };

async function rollback(work: () => Promise<void>) {
  await owner.query("BEGIN");
  try { await work(); } finally { await owner.query("ROLLBACK"); }
}
async function reject(sql: string, values: unknown[], code: string) {
  await rollback(async () => { await expect(owner.query(sql, values)).rejects.toMatchObject({ code }); });
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
      .replaceAll(`${namespace}.user_id`, "spark.user_id").replaceAll(`${namespace}.tenant_id`, "spark.tenant_id");
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
    await owner.query("COMMIT");
  } catch (error) { await owner.query("ROLLBACK"); throw error; }
});

afterAll(async () => {
  await runtime.end();
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
  it("migrates 60 tables with FORCE RLS and a non-login owner", async () => {
    const result = await owner.query("SELECT count(*)::integer AS count,bool_and(c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner)='spark_owner') AS secured FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r'", [namespace]);
    expect(result.rows[0]).toEqual({ count:60, secured:true });
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
    expect(result.rows[0].count).toBe(5);
    const file = join(folder,"0001_integrity.sql"), original = await readFile(file,"utf8");
    try {
      await writeFile(file,original+"\n-- changed\n");
      await expect(applyMigrations(owner,folder,namespace,journal)).rejects.toThrow("Migration history differs");
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
    const first = await withDatabaseContext(runtime,actorA,client=>client.query(`SELECT id FROM ${table("projects")} ORDER BY id`));
    expect(first.rows.map(row=>row.id).sort()).toEqual([projectA,projectOther].sort());
    const second = await withDatabaseContext(runtime,actorB,client=>client.query(`SELECT id FROM ${table("projects")}`));
    expect(second.rows).toEqual([{id:projectB}]);
    expect((await runtime.query(`SELECT * FROM ${table("projects")}`)).rows).toEqual([]);
    await expect(withDatabaseContext(runtime,actorA,async client=>{ await client.query("SELECT 1/0"); })).rejects.toMatchObject({code:"22012"});
    expect((await runtime.query(`SELECT * FROM ${table("projects")}`)).rows).toEqual([]);
    const spoofed = await withDatabaseContext(runtime,{userId:userA,tenantId:tenantB},client=>client.query(`SELECT * FROM ${table("projects")}`));
    expect(spoofed.rows).toEqual([]);
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
});
