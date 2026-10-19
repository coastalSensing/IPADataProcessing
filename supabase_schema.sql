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

-- =====================================================================================
-- v34: SURVEYS, KNOWN SITES, PROVENANCE (Phase 1 of the revamp) — additive, safe to re-run
-- =====================================================================================

-- 13. Surveys: one row per campaign ---------------------------------------------------
create table if not exists public.surveys (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  start_date  date,
  end_date    date,
  area        text,
  vessel      text,
  rig         jsonb,            -- streamer geometry: cable length, GPS offset, electrode spacing…
  notes       text,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);

-- 14. Known sites (seeded / surveyed targets) — replaces the day-code-in-the-name convention
create table if not exists public.sites (
  id          uuid primary key default gen_random_uuid(),
  survey_id   uuid references public.surveys(id) on delete set null,
  name        text not null,
  lat         double precision not null,
  lon         double precision not null,
  material    text,
  placed_on   date,
  depth_m     real,
  source      text,             -- 'seeded' | 'surveyed' | 'chart' …
  active      boolean not null default true,
  notes       text,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);
create unique index if not exists sites_survey_name_uq on public.sites (coalesce(survey_id, '00000000-0000-0000-0000-000000000000'::uuid), name);

-- 15. Link files, waypoints and calibrations to a survey -------------------------------
alter table public.data_files
  add column if not exists survey_id  uuid references public.surveys(id) on delete set null,
  add column if not exists survey_day integer,
  add column if not exists purpose    text;   -- 'survey_line' | 'setup' | 'lab_material' | 'lab_blank' | 'waypoints'
alter table public.waypoints
  add column if not exists survey_id uuid references public.surveys(id) on delete set null,
  add column if not exists site_id   uuid references public.sites(id) on delete set null;
alter table public.layback_calibrations
  add column if not exists survey_id        uuid references public.surveys(id) on delete set null,
  add column if not exists is_active        boolean not null default false,
  add column if not exists validation_rms_m real,
  add column if not exists anchor_ids       jsonb;

-- 16. Provenance on every confirmation ------------------------------------------------
alter table public.training_confirmations
  add column if not exists label_source text,   -- 'lab' | 'field_waypoint' | 'expert_review'
  add column if not exists data_file_id uuid references public.data_files(id) on delete set null,
  add column if not exists site_id      uuid references public.sites(id) on delete set null,
  add column if not exists survey_id    uuid references public.surveys(id) on delete set null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tc_label_source_chk') then
    alter table public.training_confirmations add constraint tc_label_source_chk
      check (label_source is null or label_source in ('lab','field_waypoint','expert_review'));
  end if;
end $$;
create index if not exists tc_label_source_idx on public.training_confirmations (label_source);
create index if not exists data_files_survey_idx on public.data_files (survey_id, survey_day);

-- 17. Guard: a confirmation only counts as AI-reviewed if it links to a real logged prediction.
-- Unverified AI fields are stripped (the human label is kept), so bad AI labels can't creep back in.
create or replace function public.tc_verify_ai_fn() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.ai_prediction_id is null
     or not exists (select 1 from public.ai_predictions p where p.id = new.ai_prediction_id) then
    new.ai_prediction_id := null;
    new.ai_used  := false;
    new.ai_class := null;
    new.ai_conf_pct := null;
  else
    new.ai_used := true;
  end if;
  if new.label_source is null then new.label_source := 'expert_review'; end if;
  return new;
end $$;
drop trigger if exists tc_verify_ai on public.training_confirmations;
create trigger tc_verify_ai before insert or update on public.training_confirmations
  for each row execute function public.tc_verify_ai_fn();
revoke all on function public.tc_verify_ai_fn() from public, anon, authenticated;

-- 18. Team-only access on the new tables -----------------------------------------------
do $$
declare t text; p record;
begin
  foreach t in array array['surveys','sites'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy %I on public.%I for select to authenticated using (public.is_team())', t||'_team_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_team())', t||'_team_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_team()) with check (public.is_team())', t||'_team_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_team())', t||'_team_delete', t);
  end loop;
