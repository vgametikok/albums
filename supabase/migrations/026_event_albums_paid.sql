-- =====================================================================
-- 026: общий альбом события (Event Album) как платная возможность.
--
-- Что меняется по сути:
--
--  1. Ссылка для гостей перестаёт быть бесплатной и общедоступной. Раньше её
--     мог выпустить владелец ЛЮБОГО альбома прямо из редактора — то есть
--     ключевая часть платного тарифа раздавалась даром. Теперь ссылку выдаёт
--     только альбом с флагом is_event, а такой альбом создаётся лишь при
--     наличии квоты (event_quota.credits), которую выдаёт админ после оплаты —
--     ровно так же, как сейчас выдаётся Pro.
--
--  2. У события ПОСТОЯННАЯ ссылка и, значит, постоянный QR: токен хранится
--     открытым текстом. Это осознанный размен. Обычное приглашение живёт
--     только хэшем и показывается один раз, но QR события печатают на
--     табличке у входа в зал — владелец обязан открыть один и тот же код
--     и завтра, и через месяц. Сама ссылка и есть ключ (capability URL),
--     как в приглашениях Google Photos; на этот случай есть event_link_reset.
--
--  3. У каждого файла внутри альбома появляется своя видимость:
--     null = «как альбом», public, friends, private. Автор события разбирает
--     гостевые фото и решает, что показать всем, что только друзьям, а что
--     спрятать. Ленты и счётчики читают прежнее поле is_private, поэтому его
--     держит в согласованном состоянии триггер: is_private = «не показывать
--     посторонним» = visibility in ('friends','private').
--
-- ВНИМАНИЕ ПРО ЯДРО: здесь целиком переписывается can_view_media. С этого
-- момента ЕДИНСТВЕННЫЙ источник её полного тела — ЭТА миграция, а не 015
-- (правило из шапки PLAN.md: ядро правится в одном месте и целиком).
-- =====================================================================

-- ---------------------------------------------------------------- квота

-- Отдельной таблицей, а НЕ колонкой в profiles: политика profiles_update
-- разрешает владельцу менять любую колонку своей строки, и колонку квоты
-- пришлось бы стеречь триггером, как plan. Отдельная таблица без политик
-- записи закрывает вопрос сразу: писать может только definer-RPC и сервисный
-- ключ (владелец таблицы обходит RLS).
create table if not exists public.event_quota (
  user_id       uuid primary key references public.profiles(id) on delete cascade,
  credits       int not null default 0 check (credits >= 0),   -- сколько ещё можно создать
  granted_total int not null default 0,                        -- сколько выдано за всё время
  updated_at    timestamptz not null default now()
);
alter table public.event_quota enable row level security;
drop policy if exists event_quota_read on public.event_quota;
create policy event_quota_read on public.event_quota for select using (user_id = auth.uid());
-- политик записи нет намеренно

grant select on public.event_quota to authenticated;

-- ---------------------------------------------------------------- альбом

alter table public.albums add column if not exists is_event boolean not null default false;
-- «Придержать гостевые фото»: новые файлы гостей ложатся скрытыми, пока автор
-- их не откроет. Для свадьбы на 500 кадров это выключено по умолчанию —
-- иначе альбом стоит пустым, пока автор не разберёт всё вручную.
alter table public.albums add column if not exists event_hold_guest boolean not null default false;

create index if not exists albums_event_idx on public.albums (author_id, created_at desc)
  where is_event;

-- is_event нельзя выставить себе самому: политика albums_upd разрешает автору
-- менять любую колонку своей строки, а INSERT вообще ничем не прикрыт. Флаг
-- ставит только event_album_create (она поднимает локальную настройку) либо
-- сервисный ключ. set_config живёт в pg_catalog и через PostgREST недоступен,
-- поэтому подделать признак клиенту нечем.
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
    if tg_op = 'INSERT' then new.is_event := false;
    else new.is_event := old.is_event;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists albums_event_guard_t on public.albums;
