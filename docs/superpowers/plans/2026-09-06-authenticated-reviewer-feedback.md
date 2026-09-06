# Authenticated Reviewer Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GitHub-authenticated, rate-limited feedback whose pending and rejected records remain private until a configured moderator approves them.

**Architecture:** Keep the dashboard static on GitHub Pages. Use Supabase PostgreSQL for identity-linked feedback and RLS, one Supabase Edge Function for moderator-only operations, and a small bundled browser module for auth and UI. Credential-free Node/PostgreSQL checks run in CI; hosted OAuth is proven by a final two-account smoke test.

**Tech Stack:** Node.js 22+, plain browser ES modules, `@supabase/supabase-js` 2.115.0, esbuild 0.28.2, PostgreSQL/Supabase RLS, Supabase Edge Functions, GitHub OAuth PKCE

**Spec:** `docs/superpowers/specs/2026-09-06-authenticated-reviewer-feedback-design.md`

## Global Constraints

- Any GitHub user may submit; anonymous users may only read approved feedback.
- New rows start `pending` and are visible only to their author and configured moderators.
- Moderator logins come only from the `MODERATOR_GITHUB_LOGINS` Supabase secret.
- Categories are exactly `useful`, `unclear`, `evidence_concern`, and `suggestion`.
- Comments are trimmed plain text, 1–2,000 characters; feedback never uses `innerHTML`.
- Limit each author to five accepted submissions in a rolling 60-minute window.
- Targets are `project`, `release`, or `claim` and must exist in the server-side target registry.
- Only `pending → approved` and `pending → rejected` are valid moderation transitions.
- No attachments, Markdown, replies, notifications, editing, deletion, framework, separate API server, or required Docker setup.
- The evidence dashboard must remain useful when Supabase is absent, paused, or unreachable.
- Never store or export GitHub provider tokens, OAuth secrets, service-role keys, or moderator values.
- Preserve the existing explicit public-export allowlist.

---

### Task 1: PostgreSQL feedback contract and RLS

**Files:**
- Create: `supabase/migrations/202609060001_reviewer_feedback.sql`
- Create: `scripts/verify-reviewer-feedback-schema.mjs`
- Modify: `package.json`
- Modify: `public/package.json`

**Interfaces:**
- Produces: `public.reviewer_profiles`, `public.feedback_targets`, `public.reviewer_feedback`
- Produces: `public.submit_reviewer_feedback(text, text, text, text) returns uuid`
- Produces: browser-safe SELECT access on `reviewer_feedback`; no browser INSERT/UPDATE/DELETE grants
- Consumes: Supabase `auth.users`, `auth.uid()`, and roles `anon`, `authenticated`, `service_role`

- [ ] **Step 1: Write the failing schema verifier**

Create `scripts/verify-reviewer-feedback-schema.mjs` with `node:assert/strict`, `pg`, and the existing connection helpers from `scripts/lib/verify.mjs`. Have it read the migration, fail if the file is absent, and then execute it against an isolated transaction after creating minimal `auth.users`, `auth.uid()`, and role stubs when they do not exist.

The behavioural assertions must cover this exact matrix:

```js
assert.equal(await visibleCount(anonymous), 0);
assert.equal(await visibleCount(authorA), 1);       // own pending
assert.equal(await visibleCount(authorB), 0);       // another user's pending
await assert.rejects(() => directInsert(authorA), /permission denied/i);
await assert.rejects(() => directUpdate(authorA), /permission denied/i);
await assert.rejects(() => directDelete(authorA), /permission denied/i);
await assert.rejects(() => submit(authorA, { category: 'other' }), /category/i);
await assert.rejects(() => submit(authorA, { targetKey: 'missing' }), /target/i);
await assert.rejects(() => submit(authorA, { comment: ' '.repeat(3) }), /comment/i);
await assert.rejects(() => submit(authorA, { comment: 'x'.repeat(2001) }), /comment/i);
for (let index = 0; index < 4; index += 1) {
  await submit(authorA, { comment: `accepted ${index}` });
}
await assert.rejects(() => submit(authorA, { comment: 'sixth in one hour' }), /rate|60 minutes/i);
```

