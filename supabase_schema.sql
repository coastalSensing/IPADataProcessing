-- IPA MIP Classifier Portal — Supabase schema (cumulative, idempotent)
-- Run in Supabase Dashboard → SQL Editor on a NEW project, or after any app update that changes this file.
-- Safe to re-run: every statement is IF NOT EXISTS / guarded.
-- Adds prediction columns to training_confirmations (for accuracy metrics) and
-- creates shared tables for lab reference signatures, known waypoints and layback calibrations.
-- Access: any signed-in (GitHub OAuth) user can read/write, matching the existing training table.

-- 0. Base table (only created on a brand-new project; existing projects skip this) --
create table if not exists public.training_confirmations (
  id            uuid primary key default gen_random_uuid(),
  material      text not null,
  run_name      text,
  xmt_hz        integer,
  dp_fund_mrad  real,
  dp_mid_mrad   real,
  dp_high_mrad  real,
  mag_pct       real,
  max_snr       real,
  fund_freq_hz  real,
  mid_freq_hz   real,
  high_freq_hz  real,
  ai_conf_pct   real,
  notes         text,
  created_by    uuid default auth.uid(),
  confirmed_at  timestamptz not null default now()
);

-- 1. Extend training confirmations ------------------------------------------------
alter table public.training_confirmations
  add column if not exists rules_class   text,
  add column if not exists ai_class      text,
  add column if not exists lab_class     text,
  add column if not exists lab_cos       real,
  add column if not exists fused_class   text,
  add column if not exists pred_conf_pct real,
  add column if not exists phase_slope   real,
  add column if not exists dp_dev_json   jsonb,
  add column if not exists lat           double precision,
  add column if not exists lon           double precision,
  add column if not exists cog_deg       real,
  add column if not exists sog_ms        real,
  add column if not exists proc_mode     text,
  add column if not exists app_version   text;

-- 2. Lab reference signatures ------------------------------------------------------
create table if not exists public.lab_signatures (
  id          uuid primary key default gen_random_uuid(),
  material    text not null,
  xmt_hz      integer not null,
  freqs_hz    jsonb not null,   -- [4,12,20,28,36,44]
  mean_mrad   jsonb not null,   -- mean ch1-0 phase at each harmonic (mrad)
  std_mrad    jsonb,            -- std (ddof=1) at each harmonic (mrad)
  n_pkts      integer,
  run_name    text,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);

-- 3. Known waypoints / seeded targets ---------------------------------------------
create table if not exists public.waypoints (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  lat         double precision not null,
  lon         double precision not null,
  material    text,
  source      text,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);

-- 4. Layback calibrations -----------------------------------------------------------
create table if not exists public.layback_calibrations (
  id             uuid primary key default gen_random_uuid(),
  layback_m      real not null,
  latency_s      real,
  bias_m         real,
  se_layback_m   real,
  n_matches      integer,
  rms_m          real,
  cross_mean_m   real,
  params         jsonb,
  notes          text,
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now()
);

