-- 015: ЕДИНСТВЕННАЯ точка переопределения ядра видимости и агрегатных выдач.
--
-- Почему так: миграции 007–014 добавляли новые правила (блокировки, баны, скрытие
-- модератором, роль контрибьютора, аудио-рассказ, мягкое удаление). Если бы каждая
-- переписывала can_view_album своим полным телом, последняя молча стёрла бы ветки
-- остальных — без единой ошибки, но с дырой в приватности. Поэтому все ветки
-- собраны здесь один раз и в фиксированном порядке.
--
-- ПОРЯДОК ВЕТОК ОБЯЗАТЕЛЕН: прямая проверка владельца идёт ПЕРВОЙ. Иначе
-- INSERT ... RETURNING падает с 42501 — эта функция вызывается из SELECT-политики
-- той же таблицы, и вставляемая строка своему же запросу ещё не видна (гоча 002).
--
-- Сигнатуры feed_albums / feed_posts / log_album_view НЕ меняются: фронт продолжает
-- работать без синхронного релиза. Персональная лента добавится отдельной функцией.

-- ============================================================ ЯДРО ВИДИМОСТИ

create or replace function public.can_view_album(a_id uuid, viewer uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from albums a
    where a.id = a_id and (
      -- 1. владелец: всегда и без каких-либо условий
      a.author_id = viewer
      -- 2. соавтор или гость события
      or (viewer is not null
          and exists (select 1 from album_collaborators c
                      where c.album_id = a.id and c.user_id = viewer)
          and not is_blocked_between(a.author_id, viewer))
      -- 3. обычный зритель
      or (a.published_at is not null
          and a.hidden_at is null
          and not is_banned(a.author_id)
          and not exists (select 1 from profiles p where p.id = a.author_id and p.deleted_at is not null)
          and not is_blocked_between(a.author_id, viewer)
          and (a.visibility = 'public'
               or (a.visibility = 'friends'
                   and are_friends(a.author_id, viewer)
                   and not exists (select 1 from album_exceptions e
                                   where e.album_id = a.id and e.user_id = viewer))))
    ));
$$;

create or replace function public.can_view_post(p_id uuid, viewer uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from posts p
    where p.id = p_id and (
      p.author_id = viewer
      or p.coauthor_id = viewer
      or (p.hidden_at is null
          and not is_banned(p.author_id)
          and not exists (select 1 from profiles pr where pr.id = p.author_id and pr.deleted_at is not null)
          and not is_blocked_between(p.author_id, viewer)
          and (p.visibility = 'public'
               or (p.visibility = 'friends' and are_friends(p.author_id, viewer))))
    ));
$$;

