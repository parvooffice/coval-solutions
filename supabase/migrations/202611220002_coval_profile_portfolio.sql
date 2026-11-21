-- Portfolio customization for member profiles: accent color, a status badge (open to work,
-- hiring, open to collaborate), skills, links, and the order of profile sections. Stored as one
-- JSON object; the API validates its shape. Safe to run again.

alter table public.coval_profiles add column if not exists profile_portfolio jsonb not null default '{}'::jsonb;

alter table public.coval_profiles drop constraint if exists coval_profiles_portfolio_check;
alter table public.coval_profiles add constraint coval_profiles_portfolio_check
  check (jsonb_typeof(profile_portfolio) = 'object' and octet_length(profile_portfolio::text) <= 4000);
