# Spark user stories

## Purpose

This document defines the MVP user stories by actor. It extends the seven summary stories (US-01 to US-07) in [context.md](../context.md) and aligns with the journeys in [screen-flow.md](screen-flow.md). Behavioral flows for each story live in [use-cases.md](use-cases.md).

Status values describe verified repository state only:

- **Implemented**: backend or UI exists in the repository and is described as implemented in context.md or screen-flow.md.
- **Mockup**: a screen exists with hardcoded data; no persisted behavior.
- **Planned**: no code yet.

Nothing in this document claims a capability is operational unless its status says so.

## Actors

| Actor | Description | Authentication | Source |
| --- | --- | --- | --- |
| Visitor | Anyone browsing public pages without a session. | None | Journey 1 |
| User | A signed-in account with no special community or workspace role. | Opaque session | Journey 5 |
| Community Member | A User with an approved membership in a community. | Opaque session | US-02, US-03 |
| Community Owner | A Community Member who manages a community and its membership requests. | Opaque session | US-02 |
| Workspace Owner | A User who created a workspace and controls its invitations. | Opaque session | US-04 |
| Workspace Member | A User who accepted a workspace invitation. | Opaque session | US-04, US-05 |
| Reporter | Any User or Community Member who flags content. Identity is hidden from ordinary members. | Opaque session | US-07 |
| Community Moderator | Platform role `community_moderator`; moderates communities in an authorized scope. | Opaque session + platform role | Journey 6 |
| Content Moderator | Platform role `content_moderator`; resolves reports in an authorized queue. | Opaque session + platform role | US-07, Journey 6 |
| Campaign Moderator | Platform role `campaign_moderator`; reviews sponsored startup promotions. | Opaque session + platform role | Journey 6 |
| Platform Admin | Platform role `platform_admin`; manages users and platform status. | Opaque session + platform role | Journey 6 |
| Super Admin | Platform role `super_admin`; audits and assigns platform roles. | Opaque session + platform role | Journey 6 |
| System | Background processes: outbox dispatcher, invitation expiry, rate limiter. | Internal | US-06 |

A single account may hold several roles. Authorization is checked per resource in application use cases, never inferred from the UI.

## Story format

Each story uses: **As a** actor, **I want** goal, **so that** benefit. Acceptance criteria use Given/When/Then. Priority uses MoSCoW for the MVP: **Must**, **Should**, **Could**. Post-MVP items are listed separately.

## Epic A: Authentication and account access

### US-A1: Sign in with email and password

- **Actor**: Visitor
- **Priority**: Must
- **Status**: Implemented (`POST /api/v1/auth/password/sign-in`, `/login`)
- **Story**: As a Visitor with an account, I want to sign in with my email and password so that I can reach protected features.
- **Acceptance criteria**:
  - Given valid credentials, when I submit the sign-in form, then a secure session cookie is set and I am redirected to my destination.
  - Given invalid credentials, when I submit, then I see one generic error that does not reveal whether the email exists.
  - Given repeated failures from one source, when the rate limit is exceeded, then the API returns `429` with `Retry-After`.
  - Given a successful sign-in, then any prior session identifier is rotated.

### US-A2: Sign in with OAuth

- **Actor**: Visitor
- **Priority**: Should
- **Status**: Mockup (OAuth buttons on `/login`; no verified backend flow)
- **Story**: As a Visitor, I want to sign in with GitHub or Google so that I do not manage another password.
- **Acceptance criteria**:
  - Given a provider account whose verified email matches an existing user, when I complete OAuth, then I am signed in to that user.
  - Given a provider account with no match, when I complete OAuth, then an account is created only after I confirm the profile.
  - Given a cancelled or failed provider flow, when I return to Spark, then I see a safe error and remain signed out.

### US-A3: View my session and sign out

- **Actor**: User
- **Priority**: Must
- **Status**: Implemented (`GET /api/v1/me`, `POST /api/v1/auth/sign-out`)
- **Story**: As a User, I want to see who I am signed in as and sign out so that I control access on shared devices.
- **Acceptance criteria**:
  - Given a valid session, when I request my profile, then I receive my identity and roles with `private, no-store`.
  - Given I sign out, then the session is revoked server-side and the cookie is cleared.
  - Given a revoked or expired session, when I call a protected endpoint, then I receive `401`.

