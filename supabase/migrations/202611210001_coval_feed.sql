-- Feed: members post a score showcase, a job opening, or a team-formation request.
-- Others mark "Interested" (optionally with a note); the author sees a queue and can accept
-- or decline. Accepting a team request that is linked to a team sends a team invite.
-- Anyone (including signed-out visitors) can read the feed through coval_public_feed.

create table if not exists public.coval_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('showcase', 'job', 'team')),
  title text not null check (char_length(btrim(title)) between 3 and 120),
  body text not null default '' check (char_length(body) <= 2000),
  share_token text references public.coval_shared_reports(token) on delete set null,
  team_id uuid references public.coval_teams(id) on delete set null,
  location text check (location is null or char_length(location) <= 80),
  closed boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists coval_posts_created_idx on public.coval_posts (created_at desc);
create index if not exists coval_posts_author_idx on public.coval_posts (author_id, created_at desc);

create table if not exists public.coval_post_interests (
  post_id uuid not null references public.coval_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  note text not null default '' check (char_length(note) <= 500),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

alter table public.coval_posts enable row level security;
alter table public.coval_post_interests enable row level security;

drop policy if exists "members read posts" on public.coval_posts;
create policy "members read posts" on public.coval_posts for select to authenticated using (true);

drop policy if exists "members write their posts" on public.coval_posts;
create policy "members write their posts" on public.coval_posts for insert to authenticated
  with check (
    author_id = auth.uid()
    and (team_id is null or public.coval_team_role(team_id) = 'admin')
    and (share_token is null or exists (select 1 from public.coval_shared_reports shared where shared.token = share_token and shared.user_id = auth.uid()))
  );

drop policy if exists "members edit their posts" on public.coval_posts;
create policy "members edit their posts" on public.coval_posts for update to authenticated
  using (author_id = auth.uid()) with check (author_id = auth.uid());

drop policy if exists "members delete their posts" on public.coval_posts;
create policy "members delete their posts" on public.coval_posts for delete to authenticated using (author_id = auth.uid());

-- Interests are visible to the person who sent them and to the post's author.
drop policy if exists "members read relevant interests" on public.coval_post_interests;
create policy "members read relevant interests" on public.coval_post_interests for select to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.coval_posts post where post.id = post_id and post.author_id = auth.uid()));

grant select, insert, delete on public.coval_posts to authenticated;
grant update (title, body, location, closed) on public.coval_posts to authenticated;
grant select on public.coval_post_interests to authenticated;

-- Notifications for interest and acceptance.
alter table public.coval_notifications add column if not exists post_id uuid references public.coval_posts(id) on delete cascade;
alter table public.coval_notifications drop constraint if exists coval_notifications_kind_check;
alter table public.coval_notifications add constraint coval_notifications_kind_check
  check (kind in ('connection', 'team_invite', 'post_interest', 'interest_accepted'));

create or replace function public.coval_public_feed(feed_kind text default null, max_rows integer default 50)
returns table (
  id uuid, author_id uuid, kind text, title text, body text, share_token text, team_id uuid, location text,
  closed boolean, created_at timestamptz, author_name text, author_login text, author_avatar text,
  author_headline text, interest_count integer
)
language sql
stable
security definer
set search_path = public
as $$
  select post.id, post.author_id, post.kind, post.title, post.body, post.share_token, post.team_id, post.location,
         post.closed, post.created_at,
         coalesce(profile.profile_name, profile.display_name, profile.github_login, 'COVAL member'),
         profile.github_login, profile.avatar_url, profile.profile_headline,
         (select count(*)::integer from public.coval_post_interests interest where interest.post_id = post.id)
  from public.coval_posts post
  left join public.coval_profiles profile on profile.user_id = post.author_id
  where feed_kind is null or post.kind = feed_kind
  order by post.created_at desc
  limit least(greatest(coalesce(max_rows, 50), 1), 100);
$$;

create or replace function public.coval_express_interest(post uuid, interest_note text default '')
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  target public.coval_posts%rowtype;
  inserted_count integer;
begin
  if current_user_id is null then
    raise exception 'Sign in to show interest.' using errcode = '28000';
  end if;
  select * into target from public.coval_posts where id = post;
  if not found then
    raise exception 'This post no longer exists.' using errcode = 'P0002';
  end if;
  if target.author_id = current_user_id then
    raise exception 'This is your own post.' using errcode = '22023';
  end if;
  if target.closed then
    raise exception 'This post is closed.' using errcode = '22023';
  end if;
  if (select count(*) from public.coval_post_interests where user_id = current_user_id and created_at > now() - interval '1 day') >= 50 then
    raise exception 'You have shown interest in many posts today. Try again tomorrow.' using errcode = '54000';
  end if;
  insert into public.coval_post_interests (post_id, user_id, note)
  values (post, current_user_id, left(coalesce(interest_note, ''), 500))
  on conflict (post_id, user_id) do update set note = excluded.note;
  get diagnostics inserted_count = row_count;
  insert into public.coval_notifications (recipient_id, actor_id, kind, post_id)
  select target.author_id, current_user_id, 'post_interest', post
  where not exists (
    select 1 from public.coval_notifications
    where recipient_id = target.author_id and actor_id = current_user_id and kind = 'post_interest' and post_id = post
  );
  return inserted_count > 0;
end;
$$;

create or replace function public.coval_withdraw_interest(post uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.coval_post_interests where post_id = post and user_id = auth.uid() and status = 'pending';
  return found;
end;
$$;

create or replace function public.coval_respond_interest(post uuid, member uuid, accept boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.coval_posts%rowtype;
begin
  select * into target from public.coval_posts where id = post;
  if not found or target.author_id is distinct from auth.uid() then
    raise exception 'Only the author can respond to interest.' using errcode = '42501';
  end if;
  update public.coval_post_interests
  set status = case when accept then 'accepted' else 'declined' end
  where post_id = post and user_id = member;
  if not found then
    raise exception 'That member is not in this queue.' using errcode = 'P0002';
  end if;
  if accept then
    insert into public.coval_notifications (recipient_id, actor_id, kind, post_id)
    values (member, auth.uid(), 'interest_accepted', post);
    if target.kind = 'team' and target.team_id is not null then
      perform public.coval_invite_team_member(target.team_id, member);
    end if;
  end if;
  return true;
end;
$$;

revoke all on function public.coval_public_feed(text, integer) from public;
revoke all on function public.coval_express_interest(uuid, text) from public, anon;
revoke all on function public.coval_withdraw_interest(uuid) from public, anon;
revoke all on function public.coval_respond_interest(uuid, uuid, boolean) from public, anon;
grant execute on function public.coval_public_feed(text, integer) to anon, authenticated;
grant execute on function public.coval_express_interest(uuid, text) to authenticated;
grant execute on function public.coval_withdraw_interest(uuid) to authenticated;
grant execute on function public.coval_respond_interest(uuid, uuid, boolean) to authenticated;
