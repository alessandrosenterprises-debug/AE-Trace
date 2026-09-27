create table if not exists public.delivery_report_rider_targets (
  id bigint generated always as identity primary key,
  report_month date not null,
  rider_name text not null,
  target integer not null check (target > 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (report_month, rider_name)
);

create index if not exists delivery_report_rider_targets_month_idx
  on public.delivery_report_rider_targets (report_month, rider_name);

alter table public.delivery_report_rider_targets enable row level security;
revoke all on public.delivery_report_rider_targets from anon, authenticated;
grant all on public.delivery_report_rider_targets to service_role;
grant usage, select on sequence public.delivery_report_rider_targets_id_seq to service_role;
