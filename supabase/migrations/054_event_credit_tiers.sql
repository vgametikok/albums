-- =====================================================================
-- 054: тарифы кредитов событийного альбома — видно, какие именно куплены.
--
-- Требует 053_event_tiers.sql (колонки tier/album_id в paypal_orders и
-- event_tier в albums). 052 не нужна: admin_users здесь переписана целиком,
-- вместе с фильтром «Events».
--
-- Модель. Кредит — по-прежнему счётчик event_quota.credits. Тариф кредита
-- живёт в журнале paypal_orders: каждая оплата (PayPal order_… или Paddle
-- txn_…) и каждая ручная выдача с тарифом (admin:…) — строка с tier;
-- непотраченная = album_id is null. Всё, что покупалось ДО тарифов, стоило
-- $39.99, то есть это Small: кредит без строки журнала (старые оплаты и ручные
-- выдачи) считается Small, событийный альбом без тарифа — тоже Small.
--
--   event_credits_split(uid) -> {total, small, medium, large}
--     medium/large = непотраченные строки журнала этого тарифа, small = всё
--     остальное. Если кредитов меньше, чем строк (админ забрал кредит без
--     тарифа), Medium, потом Large урезаются до total — сумма всегда = total.
--
--  1. Бэкфилл: оплаченные заказы без тарифа -> small (по kind), событийные
--     альбомы без тарифа -> small (53 это уже делает; здесь повтор на случай,
--     если что-то создано между 053 и 054).
--  2. paypal_grant_event_tier — кредит и тариф ОДНОЙ транзакцией (вебхуки
--     PayPal и Paddle зовут её; пока её нет — старый путь из 040 + UPDATE).
--  3. my_event_credit_tiers — разбивка для кабинета.
--  4. event_album_create(+ p_tier) — пользователь выбирает, кредит какого
--     тарифа потратить; без p_tier — самый крупный (как в 053).
--  5. admin_grant_event(+ p_tier) — ручная выдача/отзыв с тарифом.
--  6. admin_users / admin_stats — разбивка по тарифам для панели модерации.
--  7. Срок хранения: 6 месяцев с ПЕРВОЙ загрузки в альбом (не с оплаты и не
--     с создания). albums.event_first_upload_at и event_storage_until ставит
--     триггер на album_media при первой загрузке; продление (+6 месяцев) —
--     будущая оплата сдвинет event_storage_until. Здесь только учёт срока:
--     ни удаления, ни оплаты продления нет. Непотраченный кредит не сгорает.
--
-- Повторный запуск безопасен.
-- =====================================================================

do $$ begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'paypal_orders' and column_name = 'album_id')
     or not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'albums' and column_name = 'event_tier') then
    raise exception '054 требует 053_event_tiers.sql — сначала выполните её';
  end if;
end $$;

-- ---------------------------------------------------------------- 1. бэкфилл

update public.paypal_orders
   set tier = case kind when 'event_medium' then 'medium' when 'event_large' then 'large' else 'small' end
 where tier is null and kind like 'event%';

update public.paypal_orders
   set guest_cap  = case tier when 'medium' then 250   when 'large' then 500    else 100   end,
       storage_gb = case tier when 'medium' then 200   when 'large' then 400    else 100   end,
       amount     = coalesce(amount, case when status = 'COMPLETED' then
                      case tier when 'medium' then 69.99 when 'large' then 129.99 else 39.99 end end)
 where tier is not null and (guest_cap is null or storage_gb is null);

alter table public.albums disable trigger albums_touch_t;
update public.albums
   set event_tier = 'small', event_guest_cap = 100, event_storage_gb = 100
 where is_event and event_tier is null;
alter table public.albums enable trigger albums_touch_t;

-- ---------------------------------------------------------------- разбивка

/**
 * {total, small, medium, large} непотраченных кредитов пользователя.
 * Строки журнала со статусом REVOKED (отозваны из панели) не считаются.
 */
