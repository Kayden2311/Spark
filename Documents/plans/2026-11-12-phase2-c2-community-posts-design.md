# Phase 2 C2 — Community posts, comments, edit/delete and reporting: design

Status: design for the C2 plan (`2026-11-12-phase2-c2-community-posts.md`). Decisions marked **(call)** were made by the building session, because the starting session said "C2 decides"; everything else comes from the user stories, use cases and schema documents.

## Intent

C1 made communities real: people can find, join and manage them, but the community page still says "Discussions open in the next update". C2 makes a community a place to talk. Members publish posts and comment on them, authors fix or remove what they wrote, anyone who can see a post or comment can report it, and the community's own owners and moderators can act on reports without waiting for platform staff. It also closes the issues C1 parked.

Stories: US-D1 (read the feed), US-D2 (publish a post), US-D3 (comment), US-D4 (edit or delete my own content), US-G1 (report content), and the community-scoped part of US-G2/US-G3 (work the community's reports, with an auditable record). Use cases UC-11, UC-12, UC-13, UC-17.

## Goals

- A feed on the community page, newest first, with "Show more" (cursor paging).
- A post page with the whole post and its comments, oldest first, with "Show more".
- Members write posts (title and plain-text body) and comments; a network retry never makes a duplicate (`Idempotency-Key`).
- Authors edit (with `If-Match`; a stale edit says someone else changed it) and delete their own posts and comments. Deleted content disappears from lists and pages; reports and moderation records stay.
- Anyone signed in who can see a post or comment reports it with a reason; reporting twice keeps one open report. The reporter's identity never reaches other members or community moderators.
- Community owners and moderators see a Reports tab on the manage page, grouped by reported item, and hide, keep (dismiss the reports) or restore content with a reason. Each action is recorded in `moderation_actions`. They can also hide or restore any post or comment directly from the feed.
- The post author gets an in-app notification when someone else comments (UC-13), linking to the post while they can still read it.
- The six issues C1 parked are fixed.

## Non-goals

- Rich text, Markdown, images, attachments, mentions, reactions, pinning, threaded replies (comments are flat, as the schema says).
- Email for any C2 notification, and notifications for moderation decisions or reports.
- Per-post visibility choices. The `posts.visibility` column stays for old rows and is not exposed.
- Changes to the platform staff queue (`/admin/reports`) beyond receiving the new reports, which it already lists.
- Search inside a community, sorting other than newest first, or realtime updates (the MVP polls nothing here; the page reloads on action).

## Anti-goals (would be a failure even if it works)

- A private or hidden community's posts readable by someone who is not a member, through any list, detail, comment, report, notification or count.
- Reporter identity visible to anyone but platform report staff (and the reporter's own "Reported" state).
- A retry or double-click creating two posts or comments.
- An edit silently overwriting another edit.

## Access rules

Content (posts and their comments) is readable when the community is readable (not archived, host workspace active, hidden only for members and managers), the post is not deleted and its legacy `visibility` is not `hidden`, and:

- the community is **public** — then everyone, signed out too, reads it **(call)**; US-D1 restricts only private communities, US-B3 wants visitors to judge a community's activity, and public communities are joined instantly anyway; or
- the viewer is an **active member** (any role) of the community.

Content hidden by moderation is readable only by the community's owners and moderators (it shows to them with a "Hidden" label). Deleted content is never readable.

**Host workspace owners and admins who are not community members do not read private or hidden content, and do not moderate it (call).** They keep the C1 membership powers (members, requests, settings). This keeps the 0004 rule and the schema rule "an admin managing workspace lifecycle does not automatically gain private community content access"; such an admin can add themselves as a member through C1 if they need to read. Moderation (hide, restore, reports) belongs to active community `owner`s and `moderator`s only, which is also what the `moderation_actions` actor trigger already accepts.

- **Post:** active member of a community that is neither frozen nor archived (the `community_open` trigger already refuses frozen and archived).
- **Comment:** same, on a readable post that is visible (not hidden by moderation).
- **Edit:** the author, still an active member, community not frozen, content not deleted and not hidden by moderation. `If-Match` with the row version.
- **Delete:** the author, at any time, including after leaving the community and while it is frozen **(call)**: people can always take back what they wrote. Soft delete (`deleted_at`). Deleting a post hides its comments with it; reports and moderation rows stay.
- **Report:** any signed-in user who can read the target and is not its author. Reasons: `spam`, `harassment`, `off_topic`, `misinformation`, `self_promotion`, `other` (the first five are the ones the staff queue already shows); details optional, up to 1000 characters. One open report per reporter and target (a repeat returns the existing one). No `Idempotency-Key`: the open-report uniqueness already makes the call idempotent **(call)**.
- **Moderate:** community owner or moderator. Actions on one post or comment: `hide` (closes all its open reports as resolved), `dismiss` (closes all its open reports as dismissed and leaves it visible), `restore` (makes hidden content visible again). Reason 3–500 characters. One `moderation_actions` row per affected report, or one with no report when there is none. Allowed while the community is frozen (moderation must keep working). A community moderator can restore something platform staff hid **(call)**; staff can hide it again and the history shows both.

Lists and details apply the same rule (US-D1). Visible error behaviour:

- A hidden, archived or unknown community: `404 community_not_found`.
- A private community's feed without a session: `401`; signed in but not a member: `403 members_only`. The private community's summary is public (C1), so this reveals nothing new.
- A post or comment the viewer cannot read, including a deleted one: the same `404 post_not_found` / `comment_not_found` as an unknown id. Ids are random, and this keeps "hidden resources return 404".

## Limits

- Post title 1–150 characters and body 1–10,000, both trimmed; comment body 1–2,000 trimmed **(call)**. Plain text; line breaks are kept on display; nothing is rendered as HTML.
- Feed: 1–50 per page, default 20; posts show an excerpt (first 400 characters) and a "Read more" link when longer. Comments: 1–50 per page, default 20.
- Rate limits **(call)**: new posts 10 per 10 minutes, comments 30 per 10 minutes, reports 20 per 10 minutes, edits, deletes and moderation 30 a minute (`MUTATION_RATE_LIMIT`).

## Notifications

`post_commented` goes to the post author when someone else comments, in-app only, in the same transaction through the outbox (processed at once, like the C1 community kinds). Text: "<name> commented on your post in <community>" — no post or comment text, so a removed member's inbox never shows content **(call)**. It is visible outside the host workspace (like the C1 community notifications) and links to `/communities/<slug>/posts/<postId>` only while the recipient can still read the post; otherwise the row has no link.

## The C1 issues C2 closes

1. Adding a member from the workspace while they have a pending request: the request is approved as today and the requester also gets the `community_request_approved` notification.
2. Discovery shows hidden communities to the host workspace owners and admins who manage them, not only to members.
3. Switching a community from private to public approves its pending requests (the people asked to join, and anyone can now join) and notifies each requester **(call)**. Switching to hidden leaves them for managers to decide, as today.
4. `member_count` ignores deleted users.
5. A hidden or unknown community page answers a real HTTP 404 (and so does an unreadable post page), by resolving the community on the server before the page renders.
6. `weekly_posts` counts only posts that are visible, not deleted and not legacy-hidden, and comments that are visible and not deleted on such posts.

## Screens

Public community pages keep the landing-page look (`circle*` classes in `globals.css`). The manage page's new Reports tab follows the existing manage tabs.

- **Community page** (`/communities/[slug]`): the Discussions section becomes the feed. Members (not frozen) see a composer (title, body, counters, Post). Signed-out visitors of a public community read the feed and see "Sign in to join the discussion"; non-members of a public community see "Join to post"; non-members of a private community see "Members only — request access to read the discussions" instead of the feed; a frozen community shows the feed with "This community is paused by Spark moderators" in place of the composer. Each post card: author initials avatar and name, relative time, "Edited", "Hidden" for moderators, title linking to the post page, excerpt, comment count, and a "More actions" menu (Edit and Delete for the author, Report for others, Hide or Restore for moderators).
- **Post page** (`/communities/[slug]/posts/[postId]`): back link to the community, the post (inline edit for the author), comments oldest first with "Show more", a comment composer for members, the same per-comment menu.
- **Dialogs:** delete confirmation, report (reason choices with plain descriptions, optional details, "Report sent" confirmation; already reported shows "You reported this"), moderation (action and required reason).
- **Manage → Reports tab** (owners and moderators): one row per reported item with an excerpt, author, how many open reports and their reasons, the latest details (never who reported), and Hide / Keep / open in the feed. Empty: "No open reports".
- Phone width 390 px works without horizontal scroll; motion respects `prefers-reduced-motion`.

## Settled details (from the builder check)

- **One hidden flag.** Staff and community moderators set the same `moderation_status`; there is no "hidden by" source. `moderation_actions` (and, for staff, `platform_audit_events`) keep who did what, and the staff queue is unchanged **(call)**.
- **Data access.** `spark_app` has no read on `content_reports`, and `users` RLS only shows coworkers, so every content read is a `SECURITY DEFINER` function that works with or without a session (the C1 discovery pattern) and returns author names itself; the community report queue is a new definer function with no reporter column. Migrations `0032`–`0035` add what is missing: `edited_at` on posts and comments, length checks, the `post_commented` kind, a report reason check, and the functions. The moderation action for "keep" is the existing `dismiss_report`.
- **Hiding a post** makes its comments unreadable for everyone but moderators, like deleting it; open reports on those comments stay open and listed (they are separate targets) **(call)**.
- **Comment count** = visible, non-deleted comments, the same for every viewer, computed on read.
- **Comment notifications:** one per comment by someone other than the post author; none when the post author is deleted; an author who left still gets it, without a link.
- **"Edited"** shows only after an author edit (`edited_at` is set by author edits, never by moderation). Moderators cannot edit other people's content.

## Left to the builder

Exact SQL shapes, file layout, CSS class names, the server-side 404 mechanism within the Next.js 16 docs, test fixtures, and copy beyond the strings above.
