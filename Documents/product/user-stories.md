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
- **Status**: Implemented (`POST /api/v1/auth/password/sign-up`, `/signup`)
- **Story**: As a Visitor, I want to register with an email and password so that I can request membership and join workspaces.
- **Note**: Sign-up creates the account and signs the user in; since migration `0014` it no longer creates a workspace. A new user creates one explicitly (US-E1) or joins through an invitation (US-E3). Email verification is not implemented yet.
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
- **Status**: Implemented (`POST /api/v1/projects/{projectId}/issues` with an optional `Idempotency-Key`, `GET`/`PATCH /api/v1/issues/{issueId}` with `If-Match`, `GET /api/v1/issues/{issueId}/events`; screens: quick-add on the board `/w/[slug]/p/[key]` and the task drawer `?issue=<KEY>-<n>`)
- **Story**: As a Workspace Member, I want to create tasks and assign them so that ownership and progress are clear.
- **Acceptance criteria**:
  - Given a title, when I add a task under a board column, then it is created at the end of that column of the project's board with the key `<KEY>-<n>`; every active member (owner, admin or member) may create, edit, assign and archive tasks in non-archived projects of the workspace.
  - A double-submitted or network-retried "Add task" creates exactly one task: the same `Idempotency-Key` with the same body replays the first result (`201`, header `Idempotent-Replayed: true`) for 24 hours; the same key with a different body is refused with `409 idempotency_key_reused`.
  - Adding a task to a column whose WIP limit is reached is refused with `409 wip_limit_reached` and the column explains why.
  - In the task drawer the assignee is chosen from the workspace members or "Unassigned". An assignee who is not an active member of the same workspace is refused with `422 invalid_assignee`.
  - When someone else assigns me, I get one in-app `issue_assigned` notice and one email whose link opens the task's drawer (`/w/<slug>/p/<KEY>?issue=<KEY>-<n>`). Assigning myself sends nothing. Email limits: only the latest assignment per task and recipient is emailed, at most one email per task and recipient within 10 minutes, and at most 20 task-assigned emails per recipient per hour; the in-app notice is not limited. The `task_assigned` email preference is honoured.
  - Archiving asks for confirmation, removes the card from the board and keeps the history. An unknown or archived task in a link shows "That task no longer exists."; when the board shows only its first 500 tasks, a task outside them shows "That task isn't on the loaded board. Open it from the task list." instead (a lookup by key is not built yet).
  - A member of another workspace cannot read or change the task (`404`).

### US-E5: Move tasks safely

- **Actor**: Workspace Member
- **Priority**: Must
- **Status**: Implemented (`GET /api/v1/projects/{projectId}/board`, `PATCH /api/v1/issues/{issueId}` with `If-Match` and `statusId` / `afterIssueId`; screen: the board `/w/[slug]/p/[key]`)
- **Story**: As a Workspace Member, I want to move tasks between states without overwriting a teammate's change so that the board stays accurate.
- **Acceptance criteria**:
  - Every task write carries `If-Match` with the task version (missing: `428 precondition_required`). Given a stale version, the API returns `412 version_mismatch` with the current task; the board refreshes with "Updated by a teammate — the board was refreshed." and the drawer swaps in the newer values with "Updated by a teammate — review the latest values and save again." Of two teammates moving the same card at once, exactly one wins.
  - Moving a card into a column whose WIP limit is reached by other tasks is refused with `409 wip_limit_reached`: the card snaps back and the column says "<Status> is at its WIP limit (<n>). Finish or move a task out first." Reordering inside a full column is never blocked.
  - Moving works by drag and drop, by keyboard (Space picks up, arrows move, Enter drops, Escape cancels, each step announced) and on phones through "Move to…" on every card.
  - Each successful change increments the task version by one and appends one history event; the drawer tells the history in sentences ("Avery Founder moved it to In progress · 2 h ago").

### US-E6: Schedule events