create or replace function public.event_credits_split(p_uid uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare tot int; m int; l int; over int; d int;
begin
  select coalesce((select credits from event_quota where user_id = p_uid), 0) into tot;
  select count(*) filter (where tier = 'medium'), count(*) filter (where tier = 'large')
    into m, l
    from paypal_orders
   where user_id = p_uid and album_id is null and status in ('COMPLETED', 'GRANTED');
  over := m + l - tot;
  if over > 0 then
    d := least(m, over); m := m - d; over := over - d;
    l := greatest(0, l - over);
  end if;
  return jsonb_build_object('total', tot, 'small', tot - m - l, 'medium', m, 'large', l);
end $$;

/** Для кабинета: разбивка моих кредитов по тарифам. */
create or replace function public.my_event_credit_tiers()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null then null else public.event_credits_split(auth.uid()) end;
$$;

-- ---------------------------------------------------------------- выдача из вебхуков

/**
 * Оплата событийного альбома: строка заказа С ТАРИФОМ и +1 кредит — в одной
 * транзакции. Идемпотентно по order_id: повтор кредит не добавляет, лишь
 * дописывает тариф, если строку раньше записала старая paypal_grant_event.
 * Возвращает true, если кредит выдан сейчас. Только сервисный ключ.
 */
create or replace function public.paypal_grant_event_tier(p_order_id text, p_user_id uuid, p_tier text)
returns boolean language plpgsql security definer set search_path = public as $$
declare g int; gb int; amt numeric(10,2);
begin
  if p_tier is null or p_tier not in ('small', 'medium', 'large') then
    raise exception 'bad tier %', p_tier;
  end if;
  g   := case p_tier when 'medium' then 250   when 'large' then 500    else 100   end;
  gb  := case p_tier when 'medium' then 200   when 'large' then 400    else 100   end;
  amt := case p_tier when 'medium' then 69.99 when 'large' then 129.99 else 39.99 end;

  insert into paypal_orders (order_id, user_id, kind, status, tier, guest_cap, storage_gb, amount)
  values (p_order_id, p_user_id, 'event_' || p_tier, 'COMPLETED', p_tier, g, gb, amt)
  on conflict (order_id) do nothing;
  if not found then
    update paypal_orders
       set kind = 'event_' || p_tier, tier = p_tier, guest_cap = g, storage_gb = gb,
           amount = coalesce(amount, amt)
     where order_id = p_order_id and user_id = p_user_id
       and (tier is null or kind = 'event');
    return false;
  end if;

  insert into event_quota (user_id, credits, granted_total)
  values (p_user_id, 1, 1)
  on conflict (user_id) do update
    set credits       = event_quota.credits + 1,
        granted_total = event_quota.granted_total + 1,
        updated_at    = now();
  return true;
end $$;

-- ---------------------------------------------------------------- создание события

-- Новая сигнатура (+ p_tier). Старую убираем: при двух перегрузках вызов
-- с тремя именованными аргументами PostgREST счёл бы неоднозначным. Старый
-- фронт (три аргумента) продолжает работать — p_tier по умолчанию null.
drop function if exists public.event_album_create(text, text, text);

create or replace function public.event_album_create(
  p_title text, p_visibility text default 'private', p_description text default null,
  p_tier text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); vis visibility_level; a_id uuid; left_n int;
        want text := nullif(lower(btrim(coalesce(p_tier, ''))), '');
        split jsonb; o_id text; o_guests int; o_gb int;
begin
  if me is null then raise exception 'auth required'; end if;
  if coalesce(btrim(p_title), '') = '' then raise exception 'Нужно название события'; end if;
  if p_visibility not in ('public', 'friends', 'private') then raise exception 'bad visibility'; end if;
  if want is not null and want not in ('small', 'medium', 'large') then raise exception 'bad tier'; end if;
  vis := p_visibility::visibility_level;

  -- строка квоты под замок: два одновременных создания не возьмут один кредит
  perform 1 from event_quota where user_id = me for update;
  split := event_credits_split(me);
  if coalesce((split->>'total')::int, 0) < 1 then raise exception 'Нет доступных общих альбомов'; end if;

  if want is null then   -- тариф не выбран (старый фронт или кредит одного тарифа): самый крупный
    want := case when (split->>'large')::int > 0 then 'large'
                 when (split->>'medium')::int > 0 then 'medium' else 'small' end;
  end if;
  if coalesce((split->>want)::int, 0) < 1 then
    raise exception 'Нет доступного общего альбома тарифа %', want;
  end if;

  -- строка журнала этого тарифа (у Small её может не быть: старые кредиты)
  select order_id into o_id
    from paypal_orders
   where user_id = me and album_id is null and tier = want and status in ('COMPLETED', 'GRANTED')
   order by created_at
   limit 1
   for update;
  o_guests := case want when 'medium' then 250 when 'large' then 500 else 100 end;
  o_gb     := case want when 'medium' then 200 when 'large' then 400 else 100 end;

  update event_quota set credits = credits - 1, updated_at = now()
   where user_id = me and credits > 0
   returning credits into left_n;
  if not found then raise exception 'Нет доступных общих альбомов'; end if;

  perform set_config('app.event_create', '1', true);
  insert into albums (author_id, title, description, visibility, is_event,
                      event_hold_guest, published_at,
                      event_tier, event_guest_cap, event_storage_gb)
  values (me, btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''), vis, true, true,
          case when vis = 'private' then null else now() end,
          want, o_guests, o_gb)
  returning id into a_id;
  perform set_config('app.event_create', '', true);

  if o_id is not null then
    update paypal_orders set album_id = a_id where order_id = o_id;
  end if;

  return jsonb_build_object('album_id', a_id, 'credits_left', left_n,
                            'tier', want, 'guest_cap', o_guests, 'storage_gb', o_gb);
