# Authenticated Reviewer Feedback — Design

**Date:** 2026-09-06
**Status:** Approved in conversation; awaiting review of this written specification
**Owner:** Vatsalya Baranwal

## 1. Decision

Add an open-source reviewer-feedback workflow to the evidence dashboard. Any GitHub user may sign
in and submit feedback. New feedback is private to its author and configured moderators until a
moderator approves it; approved feedback is public and attributed to the author's GitHub login.

Use the existing static dashboard on GitHub Pages and add Supabase Free for PostgreSQL, GitHub
OAuth and one moderation Edge Function. Keep the current plain HTML, CSS and JavaScript frontend;
do not add a frontend framework or a separate API server. The project must remain usable without
Docker.

## 2. Goals

- Let reviewers respond to the whole project, a published release, or a specific published claim.
- Require GitHub authentication for submissions while leaving approved feedback publicly readable.
- Prevent unreviewed feedback from becoming public.
- Give maintainers a small moderation queue with an auditable one-way decision.
- Preserve the current public/private repository export boundary and keep all secrets out of the
  browser and Git history.
- Keep the evidence dashboard fully useful if the feedback service is unavailable or a free
  Supabase project is paused.

## 3. Non-goals

- Attachments, Markdown, rich HTML, embedded links or image uploads
- Threads, replies, votes, reactions or reviewer reputation
- Editing or deleting submitted feedback in the first version
- Email or other moderation notifications
- A general-purpose admin system, custom identity provider or provider abstraction
- A frontend framework, standalone application server or Docker-based local setup
- Reversing an approved or rejected moderation decision

Corrections are new submissions. Keeping the original record avoids hidden changes to the review
history.

## 4. Architecture

The browser continues to load the published evidence bundle and render the dashboard from static
files on GitHub Pages. A small feedback module uses the official Supabase browser client, pinned to
an exact version, for authentication, reads and submission.

Supabase provides:

- GitHub OAuth with PKCE
- PostgreSQL tables, constraints, functions and row-level security (RLS)
- one Edge Function for the moderator queue and moderation decisions

There is no application server between GitHub Pages and Supabase. PostgreSQL owns validation,
visibility and rate-limit correctness. The Edge Function exists only because moderator membership
is an environment-configured list and its service-role credential must never reach the browser.

## 5. Identity and authentication

- Only GitHub OAuth is enabled.
- The app requests no optional GitHub OAuth scopes. GitHub's default no-scope grant supplies public
  profile identity; repository, organization, email and write scopes are never requested.
- OAuth uses PKCE and exact production and local-development callback URLs.
- Provider access tokens and refresh tokens are never copied into application tables or logs. A
  small storage adapter strips `provider_token` and `provider_refresh_token` before Supabase
  persists its own session, so provider tokens exist only transiently during the OAuth callback.
- Supabase manages its own access and refresh session in browser storage. Sign-out clears it.
- A private reviewer profile captures the provider-issued GitHub user ID and login when the GitHub
  identity is first created. The GitHub ID is the stable identity; the login is an attribution
  snapshot and may become stale if the user later renames their GitHub account.
- The submission UI states before posting that approved feedback will show the GitHub login
  publicly.

Moderator authorization is independent of ordinary RLS. The Edge Function validates the Supabase
JWT, reads the trusted GitHub identity server-side, lowercases the login, and compares it with the
comma-separated `MODERATOR_GITHUB_LOGINS` Supabase secret. A matching login can list and moderate
pending feedback. All other authenticated users receive `403`.

## 6. Feedback targets

Every target is registered server-side before it can receive feedback. The registry contains a
type, stable key, display label and active flag.

| Target type | Stable key |
|---|---|
| Project | `hiring-observatory` |
| Release | the evidence bundle's `release_id` |
| Claim | `<release_id>:<insights[].id>` |

For the current pilot this yields the release target `ats-panel-pilot-2026-08-13` and claim targets
ending in `observable-demand` and `employer-breadth`. A deployment migration registers new release
and claim IDs before the corresponding dashboard is published. Deactivation prevents new
submissions but does not hide historical feedback.

The server rejects unknown, malformed or inactive targets. The client derives its available target
choices from the same published bundle but is not trusted as the validator.

## 7. Data model

Use three application tables.

`reviewer_profiles`

- Supabase user ID, primary key
- provider-issued GitHub numeric ID, unique
- GitHub login snapshot
- creation timestamp

A security-definer signup trigger creates this row from the newly established GitHub identity.
Browser roles cannot insert, update, delete or enumerate reviewer profiles.

`feedback_targets`

- `target_type`: `project`, `release` or `claim`
- `target_key`: stable key, unique with `target_type`
- `label`: plain-text display label
- `active`: whether new feedback is accepted

`reviewer_feedback`

- generated UUID
- author Supabase user ID
- GitHub numeric ID and login snapshots
- target type and key, referencing `feedback_targets`
- category: `useful`, `unclear`, `evidence_concern` or `suggestion`
- required trimmed plain-text comment, 1–2,000 characters
- status: `pending`, `approved` or `rejected`
- creation timestamp
- moderation timestamp, moderator GitHub login and optional private moderator note

Database checks constrain all enums, comment length and moderation-field consistency. Timestamps
come from PostgreSQL, not the browser. The initial status is always `pending`.

## 8. Submission and rate limiting

Authenticated users submit through one PostgreSQL function. Direct table inserts, updates and
deletes are not granted to browser roles.

The function:

1. requires `auth.uid()`;
2. trims and validates the comment;
3. validates the category and active registered target;
4. takes a transaction-scoped advisory lock for the user;
5. rejects a sixth submission in any rolling 60-minute window; and
6. inserts one pending row using the trusted reviewer profile.