-- 5. Row-level security: signed-in users only ------------------------------------
do $$
declare t text;
begin
  foreach t in array array['lab_signatures','waypoints','layback_calibrations'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_auth_select') then
      execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_auth_select', t);
    end if;
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_auth_insert') then
      execute format('create policy %I on public.%I for insert to authenticated with check (true)', t || '_auth_insert', t);
    end if;
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_auth_delete') then
      execute format('create policy %I on public.%I for delete to authenticated using (true)', t || '_auth_delete', t);
    end if;
  end loop;
end $$;

-- 6. Training cohorts: keep legacy (v26) confirmations from influencing new ones ----
alter table public.training_confirmations
  add column if not exists cohort        text,     -- 'legacy' | 'current'
  add column if not exists feature_basis text,     -- 'raw_v26' | 'deviation'
  add column if not exists ai_used       boolean,
  add column if not exists excluded      boolean not null default false;

-- Backfill: rows without an app version (and without v27 metadata in notes) are legacy.
update public.training_confirmations
   set cohort = case when app_version is not null or coalesce(notes,'') like '{"app":"v%' then 'current' else 'legacy' end
 where cohort is null;
update public.training_confirmations
   set feature_basis = case when cohort = 'current' then 'deviation' else 'raw_v26' end
 where feature_basis is null;
update public.training_confirmations
   set ai_used = (ai_class is not null) or coalesce(notes,'') like '%"ai_used":true%'
 where ai_used is null;

create index if not exists training_confirmations_cohort_idx on public.training_confirmations (cohort, excluded);

-- 7. Shared access: every signed-in team member sees and can curate ALL confirmations --
alter table public.training_confirmations enable row level security;
do $$
declare op text;
begin
  foreach op in array array['select','insert','update','delete'] loop
    if not exists (select 1 from pg_policies where tablename = 'training_confirmations' and policyname = 'tc_auth_' || op) then
      if op = 'insert' then
        execute 'create policy tc_auth_insert on public.training_confirmations for insert to authenticated with check (true)';
      elsif op = 'update' then
        execute 'create policy tc_auth_update on public.training_confirmations for update to authenticated using (true) with check (true)';
      else
        execute format('create policy %I on public.training_confirmations for %s to authenticated using (true)', 'tc_auth_' || op, op);
      end if;
    end if;
  end loop;
end $$;

-- 8. Shared data library: raw _p.txt / waypoint files ----------------------------
-- Files live in a PRIVATE Storage bucket; this table describes each one.
-- sha256 is unique, so the same file is never stored twice.
create table if not exists public.data_files (
  id                uuid primary key default gen_random_uuid(),
  storage_path      text not null unique,
  sha256            text not null unique,
  file_name         text not null,
  file_kind         text not null,          -- 'field' | 'lab' | 'waypoints'
  run_name          text,
  xmt_hz            integer,
  n_packets         integer,
  n_waypoints       integer,
  first_ts          text,
  last_ts           text,
  lat_min           double precision,
  lat_max           double precision,
  lon_min           double precision,
  lon_max           double precision,
  bytes             integer,
  notes             text,
  uploaded_by       uuid default auth.uid(),
  uploaded_by_email text,
  created_at        timestamptz not null default now()
);
create index if not exists data_files_kind_idx on public.data_files (file_kind, created_at desc);
alter table public.data_files enable row level security;
do $$
declare op text;
begin
  foreach op in array array['select','insert','update','delete'] loop
    if not exists (select 1 from pg_policies where tablename = 'data_files' and policyname = 'df_auth_' || op) then
      if op = 'insert' then
        execute 'create policy df_auth_insert on public.data_files for insert to authenticated with check (true)';
      elsif op = 'update' then
        execute 'create policy df_auth_update on public.data_files for update to authenticated using (true) with check (true)';
      else
        execute format('create policy %I on public.data_files for %s to authenticated using (true)', 'df_auth_' || op, op);
      end if;
    end if;
  end loop;
end $$;

-- Private storage bucket (50 MB per file) + access for signed-in users only
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('ipa-data', 'ipa-data', false, 52428800)
    on conflict (id) do nothing;
    if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'ipa_data_select') then
      create policy ipa_data_select on storage.objects for select to authenticated using (bucket_id = 'ipa-data');
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'ipa_data_insert') then
      create policy ipa_data_insert on storage.objects for insert to authenticated with check (bucket_id = 'ipa-data');
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'ipa_data_delete') then
      create policy ipa_data_delete on storage.objects for delete to authenticated using (bucket_id = 'ipa-data');
    end if;
  end if;
end $$;

-- Make PostgREST pick up new columns immediately
notify pgrst, 'reload schema';

-- =====================================================================================
-- v32: TEAM ACCESS CODE + SERVER-SIDE CLAUDE (continual learning from shared confirmations)
-- =====================================================================================
-- After running this file once, set the shared team password from the SQL Editor:
--     select public.set_access_code('your-team-password');
-- Change it any time the same way (existing members keep access).
-- Remove someone:  delete from public.team_members where email = 'someone@example.com';

create extension if not exists pgcrypto with schema extensions;
create schema if not exists ipa_private;            -- not exposed through the REST API
revoke all on schema ipa_private from anon, authenticated;

