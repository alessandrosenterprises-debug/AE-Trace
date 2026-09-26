-- Five-second rider location policy. The Android client requests this cadence;
-- the OS may still throttle or batch updates to protect the device.
alter table public.fleet_settings
  alter column location_interval_seconds set default 5;

alter table public.fleet_settings
  drop constraint if exists fleet_settings_location_interval_seconds_check;

alter table public.fleet_settings
  add constraint fleet_settings_location_interval_seconds_check
  check (location_interval_seconds between 5 and 300);

update public.fleet_settings
set location_interval_seconds = 5
where id = 1;
