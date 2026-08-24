-- =====================================================================
-- 046: список пользователей для панели модерации.
--
-- Панель умела показывать сводные числа и выдавать тариф по имени, но не
-- умела ответить на вопрос «кто у нас вообще есть». Здесь появляется
-- admin_users(): имя, почта, тариф, дата назначения тарифа, страна и
-- сколько куплено событийных альбомов — с фильтрами по тарифу и стране.
--
-- Двух полей для этого в базе не было, и оба добавляются здесь:
--
--  1. profiles.country. Страну мы уже собираем — но только в stat_events,
--     то есть у события просмотра, а не у человека. Считается она на
--     клиенте по часовому поясу (js/stats.js), с откатом на регион языка:
--     это догадка браузера, а не геолокация по IP, и в этом качестве её и
--     надо читать. Теперь тот же признак закрепляется за профилем, чтобы
--     по нему можно было фильтровать без прохода по 500 тысячам событий.
--     Существующие профили заполняются самой частой страной из их событий.
--
--  2. profiles.plan_since — когда назначен нынешний тариф. plan_until
--     говорит, когда тариф кончится, а начало нигде не хранилось.
--     Ставится триггером на ЛЮБОЙ смене plan, а не внутри admin_set_plan:
--     тариф меняют ещё paypal_apply_sub и expire_plans, и обходить их по
--     одной — верный способ забыть про третью. Существующим Pro дата
--     восстановлена из paypal_subscriptions; ручным выдачам взять её
--     неоткуда, там останется пусто.
--
-- ВНИМАНИЕ ПРО ЯДРО: здесь целиком переписываются stat_track,
-- stat_button_click и trg_profile_guard. С этого момента единственный
-- источник их полного тела — ЭТА миграция, а не 021 (правило из PLAN.md).
-- =====================================================================

-- ---------------------------------------------------------------- колонки

alter table public.profiles add column if not exists country    text;
alter table public.profiles add column if not exists plan_since timestamptz;

do $$ begin
  alter table public.profiles add constraint profiles_country_chk
    check (country is null or country ~ '^[A-Z]{2}$');
exception when duplicate_object then null; end $$;

-- Фильтр по стране и по тарифу ходит по всей таблице целиком.
create index if not exists profiles_country_idx on public.profiles (country);
create index if not exists profiles_plan_idx    on public.profiles (plan);

-- ---------------------------------------------------------------- страж профиля

/**
 * Политика profiles_update разрешает владельцу менять любую колонку своей
 * строки, поэтому денежные и модераторские поля возвращаются к прежним
 * значениям для всех, кроме сервисного ключа (панель) и прямого SQL.
 *
 * Country в этом списке на особом положении: её пишет stat_track из-под
 * обычного пользователя, но не сам пользователь руками. Отличаем по
 * локальной настройке app.profile_meta — поднять её через PostgREST нельзя
 * (set_config живёт в pg_catalog), поэтому подделать признак клиенту нечем.
 * Тот же приём стережёт is_event в миграции 026.
 *
 * plan_since ставится здесь же: любая смена plan — хоть из панели, хоть из
 * вебхука PayPal, хоть плановым спуском expire_plans — метит дату сама.
 */
create or replace function public.trg_profile_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare r text; meta boolean;
begin
  begin
    r := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
  exception when others then r := null;
  end;
  meta := coalesce(current_setting('app.profile_meta', true), '') = '1';

  if coalesce(r, 'service_role') <> 'service_role' then
    new.plan       := old.plan;
    new.plan_until := old.plan_until;
    new.plan_since := old.plan_since;
    new.banned_at  := old.banned_at;
    new.ban_reason := old.ban_reason;
    if not meta then new.country := old.country; end if;
  end if;

  -- Дата назначения тарифа: считается уже ПОСЛЕ отката подделок выше,
  -- иначе пользователь метил бы себе дату несостоявшейся сменой тарифа.
  if new.plan is distinct from old.plan then
    new.plan_since := now();
  end if;

  return new;
end $$;

drop trigger if exists trg_profiles_guard on public.profiles;
create trigger trg_profiles_guard before update on public.profiles
  for each row execute function public.trg_profile_guard();

-- ---------------------------------------------------------------- сбор страны

/**
 * Запомнить страну зрителя в его профиле. Пишем только при изменении:
 * иначе каждое открытие альбома дёргало бы UPDATE по profiles и будило
 * триггеры счётчиков ради записи того же самого значения.
 */
create or replace function public.stamp_country(p_user uuid, p_country text)
returns void language plpgsql security definer set search_path = public as $$
declare cc text := nullif(upper(left(coalesce(p_country, ''), 2)), '');
begin
  if p_user is null or cc is null or cc !~ '^[A-Z]{2}$' then return; end if;
  perform set_config('app.profile_meta', '1', true);   -- разрешение стражу, живёт до конца транзакции
  update profiles set country = cc where id = p_user and country is distinct from cc;