Add `"verify:reviewer-feedback-schema": "node --env-file=.env scripts/verify-reviewer-feedback-schema.mjs"` to both package manifests and append it to root `verify` and public `verify:public`.

- [ ] **Step 2: Run the verifier and confirm the red state**

Run: `npm run verify:reviewer-feedback-schema`

Expected: FAIL because `supabase/migrations/202609060001_reviewer_feedback.sql` does not exist.

- [ ] **Step 3: Add the minimum schema**

Create the migration with these objects and constraints:

```sql
create table public.reviewer_profiles (
  user_id uuid primary key references auth.users(id),
  github_user_id text not null unique,
  github_login text not null check (github_login ~ '^[A-Za-z0-9-]{1,39}$'),
  created_at timestamptz not null default now()
);

create table public.feedback_targets (
  target_type text not null check (target_type in ('project','release','claim')),
  target_key text not null,
  label text not null check (length(label) between 1 and 160),
  active boolean not null default true,
  primary key (target_type, target_key)
);

create table public.reviewer_feedback (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.reviewer_profiles(user_id),
  github_user_id text not null,
  github_login text not null,
  target_type text not null,
  target_key text not null,
  category text not null check (category in ('useful','unclear','evidence_concern','suggestion')),
  comment text not null check (comment = btrim(comment) and length(comment) between 1 and 2000),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  moderated_at timestamptz,
  moderated_by_login text,
  moderator_note text check (moderator_note is null or length(moderator_note) <= 2000),
  foreign key (target_type, target_key) references public.feedback_targets,
  check (
    (status = 'pending' and moderated_at is null and moderated_by_login is null and moderator_note is null)
    or (status in ('approved','rejected') and moderated_at is not null and moderated_by_login is not null)
  )
);
```

Add a security-definer `auth.users` insert trigger that accepts only `raw_app_meta_data.provider = 'github'` and copies the initial provider ID (`provider_id`, falling back to `sub`) and `user_name` into `reviewer_profiles`. Use `set search_path = ''` and schema-qualified names.

Seed these active targets with `on conflict do nothing`:

```text
project / hiring-observatory
release / ats-panel-pilot-2026-08-13
claim / ats-panel-pilot-2026-08-13:observable-demand
claim / ats-panel-pilot-2026-08-13:employer-breadth
```

Implement `submit_reviewer_feedback` as a security-definer function that requires `auth.uid()`, validates the active target, takes `pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0))`, counts the caller's rows from the previous hour, rejects count `>= 5`, and inserts snapshots from `reviewer_profiles`. Revoke default function execution and grant it only to `authenticated`.

Enable and force RLS on all three tables. Grant browser roles only these feedback columns:

```text
id, github_login, target_type, target_key, category, comment, status, created_at, moderated_at
```

The SELECT policy is exactly:

```sql
using (status = 'approved' or author_id = auth.uid())
```

Do not grant browser roles any access to `reviewer_profiles`, writes to `feedback_targets`, feedback writes, `author_id`, `github_user_id`, `moderated_by_login`, or `moderator_note`.

- [ ] **Step 4: Run schema checks green**

Run: `npm run verify:reviewer-feedback-schema`

Expected: PASS with anonymous/authenticated visibility, invalid-input, direct-write, five-per-hour, and sixth-submission checks all green.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/202609060001_reviewer_feedback.sql scripts/verify-reviewer-feedback-schema.mjs package.json public/package.json
git commit -m "feat(feedback): enforce moderated review storage"
```

---

### Task 2: Moderator policy and Edge Function

**Files:**
- Create: `supabase/functions/moderate-feedback/policy.mjs`
- Create: `supabase/functions/moderate-feedback/index.ts`
- Create: `scripts/verify-reviewer-feedback-function.mjs`
- Modify: `package.json`
- Modify: `public/package.json`

**Interfaces:**
- Produces: `parseModeratorLogins(value: string): Set<string>`
- Produces: `isModerator(login: string, allowed: Set<string>): boolean`
- Produces: `parseDecision(body: unknown): { id: string, decision: 'approved'|'rejected', note: string|null }`
- Produces: `GET /functions/v1/moderate-feedback` and `POST /functions/v1/moderate-feedback`
- Consumes: `Authorization: Bearer <Supabase JWT>`, `MODERATOR_GITHUB_LOGINS`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`