end $$;

-- 19. Backfill: Fall 2024 survey, survey days, file purpose ------------------------------
insert into public.surveys (name, start_date, end_date, notes)
values ('Fall 2024', date '2024-10-29', date '2024-11-01', 'Created by v34 migration from data_files timestamps.')
on conflict (name) do nothing;

update public.data_files f
   set survey_id = s.id
  from public.surveys s
 where s.name = 'Fall 2024' and f.survey_id is null
   and f.first_ts is not null
   and to_date(left(f.first_ts, 10), 'YYYY/MM/DD') between s.start_date and s.end_date;

update public.data_files
   set survey_day = (regexp_match(file_name, 'day[ _]?([0-9]+)', 'i'))[1]::int
 where survey_day is null and file_name ~* 'day[ _]?[0-9]+';

update public.data_files
   set purpose = case
     when file_kind = 'waypoints' then 'waypoints'
     when lower(coalesce(run_name,'')) = 'setup' then 'setup'
     when file_kind = 'lab' then 'lab_material'
     else 'survey_line' end
 where purpose is null;

-- 20. New uploads are tagged automatically (survey by date, day from the file name, purpose) --
create or replace function public.df_autotag_fn() returns trigger
language plpgsql security definer set search_path = public as $$
declare d date;
begin
  if new.purpose is null then
    new.purpose := case
      when new.file_kind = 'waypoints' then 'waypoints'
      when lower(coalesce(new.run_name,'')) = 'setup' then 'setup'
      when new.file_kind = 'lab' then 'lab_material'
      else 'survey_line' end;
  end if;
  if new.survey_day is null and new.file_name ~* 'day[ _]?[0-9]+' then
    new.survey_day := (regexp_match(new.file_name, 'day[ _]?([0-9]+)', 'i'))[1]::int;
  end if;
  if new.survey_id is null and new.first_ts ~ '^[0-9]{4}/[0-9]{2}/[0-9]{2}' then
    d := to_date(left(new.first_ts, 10), 'YYYY/MM/DD');
    select s.id into new.survey_id from public.surveys s
     where d between s.start_date and coalesce(s.end_date, s.start_date)
     order by s.start_date desc limit 1;
  end if;
  return new;
end $$;
drop trigger if exists df_autotag on public.data_files;
create trigger df_autotag before insert on public.data_files
  for each row execute function public.df_autotag_fn();
revoke all on function public.df_autotag_fn() from public, anon, authenticated;

notify pgrst, 'reload schema';

-- =====================================================================================
-- v35: NORTH BEACH GROUND TRUTH + WAYPOINT ROLES — additive, safe to re-run
-- Source: Drive "waypoint_target_assignment.csv" / "NorthBeach_waypoint_assignment" and
-- "waypoint_logs.xlsx" (field log, Apr 21–23 2026); "Eagle Harbor Survey Metadata.xlsx".
-- =====================================================================================

-- 21. What each waypoint is. Only known_site and bathy_target may anchor layback or score coverage.
alter table public.waypoints add column if not exists role text;   -- known_site | bathy_target | detection | context
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'wp_role_chk') then
    alter table public.waypoints add constraint wp_role_chk
      check (role is null or role in ('known_site','bathy_target','detection','context'));
  end if;
end $$;
alter table public.sites
  add column if not exists segment        jsonb,     -- [[lat,lon],[lat,lon]] two most distant members
  add column if not exists waypoint_names text[],
  add column if not exists line_name      text;

-- 22. Surveys --------------------------------------------------------------------------------
insert into public.surveys (name, start_date, end_date, area, notes) values
 ('North Beach April 2026', date '2026-04-21', date '2026-04-23', 'North Beach, Puget Sound, WA (~47.708 N, 122.386 W)',
  'Seeded-target survey. Day 1-2 layback_drop lines, day 3 combo_drop lines. Ground truth: waypoint_target_assignment.csv + waypoint_logs.xlsx (Drive). Prior analysis: layback 10.5 +/- 4.7 m (NorthBeach_Layback_Findings_Summary).'),
 ('Eagle Harbor multibeam Sept 2024', date '2024-09-10', date '2024-09-17', 'Mouth of Eagle Harbor, Puget Sound, WA',
  'Norbit i80S multibeam + backscatter, R/V Phoenix (Survey ID 0002). Source of EH-TGT/EH-OUT/EH-MND bathymetry targets: independent of IP data, positions only.')