create trigger albums_event_guard_t before insert or update on public.albums
  for each row execute function public.trg_album_event_guard();

-- ---------------------------------------------------------------- постоянная ссылка

-- is_permanent + открытый токен: обоснование в шапке. Частичный уникальный
-- индекс гарантирует, что действующая постоянная ссылка у события ровно одна —
-- иначе напечатанный QR и показанный на экране могли бы разойтись.
alter table public.album_invites add column if not exists is_permanent boolean not null default false;
alter table public.album_invites add column if not exists token text;
create unique index if not exists album_invites_permanent_idx
  on public.album_invites (album_id) where is_permanent and revoked_at is null;

-- ---------------------------------------------------------------- видимость файла

alter table public.album_media add column if not exists visibility visibility_level;

/**
 * Держит is_private и visibility в согласии.
 *
 * visibility — новое, «умное» поле; is_private — старое булево, на которое
 * опираются ленты, превью карточек и счётчики альбома. Правило простое:
 * is_private означает «не показывать посторонним», то есть friends тоже
 * прячется из лент и счётчиков, но остаётся видимым друзьям автора через
 * can_view_media.
 *
 * Кто из двух полей задан в запросе — тот и главный: старый редактор шлёт
 * is_private, новая страница события — visibility.
 */
create or replace function public.trg_album_media_visibility()
returns trigger language plpgsql security definer set search_path = public as $$
declare a_event boolean; a_hold boolean; a_author uuid;
begin
  if tg_op = 'INSERT' then
    -- гостевые файлы события можно придержать до одобрения автором
    if new.visibility is null and not new.is_private then
      select a.is_event, a.event_hold_guest, a.author_id
        into a_event, a_hold, a_author
        from albums a where a.id = new.album_id;
      if coalesce(a_event, false) and coalesce(a_hold, false)
         and a_author is distinct from auth.uid() then
        new.visibility := 'private';
      end if;
    end if;
    if new.visibility is not null then
      new.is_private := new.visibility in ('friends', 'private');
    elsif new.is_private then
      new.visibility := 'private';
    end if;
  else
    if new.visibility is distinct from old.visibility then
      new.is_private := coalesce(new.visibility in ('friends', 'private'), false);
    elsif new.is_private is distinct from old.is_private then
      new.visibility := case when new.is_private then 'private'::visibility_level else null end;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists album_media_visibility_t on public.album_media;
create trigger album_media_visibility_t before insert or update on public.album_media
  for each row execute function public.trg_album_media_visibility();

-- то, что уже помечено приватным, получает явную видимость
update public.album_media set visibility = 'private' where is_private and visibility is null;

-- ---------------------------------------------------------------- ядро: can_view_media

/**
 * Полное тело (см. предупреждение в шапке). Отличие от версии 015 — одна новая
 * ветка: файл с visibility='friends' виден друзьям автора альбома. Всё
 * остальное сохранено дословно.
 */