- **Actor**: Workspace Member (create, answer, read); the organizer, Owner or Admin (edit, cancel)
- **Priority**: Could
- **Status**: Implemented (`GET /api/v1/workspaces/{workspaceId}/calendar?from&to&tz`, `POST /api/v1/workspaces/{workspaceId}/calendar-events`, `GET`/`PATCH /api/v1/calendar-events/{eventId}`, `POST /api/v1/calendar-events/{eventId}/cancel`, `PUT /api/v1/calendar-events/{eventId}/attendees/me`; migration `0027`; screen `/w/[slug]/schedule`)
- **Story**: As a Workspace Member, I want to add events and see delivery dates so that the team coordinates sessions around the work that is due.
- **Acceptance criteria**:
  - The Schedule page (`/w/[slug]/schedule`, "Schedule" in the sidebar; `/schedule` opens the last workspace's page) shows one local week (Monday to Sunday, in the viewer's browser time zone) with Previous, Today and Next, an "Only mine" toggle and "New event". The week is a seven-day grid from 1280 px of window width and a day-by-day agenda below it; the shell sidebar is why the grid needs that width. `?week=` keeps the shown week in the URL. A tab that regains focus (or visibility) reloads the week once and moves "Today" past midnight.
  - Given deadlines in non-archived projects, then the week lists them as chips on their day: open tasks with a due date ("Task due"), planned or active sprints' end ("Sprint ends") and open milestones' due date ("Milestone"), each with the project key and a link to the task, backlog or timeline. Deadlines are calendar dates: a date counts in the week when it falls on a day of the viewer's zone. "Only mine" keeps events I organize or am invited to, and tasks assigned to me, and leaves sprint and milestone dates.
  - Given any member, when they choose "New event", then the dialog takes a title (1–200), start and end (an end after the start, 5 minutes to 14 days, 2000–2100), a time zone (default the browser's), an optional location (200) and description (2000), an optional project and task, and up to 50 teammates. The creator is the organizer and always attends ("Going"); invited teammates start "Awaiting reply" and get an in-app `event_invited` notice. The dialog warns "Overlaps with N of your events" and refuses an end before the start inline.
  - Given an event, then everyone in the workspace can open it: when and where in the viewer's zone (and the organizer's zone when it differs), organizer, project and task, description and every attendee's answer. Events are team-visible; a cancelled event stays listed, struck through and marked "Cancelled", and cannot change.
  - Given I am invited, then the event offers Accept, Maybe and Decline (answer shown at once, restored on failure, keyboard focus stays on the pressed button); the organizer sees my answer. Answering a cancelled event says "This event was cancelled" (`409 event_cancelled`); a member who is not invited has no answer buttons (`403 not_invited`).
  - Given the organizer, an owner or an admin edits the event and changes its start or end, then every other attendee's answer goes back to "Awaiting reply" and each is told with an `event_rescheduled` notice ("<title> moved to <local date and time in the event's zone>"); attendees who are added start pending and are invited, attendees who are removed are dropped. Edits and Cancel send `If-Match`.
  - Given a plain member opens someone else's event, then they see it (and may answer their own invitation) but no Edit or Cancel event; the API refuses their writes with `403 insufficient_role`.
  - Given two people edit the same event, then the one who saves second gets `412`, the dialog shows the teammate's version with "Updated by a teammate. The event was reloaded with their changes; review it and save again." and the week reloads. Cancelling asks "Cancel this event?" first, sends `If-Match`, tells every attendee but the person who cancelled (`event_cancelled`) and treats a stale version the same way.
  - Given a member of another workspace (or an unknown id), then reading, editing, cancelling or answering an event returns the same `404 event_not_found`; an invited person who has since left the workspace can no longer answer.
  - A phone (390 px) shows the agenda with no horizontal scroll and a dialog that fits the screen; every motion stops under `prefers-reduced-motion`.

### US-E7: Choose a methodology for a project