- [ ] **Step 1: Write the failing policy/function verifier**

Test exact normalization and validation without starting Deno:

```js
assert.deepEqual([...parseModeratorLogins(' Maintainer-One,maintainer-two,maintainer-one ')], ['maintainer-one','maintainer-two']);
assert.equal(isModerator('MAINTAINER-ONE', new Set(['maintainer-one'])), true);
assert.deepEqual(parseDecision({ id: UUID, decision: 'approved', note: 'checked' }), {
  id: UUID, decision: 'approved', note: 'checked',
});
assert.throws(() => parseDecision({ id: UUID, decision: 'pending' }), /decision/i);
assert.throws(() => parseDecision({ id: 'not-a-uuid', decision: 'rejected' }), /id/i);
assert.throws(() => parseDecision({ id: UUID, decision: 'rejected', note: 'x'.repeat(2001) }), /note/i);
```

Also read `index.ts` and assert it calls `auth.getUser(jwt)`, checks a GitHub identity, reads `MODERATOR_GITHUB_LOGINS`, uses the service-role key only after authorization, filters updates by `.eq('status', 'pending')`, and returns `409` when no pending row changed.

Add `"verify:reviewer-feedback-function": "node scripts/verify-reviewer-feedback-function.mjs"` to both package manifests and append it to root `verify` and public `verify:public`.

- [ ] **Step 2: Run the verifier red**

Run: `node scripts/verify-reviewer-feedback-function.mjs`

Expected: FAIL because the policy module and Edge Function do not exist.

- [ ] **Step 3: Implement pure policy helpers**

Use only platform APIs. `parseModeratorLogins` trims, lowercases, removes empty values, validates GitHub-login syntax, and deduplicates. `parseDecision` accepts only a UUID, `approved|rejected`, and a trimmed optional note up to 2,000 characters.

- [ ] **Step 4: Implement the one Edge Function**

Use `npm:@supabase/supabase-js@2.115.0`. Handle `OPTIONS`, then:

```text
GET  -> validate caller -> list pending rows oldest first
POST -> validate caller -> parse body -> update where id matches and status is pending
other methods -> 405
```

Resolve the login from the verified user's GitHub identity, never from request JSON or editable user metadata. Allow only `https://vatsalyab.github.io`, `http://localhost:8000`, and `http://127.0.0.1:8000`. Return JSON with generic `401`, `403`, `409`, and `500` messages; never return tokens, environment values, stack traces, or raw Supabase errors.

- [ ] **Step 5: Run the verifier green and commit**

Run: `node scripts/verify-reviewer-feedback-function.mjs`

Expected: PASS for normalization, invalid input, authorization ordering, conditional transition, CORS, and error privacy.

```bash
git add supabase/functions/moderate-feedback scripts/verify-reviewer-feedback-function.mjs package.json public/package.json
git commit -m "feat(feedback): add moderator decision endpoint"
```

---

### Task 3: Browser feedback client and safe session storage

**Files:**
- Create: `public/docs/evidence/feedback-config.mjs`
- Create: `public/docs/evidence/feedback-core.mjs`
- Create: `public/docs/evidence/feedback.mjs`
- Create: `scripts/build-feedback.mjs`
- Create: `scripts/verify-reviewer-feedback-client.mjs`
- Generate: `public/docs/evidence/feedback.bundle.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `public/package.json`

**Interfaces:**
- Produces: `buildFeedbackTargets(release): Array<{type,key,label}>`
- Produces: `createTokenFilteringStorage(storage): Storage`
- Produces: `renderPlainText(node, value): void`
- Produces: `createFeedbackApi(client)` with `list()`, `submit(input)`, `listPending()`, and `decide(input)`
- Produces: `bootFeedback({ document, location, fetch }): Promise<void>`
- Consumes: `release_id` and `insights[].id` from `data/pilot.json`

- [ ] **Step 1: Write the failing client verifier**

Test the pure contract with Node's built-in assertions:

```js
assert.deepEqual(buildFeedbackTargets(release), [
  { type: 'project', key: 'hiring-observatory', label: 'Hiring Observatory project' },
  { type: 'release', key: release.release_id, label: release.release_id },
  { type: 'claim', key: `${release.release_id}:observable-demand`, label: '469 observable vacancies across complete pilot captures.' },
]);