create or replace function public.can_view_media(m_id uuid, viewer uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select
    -- владелец файла
    exists (select 1 from media where id = m_id and owner_id = viewer)
    -- открытый файл в видимом альбоме
    or exists (select 1 from album_media am
               where am.media_id = m_id and not am.is_private
                 and can_view_album(am.album_id, viewer))
    -- приватный файл: только владелец альбома и РЕДАКТОР. Гость события — нет.
    or exists (select 1 from album_media am
               where am.media_id = m_id and am.is_private
                 and (exists (select 1 from albums a where a.id = am.album_id and a.author_id = viewer)
                      or exists (select 1 from album_collaborators c
                                 where c.album_id = am.album_id and c.user_id = viewer and c.role = 'editor')))
    -- обложка видимого альбома, если она не помечена приватной
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

-- ============================================================ ПОЛИТИКИ

-- albums: прямая проверка владельца первой (иначе INSERT..RETURNING = 42501)
drop policy if exists albums_read on albums;
create policy albums_read on albums for select
  using (author_id = auth.uid() or can_view_album(id, auth.uid()));

drop policy if exists posts_read on posts;
create policy posts_read on posts for select
  using (author_id = auth.uid() or coauthor_id = auth.uid() or can_view_post(id, auth.uid()));

drop policy if exists posts_upd on posts;
create policy posts_upd on posts for update
  using (can_edit_post(id)) with check (can_edit_post(id));

drop policy if exists media_read on media;
create policy media_read on media for select
  using (owner_id = auth.uid() or can_view_media(id, auth.uid()));

-- album_media: редактор правит всё, контрибьютор — только своё
drop policy if exists amedia_read on album_media;
drop policy if exists amedia_all  on album_media;
drop policy if exists amedia_ins  on album_media;
drop policy if exists amedia_upd  on album_media;
drop policy if exists amedia_del  on album_media;

create policy amedia_read on album_media for select using (can_view_album(album_id, auth.uid()));
create policy amedia_ins on album_media for insert with check (
  can_edit_album(album_id)
  or (can_contribute_album(album_id)
      and exists (select 1 from media m where m.id = media_id and m.owner_id = auth.uid())));
create policy amedia_upd on album_media for update
  using (can_edit_album(album_id)
         or exists (select 1 from media m where m.id = media_id and m.owner_id = auth.uid()))
  with check (can_edit_album(album_id)
         or exists (select 1 from media m where m.id = media_id and m.owner_id = auth.uid()));
create policy amedia_del on album_media for delete
  using (can_edit_album(album_id)
         or exists (select 1 from media m where m.id = media_id and m.owner_id = auth.uid()));

-- В пост можно класть ТОЛЬКО свои файлы — правило проверяется в базе, а не в интерфейсе.
drop policy if exists pmedia_read on post_media;
drop policy if exists pmedia_all  on post_media;
create policy pmedia_read on post_media for select using (can_view_post(post_id, auth.uid()));
create policy pmedia_all on post_media for all
  using (exists (select 1 from posts where id = post_id and (author_id = auth.uid() or coauthor_id = auth.uid())))
  with check (
    exists (select 1 from posts where id = post_id and (author_id = auth.uid() or coauthor_id = auth.uid()))
    and exists (select 1 from media m where m.id = media_id and m.owner_id = auth.uid()));

-- Заблокированные не комментируют друг друга.
drop policy if exists comments_ins on comments;
create policy comments_ins on comments for insert with check (
  author_id = auth.uid()
  and can_view_subject(subject_type, subject_id, auth.uid())
  and not exists (
    select 1 from albums a where subject_type = 'album' and a.id = subject_id
      and is_blocked_between(a.author_id, auth.uid()))
  and not exists (
    select 1 from posts p where subject_type = 'post' and p.id = subject_id
      and is_blocked_between(p.author_id, auth.uid())));

-- Скрытые модератором комментарии не показываем никому, кроме автора.
drop policy if exists comments_read on comments;
create policy comments_read on comments for select using (
  can_view_subject(subject_type, subject_id, auth.uid())
  and (hidden_at is null or author_id = auth.uid()));

-- ============================================================ ВЫДАЧИ

create or replace function public.get_album(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not can_view_album(p_id, auth.uid()) then null else (
    select jsonb_build_object(
      'album', jsonb_build_object(
        'id', a.id, 'title', a.title, 'description', a.description, 'category', a.category,
        'visibility', a.visibility, 'published_at', a.published_at, 'created_at', a.created_at,
        'date_from', a.date_from, 'date_to', a.date_to, 'date_precision', a.date_precision,
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
              'is_private', am.is_private, 'mine', m.owner_id = auth.uid()) order by am.position)
            from album_media am join media m on m.id = am.media_id
            where am.chapter_id = c.id
              and (not am.is_private or can_edit_album(a.id))), '[]'::jsonb)
        ) order by c.position)
        from album_chapters c where c.album_id = a.id), '[]'::jsonb),
      'loose', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', m.id, 'am_id', am.id, 'kind', m.kind, 'path', m.storage_path, 'thumb', m.thumb_path,
          'width', m.width, 'height', m.height, 'duration', m.duration_seconds,
          'captured_at', m.captured_at, 'caption', am.caption, 'position', am.position,
          'is_private', am.is_private, 'mine', m.owner_id = auth.uid()) order by am.position)
        from album_media am join media m on m.id = am.media_id
        where am.album_id = a.id and am.chapter_id is null
          and (not am.is_private or can_edit_album(a.id))), '[]'::jsonb)
    )
    from albums a join profiles p on p.id = a.author_id where a.id = p_id
  ) end;
