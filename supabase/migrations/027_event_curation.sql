-- =====================================================================
-- 027: разбор общего альбома — приветствие, обложка, порядок, кто что прислал.
--
--  1. Гостевые фото по умолчанию ждут одобрения автора: событие создаётся с
--     event_hold_guest = true. До одобрения файл не виден никому, кроме автора
--     (и того, кто его залил, — он владелец файла).
--  2. Приветствие автора на странице приглашения (albums.event_greeting).
--     Пусто — страница покажет текст Albums по умолчанию.
--  3. Обложка: первая ПОКАЗАННАЯ фотография становится обложкой сама; автор
--     может выбрать любую другую, включая скрытую.
--  4. Порядок публикации: album_media_reorder.
--  5. Автор видит, кто из гостей что прислал, и кем ему приходится (друг,
--     подписчик). Посторонним этих данных не отдаём.
--
-- ВНИМАНИЕ ПРО ЯДРО: снова переписываются целиком can_view_media и get_album.
-- Единственный источник их тела теперь — ЭТА миграция (правило из PLAN.md).
-- =====================================================================

alter table public.albums add column if not exists event_greeting text;
do $$ begin
  alter table public.albums add constraint albums_greeting_len check (length(event_greeting) <= 1200);
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- обложка сама собой

/**
 * Первая показанная фотография события становится обложкой.
 *
 * Считаем именно ПОКАЗАННУЮ: при включённом «придержать» все гостевые файлы
 * ложатся скрытыми, и обложкой должна стать та, которую автор одобрил первой,
 * а не та, что просто пришла раньше всех. Срабатывает и на добавление файла,
 * и на смену его видимости.
 */
create or replace function public.trg_event_autocover()
returns trigger language plpgsql security definer set search_path = public as $$
declare a albums; k media_kind;
begin
  select * into a from albums where id = new.album_id;
  if a.id is null or not a.is_event or a.cover_media_id is not null then return null; end if;
  if new.is_private then return null; end if;
  select kind into k from media where id = new.media_id;
  if k <> 'photo' then return null; end if;
  update albums set cover_media_id = new.media_id where id = a.id and cover_media_id is null;
  return null;
end $$;

drop trigger if exists event_autocover_t on public.album_media;
create trigger event_autocover_t after insert or update of visibility, is_private on public.album_media
  for each row execute function public.trg_event_autocover();

-- ---------------------------------------------------------------- ядро: can_view_media

/**
 * Полное тело. Отличие от версии 026 — одно: обложку видит всякий, кто может
 * открыть альбом, даже если сам файл помечен скрытым. Обложку автор назначает
 * руками и осознанно: это лицо альбома, и прятать её от тех, кто уже видит
 * альбом, бессмысленно. В интерфейсе об этом сказано прямым текстом.
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
               where n.media_id = m_id and can_view_album(n.album_id, viewer));
$$;

-- ---------------------------------------------------------------- выдача альбома

/**
 * Полное тело get_album. Отличия от версии 026:
 *   — альбом отдаёт event_greeting и cover_media_id;
 *   — у файла отдаётся, кто его залил, — но ТОЛЬКО тем, кто правит альбом.
 *     Обычному зрителю списка «кто что принёс» не видно.
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
        'moderation_status', a.moderation_status,
        'photos_count', a.photos_count, 'videos_count', a.videos_count, 'audio_count', a.audio_count,
        'likes_count', a.likes_count, 'comments_count', a.comments_count, 'views_count', a.views_count,
        'cover_path', (select m.storage_path from media m where m.id = a.cover_media_id),
        'cover_thumb', (select coalesce(m.thumb_path, m.storage_path) from media m where m.id = a.cover_media_id)),
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

-- ---------------------------------------------------------------- события: RPC

/** Событие создаётся с включённым «придержать»: гостевое ждёт одобрения. */
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

  perform set_config('app.event_create', '1', true);
  insert into albums (author_id, title, description, visibility, is_event,
                      event_hold_guest, published_at)
  values (me, btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''), vis, true, true,
          case when vis = 'private' then null else now() end)
  returning id into a_id;
  perform set_config('app.event_create', '', true);

  return jsonb_build_object('album_id', a_id, 'credits_left', left_n);
end $$;