end $$;

-- ---------------------------------------------------------------- ручная выдача

drop function if exists public.admin_grant_event(text, int);

/**
 * Выдать (или отобрать отрицательным числом) кредиты событий из панели.
 * p_tier null или 'small' — как раньше, счётчиком (кредит без строки журнала
 * и есть Small); если после отзыва кредитов меньше, чем строк Medium/Large,
 * лишние строки гасятся. 'medium'/'large': выдача пишет строки журнала admin:… со
 * статусом GRANTED, отзыв помечает непотраченные строки этого тарифа REVOKED
 * (сначала ручные, потом оплаченные) и снимает ровно столько кредитов.
 */
create or replace function public.admin_grant_event(p_username text, p_count int, p_tier text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u uuid; c int; n int := coalesce(p_count, 0); k int := 0;
        tr text := nullif(lower(btrim(coalesce(p_tier, ''))), '');
begin
  if tr = 'small' then tr := null; end if;
  if tr is not null and tr not in ('medium', 'large') then return jsonb_build_object('error', 'bad_tier'); end if;
  select id into u from profiles where username = lower(btrim(p_username));
  if u is null then return jsonb_build_object('error', 'not_found'); end if;

  if tr is not null and n > 0 then
    n := least(n, 100);
    insert into paypal_orders (order_id, user_id, kind, status, tier, guest_cap, storage_gb)
    select 'admin:' || gen_random_uuid(), u, 'event_' || tr, 'GRANTED', tr,
           case tr when 'large' then 500 else 250 end, case tr when 'large' then 400 else 200 end
      from generate_series(1, n);
  elsif tr is not null and n < 0 then
    with v as (
      select order_id from paypal_orders
       where user_id = u and album_id is null and tier = tr and status in ('COMPLETED', 'GRANTED')
       order by (status = 'GRANTED') desc, created_at desc
       limit (-n)
       for update)
    update paypal_orders o set status = 'REVOKED' from v where o.order_id = v.order_id;
    get diagnostics k = row_count;
    n := -k;
  end if;

  insert into event_quota (user_id, credits, granted_total)
  values (u, greatest(0, n), greatest(0, n))
  on conflict (user_id) do update
    set credits       = greatest(0, event_quota.credits + n),
        granted_total = event_quota.granted_total + greatest(0, n),
        updated_at    = now()
  returning credits into c;

  -- Забрали кредиты без тарифа, и строк Medium/Large стало больше, чем
  -- кредитов: лишние строки гасим (как их урезает event_credits_split —
  -- сначала Medium, ручные раньше оплаченных), иначе при следующей выдаче
  -- Small они бы «воскресли» как Medium/Large.
  if tr is null and n < 0 then
    with rows as (
      select order_id, row_number() over (
               order by (tier = 'medium') desc, (status = 'GRANTED') desc, created_at desc) as rn,
             count(*) over () as cnt
        from paypal_orders
       where user_id = u and album_id is null and tier in ('medium', 'large')
         and status in ('COMPLETED', 'GRANTED'))
    update paypal_orders o set status = 'REVOKED'
      from rows r
     where o.order_id = r.order_id and r.rn <= r.cnt - c;
  end if;

  return jsonb_build_object('username', lower(btrim(p_username)), 'credits', c,
                            'tier', coalesce(tr, 'small'), 'changed', n,
                            'tiers', event_credits_split(u),
                            'events', (select count(*) from albums where author_id = u and is_event));
end $$;

-- ---------------------------------------------------------------- панель: пользователи

/**
 * Тело из 052 (фильтр «Events») + разбивка по тарифам у каждой строки:
 *   ev_unused  {total, small, medium, large} — непотраченные кредиты;
 *   ev_albums  {small, medium, large}        — созданные событийные альбомы.
 * Фильтр «Events» теперь включает и тех, кто купил, но ещё не создал.
 */
create or replace function public.admin_users(
  p_plan    text default null,     -- 'free' | 'pro' | 'events' | null = все
  p_country text default null,
  p_q       text default null,
  p_limit   int  default 50,
  p_offset  int  default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
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
     where (p_plan is null
            or (p_plan = 'events' and (event_albums > 0 or event_left > 0))
            or (p_plan in ('free', 'pro') and plan = p_plan))
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
      select jsonb_agg(to_jsonb(r) || jsonb_build_object(
               'ev_unused', event_credits_split(r.id),
               'ev_albums', (select jsonb_build_object(
                   'small',  count(*) filter (where coalesce(a.event_tier, 'small') = 'small'),
                   'medium', count(*) filter (where a.event_tier = 'medium'),
                   'large',  count(*) filter (where a.event_tier = 'large'))
                 from albums a where a.author_id = r.id and a.is_event))
             order by r.created_at desc)
        from (select * from filtered order by created_at desc limit lim offset off) r), '[]'::jsonb),
    'countries', coalesce((
      select jsonb_agg(jsonb_build_object('code', code, 'n', n) order by n desc, code)
        from (select coalesce(country, '??') as code, count(*) as n
                from people group by coalesce(country, '??')) c), '[]'::jsonb),
    'plans', jsonb_build_object(
      'free',   (select count(*) from people where plan = 'free'),
      'pro',    (select count(*) from people where plan = 'pro'),
      'events', (select count(*) from people where event_albums > 0 or event_left > 0)),
    'guests', (select count(*) from profiles p
                join auth.users u on u.id = p.id
               where coalesce(u.is_anonymous, false))
  ) into out;
  return out;