create or replace function public.can_view_media(m_id uuid, viewer uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select
    -- владелец файла (гость события всегда видит то, что залил сам)
    exists (select 1 from media where id = m_id and owner_id = viewer)
    -- открытый файл в видимом альбоме
    or exists (select 1 from album_media am
               where am.media_id = m_id and not am.is_private
                 and can_view_album(am.album_id, viewer))
    -- файл «только для друзей автора» внутри видимого альбома
    or exists (select 1 from album_media am join albums a on a.id = am.album_id
               where am.media_id = m_id and am.visibility = 'friends'
                 and can_view_album(am.album_id, viewer)
                 and (a.author_id = viewer or are_friends(a.author_id, viewer)))
    -- скрытый файл: только владелец альбома и РЕДАКТОР. Гость события — нет.
    or exists (select 1 from album_media am
               where am.media_id = m_id and am.visibility = 'private'
                 and (exists (select 1 from albums a where a.id = am.album_id and a.author_id = viewer)
                      or exists (select 1 from album_collaborators c
                                 where c.album_id = am.album_id and c.user_id = viewer and c.role = 'editor')))
    -- обложка видимого альбома, если она не спрятана
    or exists (select 1 from albums al
               where al.cover_media_id = m_id and can_view_album(al.id, viewer)
                 and not exists (select 1 from album_media am2
                                 where am2.album_id = al.id and am2.media_id = m_id and am2.is_private))
    -- слайд видимого поста
    or exists (select 1 from post_media pm
               where pm.media_id = m_id and can_view_post(pm.post_id, viewer))
    -- аудио-рассказ виден тем же, кому виден альбом
    or exists (select 1 from album_narrations n
               where n.media_id = m_id and can_view_album(n.album_id, viewer));
$$;

-- ---------------------------------------------------------------- выдача альбома

/**
 * Полное тело get_album. Отличия от версии 015:
 *   — в карточке альбома отдаются is_event / event_hold_guest;
 *   — у каждого файла отдаётся visibility;
 *   — фильтр файлов знает про «только друзьям».
 */
create or replace function public.get_album(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not can_view_album(p_id, auth.uid()) then null else (
    select jsonb_build_object(
      'album', jsonb_build_object(
        'id', a.id, 'title', a.title, 'description', a.description, 'category', a.category,
        'visibility', a.visibility, 'published_at', a.published_at, 'created_at', a.created_at,
        'date_from', a.date_from, 'date_to', a.date_to, 'date_precision', a.date_precision,
        'is_event', a.is_event, 'event_hold_guest', a.event_hold_guest,
        'photos_count', a.photos_count, 'videos_count', a.videos_count, 'audio_count', a.audio_count,
        'likes_count', a.likes_count, 'comments_count', a.comments_count, 'views_count', a.views_count,
        'cover_path', (select m.storage_path from media m where m.id = a.cover_media_id)),
      'author', jsonb_build_object('username', p.username, 'name', p.display_name, 'avatar', p.avatar_url),
      'is_author', a.author_id = auth.uid(),
      'can_edit', can_edit_album(a.id),
      'can_contribute', can_contribute_album(a.id),
      'has_narration', exists (select 1 from album_narrations n where n.album_id = a.id),
      'collaborators', coalesce((
        select jsonb_agg(jsonb_build_object('username', cp.username, 'name', cp.display_name,
                                            'avatar', cp.avatar_url, 'role', c.role))
        from album_collaborators c join profiles cp on cp.id = c.user_id
        where c.album_id = a.id), '[]'::jsonb),
      'liked', exists (select 1 from likes l where l.subject_type='album' and l.subject_id=a.id and l.user_id=auth.uid()),
      'saved', exists (select 1 from saves s where s.album_id=a.id and s.user_id=auth.uid()),
      'chapters', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', c.id, 'label', c.label, 'title', c.title, 'body', c.body, 'position', c.position,
          'media', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', m.id, 'am_id', am.id, 'kind', m.kind, 'path', m.storage_path, 'thumb', m.thumb_path,
              'width', m.width, 'height', m.height, 'duration', m.duration_seconds,
              'captured_at', m.captured_at, 'caption', am.caption, 'position', am.position,
              'is_private', am.is_private, 'visibility', am.visibility,
              'mine', m.owner_id = auth.uid()) order by am.position)
            from album_media am join media m on m.id = am.media_id
            where am.chapter_id = c.id
              and (not am.is_private
                   or can_edit_album(a.id)
                   or (am.visibility = 'friends' and are_friends(a.author_id, auth.uid())))), '[]'::jsonb)
        ) order by c.position)
        from album_chapters c where c.album_id = a.id), '[]'::jsonb),
      'loose', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', m.id, 'am_id', am.id, 'kind', m.kind, 'path', m.storage_path, 'thumb', m.thumb_path,
          'width', m.width, 'height', m.height, 'duration', m.duration_seconds,
          'captured_at', m.captured_at, 'caption', am.caption, 'position', am.position,
          'is_private', am.is_private, 'visibility', am.visibility,
          'mine', m.owner_id = auth.uid()) order by am.position)
        from album_media am join media m on m.id = am.media_id
        where am.album_id = a.id and am.chapter_id is null
          and (not am.is_private
               or can_edit_album(a.id)
               or (am.visibility = 'friends' and are_friends(a.author_id, auth.uid())))), '[]'::jsonb)
    )
    from albums a join profiles p on p.id = a.author_id where a.id = p_id
  ) end;