$$;

create or replace function public.get_profile(p_username text)
returns jsonb language sql stable security definer set search_path = public as $$
  select case
    when not exists (select 1 from profiles where username = lower(p_username)) then null
    when exists (select 1 from profiles p where p.username = lower(p_username)
                 and (p.banned_at is not null or p.deleted_at is not null
                      or is_blocked_between(p.id, auth.uid()))
                 and p.id <> auth.uid())
      then jsonb_build_object('unavailable', true)
    else (
      select jsonb_build_object(
        'profile', jsonb_build_object(
          'id', p.id, 'username', p.username, 'name', p.display_name, 'avatar', p.avatar_url,
          'banner', p.banner_url, 'bio', p.bio, 'location', p.location, 'created_at', p.created_at),
        'is_me', p.id = auth.uid(),
        'friend_state', case
          when p.id = auth.uid() then 'self'
          when auth.uid() is null then 'anon'
          else coalesce((
            select case when f.status = 'accepted' then 'friends'
                        when f.requested_by = auth.uid() then 'sent' else 'incoming' end
            from friendships f
            where f.user_a = least(p.id, auth.uid()) and f.user_b = greatest(p.id, auth.uid())), 'none')
          end,
        'is_following', is_following(auth.uid(), p.id),
        'followers_count', p.followers_count,
        'following_count', p.following_count,
        'friends_count', (select count(*) from friendships f
                          where f.status='accepted' and (f.user_a = p.id or f.user_b = p.id)),
        'albums_count', (select count(*) from albums a
                         where a.author_id = p.id and can_view_album(a.id, auth.uid())),
        'albums', coalesce((
          select jsonb_agg(x order by x->>'published_at' desc nulls first) from (
            select jsonb_build_object(
              'id', a.id, 'title', a.title, 'category', a.category, 'visibility', a.visibility,
              'is_pinned', a.is_pinned, 'published_at', a.published_at,
              'date_from', a.date_from, 'date_to', a.date_to,
              'photos_count', a.photos_count, 'videos_count', a.videos_count, 'audio_count', a.audio_count,
              'views_count', a.views_count, 'likes_count', a.likes_count,
              'cover_path', (select coalesce(m.thumb_path, m.storage_path) from media m where m.id = a.cover_media_id),
              'thumb1', (select coalesce(m.thumb_path, m.storage_path) from album_media am join media m on m.id=am.media_id
                         where am.album_id=a.id and m.kind<>'audio' and not am.is_private order by am.position limit 1),
              'thumb2', (select coalesce(m.thumb_path, m.storage_path) from album_media am join media m on m.id=am.media_id
                         where am.album_id=a.id and m.kind<>'audio' and not am.is_private order by am.position limit 1 offset 1)
            ) as x
            from albums a where a.author_id = p.id and can_view_album(a.id, auth.uid())
          ) s), '[]'::jsonb))
      from profiles p where p.username = lower(p_username)
    ) end;
$$;

create or replace function public.my_shared_albums()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'title', a.title, 'category', a.category, 'visibility', a.visibility,
      'published_at', a.published_at, 'role', c.role,
      'photos_count', a.photos_count, 'videos_count', a.videos_count, 'audio_count', a.audio_count,
      'views_count', a.views_count, 'likes_count', a.likes_count,
      'owner_username', p.username, 'owner_name', p.display_name,
      'cover_path', (select coalesce(m.thumb_path, m.storage_path) from media m where m.id = a.cover_media_id),
      'thumb1', (select coalesce(m.thumb_path, m.storage_path) from album_media am join media m on m.id=am.media_id
                 where am.album_id=a.id and m.kind<>'audio' and not am.is_private order by am.position limit 1),
      'thumb2', (select coalesce(m.thumb_path, m.storage_path) from album_media am join media m on m.id=am.media_id
                 where am.album_id=a.id and m.kind<>'audio' and not am.is_private order by am.position limit 1 offset 1)
    ) order by a.updated_at desc)
    from album_collaborators c
    join albums a on a.id = c.album_id
    join profiles p on p.id = a.author_id
    where c.user_id = auth.uid()), '[]'::jsonb);
