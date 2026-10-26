alter table public.coval_profiles
  add column if not exists profile_name text,
  add column if not exists profile_headline text not null default '',
  add column if not exists profile_bio text not null default '',
  add column if not exists profile_location text not null default '',
  add column if not exists profile_company text not null default '',
  add column if not exists profile_visibility jsonb not null default '{"contributions":true,"repositories":true,"activity":true,"evaluations":true}'::jsonb,
  add column if not exists featured_repositories text[];

grant update (profile_name, profile_headline, profile_bio, profile_location, profile_company, profile_visibility, featured_repositories, updated_at)
  on public.coval_profiles to authenticated;
