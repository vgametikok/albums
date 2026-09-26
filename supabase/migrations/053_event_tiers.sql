-- =====================================================================
-- 053: три тарифа событийного альбома (Small / Medium / Large).
--
--   small  — до 100 гостей, 100 GB, $39.99
--   medium — до 250 гостей, 200 GB, $69.99
--   large  — до 500 гостей, 400 GB, $129.99
--
-- Оплата от этой миграции НЕ зависит. Цена и проверка суммы живут в
-- edge-функции paypal-webhook (EVENT_TIERS), кредит выдаёт прежняя
-- paypal_grant_event из 040, а тариф заказа функция пишет в paypal_orders.kind
-- (event_small / event_medium / event_large) — эта колонка есть с 040. Здесь
-- только НЕразрушающие добавления, чтобы тариф жил в явном виде:
--
--  1. paypal_orders: tier, guest_cap, storage_gb, amount, album_id —
--     заполняются из kind (для старых заказов: kind = 'event' -> small).
--  2. albums: event_tier, event_guest_cap, event_storage_gb — тариф самого
--     альбома. Автор может править любые колонки своей строки (политика
--     albums_upd), поэтому эти три стережёт тот же триггер, что и is_event.
--  3. event_album_create: при создании альбома берёт самый крупный ещё не
--     привязанный оплаченный заказ пользователя, привязывает его к альбому
--     (album_id) и переносит тариф в albums. Кредит без заказа (выдан
--     вручную из админки) даёт small.
--  4. my_event_albums: отдаёт тариф в кабинет.
--
-- Лимиты (гости, GB) пока только ЗАПИСЫВАЮТСЯ, а не применяются: принудительного
-- ограничения загрузок по тарифу здесь нет.
-- Повторный запуск безопасен (if not exists / create or replace / where ... is null).
-- =====================================================================

-- ---------------------------------------------------------------- заказы

alter table public.paypal_orders add column if not exists tier       text;
alter table public.paypal_orders add column if not exists guest_cap  int;
alter table public.paypal_orders add column if not exists storage_gb int;
alter table public.paypal_orders add column if not exists amount     numeric(10,2);
alter table public.paypal_orders add column if not exists album_id   uuid
  references public.albums(id) on delete set null;

do $$ begin
  alter table public.paypal_orders add constraint paypal_orders_tier_chk
    check (tier is null or tier in ('small', 'medium', 'large'));
exception when duplicate_object then null;
end $$;

create index if not exists paypal_orders_unlinked
  on public.paypal_orders (user_id, created_at) where album_id is null;

-- тариф из kind: event_medium / event_large; всё прочее событийное — small
update public.paypal_orders
   set tier = case kind when 'event_medium' then 'medium'
                        when 'event_large'  then 'large'
                        else 'small' end
 where tier is null and kind like 'event%';

update public.paypal_orders
   set guest_cap  = case tier when 'medium' then 250   when 'large' then 500    else 100   end,
       storage_gb = case tier when 'medium' then 200   when 'large' then 400    else 100   end,
       amount     = case tier when 'medium' then 69.99 when 'large' then 129.99 else 39.99 end
 where tier is not null and (guest_cap is null or storage_gb is null or amount is null);

-- ---------------------------------------------------------------- альбомы

alter table public.albums add column if not exists event_tier       text;
alter table public.albums add column if not exists event_guest_cap  int;
alter table public.albums add column if not exists event_storage_gb int;

do $$ begin
  alter table public.albums add constraint albums_event_tier_chk
    check (event_tier is null or event_tier in ('small', 'medium', 'large'));
exception when duplicate_object then null;
end $$;

/**
 * Тело из 026 + три колонки тарифа. Выставить их может только
 * event_album_create (локальная настройка app.event_create) или сервисный ключ;
 * всем остальным INSERT обнуляет, UPDATE возвращает прежние значения.
 */
