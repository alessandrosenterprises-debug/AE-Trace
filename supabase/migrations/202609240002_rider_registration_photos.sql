-- Rider self-registration fields and private profile-photo storage.
alter table public.riders add column if not exists store text;
alter table public.riders add column if not exists photo_path text;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('rider-photos', 'rider-photos', false, 1048576, array['image/jpeg'])
on conflict (id) do update set public=false, file_size_limit=1048576, allowed_mime_types=array['image/jpeg'];

create or replace function public.enroll_rider_device(
  p_code_hash text,
  p_full_name text,
  p_store text,
  p_phone text,
  p_name text,
  p_platform text,
  p_token_hash text,
  p_device_model text,
  p_app_version text,
  p_battery integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  enrollment public.enrollments%rowtype;
  rider_id uuid;
  device_id uuid;
begin
  if length(trim(p_full_name)) < 2 or length(trim(p_full_name)) > 120 then raise exception 'Enter the rider full name'; end if;
  if length(trim(p_store)) < 1 or length(trim(p_store)) > 120 then raise exception 'Enter the store'; end if;
  if length(trim(p_phone)) < 5 or length(trim(p_phone)) > 40 then raise exception 'Enter a valid phone number'; end if;
  if p_battery is not null and (p_battery < 0 or p_battery > 100) then raise exception 'Invalid battery level'; end if;

  select * into enrollment from public.enrollments
    where code_hash=p_code_hash and used_at is null and expires_at>now()
    for update;
  if not found then raise exception 'Enrollment code invalid, expired, or already used'; end if;
  if (select count(*) from public.devices)>=50 then raise exception '50 device limit reached'; end if;

  if enrollment.rider_id is null then
    insert into public.riders(full_name,store,phone)
      values (trim(p_full_name),trim(p_store),trim(p_phone))
      returning id into rider_id;
  else
    select id into rider_id from public.riders where id=enrollment.rider_id and status='active' for update;
    if rider_id is null then raise exception 'Assigned rider is not active'; end if;
    update public.riders set full_name=trim(p_full_name),store=trim(p_store),phone=trim(p_phone) where id=rider_id;
  end if;

  update public.enrollments set used_at=now() where code_hash=p_code_hash;
  insert into public.devices(name,platform,token_hash,rider_id,device_model,app_version,battery)
    values(left(trim(p_name),100),p_platform,p_token_hash,rider_id,left(p_device_model,120),left(p_app_version,40),p_battery)
    returning id into device_id;
  return jsonb_build_object('device_id',device_id,'rider_id',rider_id);
end;
$$;

revoke all on function public.enroll_rider_device(text,text,text,text,text,text,text,text,text,integer) from public, anon, authenticated;
grant execute on function public.enroll_rider_device(text,text,text,text,text,text,text,text,text,integer) to service_role;
