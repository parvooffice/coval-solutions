create table if not exists public.coval_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  github_login text unique,
  display_name text not null default '',
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.coval_connections (
  user_id uuid not null references auth.users(id) on delete cascade,
  target_github_login text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, target_github_login)
);

create table if not exists public.coval_conversations (
  id uuid primary key default gen_random_uuid(),
  title text not null default '',
  kind text not null default 'person' check (kind in ('person', 'project')),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.coval_conversation_members (
  conversation_id uuid not null references public.coval_conversations(id) on delete cascade,
  user_id uuid not null references public.coval_profiles(user_id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_read_at timestamptz,
  primary key (conversation_id, user_id)
);

create table if not exists public.coval_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.coval_conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  content text not null check (char_length(content) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index if not exists coval_messages_conversation_time_idx
  on public.coval_messages (conversation_id, created_at desc);
create index if not exists coval_members_user_idx
  on public.coval_conversation_members (user_id, joined_at desc);

create or replace function public.coval_sync_auth_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.coval_profiles (user_id, github_login, display_name, avatar_url, updated_at)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'user_name', new.raw_user_meta_data->>'preferred_username', new.raw_user_meta_data->>'nickname'),
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'user_name', ''),
    new.raw_user_meta_data->>'avatar_url',
    now()
  )
  on conflict (user_id) do update set
    github_login = excluded.github_login,
    display_name = excluded.display_name,
    avatar_url = excluded.avatar_url,
    updated_at = now();
  return new;
end;
$$;

drop trigger if exists coval_auth_profile_sync on auth.users;
create trigger coval_auth_profile_sync
  after insert or update of raw_user_meta_data on auth.users
  for each row execute function public.coval_sync_auth_profile();

insert into public.coval_profiles (user_id, github_login, display_name, avatar_url)
select
  id,
  coalesce(raw_user_meta_data->>'user_name', raw_user_meta_data->>'preferred_username', raw_user_meta_data->>'nickname'),
  coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name', raw_user_meta_data->>'user_name', ''),
  raw_user_meta_data->>'avatar_url'
from auth.users
on conflict (user_id) do nothing;

create or replace function public.coval_create_conversation(recipient_login text, conversation_title text default '')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  recipient_user_id uuid;
  recipient_name text;
  new_conversation_id uuid;
begin
  if current_user_id is null then
    raise exception 'Sign in to create a conversation.' using errcode = '28000';
  end if;
  if recipient_login is null or recipient_login !~ '^[A-Za-z0-9-]{1,39}$' then
    raise exception 'A valid GitHub username is required.' using errcode = '22023';
  end if;

  select user_id, display_name into recipient_user_id, recipient_name
  from public.coval_profiles
  where lower(github_login) = lower(recipient_login)
  limit 1;

  if recipient_user_id is null then
    raise exception 'This teammate has not signed into COVAL yet.' using errcode = 'P0001';
  end if;
  if recipient_user_id = current_user_id then
    raise exception 'You cannot start a conversation with yourself.' using errcode = '22023';
  end if;

  insert into public.coval_conversations (title, kind, created_by)
  values (coalesce(nullif(left(conversation_title, 120), ''), recipient_name), 'person', current_user_id)
  returning id into new_conversation_id;

  insert into public.coval_conversation_members (conversation_id, user_id)
  values (new_conversation_id, current_user_id), (new_conversation_id, recipient_user_id);

  return new_conversation_id;
end;
$$;

create or replace function public.coval_is_conversation_member(target_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.coval_conversation_members member
    where member.conversation_id = target_conversation_id
      and member.user_id = auth.uid()
  );
$$;

create or replace function public.coval_leave_conversation(target_conversation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'Sign in to update a conversation.' using errcode = '28000';
  end if;
  delete from public.coval_conversation_members
  where conversation_id = target_conversation_id and user_id = current_user_id;
  if not found then return false; end if;
  delete from public.coval_conversations conversation
  where conversation.id = target_conversation_id
    and not exists (select 1 from public.coval_conversation_members member where member.conversation_id = target_conversation_id);
  return true;
end;
$$;

alter table public.coval_profiles enable row level security;
alter table public.coval_connections enable row level security;
alter table public.coval_conversations enable row level security;
alter table public.coval_conversation_members enable row level security;
alter table public.coval_messages enable row level security;

drop policy if exists "signed-in users can view coval profiles" on public.coval_profiles;
create policy "signed-in users can view coval profiles"
  on public.coval_profiles for select to authenticated using (true);

drop policy if exists "users manage their own connections" on public.coval_connections;
create policy "users manage their own connections"
  on public.coval_connections for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "members can view conversations" on public.coval_conversations;
create policy "members can view conversations"
  on public.coval_conversations for select to authenticated
  using (public.coval_is_conversation_member(id));

drop policy if exists "members can view conversation participants" on public.coval_conversation_members;
create policy "members can view conversation participants"
  on public.coval_conversation_members for select to authenticated
  using (public.coval_is_conversation_member(conversation_id));

drop policy if exists "members can read conversation messages" on public.coval_messages;
create policy "members can read conversation messages"
  on public.coval_messages for select to authenticated
  using (public.coval_is_conversation_member(conversation_id));

drop policy if exists "members can send messages as themselves" on public.coval_messages;
create policy "members can send messages as themselves"
  on public.coval_messages for insert to authenticated
  with check (
    sender_id = auth.uid() and public.coval_is_conversation_member(conversation_id)
  );

drop policy if exists "users update their own conversation read time" on public.coval_conversation_members;
create policy "users update their own conversation read time"
  on public.coval_conversation_members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select on public.coval_profiles to authenticated;
grant select, insert, update, delete on public.coval_connections to authenticated;
grant select on public.coval_conversations, public.coval_conversation_members, public.coval_messages to authenticated;
grant update (last_read_at) on public.coval_conversation_members to authenticated;
grant insert on public.coval_messages to authenticated;
revoke all on function public.coval_create_conversation(text, text) from public, anon;
revoke all on function public.coval_is_conversation_member(uuid) from public, anon;
revoke all on function public.coval_leave_conversation(uuid) from public, anon;
grant execute on function public.coval_create_conversation(text, text) to authenticated;
grant execute on function public.coval_is_conversation_member(uuid) to authenticated;
grant execute on function public.coval_leave_conversation(uuid) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'coval_messages'
     ) then
    alter publication supabase_realtime add table public.coval_messages;
  end if;
end;
$$;