on conflict (name) do nothing;
update public.surveys set area = coalesce(area, 'Eagle Harbor (days 1-2), Point Wells area (day 4), Puget Sound, WA')
 where name = 'Fall 2024';

-- 23. North Beach seeded sites (12), from the waypoint assignment sheet ---------------------
with m(site, material, placed, line_name, names, notes) as (values
 ('1A','Steel',date '2026-04-21','Steel Pipe', array['1A-1','1A-2','1A-3','1A-4','1A-5'], 'Northernmost day-1 site. 1A-1 deep end, 1A-5 shallow end.'),
 ('1B','Steel',date '2026-04-21','Steel Pipe Day 1 First Half', array['1B-2','1B-3','1B-4','1B-5'], 'Southernmost day-1 site, surveyed first; used until 14:45, then the pipe was pulled deeper (see 1C).'),
 ('1C','Steel',date '2026-04-21','Steel Pipe Day 1 Second Half', array['1C-1','1C-2','1C-3','568','1C-4','1B-1'], 'Same pipe as 1B pulled deeper (downhill), in use from 14:45. 568 is a GPS mark on this line; 1B-1 sits on it.'),
 ('2A','Steel',date '2026-04-22','Steel Pipe Day 2', array['2A-1','584','2A-2','2A-3','2A-4'], 'Northernmost day-2 site. 584 is coordinate-identical to 2A-2.'),
 ('2B','Steel',date '2026-04-22','Steel Pipe Day 2', array['2B-1','2B-2','2B-3','2B-4','2B-5'], 'Middle day-2 site, oriented north/south.'),
 ('2C','Steel',date '2026-04-22','Steel Pipe Day 2', array['2C-1','2C-2','2C-3','2C-4','2C-5','2C-6'], 'Southernmost day-2 site.'),
 ('3A','Steel',date '2026-04-23','Steel Pipe Day 3', array['576','577','578','579','580','581','582','583'], 'Northernmost day-3 site (logged as 3A-1..8).'),
 ('3B','Asphalt',date '2026-04-23','Asphalt - Day 3', array['585','586','587','588','589','590','591'], 'Asphalt target (logged as 3B-1..7).'),
 ('3C (first)','Steel',date '2026-04-23','Steel Pipe Day 3', array['569','570','571','572','573','574','575'], 'Steel, first placement; line pulled from its spot and reset.'),
 ('3C (second half)','Steel',date '2026-04-23','Steel Pipe Day 3 - Second Half', array['606','605','604','559','560','603','567'], 'Steel, reset placement used from 11:23.'),
 ('3D','Ilmenite',date '2026-04-23','Ilminite - After 11 - Day 3', array['602','592','593','594','595','601','600','596','598','599'], 'Ilmenite. First drop (592-595) not seen; re-dropped ~8 m along-track at 11:00 (596-602).'),
 ('3E','Steel',date '2026-04-23','Steel Pipe Day 3', array['561','562','563','597','564','565','566'], 'Southernmost day-3 site.')
),
src as (select * from public.waypoints where source = 'IPA_waypoints_202604_w_coords_Google.kmz'),
pts as (select m.site, s.name, s.lat, s.lon from m join src s on s.name = any(m.names)),
far as (
  select distinct on (a.site) a.site, a.lat lat1, a.lon lon1, b.lat lat2, b.lon lon2
    from pts a join pts b on a.site = b.site
   order by a.site, (power(a.lat-b.lat,2) + power((a.lon-b.lon)*cos(radians(a.lat)),2)) desc)