$$;

-- feed_albums: тело обновлено (скрытые/забаненные/приватные файлы), сигнатура прежняя.
create or replace function public.feed_albums(
  p_seed text default 'seed', p_category text default null,
  p_limit int default 24, p_offset int default 0)
returns table (
  id uuid, title text, category text, description text,
  author_username text, author_name text, author_avatar text,
  cover_path text, thumb1_path text, thumb1_kind media_kind,
  thumb2_path text, thumb2_kind media_kind,
  photos_count int, videos_count int, audio_count int,
  likes_count int, comments_count int, views_count int,
  published_at timestamptz)
language sql stable security definer set search_path = public as $$
  with vis as (
    select a.* from albums a
    where a.published_at is not null and a.hidden_at is null
      and can_view_album(a.id, auth.uid())
      and (p_category is null or a.category = p_category)
  )
  select v.id, v.title, v.category, v.description,
         p.username, p.display_name, p.avatar_url,
         coalesce(cm.thumb_path, cm.storage_path, t1.path),
         t1.path, t1.kind, t2.path, t2.kind,
         v.photos_count, v.videos_count, v.audio_count,
         v.likes_count, v.comments_count, v.views_count, v.published_at
  from vis v
  join profiles p on p.id = v.author_id
  left join media cm on cm.id = v.cover_media_id
  left join lateral (
    select coalesce(m.thumb_path, m.storage_path) as path, m.kind from album_media am
    join media m on m.id = am.media_id
    where am.album_id = v.id and m.kind <> 'audio' and not am.is_private
      and (v.cover_media_id is null or m.id <> v.cover_media_id)
    order by am.position limit 1 offset 0) t1 on true
  left join lateral (
    select coalesce(m.thumb_path, m.storage_path) as path, m.kind from album_media am
    join media m on m.id = am.media_id
    where am.album_id = v.id and m.kind <> 'audio' and not am.is_private
      and (v.cover_media_id is null or m.id <> v.cover_media_id)
    order by am.position limit 1 offset 1) t2 on true
  order by
    0.5 * ((('x0' || substr(md5(v.id::text || p_seed), 1, 7))::bit(32)::int)::double precision / 268435455.0)
  + 0.3 * least(1.0, ln(1 + v.likes_count * 3 + v.views_count)::double precision / ln(1000))
  + 0.2 * exp(- extract(epoch from (now() - v.published_at)) / (14 * 86400))
    desc
  limit greatest(1, least(p_limit, 60)) offset greatest(0, p_offset);
$$;

-- набор колонок расширяется (соавтор) — Postgres требует сначала удалить функцию
drop function if exists public.feed_posts(int, int);
create or replace function public.feed_posts(p_limit int default 12, p_offset int default 0)
returns table (
  id uuid, caption text, created_at timestamptz,
  author_username text, author_name text, author_avatar text,
  coauthor_username text, coauthor_name text,
  likes_count int, comments_count int, liked boolean, slides jsonb)
language sql stable security definer set search_path = public as $$
  select p.id, p.caption, p.created_at,
         pr.username, pr.display_name, pr.avatar_url,
         co.username, co.display_name,
         p.likes_count, p.comments_count,
         exists (select 1 from likes l where l.subject_type='post' and l.subject_id=p.id and l.user_id=auth.uid()),
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'kind', m.kind, 'path', m.storage_path, 'thumb', m.thumb_path,
             'width', m.width, 'height', m.height) order by pm.position)
           from post_media pm join media m on m.id = pm.media_id
           where pm.post_id = p.id), '[]'::jsonb)
  from posts p
  join profiles pr on pr.id = p.author_id
  left join profiles co on co.id = p.coauthor_id
  where p.hidden_at is null and can_view_post(p.id, auth.uid())
  order by p.created_at desc
  limit greatest(1, least(p_limit, 40)) offset greatest(0, p_offset);
