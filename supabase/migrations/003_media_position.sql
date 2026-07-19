-- get_album теперь отдаёт position каждого медиа: нужен, чтобы собрать сквозной
-- порядок «от первого к последнему загруженному» через главы и внеглавные медиа.

create or replace function public.get_album(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not can_view_album(p_id, auth.uid()) then null else (
    select jsonb_build_object(
      'album', jsonb_build_object(
        'id', a.id, 'title', a.title, 'description', a.description, 'category', a.category,
        'visibility', a.visibility, 'published_at', a.published_at, 'created_at', a.created_at,
        'photos_count', a.photos_count, 'videos_count', a.videos_count, 'audio_count', a.audio_count,
        'likes_count', a.likes_count, 'comments_count', a.comments_count, 'views_count', a.views_count,
        'cover_path', (select coalesce(m.storage_path) from media m where m.id = a.cover_media_id)),
      'author', jsonb_build_object('username', p.username, 'name', p.display_name, 'avatar', p.avatar_url),
      'is_author', a.author_id = auth.uid(),
      'liked', exists (select 1 from likes l where l.subject_type='album' and l.subject_id=a.id and l.user_id=auth.uid()),
      'saved', exists (select 1 from saves s where s.album_id=a.id and s.user_id=auth.uid()),
      'chapters', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', c.id, 'label', c.label, 'title', c.title, 'body', c.body,
          'position', c.position,
          'media', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', m.id, 'kind', m.kind, 'path', m.storage_path, 'thumb', m.thumb_path,
              'width', m.width, 'height', m.height, 'duration', m.duration_seconds,
              'caption', am.caption, 'position', am.position) order by am.position)
            from album_media am join media m on m.id = am.media_id
            where am.chapter_id = c.id), '[]'::jsonb)
        ) order by c.position)
        from album_chapters c where c.album_id = a.id), '[]'::jsonb),
      'loose', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', m.id, 'kind', m.kind, 'path', m.storage_path, 'thumb', m.thumb_path,
          'width', m.width, 'height', m.height, 'duration', m.duration_seconds,
          'caption', am.caption, 'position', am.position) order by am.position)
        from album_media am join media m on m.id = am.media_id
        where am.album_id = a.id and am.chapter_id is null), '[]'::jsonb)
    )
    from albums a join profiles p on p.id = a.author_id where a.id = p_id
  ) end;
$$;

grant execute on function public.get_album(uuid) to anon, authenticated;