insert into public.sites (survey_id, name, lat, lon, material, placed_on, source, notes, segment, waypoint_names, line_name)
select (select id from public.surveys where name = 'North Beach April 2026'), m.site,
       avg(p.lat), avg(p.lon), m.material, m.placed, 'seeded', m.notes,
       jsonb_build_array(jsonb_build_array(f.lat1, f.lon1), jsonb_build_array(f.lat2, f.lon2)), m.names, m.line_name
  from m join pts p on p.site = m.site join far f on f.site = m.site
 group by m.site, m.material, m.placed, m.notes, m.names, m.line_name, f.lat1, f.lon1, f.lat2, f.lon2
on conflict do nothing;

-- 24. Tag every waypoint with its role, survey and site ----------------------------------------
update public.waypoints w
   set role = 'known_site',
       survey_id = (select id from public.surveys where name = 'North Beach April 2026'),
       site_id = (select s.id from public.sites s join public.surveys v on v.id = s.survey_id
                   where v.name = 'North Beach April 2026' and w.name = any(s.waypoint_names) limit 1),
       material = coalesce(w.material, (select s.material from public.sites s join public.surveys v on v.id = s.survey_id
                   where v.name = 'North Beach April 2026' and w.name = any(s.waypoint_names) limit 1))
 where w.source = 'IPA_waypoints_202604_w_coords_Google.kmz' and w.role is null;

update public.waypoints
   set role = 'bathy_target', survey_id = (select id from public.surveys where name = 'Eagle Harbor multibeam Sept 2024')
 where role is null and (name ~ '^EH-TGT-' or name ~ '^EH-OUT-' or name ~ '^EH-MND-');
update public.waypoints set role = 'context'
 where role is null and name ~ '^CTX-';
update public.waypoints set role = 'detection', survey_id = (select id from public.surveys where name = 'Fall 2024')
 where role is null and (name ~ '^EH-(C|T|IP)-' or name ~* '^IP line');

notify pgrst, 'reload schema';

-- =====================================================================================
-- v37: LAB / SHORE / NEAR-SHORE LABELS + LAB REFERENCE PROVENANCE — additive, safe to re-run
-- Source: Drive "IPA data inventory.xlsx" (lab projects, shore stations, near-shore surveys) and
-- the run designator recorded in each processed file header (data_files.run_name).
-- =====================================================================================

-- 25. File labels ---------------------------------------------------------------------------
alter table public.data_files
  add column if not exists project  text,   -- Drive project folder, e.g. 'Lab-Galvanized Steel_02'
  add column if not exists material text;   -- target material for target runs; 'Seawater blank' for lab baselines
create index if not exists data_files_purpose_idx on public.data_files (purpose, material);

alter table public.lab_signatures
  add column if not exists data_file_id uuid references public.data_files(id) on delete cascade,
  add column if not exists project      text,
  add column if not exists source       text;   -- 'library' (built from the shared library) | 'manual'
create unique index if not exists lab_sig_file_xmt_uq on public.lab_signatures (data_file_id, xmt_hz) where data_file_id is not null;

-- 26. Surveys for the newly imported groups --------------------------------------------------
insert into public.surveys (name, start_date, end_date, area, notes) values
 ('Eagle Harbor March 2024', date '2024-03-18', date '2024-03-19', 'Eagle Harbor, Puget Sound, WA', 'Near Shore-Eagle Harbor March 2024 (R/V Phoenix, dipole-dipole 01).'),
 ('Near Shore Fall 2025',    date '2025-09-22', date '2025-09-23', 'Puget Sound, WA', 'Near Shore-IPA Fall Survey 2025.'),
 ('Shore Station tests',     date '2024-01-19', date '2025-06-13', 'Golden Gardens, Seattle, WA', 'Stationary beach tests, dipole-dipole 01, ~28.5 ppt. Sessions 1.19.24, 2.13.24, 3.15.24, 8.30.24, 4.29.25, 6.12.25.'),
 ('Lab tank tests',          date '2024-06-25', date '2025-08-12', 'Lab tank', 'Wenner array, Ag/AgCl RX. Each session alternates baseline (seawater only) and target runs.')
