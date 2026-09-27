create table if not exists public.delivery_report_rider_roster (
  rider_name text primary key check (length(btrim(rider_name)) > 0),
  home_store text not null check (length(btrim(home_store)) > 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists delivery_report_rider_roster_store_idx
  on public.delivery_report_rider_roster (home_store, rider_name);

create table if not exists public.delivery_report_store_targets (
  id bigint generated always as identity primary key,
  report_month date not null,
  store_name text not null check (length(btrim(store_name)) > 0),
  target integer not null check (target > 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (report_month, store_name)
);

create index if not exists delivery_report_store_targets_month_idx
  on public.delivery_report_store_targets (report_month, store_name);

alter table public.delivery_report_rider_roster enable row level security;
alter table public.delivery_report_store_targets enable row level security;

revoke all on public.delivery_report_rider_roster from anon, authenticated;
revoke all on public.delivery_report_store_targets from anon, authenticated;
grant all on public.delivery_report_rider_roster to service_role;
grant all on public.delivery_report_store_targets to service_role;
grant usage, select on sequence public.delivery_report_store_targets_id_seq to service_role;