end $$;

-- ---------------------------------------------------------------- панель: статистика

/**
 * Тело из 021 + блок events: по тарифам — созданные альбомы, непотраченные
 * кредиты, оплаты (COMPLETED) и ручные выдачи с тарифом (GRANTED).
 * Кредиты и альбомы без тарифа — Small.
 */
create or replace function public.admin_stats(p_days int default 30)
returns jsonb language sql stable security definer set search_path = public as $$
  with win as (select greatest(1, least(coalesce(p_days, 30), 365)) as d),
  days as (
    select generate_series(current_date - ((select d from win) - 1), current_date, interval '1 day')::date as day
  ),
  ev as (select * from stat_events where created_at > now() - (select d from win) * interval '1 day'),
  unused as (select event_credits_split(user_id) as s from event_quota where credits > 0)
  select jsonb_build_object(
    'days', (select d from win),
    'users', jsonb_build_object(
      'total', (select count(*) from profiles where deleted_at is null),
      'new',   (select count(*) from profiles where created_at > now() - (select d from win) * interval '1 day'),
      'pro',   (select count(*) from profiles where plan = 'pro'),
      'banned',(select count(*) from profiles where banned_at is not null)),
    'content', jsonb_build_object(
      'albums',    (select count(*) from albums),
      'published', (select count(*) from albums where published_at is not null),
      'new_albums',(select count(*) from albums where created_at > now() - (select d from win) * interval '1 day'),
      'posts',     (select count(*) from posts),
      'comments',  (select count(*) from comments),
      'likes',     (select count(*) from likes),
      'media',     (select count(*) from media),
      'media_r2',  (select count(*) from media where storage_path like 'r2/%'),
      'bytes',     (select coalesce(sum(size_bytes), 0) from media)),
    'activity', jsonb_build_object(
      'views',       (select count(*) from ev where kind = 'view'),
      'impressions', (select count(*) from ev where kind = 'impression'),
      'clicks',      (select count(*) from ev where kind = 'button'),
      'avg_dwell_ms',(select coalesce(round(avg(dwell_ms)), 0) from ev where kind = 'view' and dwell_ms > 0),
      'reports_open',(select count(*) from reports where status = 'open')),
    'events', jsonb_build_object(
      'albums', (select jsonb_build_object(
          'small',  count(*) filter (where coalesce(event_tier, 'small') = 'small'),
          'medium', count(*) filter (where event_tier = 'medium'),
          'large',  count(*) filter (where event_tier = 'large'))
        from albums where is_event),
      'unused', (select jsonb_build_object(
          'small',  coalesce(sum((s->>'small')::int), 0),
          'medium', coalesce(sum((s->>'medium')::int), 0),
          'large',  coalesce(sum((s->>'large')::int), 0))
        from unused),
      'paid', (select jsonb_build_object(
          'small',  count(*) filter (where coalesce(tier, 'small') = 'small'),
          'medium', count(*) filter (where tier = 'medium'),
          'large',  count(*) filter (where tier = 'large'),
          'usd',    coalesce(sum(amount), 0))
        from paypal_orders where status = 'COMPLETED' and kind like 'event%'),
      'granted', (select jsonb_build_object(
          'medium', count(*) filter (where tier = 'medium'),
          'large',  count(*) filter (where tier = 'large'))
        from paypal_orders where status = 'GRANTED')),
    'by_day', (select coalesce(jsonb_agg(x order by x->>'day'), '[]'::jsonb) from (
        select jsonb_build_object(
          'day', d.day,
          'views',   (select count(*) from ev e where e.day = d.day and e.kind = 'view'),
          'actives', (select count(distinct e.actor_id) from ev e where e.day = d.day and e.actor_id is not null),
          'signups', (select count(*) from profiles p where p.created_at::date = d.day),
          'albums',  (select count(*) from albums a where a.created_at::date = d.day)) as x
        from days d) s),
    'geo', (select coalesce(jsonb_agg(x order by (x->>'n')::int desc), '[]'::jsonb) from (
        select jsonb_build_object('code', coalesce(country, '??'), 'n', count(*)) as x
        from ev where kind = 'view' group by country order by count(*) desc limit 15) s),
    'top_albums', (select coalesce(jsonb_agg(x order by (x->>'views')::int desc), '[]'::jsonb) from (
        select jsonb_build_object('id', a.id, 'title', a.title, 'author', p.username,
          'views', count(*) filter (where e.kind = 'view')) as x
        from ev e join albums a on a.id = e.album_id join profiles p on p.id = a.author_id
        group by a.id, a.title, p.username
        order by count(*) filter (where e.kind = 'view') desc limit 10) s)
  );