$$;

create or replace function public.search_all(p_q text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'albums', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'title', a.title, 'category', a.category,
        'author_username', p.username, 'author_name', p.display_name,
        'photos_count', a.photos_count, 'videos_count', a.videos_count, 'audio_count', a.audio_count,
        'views_count', a.views_count, 'published_at', a.published_at,
        'cover_path', (select coalesce(m.thumb_path, m.storage_path) from media m where m.id = a.cover_media_id),
        'thumb1', (select coalesce(m.thumb_path, m.storage_path) from album_media am join media m on m.id=am.media_id
                   where am.album_id=a.id and m.kind<>'audio' and not am.is_private order by am.position limit 1),
        'thumb2', (select coalesce(m.thumb_path, m.storage_path) from album_media am join media m on m.id=am.media_id
                   where am.album_id=a.id and m.kind<>'audio' and not am.is_private order by am.position limit 1 offset 1)))
      from albums a join profiles p on p.id = a.author_id
      where a.published_at is not null and a.hidden_at is null
        and can_view_album(a.id, auth.uid()) and a.title ilike '%' || p_q || '%'
      limit 24), '[]'::jsonb),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
        'username', p.username, 'name', p.display_name, 'avatar', p.avatar_url, 'bio', p.bio))
      from profiles p
      where p.banned_at is null and p.deleted_at is null
        and not is_blocked_between(p.id, auth.uid())
        and (p.username ilike '%' || p_q || '%' or p.display_name ilike '%' || p_q || '%')
      limit 12), '[]'::jsonb));
$$;

-- ============================================================ ГРАНТЫ (один раз)

revoke execute on all functions in schema public from anon, authenticated, public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;

grant execute on function
  public.can_view_album(uuid,uuid), public.can_view_post(uuid,uuid),
  public.can_view_subject(subject_kind,uuid,uuid), public.can_view_media(uuid,uuid),
  public.can_view_storage_media(text), public.are_friends(uuid,uuid),
  public.owns_album(uuid), public.owns_subject(subject_kind,uuid),
  public.can_edit_album(uuid), public.is_album_owner(uuid), public.can_contribute_album(uuid),
  public.can_edit_post(uuid), public.is_blocked_between(uuid,uuid), public.is_banned(uuid),
  public.is_following(uuid,uuid), public.is_narration_media(uuid), public.narration_album_of(uuid),
  public.contrib_upload_count(uuid,uuid),
  public.feed_albums(text,text,int,int), public.feed_posts(int,int),
  public.get_album(uuid), public.get_post(uuid), public.get_profile(text),
  public.log_album_view(uuid), public.search_all(text),
  public.narration_get(uuid), public.calendar_albums(int), public.album_date_hint(uuid),
  public.album_contributors(uuid), public.album_invite_peek(text)
to anon, authenticated;

grant execute on function
  public.ensure_profile(), public.friend_request(text),
  public.friend_respond(text,boolean), public.friend_remove(text),
  public.my_friends(), public.my_shared_albums(), public.my_media(text,int,int),
  public.album_collaborator_add(uuid,text), public.album_collaborator_remove(uuid,text),
  public.follow_user(text), public.unfollow_user(text), public.my_follows(),
  public.report_submit(text,uuid,text,text), public.block_user(text),
  public.unblock_user(text), public.my_blocks(),
  public.request_account_deletion(), public.cancel_account_deletion(), public.export_my_data(),
  public.album_invite_create(uuid,int,int), public.album_invite_revoke(uuid),
  public.album_invite_accept(text),
  public.album_autochapter_preview(uuid,int), public.album_autochapter_apply(uuid,int),
  public.narration_set(uuid,uuid,numeric), public.narration_clear(uuid),
  public.narration_cues_set(uuid,jsonb),
  public.my_videos_without_poster(int), public.set_media_poster(uuid,text),
  public.mark_poster_failed(uuid), public.post_set_coauthor(uuid,text),
  public.notif_list(int,int), public.notif_unread_count(), public.notif_mark_read(uuid)
to authenticated;
