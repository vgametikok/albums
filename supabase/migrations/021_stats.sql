-- =====================================================================
-- 021: статистика.
--
-- Событийный лог stat_events — один ряд на показ карточки в ленте, на
-- посещение альбома и на переход по кнопке профиля. Удержание пишется
-- в тот же ряд посещения чекпойнтами (вставка при открытии, обновление
-- по таймеру и при уходе), потому что событие «вкладку закрыли» браузеры
-- отдают ненадёжно.
--
-- Ядро видимости (015) не трогаем: ни одна функция оттуда не переопределяется,
-- добавляются только новые объекты. Служебные функции несут собственный
-- revoke — на alter default privileges полагаться нельзя (гоча миграции 020).
--
-- Демография: Google при обычном входе не отдаёт ни возраст, ни пол (для
-- этого нужны отдельные чувствительные разрешения и проверка приложения),
-- поэтому год рождения и пол — необязательные поля профиля, которые
-- пользователь заполняет сам. Гео берём из часового пояса браузера, IP
-- не храним вообще.
-- =====================================================================

-- ---------------------------------------------------------------- профиль

alter table public.profiles add column if not exists birth_year  smallint;
alter table public.profiles add column if not exists gender      text;
alter table public.profiles add column if not exists plan        text not null default 'free';
alter table public.profiles add column if not exists plan_until  timestamptz;