### US-A4: Register an account

- **Actor**: Visitor
- **Priority**: Must
- **Status**: Planned (`/signup`)
- **Story**: As a Visitor, I want to register with an email and password so that I can request membership and join workspaces.
- **Note**: Sign-up no longer creates a workspace; a new user creates one explicitly (US-E1) or joins through an invitation (US-E3).
- **Acceptance criteria**:
  - Given a new email and a password meeting policy, when I submit, then the account is created with an Argon2id hash and I am signed in or asked to verify the email.
  - Given an email already registered, when I submit, then the response does not disclose that the email exists.
  - Given a duplicate retry of the same request, then no second account is created.

### US-A5: Recover a forgotten password

- **Actor**: Visitor
- **Priority**: Should
- **Status**: Planned (`/forgot-password`)
- **Story**: As a Visitor who forgot my password, I want a reset link so that I can regain access.
- **Acceptance criteria**:
  - Given any submitted email, when I request a reset, then the response is identical whether or not the account exists.
  - Given a reset token, then it is expiring, single-use, and stored only as a hash.
  - Given a successful reset, then all existing sessions for the account are revoked.

## Epic B: Community discovery (US-01)

### US-B1: Search public communities

- **Actor**: Visitor, User
- **Priority**: Must
- **Status**: Mockup (`/communities`)
- **Story**: As a Visitor, I want to search public communities by keyword so that I can find groups relevant to my startup.
- **Acceptance criteria**:
  - Given a keyword, when I search, then only public communities that match are returned in a deterministic order.
  - Given no match, then an empty state suggests clearing filters.
  - Given more results than one page, then a cursor returns the next page without duplicates or gaps.
  - Given an oversized page size or invalid filter, then the API rejects it with a validation error.
  - Private and hidden communities never appear in anonymous results.

### US-B2: Filter by topic, location, and stage

- **Actor**: Visitor, User
- **Priority**: Must
- **Status**: Mockup
- **Story**: As a Visitor, I want to narrow results by topic, location, and startup stage so that I see communities that fit my situation.
- **Acceptance criteria**:
  - Given one or more filters, when applied, then results satisfy all active filters.
  - Given the filters are in the URL, when I share or reload the page, then the same filtered view is restored.
  - Filter values come from a fixed, validated set.

### US-B3: Evaluate a community

- **Actor**: Visitor, User
- **Priority**: Must
- **Status**: Mockup (`/communities/[slug]`)
- **Story**: As a Visitor, I want to see a community's description, topics, activity level, and access type so that I can decide whether to request access.
- **Acceptance criteria**:
  - Given a public community, then its details load by slug.
  - Given a private community, then I see only the public summary and a Request access action.
  - Given a hidden community and a non-member, then the response is `404`, indistinguishable from a missing slug.

## Epic C: Membership (US-02)

### US-C1: Request membership

- **Actor**: User
- **Priority**: Must
- **Status**: Planned (`/communities/[slug]/request`, `/request/sent`)
- **Story**: As a User, I want to request access to a private community so that its owner can admit me.
- **Acceptance criteria**:
  - Given I am signed in, when I send a request with an optional message, then a pending request is created and I see the sent confirmation.
  - Given I am a Visitor, when I choose Request access, then I am asked to sign in and returned to the request screen afterward.
  - Given I retry the same request, then no duplicate is created and the original is returned.
  - Given I am already a member or have a pending request, then I see my current state instead of a new form.

### US-C2: Review membership requests

- **Actor**: Community Owner
- **Priority**: Must
- **Status**: Planned
- **Story**: As a Community Owner, I want to approve or reject pending requests so that I control who joins.
- **Acceptance criteria**:
  - Given pending requests for my community, then I see requester name, message, and date.
  - Given I approve, then the request moves to approved and the membership is created in one transaction.
  - Given I reject, then the request moves to rejected and no membership exists.
  - Given the request was already decided, then a second decision fails with a conflict and changes nothing.
  - Given I am not an owner of that community, then I receive `403` and the request list stays hidden.

### US-C3: Track my request

