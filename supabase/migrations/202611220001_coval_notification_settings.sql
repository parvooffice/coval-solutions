-- Notification preferences, one row per member. Each switch turns a kind of notification on or off
-- (in the bell on the website and as Windows pop-ups in COVAL for Windows). feed_seen_at marks
-- when the member last opened the bell, so new Feed posts and messages before it show as read.
-- Safe to run again.

create table if not exists public.coval_notification_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  messages boolean not null default true,       -- new messages in your conversations
  jobs boolean not null default true,           -- new job and team posts in the Feed
  scores boolean not null default true,         -- people sharing scores; your runs finishing
  issues boolean not null default true,         -- new "Issues to solve" posts
  post_activity boolean not null default true,  -- interest in your posts, your interest accepted
  social boolean not null default true,         -- connections and team invites
  desktop_popups boolean not null default true, -- Windows pop-ups in COVAL for Windows
  feed_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.coval_notification_settings enable row level security;

drop policy if exists "Members read their notification settings" on public.coval_notification_settings;
create policy "Members read their notification settings" on public.coval_notification_settings
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "Members create their notification settings" on public.coval_notification_settings;
create policy "Members create their notification settings" on public.coval_notification_settings
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "Members update their notification settings" on public.coval_notification_settings;
create policy "Members update their notification settings" on public.coval_notification_settings
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select, insert, update on public.coval_notification_settings to authenticated;
