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
