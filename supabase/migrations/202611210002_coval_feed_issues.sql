-- Feed "Issues": a member turns an agent finding in their repository into a help request.
-- The post keeps the repository URL and the finding (agent, title, file and line), so the
-- Feed links back to the code and the repository's report lists its open help requests.
-- Others tap "Offer to help" (the existing interest queue).

alter table public.coval_posts drop constraint if exists coval_posts_kind_check;
alter table public.coval_posts add constraint coval_posts_kind_check check (kind in ('showcase', 'job', 'team', 'issue'));

alter table public.coval_posts add column if not exists repo_url text
  check (repo_url is null or repo_url ~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$');
alter table public.coval_posts add column if not exists finding jsonb
  check (finding is null or (jsonb_typeof(finding) = 'object' and octet_length(finding::text) <= 4000));
alter table public.coval_posts drop constraint if exists coval_posts_issue_repo_check;
alter table public.coval_posts add constraint coval_posts_issue_repo_check check (kind <> 'issue' or repo_url is not null);

create index if not exists coval_posts_repo_idx on public.coval_posts (repo_url, created_at desc) where repo_url is not null;

-- The return type changes, so the function is recreated.
drop function if exists public.coval_public_feed(text, integer);
create function public.coval_public_feed(feed_kind text default null, max_rows integer default 50, feed_repo text default null)
returns table (
  id uuid, author_id uuid, kind text, title text, body text, share_token text, team_id uuid, location text,
  closed boolean, created_at timestamptz, author_name text, author_login text, author_avatar text,
  author_headline text, interest_count integer, repo_url text, finding jsonb
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
         (select count(*)::integer from public.coval_post_interests interest where interest.post_id = post.id),
         post.repo_url, post.finding
  from public.coval_posts post
  left join public.coval_profiles profile on profile.user_id = post.author_id
  where (feed_kind is null
         or post.kind = feed_kind
         or (feed_kind = 'jobs' and post.kind in ('job', 'team')))
    and (feed_repo is null or lower(post.repo_url) = lower(feed_repo))
  order by post.created_at desc
  limit least(greatest(coalesce(max_rows, 50), 1), 100);
$$;

revoke all on function public.coval_public_feed(text, integer, text) from public;
grant execute on function public.coval_public_feed(text, integer, text) to anon, authenticated;