end $$;

/**
 * Показ карточки в ленте (impression) или посещение альбома (view).
 * Возвращает id события — он нужен, чтобы потом дописать удержание.
 * Свои просмотры автору не считаем. Один и тот же зритель по одному альбому
 * не даёт больше одного события каждого вида в полчаса.
 *
 * Против 021 добавлена одна строка — stamp_country. Ранний выход из функции
 * (свой альбом, повтор за полчаса) страну не запишет, и это осознанно:
 * лишний UPDATE ради уже известного значения не нужен, а свежий зритель
 * доедет до вставки события в первый же заход.
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

  perform stamp_country(uid, p_country);

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

/** Переход по кнопке профиля. Плюс та же отметка страны, что и в stat_track. */
create or replace function public.stat_button_click(
  p_button uuid, p_country text default null, p_lang text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into stat_events (kind, owner_id, actor_id, button_id, country, lang)
  select 'button', b.owner_id, auth.uid(), b.id,
         nullif(upper(left(coalesce(p_country, ''), 2)), ''),
         nullif(lower(left(coalesce(p_lang, ''), 5)), '')
  from profile_buttons b where b.id = p_button;

  perform stamp_country(auth.uid(), p_country);
end $$;

-- ---------------------------------------------------------------- заполнение прошлого

-- Страна: самая частая из событий этого человека. При равенстве берём
-- последнюю по времени — свежий сигнал вернее старого.
with pick as (
  select actor_id, country,
         row_number() over (partition by actor_id
                            order by count(*) desc, max(created_at) desc) as rn
  from stat_events
  where actor_id is not null and country is not null
  group by actor_id, country
)
update profiles p set country = pick.country
  from pick
 where pick.actor_id = p.id and pick.rn = 1 and p.country is null;

-- Дата назначения Pro: у купивших через PayPal она есть в подписке.
-- Выданным вручную взять её неоткуда — там останется NULL, и панель честно
-- покажет прочерк вместо выдуманного числа.
with sub as (
  select user_id, min(created_at) as started
  from paypal_subscriptions
  where status = 'ACTIVE'
  group by user_id
)
update profiles p set plan_since = sub.started
  from sub
 where sub.user_id = p.id and p.plan = 'pro' and p.plan_since is null;

-- ---------------------------------------------------------------- список для панели

/**
 * Пользователи для панели модерации: строки + счётчик + список стран для
 * фильтра. Вызывается ТОЛЬКО из mod-api под сервисным ключом — как
 * admin_stats и admin_set_plan.
 *
 * Почта живёт в auth.users и наружу не отдаётся ничем, кроме этой функции;
 * поэтому execute у неё отобран у всех ролей ниже.
 *
 * Анонимные гости (сессия без входа, миграция 037) в список не попадают:
 * это технические профили без почты и тарифа, и они забили бы собой всё.
 * Их количество возвращается отдельным числом, чтобы разница с общим
 * счётчиком пользователей в «Статистике» не выглядела ошибкой.
 */
create or replace function public.admin_users(
  p_plan    text default null,     -- 'free' | 'pro' | null = все
  p_country text default null,     -- 'RU' | … | '??' = страна неизвестна | null = все
  p_q       text default null,     -- поиск по имени, псевдониму или почте
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
     where (p_plan is null or plan = p_plan)
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
    -- Список стран для выпадающего фильтра: по всем непубличным-гостевым
    -- профилям, а не по текущей выборке — иначе выбранная страна выкидывала
    -- бы из списка все остальные и фильтр нельзя было бы переключить.
    'countries', coalesce((
      select jsonb_agg(jsonb_build_object('code', code, 'n', n) order by n desc, code)
        from (select coalesce(country, '??') as code, count(*) as n
                from people group by coalesce(country, '??')) c), '[]'::jsonb),
    'plans', jsonb_build_object(
      'free', (select count(*) from people where plan = 'free'),
      'pro',  (select count(*) from people where plan = 'pro')),
    'guests', (select count(*) from profiles p
                join auth.users u on u.id = p.id
               where coalesce(u.is_anonymous, false))
  ) into out;

  return out;
end $$;

-- ---------------------------------------------------------------- гранты
-- Supabase раздаёт execute новым функциям через свои default privileges,
-- поэтому служебным функциям отзываем явно и поимённо (гоча миграции 020).

revoke execute on function public.admin_users(text,text,text,int,int) from public, anon, authenticated;
revoke execute on function public.stamp_country(uuid,text)            from public, anon, authenticated;
revoke execute on function public.trg_profile_guard()                 from public, anon, authenticated;

grant execute on function
  public.stat_track(text,uuid,text,text,text),
  public.stat_button_click(uuid,text,text)
  to anon, authenticated;
