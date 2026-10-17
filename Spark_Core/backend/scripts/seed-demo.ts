import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

import { localConnection } from "./database-support.js";

/**
 * Demo data for the admin console: ~240 members over 180 days, communities, content, reports,
 * campaigns, subscriptions, invoices and staff history. Structure is deterministic (seeded PRNG);
 * timestamps are relative to "now" so charts always show recent activity.
 *
 * Local development only. It runs once per database (audit rows are append-only); to start over run
 * `pnpm db:reset:local --yes`, then `pnpm db:migrate`, `pnpm db:seed` and `pnpm db:seed:demo`.
 */

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed demo data: NODE_ENV is production.");
  process.exit(1);
}
// Demo data is never allowed on a shared database: the guard throws unless the URL is local
// and has no connection-parameter overrides. There is deliberately no opt-out.
const connectionString = localConnection("MIGRATION_DATABASE_URL");

const MARKER_SLUG = "demo-insights-marker";
const DAY = 86_400_000;
const NOW = Date.now();

// ---------- deterministic randomness ----------
let state = 0x5eed2026;
function random(): number {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (min: number, max: number) => Math.floor(random() * (max - min + 1)) + min;
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const chance = (p: number) => random() < p;
function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/** A moment on the given day, weighted to working hours (UTC) with a quieter evening tail. */
function momentOn(dayStart: number): number {
  const roll = random();
  const hour = roll < 0.72 ? int(8, 18) : roll < 0.93 ? int(19, 23) : int(0, 7);
  return dayStart + hour * 3_600_000 + int(0, 59) * 60_000 + int(0, 59) * 1000;
}

/** A random active moment between two instants, favouring weekdays. */
function momentBetween(from: number, to: number): number {
  if (to - from < 60_000) return Math.min(from, to);
  for (let attempt = 0; attempt < 8; attempt++) {
    const dayStart = Math.floor((from + random() * (to - from)) / DAY) * DAY;
    const weekday = new Date(dayStart).getUTCDay();
    if ((weekday === 0 || weekday === 6) && chance(0.6)) continue;
    const moment = momentOn(dayStart);
    if (moment >= from && moment <= to) return moment;
    // Today (or the first day) is partial: pick any moment in the part of the day that is in range.
    const start = Math.max(dayStart, from);
    if (moment > to && start < to) return start + random() * (to - start);
  }
  return from + random() * (to - from);
}

const iso = (ms: number) => new Date(Math.min(ms, NOW - 60_000)).toISOString();

// ---------- names and catalogue ----------
const FIRST = ["Minh", "Anh", "Linh", "Huy", "Thao", "Quang", "Duc", "Mai", "Khoa", "Trang", "Bao", "Nam", "Vy", "Long", "Hoa", "Tuan", "Ngoc", "Phuc", "Lan", "Son", "Alex", "Sam", "Priya", "Daniel", "Chloe", "Marcus", "Aisha", "Leo", "Nora", "Ethan", "Sofia", "Kenji", "Isla", "Omar", "Maya", "Lucas"];
const LAST = ["Nguyen", "Tran", "Le", "Pham", "Hoang", "Vo", "Dang", "Bui", "Do", "Ngo", "Duong", "Ly", "Carter", "Patel", "Kim", "Silva", "Novak", "Rossi", "Okafor", "Lindqvist"];
const COMMUNITIES = [
  ["northstar-founders", "Northstar Founders", "B2B founders selling software across Southeast Asia.", "Seed", 1.0],
  ["climate-builders", "Climate Builders", "Operators turning climate problems into practical products.", "Pre-Seed", 0.55],
  ["product-practice", "Product Practice", "Product leaders sharpening discovery and delivery.", "Any", 0.85],
  ["ai-applied", "AI Applied Engineers", "Engineers shipping agentic workflows and LLM products.", "Pre-Seed", 0.95],
  ["fintech-hub", "FinTech Builders Hub", "Founders and compliance leads in payments and lending.", "Series A", 0.5],
  ["first-time-founders", "First-time Founders Circle", "Peer support from idea to first raise.", "Idea", 0.75],
  ["design-systems", "Design Systems Guild", "Designers and engineers building shared UI foundations.", "Any", 0.45],
  ["growth-loops", "Growth Loops", "Growth leads comparing acquisition and retention experiments.", "Seed", 0.6],
  ["devtools-makers", "DevTools Makers", "Builders of developer tools and infrastructure.", "Seed", 0.5],
  ["health-innovators", "Health Innovators", "Founders working across digital health.", "Pre-Seed", 0.3],
  ["edtech-lab", "EdTech Lab", "Educators and founders building learning products.", "Idea", 0.35],
  ["remote-ops", "Remote Ops Collective", "Operations leads running distributed teams.", "Any", 0.4],
  ["web3-skeptics", "Web3 Skeptics", "Pragmatic builders testing what actually works on-chain.", "Idea", 0.2],
  ["hardware-hackers", "Hardware Hackers", "Founders shipping physical products.", "Seed", 0.25],
] as const;
const TOPICS = ["pricing", "hiring", "fundraising", "onboarding", "churn", "roadmaps", "sales", "analytics", "community", "launch", "infra", "design"];
const TITLES = [
  "How we priced our first enterprise deal", "Lessons from our first ten customer interviews", "What finally fixed our onboarding drop-off",
  "Hiring the first engineer: what we got wrong", "Our seed deck, annotated", "Weekly metrics review template", "Churn post-mortem from last quarter",
  "Is usage-based pricing worth the complexity?", "Shipping a beta in six weeks", "Tools we replaced this year", "Running async standups that work",
  "Choosing between two pilot customers", "From side project to first revenue", "Postgres vs managed services at our stage",
];
const REPLIES = ["This matches what we saw.", "Great breakdown, thanks for sharing.", "How long did that take to roll out?", "We tried this and churn dropped.", "Would love the template.", "Counterpoint: it depends on ACV.", "Saving this for our next planning cycle.", "What tooling did you use?"];
const SPAM = ["Guaranteed 50x returns, DM me on telegram", "Buy followers cheap, link in bio", "Click here for free crypto airdrop"];

async function main() {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query("SET ROLE spark_owner");
    if ((await client.query("SELECT 1 FROM spark.workspaces WHERE slug = $1", [MARKER_SLUG])).rowCount) {
      console.log("Demo data is already present; nothing to do. To start over: pnpm db:reset:local --yes, then db:migrate, db:seed and db:seed:demo.");
      return;
    }
    const admin = (await client.query<{ user_id: string }>("SELECT user_id FROM spark.user_emails WHERE normalized_email = 'admin@spark.app'")).rows[0]?.user_id;
    const moderator = (await client.query<{ user_id: string }>("SELECT user_id FROM spark.user_emails WHERE normalized_email = 'moderator@spark.app'")).rows[0]?.user_id;
    if (!admin || !moderator) throw new Error("Run `pnpm --filter @spark/backend db:seed` first: the demo builds on the seeded staff accounts.");

    await client.query("BEGIN");

    // ---------- users and their workspaces ----------
    type Member = { id: string; name: string; email: string; createdAt: number; workspace: string; engagement: number; churnAt: number | null };
    const members: Member[] = [];
    const usedEmails = new Set<string>();
    for (let i = 0; i < 240; i++) {
      // Growth curve: more recent sign-ups than old ones.
      const ageDays = Math.floor(180 * Math.pow(random(), 1.2));
      // Never in the future: a sign-up "today" happens at least a few hours before the seed runs.
      const createdAt = Math.min(momentOn(Math.floor((NOW - ageDays * DAY) / DAY) * DAY), NOW - int(3, 9) * 3_600_000);
      const first = pick(FIRST), last = pick(LAST);
      let email = `${first}.${last}`.toLowerCase();
      while (usedEmails.has(email)) email = `${first}.${last}${int(2, 99)}`.toLowerCase();
      usedEmails.add(email);
      const engagement = pick([0.15, 0.3, 0.3, 0.55, 0.55, 0.8, 1.0]);
      members.push({ id: "", name: `${first} ${last}`, email: `${email}@demo.spark.app`, createdAt, workspace: "", engagement, churnAt: chance(0.18) ? createdAt + int(10, 60) * DAY : null });
    }
    members.sort((a, b) => a.createdAt - b.createdAt);
    const userRows = await client.query<{ id: string }>(
      `INSERT INTO spark.users (display_name, status, locale, timezone, created_at, last_login_at)
       SELECT n, 'active', 'en', 'UTC', c, NULL FROM unnest($1::text[], $2::timestamptz[]) AS t(n, c) RETURNING id`,
      [members.map((m) => m.name), members.map((m) => iso(m.createdAt))],
    );
    userRows.rows.forEach((row, index) => { members[index]!.id = row.id; });
    await client.query(
      `INSERT INTO spark.user_emails (user_id, email, normalized_email, is_primary, verified_at, created_at)
       SELECT u, e, lower(e), true, CASE WHEN v THEN c END, c FROM unnest($1::uuid[], $2::text[], $3::boolean[], $4::timestamptz[]) AS t(u, e, v, c)`,
      [members.map((m) => m.id), members.map((m) => m.email), members.map(() => chance(0.8)), members.map((m) => iso(m.createdAt))],
    );
    const workspaceRows = await client.query<{ id: string }>(
      `INSERT INTO spark.workspaces (slug, name, status, created_by_user_id, created_at)
       SELECT 'demo-' || left(replace(u::text, '-', ''), 12), n || '''s Space', 'active', u, c FROM unnest($1::uuid[], $2::text[], $3::timestamptz[]) AS t(u, n, c) RETURNING id`,
      [members.map((m) => m.id), members.map((m) => m.name), members.map((m) => iso(m.createdAt))],
    );
    workspaceRows.rows.forEach((row, index) => { members[index]!.workspace = row.id; });
    await client.query(
      `INSERT INTO spark.workspace_memberships (tenant_id, user_id, role, status, joined_at, created_at)
       SELECT w, u, 'owner', 'active', c, c FROM unnest($1::uuid[], $2::uuid[], $3::timestamptz[]) AS t(w, u, c)`,
      [members.map((m) => m.workspace), members.map((m) => m.id), members.map((m) => iso(m.createdAt))],
    );

    // ---------- sign-in history ----------
    const sessions: { user: string; at: number; expires: number; revoked: number | null }[] = [];
    const lastLogin = new Map<string, number>();
    for (const member of members) {
      const until = member.churnAt ?? NOW;
      const spanDays = Math.max(1, (until - member.createdAt) / DAY);
      const total = Math.max(1, Math.round(spanDays * member.engagement * 0.45));
      sessions.push({ user: member.id, at: member.createdAt, expires: member.createdAt + 7 * DAY, revoked: null });
      for (let i = 0; i < total; i++) {
        const at = momentBetween(member.createdAt, Math.min(until, NOW - 60_000));
        sessions.push({ user: member.id, at, expires: at + 7 * DAY, revoked: chance(0.35) ? at + int(1, 48) * 3_600_000 : null });
      }
    }
    for (const session of sessions) lastLogin.set(session.user, Math.max(lastLogin.get(session.user) ?? 0, session.at));
    await client.query(
      `INSERT INTO spark.sessions (user_id, token_hash, auth_method, created_at, last_seen_at, expires_at, revoked_at)
       SELECT u, h, 'password', c, c + interval '20 minutes', e, r FROM unnest($1::uuid[], $2::bytea[], $3::timestamptz[], $4::timestamptz[], $5::timestamptz[]) AS t(u, h, c, e, r)`,
      [sessions.map((s) => s.user), sessions.map(() => randomBytes(32)), sessions.map((s) => iso(s.at)), sessions.map((s) => new Date(s.expires).toISOString()),
        sessions.map((s) => (s.revoked && s.revoked < NOW ? new Date(s.revoked).toISOString() : null))],
    );
    await client.query(
      "UPDATE spark.users u SET last_login_at = t.l FROM unnest($1::uuid[], $2::timestamptz[]) AS t(id, l) WHERE u.id = t.id",
      [[...lastLogin.keys()], [...lastLogin.values()].map((ms) => iso(ms))],
    );

    // ---------- communities and memberships ----------
    type Community = { id: string; tenant: string; owner: Member; createdAt: number; popularity: number; members: { member: Member; joined: number }[] };
    const communities: Community[] = [];
    const founders = shuffle(members.filter((m) => m.createdAt < NOW - 120 * DAY && !m.churnAt));
    for (const [index, [slug, name, description, stage, popularity]] of COMMUNITIES.entries()) {
      const owner = founders[index % founders.length]!;
      const createdAt = Math.max(owner.createdAt + DAY, NOW - int(110, 175) * DAY);
      const row = await client.query<{ id: string }>(
        `INSERT INTO spark.communities (tenant_id, slug, name, description, stage, visibility, created_by_user_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [owner.workspace, `demo-${slug}`, name, description, stage, index % 5 === 4 ? "private" : "public", owner.id, iso(createdAt)],
      );
      communities.push({ id: row.rows[0]!.id, tenant: owner.workspace, owner, createdAt, popularity, members: [{ member: owner, joined: createdAt }] });
    }
    const membershipRows: { tenant: string; community: string; user: string; role: string; joined: number }[] = [];
    for (const community of communities) {
      membershipRows.push({ tenant: community.tenant, community: community.id, user: community.owner.id, role: "owner", joined: community.createdAt });
      for (const member of members) {
        if (member.id === community.owner.id || !chance(0.16 + community.popularity * 0.5 * (0.4 + member.engagement))) continue;
        const from = Math.max(member.createdAt, community.createdAt);
        // Members who left before the community existed never join it.
        if (member.churnAt && member.churnAt <= from) continue;
        // Most members join a community within their first weeks, not uniformly over their lifetime.
        const joined = Math.max(from, Math.min(from + int(0, 21) * DAY + int(1, 23) * 3_600_000, member.churnAt ?? NOW, NOW - 3_600_000));
        community.members.push({ member, joined });
        membershipRows.push({ tenant: community.tenant, community: community.id, user: member.id, role: chance(0.04) ? "moderator" : "member", joined });
      }
    }
    await client.query(
      `INSERT INTO spark.community_memberships (tenant_id, community_id, user_id, role, status, joined_at, created_at)
       SELECT t, c, u, r, 'active', j, j FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::timestamptz[]) AS x(t, c, u, r, j)`,
      [membershipRows.map((m) => m.tenant), membershipRows.map((m) => m.community), membershipRows.map((m) => m.user), membershipRows.map((m) => m.role), membershipRows.map((m) => iso(m.joined))],
    );

    // ---------- posts and comments ----------
    type Post = { id: string; community: Community; author: Member; at: number };
    const postDrafts: { community: Community; author: Member; at: number; title: string; body: string; spam: boolean }[] = [];
    for (const community of communities) {
      for (const { member, joined } of community.members) {
        // Posts scale with how long the member has been in the community, so new members do not flood a single day.
        const activeDays = Math.max(0, (Math.min(member.churnAt ?? NOW, NOW) - joined) / DAY);
        const count = Math.round(member.engagement * community.popularity * int(0, 12) * Math.min(1, activeDays / 120));
        for (let i = 0; i < count; i++) {
          const spam = chance(0.012);
          postDrafts.push({
            community, author: member, at: momentBetween(joined, Math.min(member.churnAt ?? NOW, NOW - 60_000)), spam,
            title: spam ? pick(SPAM) : pick(TITLES),
            body: spam ? `${pick(SPAM)}. Limited spots!` : `Sharing notes on ${pick(TOPICS)} and ${pick(TOPICS)}. What has worked for your team?`,
          });
        }
      }
    }
    const postRows = await client.query<{ id: string }>(
      `INSERT INTO spark.posts (tenant_id, community_id, author_user_id, title, body, visibility, created_at)
       SELECT t, c, a, ti, b, v, at FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::timestamptz[]) AS x(t, c, a, ti, b, v, at) RETURNING id`,
      [postDrafts.map((p) => p.community.tenant), postDrafts.map((p) => p.community.id), postDrafts.map((p) => p.author.id), postDrafts.map((p) => p.title),
        postDrafts.map((p) => p.body), postDrafts.map(() => (chance(0.3) ? "public" : "members")), postDrafts.map((p) => iso(p.at))],
    );
    const posts: Post[] = postRows.rows.map((row, index) => ({ id: row.id, community: postDrafts[index]!.community, author: postDrafts[index]!.author, at: postDrafts[index]!.at }));
    const spamPosts = posts.filter((_, index) => postDrafts[index]!.spam);

    const commentDrafts: { post: Post; author: Member; at: number; body: string }[] = [];
    for (const post of posts) {
      const replies = Math.round(post.community.popularity * int(1, 6));
      for (let i = 0; i < replies; i++) {
        const { member, joined } = pick(post.community.members);
        const from = Math.max(post.at, joined);
        const until = Math.min(member.churnAt ?? NOW, NOW - 60_000, post.at + 14 * DAY);
        if (until <= from) continue;
        commentDrafts.push({ post, author: member, at: momentBetween(from, until), body: pick(REPLIES) });
      }
    }
    const commentRows = await client.query<{ id: string }>(
      `INSERT INTO spark.post_comments (tenant_id, community_id, post_id, author_user_id, body, created_at)
       SELECT t, c, p, a, b, at FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::text[], $6::timestamptz[]) AS x(t, c, p, a, b, at) RETURNING id`,
      [commentDrafts.map((c) => c.post.community.tenant), commentDrafts.map((c) => c.post.community.id), commentDrafts.map((c) => c.post.id), commentDrafts.map((c) => c.author.id),
        commentDrafts.map((c) => c.body), commentDrafts.map((c) => iso(c.at))],
    );
    const comments = commentRows.rows.map((row, index) => ({ id: row.id, ...commentDrafts[index]! }));

    // ---------- reports (some repeat offenders) and staff decisions ----------
    const audit: { actor: string; action: string; type: string; target: string; label: string; reason: string; metadata: object; at: number }[] = [];
    const repeatOffenders = new Set(shuffle([...new Set(posts.map((p) => p.author.id))]).slice(0, 3));
    const reportable = shuffle([
      ...spamPosts.map((post) => ({ kind: "post" as const, id: post.id, community: post.community, at: post.at, author: post.author.id })),
      ...posts.filter((p) => repeatOffenders.has(p.author.id)).slice(0, 12).map((post) => ({ kind: "post" as const, id: post.id, community: post.community, at: post.at, author: post.author.id })),
      ...shuffle(comments.slice()).slice(0, 30).map((comment) => ({ kind: "comment" as const, id: comment.id, community: comment.post.community, at: comment.at, author: comment.author.id })),
    ]).slice(0, 48);
    const reasons = ["spam", "harassment", "off_topic", "misinformation", "self_promotion"];
    const statuses = ["open", "open", "open", "reviewing", "resolved", "resolved", "resolved", "dismissed", "dismissed"];
    const hidePosts: string[] = [], hideComments: string[] = [];
    const reportRows: unknown[][] = [];
    const usedPairs = new Set<string>();
    for (const target of reportable) {
      const reporter = pick(target.community.members).member;
      if (reporter.id === target.author || usedPairs.has(`${reporter.id}:${target.id}`)) continue;
      usedPairs.add(`${reporter.id}:${target.id}`);
      const reportId = randomUUID();
      const communityLabel = COMMUNITIES[communities.indexOf(target.community)]![1];
      const createdAt = Math.min(NOW - 60_000, target.at + int(1, 72) * 3_600_000);
      // Only reports old enough to have been handled get a decision, a few hours to a few days later.
      const hoursOpen = (NOW - createdAt) / 3_600_000;
      const picked = repeatOffenders.has(target.author) && chance(0.5) ? "resolved" : pick(statuses);
      const status = hoursOpen < 3 && (picked === "resolved" || picked === "dismissed") ? "open" : picked;
      const resolvedAt = status === "resolved" || status === "dismissed" ? createdAt + int(1, Math.max(1, Math.min(60, Math.floor(hoursOpen) - 1))) * 3_600_000 + int(0, 59) * 60_000 : null;
      const reason = target.kind === "post" && spamPosts.some((p) => p.id === target.id) ? "spam" : pick(reasons);
      reportRows.push([reportId, target.community.tenant, target.community.id, reporter.id, target.kind === "post" ? target.id : null, target.kind === "comment" ? target.id : null, reason, chance(0.5) ? "Flagged while browsing the community feed." : null, status, iso(createdAt), resolvedAt ? iso(resolvedAt) : null]);
      if (resolvedAt) {
        const decision = status === "resolved" ? (chance(0.8) ? "hide" : "restore") : "dismiss";
        if (decision === "hide") (target.kind === "post" ? hidePosts : hideComments).push(target.id);
        audit.push({ actor: chance(0.6) ? moderator : admin, action: `report.${decision}`, type: "report", target: reportId, label: `Report in ${communityLabel}`, reason: decision === "hide" ? "Violates the community guidelines on spam and promotion." : decision === "restore" ? "Reviewed: within guidelines, keeping it visible." : "Not a policy violation.", metadata: { reasonCode: reason, targetKind: target.kind }, at: resolvedAt });
      }
    }
    const reportIds = await client.query<{ id: string }>(
      `INSERT INTO spark.content_reports (id, tenant_id, community_id, reporter_user_id, post_id, comment_id, reason_code, details, status, created_at, resolved_at)
       SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[], $6::uuid[], $7::text[], $8::text[], $9::text[], $10::timestamptz[], $11::timestamptz[])
       RETURNING id`,
      Array.from({ length: 11 }, (_, column) => reportRows.map((row) => row[column])),
    );
    if (hidePosts.length) await client.query("UPDATE spark.posts SET moderation_status = 'hidden', version = version + 1 WHERE id = ANY($1::uuid[])", [hidePosts]);
    if (hideComments.length) await client.query("UPDATE spark.post_comments SET moderation_status = 'hidden', version = version + 1 WHERE id = ANY($1::uuid[])", [hideComments]);

    // ---------- community states (after content, so the posting trigger allows the history) ----------
    const byPopularity = [...communities].sort((a, b) => b.popularity - a.popularity);
    const stateChanges: [Community, "feature" | "freeze" | "archive", string][] = [
      [byPopularity[0]!, "feature", "Consistently high-quality discussion and fast-growing membership."],
      [byPopularity[1]!, "feature", "Strong weekly engagement; good fit for the directory spotlight."],
      [byPopularity[byPopularity.length - 2]!, "freeze", "Spike in spam reports; pausing new posts while owners clean up."],
      [byPopularity[byPopularity.length - 1]!, "archive", "Inactive for months and the owner asked to wind it down."],
    ];
    for (const [community, action, reason] of stateChanges) {
      const column = action === "feature" ? "featured_at" : action === "freeze" ? "frozen_at" : "archived_at";
      const at = NOW - int(2, 20) * DAY - int(0, 10) * 3_600_000 - int(0, 59) * 60_000;
      await client.query(`UPDATE spark.communities SET ${column} = $2 WHERE id = $1`, [community.id, iso(at)]);
      audit.push({ actor: chance(0.5) ? moderator : admin, action: `community.${action}`, type: "community", target: community.id, label: COMMUNITIES[communities.indexOf(community)]![1], reason, metadata: { previousState: "active" }, at });
    }

    // ---------- account actions ----------
    const suspended = shuffle(members.filter((m) => repeatOffenders.has(m.id))).slice(0, 2);
    for (const member of suspended) {
      const at = NOW - int(1, 15) * DAY - int(0, 10) * 3_600_000 - int(0, 59) * 60_000;
      await client.query("UPDATE spark.users SET status = 'suspended' WHERE id = $1", [member.id]);
      await client.query("UPDATE spark.sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL", [member.id, iso(at)]);
      audit.push({ actor: admin, action: "user.suspend", type: "user", target: member.id, label: member.name, reason: "Repeated spam after two warnings.", metadata: { previousStatus: "active" }, at });
    }
    const newStaff = shuffle(members.filter((m) => m.engagement >= 0.8 && !m.churnAt && !repeatOffenders.has(m.id))).slice(0, 2);
    for (const [index, member] of newStaff.entries()) {
      const role = index === 0 ? "community_moderator" : "campaign_moderator";
      const at = NOW - int(5, 40) * DAY - int(0, 10) * 3_600_000 - int(0, 59) * 60_000;
      await client.query("INSERT INTO spark.platform_role_assignments (user_id, role, granted_by_user_id, created_at) VALUES ($1, $2, $3, $4)", [member.id, role, admin, iso(at)]);
      audit.push({ actor: admin, action: "role.grant", type: "user", target: member.id, label: member.name, reason: "Joining the moderation rota for their region.", metadata: { role }, at });
    }

    // ---------- campaigns ----------
    let placement = (await client.query<{ id: string }>("SELECT id FROM spark.promotion_placements WHERE code = 'directory-spotlight'")).rows[0]?.id;
    if (!placement) {
      placement = (await client.query<{ id: string }>("INSERT INTO spark.promotion_placements (code, name, description) VALUES ('directory-spotlight', 'Directory spotlight', 'Featured slot at the top of the community directory.') RETURNING id")).rows[0]!.id;
    }
    const campaignPlan: [string, string, "draft" | "pending" | "approved" | "rejected"][] = [
      ["Founder AMA week", "Ask anything: five founders, five days", "pending"],
      ["Pricing teardown live", "Bring your pricing page, leave with fixes", "pending"],
      ["Climate demo day", "Twelve climate startups demo live", "pending"],
      ["AI agents workshop", "Build and evaluate an agent in one afternoon", "approved"],
      ["Design systems clinic", "Audit your component library with experts", "approved"],
      ["Crypto riches webinar", "Learn to 50x your savings", "rejected"],
      ["Growth loops sprint", "Ship three experiments in two weeks", "rejected"],
      ["Hiring roundtable", "How seed startups hire their first five", "draft"],
    ];
    for (const [index, [name, headline, status]] of campaignPlan.entries()) {
      const community = byPopularity[index % 6]!;
      const created = NOW - int(2, 45) * DAY - int(0, 12) * 3_600_000;
      const version = status === "approved" || status === "rejected" ? 2 : 1;
      const campaign = (await client.query<{ id: string }>(
        `INSERT INTO spark.promotion_campaigns (tenant_id, community_id, name, headline, description, placement_id, submitted_by_user_id, review_status, requested_start_at, version, approved_version, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [community.tenant, community.id, name, headline, `${headline}. Hosted by ${COMMUNITIES[communities.indexOf(community)]![1]}.`, placement, community.owner.id, status,
          new Date(NOW + int(5, 30) * DAY).toISOString(), version, status === "approved" ? 2 : null, iso(created)],
      )).rows[0]!.id;
      if (status === "approved" || status === "rejected") {
        const decided = Math.min(created + int(1, 4) * DAY + int(0, 8) * 3_600_000, NOW - 3_600_000);
        const decision = status === "approved" ? "approve" : "reject";
        const reason = decision === "approve" ? "Clear value for members and fits the placement policy." : name.startsWith("Crypto") ? "Financial claims we cannot verify." : "Overlaps with an approved campaign this month.";
        await client.query(
          "INSERT INTO spark.promotion_reviews (tenant_id, campaign_id, campaign_version, reviewer_user_id, decision, reason, created_at) VALUES ($1, $2, 2, $3, $4, $5, $6)",
          [community.tenant, campaign, admin, decision, reason, iso(decided)],
        );
        audit.push({ actor: admin, action: `campaign.${decision}`, type: "campaign", target: campaign, label: name, reason, metadata: { version: 2 }, at: decided });
      }
    }

    // ---------- plans, prices, subscriptions, invoices ----------
    const planDefs = [["free", "Free", "free", 0, 0], ["starter", "Starter", "paid", 1900, 19000], ["pro", "Pro", "paid", 4900, 49000], ["business", "Business", "paid", 14900, 149000]] as const;
    const plans = new Map<string, { id: string; month?: string; year?: string; monthAmount: number; yearAmount: number }>();
    for (const [code, name, kind, monthAmount, yearAmount] of planDefs) {
      const plan = (await client.query<{ id: string }>(
        `INSERT INTO spark.subscription_plans (code, name, description, billing_kind) VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [`demo_${code}`, name, `${name} plan`, kind],
      )).rows[0]!.id;
      const entry: { id: string; month?: string; year?: string; monthAmount: number; yearAmount: number } = { id: plan, monthAmount, yearAmount };
      if (kind === "paid") {
        for (const [interval, amount] of [["month", monthAmount], ["year", yearAmount]] as const) {
          const price = (await client.query<{ id: string }>(
            `INSERT INTO spark.plan_prices (plan_id, currency, amount_minor, billing_interval, provider, provider_price_id) VALUES ($1, 'USD', $2, $3, 'demo', $4)
             ON CONFLICT (provider, provider_price_id) DO UPDATE SET is_active = true RETURNING id`,
            [plan, amount, interval, `demo_${code}_${interval}`],
          )).rows[0]!.id;
          entry[interval] = price;
        }
      }
      plans.set(code, entry);
    }

    const subs: unknown[][] = [];
    const invoices: unknown[][] = [];
    const failures: unknown[][] = [];
    const customers: unknown[][] = [];
    for (const member of members) {
      const free = plans.get("free")!;
      const goesPaid = member.engagement >= 0.55 && chance(0.42);
      if (!goesPaid) {
        subs.push([member.workspace, null, free.id, null, null, null, "free", "active", null, null, null, false, null, iso(member.createdAt)]);
        continue;
      }
      const code = pick(["starter", "starter", "pro", "pro", "pro", "business"]);
      const plan = plans.get(code)!;
      const yearly = chance(0.2);
      const customer = `demo_cus_${member.workspace.slice(0, 8)}`;
      customers.push([member.workspace, "demo", customer]);
      const start = member.createdAt + int(1, 20) * DAY;
      if (start > NOW - DAY) {
        subs.push([member.workspace, null, free.id, null, null, null, "free", "active", null, null, null, false, null, iso(member.createdAt)]);
        customers.pop();
        continue;
      }
      const trialEnds = start + 14 * DAY;
      const churnEnd = member.churnAt ? member.churnAt + int(5, 30) * DAY : 0;
      const cancelled = member.churnAt && member.churnAt > trialEnds ? (churnEnd < NOW - DAY ? churnEnd : Math.max(trialEnds, NOW - int(1, 25) * DAY)) : chance(0.06) && trialEnds < NOW - 30 * DAY ? NOW - int(1, 25) * DAY : null;
      const status = cancelled ? "cancelled" : trialEnds > NOW ? "trialing" : chance(0.07) ? "past_due" : "active";
      const amount = yearly ? plan.yearAmount : plan.monthAmount;
      const step = yearly ? 365 * DAY : 30 * DAY;
      let periodStart = trialEnds;
      while (periodStart + step < NOW) periodStart += step;
      subs.push([member.workspace, `@customer:${member.workspace}`, plan.id, yearly ? plan.year : plan.month, "demo", `demo_sub_${member.workspace.slice(0, 12)}`, "paid", status,
        // A trial's current period is the trial itself; future dates (trial end, renewal) are not clamped to now.
        new Date(status === "trialing" ? start : Math.min(periodStart, NOW - 60_000)).toISOString(),
        new Date(status === "trialing" ? trialEnds : Math.min(periodStart, NOW - 60_000) + step).toISOString(),
        new Date(trialEnds).toISOString(), status === "active" && chance(0.08), cancelled ? iso(cancelled) : null, iso(start)]);
      // One invoice per billing period after the trial; the newest may be open or failed.
      for (let issued = trialEnds; issued < Math.min(cancelled ?? NOW, NOW); issued += step) {
        const latest = issued + step >= Math.min(cancelled ?? NOW, NOW);
        const invoiceStatus = status === "past_due" && latest ? "uncollectible" : latest && chance(0.12) ? "open" : "paid";
        invoices.push([member.workspace, member.workspace, `demo_inv_${member.workspace.slice(0, 8)}_${issued}`, amount, invoiceStatus, iso(issued), iso(issued + 7 * DAY), invoiceStatus === "paid" ? iso(issued + int(0, 3) * DAY) : null]);
        if (invoiceStatus !== "paid") failures.push([`demo_evt_${member.workspace.slice(0, 8)}_${issued}`, member.workspace, iso(issued + DAY)]);
      }
    }
    const customerIds = new Map<string, string>();
    if (customers.length) {
      const rows = await client.query<{ id: string; tenant_id: string }>(
        "INSERT INTO spark.billing_customers (tenant_id, provider, provider_customer_id) SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[]) RETURNING id, tenant_id",
        Array.from({ length: 3 }, (_, column) => customers.map((row) => row[column])),
      );
      for (const row of rows.rows) customerIds.set(row.tenant_id, row.id);
    }
    for (const row of subs) if (typeof row[1] === "string") row[1] = customerIds.get((row[1] as string).replace("@customer:", "")) ?? null;
    // A cancelled paid workspace falls back to Free; insert those after the cancelled rows (one live subscription per workspace).
    const subscriptionRows = await client.query<{ id: string; tenant_id: string }>(
      `INSERT INTO spark.subscriptions (tenant_id, billing_customer_id, plan_id, price_id, provider, provider_subscription_id, billing_kind, status, period_start, period_end, trial_ends_at, cancel_at_period_end, cancelled_at, created_at)
       SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::text[], $6::text[], $7::text[], $8::text[], $9::timestamptz[], $10::timestamptz[], $11::timestamptz[], $12::boolean[], $13::timestamptz[], $14::timestamptz[])
       RETURNING id, tenant_id`,
      Array.from({ length: 14 }, (_, column) => subs.map((row) => row[column])),
    );
    const subscriptionByTenant = new Map(subscriptionRows.rows.map((row) => [row.tenant_id, row.id]));
    const fallback = subs.filter((row) => row[7] === "cancelled").map((row) => row[0] as string);
    if (fallback.length) {
      await client.query(
        "INSERT INTO spark.subscriptions (tenant_id, plan_id, billing_kind, status, created_at) SELECT t, $2, 'free', 'active', now() FROM unnest($1::uuid[]) AS x(t)",
        [fallback, plans.get("free")!.id],
      );
    }
    if (invoices.length) {
      for (const row of invoices) row[1] = subscriptionByTenant.get(row[1] as string);
      await client.query(
        `INSERT INTO spark.invoices (tenant_id, subscription_id, provider, provider_invoice_id, currency, subtotal_minor, total_minor, status, issued_at, due_at, paid_at)
         SELECT t, s, 'demo', p, 'USD', a, a, st, i, d, pa FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::bigint[], $5::text[], $6::timestamptz[], $7::timestamptz[], $8::timestamptz[]) AS x(t, s, p, a, st, i, d, pa)`,
        Array.from({ length: 8 }, (_, column) => invoices.map((row) => row[column])),
      );
    }
    if (failures.length) {
      await client.query(
        `INSERT INTO spark.payment_events (provider, provider_event_id, tenant_id, payload, status, attempts, received_at, processed_at, last_error_code)
         SELECT 'demo', e, t, '{"type":"invoice.payment_failed","demo":true}'::jsonb, 'failed', 3, r, r, 'card_declined' FROM unnest($1::text[], $2::uuid[], $3::timestamptz[]) AS x(e, t, r)`,
        Array.from({ length: 3 }, (_, column) => failures.map((row) => row[column])),
      );
    }

    // ---------- staff history ----------
    audit.sort((a, b) => a.at - b.at);
    await client.query(
      `INSERT INTO spark.platform_audit_events (actor_user_id, action, target_type, target_id, target_label, reason, metadata, created_at)
       SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::uuid[], $5::text[], $6::text[], $7::jsonb[], $8::timestamptz[])`,
      [audit.map((a) => a.actor), audit.map((a) => a.action), audit.map((a) => a.type), audit.map((a) => a.target), audit.map((a) => a.label), audit.map((a) => a.reason),
        audit.map((a) => JSON.stringify(a.metadata)), audit.map((a) => iso(a.at))],
    );

    // The marker workspace makes the seed refuse to run twice.
    const markerOwner = members[0]!;
    await client.query("INSERT INTO spark.workspaces (slug, name, status, created_by_user_id) VALUES ($1, 'Demo data marker', 'archived', $2) RETURNING id", [MARKER_SLUG, markerOwner.id])
      .then((r) => client.query("INSERT INTO spark.workspace_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')", [r.rows[0].id, markerOwner.id]));

    await client.query("COMMIT");
    console.log(
      `Demo data created: ${members.length} members, ${sessions.length} sign-ins, ${communities.length} communities, ${membershipRows.length} memberships, ` +
        `${posts.length} posts, ${comments.length} comments, ${reportIds.rows.length} reports, ${campaignPlan.length} campaigns, ` +
        `${subs.length + fallback.length} subscriptions, ${invoices.length} invoices, ${audit.length} staff actions.`,
    );
    console.log("Paid subscriptions use the provider 'demo': no real payments are involved.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error("Demo seeding failed:", error);
  process.exitCode = 1;
});
