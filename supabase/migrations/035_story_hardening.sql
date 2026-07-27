-- =====================================================================
-- 035: закалка 034 по результатам ревью безопасности (STORY-PLAN.md §9).
--
--  1. КРИТИЧНОЕ. Политика UPDATE на album_media строчная, не поколоночная, и
--     колонки voice_media_id / gallery_id (034) были доступны прямому PATCH в
--     обход RPC: можно было прикрепить ЧУЖОЙ media-id «голосовой» к своему
--     открытому кадру — и новая ветка can_view_media раздала бы подписанные
--     ссылки на чужой файл всем. Тот же класс дыры существовал с 001 и на
--     самом media_id (вставка чужого файла кадром своего альбома).
--     Ответ — триггер-страж trg_album_media_guard: голосовая только своё
--     аудио, кадр только свой файл, галерея только этого альбома. Сервисный
--     ключ (панель модерации) не ограничивается — паттерн trg_profile_guard.
--  2. СЕРЬЁЗНОЕ. Проверка «в галерее есть видимый кадр» (can_view_media,
--     get_album) не требовала am.album_id = g.album_id: кадр ЧУЖОГО альбома,
--     указавший на галерею, открывал её голосовую всем зрителям альбома
--     галереи. Обе функции переписаны целиком (источник тел теперь ЗДЕСЬ,
--     прежний — 034) с жёсткой привязкой кадра к альбому галереи. Триггер
--     из п.1 заодно не даёт создать такую связь вовсе.
--  3. has_voices больше не выдаёт существование голосовых на скрытых кадрах:
--     считается только по кадрам/галереям, видимым зрителю. galleries в
--     get_album получил недостающую ветку «кадр залит самим зрителем».
--  4. Голосовая чистится и при УДАЛЕНИИ кадра/галереи (after delete
--     триггеры), а не только при перезаписи — сироты не копятся в квоте.
--  5. Гигиена: revoke all на новые таблицы (Supabase раздаёт полные права по
--     умолчанию — гоча 020; запись и так закрыта RLS, но пояс с подтяжками);
--     null-аргументы album_story_mode_set / album_story_reorder теперь
--     отклоняются явно.
--
-- Поправка указателя: полное тело can_view_album живёт в 028 (не в 022, как
-- ошибочно писал заголовок 034) — здесь оно по-прежнему НЕ трогается.
-- =====================================================================

-- ---------------------------------------------------------------- страж album_media

/**
 * Прямые INSERT/UPDATE в album_media разрешены политиками (редактор, гостевая
 * дозагрузка) — значит инварианты владения обязаны жить в триггере, а не
 * только в RPC. Сервисный ключ и прямой SQL не ограничиваем.
 */
create or replace function public.trg_album_media_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare r text;
begin
  begin
    r := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
  exception when others then r := null;
  end;
  if coalesce(r, 'service_role') = 'service_role' then return new; end if;

  -- кадром может лечь только СВОЙ файл
  if (tg_op = 'INSERT' or new.media_id is distinct from old.media_id)
     and not exists (select 1 from media m
                     where m.id = new.media_id and m.owner_id = auth.uid()) then
    raise exception 'Это не ваш файл';
  end if;

  -- голосовой может быть только СВОЁ аудио
  if new.voice_media_id is not null
     and (tg_op = 'INSERT' or new.voice_media_id is distinct from old.voice_media_id)
     and not exists (select 1 from media m
                     where m.id = new.voice_media_id and m.owner_id = auth.uid()
                       and m.kind = 'audio') then
    raise exception 'Можно использовать только свою запись';
  end if;

  -- галерея обязана принадлежать ЭТОМУ альбому
  if new.gallery_id is not null
     and (tg_op = 'INSERT' or new.gallery_id is distinct from old.gallery_id)
     and not exists (select 1 from album_galleries g
                     where g.id = new.gallery_id and g.album_id = new.album_id) then
    raise exception 'Галерея не из этого альбома';
  end if;

  return new;
end $$;

drop trigger if exists album_media_guard_t on public.album_media;
create trigger album_media_guard_t before insert or update on public.album_media
  for each row execute function public.trg_album_media_guard();

-- ---------------------------------------------------------------- уборка при удалении

