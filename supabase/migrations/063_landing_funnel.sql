-- =====================================================================
-- 063: воронка лендинга QR-альбома (/events/).
--
--   (a) человеческие визиты на /events (дедуп на браузер/день по session_id)
--   (b) клики Buy по тарифам small/medium/large/pro
--   (c) в админке — рядом COMPLETED заказы из paypal_orders за тот же день
--
-- Клиент сам отсекает ботов (webdriver, UA, prefetch/prerender) и не шлёт
-- визит повторно в тот же день. Сервер дополнительно:
--   • принимает только через SECURITY DEFINER RPC landing_track
--   • RLS на таблице без политик (прямой insert/select для anon закрыт)
--   • sanity: kind/tier/session_id, длина, допустимые значения
--   • rate: не больше 30 событий с одного session_id за 10 минут
--   • визит: не больше одного на (session_id, day) — unique index
--
-- admin_landing_funnel(p_days) — только service_role (как admin_stats),
-- зовётся из mod-api. НЕ трогает Paddle.
--
-- ПОДГОТОВЛЕНО, НЕ ПРИМЕНЕНО: нужен накат вручную после ревью
-- (supabase db push / SQL Editor). До наката сайт работает: RPC нет —
-- клиент молча игнорирует ошибку.
-- =====================================================================

create table if not exists public.landing_events (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('visit', 'buy_click')),
  tier        text check (tier is null or tier in ('small', 'medium', 'large', 'pro')),
  session_id  text not null,
  day         date not null default (timezone('utc', now()))::date,
  created_at  timestamptz not null default now(),
  constraint landing_events_tier_kind_chk check (
    (kind = 'visit' and tier is null)
    or (kind = 'buy_click' and tier is not null)
  )
);

comment on table public.landing_events is
  '063: визиты /events и клики Buy (small/medium/large/pro). Пишется только через landing_track.';

create unique index if not exists landing_events_visit_session_day
  on public.landing_events (session_id, day)
  where kind = 'visit';

create index if not exists landing_events_day_kind
  on public.landing_events (day, kind);

create index if not exists landing_events_session_created
  on public.landing_events (session_id, created_at desc);

alter table public.landing_events enable row level security;
-- Политик нет: anon/authenticated не читают и не пишут напрямую.

/**
 * Запись визита или клика Buy. Возвращает true, если строка вставлена;
 * false — дубль визита, rate-limit или плохие аргументы. Исключений почти
 * не бросает (кроме совсем битых типов), чтобы фронт мог звать fire-and-forget.
 */
