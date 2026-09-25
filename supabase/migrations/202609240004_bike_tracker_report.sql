-- Daily bike distance from ordered GPS fixes, grouped by the fleet's local day.
-- A speed sanity check drops impossible GPS jumps; values are estimates from samples.
create or replace function public.daily_bike_tracker_report(p_start_date date, p_end_date date)
returns table(report_date date, site text, bike_reg text, kms_covered numeric)
language sql
stable
security definer
set search_path = public
as $$
  with days as (
    select generate_series(p_start_date, p_end_date, interval '1 day')::date as day
  ),
  fleet as (
    select d.id as device_id,
      coalesce(nullif(trim(r.store), ''), nullif(trim(r.team), ''), 'Unassigned site') as site,
      coalesce(nullif(trim(r.vehicle), ''), d.name, 'Unregistered bike') as bike_reg,
      (d.created_at at time zone 'Africa/Lusaka')::date as enrolled_day
    from public.devices d
    left join public.riders r on r.id = d.rider_id
  ),
  points as (
    select l.device_id,
      (l.recorded_at at time zone 'Africa/Lusaka')::date as day,
      l.latitude, l.longitude, l.recorded_at,
      lag(l.latitude) over (partition by l.device_id, (l.recorded_at at time zone 'Africa/Lusaka')::date order by l.recorded_at) as prev_lat,
      lag(l.longitude) over (partition by l.device_id, (l.recorded_at at time zone 'Africa/Lusaka')::date order by l.recorded_at) as prev_lon,
      lag(l.recorded_at) over (partition by l.device_id, (l.recorded_at at time zone 'Africa/Lusaka')::date order by l.recorded_at) as prev_at
    from public.locations l
    where l.recorded_at >= (p_start_date::timestamp at time zone 'Africa/Lusaka')
      and l.recorded_at < ((p_end_date + 1)::timestamp at time zone 'Africa/Lusaka')
      and (l.accuracy is null or l.accuracy <= 100)
  ),
  distances as (
    select p.device_id, p.day,
      6371.0088 * 2 * asin(sqrt(least(1, greatest(0,
        power(sin(radians(p.latitude - p.prev_lat) / 2), 2) +
        cos(radians(p.prev_lat)) * cos(radians(p.latitude)) *
        power(sin(radians(p.longitude - p.prev_lon) / 2), 2)
      )))) as km
    from points p
    where p.prev_at is not null
      and extract(epoch from (p.recorded_at - p.prev_at)) > 0
      and (6371.0088 * 2 * asin(sqrt(least(1, greatest(0,
        power(sin(radians(p.latitude - p.prev_lat) / 2), 2) +
        cos(radians(p.prev_lat)) * cos(radians(p.latitude)) *
        power(sin(radians(p.longitude - p.prev_lon) / 2), 2)
      ))))) / extract(epoch from (p.recorded_at - p.prev_at)) <= 0.05
  ),
  totals as (
    select device_id, day, sum(km) as km from distances group by device_id, day
  )
  select days.day as report_date, fleet.site, fleet.bike_reg,
    round(coalesce(totals.km, 0)::numeric, 2) as kms_covered
  from days cross join fleet
  left join totals on totals.device_id = fleet.device_id and totals.day = days.day
  where days.day >= fleet.enrolled_day
  order by days.day desc, fleet.site, fleet.bike_reg;
$$;

revoke all on function public.daily_bike_tracker_report(date,date) from public, anon, authenticated;
grant execute on function public.daily_bike_tracker_report(date,date) to service_role;