const sink = { value: null, setItem(_key, value) { this.value = JSON.parse(value); } };
createTokenFilteringStorage(sink).setItem('session', JSON.stringify({
  access_token: 'supabase-access', refresh_token: 'supabase-refresh',
  provider_token: 'github-access', provider_refresh_token: 'github-refresh',
}));
assert.equal(sink.value.provider_token, undefined);
assert.equal(sink.value.provider_refresh_token, undefined);
assert.equal(sink.value.access_token, 'supabase-access');

const node = { textContent: '', set innerHTML(_) { throw new Error('unsafe'); } };
renderPlainText(node, '<img src=x onerror=alert(1)>');
assert.equal(node.textContent, '<img src=x onerror=alert(1)>');
```

Assert disabled configuration performs no Supabase or evidence request and renders a non-blocking unavailable state.

- [ ] **Step 2: Run the verifier red**

Run: `node scripts/verify-reviewer-feedback-client.mjs`

Expected: FAIL because the feedback modules do not exist.

- [ ] **Step 3: Add pinned browser dependencies and builder**

Run:

```bash
npm install --save-exact @supabase/supabase-js@2.115.0
npm install --save-dev --save-exact esbuild@0.28.2
```

Mirror the exact dependency and devDependency entries in `public/package.json`. Add:

```json
"build:feedback": "node scripts/build-feedback.mjs",
"verify:reviewer-feedback-client": "node scripts/verify-reviewer-feedback-client.mjs"
```

Add both scripts to both package manifests, and append the verifier to root `verify` and public `verify:public`.

`scripts/build-feedback.mjs` bundles `public/docs/evidence/feedback.mjs` to `feedback.bundle.js` with `bundle: true`, `format: 'esm'`, `platform: 'browser'`, `target: 'es2022'`, `minify: true`, and a legal-comment banner naming the MIT-licensed Supabase client.

- [ ] **Step 4: Implement the browser modules**

`feedback-config.mjs` exports an immutable disabled config until hosted setup:

```js
export const feedbackConfig = Object.freeze({
  enabled: false,
  supabaseUrl: '',
  supabasePublishableKey: '',
  functionName: 'moderate-feedback',
});
```

`feedback-core.mjs` implements the interfaces above. The storage adapter recursively removes only `provider_token` and `provider_refresh_token` from JSON values before delegating to `localStorage`; it preserves Supabase access and refresh tokens. API errors map to short user-safe messages.

`feedback.mjs` creates the Supabase client with `flowType: 'pkce'`, the filtering storage adapter, automatic refresh, and session persistence. It requests GitHub sign-in without an optional `scopes` value, fetches the evidence bundle once, and delegates all comment rendering to `renderPlainText`/`textContent`.

- [ ] **Step 5: Build and verify green**

Run:

```bash
npm run build:feedback
npm run verify:reviewer-feedback-client
```

Expected: PASS for target IDs, disabled mode, token stripping, validation, API calls, and inert XSS-shaped text. Run `npm run build:feedback` again and expect `git diff --exit-code -- public/docs/evidence/feedback.bundle.js` after staging the generated artifact.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json public/package.json scripts/build-feedback.mjs scripts/verify-reviewer-feedback-client.mjs public/docs/evidence/feedback-config.mjs public/docs/evidence/feedback-core.mjs public/docs/evidence/feedback.mjs public/docs/evidence/feedback.bundle.js
git commit -m "feat(feedback): add secure browser client"
```

