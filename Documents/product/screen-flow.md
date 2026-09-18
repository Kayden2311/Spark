# Spark screen flow

## Purpose

This document is the source of truth for the product screen sequence. Screens use hardcoded mock data until their API contract, authorization rule, and persistence are implemented.

## Design principles

- Start from a user goal, not a navigation item.
- Keep one primary action per screen and preserve the user's context when moving between screens.
- Use readable, low-noise workspace layouts with a clear ownership and state signal.
- Keep mock data visibly representative; do not present it as live product activity.

## Journey 1: Discover a community

| Step | Route | Goal | Primary action | Mockup state |
| --- | --- | --- | --- | --- |
| 1 | `/` | Understand Spark's purpose | Browse communities | Existing landing |
| 2 | `/communities` | Find a relevant public community | Open community | Build now |
| 3 | `/communities/[slug]` | Evaluate community fit and activity | Request access | Build now |
| 4 | `/communities/[slug]/request` | Confirm a membership request | Send request | Planned |
| 5 | `/communities/[slug]/request/sent` | Confirm the request state | Return to discovery | Planned |

Filters at step 2: keyword, topic, location, and startup stage. The eventual API uses deterministic cursor pagination; the mockup shows a finite sample only.

## Journey 2: Join and collaborate

| Step | Route | Goal | Primary action | Mockup state |
| --- | --- | --- | --- | --- |
| 1 | Community detail | Request access to a private community | Request access | Planned interaction |
| 2 | Membership requests | Owner reviews a pending request | Approve or reject | Planned |
| 3 | Community feed | Read and publish a post | Create post | Planned |
| 4 | Post detail | Discuss a post | Add comment | Planned |

## Journey 3: Operate a workspace

| Step | Route | Goal | Primary action | Mockup state |
| --- | --- | --- | --- | --- |
| 1 | `/workspace` | See work ownership and progress | Add task | Existing mockup |
| 2 | `/schedule` | Coordinate member sessions and delivery dates | New event | Existing mockup |
| 3 | `/notifications` | Review relevant activity | Mark all as read | Existing mockup |
| 4 | `/billing` | Review workspace plan usage | Upgrade plan | Existing mockup |

## Journey 4: Moderate content

| Step | Route | Goal | Primary action | Mockup state |
| --- | --- | --- | --- | --- |
| 1 | Post or comment | Report inappropriate content | Submit report | Planned |
| 2 | Moderator queue | Review authorized reports | Resolve report | Planned |
| 3 | Moderation record | Preserve actor, target, reason, and time | Return to queue | Planned |

## Journey 5: Authentication and account access

| Step | Route | Goal | Primary action | Mockup state |
| --- | --- | --- | --- | --- |
| 1 | `/login` | Authenticate into Spark | Sign in with email/password or OAuth (GitHub, Google) | Implemented (UI/UX Pro Max) |
| 2 | `/login` (Sign out) | Terminate current session | Revoke session & clear cookie | Implemented |
| 3 | `/signup` | Register new user account | Submit credentials | Planned |
| 4 | `/forgot-password` | Initiate password recovery | Request reset token | Planned |

## Journey 6: Platform governance and moderation

| Step | Route | Goal | Primary action | Mockup state |
| --- | --- | --- | --- | --- |
| 1 | `/admin` | Global platform administration | Select governance domain (Communities, Reports, Campaigns, Users) | Implemented (Platform Admin Console) |
| 2 | `/admin` (Communities) | Moderate communities across platform | Feature, freeze, or archive community | Implemented |
| 3 | `/admin` (Reports) | Resolve flagged content & violations | Dismiss or take action | Implemented |
| 4 | `/admin` (Campaigns) | Review sponsored startup promotions | Approve or reject campaign | Implemented |
| 5 | `/admin` (Users) | Manage platform user status | Suspend, reactivate, or audit roles | Implemented |

## Delivery order

1. [Implemented] Landing page showcase with interactive live previews and responsive navigation.
2. [Implemented] Production-ready `/login` page with dark glassmorphism, OAuth suite, and Fastify REST auth backend.
3. [Implemented] Platform Governance Console at `/admin` for multi-role platform moderation (`super_admin`, `platform_admin`, `community_moderator`, `content_moderator`, `campaign_moderator`).
4. Discovery list and community detail mockups (`/communities`, `/communities/[slug]`).
5. Membership request and pending-state mockups.
6. Community feed and post detail mockups.
7. Refine the existing workspace mockups (`/workspace`, `/schedule`, `/notifications`, `/billing`).
8. Add API contracts and authorization only when the corresponding story is scheduled.

## Mock data rules

- All names, counts, tasks, and activity dates are illustrative.
- Buttons may navigate between mockup screens, but no mutation is simulated as persisted.
- Empty, loading, error, and authorization states are designed when their real behavior is implemented.