$$;

-- ---------------------------------------------------------------- 7. срок хранения

alter table public.albums add column if not exists event_first_upload_at timestamptz;
alter table public.albums add column if not exists event_storage_until   timestamptz;

/**
 * Тело из 053 + две колонки срока. Их, как и тариф, нельзя выставить себе
 * руками: пишет только event_album_create / сервисный ключ либо триггер
 * первой загрузки (локальная настройка app.event_clock).
 */
create or replace function public.trg_album_event_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare r text; allowed boolean; clock boolean;
begin
  begin
    r := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
  exception when others then r := null;
  end;
  allowed := coalesce(r, 'service_role') = 'service_role'
          or coalesce(current_setting('app.event_create', true), '') = '1';
  clock := allowed or coalesce(current_setting('app.event_clock', true), '') = '1';
  if not allowed then
    if tg_op = 'INSERT' then
      new.is_event         := false;
      new.event_tier       := null;
      new.event_guest_cap  := null;
      new.event_storage_gb := null;
    else
      new.is_event         := old.is_event;
      new.event_tier       := old.event_tier;
      new.event_guest_cap  := old.event_guest_cap;
      new.event_storage_gb := old.event_storage_gb;
    end if;
  end if;
  if not clock then
    if tg_op = 'INSERT' then
      new.event_first_upload_at := null;
      new.event_storage_until   := null;
    else
      new.event_first_upload_at := old.event_first_upload_at;
      new.event_storage_until   := old.event_storage_until;
    end if;
  end if;
  return new;