create table if not exists ipa_private.settings (
  key   text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
create table if not exists ipa_private.code_attempts (
  user_id uuid not null,
  ok boolean not null,
  at timestamptz not null default now()
);

-- 9. Team membership ----------------------------------------------------------------
create table if not exists public.team_members (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  email     text,
  user_name text,
  is_admin  boolean not null default false,
  joined_at timestamptz not null default now()
);
alter table public.team_members enable row level security;

create or replace function public.is_team() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.team_members where user_id = auth.uid());
$$;
create or replace function public.am_i_team() returns boolean
language sql stable security definer set search_path = public as $$ select public.is_team(); $$;
grant execute on function public.is_team(), public.am_i_team() to authenticated;

drop policy if exists tm_team_select on public.team_members;
create policy tm_team_select on public.team_members for select to authenticated using (public.is_team());

-- Shared password: stored only as a bcrypt hash; 10 wrong tries per hour per user.
create or replace function public.redeem_access_code(code text) returns boolean
language plpgsql volatile security definer set search_path = public, extensions as $$
declare h text; uid uuid := auth.uid(); fails int; u record;
begin
  if uid is null then raise exception 'Not signed in'; end if;
  if public.is_team() then return true; end if;
  select count(*) into fails from ipa_private.code_attempts
   where user_id = uid and not ok and at > now() - interval '1 hour';
  if fails >= 10 then raise exception 'Too many attempts. Try again in an hour.'; end if;
  select value into h from ipa_private.settings where key = 'access_code_hash';
  if h is null then raise exception 'No team password has been set yet. Ask the administrator.'; end if;
  if extensions.crypt(coalesce(code,''), h) = h then
    select email, raw_user_meta_data->>'user_name' as un into u from auth.users where id = uid;
    insert into public.team_members (user_id, email, user_name) values (uid, u.email, u.un)
      on conflict (user_id) do nothing;
    insert into ipa_private.code_attempts (user_id, ok) values (uid, true);
    return true;
  end if;
  insert into ipa_private.code_attempts (user_id, ok) values (uid, false);
  return false;
end $$;
revoke all on function public.redeem_access_code(text) from public, anon;
grant execute on function public.redeem_access_code(text) to authenticated;

