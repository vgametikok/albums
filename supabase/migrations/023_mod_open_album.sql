-- =====================================================================
-- 023: полный просмотр альбома модератором.
--
-- Панель показывала только плитку превью. Решение о публикации так принимать
-- нельзя: нужны подписи к каждому кадру, видео со звуком, голосовые заметки и
-- дорожка-рассказ. Функция отдаёт ровно ту же структуру, что get_album, но без
-- проверки видимости и ВКЛЮЧАЯ файлы, помеченные автором как приватные, —
-- смотреть требуется всё, что уедет на сайт.
--
-- Только сервисный ключ (edge-функция mod-api): execute отозван явно.
-- =====================================================================

create or replace function public.mod_open_album(p_id uuid, p_login text default null)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'album', jsonb_build_object(
      'id', a.id, 'title', a.title, 'description', a.description, 'category', a.category,
      'visibility', a.visibility, 'published_at', a.published_at, 'created_at', a.created_at,
      'date_from', a.date_from, 'date_to', a.date_to,
      'photos_count', a.photos_count, 'videos_count', a.videos_count, 'audio_count', a.audio_count,
      'likes_count', a.likes_count, 'comments_count', a.comments_count, 'views_count', a.views_count,
      'moderation_status', a.moderation_status,
      'cover_path', (select m.storage_path from media m where m.id = a.cover_media_id)),
    'author', jsonb_build_object(
      'username', p.username, 'name', p.display_name, 'avatar', p.avatar_url,
      'banned', p.banned_at is not null,
      'albums_total', (select count(*) from albums x where x.author_id = a.author_id),
      'joined', p.created_at),
    'collaborators', coalesce((
      select jsonb_agg(jsonb_build_object('username', cp.username, 'role', c.role))
      from album_collaborators c join profiles cp on cp.id = c.user_id
      where c.album_id = a.id), '[]'::jsonb),
    'narration', (
      select jsonb_build_object('path', m.storage_path, 'duration', n.duration, 'id', m.id)
      from album_narrations n join media m on m.id = n.media_id where n.album_id = a.id),
    'chapters', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'label', c.label, 'title', c.title, 'body', c.body, 'position', c.position,
        'media', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', m.id, 'am_id', am.id, 'kind', m.kind, 'path', m.storage_path, 'thumb', m.thumb_path,
            'width', m.width, 'height', m.height, 'duration', m.duration_seconds,
            'captured_at', m.captured_at, 'caption', am.caption, 'position', am.position,
            'is_private', am.is_private,
            'owner', (select username from profiles op where op.id = m.owner_id)) order by am.position)
          from album_media am join media m on m.id = am.media_id
          where am.chapter_id = c.id), '[]'::jsonb)
      ) order by c.position)
      from album_chapters c where c.album_id = a.id), '[]'::jsonb),
    'loose', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'am_id', am.id, 'kind', m.kind, 'path', m.storage_path, 'thumb', m.thumb_path,
        'width', m.width, 'height', m.height, 'duration', m.duration_seconds,
        'captured_at', m.captured_at, 'caption', am.caption, 'position', am.position,
        'is_private', am.is_private,
        'owner', (select username from profiles op where op.id = m.owner_id)) order by am.position)
      from album_media am join media m on m.id = am.media_id
      where am.album_id = a.id and am.chapter_id is null), '[]'::jsonb),
    'comments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'body', cm.body, 'author', cp.username, 'created_at', cm.created_at,
        'hidden', cm.hidden_at is not null) order by cm.created_at)
      from comments cm join profiles cp on cp.id = cm.author_id
      where cm.subject_type = 'album' and cm.subject_id = a.id), '[]'::jsonb)
  )
  from albums a join profiles p on p.id = a.author_id
  where a.id = p_id;
$$;

revoke execute on function public.mod_open_album(uuid,text) from public, anon, authenticated;