- **Actor**: Workspace Owner or Admin (create); Owner, Admin or project lead (settings); any Workspace Member (read)
- **Priority**: Must
- **Status**: Implemented (`GET /api/v1/methodologies`, `POST /api/v1/workspaces/{workspaceId}/projects`, `GET /api/v1/workspaces/{workspaceId}/projects`, `GET /api/v1/workspaces/{workspaceId}/projects/by-key/{key}`, `GET /api/v1/projects/{projectId}`, `PATCH /api/v1/projects/{projectId}`; screens `/w/[slug]/projects/new` and `/w/[slug]/p/[key]`)
- **Story**: As a Workspace Owner or Admin, I want to create a project with Scrum, Kanban or Waterfall so that its board, planning and reports match how the team works.
- **Acceptance criteria**:
  - Given the picker, when I choose a methodology, then the form shows that methodology's columns, practices and fields: sprint length (1–4 weeks) for Scrum, WIP limits for Kanban, and start/target dates with evenly spread, editable phases for Waterfall.
  - Given a project key that is already used in this workspace, then creation fails with `409 key_taken` and the form says so; the same key in another workspace is allowed.
  - Given Waterfall dates too short for the phases, or a target before the start, then the form shows an inline error and cannot be submitted, and the API answers `400` naming invalid dates.
  - Given a plain member opens `/w/{slug}/projects/new`, then they see "Only owners and admins can create projects" instead of a form.
  - The workspace home lists every project with its key, methodology pill, lead and progress (`done/total`, or "No tasks yet"); the sidebar lists up to 8 projects with a methodology-colored dot, and only owners and admins see "New project".
  - The project overview shows the header, the board columns with WIP limits, the methodology section (Scrum sprint length; Kanban WIP summary; Waterfall phase timeline with baseline bars, milestone markers and a today marker) and the methodology's practices; an unknown key shows a not-found card.
  - Owners, admins and the project lead can edit name, description, lead, dates and (Scrum) sprint length in the General section of the Settings tab (`/w/[slug]/p/[key]/settings`, the only place to edit them; the project header has no Settings button); saves send `If-Match`. Given a teammate saved first, then the save gets `412`, the form shows the teammate's values and says "Updated by a teammate — review the latest values and save again."
  - Projects created before methodologies existed still list and open, shown as Kanban.
  - The methodology can be changed later through the switch wizard (US-E11).

### US-E8: Plan sprints

- **Actor**: Workspace Owner, Admin or the project lead (plan); any Workspace Member (read)
- **Priority**: Must
- **Status**: Implemented (`GET`/`POST /api/v1/projects/{projectId}/sprints`, `GET`/`PATCH /api/v1/sprints/{sprintId}`, `POST /api/v1/sprints/{sprintId}/start`, `POST /api/v1/sprints/{sprintId}/complete`, `PATCH /api/v1/issues/{issueId}` with `sprintId`; migration `0023`; screen: the Backlog tab `/w/[slug]/p/[key]/backlog`, Scrum projects only)
- **Story**: As a planner of a Scrum project, I want to plan work into sprints, start one sprint at a time and close it with its unfinished work carried over so that the team commits to a realistic amount of work.
- **Acceptance criteria**:
  - The Backlog tab shows, top to bottom, the active sprint (goal, dates, days left, done against committed points), the planned sprints (name, goal, dates) and the Backlog (open tasks without a sprint, in board order). Every lane shows its task count and points. The next planned sprint compares its planned points with the velocity — the average completed points of the last 3 completed sprints ("Velocity 21 pts (last 3)", or "No velocity yet") — and above 110% warns "Over capacity: 16 pts planned is 160% of velocity."
  - "Create sprint" proposes the next name and dates that follow the open sprint ending last (or start today) and last the project's sprint length. Names are 1–80 characters, goals at most 500, and a sprint lasts 1 to 28 days. Only planned sprints change their dates; completed sprints are history and are not shown as lanes.
  - Tasks move between lanes by drag and drop, by keyboard (Space picks up, arrows move between lanes, Enter or Space drops, Escape cancels, each step announced) and through "Move to…" (always visible on phones). Each move PATCHes the task's `sprintId` with `If-Match`, shows at once and rolls back on failure; a stale task refreshes the backlog with "Updated by a teammate — the backlog was refreshed." Open tasks that still point at a completed sprint (reopened later) show in the Backlog lane.
  - "Start sprint" confirms the dates and the commitment ("5 tasks · 21 pts will be committed."). Starting snapshots every task of the sprint with its points, sends each assignee other than the starter an in-app `sprint_started` notice ("<project>: <sprint> started"), and only one sprint can be active: a second start (another sprint is active, or two planners press Start at once) is refused with `409 sprint_already_active` and the dialog says "Another sprint is already active in this project. Complete it first."
  - "Complete sprint" shows "3 of 5 tasks done · 2 unfinished tasks" and asks where unfinished work goes: the next planned sprint (the default) or the Backlog. Completing freezes the completed points and count, moves every open task (each with a new version, a history event and an outbox row) and says "Sprint 1 completed. 2 unfinished tasks moved to Sprint 2." Carrying to anything but a planned sprint of the project is refused with `422 invalid_carry_target`.
  - Start, complete and edit send `If-Match` (missing: `428`; stale: `412` with the current sprint, and the dialog says "Updated by a teammate — review the sprint and try again."). Other refusals: `409 sprint_not_planned`, `sprint_not_active`, `sprint_not_editable` and `sprint_missing_dates`.
  - Sprint writes are for Scrum projects only; the sprints of a project that left Scrum stay as read-only history. Through the API any active member may set a task's `sprintId` (an ordinary task edit), but the Backlog tab is read-only for members who cannot plan.
  - A plain member sees every lane, total and the velocity but no planning control, and the note "Only owners, admins and the project lead can change the plan."; the API refuses their sprint writes with `403 insufficient_role`.

