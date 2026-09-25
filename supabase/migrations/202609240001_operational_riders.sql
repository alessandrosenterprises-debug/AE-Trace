-- Operational rider profiles and device-to-rider assignment.
create table if not exists public.riders (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text,
  phone text,
  staff_code text,
  team text,
  vehicle text,
  status text not null default 'active' check (status in ('active','paused','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists riders_staff_code_unique on public.riders(staff_code) where staff_code is not null and staff_code <> '';

alter table public.devices add column if not exists rider_id uuid references public.riders(id) on delete set null;
alter table public.devices add column if not exists device_model text;
alter table public.devices add column if not exists app_version text;
create index if not exists devices_rider_id on public.devices(rider_id);
alter table public.enrollments add column if not exists rider_id uuid references public.riders(id) on delete set null;

create or replace function public.set_rider_updated_at()
returns trigger language plpgsql set search_path=public as $$
begin new.updated_at=now(); return new; end;
$$;
drop trigger if exists riders_updated_at on public.riders;
create trigger riders_updated_at before update on public.riders
for each row execute function public.set_rider_updated_at();

-- The API now binds a one-use code to its designated rider atomically.
drop function if exists public.enroll_device(text,text,text,text);
create or replace function public.enroll_device(
  p_code_hash text, p_name text, p_platform text, p_token_hash text, p_device_model text default null
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
  if enrollment.rider_id is not null and not exists (select 1 from public.riders where id=enrollment.rider_id and status='active') then
    raise exception 'Assigned rider is not active';
  end if;
  update public.enrollments set used_at = now() where code_hash = p_code_hash;
  insert into public.devices(name, platform, token_hash, rider_id, device_model)
    values (left(trim(p_name), 100), p_platform, p_token_hash, enrollment.rider_id, left(p_device_model, 120))
    returning id into new_device_id;
  return new_device_id;
end;
$$;
revoke all on function public.enroll_device(text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.enroll_device(text,text,text,text,text) to service_role;

alter table public.riders enable row level security;
grant select on public.riders to authenticated, service_role;
drop policy if exists "Admins can read riders" on public.riders;
create policy "Admins can read riders" on public.riders
  for select to authenticated using (exists (select 1 from public.app_admins a where a.user_id=(select auth.uid())));

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='riders') then
    alter publication supabase_realtime add table public.riders;
  end if;
end $$;
