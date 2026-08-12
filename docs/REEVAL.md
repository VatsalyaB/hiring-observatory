# Re-evaluation protocol

Run against what actually landed — after the commit, never before.

## Which tier applies (D-009)

| When | What runs |
|---|---|
| **Every commit** | The light gate below. Under a minute. |
| **Milestone boundary, or before any push** | The full checklist, plus a `HANDOFF.md` update. |

### Light gate — every commit

- [ ] `npm run scan:secrets` — scans the staged **diff**, not just filenames.
      Use `scripts/scan-secrets.sh --history` before any push, and `--self-test` after editing it.
- [ ] `git status` clean
- [ ] `npm run verify` green (once it exists)
- [ ] Nothing claimed that was not run. Anything asserted but unverified is written down as
      untested, in `HANDOFF.md`, in the same breath.

That is the whole light gate. If it passes, carry on — the full checklist waits for the milestone.

> **A guard must be able to fail.** `npm run verify:guards` now does this automatically for the
> staleness view, the invariant 8 grant, the Q15 default privilege and the wall — it breaks each one
> in a scratch database and asserts the guard reports failure. **When you add a new guard, add a
> mutation case to `scripts/verify-falsifiability.mjs` in the same commit.** A guard with no
> mutation case is a guard nobody has proven can fail.
>
> **Adapter guards are the exception, and a better one.** `verify-adapter.mjs` needs no mutation
> case because its failing input is *permanent*: `adapters/fixtures/adzuna-nz.json` contains the
> same advertisement twice, differing only in a volatile field. Remove the strip and the test fails
> immediately, naming the ref. The negative case is real captured data rather than a simulation, so
> it cannot drift out of date — **when you add an adapter that strips a field, put the duplicate pair
> in the fixture.**
>
> Before trusting any new check, prove it reports failure when
> the thing it guards is actually wrong. The first version of this project's `.env` guard read
> `git show --stat HEAD | grep -c "\.env$"`, which can never match because stat lines end in
> `+++`. It returned "safe" unconditionally for as long as it existed. Test the negative case.

## Why this exists

This project runs unattended for weeks at a time, and the owner works in bursts with long gaps.
That combination means a regression introduced on one weekend can silently corrupt data until the
next session, which might be a month later. By then the cause is cold and the damage is baked
into the dataset.

The protocol also exists because the work is done partly by AI sessions that do not share memory.
A future session will not remember why something was built a certain way, and may confidently
"fix" something that was correct. These checks are the safety net for that.

## The full checklist — milestone boundaries and before any push

Work through it in order. A failure stops the process — fix, re-commit, restart the checklist.

### 1. Structural integrity

- [ ] `git status` is clean — nothing unintended left uncommitted or untracked
- [ ] The diff contains no secrets: API keys, tokens, `app_key`, `app_id`, connection strings,
      `.env` contents. Scan the actual diff, not just filenames.
- [ ] `HANDOFF.md` was updated in this commit if behaviour changed
- [ ] `docs/DECISIONS.md` has an entry if an architectural choice was made or reversed
- [ ] `npm run verify:restore` green — the backup round trip. **Now enforced by `hooks/pre-push`**,
      listed here because it was in neither place until 2026-08-09 and sat red for a day unnoticed.
      It takes its own dump, so "stale backup" is no longer a possible failure; anything it reports
      is a real defect in backup or restore. Deliberately **not** in `npm run verify` — `backups/`
      is gitignored, so CI has no dumps and it could never pass there.

### 2. The invariants (see `CLAUDE.md`)

- [ ] **Wall test passes** — the publishing DB role still gets `permission denied` when it
      attempts to read the `private` schema. This must be an executed test, not an assumption.
      If this check is not yet automated, run it by hand and note the date.
- [ ] **No raw mutation** — nothing in the diff edits or deletes from `raw_listings`
- [ ] **No hardcoded region** — grep the diff for country codes, currency symbols, `NZ`, `AU`,
      `SG`, `NZD`, hardcoded timezones. Any hit outside a config file or adapter is a defect.
- [ ] **Extractions still append-only** — no `UPDATE` or `DELETE` against `extractions`
- [ ] **Aggregates-only egress** — nothing new pushes row-level data to the public database

### 3. Pipeline health

- [ ] End-to-end run completes: trigger fires → ingest → normalise → extract → aggregate
- [ ] Every enabled source in `docs/SOURCES.md` returned a non-zero row count on its last run.
      A source that silently drops to zero is the classic failure — treat zero as a red flag,
      never as "quiet week".
- [ ] Row counts are within a sane band of the previous run. A 10x jump or a 90% drop needs an
      explanation before you move on.
- [ ] No GitHub Actions workflow left disabled or failing. Check the Actions tab — note that GitHub
      auto-disables scheduled workflows in **public** repos after 60 days without repository
      activity, and that scheduled runs can be silently *dropped* under load.

### 4. Extraction quality (once the eval set exists, M5 onward)

- [ ] Extraction eval ran against the labelled set
- [ ] Precision and recall recorded against `extractor_version`
- [ ] No regression beyond the agreed threshold versus the previous version. If quality dropped,
      the previous version stays live — versioned extractions exist precisely so you can refuse
      to ship a regression.

### 5. Fresh-eyes audit

This is the part that catches the things a checklist cannot enumerate. Read the diff as if
someone else wrote it and you are reviewing it cold.

- [ ] Does what landed actually match what the spec says? Quote the spec line if unsure.
- [ ] Was anything claimed as done that was not verified by running it? Claims without evidence
      get downgraded to "untested" in `HANDOFF.md`.
- [ ] Was any source promoted to VERIFIED without an actual call being made? Revert it.
- [ ] Is there half-built state that would confuse a session three weeks from now? Either finish
      it or write it down explicitly as in-progress.
- [ ] Did scope creep in? Compare against the milestone definition, not against what felt useful.

### 6. Record

- [ ] Append a dated line to the session log in `HANDOFF.md` — what changed, what was verified,
      what is still untested.

## For an AI session picking this up cold

Point yourself at this file and work it honestly. Two specific failure modes to guard against in
your own output:

- **Asserting rather than checking.** "The pipeline works" is worthless without the command and
  its output. Run it, paste the result.
- **Confident repair of correct code.** If something looks wrong but the decisions log explains
  it, the log wins. Raise it as a question in `HANDOFF.md` rather than silently changing it.
