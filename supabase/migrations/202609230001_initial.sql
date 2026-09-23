-- Aetrace schema. Enable RLS on every table and keep service-role credentials server-side.
create table if not exists public.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.enrollments (
  code_hash text primary key,
  label text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid not null references public.app_admins(user_id)
);

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  platform text not null check (platform in ('android','ios','other')),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  battery smallint check (battery between 0 and 100),
  status text not null default 'offline' check (status in ('online','offline'))
);

create table if not exists public.locations (
  id bigint generated always as identity primary key,
  device_id uuid not null references public.devices(id) on delete cascade,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  accuracy double precision check (accuracy between 0 and 100000),
  recorded_at timestamptz not null default now()
);
create index if not exists locations_device_time on public.locations(device_id, recorded_at desc);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  actor text not null,
  action text not null,
  device_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_created_at on public.audit_log(created_at desc);

create or replace view public.device_latest_locations
with (security_invoker = true) as
select distinct on (device_id) device_id, latitude, longitude, accuracy, recorded_at
from public.locations order by device_id, recorded_at desc;

-- Atomically consume an enrollment code and enforce the fleet limit.
create or replace function public.enroll_device(
  p_code_hash text, p_name text, p_platform text, p_token_hash text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  enrollment public.enrollments%rowtype;
  new_device_id uuid;
begin
  select * into enrollment from public.enrollments
    where code_hash = p_code_hash and used_at is null and expires_at > now()
    for update;
  if not found then raise exception 'Enrollment code invalid, expired, or already used'; end if;
  if (select count(*) from public.devices) >= 50 then raise exception '50 device limit reached'; end if;
  update public.enrollments set used_at = now() where code_hash = p_code_hash;
  insert into public.devices(name, platform, token_hash)
    values (left(trim(p_name), 100), p_platform, p_token_hash)
    returning id into new_device_id;
  return new_device_id;
end;
$$;
revoke all on function public.enroll_device(text,text,text,text) from public, anon, authenticated;
grant execute on function public.enroll_device(text,text,text,text) to service_role;

-- Service-role API access bypasses RLS. These policies also prevent browser clients
-- from reading fleet data unless their authenticated account is an enrolled admin.
alter table public.app_admins enable row level security;
alter table public.enrollments enable row level security;
alter table public.devices enable row level security;
alter table public.locations enable row level security;
alter table public.audit_log enable row level security;
grant select on public.app_admins, public.enrollments, public.devices, public.locations, public.audit_log to authenticated;
grant select on public.device_latest_locations to authenticated, service_role;

drop policy if exists "Admins can read their own admin record" on public.app_admins;
create policy "Admins can read their own admin record" on public.app_admins
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "Admins can read enrollments" on public.enrollments;
create policy "Admins can read enrollments" on public.enrollments
  for select to authenticated using (exists (select 1 from public.app_admins a where a.user_id = (select auth.uid())));

drop policy if exists "Admins can read devices" on public.devices;
create policy "Admins can read devices" on public.devices
  for select to authenticated using (exists (select 1 from public.app_admins a where a.user_id = (select auth.uid())));

drop policy if exists "Admins can read locations" on public.locations;
create policy "Admins can read locations" on public.locations
  for select to authenticated using (exists (select 1 from public.app_admins a where a.user_id = (select auth.uid())));

drop policy if exists "Admins can read audit log" on public.audit_log;
create policy "Admins can read audit log" on public.audit_log
  for select to authenticated using (exists (select 1 from public.app_admins a where a.user_id = (select auth.uid())));

-- Realtime pushes changes to logged-in dashboard clients. Table RLS remains active.
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='devices') then
    alter publication supabase_realtime add table public.devices;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='locations') then
    alter publication supabase_realtime add table public.locations;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='audit_log') then
    alter publication supabase_realtime add table public.audit_log;
  end if;
end $$;
