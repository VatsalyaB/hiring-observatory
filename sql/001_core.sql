-- Invariant 4: country, currency, timezone, language and region are DATA, never hardcoded.
create table if not exists countries (
  code                   text primary key,          -- lowercase ISO 3166-1 alpha-2
  name                   text not null,
  currency               text not null,             -- uppercase ISO 4217
  timezone               text not null,
  region                 text not null,             -- 'oceania', 'southeast-asia', ...
  default_language       text not null default 'en',
  salary_disclosure_norm text,                      -- 'common' | 'rare' | 'unknown'
  occupation_taxonomy    text,                      -- 'anzsco' | 'isco-08'
  enabled                boolean not null default false
);

-- Adding a source is one adapter plus one row here. Adding a country is one row in `countries`.
create table if not exists sources (
  id                 text primary key,
  class              text not null
                     check (class in ('aggregator','ats','official','ecosystem','compensation','private')),
  adapter            text not null,
  country_codes      text[] not null default '{}',
  auth_type          text not null default 'none',
  rate_limit_per_min integer,
  publishable        boolean not null default true,  -- false => private tier only (invariant 3)
  enabled            boolean not null default false,
  last_success_at    timestamptz,
  last_error         text
);

-- Invariant 1: raw is immutable. Every payload, exactly as received, forever.
-- payload_hash is part of the unique key so that re-fetching an unchanged ad is a no-op while an
-- EDITED ad lands as a new row — preserving the revision history for free.
create table if not exists raw_listings (
  id           bigserial primary key,
  source_id    text not null references sources(id),
  source_ref   text not null,                       -- the source's own identifier
  country_code text not null references countries(code),
  fetched_at   timestamptz not null default now(),
  payload      jsonb not null,
  payload_hash text generated always as (md5(payload::text)) stored,
  unique (source_id, source_ref, payload_hash)
);

create index if not exists raw_listings_source_fetched_idx
  on raw_listings (source_id, fetched_at desc);

-- Enforce immutability in the database rather than by convention.
create or replace function raw_listings_immutable() returns trigger
language plpgsql as $$
begin
  raise exception
    'raw_listings is immutable (invariant 1): % is not permitted', tg_op
    using hint = 'Insert a new row instead. Downstream tables are recomputable from raw.';
end;
$$;

drop trigger if exists raw_listings_no_update on raw_listings;
create trigger raw_listings_no_update
  before update on raw_listings
  for each statement execute function raw_listings_immutable();

drop trigger if exists raw_listings_no_delete on raw_listings;
create trigger raw_listings_no_delete
  before delete on raw_listings
  for each statement execute function raw_listings_immutable();
