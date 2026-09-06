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

create function public.create_reviewer_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  provider_user_id text := coalesce(new.raw_user_meta_data ->> 'provider_id', new.raw_user_meta_data ->> 'sub');
  provider_login text := new.raw_user_meta_data ->> 'user_name';
begin
  if coalesce(new.raw_app_meta_data ->> 'provider', '') <> 'github' then
    raise exception 'GitHub authentication is required';
  end if;

  if nullif(provider_user_id, '') is null or nullif(provider_login, '') is null then
    raise exception 'GitHub identity is incomplete';
  end if;

  insert into public.reviewer_profiles (user_id, github_user_id, github_login)
  values (new.id, provider_user_id, provider_login)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

create trigger reviewer_profile_on_auth_user
after insert on auth.users
for each row execute function public.create_reviewer_profile();

insert into public.feedback_targets (target_type, target_key, label)
values
  ('project', 'hiring-observatory', 'Hiring Observatory'),
  ('release', 'ats-panel-pilot-2026-08-13', 'ATS panel pilot - 2026-08-13'),
  ('claim', 'ats-panel-pilot-2026-08-13:observable-demand', 'Observable demand'),
  ('claim', 'ats-panel-pilot-2026-08-13:employer-breadth', 'Employer breadth')
on conflict do nothing;

create function public.submit_reviewer_feedback(
  p_target_type text,
  p_target_key text,
  p_category text,
  p_comment text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  profile public.reviewer_profiles%rowtype;
  feedback_id uuid;
  retry_at timestamptz;
begin
  if caller_id is null then
    raise exception 'authenticated reviewer required';
  end if;

  if p_category is null or p_category not in ('useful', 'unclear', 'evidence_concern', 'suggestion') then
    raise exception 'invalid category';
  end if;

  if p_comment is null
    or p_comment <> pg_catalog.btrim(p_comment)
    or pg_catalog.length(p_comment) not between 1 and 2000 then
    raise exception 'invalid comment';
  end if;

  if not exists (
    select 1
    from public.feedback_targets
    where target_type = p_target_type and target_key = p_target_key and active
  ) then
    raise exception 'invalid or inactive target';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(caller_id::text, 0)
  );

  select min(created_at) + interval '1 hour'
  into retry_at
    from public.reviewer_feedback
    where author_id = caller_id
      and created_at >= pg_catalog.now() - interval '1 hour'
    having count(*) >= 5;

  if retry_at is not null then
    raise exception using
      message = 'rate limit exceeded',
      detail = 'retry_at=' || pg_catalog.to_char(
        retry_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      );
  end if;

  select *
  into profile
  from public.reviewer_profiles
  where user_id = caller_id;

  if not found then
    raise exception 'reviewer profile not found';
  end if;

  insert into public.reviewer_feedback (
    author_id,
    github_user_id,
    github_login,
    target_type,
    target_key,
    category,
    comment
  )
  values (
    caller_id,
    profile.github_user_id,
    profile.github_login,
    p_target_type,
    p_target_key,
    p_category,
    p_comment
  )
  returning id into feedback_id;

  return feedback_id;
end;
$$;

alter table public.reviewer_profiles enable row level security;
alter table public.reviewer_profiles force row level security;
alter table public.feedback_targets enable row level security;
alter table public.feedback_targets force row level security;
alter table public.reviewer_feedback enable row level security;
alter table public.reviewer_feedback force row level security;

create policy reviewer_profiles_insert
on public.reviewer_profiles
for insert
with check (true);

create policy reviewer_profiles_read_own
on public.reviewer_profiles
for select
using (user_id = auth.uid());

create policy feedback_targets_read_active
on public.feedback_targets
for select
using (active);

create policy reviewer_feedback_read
on public.reviewer_feedback
for select
using (status = 'approved' or author_id = auth.uid());

create policy reviewer_feedback_submit
on public.reviewer_feedback
for insert
with check (author_id = auth.uid());

revoke all on public.reviewer_profiles from anon, authenticated;
revoke all on public.feedback_targets from anon, authenticated;
revoke all on public.reviewer_feedback from anon, authenticated;
grant select (
  github_login,
  target_type,
  target_key,
  category,
  comment,
  status,
  created_at,
  moderated_at
) on public.reviewer_feedback to anon, authenticated;

revoke all on function public.submit_reviewer_feedback(text, text, text, text) from public;
grant execute on function public.submit_reviewer_feedback(text, text, text, text) to authenticated;
