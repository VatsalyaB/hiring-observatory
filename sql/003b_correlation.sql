-- Q13 · correlation IDs. Closes the "coordination / evidence failure" gap.
--
-- Git history proves WHAT changed but not WHICH RUN caused it. Without a correlation ID, an
-- aggregate that looks wrong three months from now cannot be traced back to the run that produced
-- it — you can see the commit, but not which source fetch, which extractor version, or which
-- workflow attempt is responsible.
--
-- Added NOW, before M2 builds adapters, because it is a nullable column on an empty table today and
-- a migration over hundreds of thousands of rows later.
--
-- Numbered 003b (D-010 convention) so Task 5a's planned 004_heartbeats.sql keeps its number.
-- The runner sorts by filename: 003_error_privacy < 003b_correlation < 004_heartbeats.

-- The correlation hub. One row per pipeline run, created at run start so rows can reference it.
--
-- DELIBERATELY has no free-text or jsonb column. Under invariant 8, anything that can carry
-- source-derived content is private by default — so error detail goes to private.ingest_errors and
-- this table stays structurally incapable of leaking a payload fragment. That is a design
-- constraint, not an oversight: do not add a `notes` column here.
create table if not exists public.ingest_runs (
  run_id        text primary key,      -- GITHUB_RUN_ID in CI, 'local-<timestamp>' when run by hand
  workflow      text not null,
  run_attempt   integer,
  commit_sha    text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  outcome       text check (outcome in ('running','success','partial','failed')),
  rows_inserted integer,
  files_written integer
);

create index if not exists ingest_runs_started_idx on public.ingest_runs (started_at desc);

-- Provenance on raw. Nullable: the pre-existing probe row has no run, and rows loaded from git
-- before this existed cannot be retro-attributed honestly.
--
-- NOT part of the unique key. The key stays (source_id, source_ref, payload_hash) so idempotency is
-- unaffected — re-fetching an unchanged advert in a later run must still be a no-op, not a new row.
-- With ON CONFLICT DO NOTHING the FIRST run's id therefore persists, which is the correct meaning:
-- provenance of first observation.
alter table public.raw_listings
  add column if not exists ingest_run_id text references public.ingest_runs(run_id);

alter table private.raw_listings
  add column if not exists ingest_run_id text references public.ingest_runs(run_id);

create index if not exists raw_listings_run_idx on public.raw_listings (ingest_run_id);

comment on column public.raw_listings.ingest_run_id is
  'Run that FIRST observed this payload. Not part of the idempotency key — a later run re-fetching '
  'the same advert is a no-op and does not overwrite this. See Q13 / 003b_correlation.sql.';

-- Fail-closed grants, matching the precedent set for `sources` in 003_error_privacy.sql: a column
-- added here in future must be invisible to publisher until deliberately granted.
grant select (
  run_id, workflow, run_attempt, commit_sha,
  started_at, finished_at, outcome, rows_inserted, files_written
) on public.ingest_runs to publisher;

grant select (ingest_run_id) on public.raw_listings to publisher;