---

### Task 4: Accessible feedback and moderation interface

**Files:**
- Modify: `public/docs/evidence/index.html`
- Modify: `public/docs/evidence/styles.css`
- Modify: `public/docs/evidence/feedback.mjs`
- Modify: `public/docs/evidence/feedback.bundle.js`
- Modify: `scripts/verify-evidence-dashboard.mjs`
- Modify: `scripts/verify-reviewer-feedback-client.mjs`

**Interfaces:**
- Consumes: Task 3 `bootFeedback` and `createFeedbackApi`
- Produces: project/release/claim feedback form, public feedback list, “Your feedback”, and moderator queue

- [ ] **Step 1: Add failing UI contract checks**

Assert `index.html` contains:

```html
<section id="reviewer-feedback" aria-labelledby="feedback-title">
<form id="feedback-form">
<select id="feedback-target" required>
<select id="feedback-category" required>
<textarea id="feedback-comment" maxlength="2000" required>
<output id="feedback-characters" for="feedback-comment">
<div id="feedback-status" role="status" aria-live="polite">
<section id="moderation-queue" hidden>
```

Extend the fake-DOM tests to prove keyboard-submit handling, remaining-character updates, focus restoration after the sign-in prompt, and comments assigned through `textContent` only.

- [ ] **Step 2: Run UI checks red**

Run: `npm run verify:evidence-dashboard && npm run verify:reviewer-feedback-client`

Expected: FAIL on missing feedback landmarks and behaviours.

- [ ] **Step 3: Add the static semantic structure**

Place the feedback section after `engineering-proof` and before `methodology`, keeping it below actionable evidence and outside the KPI/readout grid. Include sign-in/sign-out controls, target/category/comment fields, attribution warning, public list, own-status list, and a moderator queue hidden by default.

Load the generated client beside the existing dashboard module:

```html
<script type="module" src="./dashboard.mjs"></script>
<script type="module" src="./feedback.bundle.js"></script>
```

- [ ] **Step 4: Implement interaction and accessible states**

On boot:

1. If config is disabled, show “Reviewer feedback is not connected yet.” and stop without blocking dashboard boot.
2. Otherwise load approved feedback and current session concurrently.
3. Show submission controls only for a signed-in user.
4. Call `submit_reviewer_feedback`; append the returned pending item under “Your feedback”.
5. Probe the moderator GET endpoint after sign-in; keep the queue hidden on `403`.
6. Approve/reject with one POST, disable controls while pending, announce the result, and remove the decided item.
7. On network failure, retain entered text and expose a retry action.

Use real `<label>` elements, visible focus, `aria-live`, `aria-busy`, disabled-button states, and focus restoration. Build every feedback row with `createElement` and `textContent`; do not interpolate feedback into HTML strings.

- [ ] **Step 5: Style within the existing design system**

Reuse current color, spacing, border, typography, button and focus tokens. Add only feedback-specific layout selectors. At wide widths, show the form and public list as a balanced two-column work area; below the existing breakpoint, stack them. Do not add KPI cards, decorative charts, gradients, or animation.

- [ ] **Step 6: Build, verify, and commit**

Run:

```bash
npm run build:feedback
npm run verify:evidence-dashboard
npm run verify:reviewer-feedback-client
```

Expected: all PASS, including XSS-shaped comment rendering and disabled/unreachable-service behaviour.

```bash
git add public/docs/evidence/index.html public/docs/evidence/styles.css public/docs/evidence/feedback.mjs public/docs/evidence/feedback.bundle.js scripts/verify-evidence-dashboard.mjs scripts/verify-reviewer-feedback-client.mjs
git commit -m "feat(feedback): add accessible review workflow"
```

---

### Task 5: Public export, CI, setup, and operational smoke test

**Files:**
- Create: `docs/FEEDBACK-SETUP.md`
- Create: `docs/FEEDBACK-SMOKE.md`
- Modify: `public/docs/evidence/README.md`
- Modify: `.env.example`
- Modify: `config/public-export.json`
- Modify: `scripts/verify-public-export.mjs`
- Modify: `public/.github/workflows/verify.yml`
- Modify: `package.json`
- Modify: `public/package.json`

