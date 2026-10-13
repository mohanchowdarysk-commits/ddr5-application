-- DDR Tray Scanner — team sync schema for a free Supabase project.
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to run more than once.

create table if not exists public.ddr_workspaces (
  id          text primary key,
  name        text not null,
  stations    jsonb not null default '[]'::jsonb,
  settings    jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

create table if not exists public.ddr_scans (
  id            uuid primary key,
  ws_id         text not null references public.ddr_workspaces(id) on delete cascade,
  station_id    text not null,
  raw           text,
  part          text,
  brand         text,
  gen           text,
  gen_inferred  boolean not null default false,
  label         text,
  serial        text,
  tray          integer,
  status        text not null,
  note          text,
  operator      text,
  device        text,
  ts            bigint not null,
  created_at    timestamptz not null default now()
);

create index if not exists ddr_scans_ws_ts on public.ddr_scans (ws_id, ts, id);
create index if not exists ddr_scans_ws_serial on public.ddr_scans (ws_id, serial);

-- Row Level Security. Workspace ids are long random strings that only people
-- with the share link know; the link is the key. See README "Security" for a
-- stricter setup with Supabase Auth.
alter table public.ddr_workspaces enable row level security;
alter table public.ddr_scans enable row level security;

drop policy if exists "ddr_workspaces_anon" on public.ddr_workspaces;
create policy "ddr_workspaces_anon" on public.ddr_workspaces
  for all to anon, authenticated using (true) with check (char_length(id) >= 16);

drop policy if exists "ddr_scans_anon" on public.ddr_scans;
create policy "ddr_scans_anon" on public.ddr_scans
  for all to anon, authenticated using (true) with check (true);

-- Live updates between devices.
do $$
begin
  begin
    alter publication supabase_realtime add table public.ddr_scans;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.ddr_workspaces;
  exception when duplicate_object then null;
  end;
end $$;
