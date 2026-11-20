-- Teams: a member creates a team and becomes its admin, admins invite COVAL members,
-- invitees accept or decline. Admins can read active members' evaluation reports;
-- members see only team-wide averages. All changes go through the functions below.

create table if not exists public.coval_teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 80),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.coval_team_members (
  team_id uuid not null references public.coval_teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('admin', 'member')),
  status text not null default 'invited' check (status in ('invited', 'active')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  joined_at timestamptz,
  primary key (team_id, user_id)
);

create index if not exists coval_team_members_user_idx on public.coval_team_members (user_id, status);

alter table public.coval_teams enable row level security;
alter table public.coval_team_members enable row level security;

create or replace function public.coval_team_role(team uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.coval_team_members
  where team_id = team and user_id = auth.uid() and status = 'active';
$$;

-- True when the caller is an active admin of a team in which `member` is active.
create or replace function public.coval_is_admin_of(member uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.coval_team_members admin_row
    join public.coval_team_members member_row on member_row.team_id = admin_row.team_id
    where admin_row.user_id = auth.uid() and admin_row.role = 'admin' and admin_row.status = 'active'
      and member_row.user_id = member and member_row.status = 'active'
  );
$$;

drop policy if exists "members and invitees read teams" on public.coval_teams;
create policy "members and invitees read teams"
  on public.coval_teams for select to authenticated
  using (exists (select 1 from public.coval_team_members membership where membership.team_id = coval_teams.id and membership.user_id = auth.uid()));

drop policy if exists "members read team rosters" on public.coval_team_members;
create policy "members read team rosters"
  on public.coval_team_members for select to authenticated
  using (user_id = auth.uid() or public.coval_team_role(team_id) is not null);

drop policy if exists "team admins read member evaluations" on public.coval_code_evaluations;
create policy "team admins read member evaluations"
  on public.coval_code_evaluations for select to authenticated
  using (public.coval_is_admin_of(user_id));

grant select on public.coval_teams, public.coval_team_members to authenticated;

-- Notifications gain a team invite kind.
alter table public.coval_notifications add column if not exists team_id uuid references public.coval_teams(id) on delete cascade;
alter table public.coval_notifications drop constraint if exists coval_notifications_kind_check;
alter table public.coval_notifications add constraint coval_notifications_kind_check check (kind in ('connection', 'team_invite'));

create or replace function public.coval_create_team(team_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  new_team uuid;
begin
  if current_user_id is null then
    raise exception 'Sign in to create a team.' using errcode = '28000';
  end if;
  if char_length(btrim(coalesce(team_name, ''))) not between 2 and 80 then
    raise exception 'Team names must be 2 to 80 characters.' using errcode = '22023';
  end if;
  if (select count(*) from public.coval_teams where created_by = current_user_id) >= 20 then
    raise exception 'You can create up to 20 teams.' using errcode = '54000';
  end if;
  insert into public.coval_teams (name, created_by) values (btrim(team_name), current_user_id) returning id into new_team;
  insert into public.coval_team_members (team_id, user_id, role, status, invited_by, joined_at)
  values (new_team, current_user_id, 'admin', 'active', current_user_id, now());
  return new_team;
end;
$$;

create or replace function public.coval_invite_team_member(team uuid, member uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  inserted_count integer;
begin
  if public.coval_team_role(team) is distinct from 'admin' then
    raise exception 'Only team admins can invite members.' using errcode = '42501';
  end if;
  if member is null or member = current_user_id then
    raise exception 'Choose another COVAL member.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.coval_profiles where user_id = member) then
    raise exception 'COVAL member not found.' using errcode = 'P0002';
  end if;
  if (select count(*) from public.coval_team_members where team_id = team) >= 200 then
    raise exception 'Teams can have up to 200 members.' using errcode = '54000';
  end if;
  insert into public.coval_team_members (team_id, user_id, role, status, invited_by)
  values (team, member, 'member', 'invited', current_user_id)
  on conflict do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count > 0 then
    insert into public.coval_notifications (recipient_id, actor_id, kind, team_id)
    values (member, current_user_id, 'team_invite', team);
  end if;
  return inserted_count > 0;
end;
$$;

create or replace function public.coval_respond_team_invite(team uuid, accept boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if not exists (select 1 from public.coval_team_members where team_id = team and user_id = current_user_id and status = 'invited') then
    raise exception 'No pending invite for this team.' using errcode = 'P0002';
  end if;
  if accept then
    update public.coval_team_members set status = 'active', joined_at = now() where team_id = team and user_id = current_user_id;
  else
    delete from public.coval_team_members where team_id = team and user_id = current_user_id;
  end if;
  delete from public.coval_notifications where recipient_id = current_user_id and kind = 'team_invite' and team_id = team;
  return accept;
end;
$$;

create or replace function public.coval_set_team_role(team uuid, member uuid, new_role text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.coval_team_role(team) is distinct from 'admin' then
    raise exception 'Only team admins can change roles.' using errcode = '42501';
  end if;
  if new_role not in ('admin', 'member') then
    raise exception 'Choose admin or member.' using errcode = '22023';
  end if;
  if new_role = 'member' and (select count(*) from public.coval_team_members where team_id = team and role = 'admin' and status = 'active' and user_id <> member) = 0 then
    raise exception 'A team needs at least one admin.' using errcode = '23514';
  end if;
  update public.coval_team_members set role = new_role where team_id = team and user_id = member and status = 'active';
  return found;
end;
$$;

-- Admins remove members (or cancel invites); anyone can leave. The last admin cannot
-- leave while others remain; a team with no one left is deleted.
create or replace function public.coval_remove_team_member(team uuid, member uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  target_role text;
begin
  if member <> current_user_id and public.coval_team_role(team) is distinct from 'admin' then
    raise exception 'Only team admins can remove members.' using errcode = '42501';
  end if;
  select role into target_role from public.coval_team_members where team_id = team and user_id = member;
  if target_role is null then
    return false;
  end if;
  if target_role = 'admin'
     and (select count(*) from public.coval_team_members where team_id = team and role = 'admin' and status = 'active' and user_id <> member) = 0
     and (select count(*) from public.coval_team_members where team_id = team and user_id <> member) > 0 then
    raise exception 'Make another member an admin before the last admin leaves.' using errcode = '23514';
  end if;
  delete from public.coval_team_members where team_id = team and user_id = member;
  delete from public.coval_notifications where recipient_id = member and kind = 'team_invite' and team_id = team;
  if not exists (select 1 from public.coval_team_members where team_id = team) then
    delete from public.coval_teams where id = team;
  end if;
  return true;
end;
$$;

-- Team-wide averages per agent for any active member, without exposing individual reports.
create or replace function public.coval_team_agent_averages(team uuid)
returns table (agent_id text, label text, average_score numeric, repositories integer, members integer)
language sql
stable
security definer
set search_path = public
as $$
  select evaluation->>'id', max(evaluation->>'label'), round(avg((evaluation->>'score')::numeric), 1),
         count(*)::integer, count(distinct evaluations.user_id)::integer
  from public.coval_team_members member_row
  join public.coval_code_evaluations evaluations on evaluations.user_id = member_row.user_id
  cross join lateral jsonb_array_elements(coalesce(evaluations.report->'targets', '[]'::jsonb)) target
  cross join lateral jsonb_array_elements(coalesce(target->'evaluations', '[]'::jsonb)) evaluation
  where member_row.team_id = team and member_row.status = 'active'
    and public.coval_team_role(team) is not null
    and evaluation->>'status' = 'complete'
    and jsonb_typeof(evaluation->'score') = 'number'
  group by evaluation->>'id';
$$;

revoke all on function public.coval_team_role(uuid) from public, anon;
revoke all on function public.coval_is_admin_of(uuid) from public, anon;
revoke all on function public.coval_create_team(text) from public, anon;
revoke all on function public.coval_invite_team_member(uuid, uuid) from public, anon;
revoke all on function public.coval_respond_team_invite(uuid, boolean) from public, anon;
revoke all on function public.coval_set_team_role(uuid, uuid, text) from public, anon;
revoke all on function public.coval_remove_team_member(uuid, uuid) from public, anon;
revoke all on function public.coval_team_agent_averages(uuid) from public, anon;
grant execute on function public.coval_team_role(uuid) to authenticated;
grant execute on function public.coval_is_admin_of(uuid) to authenticated;
grant execute on function public.coval_create_team(text) to authenticated;
grant execute on function public.coval_invite_team_member(uuid, uuid) to authenticated;
grant execute on function public.coval_respond_team_invite(uuid, boolean) to authenticated;
grant execute on function public.coval_set_team_role(uuid, uuid, text) to authenticated;
grant execute on function public.coval_remove_team_member(uuid, uuid) to authenticated;
grant execute on function public.coval_team_agent_averages(uuid) to authenticated;