**Interfaces:**
- Produces: reproducible no-Docker remote setup with `npx supabase@2.116.0`
- Produces: two-account smoke checklist proving OAuth, privacy, moderation, rate limiting, and public rendering
- Consumes: all files and commands from Tasks 1–4

- [ ] **Step 1: Add a failing public-export coverage check**

Extend `scripts/verify-public-export.mjs` with a required-destinations assertion:

```js
for (const destination of REQUIRED_FEEDBACK_DESTINATIONS) {
  assert.equal(exportMap.files.some((entry) => entry.destination === destination), true, destination);
}
```

Set `REQUIRED_FEEDBACK_DESTINATIONS` to every destination listed in Step 2.

Run: `npm run verify:public-export`

Expected: FAIL on the first feedback destination missing from the explicit export map.

- [ ] **Step 2: Add every safe feedback artifact to the export map**

Add explicit source/destination entries for:

```text
docs/FEEDBACK-SETUP.md
docs/FEEDBACK-SMOKE.md
docs/superpowers/specs/2026-09-06-authenticated-reviewer-feedback-design.md
docs/superpowers/plans/2026-09-06-authenticated-reviewer-feedback.md
supabase/migrations/202609060001_reviewer_feedback.sql
supabase/functions/moderate-feedback/policy.mjs
supabase/functions/moderate-feedback/index.ts
public/docs/evidence/feedback-config.mjs -> docs/evidence/feedback-config.mjs
public/docs/evidence/feedback-core.mjs -> docs/evidence/feedback-core.mjs
public/docs/evidence/feedback.mjs -> docs/evidence/feedback.mjs
public/docs/evidence/feedback.bundle.js -> docs/evidence/feedback.bundle.js
scripts/build-feedback.mjs
scripts/verify-reviewer-feedback-schema.mjs
scripts/verify-reviewer-feedback-function.mjs
scripts/verify-reviewer-feedback-client.mjs
```

Keep secret values, `.env`, local auth sessions, service keys, OAuth secrets, and moderator logins unlisted.

- [ ] **Step 3: Write exact hosted setup documentation**

Document these commands without requiring Docker:

```bash
npx supabase@2.116.0 login
read -r -p "Supabase project ref: " SUPABASE_PROJECT_REF
test -n "$SUPABASE_PROJECT_REF"
npx supabase@2.116.0 link --project-ref "$SUPABASE_PROJECT_REF"
npx supabase@2.116.0 db push
read -r -p "Moderator GitHub login: " MODERATOR_GITHUB_LOGIN
test -n "$MODERATOR_GITHUB_LOGIN"
npx supabase@2.116.0 secrets set MODERATOR_GITHUB_LOGINS="$MODERATOR_GITHUB_LOGIN"
npx supabase@2.116.0 functions deploy moderate-feedback --no-verify-jwt
```

Explain that `--no-verify-jwt` delegates JWT validation to the function's explicit `auth.getUser(jwt)` call and is not anonymous moderation. Construct the GitHub OAuth callback as `https://${SUPABASE_PROJECT_REF}.supabase.co/auth/v1/callback`; record the Pages and localhost redirect allowlists, the two public config values, Pages source `main /docs`, and how to return `feedback-config.mjs` to `enabled: false` safely.

`.env.example` may name `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `MODERATOR_GITHUB_LOGINS` with empty/example values, but must label the moderator value and every secret as non-committable. Do not add service-role or OAuth secret placeholders to the browser config.

- [ ] **Step 4: Add the CI gates**

After `npm ci` in `public/.github/workflows/verify.yml`, run:

```yaml
- name: build and verify reviewer feedback
  run: |
    npm run build:feedback
    npm run verify:reviewer-feedback-function
    npm run verify:reviewer-feedback-client