create or replace function public.landing_track(
  p_kind text,
  p_session_id text,
  p_tier text default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  k   text := lower(nullif(btrim(coalesce(p_kind, '')), ''));
  sid text := nullif(btrim(coalesce(p_session_id, '')), '');
  tr  text := lower(nullif(btrim(coalesce(p_tier, '')), ''));
  n   int;
begin
  -- session_id: uuid-подобная строка 8..64, только безопасные символы
  if sid is null or length(sid) < 8 or length(sid) > 64
     or sid !~ '^[A-Za-z0-9_-]+$' then
    return false;
  end if;

  if k is null or k not in ('visit', 'buy_click') then return false; end if;

  if k = 'visit' then
    tr := null;
  else
    if tr is null or tr not in ('small', 'medium', 'large', 'pro') then
      return false;
    end if;
  end if;

  -- rate: не больше 30 событий с одной сессии за 10 минут
  select count(*) into n
    from landing_events
   where session_id = sid
     and created_at > now() - interval '10 minutes';
  if n >= 30 then return false; end if;

  if k = 'visit' then
    insert into landing_events (kind, tier, session_id, day)
      values ('visit', null, sid, (timezone('utc', now()))::date)
    on conflict (session_id, day) where kind = 'visit' do nothing;
    get diagnostics n = row_count;
    if n > 0 then return true; end if;
    -- уже учтён сегодня — для клиента это тоже успех (не спамить)
    return exists (
      select 1 from landing_events
       where kind = 'visit' and session_id = sid
         and day = (timezone('utc', now()))::date);
  end if;

  insert into landing_events (kind, tier, session_id, day)
    values ('buy_click', tr, sid, (timezone('utc', now()))::date);
  get diagnostics n = row_count;
  return n > 0;
end $$;

revoke all on function public.landing_track(text, text, text) from public;
grant execute on function public.landing_track(text, text, text) to anon, authenticated;

/**
 * Дневная воронка для панели модерации.
 * visits / buy_* — из landing_events; paid_* — COMPLETED из paypal_orders
 * (только event-тарифы; Pro-подписки сюда не входят — это /events воронка).
 * kind like 'event%' покрывает legacy 'event' и 'event_small/medium/large'.
 */
create or replace function public.admin_landing_funnel(p_days int default 30)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with win as (select greatest(1, least(coalesce(p_days, 30), 365)) as d),
  days as (
    select generate_series(
      (timezone('utc', now()))::date - ((select d from win) - 1),
      (timezone('utc', now()))::date,
      interval '1 day'
    )::date as day
  ),
  le as (
    select * from landing_events
     where day >= (timezone('utc', now()))::date - ((select d from win) - 1)
  ),
  po as (
    select
      (timezone('utc', created_at))::date as day,
      coalesce(tier, case
        when kind = 'event_medium' then 'medium'
        when kind = 'event_large'  then 'large'
        when kind like 'event%'    then 'small'
        else null end) as tier
    from paypal_orders
    where status = 'COMPLETED'
      and kind like 'event%'
      and created_at >= ((timezone('utc', now()))::date - ((select d from win) - 1))::timestamptz
  )
  select jsonb_build_object(
    'days', (select d from win),
    'totals', jsonb_build_object(
      'visits',     (select count(*) from le where kind = 'visit'),
      'buy_small',  (select count(*) from le where kind = 'buy_click' and tier = 'small'),
      'buy_medium', (select count(*) from le where kind = 'buy_click' and tier = 'medium'),
      'buy_large',  (select count(*) from le where kind = 'buy_click' and tier = 'large'),
      'buy_pro',    (select count(*) from le where kind = 'buy_click' and tier = 'pro'),
      'paid_small', (select count(*) from po where tier = 'small'),
      'paid_medium',(select count(*) from po where tier = 'medium'),
      'paid_large', (select count(*) from po where tier = 'large'),
      'paid_total', (select count(*) from po)
    ),
    'by_day', (select coalesce(jsonb_agg(x order by x->>'day'), '[]'::jsonb) from (
      select jsonb_build_object(
        'day', d.day,
        'visits',     (select count(*) from le e where e.day = d.day and e.kind = 'visit'),
        'buy_small',  (select count(*) from le e where e.day = d.day and e.kind = 'buy_click' and e.tier = 'small'),
        'buy_medium', (select count(*) from le e where e.day = d.day and e.kind = 'buy_click' and e.tier = 'medium'),
        'buy_large',  (select count(*) from le e where e.day = d.day and e.kind = 'buy_click' and e.tier = 'large'),
        'buy_pro',    (select count(*) from le e where e.day = d.day and e.kind = 'buy_click' and e.tier = 'pro'),
        'paid_small', (select count(*) from po p where p.day = d.day and p.tier = 'small'),
        'paid_medium',(select count(*) from po p where p.day = d.day and p.tier = 'medium'),
        'paid_large', (select count(*) from po p where p.day = d.day and p.tier = 'large'),
        'paid',       (select count(*) from po p where p.day = d.day)
      ) as x
      from days d
    ) s)
  );
$$;

revoke all on function public.admin_landing_funnel(int) from public, anon, authenticated;
-- service_role обходит revoke через суперправа PostgREST; явный grant не нужен,
-- как у admin_stats.
