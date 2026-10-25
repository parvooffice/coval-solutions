create table if not exists public.coval_code_evaluations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  report jsonb not null check (jsonb_typeof(report) = 'object'),
  updated_at timestamptz not null default now()
);

alter table public.coval_code_evaluations enable row level security;

drop policy if exists "users manage their own code evaluations" on public.coval_code_evaluations;
create policy "users manage their own code evaluations"
  on public.coval_code_evaluations for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete on public.coval_code_evaluations to authenticated;
