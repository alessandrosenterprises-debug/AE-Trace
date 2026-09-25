-- Single organization-wide policy row. Writes are performed only by the
-- authenticated server using the service role; devices can read only the
-- location interval through the server API.
create table if not exists public.fleet_settings (
  id integer primary key check (id = 1),
  offline_after_minutes integer not null default 2 check (offline_after_minutes between 1 and 60),
  low_battery_percent integer not null default 20 check (low_battery_percent between 5 and 50),
  stale_location_minutes integer not null default 30 check (stale_location_minutes between 5 and 240),
  location_interval_seconds integer not null default 15 check (location_interval_seconds between 15 and 300),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.fleet_settings enable row level security;
revoke all on public.fleet_settings from anon, authenticated;
insert into public.fleet_settings (id) values (1) on conflict (id) do nothing;
