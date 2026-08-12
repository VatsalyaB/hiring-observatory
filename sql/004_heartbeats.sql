-- Task 5a · liveness plumbing: `heartbeats` + the `source_staleness` view.
--
-- Silent failure is this project's primary risk. Under GitHub Actions it gets worse, not better:
-- GitHub documents that scheduled jobs may be DROPPED, not merely delayed. Nothing notifies yet —
-- the notifier belongs with M2's first real source, when there is something whose silence matters —
-- but the computation it will read exists and is proven from here.

create table if not exists public.heartbeats (
  id          bigserial   primary key,
  workflow    text        not null,
  observed_at timestamptz not null default now(),
  detail      jsonb
);

create index if not exists heartbeats_workflow_time_idx
  on public.heartbeats (workflow, observed_at desc);

comment on column public.heartbeats.detail is
  'Operational context for one run (ids, counts, timings). Potentially source-derived, therefore '
  'NOT readable by `publisher` — see the revoke below and invariant 8. Read status through the '
  'source_staleness view instead.';

-- INVARIANT 8, and a live leak rather than a theoretical one.
--
-- `002_wall.sql` line 70 runs `alter default privileges in schema public grant select on tables to
-- publisher`. So a new table in `public` is publisher-readable the instant it is created — nobody
-- has to write a grant, and nobody gets a chance to review one. `detail jsonb` is precisely the
-- free-text sink an M2 adapter reaches for when a fetch fails: a Seek response fragment, a URL
-- bearing credentials, a stack trace. That is the shape of leak D-012 closed on `sources`, and the
-- default privilege would have reopened it here silently.
--
-- The Task 5a brief said to grant `publisher` SELECT on BOTH objects. That is corrected: the role
-- gets the VIEW, which exposes only controlled status columns, and is denied the table.
-- `verify-heartbeat.mjs` asserts the denial behaviourally, so a future default-privilege change
-- cannot quietly undo it.
revoke all on public.heartbeats from publisher;
revoke all on public.heartbeats from public;

-- Status, not payload. Every column here is a boolean or a timestamp the pipeline itself sets;
-- none of it can carry source-derived content, which is why `publisher` may read it at all.
--
-- `security_invoker = true` is deliberate and load-bearing. A view runs with its OWNER's privileges
-- by default, which would let it bypass the column-scoped grants D-012 installed on `sources` — the
-- fail-open direction. With security_invoker the view reads as the CALLER, so it inherits those
-- column grants: if someone later widens this view to a sensitive column, `publisher` is denied
-- rather than silently shown it. Requires Postgres 15+; this project runs 17.
create or replace view public.source_staleness
  with (security_invoker = true)
as
select
  s.id,
  s.enabled,
  s.last_success_at,
  s.enabled
    and (s.last_success_at is null or s.last_success_at < now() - interval '48 hours')
    as is_stale
from public.sources s;

comment on view public.source_staleness is
  'Which enabled sources have gone quiet. 48h window chosen against a twice-daily schedule, so a '
  'source must miss ~4 consecutive runs before it is flagged — wide enough to absorb the dropped '
  'runs GitHub documents, narrow enough that a fortnight of loss is impossible. Revisit at M2 once '
  'the real scheduler lag is measured (Task 5c Step 3).';

grant select on public.source_staleness to publisher;