$$;

-- ---------------------------------------------------------------- RPC события

/** Сколько общих альбомов я ещё могу создать. */
create or replace function public.my_event_credits()
returns int language sql stable security definer set search_path = public as $$
  select coalesce((select credits from event_quota where user_id = auth.uid()), 0);
$$;

/**
 * Создать общий альбом, списав одну единицу квоты.
 * Приватный остаётся черновиком: публиковать в ленту нечего, а очередь
 * модерации не надо засорять. Публичный/дружеский уходит на проверку сразу.
 */
create or replace function public.event_album_create(
  p_title text, p_visibility text default 'private', p_description text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); vis visibility_level; a_id uuid; left_n int;
begin
  if me is null then raise exception 'auth required'; end if;
  if coalesce(btrim(p_title), '') = '' then raise exception 'Нужно название события'; end if;
  if p_visibility not in ('public', 'friends', 'private') then raise exception 'bad visibility'; end if;
  vis := p_visibility::visibility_level;

  update event_quota set credits = credits - 1, updated_at = now()
   where user_id = me and credits > 0
   returning credits into left_n;
  if not found then raise exception 'Нет доступных общих альбомов'; end if;

  -- Настройка транзакционная, а не пооператорная: если её не погасить сразу,
  -- она останется поднятой до конца транзакции и в этом же запросе можно будет
  -- проставить is_event любому своему альбому. PostgREST даёт по транзакции на
  -- запрос, но полагаться на это нельзя — гасим руками.
  perform set_config('app.event_create', '1', true);
  insert into albums (author_id, title, description, visibility, is_event, published_at)
  values (me, btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''), vis, true,
          case when vis = 'private' then null else now() end)
  returning id into a_id;
  perform set_config('app.event_create', '', true);

  return jsonb_build_object('album_id', a_id, 'credits_left', left_n);
end $$;

/**
 * Постоянная ссылка события: выдаётся один раз и дальше не меняется, чтобы
 * напечатанный QR не протух. Токен лежит открытым — обоснование в шапке.
 */
create or replace function public.event_link(p_album uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); a albums; inv album_invites; tok text;
begin
  if me is null then raise exception 'auth required'; end if;
  select * into a from albums where id = p_album;
  if a.id is null then raise exception 'Альбом не найден'; end if;
  if a.author_id <> me then raise exception 'Ссылку выдаёт только владелец'; end if;
  if not a.is_event then raise exception 'Это не общий альбом'; end if;

  select * into inv from album_invites
   where album_id = p_album and is_permanent and revoked_at is null
   order by created_at desc limit 1;

  if not found then
    -- не gen_random_bytes: он в схеме extensions, а search_path тут прибит к
    -- public намеренно (см. миграцию 016). Два uuid дают ~244 бита.
    tok := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    insert into album_invites (album_id, token_hash, token, created_by, role,
                               is_permanent, expires_at, max_uses)
    values (p_album, encode(sha256(tok::bytea), 'hex'), tok, me, 'contributor', true, null, null)
    returning * into inv;
  end if;

  return jsonb_build_object('token', inv.token, 'uses', inv.uses, 'created_at', inv.created_at);
end $$;

