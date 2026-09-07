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
