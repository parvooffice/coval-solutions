-- Let users publish evaluation bundles for other signed-in COVAL members.
-- Private by default; only the report owner can publish or unpublish it.
alter table public.coval_code_evaluations
  add column if not exists is_public boolean not null default false,
  add column if not exists github_login text,
  add column if not exists public_report jsonb,
  add column if not exists public_signature text;

drop policy if exists "members view shared code evaluations" on public.coval_code_evaluations;
create policy "members view shared code evaluations"
  on public.coval_code_evaluations for select to authenticated
  using (is_public = true);

grant select, insert, update, delete on public.coval_code_evaluations to authenticated;
