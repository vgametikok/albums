-- Filter "Events" in admin Users list: accounts that own at least one event album.
-- p_plan = 'events' is a virtual plan filter (not a profiles.plan value).
-- plans.events = number of such accounts (same units as free/pro chips).

create or replace function public.admin_users(
  p_plan    text default null,     -- 'free' | 'pro' | 'events' | null = all
  p_country text default null,
  p_q       text default null,
  p_limit   int  default 50,
  p_offset  int  default 0)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  lim int := greatest(1, least(coalesce(p_limit, 50), 200));
  off int := greatest(0, coalesce(p_offset, 0));
  q   text := nullif(btrim(coalesce(p_q, '')), '');
  out jsonb;
begin
  with people as (
    select p.id, p.username, p.display_name, p.plan, p.plan_since, p.plan_until,
           p.country, p.created_at, p.banned_at, p.deleted_at,
           u.email::text as email,
           coalesce(q2.granted_total, 0) as event_bought,
           coalesce(q2.credits, 0)       as event_left,
           (select count(*) from albums a where a.author_id = p.id and a.is_event) as event_albums
      from profiles p
      join auth.users u on u.id = p.id and coalesce(u.is_anonymous, false) = false
      left join event_quota q2 on q2.user_id = p.id
  ),
  filtered as (
    select * from people
     where (
            p_plan is null
            or (p_plan = 'events' and event_albums > 0)
            or (p_plan in ('free', 'pro') and plan = p_plan)
           )
       and (p_country is null
            or (p_country = '??' and country is null)
            or country = upper(p_country))
       and (q is null
            or username ilike '%' || q || '%'
            or coalesce(display_name, '') ilike '%' || q || '%'
            or coalesce(email, '') ilike '%' || q || '%')
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'shown_from', off,
    'rows', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at desc)
        from (select * from filtered order by created_at desc limit lim offset off) r), '[]'::jsonb),
    'countries', coalesce((
      select jsonb_agg(jsonb_build_object('code', code, 'n', n) order by n desc, code)
        from (select coalesce(country, '??') as code, count(*) as n
                from people group by coalesce(country, '??')) c), '[]'::jsonb),
    'plans', jsonb_build_object(
      'free',   (select count(*) from people where plan = 'free'),
      'pro',    (select count(*) from people where plan = 'pro'),
      'events', (select count(*) from people where event_albums > 0)),
    'guests', (select count(*) from profiles p
                join auth.users u on u.id = p.id
               where coalesce(u.is_anonymous, false))
  ) into out;
  return out;
end;
$$;

revoke execute on function public.admin_users(text, text, text, int, int)
  from public, anon, authenticated;
