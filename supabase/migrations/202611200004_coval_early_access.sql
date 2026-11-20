-- Early access: until the paywall is switched on, every member gets Pro features
-- (unlimited runs, 300 assistant questions, creating teams, private repositories).
--
-- Turn the paywall ON when you are ready to charge (run in the SQL editor):
--   insert into public.coval_settings (id, paywall_enabled) values (1, true)
--   on conflict (id) do update set paywall_enabled = true;
-- Turn it OFF again:
--   update public.coval_settings set paywall_enabled = false where id = 1;

create table if not exists public.coval_settings (
  id integer primary key check (id = 1),
  paywall_enabled boolean not null default false
);

alter table public.coval_settings enable row level security;
revoke all on public.coval_settings from anon, authenticated;

create or replace function public.coval_paywall_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select paywall_enabled from public.coval_settings where id = 1), false);
$$;

-- Same as before, except everyone is on Pro while the paywall is off.
create or replace function public.coval_plan(member uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when not public.coval_paywall_enabled() then 'pro'
    else coalesce((
      select 'pro' from public.coval_billing
      where user_id = member and plan = 'pro'
        and status in ('authenticated', 'active', 'pending', 'cancelled')
        and (current_period_end is null or current_period_end > now() - interval '3 days')
    ), 'free')
  end;
$$;

create or replace function public.coval_billing_summary()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'plan', public.coval_plan(auth.uid()),
    'earlyAccess', not public.coval_paywall_enabled(),
    'status', coalesce(billing.status, 'none'),
    'subscriptionId', billing.razorpay_subscription_id,
    'currentPeriodEnd', billing.current_period_end,
    'usage', jsonb_build_object(
      'evaluation', jsonb_build_object(
        'used', (select count(*) from public.coval_usage_events where user_id = auth.uid() and kind = 'evaluation' and created_at >= date_trunc('month', now())),
        'limit', public.coval_plan_limit(public.coval_plan(auth.uid()), 'evaluation')),
      'assistant', jsonb_build_object(
        'used', (select count(*) from public.coval_usage_events where user_id = auth.uid() and kind = 'assistant' and created_at >= date_trunc('month', now())),
        'limit', public.coval_plan_limit(public.coval_plan(auth.uid()), 'assistant'))),
    'resetsAt', date_trunc('month', now()) + interval '1 month')
  from (select 1) as one
  left join public.coval_billing billing on billing.user_id = auth.uid();
$$;

revoke all on function public.coval_paywall_enabled() from public, anon;
grant execute on function public.coval_paywall_enabled() to authenticated;
