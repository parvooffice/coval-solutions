create or replace function public.coval_upsert_auth_profile(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  auth_user auth.users%rowtype;
  github_identity jsonb;
begin
  select * into auth_user
  from auth.users
  where id = target_user_id;

  if not found then return; end if;

  select identity_data into github_identity
  from auth.identities
  where user_id = target_user_id and provider = 'github'
  order by updated_at desc nulls last, created_at desc
  limit 1;

  insert into public.coval_profiles (user_id, github_login, display_name, avatar_url, updated_at)
  values (
    target_user_id,
    coalesce(github_identity->>'user_name', github_identity->>'login'),
    coalesce(
      nullif(github_identity->>'full_name', ''),
      nullif(github_identity->>'name', ''),
      nullif(auth_user.raw_user_meta_data->>'full_name', ''),
      nullif(auth_user.raw_user_meta_data->>'name', ''),
      nullif(auth_user.raw_user_meta_data->>'user_name', ''),
      split_part(auth_user.email, '@', 1),
      ''
    ),
    coalesce(
      nullif(github_identity->>'avatar_url', ''),
      nullif(github_identity->>'picture', ''),
      nullif(auth_user.raw_user_meta_data->>'avatar_url', ''),
      nullif(auth_user.raw_user_meta_data->>'picture', '')
    ),
    now()
  )
  on conflict (user_id) do update set
    github_login = excluded.github_login,
    display_name = excluded.display_name,
    avatar_url = excluded.avatar_url,
    updated_at = now();
end;
$$;

create or replace function public.coval_sync_auth_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.coval_upsert_auth_profile(new.id);
  return new;
end;
$$;

create or replace function public.coval_sync_auth_identity_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_user_id uuid;
begin
  if tg_op = 'DELETE' then
    target_user_id := old.user_id;
  else
    target_user_id := new.user_id;
  end if;

  perform public.coval_upsert_auth_profile(target_user_id);

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists coval_auth_identity_profile_sync on auth.identities;
create trigger coval_auth_identity_profile_sync
  after insert or update or delete on auth.identities
  for each row execute function public.coval_sync_auth_identity_profile();

do $$
declare
  target_user record;
begin
  for target_user in select id from auth.users loop
    perform public.coval_upsert_auth_profile(target_user.id);
  end loop;
end;
$$;

revoke all on function public.coval_upsert_auth_profile(uuid) from public, anon, authenticated;
revoke all on function public.coval_sync_auth_profile() from public, anon, authenticated;
revoke all on function public.coval_sync_auth_identity_profile() from public, anon, authenticated;
