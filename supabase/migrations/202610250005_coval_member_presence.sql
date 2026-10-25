alter table public.coval_profiles
  add column if not exists last_seen_at timestamptz;

create index if not exists coval_profiles_last_seen_idx
  on public.coval_profiles (last_seen_at desc nulls last);

drop policy if exists "users update their own coval presence" on public.coval_profiles;
create policy "users update their own coval presence"
  on public.coval_profiles for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant update (last_seen_at) on public.coval_profiles to authenticated;

create table if not exists public.coval_member_connections (
  user_id uuid not null references auth.users(id) on delete cascade,
  target_user_id uuid not null references public.coval_profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, target_user_id),
  check (user_id <> target_user_id)
);

alter table public.coval_member_connections enable row level security;

drop policy if exists "users manage their own member connections" on public.coval_member_connections;
create policy "users manage their own member connections"
  on public.coval_member_connections for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete on public.coval_member_connections to authenticated;