do $$ begin
  alter table public.profiles add constraint profiles_gender_chk
    check (gender is null or gender in ('female','male','other'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.profiles add constraint profiles_birth_year_chk
    check (birth_year is null or birth_year between 1900 and 2018);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.profiles add constraint profiles_plan_chk
    check (plan in ('free','pro'));
exception when duplicate_object then null; end $$;

-- Политика profiles_update разрешает владельцу менять ЛЮБУЮ колонку своей
-- строки. Для plan это означало бы «выдай себе Pro одним запросом», для
-- banned_at — «сними себе бан». Триггер молча возвращает эти поля к прежним
-- значениям для всех, кроме сервисного ключа (панель модерации) и прямого
-- SQL. Счётчики подписчиков НЕ трогаем: их правит триггер подписок, который
-- выполняется в контексте обычного пользователя.
create or replace function public.trg_profile_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare r text;
begin
  begin
    r := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
  exception when others then r := null;
  end;
  if coalesce(r, 'service_role') <> 'service_role' then
    new.plan       := old.plan;
    new.plan_until := old.plan_until;
    new.banned_at  := old.banned_at;
    new.ban_reason := old.ban_reason;
  end if;
  return new;
end $$;

drop trigger if exists trg_profiles_guard on public.profiles;
create trigger trg_profiles_guard before update on public.profiles
  for each row execute function public.trg_profile_guard();

-- ---------------------------------------------------------------- кнопки Pro

create table if not exists public.profile_buttons (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references public.profiles(id) on delete cascade,
  label      text not null,
  url        text not null,
  position   int  not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists profile_buttons_owner_idx on public.profile_buttons(owner_id, position);
alter table public.profile_buttons enable row level security;
-- Читают через RPC (там же проверка тарифа), пишут через RPC. Прямого доступа нет.

-- ---------------------------------------------------------------- события

create table if not exists public.stat_events (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('impression','view','button')),
  album_id   uuid references public.albums(id)   on delete cascade,
  owner_id   uuid not null references public.profiles(id) on delete cascade,
  actor_id   uuid references public.profiles(id) on delete set null,
  button_id  uuid references public.profile_buttons(id) on delete cascade,
  dwell_ms   int  not null default 0,
  country    text,
  lang       text,
  source     text,
  created_at timestamptz not null default now(),
  day        date not null default current_date
);
create index if not exists stat_events_owner_idx  on public.stat_events(owner_id, day);
create index if not exists stat_events_album_idx  on public.stat_events(album_id, day);
create index if not exists stat_events_kind_idx   on public.stat_events(kind, created_at desc);
create index if not exists stat_events_button_idx on public.stat_events(button_id) where button_id is not null;
alter table public.stat_events enable row level security;
-- Политик нет намеренно: пишем и читаем только через SECURITY DEFINER функции.

-- ---------------------------------------------------------------- запись событий

/**
 * Показ карточки в ленте (impression) или посещение альбома (view).
 * Возвращает id события — он нужен, чтобы потом дописать удержание.
 * Свои просмотры автору не считаем. Один и тот же зритель по одному альбому
 * не даёт больше одного события каждого вида в полчаса.
 */
create or replace function public.stat_track(
  p_kind text, p_album uuid, p_source text default null,
  p_country text default null, p_lang text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); own uuid; ev uuid; fresh boolean := true;
begin
  if p_kind not in ('impression','view') or p_album is null then return null; end if;
  select author_id into own from albums where id = p_album;
  if own is null then return null; end if;
  if uid is not null and uid = own then return null; end if;
  if not can_view_album(p_album, uid) then return null; end if;

  if uid is not null and exists (
    select 1 from stat_events e
    where e.album_id = p_album and e.actor_id = uid and e.kind = p_kind
      and e.created_at > now() - interval '30 minutes')
  then
    return null;
  end if;

  insert into stat_events (kind, album_id, owner_id, actor_id, country, lang, source)
  values (p_kind, p_album, own, uid,
          nullif(upper(left(coalesce(p_country, ''), 2)), ''),
          nullif(lower(left(coalesce(p_lang, ''), 5)), ''),
          nullif(left(coalesce(p_source, ''), 16), ''))
  returning id into ev;

  -- Посещение поднимает и старый счётчик просмотров альбома: у залогиненных
  -- он остаётся уникальным по дням (как раньше), у гостей растёт на каждое
  -- открытие. Отдельный вызов log_album_view со страницы больше не нужен.
  if p_kind = 'view' then
    if uid is not null then
      insert into album_views (album_id, viewer_id) values (p_album, uid) on conflict do nothing;
      get diagnostics fresh = row_count;
    end if;
    if fresh then update albums set views_count = views_count + 1 where id = p_album; end if;
  end if;

  return ev;
end $$;

/**
 * Удержание: сколько миллисекунд страница альбома была открыта и видима.
 * Пишем максимум из присланного — чекпойнты идут по возрастанию, но приходить
 * могут не по порядку. Потолок два часа отсекает забытые вкладки.
 */
create or replace function public.stat_dwell(p_event uuid, p_ms int)
returns void language sql security definer set search_path = public as $$
  update stat_events
     set dwell_ms = greatest(dwell_ms, least(greatest(coalesce(p_ms, 0), 0), 7200000))
   where id = p_event and kind = 'view' and created_at > now() - interval '6 hours';
$$;

/** Переход по кнопке профиля. */
create or replace function public.stat_button_click(
  p_button uuid, p_country text default null, p_lang text default null)
returns void language sql security definer set search_path = public as $$
  insert into stat_events (kind, owner_id, actor_id, button_id, country, lang)
  select 'button', b.owner_id, auth.uid(), b.id,
         nullif(upper(left(coalesce(p_country, ''), 2)), ''),
         nullif(lower(left(coalesce(p_lang, ''), 5)), '')
  from profile_buttons b where b.id = p_button;
$$;

-- ---------------------------------------------------------------- кнопки: чтение и запись

/** Кнопки профиля. Пустой список, если у владельца не Pro. */
create or replace function public.profile_buttons_get(p_username text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'label', b.label, 'url', b.url)
                            order by b.position, b.created_at), '[]'::jsonb)
  from profile_buttons b
  join profiles p on p.id = b.owner_id
  where p.username = p_username and p.plan = 'pro'
    and p.banned_at is null and p.deleted_at is null;
$$;

/**
 * Замена набора кнопок целиком. Только для Pro, не больше шести штук,
 * адрес обязан быть http(s) — иначе можно было бы протащить javascript:.
 */
create or replace function public.profile_buttons_set(p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); it jsonb; i int := 0; u text; l text;
begin
  if uid is null then raise exception 'auth required'; end if;
  if (select plan from profiles where id = uid) <> 'pro' then
    raise exception 'pro required';
  end if;
  delete from profile_buttons where owner_id = uid;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    exit when i >= 6;
    l := btrim(coalesce(it->>'label', ''));
    u := btrim(coalesce(it->>'url', ''));
    if l <> '' and (u like 'https://%' or u like 'http://%') then
      insert into profile_buttons (owner_id, label, url, position)
      values (uid, left(l, 40), left(u, 500), i);
      i := i + 1;
    end if;
  end loop;
  return profile_buttons_get((select username from profiles where id = uid));
end $$;

-- ---------------------------------------------------------------- свои настройки

-- Год рождения и пол участвуют только в агрегатах. Прямое чтение колонок
-- закрываем: политика profiles_read разрешает читать чужие строки целиком,
-- то есть иначе демографию любого человека можно было бы выкачать запросом.
revoke select (birth_year, gender) on public.profiles from anon, authenticated;

