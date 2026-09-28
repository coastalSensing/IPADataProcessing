-- IPA MIP Classifier Portal v27 — Supabase schema migration
-- Run once in Supabase Dashboard → SQL Editor. Safe to re-run (idempotent).
-- Adds prediction columns to training_confirmations (for accuracy metrics) and
-- creates shared tables for lab reference signatures, known waypoints and layback calibrations.
-- Access: any signed-in (GitHub OAuth) user can read/write, matching the existing training table.

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

-- Make PostgREST pick up new columns immediately
notify pgrst, 'reload schema';
