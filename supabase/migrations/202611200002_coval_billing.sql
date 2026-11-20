-- COVAL Free / Pro plans with Razorpay subscriptions.
--
-- The app never uses a service-role key, so plan changes arrive as entitlements signed by
-- the Express server (HMAC-SHA256 with COVAL_BILLING_SIGNING_SECRET) and are verified here
-- before they are stored. Members can read their own plan and usage but cannot write either.
--
-- After applying this migration, store the same secret the server uses (run once in the
-- SQL editor, replacing the placeholder):
--   insert into public.coval_billing_config (id, signing_secret) values (1, '<COVAL_BILLING_SIGNING_SECRET>')
--   on conflict (id) do update set signing_secret = excluded.signing_secret;

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.coval_billing (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  status text not null default 'none' check (status in ('none', 'created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed', 'expired')),
  razorpay_subscription_id text,
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.coval_billing_config (
  id integer primary key check (id = 1),
  signing_secret text not null check (char_length(signing_secret) >= 32)
);

create table if not exists public.coval_usage_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('evaluation', 'assistant')),
  created_at timestamptz not null default now()
);

create index if not exists coval_usage_events_user_month_idx on public.coval_usage_events (user_id, kind, created_at desc);

alter table public.coval_billing enable row level security;
alter table public.coval_billing_config enable row level security;
alter table public.coval_usage_events enable row level security;

drop policy if exists "members read their billing" on public.coval_billing;
create policy "members read their billing"
  on public.coval_billing for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "members read their usage" on public.coval_usage_events;
create policy "members read their usage"
  on public.coval_usage_events for select to authenticated
  using (user_id = auth.uid());

-- Read-only for members; no grants at all on the config table.
revoke all on public.coval_billing, public.coval_usage_events, public.coval_billing_config from anon, authenticated;
grant select on public.coval_billing, public.coval_usage_events to authenticated;

-- Pro stays active until the paid period ends, including after a cancellation.
create or replace function public.coval_plan(member uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select 'pro' from public.coval_billing
    where user_id = member and plan = 'pro'
      and status in ('authenticated', 'active', 'pending', 'cancelled')
      and (current_period_end is null or current_period_end > now() - interval '3 days')
  ), 'free');
$$;

create or replace function public.coval_plan_limit(plan_name text, usage_kind text)
returns integer
language sql
immutable
as $$
  select case
    when plan_name = 'pro' and usage_kind = 'evaluation' then null
    when plan_name = 'pro' and usage_kind = 'assistant' then 300
    when usage_kind = 'evaluation' then 5
    when usage_kind = 'assistant' then 10
  end;
$$;

-- Records one use of a metered feature, or raises when the monthly limit is reached.
create or replace function public.coval_consume_quota(usage_kind text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  plan_name text;
  monthly_limit integer;
  used integer;
begin
  if current_user_id is null then
    raise exception 'Sign in to use this feature.' using errcode = '28000';
  end if;
  if usage_kind not in ('evaluation', 'assistant') then
    raise exception 'Unknown usage type.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext(current_user_id::text || usage_kind));
  plan_name := public.coval_plan(current_user_id);
  monthly_limit := public.coval_plan_limit(plan_name, usage_kind);
  select count(*) into used from public.coval_usage_events
  where user_id = current_user_id and kind = usage_kind and created_at >= date_trunc('month', now());
  if monthly_limit is not null and used >= monthly_limit then
    raise exception 'Monthly limit reached: % % uses on the % plan. Upgrade to COVAL Pro for more.',
      monthly_limit, case usage_kind when 'evaluation' then 'evaluation' else 'assistant' end, initcap(plan_name)
      using errcode = 'P0001';
  end if;
  insert into public.coval_usage_events (user_id, kind) values (current_user_id, usage_kind);
  return jsonb_build_object('plan', plan_name, 'kind', usage_kind, 'used', used + 1, 'limit', monthly_limit);
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

-- Stores a plan change signed by the Express server. Callable without a session so
-- Razorpay webhooks can be applied; the HMAC and a five-minute freshness window are the guard.
create or replace function public.coval_apply_entitlement(
  member uuid, new_plan text, new_status text, subscription text, period_end timestamptz, issued_at bigint, signature text
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  secret text;
  payload text;
  expected text;
begin
  select signing_secret into secret from public.coval_billing_config where id = 1;
  if secret is null then
    raise exception 'Billing is not configured in the database.' using errcode = '55000';
  end if;
  if abs(extract(epoch from now()) - issued_at) > 300 then
    raise exception 'Billing update expired.' using errcode = '22023';
  end if;
  payload := concat_ws('|', member::text, new_plan, new_status, coalesce(subscription, ''),
    coalesce(floor(extract(epoch from period_end))::bigint::text, ''), issued_at::text);
  expected := encode(hmac(payload, secret, 'sha256'), 'hex');
  if signature is null or length(signature) <> length(expected) or signature <> expected then
    raise exception 'Invalid billing signature.' using errcode = '42501';
  end if;
  if new_plan not in ('free', 'pro') then
    raise exception 'Unknown plan.' using errcode = '22023';
  end if;
  insert into public.coval_billing (user_id, plan, status, razorpay_subscription_id, current_period_end, updated_at)
  values (member, new_plan, new_status, subscription, period_end, now())
  on conflict (user_id) do update set
    plan = excluded.plan,
    status = excluded.status,
    razorpay_subscription_id = coalesce(excluded.razorpay_subscription_id, coval_billing.razorpay_subscription_id),
    current_period_end = coalesce(excluded.current_period_end, coval_billing.current_period_end),
    updated_at = now();
  return true;
end;
$$;

-- Creating teams is a Pro feature; joining a team stays free.
create or replace function public.coval_create_team(team_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  new_team uuid;
begin
  if current_user_id is null then
    raise exception 'Sign in to create a team.' using errcode = '28000';
  end if;
  if public.coval_plan(current_user_id) <> 'pro' then
    raise exception 'Creating teams is part of COVAL Pro. Upgrade on the Plan page.' using errcode = 'P0001';
  end if;
  if char_length(btrim(coalesce(team_name, ''))) not between 2 and 80 then
    raise exception 'Team names must be 2 to 80 characters.' using errcode = '22023';
  end if;
  if (select count(*) from public.coval_teams where created_by = current_user_id) >= 20 then
    raise exception 'You can create up to 20 teams.' using errcode = '54000';
  end if;
  insert into public.coval_teams (name, created_by) values (btrim(team_name), current_user_id) returning id into new_team;
  insert into public.coval_team_members (team_id, user_id, role, status, invited_by, joined_at)
  values (new_team, current_user_id, 'admin', 'active', current_user_id, now());
  return new_team;
end;
$$;

revoke all on function public.coval_plan(uuid) from public, anon;
revoke all on function public.coval_consume_quota(text) from public, anon;
revoke all on function public.coval_billing_summary() from public, anon;
revoke all on function public.coval_apply_entitlement(uuid, text, text, text, timestamptz, bigint, text) from public;
grant execute on function public.coval_plan(uuid) to authenticated;
grant execute on function public.coval_consume_quota(text) to authenticated;
grant execute on function public.coval_billing_summary() to authenticated;
grant execute on function public.coval_apply_entitlement(uuid, text, text, text, timestamptz, bigint, text) to anon, authenticated;