create or replace function public.set_access_code(new_code text) returns text
language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  if length(coalesce(new_code,'')) < 8 then raise exception 'Use at least 8 characters'; end if;
  insert into ipa_private.settings (key, value, updated_at)
  values ('access_code_hash', extensions.crypt(new_code, extensions.gen_salt('bf', 10)), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return 'Team password updated';
end $$;
revoke all on function public.set_access_code(text) from public, anon, authenticated;  -- SQL Editor only

-- 10. AI predictions log (every Claude call; linked to the confirmation that follows) --
create table if not exists public.ai_predictions (
  id               uuid primary key default gen_random_uuid(),
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  model            text,
  run_name         text,
  event_ts         text,
  xmt_hz           integer,
  features         jsonb,
  rules_class      text,
  fused_class      text,
  lab_class        text,
  classification   text,
  confidence_pct   real,
  response         jsonb,
  example_ids      uuid[],
  n_examples       integer,
  input_tokens     integer,
  output_tokens    integer,
  latency_ms       integer,
  app_version      text,
  confirmation_id  uuid,
  confirmed_material text,
  confirmed_at     timestamptz
);
create index if not exists ai_predictions_created_idx on public.ai_predictions (created_at desc);
alter table public.ai_predictions enable row level security;
alter table public.training_confirmations add column if not exists ai_prediction_id uuid;

create or replace function public.tc_link_prediction_fn() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.ai_prediction_id is not null then
    update public.ai_predictions
       set confirmation_id = new.id, confirmed_material = new.material, confirmed_at = now()
     where id = new.ai_prediction_id;
  end if;
  return new;
end $$;
drop trigger if exists tc_link_prediction on public.training_confirmations;
create trigger tc_link_prediction after insert on public.training_confirmations
  for each row execute function public.tc_link_prediction_fn();
revoke all on function public.tc_link_prediction_fn() from public, anon, authenticated;

-- 11. Retrieval for continual learning: nearest confirmed events, balanced per class ----
-- Distance = Euclidean on z-scored deviation features. Runs with the caller's rights (RLS applies).
create or replace function public.nearest_confirmations(
  p_xmt int, p_dp1 real, p_dp3 real, p_dplast real, p_mag real, p_slope real,
  p_k_per_class int default 3, p_max int default 30)
returns table (id uuid, material text, xmt_hz int, dp_fund_mrad real, dp_mid_mrad real, dp_high_mrad real,
               mag_pct real, max_snr real, phase_slope real, ai_class text, fused_class text, dist double precision)
language sql stable security invoker set search_path = public as $$
  with pool as (
    select * from public.training_confirmations t
     where not coalesce(t.excluded,false) and coalesce(t.cohort,'current') = 'current'
       and t.material is not null and (p_xmt is null or t.xmt_hz = p_xmt)),
  sc as (
    select coalesce(nullif(stddev_samp(dp_fund_mrad),0),1) s1, coalesce(nullif(stddev_samp(dp_mid_mrad),0),1) s2,
           coalesce(nullif(stddev_samp(dp_high_mrad),0),1) s3, coalesce(nullif(stddev_samp(mag_pct),0),1) s4,
           coalesce(nullif(stddev_samp(phase_slope),0),1) s5 from pool),
  d as (
    select p.*, sqrt(
        power((coalesce(p.dp_fund_mrad,0)-coalesce(p_dp1,0))/sc.s1,2) + power((coalesce(p.dp_mid_mrad,0)-coalesce(p_dp3,0))/sc.s2,2)
      + power((coalesce(p.dp_high_mrad,0)-coalesce(p_dplast,0))/sc.s3,2) + power((coalesce(p.mag_pct,0)-coalesce(p_mag,0))/sc.s4,2)
      + power((coalesce(p.phase_slope,0)-coalesce(p_slope,0))/sc.s5,2)) as dist
    from pool p cross join sc),
  r as (select d.*, row_number() over (partition by d.material order by d.dist) rn from d)
  select r.id, r.material, r.xmt_hz, r.dp_fund_mrad, r.dp_mid_mrad, r.dp_high_mrad, r.mag_pct, r.max_snr,
         r.phase_slope, r.ai_class, r.fused_class, r.dist
    from r where r.rn <= p_k_per_class order by r.dist limit p_max;
$$;
grant execute on function public.nearest_confirmations(int,real,real,real,real,real,int,int) to authenticated;

create or replace function public.training_class_counts(p_xmt int default null)
returns table (material text, n bigint)
language sql stable security invoker set search_path = public as $$
  select material, count(*) from public.training_confirmations
   where not coalesce(excluded,false) and coalesce(cohort,'current') = 'current' and material is not null
     and (p_xmt is null or xmt_hz = p_xmt)
   group by material order by 2 desc;
$$;
grant execute on function public.training_class_counts(int) to authenticated;

-- 12. Lock every shared table and the file bucket to team members ---------------------
-- Drops ALL existing policies on these tables (including any "any signed-in user" ones)
-- and replaces them with team-only policies.
do $$
declare t text; p record;
begin
  foreach t in array array['training_confirmations','lab_signatures','waypoints','layback_calibrations','data_files','ai_predictions'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy %I on public.%I for select to authenticated using (public.is_team())', t||'_team_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_team())', t||'_team_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_team()) with check (public.is_team())', t||'_team_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_team())', t||'_team_delete', t);
  end loop;
  if to_regclass('storage.objects') is not null then
    for p in select policyname from pg_policies where schemaname='storage' and tablename='objects'
               and (coalesce(qual,'') like '%ipa-data%' or coalesce(with_check,'') like '%ipa-data%') loop
      execute format('drop policy %I on storage.objects', p.policyname);
    end loop;
    create policy ipa_data_team_select on storage.objects for select to authenticated using (bucket_id = 'ipa-data' and public.is_team());
    create policy ipa_data_team_insert on storage.objects for insert to authenticated with check (bucket_id = 'ipa-data' and public.is_team());
    create policy ipa_data_team_delete on storage.objects for delete to authenticated using (bucket_id = 'ipa-data' and public.is_team());
  end if;
end $$;

notify pgrst, 'reload schema';