end $$;

/**
 * Первая загрузка в событийный альбом запускает срок хранения: 6 месяцев.
 * Кто загрузил — автор или гость — не важно. Повторные загрузки срок не
 * трогают (where event_first_upload_at is null).
 */
create or replace function public.trg_event_first_upload()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.event_clock', '1', true);
  update albums
     set event_first_upload_at = now(),
         event_storage_until   = now() + interval '6 months'
   where id = new.album_id and is_event and event_first_upload_at is null;
  perform set_config('app.event_clock', '', true);
  return null;
end $$;

drop trigger if exists album_media_event_clock_t on public.album_media;
create trigger album_media_event_clock_t after insert on public.album_media
  for each row execute function public.trg_event_first_upload();

-- уже идущие события: срок — от самого раннего файла альбома
alter table public.albums disable trigger albums_touch_t;
update public.albums a
   set event_first_upload_at = f.first_at,
       event_storage_until   = f.first_at + interval '6 months'
  from (select am.album_id, min(m.created_at) as first_at
          from public.album_media am join public.media m on m.id = am.media_id
         group by am.album_id) f
 where f.album_id = a.id and a.is_event and a.event_first_upload_at is null;
alter table public.albums enable trigger albums_touch_t;

/** Тело из 053 + срок хранения (null — загрузок ещё не было, срок не идёт). */
create or replace function public.my_event_albums()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'title', a.title, 'visibility', a.visibility, 'published_at', a.published_at,
      'moderation_status', a.moderation_status, 'created_at', a.created_at,
      'hold', a.event_hold_guest,
      'tier', coalesce(a.event_tier, 'small'),
      'guest_cap', coalesce(a.event_guest_cap, 100), 'storage_gb', coalesce(a.event_storage_gb, 100),
      'first_upload_at', a.event_first_upload_at, 'storage_until', a.event_storage_until,
      'photos_count', a.photos_count, 'videos_count', a.videos_count,
      'items_total', (select count(*) from album_media am where am.album_id = a.id),
      'items_hidden', (select count(*) from album_media am
                       where am.album_id = a.id and am.visibility = 'private'),
      'guests', (select count(*) from album_collaborators c where c.album_id = a.id),
      'cover_path', (select coalesce(m.thumb_path, m.storage_path) from media m where m.id = a.cover_media_id),
      'thumb1', (select coalesce(m.thumb_path, m.storage_path)
                 from album_media am join media m on m.id = am.media_id
                 where am.album_id = a.id and m.kind <> 'audio'
                 order by am.position limit 1)
    ) order by a.created_at desc)
    from albums a
    where a.author_id = auth.uid() and a.is_event), '[]'::jsonb);
$$;

-- ---------------------------------------------------------------- гранты
-- Supabase раздаёт execute новым функциям через default privileges, поэтому
-- служебным отзываем явно (гоча миграции 020).

revoke execute on function public.event_credits_split(uuid)                   from public, anon, authenticated;
revoke execute on function public.trg_event_first_upload()                     from public, anon, authenticated;
revoke execute on function public.paypal_grant_event_tier(text, uuid, text)   from public, anon, authenticated;
revoke execute on function public.admin_grant_event(text, int, text)          from public, anon, authenticated;
revoke execute on function public.admin_users(text, text, text, int, int)     from public, anon, authenticated;
revoke execute on function public.admin_stats(int)                            from public, anon, authenticated;

revoke execute on function public.my_event_credit_tiers()                     from public, anon;
revoke execute on function public.event_album_create(text, text, text, text)  from public, anon;
grant execute on function
  public.my_event_credit_tiers(),
  public.my_event_albums(),
  public.event_album_create(text, text, text, text)
to authenticated;