```

Keep schema verification in `verify:public`, where the existing PostgreSQL service is available. Preserve the final `git diff --exit-code` so a stale generated bundle fails CI.

- [ ] **Step 5: Write and run the hosted smoke checklist**

`docs/FEEDBACK-SMOKE.md` must require a non-production Supabase project and two GitHub accounts: one ordinary reviewer and one login present in `MODERATOR_GITHUB_LOGINS`. Check, in order:

1. anonymous approved-list access and blocked submission;
2. GitHub consent shows no optional repo/org/email/write scope;
3. author submits an XSS-shaped plain-text comment to a valid claim and sees pending;
4. anonymous and the second non-author session cannot see it;
5. ordinary reviewer receives `403` from the moderation function;
6. moderator sees it, approves once, and a repeated decision receives `409`;
7. anonymous sees the exact inert text and GitHub login, with no private IDs/note;
8. a second item is rejected and remains private;
9. from the moderator account, which has not submitted feedback yet, five rapid submissions succeed and the sixth returns a retry time;
10. disabling network access leaves the evidence dashboard working with a retryable feedback state;
11. browser storage contains Supabase session tokens but no `provider_token` or `provider_refresh_token` keys.

Do not enable production feedback until every item is recorded with date, Supabase project ref, dashboard commit SHA, ordinary login, moderator login, and pass/fail result.

- [ ] **Step 6: Run the complete local and export gates**

Run:

```bash
npm run build:feedback
npm run verify
npm run verify:workflows
npm run verify:public-export
PUBLIC_EXPORT_CHECK_DIR="$(mktemp -d)"
npm run export:public -- "$PUBLIC_EXPORT_CHECK_DIR"
npm run scan:secrets
git diff --check
```

Expected: every command exits `0`, the generated bundle is unchanged after rebuilding, the public tree contains only allowlisted artifacts, and secret scanning reports no finding.

- [ ] **Step 7: Commit**

```bash
git add docs/FEEDBACK-SETUP.md docs/FEEDBACK-SMOKE.md public/docs/evidence/README.md .env.example config/public-export.json scripts/verify-public-export.mjs public/.github/workflows/verify.yml package.json public/package.json docs/superpowers/plans/2026-09-06-authenticated-reviewer-feedback.md
git commit -m "docs(feedback): add free hosted rollout guide"
```

---

### Task 6: Final review and pull request

**Files:**
- Review: all files changed since `origin/main`

**Interfaces:**
- Consumes: Tasks 1–5 and either a completed hosted smoke record or an explicit blocked status awaiting owner-created credentials
- Produces: one reviewable feature branch and pull request; no merge without green CI

- [ ] **Step 1: Review the final branch boundary**

Run:

```bash
git status --short
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: clean worktree; only the design, plan, feedback implementation, tests, public-export changes, and setup docs are present.

- [ ] **Step 2: Re-run fresh verification**

Run the complete Task 5 Step 6 command set again. Do not rely on earlier output.

- [ ] **Step 3: Push and create the pull request**

```bash
git push -u origin codex/authenticated-reviewer-feedback
gh pr create --base main --head codex/authenticated-reviewer-feedback --title "feat(feedback): add authenticated moderated reviews" --body "## Summary
- add GitHub-authenticated, RLS-protected reviewer feedback
- add moderator-only approve/reject workflow
- keep GitHub Pages static and use Supabase Free without Docker

## Verification
- npm run verify
- npm run verify:workflows
- npm run verify:public-export
- npm run scan:secrets

## Deployment
Hosted activation and the two-account smoke gate are documented in docs/FEEDBACK-SETUP.md and docs/FEEDBACK-SMOKE.md. The static dashboard remains functional while feedback is disabled."
```

The PR body must summarize the user workflow, RLS/moderator boundary, free/no-Docker deployment, tests run, hosted-smoke status, and the exact manual configuration still required. If the hosted smoke is blocked on owner-created credentials, mark that gate explicitly instead of claiming the live workflow is verified.

- [ ] **Step 4: Wait for CI and address failures at root cause**

Run: `gh pr checks --watch`

Expected: all required checks pass. Do not merge unless the user asks after reviewing the PR.
