create table if not exists public.delivery_report_store_monthly_metrics (
  report_month date not null,
  store_name text not null check (length(btrim(store_name)) > 0),
  online_orders integer check (online_orders is null or online_orders >= 0),
  live_tracking_percent numeric(5,2) check (live_tracking_percent is null or live_tracking_percent between 0 and 100),
  failed_orders integer check (failed_orders is null or failed_orders >= 0),
  failed_revenue numeric(14,2) check (failed_revenue is null or failed_revenue >= 0),
  failed_percent numeric(5,2) check (failed_percent is null or failed_percent between 0 and 100),
  failed_reason text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (report_month, store_name)
);

create index if not exists delivery_report_store_monthly_metrics_month_idx
  on public.delivery_report_store_monthly_metrics (report_month, store_name);

alter table public.delivery_report_store_monthly_metrics enable row level security;
revoke all on public.delivery_report_store_monthly_metrics from anon, authenticated;
grant all on public.delivery_report_store_monthly_metrics to service_role;
