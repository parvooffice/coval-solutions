create table if not exists public.coval_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('connection')),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  check (recipient_id <> actor_id)
);

create index if not exists coval_notifications_recipient_created_idx
  on public.coval_notifications (recipient_id, created_at desc);

alter table public.coval_notifications enable row level security;

drop policy if exists "users read their notifications" on public.coval_notifications;
create policy "users read their notifications"
  on public.coval_notifications for select to authenticated
  using (recipient_id = auth.uid());

drop policy if exists "users mark their notifications read" on public.coval_notifications;
create policy "users mark their notifications read"
  on public.coval_notifications for update to authenticated
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());

grant select on public.coval_notifications to authenticated;
grant update (read_at) on public.coval_notifications to authenticated;

create or replace function public.coval_connect_member(target_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  inserted_count integer;
begin
  if current_user_id is null then
    raise exception 'Sign in to connect with a member.' using errcode = '28000';
  end if;
  if target_user_id is null or target_user_id = current_user_id then
    raise exception 'Choose another COVAL member.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.coval_profiles where user_id = target_user_id) then
    raise exception 'COVAL member not found.' using errcode = 'P0002';
  end if;

  insert into public.coval_member_connections (user_id, target_user_id)
  values (current_user_id, target_user_id)
  on conflict do nothing;
  get diagnostics inserted_count = row_count;

  insert into public.coval_member_connections (user_id, target_user_id)
  values (target_user_id, current_user_id)
  on conflict do nothing;

  if inserted_count > 0 then
    insert into public.coval_notifications (recipient_id, actor_id, kind)
    values (target_user_id, current_user_id, 'connection');
  end if;

  return inserted_count > 0;
end;
$$;

create or replace function public.coval_disconnect_member(member_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  deleted_count integer;
begin
  if current_user_id is null then
    raise exception 'Sign in to update connections.' using errcode = '28000';
  end if;
  if member_id is null or member_id = current_user_id then
    raise exception 'Choose another COVAL member.' using errcode = '22023';
  end if;

  delete from public.coval_member_connections
  where (user_id = current_user_id and coval_member_connections.target_user_id = member_id)
     or (user_id = member_id and coval_member_connections.target_user_id = current_user_id);
  get diagnostics deleted_count = row_count;
  return deleted_count > 0;
end;
$$;

revoke all on function public.coval_connect_member(uuid) from public, anon;
revoke all on function public.coval_disconnect_member(uuid) from public, anon;
grant execute on function public.coval_connect_member(uuid) to authenticated;
grant execute on function public.coval_disconnect_member(uuid) to authenticated;

-- Existing follows become mutual platform connections so both users can see
-- each other and receive the same profile access as new connections.
insert into public.coval_member_connections (user_id, target_user_id)
select source.user_id, target.user_id
from public.coval_member_connections existing
join public.coval_profiles source on source.user_id = existing.user_id
join public.coval_profiles target on target.user_id = existing.target_user_id
where source.user_id <> target.user_id
union
select target.user_id, source.user_id
from public.coval_member_connections existing
join public.coval_profiles source on source.user_id = existing.user_id
join public.coval_profiles target on target.user_id = existing.target_user_id
where source.user_id <> target.user_id
union
select source.user_id, target.user_id
from public.coval_connections existing
join public.coval_profiles source on source.user_id = existing.user_id
join public.coval_profiles target on lower(target.github_login) = lower(existing.target_github_login)
where source.user_id <> target.user_id
union
select target.user_id, source.user_id
from public.coval_connections existing
join public.coval_profiles source on source.user_id = existing.user_id
join public.coval_profiles target on lower(target.github_login) = lower(existing.target_github_login)
where source.user_id <> target.user_id
on conflict do nothing;

-- COVAL-to-COVAL connections now use user IDs only. Keep the legacy login
-- table for follows to GitHub users who have not joined COVAL.
delete from public.coval_connections existing
using public.coval_profiles target
where lower(target.github_login) = lower(existing.target_github_login);
