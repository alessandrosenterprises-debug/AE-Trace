create table if not exists public.delivery_report_orders (
  id bigint generated always as identity primary key,
  order_no text not null,
  delivery_date date,
  delivery_time text,
  customer_name text,
  source text,
  store text,
  driver_name text,
  status text,
  value_currency text,
  value_amount numeric(14,2),
  mbd numeric(14,2),
  valid text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists delivery_report_orders_date_idx on public.delivery_report_orders (delivery_date desc);
create index if not exists delivery_report_orders_store_idx on public.delivery_report_orders (store);
create index if not exists delivery_report_orders_driver_idx on public.delivery_report_orders (driver_name);

alter table public.delivery_report_orders enable row level security;
revoke all on public.delivery_report_orders from anon, authenticated;
grant all on public.delivery_report_orders to service_role;
grant usage, select on sequence public.delivery_report_orders_id_seq to service_role;
