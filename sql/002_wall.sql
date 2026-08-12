-- INVARIANT 2 — the wall.
--
-- Seek-sourced data is isolated by DATABASE PERMISSIONS, not by convention. The publishing role
-- holds no grant on the `private` schema, and nothing from M6 onward may join across that line.
-- scripts/verify-wall.mjs proves it, and must stay green.

create schema if not exists private;

create table if not exists private.raw_listings (
  id           bigserial primary key,
  source_id    text not null references public.sources(id),
  source_ref   text not null,
  country_code text not null references public.countries(code),
  fetched_at   timestamptz not null default now(),
  payload      jsonb not null,
  payload_hash text generated always as (md5(payload::text)) stored,
  unique (source_id, source_ref, payload_hash)
);

create index if not exists private_raw_listings_source_fetched_idx
  on private.raw_listings (source_id, fetched_at desc);

-- Invariant 1 applies to the private tier too, and it applies THREE ways.
--
-- The plan as drafted attached only the UPDATE and DELETE pair. TRUNCATE fires neither of those
-- triggers and empties the table outright — the same hole found in the public table during the
-- Task 2 audit and closed by 001b_truncate_guard.sql. A wall protecting data that can still be
-- wiped is not the guarantee invariant 1 claims, so the private tier gets all three.
drop trigger if exists private_raw_listings_no_update on private.raw_listings;
create trigger private_raw_listings_no_update
  before update on private.raw_listings
  for each statement execute function public.raw_listings_immutable();

drop trigger if exists private_raw_listings_no_delete on private.raw_listings;
create trigger private_raw_listings_no_delete
  before delete on private.raw_listings
  for each statement execute function public.raw_listings_immutable();

drop trigger if exists private_raw_listings_no_truncate on private.raw_listings;
create trigger private_raw_listings_no_truncate
  before truncate on private.raw_listings
  for each statement execute function public.raw_listings_immutable();

-- The publishing role. ${PUBLISHER_PASSWORD} is substituted from the environment by
-- scripts/migrate.mjs, so no secret is ever committed.
--
-- CAVEAT: that substitution is plain text replacement. A single quote in PUBLISHER_PASSWORD would
-- break this file, and in principle inject SQL. The generator the plan specifies emits hex, which
-- is safe. Do not put punctuation in this value without hardening scripts/migrate.mjs first.
do $wall$
begin
  if not exists (select 1 from pg_roles where rolname = 'publisher') then
    create role publisher login password '${PUBLISHER_PASSWORD}';
  else
    alter role publisher login password '${PUBLISHER_PASSWORD}';
  end if;
end
$wall$;

-- State the role's ceiling explicitly rather than inheriting it from whatever the defaults happen
-- to be. This role is the one that talks to the publishing pipeline; it should be able to do
-- nothing but read.
alter role publisher nosuperuser nocreatedb nocreaterole noreplication nobypassrls;

-- Read-only on public.
grant usage on schema public to publisher;
grant select on all tables in schema public to publisher;
-- Applies only to objects subsequently created by the role running this statement (observatory),
-- which is the role every migration runs as.
alter default privileges in schema public grant select on tables to publisher;

-- Nothing whatsoever on private. Explicit, even though it is also the default: an explicit revoke
-- records the intent, and PUBLIC is revoked too because a grant to PUBLIC would be inherited by
-- publisher without publisher ever being named.
revoke all on schema private from public;
revoke all on schema private from publisher;
revoke all on all tables in schema private from public;
revoke all on all tables in schema private from publisher;
revoke all on all sequences in schema private from public;
revoke all on all sequences in schema private from publisher;
alter default privileges in schema private revoke all on tables from publisher;
alter default privileges in schema private revoke all on sequences from publisher;