/** Порядок публикации: позиции раздаются по порядку массива. Только автор. */
create or replace function public.album_media_reorder(p_ids uuid[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); n int;
begin
  if me is null then raise exception 'auth required'; end if;
  update album_media am set position = x.ord
    from (select unnest(p_ids) as id, generate_subscripts(p_ids, 1) as ord) x,
         albums a
   where am.id = x.id and a.id = am.album_id and a.author_id = me;
  get diagnostics n = row_count;
  return jsonb_build_object('updated', n);
end $$;

/**
 * Обложкой можно сделать любой залитый снимок, в том числе скрытый: обложку
 * автор выбирает осознанно, и она видна всем, кто может открыть альбом.
 */
create or replace function public.album_set_cover(p_am_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); a_id uuid; m_id uuid; k media_kind;
begin
  if me is null then raise exception 'auth required'; end if;
  select am.album_id, am.media_id, m.kind into a_id, m_id, k
    from album_media am join media m on m.id = am.media_id
    join albums a on a.id = am.album_id
   where am.id = p_am_id and a.author_id = me;
  if a_id is null then raise exception 'Недостаточно прав'; end if;
  if k = 'audio' then raise exception 'Обложкой может быть только фото или кадр видео'; end if;

  update albums set cover_media_id = m_id where id = a_id;
  return jsonb_build_object('ok', true, 'media_id', m_id);
end $$;

/** Обложка из свежезалитого файла (не обязательно попавшего в альбом). */
create or replace function public.album_set_cover_media(p_album uuid, p_media uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth required'; end if;
  if not exists (select 1 from albums where id = p_album and author_id = me) then
    raise exception 'Недостаточно прав';
  end if;
  if not exists (select 1 from media where id = p_media and owner_id = me) then
    raise exception 'Это не ваш файл';
  end if;
  update albums set cover_media_id = p_media where id = p_album;
  return jsonb_build_object('ok', true);
end $$;

/**
 * Гости события: сколько кто принёс и кем приходится автору. Полные данные —
 * только владельцу альбома: посторонним знать, кто из гостей его подписчик,
 * незачем.
 */
create or replace function public.album_contributors(p_album uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case
    when not exists (select 1 from albums where id = p_album and author_id = auth.uid())
      then '[]'::jsonb
    else coalesce((
      select jsonb_agg(jsonb_build_object(
        'username', p.username, 'name', p.display_name, 'avatar', p.avatar_url,
        'role', c.role,
        'uploaded', contrib_upload_count(p_album, c.user_id),
        'shown', (select count(*) from album_media am join media m on m.id = am.media_id
                  where am.album_id = p_album and m.owner_id = c.user_id and not am.is_private),
        'held',  (select count(*) from album_media am join media m on m.id = am.media_id
                  where am.album_id = p_album and m.owner_id = c.user_id and am.visibility = 'private'),
        'is_friend', are_friends(auth.uid(), c.user_id),
        'is_follower', is_following(c.user_id, auth.uid()),
        'joined_at', c.created_at)
        order by contrib_upload_count(p_album, c.user_id) desc)
      from album_collaborators c join profiles p on p.id = c.user_id
      where c.album_id = p_album), '[]'::jsonb)
  end;
$$;

/** Что видит гость на странице приглашения ДО входа: обложка, название, слово автора. */
create or replace function public.album_invite_peek(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare inv album_invites; a albums; p profiles;
begin
  select * into inv from album_invites where token_hash = encode(sha256(p_token::bytea), 'hex');
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if inv.revoked_at is not null then return jsonb_build_object('ok', false, 'reason', 'revoked'); end if;
  if inv.expires_at is not null and inv.expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if inv.max_uses is not null and inv.uses >= inv.max_uses then
    return jsonb_build_object('ok', false, 'reason', 'used_up'); end if;

  select * into a from albums where id = inv.album_id;
  select * into p from profiles where id = a.author_id;
  return jsonb_build_object('ok', true, 'album_id', a.id, 'title', a.title,
    'greeting', a.event_greeting,
    'owner_name', p.display_name, 'owner_username', p.username, 'owner_avatar', p.avatar_url,
    'cover_path', (select coalesce(m.thumb_path, m.storage_path) from media m where m.id = a.cover_media_id),
    'cover_full', (select m.storage_path from media m where m.id = a.cover_media_id),
    'already_in', exists (select 1 from album_collaborators c
                          where c.album_id = a.id and c.user_id = auth.uid()));
end $$;

-- ---------------------------------------------------------------- добор для уже созданных

-- События, созданные до этой миграции, жили с выключенным «придержать» и без
-- обложки. Приводим их к новому поведению: гостевое ждёт одобрения, а обложкой
-- становится первый показанный снимок.
update public.albums set event_hold_guest = true
 where is_event and not event_hold_guest;

update public.albums a set cover_media_id = (
  select am.media_id from album_media am join media m on m.id = am.media_id
   where am.album_id = a.id and not am.is_private and m.kind = 'photo'
   order by am.position limit 1)
 where a.is_event and a.cover_media_id is null;

-- ---------------------------------------------------------------- гранты

grant execute on function
  public.album_media_reorder(uuid[]),
  public.album_set_cover(uuid),
  public.album_set_cover_media(uuid, uuid)
to authenticated;

grant execute on function public.get_album(uuid), public.can_view_media(uuid, uuid),
  public.album_invite_peek(text)
to anon, authenticated;

grant execute on function public.album_contributors(uuid) to authenticated;