- **Actor**: User
- **Priority**: Should
- **Status**: Planned
- **Story**: As a User, I want to see whether my request is pending, approved, or rejected so that I know what to do next.
- **Acceptance criteria**:
  - Given a decision, then I receive a notification (see US-F1).
  - Given a rejected request, then I may not re-request until a documented cooldown ends.

## Epic D: Posts and discussion (US-03)

### US-D1: Read the community feed

- **Actor**: Community Member
- **Priority**: Must
- **Status**: Planned
- **Story**: As a Community Member, I want to read my community's posts so that I stay informed.
- **Acceptance criteria**:
  - Given I am a member, then the feed lists posts newest first with cursor pagination.
  - Given I am not a member of a private community, then the feed and individual posts return `403` or `404` consistently with visibility rules.
  - List and detail endpoints apply the same visibility rules.

### US-D2: Publish a post

- **Actor**: Community Member
- **Priority**: Must
- **Status**: Planned
- **Story**: As a Community Member, I want to publish a post so that I can share updates or ask for help.
- **Acceptance criteria**:
  - Given valid title and body, when I submit, then the post appears in the feed.
  - Given a network retry with the same idempotency key, then only one post exists.
  - Given content over the limit or invalid, then I receive a validation error and nothing is stored.

### US-D3: Comment on a post

- **Actor**: Community Member
- **Priority**: Must
- **Status**: Planned
- **Story**: As a Community Member, I want to comment on a post so that I can join the discussion.
- **Acceptance criteria**:
  - Given I can view the post, when I comment, then the comment appears in order under the post.
  - Given I lose membership, then I can no longer comment.
  - Retries with the same idempotency key do not duplicate the comment.

### US-D4: Edit or delete my own content

- **Actor**: Community Member
- **Priority**: Could
- **Status**: Planned
- **Story**: As an author, I want to edit or delete my post or comment so that I can correct mistakes.
- **Acceptance criteria**:
  - Given I am the author, then I can edit or delete within policy; others cannot.
  - Deleted content is removed from lists and details; moderation records are preserved.

## Epic E: Workspaces and tasks (US-04, US-05)

### US-E1: Create a workspace

- **Actor**: User
- **Priority**: Must
- **Status**: Implemented (`POST /api/v1/workspaces`, `GET /api/v1/workspaces`, `GET /api/v1/workspaces/{workspaceId}`, `GET /api/v1/workspaces/by-slug/{slug}`, `PATCH /api/v1/workspaces/{workspaceId}`)
- **Story**: As a User, I want to create a workspace so that my team has a private place to collaborate.
- **Acceptance criteria**:
  - Given a valid name, when I create it, then the workspace and my ownership are committed atomically.
  - Given a failure partway, then neither the workspace nor the ownership exists.
  - Every workspace row carries `tenant_id`, and tenant isolation is enforced by RLS.

### US-E2: Invite members

- **Actor**: Workspace Owner or Admin
- **Priority**: Must
- **Status**: Implemented (`POST /api/v1/workspaces/{workspaceId}/invitations`, `GET /api/v1/workspaces/{workspaceId}/invitations`, `POST /api/v1/workspaces/{workspaceId}/invitations/{invitationId}/resend`, `DELETE /api/v1/workspaces/{workspaceId}/invitations/{invitationId}`)
- **Story**: As a Workspace Owner or Admin, I want to invite people by email so that my team can join.
- **Acceptance criteria**:
  - Given an email, when I send an invitation, then it is expiring (7 days) and single-use, and the link is emailed by the background worker; the API never returns the token.
  - Given I revoke a pending invitation, then it can no longer be accepted.
  - Given I resend an invitation, then a new link is emailed and the previous link stops working.
  - An owner may invite admins or members; an admin may invite members only. Plain members cannot list, send, resend, or revoke invitations.

### US-E3: Accept an invitation

