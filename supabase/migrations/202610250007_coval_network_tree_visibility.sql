alter table public.coval_member_connections
  add column if not exists show_in_network boolean not null default false;

create index if not exists coval_member_network_visible_idx
  on public.coval_member_connections (user_id, target_user_id)
  where show_in_network = true;

grant update (show_in_network) on public.coval_member_connections to authenticated;