/** Сменить ссылку: старый QR перестаёт работать, уже вошедшие гости остаются. */
create or replace function public.event_link_reset(p_album uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); owner uuid;
begin
  if me is null then raise exception 'auth required'; end if;
  select author_id into owner from albums where id = p_album and is_event;
  if owner is null then raise exception 'Альбом не найден'; end if;
  if owner <> me then raise exception 'Недостаточно прав'; end if;

  update album_invites set revoked_at = now()
   where album_id = p_album and is_permanent and revoked_at is null;
  return event_link(p_album);
end $$;

/** Видимость пачки файлов внутри альбома. Разбирает гостевые фото ТОЛЬКО автор. */
create or replace function public.album_media_set_visibility(p_ids uuid[], p_visibility text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); vis visibility_level; n int;
begin
  if me is null then raise exception 'auth required'; end if;
  if p_visibility is not null and p_visibility not in ('public', 'friends', 'private') then
    raise exception 'bad visibility';
  end if;
  vis := case when p_visibility is null then null else p_visibility::visibility_level end;

  update album_media am set visibility = vis
    from albums a
   where am.id = any(p_ids) and a.id = am.album_id and a.author_id = me;
  get diagnostics n = row_count;
  return jsonb_build_object('updated', n);
end $$;

/** Мои общие альбомы — для кабинета. */
create or replace function public.my_event_albums()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'title', a.title, 'visibility', a.visibility, 'published_at', a.published_at,
      'moderation_status', a.moderation_status, 'created_at', a.created_at,
      'hold', a.event_hold_guest,
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

-- ---------------------------------------------------------------- закрываем бесплатный путь

/**
 * Обычные приглашения остаются только у событийных альбомов. Раньше ссылку мог
 * выпустить владелец любого альбома прямо из редактора — это и была бесплатная
 * раздача платной возможности.
 */
create or replace function public.album_invite_create(
  p_album uuid, p_days int default 30, p_max_uses int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); tok text; a albums;
begin
  if me is null then raise exception 'auth required'; end if;
  select * into a from albums where id = p_album;
  if a.id is null then raise exception 'Альбом не найден'; end if;
  if a.author_id <> me then raise exception 'Ссылку создаёт только владелец альбома'; end if;
  if not a.is_event then raise exception 'Гостевые ссылки есть только у общего альбома события'; end if;

  tok := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into album_invites (album_id, token_hash, created_by, expires_at, max_uses)
  values (p_album, encode(sha256(tok::bytea), 'hex'), me,
          case when p_days is null then null else now() + make_interval(days => greatest(1, p_days)) end,
          p_max_uses);
  return jsonb_build_object('token', tok);
end $$;

-- ---------------------------------------------------------------- админ

/**
 * Выдать (или отобрать при отрицательном числе) общие альбомы пользователю.
 * Вызывается только панелью модерации под сервисным ключом — как admin_set_plan.
 */
create or replace function public.admin_grant_event(p_username text, p_count int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u uuid; c int;
begin
  select id into u from profiles where username = lower(btrim(p_username));
  if u is null then return jsonb_build_object('error', 'not_found'); end if;

  insert into event_quota (user_id, credits, granted_total)
  values (u, greatest(0, coalesce(p_count, 0)), greatest(0, coalesce(p_count, 0)))
  on conflict (user_id) do update
    set credits       = greatest(0, event_quota.credits + coalesce(p_count, 0)),
        granted_total = event_quota.granted_total + greatest(0, coalesce(p_count, 0)),
        updated_at    = now()
  returning credits into c;

  return jsonb_build_object('username', lower(btrim(p_username)), 'credits', c,
                            'events', (select count(*) from albums where author_id = u and is_event));
end $$;

-- ---------------------------------------------------------------- гранты

revoke execute on function public.admin_grant_event(text, int) from public, anon, authenticated;

grant execute on function
  public.my_event_credits(),
  public.my_event_albums(),
  public.event_album_create(text, text, text),
  public.event_link(uuid),
  public.event_link_reset(uuid),
  public.album_media_set_visibility(uuid[], text)
to authenticated;

grant execute on function public.get_album(uuid), public.can_view_media(uuid, uuid)
to anon, authenticated;
