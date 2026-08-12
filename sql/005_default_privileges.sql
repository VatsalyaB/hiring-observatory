-- Q15 · the `public` schema defaulted to publisher-readable, which is invariant 8 backwards.
--
-- THE DEFECT. `002_wall.sql` line 70 runs:
--     alter default privileges in schema public grant select on tables to publisher;
-- so every table created in `public` by `observatory` gets table-wide SELECT for `publisher` at
-- creation. No grant is written, no review happens, and nothing in the diff shows it.
--
-- THIS ALREADY BROKE A DOCUMENTED GUARANTEE, which is why it is being fixed now rather than filed.
-- `003b_correlation.sql` line 53 states: "a column added here in future must be invisible to
-- publisher until deliberately granted", and then writes correct column-scoped grants on
-- `ingest_runs`. Measured in the live database, `pg_class.relacl` for `ingest_runs` reads
-- `publisher=r/observatory` — table-wide. The default privilege had already granted everything
-- before those column grants ran, making them redundant. The stated fail-closed property was false
-- from the moment the table was created, and nothing detected it, because every test asserted that
-- publisher COULD read what it should read and none asserted the boundary.
--
-- `heartbeats` hit the same trap in 004 and was caught only because invariant 8 was being thought
-- about explicitly at the time. That is not a control; that is luck.

-- 1. Flip the default to fail-closed. New tables in `public` are now invisible to `publisher` until
--    someone writes a grant — which is the direction that makes the safe case the default and the
--    unsafe case a deliberate, reviewable act.
alter default privileges in schema public revoke select on tables from publisher;

-- 2. Restore the property `003b` claimed. Revoking the table-wide grant leaves column grants intact
--    in Postgres, but they are re-stated here so this file is self-contained and so a future reader
--    can see exactly what `publisher` is meant to have without cross-referencing two migrations.
revoke select on public.ingest_runs from publisher;
grant select (
  run_id, workflow, run_attempt, commit_sha,
  started_at, finished_at, outcome, rows_inserted, files_written
) on public.ingest_runs to publisher;

-- 3. Least privilege: the migration ledger is operational bookkeeping. The publishing pipeline has
--    no legitimate reason to read which migrations have run, and it inherited this purely from the
--    blanket grant in 002.
revoke all on public.schema_migrations from publisher;

-- 4. DELIBERATELY LEFT TABLE-WIDE, with reasons, so a later session does not "tighten" these and
--    break the pipeline believing it is completing this migration:
--
--    * `countries` — pure configuration under invariant 4 (code, currency, timezone, region). It is
--      structurally incapable of holding source-derived content, and every aggregate needs it.
--
--    * `raw_listings` — this is the PUBLIC table, and the wall's whole design is that only
--      publishable-source data lands here; anything private-class goes to `private.raw_listings`,
--      where `publisher` holds nothing. So `payload` here is publishable by construction, not by
--      permission. Invariant 8 governs private content, and this is not it.
--      Revisit at M4 if aggregates end up reading normalised `listings` instead, at which point
--      this grant may simply be unnecessary rather than unsafe.

-- 5. Not touched: `sources` (already column-scoped by D-012) and `heartbeats` (explicitly revoked in
--    004). Both are asserted by scripts/verify-default-privileges.mjs so a future default-privilege
--    change cannot quietly undo either.