on conflict (name) do nothing;
update public.surveys set notes = coalesce(notes,'') || ' Inventory: Near Shore-Eagle Harbor, Point Wells October 2024 (10/29-11/1).'
 where name = 'Fall 2024' and coalesce(notes,'') not like '%Point Wells October 2024%';

update public.data_files set project = split_part(notes, '/', 3)
 where project is null and notes like 'Drive path: %/%/%';

update public.data_files set survey_id = (select id from public.surveys where name = 'Eagle Harbor March 2024')
 where survey_id is null and project = 'Near Shore-Eagle Harbor March 2024';
update public.data_files set survey_id = (select id from public.surveys where name = 'Near Shore Fall 2025')
 where survey_id is null and project = 'Near Shore-IPA Fall Survey 2025';
update public.data_files set survey_id = (select id from public.surveys where name = 'Shore Station tests')
 where survey_id is null and project like 'Shore Station-%';
update public.data_files set survey_id = (select id from public.surveys where name = 'Lab tank tests')
 where survey_id is null and notes like 'Drive path: %/Lab Data/%';

-- 27. Role and material for every lab and shore-station run ---------------------------------
with x as (
  select id, lower(coalesce(run_name,'')) rn, coalesce(project,'') p,
         (notes like 'Drive path: %/Beach Data/%') shore
    from public.data_files
   where notes like 'Drive path: %/Lab Data/%' or notes like 'Drive path: %/Beach Data/%'),
y as (
  select id, shore,
    case
      when rn ~ '^(setup|setuo|default|startup)' then 'setup'
      when rn ~ 'hydrolysis' then 'lab_test'
      when rn ~ '(baseline|^bl[0-9])' then case when shore then 'shore_blank' else 'lab_blank' end
      when rn ~ '(tea bag|^sandbag)' then 'lab_control'
      else case when shore then 'shore_target' else 'lab_material' end
    end as purpose,
    case
      when rn ~ '(baseline|^bl[0-9])' then case when shore then 'No anomaly' else 'Seawater blank' end
      when rn ~ '^(setup|setuo|default|startup)' or rn ~ 'hydrolysis' or rn ~ '(tea bag|^sandbag)' then null
      -- lab projects: the project defines the target (inventory "target(s)")
      when p ~* 'ag coin'           then 'Silver'
      when p ~* 'au paddle'         then 'Gold'
      when p ~* 'yukon gold'        then 'Gold'
      when p ~* 'cu wire|cu sand'   then 'Copper'
      when p ~* 'ilmenite'          then 'Ilmenite'
      when p ~* 'lab-pb'            then 'Lead'
      when p ~* 'lab-zn'            then 'Zinc'
      when p ~* 'mineral oil'       then 'Mineral Oil'
      when p ~* 'group 5'           then 'Group 5 Oil'
      when p ~* 'alaska crude'      then 'Alaska Crude Oil'
      when p ~* 'itb rebel'         then 'ITB Rebel Crude'
      when p ~* 'galvanized steel'  then 'Galvanized Steel'
      when p ~* 'silver ore'        then 'Silver Ore'
      when p ~* 'class 3 gas oil'   then 'Class 3 Gas Oil'
      -- shore sessions and the lab 'backup' folder: the run name defines the target
      when p ~* 'shore station-(4\.29\.25|6\.12\.25)' and rn ~ '^target' then 'Group 5 Oil'
      when p ~* 'shore station-6\.12\.25' and rn ~ '^silver' then 'Silver Ore'
      when rn ~ '^(sp[0-9]|steel pipe)' then 'Steel'
      when rn ~ '^(il[0-9]|ilmen|luminite)' then 'Ilmenite'
      when rn ~ '^pb' then 'Lead'
      when rn ~ '^cu' then 'Copper'
      when rn ~ '^au' then 'Gold'
      when rn ~ '^silver' then 'Silver'
      when rn ~ '^rutile' then 'Rutile'
      when rn ~ '^bronze' then 'Bronze'
      else null   -- unknown target (e.g. Shore Station 1.19.24 'ab#pl#', 3.15.24 'ss#-#'): left for review
    end as material
  from x)