### US-E9: Plan phases and milestones and re-baseline

- **Actor**: Workspace Owner, Admin or the project lead (plan); any Workspace Member (read)
- **Priority**: Must
- **Status**: Implemented (`GET /api/v1/projects/{projectId}/plan`, `PUT /api/v1/projects/{projectId}/phases`, `POST /api/v1/projects/{projectId}/baseline`, `POST /api/v1/projects/{projectId}/milestones`, `GET`/`PATCH /api/v1/milestones/{milestoneId}`; migration `0024`; screen: the Timeline tab `/w/[slug]/p/[key]/timeline`)
- **Story**: As a planner of a Waterfall project, I want to keep the phase plan and milestones current and see how far they moved from the baseline so that schedule slips are visible early.
- **Acceptance criteria**:
  - The Timeline draws a Gantt from the project start to the target date: per phase a dashed baseline bar, the planned bar filled by its done share (done tasks ÷ phase tasks) and a variance badge for planned end minus baseline end — "on baseline" (green), "−2 d" ahead (green), "+1 d" to "+7 d" late (amber), more than 7 days late (red), or "no baseline" for a phase added after the last re-baseline. Milestone diamonds sit on their due dates (filled when completed, red outline when overdue), a line marks today, and a "Plan details" table gives every date, baseline and variance as text.
  - "Unphased N" counts the open tasks without a phase and links to the board filtered to them (`?phase=none`, "Showing unphased tasks" with Clear). Progress and counts come from the loaded board (at most 500 tasks; a banner says when it is cut).
  - "Edit phases" edits 1 to 12 phases (names 1–60, inside the project dates, in order without overlap) and sends the whole plan with `If-Match` (the project ETag). Moving a phase end shows the variance at once ("+6 d"); baselines never change. A removed phase that still has tasks or milestones is refused ("A phase you removed still has tasks or milestones…").
  - Milestones (name 1–80, due date inside the project dates, optional phase) can be added, edited, completed and reopened, in every methodology.
  - "Re-baseline" requires a reason (1–200) and a confirmation. It copies the planned dates of every phase and milestone into the baseline, records `project.rebaselined` with the reason in the audit log and says "New baseline saved."
  - A project that left Waterfall keeps a Timeline tab while it has phases or milestones: the phases are read-only history ("Plan from the Waterfall period. Phases are kept as history and can't change; milestones stay editable."), milestones stay editable, and Edit phases and Re-baseline are hidden.
  - Every write sends `If-Match` (`428` when missing, `412` with the current plan or milestone when stale). A plain member sees the whole plan read-only with "Only owners, admins and the project lead can change the plan."; the API answers `403 insufficient_role`.

### US-E10: Edit board columns and WIP limits

- **Actor**: Workspace Owner, Admin or the project lead
- **Priority**: Must
- **Status**: Implemented (`PATCH /api/v1/projects/{projectId}/statuses/{statusId}` with `If-Match` = the project ETag; migration `0025`; screen: Board columns on the Settings tab)
- **Story**: As a planner, I want to rename board columns and set work-in-progress limits so that the board reflects how the team works.
- **Acceptance criteria**:
  - Each column shows its name, category, card count and WIP limit with its own Save. Names are 1–40 characters and unique in the project ignoring case (`409 name_taken`); a limit is empty (no limit) or 1–99.
  - A limit below the cards already in the column is refused with `409 wip_below_occupancy` and nothing is saved; the row says "4 cards are in this column; the limit can't be below that." and goes back to the saved limit.
  - A teammate's newer project version (`412`) replaces the page's copy and the row says "Updated by a teammate — review the latest values and save again."
  - Members who cannot plan have no Settings tab; opening `/settings` directly shows the columns read-only with the authority note and no Switch button. The API answers `403 insufficient_role`.

### US-E11: Switch a project's methodology

