-- Public share links and README badges for one repository's evaluation.
-- Only public GitHub repositories can be shared. Each snapshot is signed by the server
-- (CODE_EVALUATION_FUNCTION_SECRET), so a member cannot edit their own scores to fake a badge.

create table if not exists public.coval_shared_reports (
  token text primary key check (token ~ '^[A-Za-z0-9_-]{20,64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  github_login text,
  target_url text not null check (target_url ~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  signature text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists coval_shared_reports_owner_target_idx on public.coval_shared_reports (user_id, target_url);

alter table public.coval_shared_reports enable row level security;

drop policy if exists "members manage their shared reports" on public.coval_shared_reports;
create policy "members manage their shared reports"
  on public.coval_shared_reports for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete on public.coval_shared_reports to authenticated;

-- Anyone with the link can read that one report (the server checks the signature before showing it).
create or replace function public.coval_get_shared_report(share_token text)
returns table (user_id uuid, github_login text, target_url text, snapshot jsonb, signature text, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select user_id, github_login, target_url, snapshot, signature, created_at
  from public.coval_shared_reports
  where token = share_token;
$$;

revoke all on function public.coval_get_shared_report(text) from public;
grant execute on function public.coval_get_shared_report(text) to anon, authenticated;