update public.data_files d
   set purpose = y.purpose, material = y.material
  from y where d.id = y.id;

notify pgrst, 'reload schema';

-- =====================================================================================
-- v43: PROJECTS — shared working sets of survey lines + known targets, with notes and
-- per-pass verdicts (e.g. "did we get a good steel detection on this pass?"). Additive.
-- =====================================================================================
create table if not exists public.projects (
  id               uuid primary key default gen_random_uuid(),
  name             text not null unique,
  description      text,
  survey_id        uuid references public.surveys(id) on delete set null,
  data_file_ids    uuid[] not null default '{}',   -- the project's survey lines (data_files.id)
  targets          text[] not null default '{}',   -- known-target labels (site names, e.g. 2B)
  settings         jsonb  not null default '{}'::jsonb,
  archived         boolean not null default false,
  created_by       uuid default auth.uid(),
  created_by_email text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists public.project_notes (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects(id) on delete cascade,
  data_file_id uuid references public.data_files(id) on delete set null,   -- a line (optional)
  target       text,                                                       -- a known target (optional)
  event_ts     text,                                                       -- a crossing (optional)
  event_cum    real,
  verdict      text,                                                       -- pass verdict (optional)
  body         text,
  author       uuid default auth.uid(),
  author_email text,
  created_at   timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'project_notes_verdict_chk') then
    alter table public.project_notes add constraint project_notes_verdict_chk
      check (verdict is null or verdict in ('good','weak','missed','invalid','unsure'));
  end if;
end $$;
create index if not exists project_notes_project_idx on public.project_notes (project_id, created_at);

-- Team-only access. Notes can only be edited or deleted by their author.
do $$
declare t text; p record;
begin
  foreach t in array array['projects','project_notes'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
  end loop;
  create policy projects_team_select on public.projects for select to authenticated using (public.is_team());
  create policy projects_team_insert on public.projects for insert to authenticated with check (public.is_team());
  create policy projects_team_update on public.projects for update to authenticated using (public.is_team()) with check (public.is_team());
  create policy projects_team_delete on public.projects for delete to authenticated using (public.is_team());
  create policy project_notes_team_select on public.project_notes for select to authenticated using (public.is_team());
  create policy project_notes_team_insert on public.project_notes for insert to authenticated with check (public.is_team());
  create policy project_notes_own_update on public.project_notes for update to authenticated using (public.is_team() and author = auth.uid()) with check (public.is_team() and author = auth.uid());
  create policy project_notes_own_delete on public.project_notes for delete to authenticated using (public.is_team() and author = auth.uid());
end $$;

-- First project: the day-2 steel pipe drop at North Beach (waypoint_logs.xlsx / waypoint_target_assignment.csv)
insert into public.projects (name, description, survey_id, data_file_ids, targets, settings, created_by_email)
select 'Steel pipe drop · North Beach Day 2 (2A, 2B, 2C)',
       'Steel pipes dropped 22 Apr 2026 at North Beach: 2A northernmost, 2B middle (laid north–south), 2C southernmost '
       || '(waypoint_logs.xlsx, waypoint_target_assignment.csv). Lines: the 23 layback_drop runs recorded that day (17–39). '
       || 'Goal: decide for each pass over a target whether we got a good steel detection.',
       s.id,
       coalesce((select array_agg(f.id order by f.first_ts) from public.data_files f
                  where f.file_kind = 'field' and f.purpose = 'survey_line'
                    and f.first_ts like '2026/04/22%' and f.run_name like 'layback\_drop\_%'), '{}'),
       array['2A','2B','2C'],
       '{"date":"2026-04-22","material":"Steel"}'::jsonb,
       'abby@coastalsensing.com'
  from public.surveys s where s.name = 'North Beach April 2026'
on conflict (name) do nothing;

notify pgrst, 'reload schema';