- **Actor**: User
- **Priority**: Must
- **Status**: Implemented (`POST /api/v1/invitations/preview`, `POST /api/v1/invitations/accept`)
- **Story**: As an invited person, I want to accept my invitation so that I can join the workspace.
- **Acceptance criteria**:
  - Given a valid token and a signed-in account matching the invited recipient, when I accept, then I become a Workspace Member of that tenant only.
  - Given an expired, used, or revoked token, then acceptance fails with a safe error.
  - Given a different account than the intended recipient, then acceptance is refused with `403 recipient_mismatch` naming the masked invited email, and the invitation stays pending.
  - Given the same account accepts twice, then the second call succeeds with `alreadyMember: true`.
  - Two simultaneous accepts of the same token result in exactly one membership.

### US-E4: Create and assign tasks

- **Actor**: Workspace Member
- **Priority**: Must
- **Status**: Mockup (`/workspace` Add task)
- **Story**: As a Workspace Member, I want to create tasks and assign them so that ownership and progress are clear.
- **Acceptance criteria**:
  - Given a title and optional assignee, then the task is created in the workspace's board.
  - The assignee must be a member of the same workspace.
  - A member of another workspace cannot read or change the task.

### US-E5: Move tasks safely

- **Actor**: Workspace Member
- **Priority**: Must
- **Status**: Planned
- **Story**: As a Workspace Member, I want to move tasks between states without overwriting a teammate's change so that the board stays accurate.
- **Acceptance criteria**:
  - Given a task version, when I update with a stale version, then the API returns a conflict and I see the latest state.
  - Moving a task works with keyboard and on mobile.
  - Each successful update increments the task version.

### US-E6: Schedule events

- **Actor**: Workspace Member
- **Priority**: Could
- **Status**: Mockup (`/schedule`)
- **Story**: As a Workspace Member, I want to add events and delivery dates so that the team coordinates sessions.
- **Acceptance criteria**: Persisted behavior is defined when this story is scheduled; until then the screen shows illustrative data only.

## Epic F: Notifications (US-06)

### US-F1: Receive notifications

- **Actor**: User
- **Priority**: Must
- **Status**: Mockup (`/notifications`)
- **Story**: As a User, I want to be notified of relevant activity so that I can respond quickly.
- **Acceptance criteria**:
  - Given a committed event (membership decision, task assignment, new comment on my post), then a notification is created through the outbox.
  - Given the MVP, then notifications are retrieved by polling.
  - Given authorization changes, then a notification for a resource I can no longer access is not delivered.

### US-F2: Mark notifications as read

- **Actor**: User
- **Priority**: Must
- **Status**: Mockup
- **Story**: As a User, I want to mark notifications read so that I can track what is new.
- **Acceptance criteria**:
  - Given unread notifications, when I choose Mark all as read, then only my notifications change.
  - The operation is idempotent.

## Epic G: Reporting and moderation (US-07)

### US-G1: Report content

- **Actor**: Reporter
- **Priority**: Must
- **Status**: Planned
- **Story**: As a Reporter, I want to report a post or comment so that moderators can review it.
- **Acceptance criteria**:
  - Given I can view the content, when I submit a reason, then a report is created.
  - Given I report the same content twice, then one report per reporter and target exists.
  - Reporter identity is never exposed to ordinary members.

### US-G2: Work the moderation queue

- **Actor**: Content Moderator
- **Priority**: Must
- **Status**: Implemented: `/admin/reports` and `/api/v1/admin/reports` (`0009_platform_governance`). Authorized scope is platform-wide, because platform roles are global; per-community moderator scopes are not modelled yet.
- **Story**: As a Content Moderator, I want to see and resolve reports within my authorized scope so that harmful content is handled.
- **Acceptance criteria**:
  - Given reports outside my scope, then they are not listed and cannot be fetched by id.
  - Given I resolve a report (dismiss or take action), then the status changes once and a second resolution conflicts.
  - Taking action can hide or remove the target content.

### US-G3: Keep an auditable record

- **Actor**: Content Moderator, Community Moderator, Campaign Moderator, Platform Admin
- **Priority**: Must
- **Status**: Implemented for platform staff actions: every action in `/admin` writes one row to the append-only `spark.platform_audit_events` in the same transaction, shown in `/admin/audit`. Community-owner moderation does not exist yet.
- **Story**: As a moderator, I want every action recorded so that decisions are accountable.
- **Acceptance criteria**:
  - Each moderation action stores actor, target, reason, and timestamp in the same transaction as the action.
  - Records are append-only for ordinary roles.
  - Logs contain no private payloads.