/** Кадр удалили — его голосовая (если больше никому не нужна) уходит следом. */
create or replace function public.trg_album_media_prune_voice()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform voice_media_prune(old.voice_media_id);
  return null;
end $$;

drop trigger if exists album_media_prune_voice_t on public.album_media;
create trigger album_media_prune_voice_t after delete on public.album_media
  for each row when (old.voice_media_id is not null)
  execute function public.trg_album_media_prune_voice();

create or replace function public.trg_album_galleries_prune_voice()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform voice_media_prune(old.voice_media_id);
  return null;
end $$;

drop trigger if exists album_galleries_prune_voice_t on public.album_galleries;
create trigger album_galleries_prune_voice_t after delete on public.album_galleries
  for each row when (old.voice_media_id is not null)
  execute function public.trg_album_galleries_prune_voice();

-- ---------------------------------------------------------------- гигиена прав

revoke all on public.album_galleries, public.album_texts from anon, authenticated;
grant select on public.album_galleries, public.album_texts to anon, authenticated;

-- ---------------------------------------------------------------- ядро: can_view_media

/**
 * Полное тело. Источник — эта миграция (прежний — 034). Единственное отличие
 * от 034: в ветке голосовой галереи видимый кадр обязан принадлежать альбому
 * самой галереи (am.album_id = g.album_id) — кадр чужого альбома, указавший
 * на галерею, больше не открывает её голосовую.
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
    -- обложка видимого альбома
    or exists (select 1 from albums al
               where al.cover_media_id = m_id and can_view_album(al.id, viewer))
    -- слайд видимого поста
    or exists (select 1 from post_media pm
               where pm.media_id = m_id and can_view_post(pm.post_id, viewer))
    -- аудио-рассказ виден тем же, кому виден альбом
    or exists (select 1 from album_narrations n
               where n.media_id = m_id and can_view_album(n.album_id, viewer))
    -- голосовая открытого кадра — тем, кому виден альбом
    or exists (select 1 from album_media am
               where am.voice_media_id = m_id and not am.is_private
                 and can_view_album(am.album_id, viewer))
    -- голосовая friends-кадра — друзьям автора (и самому автору)
    or exists (select 1 from album_media am join albums a on a.id = am.album_id
               where am.voice_media_id = m_id and am.visibility = 'friends'
                 and can_view_album(am.album_id, viewer)
                 and (a.author_id = viewer or are_friends(a.author_id, viewer)))
    -- голосовая скрытого кадра — только владельцу альбома и редактору
    or exists (select 1 from album_media am
               where am.voice_media_id = m_id and am.visibility = 'private'
                 and (exists (select 1 from albums a where a.id = am.album_id and a.author_id = viewer)
                      or exists (select 1 from album_collaborators c
                                 where c.album_id = am.album_id and c.user_id = viewer and c.role = 'editor')))
    -- голосовая галереи
    or exists (select 1 from album_galleries g
               where g.voice_media_id = m_id
                 and (exists (select 1 from albums a where a.id = g.album_id and a.author_id = viewer)
                      or exists (select 1 from album_collaborators c
                                 where c.album_id = g.album_id and c.user_id = viewer and c.role = 'editor')
                      or (can_view_album(g.album_id, viewer)
                          and exists (select 1 from album_media am join albums a2 on a2.id = am.album_id
                                      where am.gallery_id = g.id and am.album_id = g.album_id
                                        and (not am.is_private
                                             or (am.visibility = 'friends'
                                                 and are_friends(a2.author_id, viewer)))))));
$$;

-- ---------------------------------------------------------------- ядро: get_album

/**
 * Полное тело. Источник — эта миграция (прежний — 034). Отличия от 034:
 *   — galleries: видимый кадр обязан принадлежать альбому галереи, добавлена
 *     недостающая ветка «кадр залит самим зрителем» (паритет с фильтром
 *     кадров);
 *   — has_voices считается ТОЛЬКО по видимым зрителю кадрам и галереям —
 *     существование голосовой на скрытом кадре больше не выдаётся.
 * Всё остальное — без изменений относительно 034.
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
        'event_greeting', a.event_greeting, 'cover_media_id', a.cover_media_id,
        'moderation_status', a.moderation_status, 'story_mode', a.story_mode,
        'photos_count', a.photos_count, 'videos_count', a.videos_count, 'audio_count', a.audio_count,
        'likes_count', a.likes_count, 'comments_count', a.comments_count, 'views_count', a.views_count,
        'cover_path', (select m.storage_path from media m where m.id = a.cover_media_id),
        'cover_thumb', (select coalesce(m.thumb_path, m.storage_path) from media m where m.id = a.cover_media_id)),
      'author', jsonb_build_object('username', p.username, 'name', p.display_name, 'avatar', p.avatar_url),
      'is_author', a.author_id = auth.uid(),
      'can_edit', can_edit_album(a.id),
      'can_contribute', can_contribute_album(a.id),
      'has_narration', exists (select 1 from album_narrations n where n.album_id = a.id),
      'has_voices', (exists (
          select 1 from album_media am
          where am.album_id = a.id and am.voice_media_id is not null
            and (not am.is_private
                 or can_edit_album(a.id)
                 or exists (select 1 from media mm where mm.id = am.media_id and mm.owner_id = auth.uid())
                 or (am.visibility = 'friends' and are_friends(a.author_id, auth.uid())))
        ) or exists (
          select 1 from album_galleries g
          where g.album_id = a.id and g.voice_media_id is not null
            and exists (select 1 from album_media am2
                        where am2.gallery_id = g.id and am2.album_id = g.album_id
                          and (not am2.is_private
                               or can_edit_album(a.id)
                               or exists (select 1 from media mm where mm.id = am2.media_id and mm.owner_id = auth.uid())
                               or (am2.visibility = 'friends' and are_friends(a.author_id, auth.uid()))))
        )),
      'collaborators', coalesce((
        select jsonb_agg(jsonb_build_object('username', cp.username, 'name', cp.display_name,
                                            'avatar', cp.avatar_url, 'role', c.role))
        from album_collaborators c join profiles cp on cp.id = c.user_id
        where c.album_id = a.id), '[]'::jsonb),
      'liked', exists (select 1 from likes l where l.subject_type='album' and l.subject_id=a.id and l.user_id=auth.uid()),
      'saved', exists (select 1 from saves s where s.album_id=a.id and s.user_id=auth.uid()),
      'galleries', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', g.id,
          'voice_path', (select vm.storage_path from media vm where vm.id = g.voice_media_id),
          'voice_duration', (select vm.duration_seconds from media vm where vm.id = g.voice_media_id)))
        from album_galleries g
        where g.album_id = a.id
          and exists (select 1 from album_media am2
                      where am2.gallery_id = g.id and am2.album_id = g.album_id
                        and (not am2.is_private
                             or can_edit_album(a.id)
                             or exists (select 1 from media mm where mm.id = am2.media_id and mm.owner_id = auth.uid())
                             or (am2.visibility = 'friends' and are_friends(a.author_id, auth.uid()))))), '[]'::jsonb),
      'texts', coalesce((
        select jsonb_agg(jsonb_build_object('id', x.id, 'chapter_id', x.chapter_id,
                                            'position', x.position, 'body', x.body) order by x.position)
        from album_texts x where x.album_id = a.id), '[]'::jsonb),
      'chapters', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', c.id, 'label', c.label, 'title', c.title, 'body', c.body, 'position', c.position,
          'media', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', m.id, 'am_id', am.id, 'kind', m.kind, 'path', m.storage_path, 'thumb', m.thumb_path,
              'width', m.width, 'height', m.height, 'duration', m.duration_seconds,
              'captured_at', m.captured_at, 'caption', am.caption, 'position', am.position,
              'is_private', am.is_private, 'visibility', am.visibility,
              'gallery_id', am.gallery_id,
              'voice_path', (select vm.storage_path from media vm where vm.id = am.voice_media_id),
              'voice_duration', (select vm.duration_seconds from media vm where vm.id = am.voice_media_id),
              'mine', m.owner_id = auth.uid(),
              'by', case when can_edit_album(a.id)
                         then (select jsonb_build_object('username', up.username, 'name', up.display_name,
                                                         'avatar', up.avatar_url)
                               from profiles up where up.id = m.owner_id) end) order by am.position)
            from album_media am join media m on m.id = am.media_id
            where am.chapter_id = c.id
              and (not am.is_private
                   or can_edit_album(a.id)
                   or m.owner_id = auth.uid()
                   or (am.visibility = 'friends' and are_friends(a.author_id, auth.uid())))), '[]'::jsonb)
        ) order by c.position)
        from album_chapters c where c.album_id = a.id), '[]'::jsonb),
      'loose', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', m.id, 'am_id', am.id, 'kind', m.kind, 'path', m.storage_path, 'thumb', m.thumb_path,
          'width', m.width, 'height', m.height, 'duration', m.duration_seconds,
          'captured_at', m.captured_at, 'caption', am.caption, 'position', am.position,
          'is_private', am.is_private, 'visibility', am.visibility,
          'gallery_id', am.gallery_id,
          'voice_path', (select vm.storage_path from media vm where vm.id = am.voice_media_id),
          'voice_duration', (select vm.duration_seconds from media vm where vm.id = am.voice_media_id),
          'mine', m.owner_id = auth.uid(),
          'by', case when can_edit_album(a.id)
                     then (select jsonb_build_object('username', up.username, 'name', up.display_name,
                                                     'avatar', up.avatar_url)
                           from profiles up where up.id = m.owner_id) end) order by am.position)
        from album_media am join media m on m.id = am.media_id
        where am.album_id = a.id and am.chapter_id is null
          and (not am.is_private
               or can_edit_album(a.id)
               or m.owner_id = auth.uid()
               or (am.visibility = 'friends' and are_friends(a.author_id, auth.uid())))), '[]'::jsonb)
    )
    from albums a join profiles p on p.id = a.author_id where a.id = p_id
  ) end;
$$;

-- ---------------------------------------------------------------- null-заглушки RPC

/** Как в 034, плюс явный отказ на null-режим. */
create or replace function public.album_story_mode_set(p_album uuid, p_mode text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth required'; end if;
  if not can_edit_album(p_album) then raise exception 'Недостаточно прав'; end if;
  if p_mode is null or p_mode not in ('auto', 'narration', 'voices') then raise exception 'bad mode'; end if;
  update albums set story_mode = nullif(p_mode, 'auto') where id = p_album;
  return jsonb_build_object('ok', true);
end $$;

/** Как в 034, плюс явный отказ на null-аргумент. */
create or replace function public.album_story_reorder(p_album uuid, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); n1 int; n2 int;
begin
  if me is null then raise exception 'auth required'; end if;
  if not can_edit_album(p_album) then raise exception 'Недостаточно прав'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'Ожидается массив'; end if;
  if jsonb_array_length(p_items) > 1000 then raise exception 'Слишком много элементов'; end if;

  update album_media am set position = x.ord - 1
    from (select (e->>'id')::uuid as id, t.ord
            from jsonb_array_elements(p_items) with ordinality as t(e, ord)
           where e->>'t' = 'm') x
   where am.id = x.id and am.album_id = p_album;
  get diagnostics n1 = row_count;

  update album_texts tx set position = x.ord - 1
    from (select (e->>'id')::uuid as id, t.ord
            from jsonb_array_elements(p_items) with ordinality as t(e, ord)
           where e->>'t' = 'x') x
   where tx.id = x.id and tx.album_id = p_album;
  get diagnostics n2 = row_count;

  return jsonb_build_object('media', n1, 'texts', n2);
end $$;

-- ---------------------------------------------------------------- гранты

revoke execute on function public.trg_album_media_guard()           from public, anon, authenticated;
revoke execute on function public.trg_album_media_prune_voice()     from public, anon, authenticated;
revoke execute on function public.trg_album_galleries_prune_voice() from public, anon, authenticated;

-- Переподтверждение прав на переписанное (create or replace сохраняет ACL,
-- но правило проекта — задавать их явно в источнике тела).
grant execute on function public.can_view_media(uuid,uuid), public.get_album(uuid)
to anon, authenticated;
grant execute on function
  public.album_story_mode_set(uuid,text),
  public.album_story_reorder(uuid,jsonb)
to authenticated;
revoke execute on function
  public.album_story_mode_set(uuid,text),
  public.album_story_reorder(uuid,jsonb)
from anon;