The lock makes the five-per-hour limit atomic across simultaneous requests without adding another
service. A rate-limit response includes a retry time but no information about other users.

## 9. Visibility and moderation

PostgreSQL RLS and column grants enforce this matrix:

| Actor | Approved feedback | Own pending/rejected | Other pending/rejected | Moderate |
|---|---:|---:|---:|---:|
| Anonymous visitor | Read | — | No | No |
| Authenticated author | Read | Read | No | No |
| Configured moderator | Read | Read through queue | Read through queue | Yes |

Browser roles can select only public-safe fields; author IDs and private moderator notes are not
selectable. RLS exposes approved rows to everyone and unapproved rows only to their author.

The Edge Function has two authenticated operations:

- list pending feedback for the moderator queue;
- approve or reject one pending item, with an optional private note.

It uses the Supabase service-role credential only after moderator verification. The database update
requires `status = 'pending'`, so concurrent or repeated decisions cannot overwrite the first
decision. Approval makes the row public immediately. Rejection remains visible only to its author
and moderators. The moderator login and server timestamp form the audit record.

## 10. User experience

The feedback experience sits after the dashboard's actionable evidence, not among its headline
KPIs. Each eligible project, release or claim context offers a clear “Give feedback” action.

- Anonymous users can browse approved feedback and are prompted to sign in with GitHub before
  submitting.
- Signed-in users choose a category, enter up to 2,000 characters, see a remaining-character count
  and submit once.
- After submission, the item appears in “Your feedback” with a pending status and an explanation
  that it is not public yet.
- Rejected items show the decision status but not the private moderator note.
- Approved items appear in the public list with category, comment, GitHub login and submission
  date.
- Moderators get a compact queue with target context, reviewer, comment, approve/reject controls
  and an optional private-note field.

The form uses real labels, keyboard-reachable controls, visible focus, an `aria-live` status region
and focus restoration after dialogs or panels close. Comments are always inserted with
`textContent`; feedback never passes through `innerHTML` or a Markdown renderer.

If Supabase is unavailable, the dashboard data and recommendations continue to render. The
feedback area shows a short retryable unavailable state without blocking or replacing the evidence
content.

## 11. Configuration and secrets

The GitHub Pages code may contain the Supabase project URL and publishable key; both are public by
design. They live in one committed feedback configuration module so forks have one obvious place
to replace them.

The following remain outside the repository:

- GitHub OAuth client secret, configured in Supabase Auth
- Supabase service-role key, available only to the Edge Function
- `MODERATOR_GITHUB_LOGINS`, configured as a Supabase secret

Repository secret scanning and public-export verification cover all new source and deployment
files. Logs contain feedback IDs and result codes, not comments, tokens or private notes.

## 12. Public export and deployment

The canonical private repository remains the source of truth. The existing explicit public-export
manifest gains only the safe feedback files: static UI modules, SQL migrations, the Edge Function,
tests, setup documentation and this design. It never exports `.env` files, OAuth secrets, service
keys or moderator values.

Deployment uses free services:

- GitHub Pages serves the static dashboard from the public repository.
- Supabase Free hosts authentication, PostgreSQL and the Edge Function.

Local static UI development uses the existing local server plus the hosted Supabase development
project; Docker and the Supabase local stack are optional and not required. The setup guide records
the exact OAuth callback URLs, SQL migration order, Edge Function deployment command, public
configuration values and moderator-secret command.

Free-tier pausing, quota exhaustion and lack of an uptime guarantee are accepted for this portfolio
project. Those conditions degrade only feedback; the static observatory remains available.

## 13. Security and privacy

- RLS is enabled before browser access is granted.
- Anonymous and authenticated browser roles never receive service-role access.
- Moderator membership is checked from trusted provider identity on every Edge Function request.
- Server-side constraints and functions repeat every client-side validation rule.
- Comments are plain text and rendered as text, including XSS-shaped input.
- Error messages do not reveal whether another user's private feedback exists.
- CORS allows only the production GitHub Pages origin and documented local-development origins.
- Moderation writes are conditional and auditable; clients cannot alter authorship, status or
  timestamps.

The published data consists of the comment, category, target, submission date and GitHub login the
author was shown before submitting. No email address, provider token, internal user UUID or private
moderator note is public.

## 14. Verification and acceptance criteria

Automated checks cover:

- anonymous users can read approved feedback only;
- authenticated users can read approved feedback plus their own pending/rejected rows;
- one user cannot read another user's pending/rejected rows;
- direct browser-role insert, update and delete attempts fail;
- only configured GitHub moderators can list pending items or decide them;
- only `pending → approved` and `pending → rejected` succeed, once;
- invalid categories, empty/oversized comments and unregistered targets fail server-side;
- five submissions in a rolling hour succeed and the sixth is rate-limited, including concurrent
  requests;
- XSS-shaped comments are stored and rendered as inert text;
- private notes, internal IDs and secrets do not appear in anonymous responses or the public
  export;
- the static dashboard still renders when Supabase is unreachable.

CI runs the existing repository verification plus frontend and SQL contract tests that require no
remote credentials. Before deployment, a remote smoke test uses a disposable ordinary account and
a configured moderator account to prove sign-in, pending visibility, approval, public visibility
and rejection. Production release is blocked until that smoke test passes.

## 15. Rollout boundary

The first pull request delivers the schema, RLS, submission function, moderation Edge Function,
static feedback UI, public-export entries, setup documentation and credential-free tests. Enabling
the live workflow still requires the owner to create the free Supabase project and GitHub OAuth
application, apply the migrations, deploy the function, set moderator logins, add the two public
configuration values and run the documented smoke test.

No account, paid plan or Docker installation is required to review and merge the code. No live
feedback is accepted until the external configuration is complete.