create or replace function public.trg_album_event_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare r text; allowed boolean;
begin
  begin
    r := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
  exception when others then r := null;
  end;
  allowed := coalesce(r, 'service_role') = 'service_role'
          or coalesce(current_setting('app.event_create', true), '') = '1';
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
  return new;
end $$;

-- Уже существующие события: привязываем старые оплаченные заказы к альбомам
-- по хронологии (каждому альбому — самый ранний свободный заказ того же
-- пользователя, сделанный не позже альбома), остальным событиям — small.
-- albums_touch_t на время отключаем: служебная разметка не должна менять
-- updated_at альбомов.
alter table public.albums disable trigger albums_touch_t;
do $$
declare a record; o record;
begin
  for a in select id, author_id, created_at from public.albums
            where is_event and event_tier is null order by created_at loop
    select order_id, tier, guest_cap, storage_gb into o
      from public.paypal_orders
     where user_id = a.author_id and album_id is null and tier is not null
       and created_at <= a.created_at
     order by created_at limit 1;
    if found then
      update public.paypal_orders set album_id = a.id where order_id = o.order_id;
      update public.albums set event_tier = o.tier, event_guest_cap = o.guest_cap,
                               event_storage_gb = o.storage_gb where id = a.id;
    else
      update public.albums set event_tier = 'small', event_guest_cap = 100,
                               event_storage_gb = 100 where id = a.id;
    end if;
  end loop;
end $$;
alter table public.albums enable trigger albums_touch_t;

-- ---------------------------------------------------------------- создание события

/** Тело из 027 + привязка оплаченного заказа и тариф альбома. */
create or replace function public.event_album_create(
  p_title text, p_visibility text default 'private', p_description text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); vis visibility_level; a_id uuid; left_n int;
        o_id text; o_tier text; o_guests int; o_gb int;
begin
  if me is null then raise exception 'auth required'; end if;
  if coalesce(btrim(p_title), '') = '' then raise exception 'Нужно название события'; end if;
  if p_visibility not in ('public', 'friends', 'private') then raise exception 'bad visibility'; end if;
  vis := p_visibility::visibility_level;

  update event_quota set credits = credits - 1, updated_at = now()
   where user_id = me and credits > 0
   returning credits into left_n;
  if not found then raise exception 'Нет доступных общих альбомов'; end if;

  -- самый крупный свободный оплаченный заказ; нет такого — кредит из админки, small
  select order_id, tier, guest_cap, storage_gb into o_id, o_tier, o_guests, o_gb
    from paypal_orders
   where user_id = me and album_id is null and tier is not null
   order by case tier when 'large' then 3 when 'medium' then 2 else 1 end desc, created_at
   limit 1
   for update;
  if o_id is null then o_tier := 'small'; o_guests := 100; o_gb := 100; end if;

  perform set_config('app.event_create', '1', true);
  insert into albums (author_id, title, description, visibility, is_event,
                      event_hold_guest, published_at,
                      event_tier, event_guest_cap, event_storage_gb)
  values (me, btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''), vis, true, true,
          case when vis = 'private' then null else now() end,
          o_tier, o_guests, o_gb)
  returning id into a_id;
  perform set_config('app.event_create', '', true);

  if o_id is not null then
    update paypal_orders set album_id = a_id where order_id = o_id;
  end if;

  return jsonb_build_object('album_id', a_id, 'credits_left', left_n,
                            'tier', o_tier, 'guest_cap', o_guests, 'storage_gb', o_gb);
end $$;

-- ---------------------------------------------------------------- кабинет

/** Тело из 026 + тариф. */
create or replace function public.my_event_albums()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'title', a.title, 'visibility', a.visibility, 'published_at', a.published_at,
      'moderation_status', a.moderation_status, 'created_at', a.created_at,
      'hold', a.event_hold_guest,
      'tier', a.event_tier, 'guest_cap', a.event_guest_cap, 'storage_gb', a.event_storage_gb,
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

grant execute on function
  public.event_album_create(text, text, text),
  public.my_event_albums()
to authenticated;
