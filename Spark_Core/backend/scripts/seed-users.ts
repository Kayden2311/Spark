import pg from "pg";
import { hashPassword } from "../src/infrastructure/database/password.js";

const connectionString =
  process.env.MIGRATION_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://spark_migrator:spark_migrate_local_only@127.0.0.1:5432/spark";

// Seeded accounts have published passwords and their role grants bypass the audited staff functions,
// so seeding is for local development only.
const seedHost = new URL(connectionString).hostname;
const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(seedHost);
if (process.env.NODE_ENV === "production" || (!loopback && process.env.SPARK_ALLOW_SEED !== "1")) {
  console.error(
    `Refusing to seed ${seedHost}: seeding creates accounts with published passwords. ` +
      "It runs only against a local database (set SPARK_ALLOW_SEED=1 to seed another non-production host).",
  );
  process.exit(1);
}
const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });

try {
  await client.connect();
  await client.query("SET ROLE spark_owner");
  console.log("Connected to PostgreSQL for seeding...");

  // Helper to ensure user exists
  async function ensureUser(opts: {
    email: string;
    displayName: string;
    password: string;
  }): Promise<string> {
    const normalizedEmail = opts.email.trim().toLowerCase();
    const existingEmail = await client.query(
      "SELECT user_id FROM spark.user_emails WHERE normalized_email = $1 LIMIT 1",
      [normalizedEmail],
    );

    let userId: string;
    const hashed = await hashPassword(opts.password);

    if (existingEmail.rows.length > 0) {
      userId = existingEmail.rows[0].user_id;
      console.log(`User ${normalizedEmail} exists (${userId}). Updating credentials...`);
      await client.query("UPDATE spark.users SET status = 'active' WHERE id = $1", [userId]);
      await client.query(
        `INSERT INTO spark.password_credentials (user_id, password_hash, password_changed_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, password_changed_at = NOW()`,
        [userId, hashed],
      );
    } else {
      const userRes = await client.query(
        `INSERT INTO spark.users (id, display_name, status, locale, timezone)
         VALUES (gen_random_uuid(), $1, 'active', 'en', 'UTC')
         RETURNING id`,
        [opts.displayName],
      );
      userId = userRes.rows[0].id;

      await client.query(
        `INSERT INTO spark.user_emails (id, user_id, email, normalized_email, is_primary, verified_at)
         VALUES (gen_random_uuid(), $1, $2, $3, true, NOW())`,
        [userId, opts.email, normalizedEmail],
      );

      await client.query(
        `INSERT INTO spark.password_credentials (user_id, password_hash, password_changed_at)
         VALUES ($1, $2, NOW())`,
        [userId, hashed],
      );
      console.log(`Created user ${normalizedEmail} (${userId})`);
    }
    return userId;
  }

  // 1. Ensure Admin User (Super Admin & Multi-role Platform Moderator)
  const adminId = await ensureUser({
    email: "admin@spark.app",
    displayName: "Spark Admin",
    password: "AdminPassword123!",
  });

  // Assign multiple platform roles to Admin
  const adminRoles = [
    "super_admin",
    "platform_admin",
    "community_moderator",
    "content_moderator",
    "campaign_moderator",
  ];

  for (const role of adminRoles) {
    await client.query(
      `INSERT INTO spark.platform_role_assignments (id, user_id, role, granted_by_user_id)
       VALUES (gen_random_uuid(), $1, $2, $1)
       ON CONFLICT DO NOTHING`,
      [adminId, role],
    );
  }

  // 2. Ensure Regular User
  const user1Id = await ensureUser({
    email: "user1@spark.app",
    displayName: "Spark User 1",
    password: "UserPassword123!",
  });

  // 3. Ensure Default Workspace and initial owner (User 1) commit together in one transaction
  let workspaceResult = await client.query(
    "SELECT id, slug, name FROM spark.workspaces WHERE slug = 'spark-lab' LIMIT 1",
  );

  let workspaceId: string;
  if (workspaceResult.rows.length === 0) {
    await client.query("BEGIN");
    try {
      const wsId = (await client.query("SELECT gen_random_uuid() AS id")).rows[0].id;
      await client.query(
        `INSERT INTO spark.workspaces (id, slug, name, status, created_by_user_id)
         VALUES ($1, 'spark-lab', 'Spark Lab', 'active', $2)`,
        [wsId, user1Id],
      );
      await client.query(
        `INSERT INTO spark.workspace_memberships (id, tenant_id, user_id, role, status, joined_at)
         VALUES (gen_random_uuid(), $1, $2, 'owner', 'active', NOW())`,
        [wsId, user1Id],
      );
      await client.query("COMMIT");
      workspaceId = wsId;
      console.log("Atomically created workspace 'spark-lab' with owner User 1:", workspaceId);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } else {
    workspaceId = workspaceResult.rows[0].id;
    console.log("Found existing workspace 'spark-lab':", workspaceId);
    await client.query(
      `INSERT INTO spark.workspace_memberships (id, tenant_id, user_id, role, status, joined_at)
       VALUES (gen_random_uuid(), $1, $2, 'owner', 'active', NOW())
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = 'owner', status = 'active'`,
      [workspaceId, user1Id],
    );
  }

  // 5. Ensure sample communities, posts, and moderation reports for Admin Console testing
  let comm1 = (await client.query("SELECT id FROM spark.communities WHERE slug = 'hyperdrive' LIMIT 1")).rows[0];
  if (!comm1) {
    await client.query("BEGIN");
    try {
      const commId = (await client.query("SELECT gen_random_uuid() AS id")).rows[0].id;
      await client.query(
        `INSERT INTO spark.communities (id, tenant_id, slug, name, description, stage, visibility, created_by_user_id)
         VALUES ($1, $2, 'hyperdrive', 'Hyperdrive Founders', 'Pre-seed to Series A peer group for technical founders building hardtech and AI systems.', 'Pre-Seed', 'public', $3)`,
        [commId, workspaceId, user1Id],
      );

      await client.query(
        `INSERT INTO spark.community_memberships (id, tenant_id, community_id, user_id, role, status)
         VALUES (gen_random_uuid(), $1, $2, $3, 'owner', 'active')`,
        [workspaceId, commId, user1Id],
      );

      // Create a sample post
      const postId = (await client.query("SELECT gen_random_uuid() AS id")).rows[0].id;
      await client.query(
        `INSERT INTO spark.posts (id, tenant_id, community_id, author_user_id, title, body, visibility, moderation_status)
         VALUES ($1, $2, $3, $4, 'Check out this external crypto trading bot investment opportunity', 'Sign up here with 50x guaranteed return on telegram @bot_spam', 'public', 'visible')`,
        [postId, workspaceId, commId, user1Id],
      );

      // Create a content report for this post
      await client.query(
        `INSERT INTO spark.content_reports (id, tenant_id, community_id, reporter_user_id, post_id, reason_code, details, status)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'Potential spam / solicitation', 'Unsolicited bot investment links in technical channel.', 'open')`,
        [workspaceId, commId, user1Id, postId],
      );

      await client.query("COMMIT");
      comm1 = { id: commId };
      console.log("Atomically created community 'hyperdrive' with post and report.");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }

  let comm2 = (await client.query("SELECT id FROM spark.communities WHERE slug = 'zero-to-one' LIMIT 1")).rows[0];
  if (!comm2) {
    await client.query("BEGIN");
    try {
      const comm2Id = (await client.query("SELECT gen_random_uuid() AS id")).rows[0].id;
      await client.query(
        `INSERT INTO spark.communities (id, tenant_id, slug, name, description, stage, visibility, created_by_user_id)
         VALUES ($1, $2, 'zero-to-one', 'Zero-to-One SaaS', 'B2B software builders scaling from first 10 customers to repeatable revenue.', 'Seed', 'public', $3)`,
        [comm2Id, workspaceId, user1Id],
      );

      await client.query(
        `INSERT INTO spark.community_memberships (id, tenant_id, community_id, user_id, role, status)
         VALUES (gen_random_uuid(), $1, $2, $3, 'owner', 'active')`,
        [workspaceId, comm2Id, user1Id],
      );

      await client.query("COMMIT");
      comm2 = { id: comm2Id };
      console.log("Atomically created community 'zero-to-one'.");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }

  // 6. A moderator without admin roles, to exercise role-gated sections of the console.
  const moderatorId = await ensureUser({
    email: "moderator@spark.app",
    displayName: "Spark Moderator",
    password: "ModeratorPassword123!",
  });
  for (const role of ["content_moderator", "community_moderator"]) {
    await client.query(
      `INSERT INTO spark.platform_role_assignments (id, user_id, role, granted_by_user_id)
       VALUES (gen_random_uuid(), $1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [moderatorId, role, adminId],
    );
  }

  // 7. Sponsored campaigns awaiting review.
  const existingCampaigns = await client.query("SELECT count(*)::integer AS total FROM spark.promotion_campaigns");
  if (existingCampaigns.rows[0].total === 0) {
    await client.query("BEGIN");
    try {
      const placement = await client.query(
        `INSERT INTO spark.promotion_placements (id, code, name, description)
         VALUES (gen_random_uuid(), 'directory-spotlight', 'Directory spotlight', 'Featured slot at the top of the community directory.')
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
      );
      const campaigns = [
        [comm1.id, "Hyperdrive demo night", "Watch six hardtech founders demo live", "A monthly demo night for technical founders, open to Spark members."],
        [comm2.id, "Zero-to-One pricing clinic", "Fix your SaaS pricing in one evening", "Hands-on pricing teardown with operators who scaled B2B revenue."],
      ];
      for (const [communityId, name, headline, description] of campaigns) {
        await client.query(
          `INSERT INTO spark.promotion_campaigns (id, tenant_id, community_id, name, headline, description, placement_id, submitted_by_user_id, review_status, requested_start_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'pending', NOW() + interval '7 days')`,
          [workspaceId, communityId, name, headline, description, placement.rows[0].id, user1Id],
        );
      }
      await client.query("COMMIT");
      console.log("Created two pending sponsored campaigns.");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }

  console.log("\n==============================================");
  console.log("SEEDED USERS & GOVERNANCE DEMO DATA SUCCESSFULLY:");
  console.log("1. Admin:     admin@spark.app / AdminPassword123! (Super Admin & Platform Governance)");
  console.log("2. Moderator: moderator@spark.app / ModeratorPassword123! (Content and community moderator)");
  console.log("3. User 1:    user1@spark.app / UserPassword123! (Owner of 'Spark Lab' and 'Hyperdrive')");
  console.log("Note: seeded role grants are written directly and do not appear in the platform audit log.");
  console.log("==============================================\n");
} catch (error) {
  console.error("Seeding failed:", error);
  process.exitCode = 1;
} finally {
  await client.end();
}
