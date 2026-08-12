-- Q10 · closes a leak *through* the wall rather than around it.
--
-- The wall (002_wall.sql) protects the private DATA table. It did not protect the METADATA table.
-- `publisher` held table-wide SELECT on `public.sources`, and `sources.last_error` is free text an
-- adapter writes on failure. A failing Seek fetch could put a response fragment, a GraphQL query
-- body, or a URL bearing credentials into that column — readable by the publishing role, on a row
-- describing a private-class source. No amount of hardening the private schema catches that.
--
-- Fix: reuse the wall instead of inventing a second mechanism. Error *detail* is potentially
-- source-derived content, so it is private data and belongs behind the wall with the rest of it.
-- `sources` keeps only non-sensitive status.
--
-- Generalisable rule, now recorded in CLAUDE.md: any field that can contain source-derived content
-- is private by default, whatever table it would naturally live in.

-- 1. Status stays public; it cannot carry payload content.
alter table public.sources add column if not exists last_error_at   timestamptz;
alter table public.sources add column if not exists last_error_code text;

comment on column public.sources.last_error_code is
  'Short controlled value only (http_429, timeout, parse_failed, auth_failed). NEVER a message, '
  'body, URL or stack trace — those go to private.ingest_errors. See Q10 / 003_error_privacy.sql.';

-- 2. Detail moves behind the wall. Nothing outside `private` may reference it.
create table if not exists private.ingest_errors (
  id          bigserial primary key,
  source_id   text        not null references public.sources(id),
  occurred_at timestamptz not null default now(),
  error_code  text        not null,
  detail      text,
  payload_excerpt jsonb
);

create index if not exists ingest_errors_source_time_idx
  on private.ingest_errors (source_id, occurred_at desc);

-- 3. Drop the leaking column. Verified NULL everywhere before dropping — nothing writes it yet,
--    because no adapter exists until M2. Doing this now is free; after M2 it would need a migration
--    of live content that may already be sensitive.
alter table public.sources drop column if exists last_error;

-- 4. FAIL-CLOSED grants on `sources`. Table-wide SELECT means every future column is exposed the
--    moment it is added. Column-scoped means a new column is invisible to `publisher` until someone
--    deliberately grants it — the default now runs the safe way round.
revoke select on public.sources from publisher;
grant select (
  id, class, adapter, country_codes, auth_type, rate_limit_per_min,
  publishable, enabled, last_success_at, last_error_at, last_error_code
) on public.sources to publisher;

-- 5. Belt and braces: private is already unreachable for publisher via schema USAGE, but state it.
revoke all on private.ingest_errors from publisher;
revoke all on private.ingest_errors from public;