- **Actor**: Workspace Owner, Admin or the project lead
- **Priority**: Must
- **Status**: Implemented (`POST /api/v1/projects/{projectId}/methodology` with `If-Match`; the history in the `periods` of `GET /api/v1/projects/{projectId}/plan`; migration `0025`; screen: Methodology on the Settings tab and its switch wizard)
- **Story**: As a planner, I want to switch a project between Scrum, Kanban and Waterfall without losing tasks or history so that the project can change how it works as it grows.
- **Acceptance criteria**:
  - The Methodology section shows the current methodology and its history ("Kanban since Oct 18", "Scrum Oct 3–Oct 18").
  - The wizard has four steps. **1 Choose a methodology**: the three methodology cards; the current one is refused ("… already uses Scrum. Pick another way of working."). **2 Map columns**: the target template's columns are proposed; a current column with the same name and category is kept with its cards, every other current column is mapped to a target column of the same category, or must be chosen ("Choose where the cards in Backlog go."); columns can be renamed, added or removed (2 to 12), card counts are shown, and Kanban's WIP limits are proposed and editable. A limit below the cards a column would hold is refused before sending ("5 cards would be in this column; the limit can't be below that."). A kept column keeps its category; to change a category, add a new column and map to it. **3 Plan**: Scrum asks for the sprint length (1–4 weeks); Waterfall asks for the start and target dates and a phase plan (spread evenly from the template's five phases, or the phases of an earlier Waterfall period with their baselines); Kanban needs nothing. Leaving Scrum while a sprint is active is blocked ("Sprint 1 is still active. …") with "Complete sprint now", which opens the Backlog. **4 Confirm**: a summary ("4 open cards move, 3 columns removed, periods: Kanban → Waterfall"); leaving Scrum adds what happens to the plan ("2 planned sprints are cancelled and 5 open cards return to the backlog."); and a required reason (1–200).
  - The switch is one transaction: every task on a removed column moves to its target column (each with a new version, history event and outbox row), the removed columns are deleted, the open methodology period closes and a new one opens with the reason, and `project.methodology_switched` `{from, to}` is audited. Success opens the board with "Switched to Waterfall. 4 cards moved."
  - Completed sprints stay as history. Leaving Scrum cancels every planned sprint and returns its open tasks to the backlog (each with a new version, history event and outbox row); done and archived tasks keep their sprint. So entering Scrum again starts with every open task in the backlog and no stale plan. Leaving Waterfall keeps the phases read-only and the milestones usable; entering Waterfall gives tasks no phase, so they show as Unphased on the Timeline.
  - Refusals: `409 active_sprint`, `409 same_methodology`, `409 wip_below_occupancy`, `412` when a teammate changed the project (the wizard keeps the plan, adapts it to the newer columns and says "Updated by a teammate — review the latest values and save again."), `428` without `If-Match` and `403 insufficient_role` for members who cannot plan.

### US-E12: See how a project is doing, by methodology

- **Actor**: Any Workspace Member
- **Priority**: Must
- **Status**: Implemented (`GET /api/v1/projects/{projectId}/insights/summary`, `.../insights/flow`, `.../insights/cycle-time`, `.../insights/aging-wip`, `.../insights/velocity`, `.../insights/schedule`, `GET /api/v1/sprints/{sprintId}/burndown`; migration `0026`; screen: the Insights tab `/w/[slug]/p/[key]/insights`)
- **Story**: As a member of a project, I want to see progress against the plan and the charts that fit the way the project works so that I can tell early whether the work will land on time.
- **Acceptance criteria**:
  - Every member, including plain members, sees an Insights tab after Overview. Nothing on it offers a write.
  - The header has a range control (7 / 30 / 90 / 180 days, default 30, kept in `?days=`). Days are UTC calendar days ending today; anything else is refused with `400`.
  - A key-number strip shows done % with its unit, plan %, a status pill (On track green, At risk amber, Behind red, No plan grey), the forecast date ("No forecast yet" when nothing finished in the last 14 days) and the overdue count; a plan-vs-done bar puts a tick where the plan says the work should be by today. A metric counts story points when at least 80% of its tasks have points, otherwise tasks. The plan is the active sprint (Scrum), the project dates (Waterfall, and Kanban when both dates are set) or none.
  - **Scrum**: the sprint burndown (the active sprint by default, completed sprints in a picker; ideal dashed, remaining and scope per UTC day, later days empty). The ideal line burns from the base: the committed work not done when the sprint started (work finished on day 1 still counts in it; a planned sprint uses its tasks not done now), and the subtitle names committed work already done at the start, "34 points at the start, 3 already done". Velocity bars compare committed and completed for the last 6 completed sprints with the average in the same unit, and a commitment reliability table gives reliability, added and removed work and scope creep per sprint; committed work already done at the start is left out of both sides and noted ("2 already done at start"). A sprint without dates answers `409 sprint_missing_dates`.
  - **Kanban**: WIP vs limit gauges per column (columns without a limit show the count only), aging work in progress with p50/p85 bands from the last 90 days, and a cycle and lead time scatter (at most 500 points) with p50/p85 lines.
  - **Waterfall**: the schedule variance ("+6 d", latest planned phase end against the latest baseline end), phase done vs plan bars with variance badges (on baseline green, 1–7 d late amber, later red) and status, and a milestone table with Hit, Missed, At risk (due within 7 days) and Upcoming pills.
  - Always: cumulative flow by category and throughput per day; a Members table and an overdue list (at most 20) that links to the task drawer.
  - Every chart sits in a card with a legend and "View as table"; each card loads, fails and retries on its own. At 390 px cards stack and tables scroll inside their card.

### US-E13: See completion by member

- **Actor**: Any Workspace Member
- **Priority**: Must
- **Status**: Implemented (`GET /api/v1/projects/{projectId}/insights/members`, and the `members` of `GET /api/v1/workspaces/{workspaceId}/insights`; screens: the Members card on both Insights pages)
- **Story**: As a team member, I want to see what each person finished and has open so that load and deadlines are shared fairly.
- **Acceptance criteria**:
  - Rows are grouped by the current assignee with initials avatars: tasks and points completed in the range, on-time rate (completed by the due date, of those with a due date; "—" without any), open, overdue (open past the due date) and median cycle time in days.
  - Sorted by completed, then name; "Unassigned" is always last. Every active member appears, plus every departed member who still holds an assignment, so the rows add up to the project's totals; a departed member whose name the viewer can no longer read is shown as "Former member".
  - Every active member sees every row; there is no extra role gate.

### US-E14: See the whole workspace at a glance

- **Actor**: Any Workspace Member
- **Priority**: Should
- **Status**: Implemented (`GET /api/v1/workspaces/{workspaceId}/insights?days`; screen: `/w/[slug]/insights`, "Insights" in the sidebar next to Members)
- **Story**: As a member of a workspace, I want one page with every project's progress, every member's completion and the team's activity so that I know where help is needed.
- **Acceptance criteria**:
  - The same range control as the project page. One card per non-archived project: key, methodology tag, done % bar with a plan tick, status pill, open and overdue counts; it links to the project's Insights.
  - The Members table as in US-E13 across the workspace's non-archived projects, an activity calendar (task events per UTC day) and an overdue list across projects (at most 50, oldest due first) linking to the task drawer.
  - A workspace without projects says "No projects yet", with "Create a project" for owners and admins and plain text for members.

### US-E15: Keep metrics across a methodology switch

- **Actor**: Any Workspace Member
- **Priority**: Should
- **Status**: Implemented (`period` on `.../insights/velocity` and `.../insights/schedule`, `markers` on `.../insights/flow`, `id` on the `periods` of `GET /api/v1/projects/{projectId}/plan`; screen: the period selector on the Insights tab)
- **Story**: As a member of a project that changed methodology, I want its history to stay readable so that the switch does not erase how the team performed before.
- **Acceptance criteria**:
  - The key numbers, flow, cycle time, aging work and members span the whole history whatever the methodology. Flow charts mark each switch inside the range ("Switched Kanban → Scrum on Sep 6").
  - A project with more than one period shows a period selector ("Scrum since Sep 6", "Kanban Jul 8–Sep 6", kept in `?period=`). The methodology section follows the selected period: choosing the Kanban period shows the Kanban charts, and velocity counts only the sprints of the selected Scrum period. Cards that can only show the present (WIP, aging work, phases and milestones) add "Current board" or "Current plan" to their subtitle when a past period is selected. An unknown or foreign period answers `404 period_not_found`.
  - A member of another workspace who asks for any insight of a project, sprint, period or workspace gets `404` and no number from it.

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
| US-05 | US-E4 to US-E15 | Journey 3 |
| US-06 | US-F1, US-F2 | Journey 3 |
| US-07 | US-G1, US-G2, US-G3 | Journey 4 |
| Auth and governance | US-A1 to US-A5, US-H1 to US-H4, US-I1 | Journeys 5 and 6 |

## Definition of done

Each story follows the definition of done in [context.md](../context.md#definition-of-done): working acceptance criteria, matching API contracts, tested authorization and data invariants, reversible or documented migrations, no sensitive logging, and passing applicable repository checks.
