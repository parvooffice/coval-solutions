alter table public.coval_profiles
  add column if not exists profile_banner_path text;

grant update (profile_banner_path, updated_at)
  on public.coval_profiles to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('coval-profile-banners', 'coval-profile-banners', true, 5242880, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Profile banners are publicly readable" on storage.objects;
create policy "Profile banners are publicly readable"
  on storage.objects for select
  using (bucket_id = 'coval-profile-banners');

drop policy if exists "Members upload their own profile banners" on storage.objects;
create policy "Members upload their own profile banners"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'coval-profile-banners' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Members delete their own profile banners" on storage.objects;
create policy "Members delete their own profile banners"
  on storage.objects for delete to authenticated
  using (bucket_id = 'coval-profile-banners' and (storage.foldername(name))[1] = auth.uid()::text);