## Epic H: Platform governance (Journey 6)

### US-H1: Moderate communities

- **Actor**: Community Moderator, Platform Admin
- **Priority**: Should
- **Status**: Implemented: `/admin/communities` and `POST /api/v1/admin/communities/{id}/actions` (feature, unfeature, freeze, unfreeze, archive, restore). A database trigger rejects new posts and comments in frozen or archived communities.
- **Story**: As a Community Moderator, I want to feature, freeze, or archive a community so that platform quality is maintained.
- **Acceptance criteria**:
  - Given I hold the role, then I can change community status and must supply a reason.
  - A frozen community blocks new posts but remains readable per visibility.
  - Users without the role cannot call these actions.

### US-H2: Review sponsored campaigns

- **Actor**: Campaign Moderator
- **Priority**: Could
- **Status**: Implemented: `/admin/campaigns` and `POST /api/v1/admin/campaigns/{id}/review`. No reopen action exists, so decisions are final.
- **Story**: As a Campaign Moderator, I want to approve or reject sponsored startup promotions so that only appropriate promotions run.
- **Acceptance criteria**:
  - Given a pending campaign, then I can approve or reject with a reason.
  - A decision is final unless a documented reopen action exists.

### US-H3: Manage platform users

- **Actor**: Platform Admin
- **Priority**: Should
- **Status**: Implemented: `/admin/users`, `/admin/users/{id}` and `PATCH /api/v1/admin/users/{id}/status`.
- **Story**: As a Platform Admin, I want to suspend or reactivate users so that abusive accounts are contained.
- **Acceptance criteria**:
  - Given a suspension, then the user's sessions are revoked and sign-in is refused.
  - Reactivation restores sign-in without restoring revoked sessions.
  - Both actions are recorded (US-G3).

### US-H4: Audit and assign platform roles

- **Actor**: Super Admin
- **Priority**: Should
- **Status**: Implemented: role management on `/admin/users/{id}`, `POST` and `DELETE /api/v1/admin/users/{id}/roles`.
- **Story**: As a Super Admin, I want to view and assign platform roles so that privileges are least-privilege and reviewable.
- **Acceptance criteria**:
  - Only `super_admin` can grant or revoke platform roles.
  - Role changes are recorded with actor, target, and time.
  - A Super Admin cannot remove the last remaining `super_admin`.

## Epic I: Platform guardrails (cross-cutting)

### US-I1: Safe errors and rate limits

- **Actor**: System
- **Priority**: Must
- **Status**: Implemented (Redis-backed rate limiting, safe error responses)
- **Story**: As the platform, I want route-specific rate limits and safe errors so that abuse is contained and no internals leak.
- **Acceptance criteria**:
  - Limited routes return `429` with `Retry-After`; `GET /health` is never limited.
  - Redis failure follows each route's documented fail-open or fail-closed policy.
  - Error bodies contain no stack traces, secrets, or private data.

## Out of scope for the MVP

Mentor matching, file uploads, rich realtime collaboration, AI summaries, and billing or plan upgrades (`/billing` remains a mockup). These need new stories and a scope decision before work starts.

## Traceability

| Summary story | Detailed stories | Primary journey |
| --- | --- | --- |
| US-01 | US-B1, US-B2, US-B3 | Journey 1 |
| US-02 | US-C1, US-C2, US-C3 | Journeys 1 and 2 |
| US-03 | US-D1, US-D2, US-D3, US-D4 | Journey 2 |
| US-04 | US-E1, US-E2, US-E3 | Journey 3 |
| US-05 | US-E4, US-E5, US-E6 | Journey 3 |
| US-06 | US-F1, US-F2 | Journey 3 |
| US-07 | US-G1, US-G2, US-G3 | Journey 4 |
| Auth and governance | US-A1 to US-A5, US-H1 to US-H4, US-I1 | Journeys 5 and 6 |

## Definition of done

Each story follows the definition of done in [context.md](../context.md#definition-of-done): working acceptance criteria, matching API contracts, tested authorization and data invariants, reversible or documented migrations, no sensitive logging, and passing applicable repository checks.