/** Свои настройки: тариф и необязательная демография. */
create or replace function public.my_settings()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'plan', p.plan, 'plan_until', p.plan_until,
    'birth_year', p.birth_year, 'gender', p.gender)
  from profiles p where p.id = auth.uid();
$$;

/** Сохранение демографии. Пустые значения допустимы — поля необязательные. */
create or replace function public.profile_set_demographics(p_birth_year int, p_gender text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'auth required'; end if;
  update profiles
     set birth_year = case when p_birth_year between 1900 and 2018 then p_birth_year::smallint else null end,
         gender     = case when p_gender in ('female','male','other') then p_gender else null end
   where id = uid;
  return my_settings();
end $$;

-- ---------------------------------------------------------------- статистика автора

/**
 * Сводка для личного кабинета. p_album = null — по всем своим альбомам,
 * иначе по одному (и только если он мой). Всё за последние p_days суток.
 */
create or replace function public.stats_summary(p_album uuid default null, p_days int default 30)
returns jsonb language sql stable security definer set search_path = public as $$
  with me as (select auth.uid() as uid),
  win as (select greatest(1, least(coalesce(p_days, 30), 365)) as d),
  mine as (
    select a.id, a.title, a.likes_count, a.comments_count, a.published_at, a.visibility::text as visibility
    from albums a, me
    where a.author_id = me.uid and (p_album is null or a.id = p_album)
  ),
  ev as (
    select e.* from stat_events e
    join mine m on m.id = e.album_id
    where e.created_at > now() - (select d from win) * interval '1 day'
  ),
  days as (
    select generate_series(current_date - ((select d from win) - 1), current_date, interval '1 day')::date as day
  )
  select jsonb_build_object(
    'plan', (select plan from profiles p, me where p.id = me.uid),
    'days', (select d from win),
    'totals', jsonb_build_object(
      'impressions', (select count(*) from ev where kind = 'impression'),
      'views',       (select count(*) from ev where kind = 'view'),
      'viewers',     (select count(distinct coalesce(actor_id::text, id::text)) from ev where kind = 'view'),
      'known_viewers', (select count(distinct actor_id) from ev where kind = 'view' and actor_id is not null),
      'avg_dwell_ms', (select coalesce(round(avg(dwell_ms)), 0) from ev where kind = 'view' and dwell_ms > 0),
      'likes',       (select coalesce(sum(likes_count), 0) from mine),
      'comments',    (select coalesce(sum(comments_count), 0) from mine),
      'albums',      (select count(*) from mine)),
    'by_day', (select coalesce(jsonb_agg(x order by x->>'day'), '[]'::jsonb) from (
        select jsonb_build_object(
          'day', d.day,
          'views', count(*) filter (where e.kind = 'view'),
          'impressions', count(*) filter (where e.kind = 'impression')) as x
        from days d left join ev e on e.day = d.day
        group by d.day) s),
    'geo', (select coalesce(jsonb_agg(x order by (x->>'n')::int desc), '[]'::jsonb) from (
        select jsonb_build_object('code', coalesce(country, '??'), 'n', count(*)) as x
        from ev where kind = 'view' group by country order by count(*) desc limit 12) s),
    'age', (select coalesce(jsonb_agg(x order by x->>'bucket'), '[]'::jsonb) from (
        select jsonb_build_object('bucket', b, 'n', count(*)) as x from (
          select case
            when p.birth_year is null then 'unknown'
            when date_part('year', now()) - p.birth_year < 18 then '13-17'
            when date_part('year', now()) - p.birth_year < 25 then '18-24'
            when date_part('year', now()) - p.birth_year < 35 then '25-34'
            when date_part('year', now()) - p.birth_year < 45 then '35-44'
            when date_part('year', now()) - p.birth_year < 55 then '45-54'
            else '55+' end as b
          from ev e left join profiles p on p.id = e.actor_id
          where e.kind = 'view') q
        group by b) s),
    'gender', (select coalesce(jsonb_agg(x order by x->>'bucket'), '[]'::jsonb) from (
        select jsonb_build_object('bucket', coalesce(p.gender, 'unknown'), 'n', count(*)) as x
        from ev e left join profiles p on p.id = e.actor_id
        where e.kind = 'view' group by coalesce(p.gender, 'unknown')) s),
    'sources', (select coalesce(jsonb_agg(x order by (x->>'n')::int desc), '[]'::jsonb) from (
        select jsonb_build_object('source', coalesce(source, 'direct'), 'n', count(*)) as x
        from ev where kind = 'view' group by source) s),
    'dwell', (select coalesce(jsonb_agg(x order by x->>'ord'), '[]'::jsonb) from (
        select jsonb_build_object('ord', o, 'bucket', b, 'n', count(*)) as x from (
          select case
            when dwell_ms < 10000  then 1 when dwell_ms < 30000  then 2
            when dwell_ms < 60000  then 3 when dwell_ms < 180000 then 4 else 5 end as o,
            case
            when dwell_ms < 10000  then '0-10s' when dwell_ms < 30000  then '10-30s'
            when dwell_ms < 60000  then '30-60s' when dwell_ms < 180000 then '1-3m' else '3m+' end as b
          from ev where kind = 'view') q
        group by o, b) s),
    'albums', (select coalesce(jsonb_agg(x order by (x->>'views')::int desc), '[]'::jsonb) from (
        select jsonb_build_object(
          'id', m.id, 'title', m.title, 'visibility', m.visibility,
          'published', m.published_at is not null,
          'likes', m.likes_count, 'comments', m.comments_count,
          'impressions', count(*) filter (where e.kind = 'impression'),
          'views', count(*) filter (where e.kind = 'view'),
          'avg_dwell_ms', coalesce(round(avg(e.dwell_ms) filter (where e.kind = 'view' and e.dwell_ms > 0)), 0)) as x
        from mine m left join ev e on e.album_id = m.id
        group by m.id, m.title, m.visibility, m.published_at, m.likes_count, m.comments_count) s),
    'buttons', (select coalesce(jsonb_agg(x order by (x->>'clicks')::int desc), '[]'::jsonb) from (
        select jsonb_build_object('id', b.id, 'label', b.label, 'url', b.url,
          'clicks', (select count(*) from stat_events se
                     where se.button_id = b.id
                       and se.created_at > now() - (select d from win) * interval '1 day')) as x
        from profile_buttons b, me where b.owner_id = me.uid) s)
  );
$$;

-- ---------------------------------------------------------------- статистика админа

/**
 * Продуктовые метрики для панели модерации. Вызывается только сервисным
 * ключом из edge-функции: обычным ролям execute отозван явно (см. ниже).
 */
create or replace function public.admin_stats(p_days int default 30)
returns jsonb language sql stable security definer set search_path = public as $$
  with win as (select greatest(1, least(coalesce(p_days, 30), 365)) as d),
  days as (
    select generate_series(current_date - ((select d from win) - 1), current_date, interval '1 day')::date as day
  ),
  ev as (select * from stat_events where created_at > now() - (select d from win) * interval '1 day')
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

/** Выдать или снять Pro. Только из панели модерации (сервисный ключ). */
create or replace function public.admin_set_plan(p_username text, p_plan text, p_days int default 30)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  if p_plan not in ('free','pro') then raise exception 'bad plan'; end if;
  select id into u from profiles where username = p_username;
  if u is null then return jsonb_build_object('error', 'no_user'); end if;
  update profiles
     set plan = p_plan,
         plan_until = case when p_plan = 'pro'
                           then now() + greatest(1, coalesce(p_days, 30)) * interval '1 day'
                           else null end
   where id = u;
  return jsonb_build_object('username', p_username, 'plan', p_plan,
                            'until', (select plan_until from profiles where id = u));
end $$;

-- ---------------------------------------------------------------- гранты
-- Supabase раздаёт execute новым функциям через свои default privileges,
-- поэтому служебным функциям отзываем явно и поимённо (гоча миграции 020).

revoke execute on function public.admin_stats(int)                      from public, anon, authenticated;
revoke execute on function public.admin_set_plan(text,text,int)         from public, anon, authenticated;
revoke execute on function public.trg_profile_guard()                   from public, anon, authenticated;

grant execute on function
  public.stat_track(text,uuid,text,text,text),
  public.stat_dwell(uuid,int),
  public.stat_button_click(uuid,text,text),
  public.profile_buttons_get(text)
to anon, authenticated;

-- Сначала снять то, что Supabase выдал сам (иначе анониму остаётся execute),
-- и только потом выдать нужной роли.
revoke execute on function public.stats_summary(uuid,int)      from public, anon, authenticated;
revoke execute on function public.profile_buttons_set(jsonb)   from public, anon, authenticated;
revoke execute on function public.my_settings()                from public, anon, authenticated;
revoke execute on function public.profile_set_demographics(int,text) from public, anon, authenticated;

grant execute on function
  public.stats_summary(uuid,int),
  public.profile_buttons_set(jsonb),
  public.my_settings(),
  public.profile_set_demographics(int,text)
to authenticated;
